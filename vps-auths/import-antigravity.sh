#!/usr/bin/env bash
# ==============================================================================
# vps-auths/import-antigravity.sh
# Import Antigravity OAuth (laurienbuny2568@gmail.com) vào ~/.gemini/oauth_creds.json
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/import.sh" antigravity "$@"
