#!/usr/bin/env bash
# ==============================================================================
# vps-auths/download.sh
# Tải (sync) các file thông tin xác thực mới nhất từ VPS (163.223.224.240) về vps-auths/
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Xóa toàn bộ file .json cũ trong vps-auths/
find "$SCRIPT_DIR" -maxdepth 1 -name "*.json" -type f -delete 2>/dev/null || true

exec "$SCRIPT_DIR/import.sh" download "$@"
