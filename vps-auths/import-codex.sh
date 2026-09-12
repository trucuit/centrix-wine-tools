#!/usr/bin/env bash
# ==============================================================================
# vps-auths/import-codex.sh
# Import Codex CLI auth (chatgpt57@23ww.onmicrosoft.com) vào ~/.codex/auth.json
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/import.sh" codex "$@"
