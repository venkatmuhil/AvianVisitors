#!/usr/bin/env python3
"""AvianVisitors - local species image sync tool.

Search any species (global label catalog, ~7000 names), see the image
currently bundled for it (if any), replace it with an uploaded photo or a
fresh Wikipedia fetch, rebuild the frontend's DIMS/MASKS tables, and push +
deploy the result to the Pi over SSH.

This wraps the existing avian/scripts/ pipeline (gen_cutouts.py's
Wikipedia+rembg approach and cutout.py's crop/margin conventions) rather
than reimplementing it, so new/replaced images match the rest of the
bundled set. See README.md for the deploy-safety note about the Pi's
Sunday auto-update cron.

Run with ./run.sh (activates .venv-rembg, launches uvicorn).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

REPO = Path(__file__).resolve().parents[3]  # .../AvianVisitors
AVIAN = REPO / "avian"
ILLUS_DIR = AVIAN / "assets" / "illustrations"
CUTOUTS_DIR = AVIAN / "assets" / "cutouts"
APT_JS = AVIAN / "frontend" / "apt.js"        # still holds SKETCH_VERSION/IMG_VERSION
DIMS_JSON = AVIAN / "frontend" / "dims.json"  # written by build_masks.py
MASKS_JSON = AVIAN / "frontend" / "masks.json"
# Everything the mask rebuild can touch, for git add / diff --stat.
TRACKED_PATHS = ["avian/assets", "avian/frontend/apt.js",
                 "avian/frontend/dims.json", "avian/frontend/masks.json"]
SCRIPTS_DIR = AVIAN / "scripts"
LABELS_EN = REPO / "model" / "l18n" / "labels_en.json"

PI_HOST = os.environ.get("PI_HOST", "192.168.1.53")
PI_USER = os.environ.get("PI_USER", "bird-listen")
PI_SSH_KEY = os.environ.get("PI_SSH_KEY", str(Path.home() / ".ssh" / "id_ed25519_birdnet"))
PI_REPO = "~/BirdNET-Pi"

USER_AGENT = "AvianVisitors/1.0 (+https://github.com/venkatmuhil/AvianVisitors)"
MAX_EDGE = 800  # matches gen_cutouts.py's MAX_EDGE
CUTOUT_MARGIN = 0.02  # matches cutout.py's --margin default

app = FastAPI(title="AvianVisitors species-sync")


def slugify(sci: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


_sci_to_com_cache: Optional[dict] = None


def sci_to_com() -> dict:
    global _sci_to_com_cache
    if _sci_to_com_cache is None:
        _sci_to_com_cache = json.loads(LABELS_EN.read_text())
    return _sci_to_com_cache


def load_dims() -> dict:
    """Slugs the collage can actually draw.

    These used to be inlined in apt.js as `var DIMS = {...}`; upstream moved
    them into dims.json so species-adds stop colliding on every merge. A slug
    missing here still gets dropped by the frontend even if cutout.php can
    serve an image for it.
    """
    if not DIMS_JSON.is_file():
        raise RuntimeError(f"{DIMS_JSON} missing - run avian/scripts/build_masks.py")
    return json.loads(DIMS_JSON.read_text())


# Slugs may carry a pose suffix (`turdus-migratorius-2` is the flight
# variant), matching the dims.json keys and the on-disk filenames.
SLUG_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def resolve_current_image(slug: str) -> Optional[Path]:
    # Starlette routes on the raw path, so a percent-encoded separator can
    # reach here; without this guard it would escape the assets directory.
    if not SLUG_RE.fullmatch(slug):
        return None
    p = ILLUS_DIR / f"{slug}.png"
    if p.is_file() and p.stat().st_size > 1024:
        return p
    p = CUTOUTS_DIR / f"{slug}.png"
    if p.is_file() and p.stat().st_size > 1024:
        return p
    return None


def fetch_lifelist() -> list:
    url = f"http://{PI_HOST}/avian/api/birdnet-api.php?action=lifelist"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.loads(r.read())
    return data.get("species", [])


@app.get("/api/species")
def api_species(q: str = ""):
    dims = load_dims()
    # Coverage is per-pose: a species can have a perched image, a flight
    # image, or both. Flight keys carry the -2 suffix, so strip it to get
    # back to the species slug the UI works in.
    perched = {s for s in dims if not s.endswith("-2")}
    flight = {s[:-2] for s in dims if s.endswith("-2")}

    try:
        detected = {slugify(e["sci"]) for e in fetch_lifelist()}
    except Exception:
        detected = set()

    q_norm = q.strip().lower()

    if not q_norm:
        # Default view: this site's own detections (small, actionable list).
        try:
            lifelist = fetch_lifelist()
        except Exception:
            lifelist = []
        results = []
        for e in lifelist:
            slug = slugify(e["sci"])
            results.append({
                "slug": slug, "sci": e["sci"], "com": e.get("com"),
                "has_perched": slug in perched, "has_flight": slug in flight,
                "detected_here": True,
            })
        # Perched coverage still decides whether a bird can be drawn at all,
        # so it stays the primary sort: uncovered species surface first.
        results.sort(key=lambda r: (r["has_perched"], r["com"] or r["sci"]))
        return results

    # Named search across the full global label catalog (~7000 species),
    # so species that have never been detected here (or have no image
    # yet) are still findable by name.
    catalog = sci_to_com()
    results = []
    for sci, com in catalog.items():
        haystack = f"{sci} {com}".lower()
        if q_norm in haystack:
            slug = slugify(sci)
            results.append({
                "slug": slug, "sci": sci, "com": com,
                "has_perched": slug in perched, "has_flight": slug in flight,
                "detected_here": slug in detected,
            })
    results.sort(key=lambda r: (not r["detected_here"], not r["has_perched"], r["com"] or r["sci"]))
    return results[:40]


@app.get("/api/image/{slug}")
def api_image(slug: str):
    p = resolve_current_image(slug)
    if p is None:
        raise HTTPException(404, "no image bundled for this slug")
    return FileResponse(p)


def wikipedia_image_url(sci: str) -> Optional[str]:
    url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(sci)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            j = json.loads(r.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        return None
    src = (j.get("originalimage") or {}).get("source") or (j.get("thumbnail") or {}).get("source")
    if not src:
        return None
    host = urllib.parse.urlparse(src).netloc
    if not re.search(r"(?:^|\.)(?:wikimedia\.org|wikipedia\.org)$", host, re.I):
        return None
    return src


def normalize_photo_bytes(img_bytes: bytes) -> bytes:
    """rembg (u2net) -> crop to alpha bbox w/ margin -> downscale to MAX_EDGE.

    Mirrors gen_cutouts.py's photo pipeline plus cutout.py's margin, so a
    replacement image matches the framing/background-removal style of
    every other cutout in avian/assets/cutouts/.
    """
    from PIL import Image
    from rembg import new_session, remove

    with tempfile.TemporaryDirectory() as td:
        tmp_in = Path(td) / "in.jpg"
        tmp_in.write_bytes(img_bytes)
        im = Image.open(tmp_in).convert("RGB")
        session = new_session("u2net")
        cut = remove(im, session=session).convert("RGBA")

        bbox = cut.getchannel("A").getbbox()
        if bbox:
            pad = round(CUTOUT_MARGIN * max(bbox[2] - bbox[0], bbox[3] - bbox[1]))
            x0, y0 = max(0, bbox[0] - pad), max(0, bbox[1] - pad)
            x1, y1 = min(cut.width, bbox[2] + pad), min(cut.height, bbox[3] + pad)
            cut = cut.crop((x0, y0, x1, y1))

        w, h = cut.size
        if max(w, h) > MAX_EDGE:
            scale = MAX_EDGE / max(w, h)
            cut = cut.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

        out_path = Path(td) / "out.png"
        cut.save(out_path, "PNG", optimize=True)
        return out_path.read_bytes()


@app.post("/api/cutout")
async def api_cutout(
    sci: str = Form(...),
    source: str = Form("upload"),
    pose: int = Form(1),
    file: Optional[UploadFile] = File(None),
):
    if pose not in (1, 2):
        raise HTTPException(422, "pose must be 1 (perched) or 2 (flight)")
    # Wikipedia's summary endpoint returns one representative photo with no
    # pose control - it is almost always a perched bird, so accepting this
    # would file a perched photo under the flight slug.
    if pose == 2 and source == "wikipedia":
        raise HTTPException(400, "Wikipedia returns a single representative photo "
                                 "with no pose control; upload a flight photo instead")
    slug = slugify(sci)

    if source == "wikipedia":
        src_url = wikipedia_image_url(sci)
        if not src_url:
            raise HTTPException(404, "no usable Wikipedia photo found for " + sci)
        req = urllib.request.Request(src_url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                img_bytes = r.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            raise HTTPException(502, f"failed to fetch Wikipedia image: {e}")
    else:
        if file is None:
            raise HTTPException(400, "file is required when source=upload")
        img_bytes = await file.read()

    if len(img_bytes) < 1024:
        raise HTTPException(422, "source image too small/empty")

    try:
        out_bytes = normalize_photo_bytes(img_bytes)
    except Exception as e:
        raise HTTPException(500, f"cutout processing failed: {e}")

    CUTOUTS_DIR.mkdir(parents=True, exist_ok=True)
    # Pose 2 lands at <slug>-2.png. build_masks.py keys dims/masks off the
    # bare filename stem, so it picks the flight variant up with no change,
    # and cutout.php serves it for ?pose=2.
    out_slug = f"{slug}-2" if pose == 2 else slug
    out_path = CUTOUTS_DIR / f"{out_slug}.png"
    out_path.write_bytes(out_bytes)
    return {"slug": out_slug, "pose": pose,
            "path": str(out_path.relative_to(REPO)), "bytes": len(out_bytes)}


@app.post("/api/rebuild")
def api_rebuild():
    result = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "build_masks.py")],
        cwd=SCRIPTS_DIR, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise HTTPException(500, f"build_masks.py failed:\n{result.stderr}")

    src = APT_JS.read_text()

    def bump(m: re.Match) -> str:
        return f"{m.group(1)}{int(m.group(2)) + 1}{m.group(3)}"

    new_src, n1 = re.subn(r"(var SKETCH_VERSION = 'r)(\d+)(';)", bump, src)
    new_src, n2 = re.subn(r"(var IMG_VERSION = 'r)(\d+)(';)", bump, new_src)
    if n1 != 1 or n2 != 1:
        raise HTTPException(500, "could not find/bump SKETCH_VERSION or IMG_VERSION in apt.js")
    APT_JS.write_text(new_src)

    new_version = re.search(r"var IMG_VERSION = '(r\d+)';", new_src).group(1)
    return {"build_output": result.stdout, "new_version": new_version}


def _pending_diff() -> str:
    subprocess.run(["git", "add", "-N", *TRACKED_PATHS], cwd=REPO)
    diff = subprocess.run(
        ["git", "diff", "--stat", "--", *TRACKED_PATHS],
        cwd=REPO, capture_output=True, text=True,
    ).stdout
    return diff


@app.get("/api/deploy/preview")
def api_deploy_preview():
    return {"diff": _pending_diff()}


@app.post("/api/deploy")
def api_deploy(commit_message: str = Form("Update bird cutouts via species-sync tool")):
    diff = _pending_diff()
    if not diff.strip():
        return {"diff": "", "pi_output": "", "message": "nothing to deploy"}

    subprocess.run(["git", "add", *TRACKED_PATHS], cwd=REPO, check=True)
    subprocess.run(["git", "commit", "-m", commit_message], cwd=REPO, check=True)
    subprocess.run(["git", "push", "origin", "avian-visitors"], cwd=REPO, check=True)

    ssh_cmd = [
        "ssh", "-i", PI_SSH_KEY, "-o", "ConnectTimeout=10",
        f"{PI_USER}@{PI_HOST}",
        f"cd {PI_REPO} && git fetch origin avian-visitors && git reset --hard origin/avian-visitors",
    ]
    result = subprocess.run(ssh_cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(500, f"pushed to GitHub, but deploy to Pi failed:\n{result.stderr}")

    return {"diff": diff, "pi_output": result.stdout}


app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")
