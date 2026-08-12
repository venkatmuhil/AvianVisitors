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
APT_JS = AVIAN / "frontend" / "apt.js"
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
    src = APT_JS.read_text()
    m = re.search(r"var DIMS = (\{.*?\});", src)
    if not m:
        raise RuntimeError("could not find DIMS in apt.js")
    return json.loads(m.group(1))


def resolve_current_image(slug: str) -> Optional[Path]:
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
    covered = {s for s in dims if not s.endswith("-2")}

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
                "has_image": slug in covered, "detected_here": True,
            })
        results.sort(key=lambda r: (r["has_image"], r["com"] or r["sci"]))
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
                "has_image": slug in covered, "detected_here": slug in detected,
            })
    results.sort(key=lambda r: (not r["detected_here"], not r["has_image"], r["com"] or r["sci"]))
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
    file: Optional[UploadFile] = File(None),
):
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
    out_path = CUTOUTS_DIR / f"{slug}.png"
    out_path.write_bytes(out_bytes)
    return {"slug": slug, "path": str(out_path.relative_to(REPO)), "bytes": len(out_bytes)}


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
    subprocess.run(["git", "add", "-N", "avian/assets", "avian/frontend/apt.js"], cwd=REPO)
    diff = subprocess.run(
        ["git", "diff", "--stat", "--", "avian/assets", "avian/frontend/apt.js"],
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

    subprocess.run(["git", "add", "avian/assets", "avian/frontend/apt.js"], cwd=REPO, check=True)
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
