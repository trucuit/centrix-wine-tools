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
  local custom_delay=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --delay|-d)
        custom_delay="${2:-}"
        [[ -z "$custom_delay" ]] && { echo "❌ Thiếu giá trị delay. Ví dụ: --delay 55"; exit 1; }
        shift 2
        ;;
      --all)
        while IFS= read -r f; do
          auth_files+=("$f")
        done < <(find "$VPS_AUTHS_DIR" -maxdepth 1 -name 'codex-*.json' -type f 2>/dev/null | sort)
        shift
        ;;
      -h|--help)
        echo "Cách dùng:"
        echo "  $0                           # Tự chọn file auth đầu tiên"
        echo "  $0 <path/to/codex-auth.json> # Chỉ định file auth cụ thể"
        echo "  $0 --all                     # Fetch cho tất cả tài khoản"
        echo "  $0 <file> --delay 55         # Tùy chỉnh khoảng cách giữa các request (mặc định: 55s)"
        exit 0
        ;;
      -*)
        echo "❌ Tùy chọn không hợp lệ: $1"
        exit 1
        ;;
      *)
        if [[ -f "$1" ]]; then
          auth_files+=("$(cd "$(dirname "$1")" && pwd)/$(basename "$1")")
        else
          echo "❌ Không tìm thấy file: $1"
          exit 1
        fi
        shift
        ;;
    esac
  done

  if [[ ${#auth_files[@]} -eq 0 ]]; then
    local first
    first="$(find "$VPS_AUTHS_DIR" -maxdepth 1 -name 'codex-*.json' -type f 2>/dev/null | sort | head -1)"
    [[ -z "$first" ]] && { echo "❌ Không tìm thấy codex-*.json trong $VPS_AUTHS_DIR"; exit 1; }
    auth_files+=("$first")
  fi

  if [[ -n "$custom_delay" ]]; then
    export FETCH_DELAY="$custom_delay"
  else
    export FETCH_DELAY="${FETCH_DELAY:-55.0}"
  fi
  echo -e "\033[36m⏱️  Pacing delay: ${FETCH_DELAY}s giữa các hội thoại (chống 429 triệt để)\033[0m"

  local ok=0 fail=0
  for f in "${auth_files[@]}"; do
    local attempt=1
    local max_attempts=10
    local success=0
    while [[ $attempt -le $max_attempts ]]; do
      echo -e "\033[36m🚀 [Lần $attempt/$max_attempts] Bắt đầu tải: $(basename "$f")...\033[0m"
      if PYTHONUNBUFFERED=1 python3 -u "$SCRIPT_DIR/_fetch_chatgpt_data.py" "$f" "$DATA_DIR"; then
        success=1
        ((ok++)) || true
        break
      else
        echo -e "\033[33m⚠️ Quá trình bị gián đoạn (Rate limit 429 / mạng). Chờ 90s cooldown và tiếp tục tải từ điểm dừng...\033[0m"
        sleep 90
        ((attempt++)) || true
      fi
    done
    if [[ $success -eq 0 ]]; then
      ((fail++)) || true
    fi
  done

  echo ""
  echo -e "\033[1m📊 Kết quả: \033[32m${ok} thành công\033[0m, \033[31m${fail} thất bại\033[0m"
  echo -e "\033[2m   Data: $DATA_DIR/\033[0m"
}

main "$@"
