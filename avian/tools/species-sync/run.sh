#!/usr/bin/env bash
# Launches the species-sync tool at http://127.0.0.1:8787
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VENV="${VENV:-/Users/muhilvenkat/Program/BirdProject/.venv-rembg}"
source "$VENV/bin/activate"

exec uvicorn app:app --host 127.0.0.1 --port 8787 --reload
