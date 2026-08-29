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
#   ./export-centrix-api.sh export gptpro --chrome
#   ./export-centrix-api.sh export all
#   ./export-centrix-api.sh export all --chrome
#   ./export-centrix-api.sh status
#   ./export-centrix-api.sh logout
#   ./export-centrix-api.sh takeover
#   ./export-centrix-api.sh services
#
# Env: CENTRIX_APP_VERSION, CENTRIX_OUT_DIR, CENTRIX_SESSION_FILE,
#      CENTRIX_SERVER_URL, J2TEAM_OUT_DIR, IMPORT_TO_CHROME, CENTRIX_NO_ALIASES
#      CENTRIX_API_VERSION   force "v1" or "v2"  (default: auto-detect)
#      CENTRIX_V2_API_URL    v2 API base URL      (default: https://api.cetrix.app)
#      CENTRIX_V2_SESSION    v2 session file       (default: ./.cetrix-session.json)
#
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
SCRIPT_NAME="${SCRIPT_PATH:t}"

# ── API version auto-detect ────────────────────────────────
# v1 = https://api-centrixapp-quang.centrix.asia (CentriX App Server / Profile Pool Manager - 25 Profiles)
# v2 = https://api.cetrix.app (CentriX Desktop Client Auth API - OTP / Managed Lease)
V2_MJS="$SCRIPT_DIR/scripts/centrix-v2-api.mjs"
V1_MJS="$SCRIPT_DIR/scripts/export-centrix-api.mjs"

choose_api_version() {
  local forced="${CENTRIX_API_VERSION:-}"
  if [[ "$forced" == "v1" ]]; then echo "v1"; return; fi
  if [[ "$forced" == "v2" ]]; then echo "v2"; return; fi

  # Auto: if v2 session exists and is recent, use v2
  local v2_session="${CENTRIX_V2_SESSION:-$SCRIPT_DIR/.cetrix-session.json}"
  if [[ -f "$v2_session" ]]; then
    echo "v2"; return
  fi

  # Auto: if v2 script exists, try v2 first
  if [[ -f "$V2_MJS" ]]; then
    echo "v2"; return
  fi

  # Fallback to v1
  echo "v1"
}

if ! command -v node >/dev/null 2>&1; then
  print -r -- "ERROR: Node.js 18+ required." >&2
  exit 1
fi

API_VER="$(choose_api_version)"

if [[ "$API_VER" == "v2" ]]; then
  # ── v2 flow (api.cetrix.app) ────────────────────────────
  [[ -f "$V2_MJS" ]] || { print -r -- "ERROR: missing $V2_MJS" >&2; exit 1; }

  export CENTRIX_OUT_DIR="${CENTRIX_OUT_DIR:-$SCRIPT_DIR/cookies}"
  export CENTRIX_V2_SESSION="${CENTRIX_V2_SESSION:-$SCRIPT_DIR/.cetrix-session.json}"
  export CENTRIX_APP_VERSION="${CENTRIX_APP_VERSION:-0.1.346}"
  mkdir -p "$CENTRIX_OUT_DIR" 2>/dev/null || true

  exec node "$V2_MJS" "$@"

else
  # ── v1 flow (legacy) ────────────────────────────────────
  source "$SCRIPT_DIR/scripts/lib/centrix-export-common.sh"
  centrix_export_init
  centrix_parse_shared_flags "$@"
  set -- "${CENTRIX_POS_ARGS[@]}"

  [[ -f "$API_MJS" ]] || { print -r -- "ERROR: missing $API_MJS" >&2; exit 1; }

  export_api_env
  ensure_out

  exec node "$API_MJS" "$@"
fi
