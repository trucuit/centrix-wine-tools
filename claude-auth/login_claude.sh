#!/bin/bash
# ==============================================================================
# Claude Code CLI - Subscription OAuth Login
# ==============================================================================
# Tự động tạo link OAuth PKCE với Claude subscription, in ra terminal để người dùng
# mở trong trình duyệt, nhận auth code (code#state) và hoàn tất đăng nhập.
#
# Dựa trên phân tích mã nguồn Claude Code CLI (v2.1.x) Auth Flow:
#  - Client ID: 9d1c250a-e61b-44d9-88ed-5944d1962f5e
#  - Authorize URL: https://claude.com/cai/oauth/authorize
#  - Token URL: https://platform.claude.com/v1/oauth/token
#  - Profile URL: https://api.anthropic.com/api/oauth/profile
#  - Manual Callback: https://platform.claude.com/oauth/code/callback
#  - Keychain Service: "Claude Code-credentials" (account: $USER)
#  - Plaintext Fallback: ~/.claude/.credentials.json
#  - State Config: ~/.claude.json
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH}"

resolve_default_user() {
  local detected_user=""
  if command -v stat >/dev/null 2>&1; then
    detected_user="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
  fi
  if [ -z "$detected_user" ] || [ "$detected_user" = "root" ]; then
    detected_user="${SUDO_USER:-${USER:-$(whoami)}}"
  fi
  printf '%s\n' "$detected_user"
}

resolve_default_home() {
  local detected_user="${1:-}"
  local detected_home=""
  if [ -z "$detected_user" ]; then
    detected_user="$(resolve_default_user)"
  fi
  if command -v dscl >/dev/null 2>&1; then
    detected_home="$(dscl . -read "/Users/$detected_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
  fi
  if [ -z "$detected_home" ]; then
    detected_home="${HOME:-}"
  fi
  printf '%s\n' "$detected_home"
}

DEFAULT_USER="$(resolve_default_user)"
DEFAULT_HOME="$(resolve_default_home "$DEFAULT_USER")"
export DEFAULT_USER DEFAULT_HOME

usage() {
  cat <<'EOF'
Sử dụng:
  ./login_claude_sub.sh [tùy chọn]

Mô tả:
  Đăng nhập Claude Code CLI với gói Subscription (Claude Pro / Max / Team).
  Tạo link xác thực OAuth PKCE, in ra màn hình để người dùng mở trên trình duyệt,
  và sau đó nhận Auth Code để hoàn tất xác thực và lưu vào Keychain & ~/.claude.json.

Tùy chọn:
  -o, --open            Tự động mở link đăng nhập trên trình duyệt mặc định
  -c, --chrome          Mở link đăng nhập trên Google Chrome
  -e, --email EMAIL     Điền sẵn email đăng nhập trên trang Claude
      --sso             Bật chế độ đăng nhập SSO
      --no-server       Tắt local loopback server (chỉ nhập code thủ công)
  -s, --status          Xem trạng thái xác thực hiện tại của Claude CLI
      --native          Chạy trực tiếp lệnh native: claude auth login --claudeai
      --setup-token     Chạy trực tiếp lệnh native: claude setup-token
  -h, --help            Hiển thị hướng dẫn sử dụng

Ví dụ:
  ./login_claude_sub.sh
  ./login_claude_sub.sh --open
  ./login_claude_sub.sh --chrome
  ./login_claude_sub.sh --email user@example.com
EOF
}

# Check for special dispatch flags
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --native|--cli)
      if ! command -v claude >/dev/null 2>&1; then
        echo $'\U274C Lỗi: Lệnh claude chưa được cài đặt trong PATH.' >&2
        exit 1
      fi
      echo $'\U1F680 Đang khởi chạy Claude CLI native login (--claudeai)...'
      exec claude auth login --claudeai "${@}"
      ;;
    --setup-token)
      if ! command -v claude >/dev/null 2>&1; then
        echo $'\U274C Lỗi: Lệnh claude chưa được cài đặt trong PATH.' >&2
        exit 1
      fi
      echo $'\U1F680 Đang khởi chạy Claude CLI setup-token...'
      exec claude setup-token
      ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo $'\U274C Lỗi: Cần cài đặt python3 để chạy script này.' >&2
  exit 1
fi

chmod +x "$SCRIPT_DIR/login_claude_sub.py" 2>/dev/null || true

# Execute Python OAuth engine
exec python3 "$SCRIPT_DIR/login_claude_sub.py" "$@"
