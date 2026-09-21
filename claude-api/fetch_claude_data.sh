#!/usr/bin/env bash
# ==============================================================================
# claude-api/fetch_claude_data.sh
#
# Tải toàn bộ các cuộc hội thoại Claude về local và xuất sang Markdown.
# Hoạt động tương tự `chatgpt-api/fetch_chatgpt_data.sh`.
#
# Cách dùng:
#   ./fetch_claude_data.sh                          # Tự động chọn file auth / cookie Claude
#   ./fetch_claude_data.sh <path/to/auth_or_cookie> # Chỉ định file cụ thể
#
# Output: claude-api/data/<email>/
#   ├── conversations.json      (danh sách tất cả hội thoại)
#   ├── conversations/<id>.json (chi tiết từng cuộc trò chuyện)
#   ├── conversations_md/       (các file Markdown đã format)
#   │   └── index.md            (bảng mục lục tổng hợp)
#   ├── assets/<id>/            (file đính kèm tải về)
#   └── summary.txt             (tóm tắt kết quả)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VPS_AUTHS_DIR="$ROOT_DIR/vps-auths"
COOKIES_DIR="$ROOT_DIR/cookies/claude"
DATA_DIR="$SCRIPT_DIR/data"

main() {
  # 1. Kiểm tra môi trường python3 + curl_cffi
  if ! python3 -c "import curl_cffi" 2>/dev/null; then
    echo "❌ Cần cài đặt curl_cffi: pip3 install --break-system-packages curl_cffi"
    exit 1
  fi

  # 2. Hỗ trợ cờ 'code' / '--code' để xuất phiên Claude Code CLI
  if [[ "${1:-}" == "code" || "${1:-}" == "--code" ]]; then
    echo "=========================================================="
    echo "🚀 Bắt đầu xuất toàn bộ phiên làm việc Claude Code CLI..."
    echo "📂 Nơi lưu trữ: $DATA_DIR/claude_code_cli"
    echo "=========================================================="
    python3 "$SCRIPT_DIR/export_claude_code_sessions.py" "$DATA_DIR/claude_code_cli"
    exit 0
  fi

  local auth_file=""

  # 3. Xác định file input
  if [[ -n "${1:-}" && -f "${1:-}" ]]; then
    auth_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
  else
    # Ưu tiên tìm file cookie có sessionKey còn sống trong cookies/claude
    for f in "$COOKIES_DIR"/claude*.json "$VPS_AUTHS_DIR"/claude*.json; do
      if [[ -f "$f" ]]; then
        auth_file="$f"
        break
      fi
    done
  fi

  if [[ -z "$auth_file" || ! -f "$auth_file" ]]; then
    echo "❌ Không tìm thấy file auth hoặc cookie Claude."
    echo "👉 Cách dùng: ./fetch_claude_data.sh <path/to/claude_auth_or_cookie.json>"
    exit 1
  fi

  echo "=========================================================="
  echo "🚀 Bắt đầu tải dữ liệu Claude..."
  echo "📄 Nguồn xác thực: $(basename "$auth_file")"
  echo "📂 Nơi lưu trữ:     $DATA_DIR"
  echo "=========================================================="

  mkdir -p "$DATA_DIR"

  if python3 "$SCRIPT_DIR/_fetch_claude_data.py" "$auth_file" "$DATA_DIR"; then
    echo ""
    echo -e "\033[32m🎉 Hoàn tất thành công! Xem dữ liệu tại: $DATA_DIR/\033[0m"
  else
    echo ""
    echo -e "\033[33m⚠️  Lưu ý về phương thức xác thực Claude:\033[0m"
    echo "  • File OAuth token từ Claude Code CLI ('sk-ant-oat01-...') không có quyền đọc"
    echo "    lịch sử chat trên web claude.ai nếu đã bị thu hồi (Revoked)."
    echo "  • Để tải toàn bộ lịch sử chat trên giao diện Web Claude, bạn chỉ cần xuất file"
    echo "    Cookie chứa 'sessionKey' (sk-ant-sid...) từ trình duyệt vào thư mục cookies/claude/."
  fi
}

main "$@"
