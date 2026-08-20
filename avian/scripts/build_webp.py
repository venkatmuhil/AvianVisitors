#!/usr/bin/env python3
"""AvianVisitors - encode the bundled bird art as WebP for the frontend.

Step 4 of the illustration pipeline (after build_masks.py).

The collage used to pull every bird through avian/api/cutout.php, which
readfile()s a full-size PNG out of PHP-FPM. Two costs came with that:
the PNGs average ~350KB (illustrations ~650KB), and a .php URL is never
edge-cached by a CDN, so every visitor re-downloaded the whole set from
the Pi. This writes a WebP twin of each bundled PNG that Caddy can serve
as a plain static file, which is both ~6-8x smaller and cacheable by
extension.

Output is a single flat directory, avian/assets/webp/<slug>.webp, NOT a
sibling of each source PNG. dims.json records only a slug, never which
directory it resolved from, so a split layout would leave the frontend
guessing between illustrations/ and cutouts/. One flat dir mirrors the
dims.json key space exactly: one slug, one URL, no probe.

Dimensions are preserved exactly. dims.json stores a per-slug aspect that
the collage packer lays tiles out against, so resizing here would skew
every tile. (It would also buy almost nothing - re-encoding a 623x705
cutout at its native size lands within 1KB of the same image capped to
700px.)

The frontend picks the static URL for any species with a dims.json entry
and falls back to cutout.php otherwise, so the two sets MUST agree. That
is asserted before this script exits 0 - a missing .webp renders as blank
paper in the CSS-mask stamp templates, with no console error and no
broken-image icon.

These files are generated, not committed - see .gitignore. Run on the Pi
after any deploy that changes the art, and after avian/tools/species-sync
adds a species.

Usage:
    python3 build_webp.py             # encode anything missing or stale
    python3 build_webp.py --check     # report only, don't write
    python3 build_webp.py --force     # re-encode everything
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from build_masks import iter_source_pngs

QUALITY = 82  # visually lossless on these flat-shaded cutouts; 6-8x smaller
METHOD = 6    # slowest/smallest encoder effort - this is a build-time script


def encode(job) -> tuple[str, int, int]:
    """Encode one PNG to WebP at identical dimensions. Returns (slug, src, dst)."""
    from PIL import Image
    slug, src, dst = job
    im = Image.open(src).convert("RGBA")
    im.save(dst, "WEBP", quality=QUALITY, method=METHOD, lossless=False)
    return slug, src.stat().st_size, dst.stat().st_size


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--illustrations", type=Path, default=here / "assets" / "illustrations",
                    help="Illustration directory, highest priority")
    ap.add_argument("--cutouts", type=Path, default=here / "assets" / "cutouts",
                    help="Photo-cutout fallback directory, lower priority")
    ap.add_argument("--out", type=Path, default=here / "assets" / "webp",
                    help="Flat output dir (default: avian/assets/webp/)")
    ap.add_argument("--frontend", type=Path, default=here / "frontend",
                    help="Dir holding dims.json, for the coverage assertion")
    ap.add_argument("--check", action="store_true", help="Report only, don't write")
    ap.add_argument("--force", action="store_true", help="Re-encode even if up to date")
    ap.add_argument("--add", nargs="+", metavar="SLUG",
                    help="Encode only these slugs, for the on-Pi generate path "
                         "(a full rescan of 1200+ images is slow there). "
                         "Coverage is asserted for these slugs only.")
    ap.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1),
                    help="Parallel encoders (default: min(4, cpu count))")
    args = ap.parse_args()

    dirs = [args.illustrations, args.cutouts]
    only = set(args.add) if args.add else None
    sources = list(iter_source_pngs(dirs, only))
    if only:
        # Mirror build_masks --add: a slug with no PNG is a caller error, not
        # something to skip quietly, or the generate path would report success
        # while leaving the frontend pointed at a URL that 404s. Checked before
        # the empty-scan case below, which would otherwise blame the whole dir.
        absent = sorted(only - {slug for slug, _ in sources})
        if absent:
            print(f"error: no source PNG for: {', '.join(absent)}", file=sys.stderr)
            return 1
    elif not sources:
        print(f"error: no source PNGs under {dirs}", file=sys.stderr)
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    jobs, fresh = [], 0
    for slug, src in sources:
        dst = args.out / f"{slug}.webp"
        # Stale if the source has been re-rendered since the last encode.
        if not args.force and dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime:
            fresh += 1
            continue
        jobs.append((slug, src, dst))

    print(f"{len(sources)} bundled PNGs; {fresh} already current, {len(jobs)} to encode")

    if args.check:
        if jobs:
            names = ", ".join(s for s, _, _ in jobs[:8])
            print(f"  stale/missing: {names}{' ...' if len(jobs) > 8 else ''}")
    elif jobs:
        src_bytes = dst_bytes = 0
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for i, (slug, sb, db) in enumerate(pool.map(encode, jobs), 1):
                src_bytes += sb
                dst_bytes += db
                if i % 100 == 0 or i == len(jobs):
                    print(f"  {i}/{len(jobs)}", flush=True)
        if src_bytes:
            print(f"encoded {len(jobs)} files: {src_bytes / 1048576:.1f}MB PNG -> "
                  f"{dst_bytes / 1048576:.1f}MB WebP ({src_bytes / dst_bytes:.1f}x smaller)")

    # The invariant the frontend depends on. apt.js picks the static .webp
    # URL for any species carrying a dims.json entry and never probes for
    # it, because the CSS-mask and SVG-<image> stamp templates have no
    # error hook to fall back from - a miss there is silent blank paper.
    dims_path = args.frontend / "dims.json"
    if not dims_path.exists():
        print(f"error: {dims_path} not found; run build_masks.py first", file=sys.stderr)
        return 1
    # An --add run only claims to have covered what it was asked for; asserting
    # all of dims.json there would fail the caller for unrelated gaps.
    want = set(args.add) if args.add else set(json.loads(dims_path.read_text()))
    have = {p.stem for p in args.out.glob("*.webp")}
    missing = sorted(want - have)
    if missing:
        print(f"error: {len(missing)} slug(s) in dims.json have no .webp: "
              f"{', '.join(missing[:8])}{' ...' if len(missing) > 8 else ''}",
              file=sys.stderr)
        return 1
    scope = "requested" if args.add else "dims.json"
    print(f"ok: all {len(want)} {scope} slugs have a .webp in {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
