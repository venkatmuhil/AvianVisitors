#!/usr/bin/env python3
"""Batch-generate photo cutouts for species missing bundled illustrations.

Mirrors the live Wikipedia+rembg fallback in avian/api/cutout.php, but runs
offline/in-bulk instead of inline in a PHP-FPM request - meant for hardware
(like a Pi with <1GB RAM) where doing this synchronously per-request starves
the web server. Output lands in avian/assets/cutouts/<slug>.png, exactly
where cutout.php looks for bundled cutouts, so no code changes are needed to
pick these up once synced.

Usage:
    python3 gen_cutouts.py --species-file species.txt --out ../assets/cutouts
    (species.txt: one "Scientific name" per line)
"""
import argparse
import json
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "AvianVisitors/1.0 (+https://github.com/Twarner491/AvianVisitors)"
MAX_EDGE = 800


def slugify(sci: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def wikipedia_image_url(sci: str):
    url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(sci)
    try:
        j = fetch_json(url)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return None
    src = (j.get("originalimage") or {}).get("source") or (j.get("thumbnail") or {}).get("source")
    if not src:
        return None
    host = urllib.parse.urlparse(src).netloc
    if not re.search(r"(?:^|\.)(?:wikimedia\.org|wikipedia\.org)$", host, re.I):
        return None
    return src


def process_one(sci: str, out_dir, tmp_dir) -> str:
    """Returns 'ok', 'no-photo', or 'failed'."""
    slug = slugify(sci)
    out_path = out_dir / f"{slug}.png"
    if out_path.exists():
        return "skip-exists"

    src = wikipedia_image_url(sci)
    if not src:
        return "no-photo"

    try:
        img_bytes = fetch_bytes(src)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return "failed"
    if len(img_bytes) < 1024:
        return "failed"

    tmp_in = tmp_dir / f"{slug}.jpg"
    tmp_out = tmp_dir / f"{slug}-out.png"
    tmp_in.write_bytes(img_bytes)

    try:
        subprocess.run(
            ["rembg", "i", "-m", "u2net", str(tmp_in), str(tmp_out)],
            check=True, capture_output=True, timeout=60,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        tmp_in.unlink(missing_ok=True)
        return "failed"
    tmp_in.unlink(missing_ok=True)

    if not tmp_out.exists() or tmp_out.stat().st_size < 1024:
        tmp_out.unlink(missing_ok=True)
        return "failed"

    from PIL import Image
    im = Image.open(tmp_out).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    if max(w, h) > MAX_EDGE:
        scale = MAX_EDGE / max(w, h)
        im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    im.save(out_path, "PNG", optimize=True)
    tmp_out.unlink(missing_ok=True)
    return "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--species-file", required=True, help="One scientific name per line")
    ap.add_argument("--out", required=True, help="Output dir (avian/assets/cutouts)")
    ap.add_argument("--tmp", default="/tmp/avian-cutout-gen")
    ap.add_argument("--delay", type=float, default=1.0, help="Seconds between species (be polite to Wikipedia)")
    ap.add_argument("--limit", type=int, default=0, help="Stop after N species (0 = no limit)")
    args = ap.parse_args()

    from pathlib import Path
    out_dir = Path(args.out)
    tmp_dir = Path(args.tmp)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    species = [l.strip() for l in Path(args.species_file).read_text().splitlines() if l.strip()]
    if args.limit:
        species = species[: args.limit]

    counts = {"ok": 0, "no-photo": 0, "failed": 0, "skip-exists": 0}
    for i, sci in enumerate(species, 1):
        result = process_one(sci, out_dir, tmp_dir)
        counts[result] += 1
        print(f"[{i}/{len(species)}] {sci}: {result}", flush=True)
        if result != "skip-exists":
            time.sleep(args.delay)

    print("\n--- summary ---")
    for k, v in counts.items():
        print(f"{k}: {v}")


if __name__ == "__main__":
    main()
