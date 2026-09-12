#!/usr/bin/env bash
# ==============================================================================
# vps-auths/import-xai.sh
# Import xAI / Grok CLI auth (codecentrix1@signs.onmicrosoft.com) vào ~/.grok/auth.json
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/import.sh" xai "$@"
