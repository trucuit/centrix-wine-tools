#!/usr/bin/env zsh
# export-centrix-api.sh — pull CentriX cookies via API (no App UI / no asar hook)
#
# Shared write pattern: scripts/lib/centrix-export-common.sh
#   → scripts/lib/centrix_cookie_export.py --sidecars (via node CLI)
# (same as export-centrix-cookies.sh + export-pick-service.sh)
#
#   ./export-centrix-api.sh              # menu
#   ./export-centrix-api.sh login
#   ./export-centrix-api.sh export grok
#   ./export-centrix-api.sh export chatgpt claude
#   ./export-centrix-api.sh export all
#   ./export-centrix-api.sh export all --chrome
#   ./export-centrix-api.sh status
#   ./export-centrix-api.sh logout
#   ./export-centrix-api.sh takeover
#   ./export-centrix-api.sh services
#
# Env: CENTRIX_APP_VERSION, CENTRIX_OUT_DIR, CENTRIX_SESSION_FILE,
#      CENTRIX_SERVER_URL, J2TEAM_OUT_DIR, IMPORT_TO_CHROME, CENTRIX_NO_ALIASES
#
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
SCRIPT_NAME="${SCRIPT_PATH:t}"

source "$SCRIPT_DIR/scripts/lib/centrix-export-common.sh"
centrix_export_init
centrix_parse_shared_flags "$@"
set -- "${CENTRIX_POS_ARGS[@]}"

if ! command -v node >/dev/null 2>&1; then
  die "Node.js 18+ required."
fi

[[ -f "$API_MJS" ]] || die "missing $API_MJS"

export_api_env
# ensure OUT_DIR exists for node writer
ensure_out

exec node "$API_MJS" "$@"
