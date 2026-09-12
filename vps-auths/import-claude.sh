#!/usr/bin/env bash
# ==============================================================================
# vps-auths/import-claude.sh
# Import Claude credentials (sasadairaseann@gmail.com) into:
#  1. Claude Code CLI (~/.claude.json, macOS Keychain, CLAUDE_CODE_OAUTH_TOKEN)
#  2. Claude Desktop (/Applications/Claude.app via claude-auth/ tooling)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_AUTH_DIR="$ROOT_DIR/claude-auth"
AUTH_JSON="$SCRIPT_DIR/claude-sasadairaseann@gmail.com.json"

echo "=========================================================="
echo "📦 [1/2] Đang import Claude CLI credentials..."
echo "=========================================================="

if [ ! -f "$AUTH_JSON" ]; then
  echo "❌ Không tìm thấy: $AUTH_JSON" >&2
  exit 1
fi

node "$ROOT_DIR/scripts/import-vps-auths.mjs" claude "$@"

# Extract OAuth token for CLI direct run
ACCESS_TOKEN=$(python3 -c "import json; print(json.load(open('$AUTH_JSON'))['access_token'])" 2>/dev/null || echo "")

if [ -n "$ACCESS_TOKEN" ]; then
  # Create a wrapper or convenience alias in ~/.zshrc or ~/.local/bin/claude-vps if needed
  mkdir -p "$HOME/.local/bin" 2>/dev/null || true
  cat <<WRAPPER > "$HOME/.local/bin/claude-vps"
#!/usr/bin/env bash
export CLAUDE_CODE_OAUTH_TOKEN="$ACCESS_TOKEN"
exec claude "\$@"
WRAPPER
  chmod +x "$HOME/.local/bin/claude-vps" 2>/dev/null || true
  echo "  ✓ Đã tạo lệnh chạy trực tiếp CLI: ~/.local/bin/claude-vps"
fi

echo ""
echo "=========================================================="
echo "🖥️  [2/2] Kiểm tra & đồng bộ vào Claude Desktop (Claude for Mac)..."
echo "=========================================================="

SYNC_SCRIPT="$CLAUDE_AUTH_DIR/sync_claude_desktop_auth.sh"

# Check candidate cookie files that contain web sessionKey
CANDIDATE=""
for f in "$ROOT_DIR/cookies-claude.json" "$ROOT_DIR/cookies/claude/claude.ai.json" "$ROOT_DIR/cookies/claude/claude.json" "$HOME/Downloads/claude"*.json; do
  if [ -f "$f" ]; then
    CANDIDATE="$f"
    break
  fi
done

SYNCED=0
if [ -n "$CANDIDATE" ] && [ -f "$SYNC_SCRIPT" ]; then
  echo "  ▸ Tìm thấy file cookie ứng viên: $CANDIDATE"
  echo "  ▸ Đang chạy sync qua claude-auth/sync_claude_desktop_auth.sh..."
  if bash "$SYNC_SCRIPT" "$CANDIDATE" 2>&1; then
    echo "  🎉 Đã đồng bộ thành công vào Claude Desktop!"
    SYNCED=1
  else
    echo "  ⚠️  Cookie web trong file hiện tại đã hết hạn (expired)."
  fi
fi

if [ "$SYNCED" -eq 0 ]; then
  echo ""
  echo "ℹ️  LƯU Ý VỀ CLAUDE DESKTOP:"
  echo "  • File 'claude-sasadairaseann@gmail.com.json' chứa token OAuth (sk-ant-oat01-...)"
  echo "    được tạo cho Claude Code CLI (đã hoạt động 100% với: claude-vps hoặc export CLAUDE_CODE_OAUTH_TOKEN)."
  echo "  • Claude Desktop (Claude for Mac) là app Electron hiển thị web claude.ai,"
  echo "    yêu cầu cookie phiên web (sessionKey: sk-ant-sid02-...)."
  echo ""
  echo "👉 Để đăng nhập vào Claude Desktop:"
  echo "  1. Trên cửa sổ 'Claude for Mac', bấm nút [Get started]."
  echo "  2. Trình duyệt sẽ mở trang đăng nhập claude.ai → Nhập email: sasadairaseann@gmail.com"
  echo "  3. Sau khi xác nhận OTP/Google, trình duyệt sẽ tự động kích hoạt đăng nhập vào Claude for Mac!"
fi

echo "=========================================================="
