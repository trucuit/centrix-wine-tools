#!/usr/bin/env bash
# ==============================================================================
# vps-auths/import.sh
# Trình quản lý và import chứng thực VPS (Codex, Claude, Antigravity, xAI / Grok)
#
# Cách dùng:
#   ./import.sh              # Menu tương tác chọn dịch vụ cần import
#   ./import.sh codex        # Import Codex CLI
#   ./import.sh claude       # Import Claude
#   ./import.sh antigravity  # Import Antigravity
#   ./import.sh xai          # Import xAI / Grok
#   ./import.sh all          # Import tất cả dịch vụ
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Lỗi: Cần cài đặt Node.js để chạy script này." >&2
  exit 1
fi

exec node "$ROOT_DIR/scripts/import-vps-auths.mjs" "$@"
