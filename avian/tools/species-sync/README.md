# species-sync

Local tool for adding or replacing a bird's image in the collage, from the
Mac, without hand-running the `avian/scripts/` pipeline every time.

## Run it

```bash
./run.sh
```

Opens a server at http://127.0.0.1:8787. Uses `.venv-rembg` (already has
`fastapi`, `uvicorn`, `rembg`, `Pillow` — no extra installs needed).

## What it does

- **Search** any of the ~7,000 species in `model/l18n/labels_en.json` by
  common or scientific name. With an empty search box it instead shows the
  species actually detected at this site (via the Pi's live
  `avian/api/birdnet-api.php?action=lifelist`), so the species that
  currently need attention are the first thing you see.
- Pick a result to see the **current image** (whatever `cutout.php` would
  serve for it — bundled illustration or photo cutout), or "no current
  image" if it isn't covered yet.
- **Perched / Flight**: each species has two poses. Perched is the default
  and lives at the bare slug; flight lives at `<slug>-2`. The toggle drives
  both the preview and where an upload lands, and each row carries a badge
  per pose. A species with no flight variant is the normal case — the
  collage just always draws it perched.
- **Replace or add**: drag in a photo, or click "Fetch from Wikipedia."
  Either way the image goes through the same normalization the rest of the
  asset set uses (`rembg` `u2net` background removal, crop to the alpha
  bbox with a small margin, downscale to an 800px max edge — matching
  `gen_cutouts.py` / `cutout.py`), so it matches the framing/style of every
  other cutout rather than being a raw upload. The result is written
  straight to `avian/assets/cutouts/<slug>.png` — or `<slug>-2.png` in
  Flight mode (git-tracked, so an unwanted replacement can just be
  `git checkout`ed away before deploying). Wikipedia is disabled in Flight
  mode: its summary endpoint returns one representative photo with no pose
  control, and it is almost always a perched bird.
- **Keep both poses in the same medium.** If a species has a bundled
  kachō-e illustration perched, adding a *photo* flight variant makes the
  collage alternate between two art styles for that bird every few minutes.
  Upload flight photos for photo-cutout species.
- **Stamp design**: pin which Atlas stamp design a species is printed on.
  Normally the design is decided for the bird — by family if its genus is in
  `stamps.js`'s `GENUS_GROUP` map, otherwise by a stable hash of its
  scientific name across a 24-design pool. That map is all North American, so
  at this station 52 of 61 species land in the hash branch. The panel shows
  which rule applied, lists all 29 designs, and writes the pick to
  `avian/frontend/style-overrides.json` (`{"Genus species": "design-id"}`,
  one key per line like `dims.json`), which wins over both rules in
  `styleFor()`. "Back to automatic" removes the key.

  The catalogue is read by running the real frontend under a DOM shim
  (`stamp_info.js`, needs `node`, no packages) rather than by parsing
  `stamps.js` from Python — a second implementation of `styleFor()` would
  drift, and it would drift by offering a design the page cannot draw.

  Three warnings come out of that same pass, because **every one of these
  fails as blank paper with a clean console**:
  - the design has no stylesheet (upstream's retired `field`),
  - it hardcodes a family name that isn't this bird's (`raptor` prints
    `ACCIPITRIDAE`),
  - it composes the bird **in flight** and this species has no flight image.
    `kieler` is one. Separately, `markup()` forces the flight plate for the
    whole `Doves & Pigeons` family, so for a dove no design choice escapes it
    — only uploading a flight photo does.
- **Rebuild masks**: runs `avian/scripts/build_masks.py` (writes
  `dims.json` + `masks.json`) then `build_webp.py`, then bumps the versions
  (below) — the step `build_masks.py` reminds you to do but doesn't do itself.
- **Push + deploy to Pi**: commits the changed assets, `apt.js`,
  `index.html`, and the JSON tables, pushes to `origin avian-visitors` on
  GitHub, then SSHes to the Pi and runs
  `git fetch && git reset --hard origin/avian-visitors && python3 avian/scripts/build_webp.py`
  — deliberately **not** the full `scripts/update_birdnet.sh` (that also runs
  `pre_update.sh` / `update_birdnet_snippets.sh` under `sudo`, meant for
  full BirdNET-Pi system updates, not a content-only asset refresh; since
  Caddy serves `avian/` via a symlink straight into the git working copy, a
  plain fetch+reset is enough).

## Two things the deploy must do that a `git pull` cannot

Both were missing until 2026-08-22, and both fail silently.

**`build_webp.py` has to run on the Pi.** The art the frontend actually loads
is `avian/assets/webp/<slug>.webp`, and that directory is **gitignored** — the
WebPs are derived from the committed PNGs. So a git-only deploy leaves the Pi
with a `dims.json` entry for the new species and no art behind it. `apt.js`
treats a `dims.json` entry as proof the WebP exists and links straight to it
without probing, and that src reaches a CSS mask, a canvas and an SVG
`<image>` — none of which have an error hook. Blank paper, clean console.

**The `?v=` on `apt.js` in `index.html` has to move too.** Bumping
`SKETCH_VERSION`/`IMG_VERSION` inside `apt.js` only busts the URLs `apt.js`
mints. `apt.js` itself is served `public, max-age=31536000, immutable` and
sits in Cloudflare's edge cache; `index.html` is `no-cache`, so it is always
re-read, but it keeps asking for the same `apt.js?v=rNNN`. Leave that
unchanged and the browser keeps running *last* deploy's `apt.js`, which asks
for last deploy's `dims.json` — the new species stays invisible on
`birds.7ml.in` for up to a year while looking perfectly fine on the Pi's LAN
address. `bump_versions()` moves both or neither.

## After adding `style-overrides.json` (one time)

It is a new webroot symlink, so the Pi needs
`sudo bash scripts/link_webroot.sh` once. Until then `apt.js` fetches it,
gets a 404, falls back to the automatic rules and renders normally — the
overrides just have no effect.

## Why deploys go through git, not rsync

The Pi has a Sunday 3am cron (`templates/automatic_update.cron` →
`update_birdnet.sh -a`) that does `git reset --hard` whenever
`AUTOMATIC_UPDATE` is on. Anything copied onto the Pi outside of git (raw
`scp`/`rsync` into the working tree) would be silently wiped the next time
that cron fires. Always go through commit → push → the deploy button here
(or a manual `git pull` on the Pi) so the change actually sticks.

## Config

Env vars (all optional, defaults match this project's Pi):

- `PI_HOST` — default `192.168.1.53`
- `PI_USER` — default `bird-listen`
- `PI_SSH_KEY` — default `~/.ssh/id_ed25519_birdnet`
- `VENV` (used by `run.sh` only) — default
  `/Users/muhilvenkat/Program/BirdProject/.venv-rembg`
