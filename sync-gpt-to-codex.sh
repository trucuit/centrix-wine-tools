#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"

if ! command -v node >/dev/null 2>&1; then
  print -r -- "ERROR: Node.js 22+ is required." >&2
  exit 1
fi

export CENTRIX_CHROME_PROFILE="${CENTRIX_CHROME_PROFILE:-$SCRIPT_DIR/.chrome-cookie-profile}"
export CHROME_DEBUG_PORT="${CHROME_DEBUG_PORT:-9222}"

# Optional: if user passed service name like "gptpro", ensure cookies are imported first
if [[ $# -gt 0 && "$1" != "--help" && "$1" != "-h" ]]; then
  print -r -- "▸ Importing cookies for $1 first..."
  "$SCRIPT_DIR/import-cookies-to-chrome.sh" "$1"
fi

exec node "$SCRIPT_DIR/scripts/sync-gpt-to-codex.mjs"
