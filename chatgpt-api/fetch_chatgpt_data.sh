#!/usr/bin/env bash
# ==============================================================================
# chatgpt-api/fetch_chatgpt_data.sh
#
# Gọi các API ChatGPT khi mở app và lưu kết quả vào local.
# Sử dụng curl_cffi (Python) để bypass Cloudflare TLS fingerprint.
#
# Flow:
#   1. POST /api/auth/link-session  → Đổi OAuth token → web session cookies
#   2. GET  /backend-api/conversations → Lấy danh sách conversations
#   3. GET  /backend-api/accounts/check/v4-2023-04-27 → Check account & plan
#
# Cách dùng:
#   ./fetch_chatgpt_data.sh                           # Tự chọn file codex-*.json đầu tiên
#   ./fetch_chatgpt_data.sh <path/to/codex-auth.json> # Chỉ định file auth cụ thể
#   ./fetch_chatgpt_data.sh --all                     # Fetch cho tất cả tài khoản
#
# Output: chatgpt-api/data/<email>/
#   ├── session.json          (cookies từ link-session)
#   ├── conversations.json    (danh sách hội thoại)
#   ├── accounts.json         (thông tin tài khoản & gói)
#   └── summary.txt           (tóm tắt nhanh)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VPS_AUTHS_DIR="$ROOT_DIR/vps-auths"
DATA_DIR="$SCRIPT_DIR/data"

fetch_for_auth() {
  local auth_file="$1"
  exec python3 "$SCRIPT_DIR/_fetch_chatgpt_data.py" "$auth_file" "$DATA_DIR"
}

main() {
  # Check python3 + curl_cffi
  if ! python3 -c "import curl_cffi" 2>/dev/null; then
    echo "❌ Cần cài đặt curl_cffi: pip3 install --break-system-packages curl_cffi"
    exit 1
  fi

  local auth_files=()

  if [[ "${1:-}" == "--all" ]]; then
    while IFS= read -r f; do
      auth_files+=("$f")
    done < <(find "$VPS_AUTHS_DIR" -maxdepth 1 -name 'codex-*.json' -type f 2>/dev/null | sort)
    [[ ${#auth_files[@]} -eq 0 ]] && { echo "❌ Không tìm thấy codex-*.json trong $VPS_AUTHS_DIR"; exit 1; }
  elif [[ -n "${1:-}" && -f "${1:-}" ]]; then
    auth_files+=("$(cd "$(dirname "$1")" && pwd)/$(basename "$1")")
  else
    local first
    first="$(find "$VPS_AUTHS_DIR" -maxdepth 1 -name 'codex-*.json' -type f 2>/dev/null | sort | head -1)"
    [[ -z "$first" ]] && { echo "❌ Không tìm thấy codex-*.json"; exit 1; }
    auth_files+=("$first")
  fi

  local ok=0 fail=0
  for f in "${auth_files[@]}"; do
    if python3 "$SCRIPT_DIR/_fetch_chatgpt_data.py" "$f" "$DATA_DIR"; then
      ((ok++)) || true
    else
      ((fail++)) || true
    fi
  done

  echo ""
  echo -e "\033[1m📊 Kết quả: \033[32m${ok} thành công\033[0m, \033[31m${fail} thất bại\033[0m"
  echo -e "\033[2m   Data: $DATA_DIR/\033[0m"
}

main "$@"
