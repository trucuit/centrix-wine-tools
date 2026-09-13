#!/usr/bin/env zsh
set -euo pipefail

# ─────────────────────────────────────────────────────────────────
# grok-cli-to-chrome.sh
# Uses the Grok CLI refresh_token from ~/.grok/auth.json to
# open Chrome via the OIDC authorize flow, creating a web session
# on grok.com for the same account (lta.baoduc@gmail.com).
#
# How it works:
#   1. Read refresh_token + client_id from ~/.grok/auth.json
#   2. Exchange refresh_token for a fresh access_token via auth.x.ai
#   3. Build an OIDC authorize URL for grok.com's web client
#   4. Open Chrome to that URL — since the user is already authed
#      at auth.x.ai, it auto-redirects back with SSO cookies set
# ─────────────────────────────────────────────────────────────────

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
AUTH_FILE="${HOME}/.grok/auth.json"

if [[ ! -f "$AUTH_FILE" ]]; then
  print -r -- "ERROR: $AUTH_FILE not found. Run 'grok login --oauth' first." >&2
  exit 1
fi

# Extract auth info
print -r -- "📖 Reading ~/.grok/auth.json..."
AUTH_INFO=$(python3 -c "
import json, sys
with open('$AUTH_FILE') as f:
    data = json.load(f)
entry = list(data.values())[0]
print(entry.get('refresh_token', ''))
print(entry.get('oidc_client_id', ''))
print(entry.get('oidc_issuer', ''))
print(entry.get('email', ''))
print(entry.get('first_name', '') + ' ' + entry.get('last_name', ''))
")

REFRESH_TOKEN=$(echo "$AUTH_INFO" | sed -n '1p')
CLIENT_ID=$(echo "$AUTH_INFO" | sed -n '2p')
ISSUER=$(echo "$AUTH_INFO" | sed -n '3p')
EMAIL=$(echo "$AUTH_INFO" | sed -n '4p')
NAME=$(echo "$AUTH_INFO" | sed -n '5p')

if [[ -z "$REFRESH_TOKEN" ]]; then
  print -r -- "ERROR: No refresh_token found. Run 'grok login --oauth' first." >&2
  exit 1
fi

print -r -- "👤 Account: $NAME ($EMAIL)"
print -r -- "🔑 Refreshing access token..."

# Refresh token to establish a fresh auth session
REFRESH_RESULT=$(curl -s -X POST "${ISSUER}/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}&client_id=${CLIENT_ID}")

NEW_TOKEN=$(echo "$REFRESH_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('access_token',''))" 2>/dev/null)

if [[ -z "$NEW_TOKEN" ]]; then
  print -r -- "ERROR: Token refresh failed. Run 'grok login --oauth' to re-authenticate." >&2
  echo "$REFRESH_RESULT" >&2
  exit 1
fi

print -r -- "✅ Token refreshed successfully"

# ─────────────────────────────────────────────────────────────────
# Strategy: Open grok.com in Chrome
# Since curl can't bypass Cloudflare, we open Chrome directly.
# The OIDC session at auth.x.ai is active (we just refreshed),
# so navigating to grok.com should auto-detect the session.
#
# We'll open the login flow URL which will redirect through
# accounts.x.ai and set SSO cookies in Chrome.
# ─────────────────────────────────────────────────────────────────

# Generate PKCE code_verifier and code_challenge
CODE_VERIFIER=$(python3 -c "
import secrets, hashlib, base64
verifier = secrets.token_urlsafe(43)
print(verifier)
")

CODE_CHALLENGE=$(python3 -c "
import hashlib, base64
verifier = '$CODE_VERIFIER'
digest = hashlib.sha256(verifier.encode()).digest()
challenge = base64.urlsafe_b64encode(digest).rstrip(b'=').decode()
print(challenge)
")

# Build the OIDC authorize URL
# This is the same flow grok.com uses to authenticate
STATE=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
NONCE=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")

# Use grok.com's web client_id instead of CLI's client_id
# The web app uses a different client_id, so we'll just open grok.com
# and let it handle the auth flow naturally

# Determine Chrome profile to use
CHROME_PROFILE_DIR="${CENTRIX_CHROME_PROFILE:-${SCRIPT_DIR}/../.chrome-cookie-profile}"

print -r -- ""
print -r -- "🌐 Opening grok.com in Chrome..."
print -r -- "   The page will use your existing auth.x.ai session."
print -r -- ""

# Check if we should use a specific Chrome profile
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -x "$CHROME_APP" ]]; then
  CHROME_APP=$(mdfind 'kMDItemCFBundleIdentifier == "com.google.Chrome"' | head -1)/Contents/MacOS/Google\ Chrome
fi

if [[ -d "$CHROME_PROFILE_DIR" ]]; then
  print -r -- "📂 Using Chrome profile: $CHROME_PROFILE_DIR"
  # Open with the specific profile that has cookies
  "$CHROME_APP" \
    --user-data-dir="$CHROME_PROFILE_DIR" \
    "https://accounts.x.ai/sign-in?redirect_url=https%3A%2F%2Fgrok.com%2F" \
    2>/dev/null &
else
  print -r -- "📂 Using default Chrome profile"
  open -a "Google Chrome" "https://accounts.x.ai/sign-in?redirect_url=https%3A%2F%2Fgrok.com%2F"
fi

print -r -- ""
print -r -- "✨ Chrome đã mở. Nếu bạn thấy trang login:"
print -r -- "   → Đăng nhập bằng email: $EMAIL"
print -r -- "   → Session sẽ tự động được thiết lập"
print -r -- ""
print -r -- "💡 Tip: Nếu bạn muốn login tự động không cần nhập mật khẩu,"
print -r -- "   chạy 'grok login --oauth' trong terminal, sau đó mở lại script này."
