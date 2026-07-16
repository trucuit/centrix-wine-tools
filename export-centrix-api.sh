#!/usr/bin/env zsh
# export-centrix-api.sh — pull CentriX cookies via API (no App UI / no asar hook)
#
# Targets CentriX App User 3.17 (UA CentriXAppUser/3.17). Override with CENTRIX_APP_VERSION.
#
#   ./export-centrix-api.sh              # menu chọn option
#   ./export-centrix-api.sh login
#   ./export-centrix-api.sh export grok
#   ./export-centrix-api.sh export chatgpt claude
#   ./export-centrix-api.sh export all
#   ./export-centrix-api.sh status
#   ./export-centrix-api.sh logout
#   ./export-centrix-api.sh takeover
#   ./export-centrix-api.sh services
#
set -euo pipefail
SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"

if ! command -v node >/dev/null 2>&1; then
  print -r -- "ERROR: Node.js 18+ required." >&2
  exit 1
fi

# Match installed App User version (setup-centrix-mac.sh / CentriX-App-User-Setup-3.17.exe)
export CENTRIX_APP_VERSION="${CENTRIX_APP_VERSION:-3.17}"
export CENTRIX_OUT_DIR="${CENTRIX_OUT_DIR:-$SCRIPT_DIR/cookies}"
export CENTRIX_SESSION_FILE="${CENTRIX_SESSION_FILE:-$SCRIPT_DIR/.centrix-api-session.json}"
export CENTRIX_SERVER_URL="${CENTRIX_SERVER_URL:-https://api-centrixapp-quang.centrix.asia}"

exec node "$SCRIPT_DIR/scripts/export-centrix-api.mjs" "$@"
