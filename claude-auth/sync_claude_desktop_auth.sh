#!/bin/bash
# ============================================
# Sync Claude Desktop auth cookies from export JSON
# ============================================
# Steps:
# - Find source claude.ai_*.json (argument > project > Downloads)
# - Quit Claude app to release sqlite locks
# - Backup Cookies + config.json
# - Upsert claude.ai cookies into Claude Cookies sqlite DB
# - Clean non-native keys from config.json
# - Inject Claude Code CLI auth (non-fatal)
# - Re-open Claude app
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${HOME}/Library/Application Support/Claude"
COOKIES_DB="${CLAUDE_DIR}/Cookies"
CONFIG_JSON="${CLAUDE_DIR}/config.json"
ALLOW_HTTP_403_FALLBACK="${ALLOW_HTTP_403_FALLBACK:-1}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ Missing required command: $1"
    exit 1
  fi
}

find_latest_claude_json_in_dir() {
  local target_dir="$1"
  TARGET_DIR="$target_dir" python3 << 'PYEOF'
import os
from pathlib import Path

base = Path(os.environ["TARGET_DIR"]).expanduser()
if not base.exists() or not base.is_dir():
    print("")
    raise SystemExit(0)

# Match export formats: claude*.json, cookies-claude.json, session-claude.json
patterns = ["claude*.json", "cookies-claude.json", "session-claude.json"]
candidates = []
for pat in patterns:
    candidates.extend([p for p in base.glob(pat) if p.is_file() and not p.name.endswith(".storage.json")])
if not candidates:
    print("")
    raise SystemExit(0)

latest = max(candidates, key=lambda p: p.stat().st_mtime)
print(str(latest))
PYEOF
}

resolve_source_file() {
  if [ "${1:-}" != "" ] && [ "${1:-}" != "run" ] && [ -f "${1:-}" ]; then
    echo "$1"
    return
  fi

  local candidate=""

  # Prefer project's cookies directory (synced via centrix API)
  candidate="$(find_latest_claude_json_in_dir "${SCRIPT_DIR}/../cookies/claude")"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return
  fi

  candidate="$(find_latest_claude_json_in_dir "${SCRIPT_DIR}/../cookies")"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return
  fi

  # Downloads directory
  candidate="$(find_latest_claude_json_in_dir "${HOME}/Downloads")"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return
  fi

  # Fallbacks inside repository.
  candidate="$(find_latest_claude_json_in_dir "${SCRIPT_DIR}/claude")"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return
  fi

  candidate="$(find_latest_claude_json_in_dir "${SCRIPT_DIR}")"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return
  fi

  echo ""
}

validate_session_cookie() {
  local file="$1"
  SOURCE_JSON_VALIDATE="$file" python3 << 'PYEOF'
import json
import os
import ssl
import http.client
from pathlib import Path

path = Path(os.environ["SOURCE_JSON_VALIDATE"])
data = json.loads(path.read_text())
if isinstance(data, list):
    cookies = data
else:
    cookies = data.get("cookies")
    if not isinstance(cookies, list):
        auth_payload = data.get("auth")
        if isinstance(auth_payload, dict):
            cookies = auth_payload.get("cookies", [])
if not isinstance(cookies, list):
    print("MISSING:cookies")
    raise SystemExit(3)
cookie_map = {
    c.get("name"): c.get("value")
    for c in cookies
    if isinstance(c, dict) and c.get("name") and c.get("value")
}

required = ["sessionKey", "routingHint"]
missing = [k for k in required if k not in cookie_map]
if missing:
    print("MISSING:" + ",".join(missing))
    raise SystemExit(2)

preferred_order = [
    "sessionKey",
    "routingHint",
    "anthropic-device-id",
    "lastActiveOrg",
    "activitySessionId",
]

cookie_header = "; ".join(
    f"{k}={cookie_map[k]}" for k in preferred_order if k in cookie_map
)

conn = http.client.HTTPSConnection("claude.ai", context=ssl.create_default_context(), timeout=20)
conn.request(
    "GET",
    "/api/bootstrap",
    headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": cookie_header,
    },
)
resp = conn.getresponse()
body = resp.read().decode("utf-8", "ignore")
conn.close()

if resp.status != 200:
    print(f"HTTP:{resp.status}")
    raise SystemExit(3)

try:
    payload = json.loads(body)
except json.JSONDecodeError:
    print("INVALID_JSON")
    raise SystemExit(5)

account = payload.get("account") if isinstance(payload, dict) else None
if account is None:
    print("INVALID_SESSION")
    raise SystemExit(4)

print("VALID_SESSION")
raise SystemExit(0)
PYEOF
}

require_cmd jq
require_cmd sqlite3
require_cmd python3
require_cmd osascript
require_cmd open

SOURCE_JSON="$(resolve_source_file "${1:-}")"
if [ -z "$SOURCE_JSON" ]; then
  echo "❌ No source file found. Pass file path manually:"
  echo "   ./sync_claude_desktop_auth.sh /path/to/claude.ai_12-03-2026.json"
  exit 1
fi

