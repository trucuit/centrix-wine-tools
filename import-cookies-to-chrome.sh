#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"

if ! command -v node >/dev/null 2>&1; then
  print -r -- "ERROR: Node.js 22+ is required." >&2
  exit 1
fi

export CENTRIX_COOKIES_DIR="${CENTRIX_COOKIES_DIR:-$SCRIPT_DIR/cookies}"
export CENTRIX_CHROME_PROFILE="${CENTRIX_CHROME_PROFILE:-$SCRIPT_DIR/.chrome-cookie-profile}"

exec node "$SCRIPT_DIR/scripts/import-cookies-to-chrome.mjs" "$@"
