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
- **Replace or add**: drag in a photo, or click "Fetch from Wikipedia."
  Either way the image goes through the same normalization the rest of the
  asset set uses (`rembg` `u2net` background removal, crop to the alpha
  bbox with a small margin, downscale to an 800px max edge — matching
  `gen_cutouts.py` / `cutout.py`), so it matches the framing/style of every
  other cutout rather than being a raw upload. The result is written
  straight to `avian/assets/cutouts/<slug>.png` (git-tracked, so an unwanted
  replacement can just be `git checkout`ed away before deploying).
- **Rebuild masks**: runs `avian/scripts/build_masks.py` to patch the
  `DIMS`/`MASKS` tables into `avian/frontend/apt.js`, then bumps
  `SKETCH_VERSION`/`IMG_VERSION` (the one step `build_masks.py` reminds you
  to do but doesn't do itself).
- **Push + deploy to Pi**: commits the changed assets + `apt.js`, pushes to
  `origin avian-visitors` on GitHub, then SSHes to the Pi and runs a plain
  `git fetch && git reset --hard origin/avian-visitors` — deliberately
  **not** the full `scripts/update_birdnet.sh` (that also runs
  `pre_update.sh` / `update_birdnet_snippets.sh` under `sudo`, meant for
  full BirdNET-Pi system updates, not a content-only asset refresh; since
  Caddy serves `avian/` via a symlink straight into the git working copy, a
  plain fetch+reset is enough).

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
