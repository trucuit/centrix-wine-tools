#!/usr/bin/env bash
# ==============================================================================
# vps-auths/import-claude.sh
# Import Claude credentials vào:
#  1. Claude Code CLI (~/.claude.json, macOS Keychain, CLAUDE_CODE_OAUTH_TOKEN)
#  2. Claude Desktop (/Applications/Claude.app via claude-auth/ tooling)
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_AUTH_DIR="$ROOT_DIR/claude-auth"

echo "=========================================================="
echo "📦 [1/2] Đang import Claude CLI credentials..."
echo "=========================================================="

# Tìm file xác thực claude*.json mới nhất trong thư mục vps-auths
AUTH_JSON=$(find "$SCRIPT_DIR" -maxdepth 1 -name "claude*.json" -type f | sort -r | head -n 1 || echo "")

if [ -z "$AUTH_JSON" ] || [ ! -f "$AUTH_JSON" ]; then
  echo "❌ Không tìm thấy file xác thực claude*.json nào trong: $SCRIPT_DIR" >&2
  echo "👉 Vui lòng chạy: ./vps-auths/download.sh để tải từ VPS về trước." >&2
  exit 1
fi

echo "  ▸ Sử dụng file xác thực: $(basename "$AUTH_JSON")"

node "$ROOT_DIR/scripts/import-vps-auths.mjs" claude "$@"

# Extract OAuth token for CLI direct run
ACCESS_TOKEN=$(python3 -c "import json; print(json.load(open('$AUTH_JSON'))['access_token'])" 2>/dev/null || echo "")

if [ -n "$ACCESS_TOKEN" ]; then
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

# Quét tìm file cookie web nào còn sống (live sessionKey)
LIVE_COOKIE_FILE=""
for f in "$ROOT_DIR/cookies/claude/"*.json "$HOME/Downloads/claude"*.json; do
  if [ -f "$f" ]; then
    IS_VALID=$(python3 -c "
import json, ssl, http.client
try:
    with open('$f') as fp: d = json.load(fp)
    cookies = d if isinstance(d, list) else d.get('cookies', [])
    cmap = {c['name']: c['value'] for c in cookies if isinstance(c, dict) and c.get('name') and c.get('value')}
    if 'sessionKey' in cmap:
        conn = http.client.HTTPSConnection('claude.ai', context=ssl.create_default_context(), timeout=5)
        conn.request('GET', '/api/bootstrap', headers={'User-Agent': 'Mozilla/5.0', 'Cookie': 'sessionKey=' + cmap['sessionKey']})
        res = json.loads(conn.getresponse().read().decode('utf-8', 'ignore'))
        if res.get('account'): print('VALID')
except: pass
" 2>/dev/null || echo "")
    if [ "$IS_VALID" = "VALID" ]; then
      LIVE_COOKIE_FILE="$f"
      break
    fi
  fi
done

if [ -n "$LIVE_COOKIE_FILE" ] && [ -f "$SYNC_SCRIPT" ]; then
  echo "  ▸ Tìm thấy file cookie web còn sống: $(basename "$LIVE_COOKIE_FILE")"
  echo "  ▸ Đang nạp vào Claude Desktop qua sync_claude_desktop_auth.sh..."
  if bash "$SYNC_SCRIPT" "$LIVE_COOKIE_FILE"; then
    echo "  🎉 Đã đồng bộ thành công vào Claude Desktop!"
  fi
else
  EMAIL=$(python3 -c "import json; print(json.load(open('$AUTH_JSON')).get('email', ''))" 2>/dev/null || echo "sasadairaseann@gmail.com")
  echo "  ℹ️  Chưa có file cookie web (sessionKey) còn sống để nạp vào Claude Desktop."
  echo ""
  echo "  📌 GIẢI THÍCH:"
  echo "  • File '$(basename "$AUTH_JSON")' từ VPS chứa OAuth Token (sk-ant-oat01-...)"
  echo "    → Dành riêng cho Claude Code CLI (dùng ngay: 'claude-vps')."
  echo "  • App 'Claude for Mac' yêu cầu Cookie phiên duyệt web (sessionKey: sk-ant-sid02-...)"
  echo "    → Không thể chuyển đổi trực tiếp từ OAuth Token sang Cookie web."
  echo ""
  echo "👉 ĐỂ KÍCH HOẠT CLAUDE DESKTOP:"
  echo "  1. Trên cửa sổ 'Claude for Mac', bấm nút [Get started]."
  echo "  2. Trình duyệt mở trang web claude.ai → Nhập email: ${EMAIL}"
  echo "  3. Xác nhận OTP/Google → App Claude Desktop sẽ tự động đăng nhập!"
fi

echo "=========================================================="
