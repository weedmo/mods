#!/bin/sh
# One-shot fresh-machine setup: install Herdr if missing, fetch this repo, apply the saved setup.
#   curl -fsSL https://raw.githubusercontent.com/weedmo/mods/main/scripts/bootstrap.sh | sh
# Extra args are passed to install.py (e.g. --with-automations --with-statusline).
set -eu
REPO_URL="${HERDR_MODS_REPO:-https://github.com/weedmo/mods.git}"
DEST="${HERDR_MODS_DIR:-$HOME/mods}"
export PATH="$HOME/.local/bin:$PATH"

if ! command -v herdr-app >/dev/null 2>&1; then
  echo "installing Herdr"
  curl -fsSL https://releases.herdr.dev/app/install.sh | sh
fi

if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only
else
  git clone "$REPO_URL" "$DEST"
fi

python3 "$DEST/scripts/install.py" "$@"
echo "done. Start Herdr with: herdr-app"