if [ ! -f "$SOURCE_JSON" ]; then
  echo "❌ Source file not found: $SOURCE_JSON"
  exit 1
fi

if [ ! -f "$COOKIES_DB" ] || [ ! -f "$CONFIG_JSON" ]; then
  echo "❌ Claude profile files not found:"
  echo "   Cookies DB:  $COOKIES_DB"
  echo "   Config JSON: $CONFIG_JSON"
  exit 1
fi

if ! jq -e '(type == "array") or (.cookies and (.cookies|type == "array")) or (.auth.cookies and (.auth.cookies|type == "array"))' "$SOURCE_JSON" >/dev/null 2>&1; then
  echo "❌ Invalid source JSON: missing cookies array"
  exit 1
fi

echo "🔎 Validating source session..."
VALIDATION_MSG="$(validate_session_cookie "$SOURCE_JSON" 2>/dev/null || true)"
case "$VALIDATION_MSG" in
  VALID_SESSION)
    echo "✅ Source session is valid."
    ;;
  INVALID_SESSION)
    echo "❌ Source session is invalid/expired (api/bootstrap => account:null)."
    echo "   Export a fresh cookies file while Claude Web is logged in, then retry."
    echo "   Example:"
    echo "   ./sync_claude_desktop_auth.sh /path/to/new/claude.ai_*.json"
    exit 2
    ;;
  MISSING:*)
    echo "⚠️  Source file is missing auth cookies: ${VALIDATION_MSG#MISSING:}"
    # ── Fallback: re-export from CentriX ──────────────────────────
    CENTRIX_EXPORT_SCRIPT="${SCRIPT_DIR}/centrix/export_centrix_cookies.sh"
    if [ -f "$CENTRIX_EXPORT_SCRIPT" ] && [ -x "$CENTRIX_EXPORT_SCRIPT" ]; then
      echo "🔄 Attempting centrix fallback export..."
      CENTRIX_FALLBACK_OUT="${SCRIPT_DIR}/centrix/claude-max-20x.cookies.json"
      if bash "$CENTRIX_EXPORT_SCRIPT" \
           --service-name "Claude Max 20x" \
           --bookmark-url "https://claude.ai/" \
           --domain "claude.ai" \
           --out "$CENTRIX_FALLBACK_OUT" 2>&1; then
        echo "✅ CentriX fallback export succeeded: $CENTRIX_FALLBACK_OUT"
        SOURCE_JSON="$CENTRIX_FALLBACK_OUT"
        # Re-validate the freshly exported file
        echo "🔎 Re-validating fallback session..."
        VALIDATION_MSG="$(validate_session_cookie "$SOURCE_JSON" 2>/dev/null || true)"
        case "$VALIDATION_MSG" in
          VALID_SESSION)
            echo "✅ Fallback session is valid."
            ;;
          *)
            echo "❌ Fallback session also failed validation: ${VALIDATION_MSG:-unknown_error}"
            echo "   Export a fresh cookies file while Claude Web is logged in, then retry."
            exit 3
            ;;
        esac
      else
        echo "❌ CentriX fallback export failed."
        echo "   Export a fresh cookies file while Claude Web is logged in, then retry."
        exit 3
      fi
    else
      echo "❌ CentriX export script not found: $CENTRIX_EXPORT_SCRIPT"
      exit 3
    fi
    ;;
  HTTP:403)
    if [ "$ALLOW_HTTP_403_FALLBACK" = "1" ]; then
      echo "⚠️  Source validation hit HTTP:403 (Cloudflare challenge)."
      echo "   Continue with file-based auth sync fallback."
    else
      echo "❌ Session validation failed with ${VALIDATION_MSG}."
      echo "   Retry in 10-20s or pass another export file."
      exit 4
    fi
    ;;
  HTTP:*)
    echo "❌ Session validation failed with ${VALIDATION_MSG}."
    echo "   Retry in 10-20s or pass another export file."
    exit 4
    ;;
  *)
    echo "❌ Session validation failed (${VALIDATION_MSG:-unknown_error})."
    exit 5
    ;;
esac

echo "🔄 Syncing Claude Desktop auth..."
echo "   Source:  $SOURCE_JSON"
echo "   Cookies: $COOKIES_DB"
echo "   Config:  $CONFIG_JSON"
echo ""

echo "🛑 Closing Claude app..."
osascript -e 'tell application "Claude" to quit' >/dev/null 2>&1 || true
sleep 2
pkill -f "/Applications/Claude.app/Contents/MacOS/Claude" >/dev/null 2>&1 || true
pkill -f "Claude Helper" >/dev/null 2>&1 || true
sleep 1

TS="$(date +%Y%m%d-%H%M%S)"
COOKIES_BAK="${COOKIES_DB}.bak.${TS}"
CONFIG_BAK="${CONFIG_JSON}.bak.${TS}"

cp "$COOKIES_DB" "$COOKIES_BAK"
cp "$CONFIG_JSON" "$CONFIG_BAK"

echo "💾 Backup created:"
echo "   $COOKIES_BAK"
echo "   $CONFIG_BAK"
echo ""

