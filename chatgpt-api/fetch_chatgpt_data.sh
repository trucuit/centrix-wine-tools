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
#   ./fetch_chatgpt_data.sh                           # Hiện menu chọn profile (mặc định: 3 ngày gần nhất)
#   ./fetch_chatgpt_data.sh <path/to/codex-auth.json> # Chỉ định file auth cụ thể
#   ./fetch_chatgpt_data.sh --all                     # Fetch cho tất cả tài khoản
#   ./fetch_chatgpt_data.sh --days 7                  # Fetch conversations trong 7 ngày gần nhất
#   ./fetch_chatgpt_data.sh --days 0                  # Fetch tất cả conversations (không giới hạn)
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

# Trích xuất email + plan type từ tên file codex-*.json
# Input:  codex-64d43abd-xuanloc@centrix.asia-team.json
# Output: xuanloc@centrix.asia (team)
_parse_profile() {
  local name
  name="$(basename "$1" .json)"
  # Pattern: codex-<hash>-<email>-<plan>
  local email plan
  email="$(echo "$name" | sed -E 's/^codex-[a-f0-9]+-//' | sed -E 's/-[^@-]+$//')"
  plan="$(echo "$name" | grep -oE '[a-z]+$')"
  echo "$email ($plan)"
}

# Menu chọn profile tương tác
_select_profiles() {
  local -n _out_files=$1
  local all_files=()

  while IFS= read -r f; do
    all_files+=("$f")
  done < <(find "$VPS_AUTHS_DIR" -maxdepth 1 -name 'codex-*.json' -type f 2>/dev/null | sort)

  if [[ ${#all_files[@]} -eq 0 ]]; then
    echo "❌ Không tìm thấy codex-*.json trong $VPS_AUTHS_DIR"
    exit 1
  fi

  echo ""
  echo -e "\033[1;36m╔══════════════════════════════════════════════╗\033[0m"
  echo -e "\033[1;36m║       🔑 Chọn Profile ChatGPT để Fetch      ║\033[0m"
  echo -e "\033[1;36m╚══════════════════════════════════════════════╝\033[0m"
  echo ""

  local i=1
  for f in "${all_files[@]}"; do
    local label
    label="$(_parse_profile "$f")"
    printf "  \033[33m%2d)\033[0m  %s\n" "$i" "$label"
    ((i++)) || true
  done
  echo ""
  printf "  \033[33m a)\033[0m  \033[1mFetch tất cả tài khoản\033[0m\n"
  echo ""

  local choice
  while true; do
    printf "\033[36m👉 Chọn (1-%d / a): \033[0m" "${#all_files[@]}"
    read -r choice

    if [[ "$choice" == "a" || "$choice" == "A" ]]; then
      _out_files=("${all_files[@]}")
      echo -e "\033[32m✓ Đã chọn tất cả ${#all_files[@]} profiles\033[0m"
      return
    elif [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#all_files[@]} )); then
      _out_files=("${all_files[$((choice - 1))]}")
      echo -e "\033[32m✓ Đã chọn: $(_parse_profile "${_out_files[0]}")\033[0m"
      return
    else
      echo -e "\033[31m❌ Lựa chọn không hợp lệ. Thử lại.\033[0m"
    fi
  done
}

main() {
  # Check python3 + curl_cffi
  if ! python3 -c "import curl_cffi" 2>/dev/null; then
    echo "❌ Cần cài đặt curl_cffi: pip3 install --break-system-packages curl_cffi"
    exit 1
  fi

  local auth_files=()
  local custom_delay=""
  local custom_days=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --delay|-d)
        custom_delay="${2:-}"
        [[ -z "$custom_delay" ]] && { echo "❌ Thiếu giá trị delay. Ví dụ: --delay 55"; exit 1; }
        shift 2
        ;;
      --days)
        custom_days="${2:-}"
        [[ -z "$custom_days" ]] && { echo "❌ Thiếu giá trị days. Ví dụ: --days 3 (0 = tất cả)"; exit 1; }
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
        echo "  $0                           # Hiện menu chọn profile (3 ngày gần nhất)"
        echo "  $0 <path/to/codex-auth.json> # Chỉ định file auth cụ thể"
        echo "  $0 --all                     # Fetch cho tất cả tài khoản"
        echo "  $0 --days 7                  # Fetch conversations trong 7 ngày gần nhất"
        echo "  $0 --days 0                  # Fetch tất cả conversations (không giới hạn)"
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

  # Nếu không có argument → hiện menu chọn profile
  if [[ ${#auth_files[@]} -eq 0 ]]; then
    _select_profiles auth_files
  fi

  if [[ -n "$custom_delay" ]]; then
    export FETCH_DELAY="$custom_delay"
  else
    export FETCH_DELAY="${FETCH_DELAY:-55.0}"
  fi

  # Mặc định fetch 3 ngày gần nhất; --days 0 = tất cả
  if [[ -n "$custom_days" ]]; then
    export FETCH_DAYS="$custom_days"
  else
    export FETCH_DAYS="${FETCH_DAYS:-3}"
  fi

  if [[ "$FETCH_DAYS" == "0" ]]; then
    echo -e "\033[36m📅 Fetch tất cả conversations (không giới hạn ngày)\033[0m"
  else
    echo -e "\033[36m📅 Fetch conversations trong ${FETCH_DAYS} ngày gần nhất\033[0m"
  fi
  echo -e "\033[36m⏱️  Pacing delay: ${FETCH_DELAY}s giữa các hội thoại (chống 429 triệt để)\033[0m"

  local ok=0 fail=0
  for f in "${auth_files[@]}"; do
    local attempt=1
    local max_attempts=10
    local success=0
    while [[ $attempt -le $max_attempts ]]; do
      echo -e "\033[36m🚀 [Lần $attempt/$max_attempts] Bắt đầu tải: $(_parse_profile "$f")...\033[0m"
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
