#!/usr/bin/env bash
# ==============================================================================
# vps-auths/import-all.sh
# Import toàn bộ 4 tài khoản (Codex, Claude, Antigravity, xAI / Grok) vào Mac
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/import.sh" all "$@"