export SOURCE_JSON COOKIES_DB
python3 << 'PYEOF'
import json
import os
import sqlite3
import time
from pathlib import Path

source_json = Path(os.environ["SOURCE_JSON"])
cookies_db = Path(os.environ["COOKIES_DB"])

data = json.loads(source_json.read_text())
if isinstance(data, list):
    cookies = data
else:
    cookies = data.get("cookies")
    if not isinstance(cookies, list):
        auth_payload = data.get("auth")
        if isinstance(auth_payload, dict):
            cookies = auth_payload.get("cookies", [])
if not isinstance(cookies, list):
    raise SystemExit("No cookies array in source JSON")
target = [
    c for c in cookies
    if isinstance(c, dict)
    and "claude.ai" in (c.get("domain") or "")
    and c.get("name")
]
if not target:
    raise SystemExit("No claude.ai cookies found in source JSON")

EPOCH_OFFSET_US = 11644473600 * 1_000_000

def now_utc_us() -> int:
    return int(time.time() * 1_000_000) + EPOCH_OFFSET_US

def expires_utc_us(exp):
    if exp is None:
        return 0
    return int(float(exp) * 1_000_000) + EPOCH_OFFSET_US

def same_site_to_int(value):
    if not isinstance(value, str):
        return -1
    value = value.lower()
    if value == "lax":
        return 1
    if value == "strict":
        return 2
    if value in ("none", "no_restriction"):
        return 0
    return -1

conn = sqlite3.connect(str(cookies_db))
cur = conn.cursor()
cur.execute("PRAGMA busy_timeout=3000")

for c in target:
    host = c.get("domain")
    name = c.get("name")
    path = c.get("path") or "/"
    value = c.get("value", "")

    secure = 1 if c.get("secure") else 0
    http_only = 1 if c.get("httpOnly") else 0
    samesite = same_site_to_int(c.get("sameSite"))

    exp_utc = expires_utc_us(c.get("expirationDate"))
    has_expires = 1 if exp_utc > 0 else 0
    is_persistent = 1 if exp_utc > 0 else 0

    source_scheme = 2 if secure else 1
    source_port = 443 if secure else 80
    source_type = 2 if host.startswith(".") else 1
    top_frame_site_key = ""
    has_cross_site_ancestor = 1

    now = now_utc_us()

    cur.execute(
        """
        DELETE FROM cookies
        WHERE host_key=? AND top_frame_site_key=? AND has_cross_site_ancestor=?
          AND name=? AND path=? AND source_scheme=? AND source_port=?
        """,
        (
            host,
            top_frame_site_key,
            has_cross_site_ancestor,
            name,
            path,
            source_scheme,
            source_port,
        ),
    )

    cur.execute(
        """
        INSERT INTO cookies (
            creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
            path, expires_utc, is_secure, is_httponly, last_access_utc,
            has_expires, is_persistent, priority, samesite,
            source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            now,
            host,
            top_frame_site_key,
            name,
            value,
            b"",
            path,
            exp_utc,
            secure,
            http_only,
            now,
            has_expires,
            is_persistent,
            1,
            samesite,
            source_scheme,
            source_port,
            now,
            source_type,
            has_cross_site_ancestor,
        ),
    )

conn.commit()

count = cur.execute(
    "SELECT COUNT(*) FROM cookies WHERE host_key LIKE '%claude.ai%'"
).fetchone()[0]

critical = cur.execute(
    """
    SELECT host_key, name, length(value) AS value_len, length(encrypted_value) AS enc_len
    FROM cookies
    WHERE host_key LIKE '%claude.ai%'
      AND name IN ('sessionKey', 'routingHint', 'activitySessionId')
    ORDER BY host_key, name
    """
).fetchall()

print(f"claude_cookie_count={count}")
for row in critical:
    print("\t".join(str(v) for v in row))

conn.close()
PYEOF

echo ""
echo "🧹 Cleaning temporary keys from config.json..."
TMP_FILE="$(mktemp)"
jq 'del(.cookies, ."cookies:source", ."cookies:lastSyncedAt", .url)' "$CONFIG_JSON" > "$TMP_FILE"
mv "$TMP_FILE" "$CONFIG_JSON"

# ── Also inject into Claude Code CLI ──────────────────────────
INJECT_SCRIPT="${SCRIPT_DIR}/inject_claude_code_auth.sh"
if [ -f "$INJECT_SCRIPT" ]; then
  echo ""
  echo "🔄 Injecting Claude Code CLI auth..."
  if ALLOW_HTTP_403_FALLBACK=1 bash "$INJECT_SCRIPT" --no-launcher -- "$SOURCE_JSON"; then
    echo "✅ Claude Code CLI auth injected."
  else
    echo "⚠️  Claude Code CLI auth injection failed (non-fatal, Desktop sync is fine)."
  fi
else
  echo "ℹ️  inject_claude_code_auth.sh not found, skipping Code CLI auth."
fi

echo ""
echo "🚀 Re-opening Claude app..."
open -a Claude

echo ""
echo "✅ Done."
echo "   If login screen still appears, press Cmd+R inside Claude."
