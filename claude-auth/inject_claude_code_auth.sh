#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

resolve_default_user() {
  local detected_user=""

  if command -v stat >/dev/null 2>&1; then
    detected_user="$(stat -f '%Su' /dev/console 2>/dev/null || true)"
  fi

  if [ -z "$detected_user" ] || [ "$detected_user" = "root" ]; then
    detected_user="${SUDO_USER:-${USER:-$(whoami)}}"
  fi

  if [ -z "$detected_user" ]; then
    echo "❌ Could not determine default user." >&2
    exit 1
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

  if [ -z "$detected_home" ]; then
    echo "❌ Could not determine home directory for user: $detected_user" >&2
    exit 1
  fi

  printf '%s\n' "$detected_home"
}

DEFAULT_USER="$(resolve_default_user)"
DEFAULT_HOME="$(resolve_default_home "$DEFAULT_USER")"
DEFAULT_DOWNLOADS_DIR="${DEFAULT_HOME}/Downloads"
DEFAULT_CLAUDE_BACKUP_DIR="${DEFAULT_HOME}/.claude/backups"
DEFAULT_CLAUDE_CREDENTIALS_FILE="${DEFAULT_HOME}/.claude/.credentials.json"
DEFAULT_LAUNCHER_PATH="${DEFAULT_HOME}/.local/bin/claude-like-desktop"
ALLOW_HTTP_403_FALLBACK="${ALLOW_HTTP_403_FALLBACK:-0}"
DEFAULT_CLAUDE_KEYCHAIN_BACKUP_DIR="${DEFAULT_CLAUDE_BACKUP_DIR}/keychain-runtime-auth-purge"

SOURCE_JSON_ARG=""
TARGET_JSON=""
RUN_PERSISTENT_OAUTH=0
INSTALL_LAUNCHER=1
LAUNCHER_PATH="$DEFAULT_LAUNCHER_PATH"
LAUNCHER_MODE_EXPLICIT=0

usage() {
  cat <<'EOF'
Usage:
  ./inject_claude_code_auth.sh [options] [source_json] [target_json]

What it does:
  1. Validate exported claude.ai cookies
  2. Inject Claude Desktop auth cookies into ~/.claude.json-style state
  3. By default, install a desktop-style launcher that runs Claude with
     short-lived runtime OAuth like run_claude_like_desktop.sh

Options:
  --persist-oauth       Restore persistent Claude CLI OAuth into keychain/.credentials.json
  --desktop-like        Force desktop-style runtime auth mode (default)
  --launcher PATH       Install desktop-style launcher at PATH
  --no-launcher         Skip launcher installation
  --target-json FILE    Override target JSON path (default: ~/.claude.json)
  -h, --help            Show this help
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --persist-oauth)
        RUN_PERSISTENT_OAUTH=1
        shift
        ;;
      --desktop-like)
        RUN_PERSISTENT_OAUTH=0
        shift
        ;;
      --launcher)
        LAUNCHER_PATH="${2:?missing value for --launcher}"
        INSTALL_LAUNCHER=1
        LAUNCHER_MODE_EXPLICIT=1
        shift 2
        ;;
      --no-launcher)
        INSTALL_LAUNCHER=0
        LAUNCHER_MODE_EXPLICIT=1
        shift
        ;;
      --target-json)
        TARGET_JSON="${2:?missing value for --target-json}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        echo "❌ Unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
      *)
        if [ -z "$SOURCE_JSON_ARG" ]; then
          SOURCE_JSON_ARG="$1"
        elif [ -z "$TARGET_JSON" ]; then
          TARGET_JSON="$1"
        else
          echo "❌ Unexpected extra argument: $1" >&2
          usage >&2
          exit 1
        fi
        shift
        ;;
    esac
  done

  while [ "$#" -gt 0 ]; do
    if [ -z "$SOURCE_JSON_ARG" ]; then
      SOURCE_JSON_ARG="$1"
    elif [ -z "$TARGET_JSON" ]; then
      TARGET_JSON="$1"
    else
      echo "❌ Unexpected extra argument: $1" >&2
      usage >&2
      exit 1
    fi
    shift
  done

  if [ "$RUN_PERSISTENT_OAUTH" -eq 1 ] && [ "$LAUNCHER_MODE_EXPLICIT" -eq 0 ]; then
    INSTALL_LAUNCHER=0
  fi

  TARGET_JSON="${TARGET_JSON:-$DEFAULT_HOME/.claude.json}"
}

parse_args "$@"

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ Missing required command: python3"
  exit 1
fi

find_latest_claude_json_in_dir() {
  local target_dir="$1"
  TARGET_DIR="$target_dir" python3 << 'PYEOF'
import os
from pathlib import Path

base = Path(os.environ["TARGET_DIR"]).expanduser()
if not base.exists() or not base.is_dir():
    print("")
    raise SystemExit(0)

candidates = [p for p in base.glob("claude.ai*.json") if p.is_file()]
if not candidates:
    print("")
    raise SystemExit(0)

latest = max(candidates, key=lambda p: p.stat().st_mtime)
print(str(latest))
PYEOF
}

resolve_source_file() {
  if [ "${1:-}" != "" ]; then
    echo "$1"
    return
  fi

  local candidate

  # Prefer newest export from Downloads.
  candidate="$(find_latest_claude_json_in_dir "$DEFAULT_DOWNLOADS_DIR")"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return
  fi

  # Fallback to repo-local files.
  candidate="$(find_latest_claude_json_in_dir "$SCRIPT_DIR/claude")"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return
  fi

  candidate="$(find_latest_claude_json_in_dir "$SCRIPT_DIR")"
  if [ -n "$candidate" ]; then
    echo "$candidate"
    return
  fi

  echo ""
}

check_claude_cli_status() {
  CLAUDE_STATUS_HOME="$DEFAULT_HOME" python3 << 'PYEOF'
import json
import os
import subprocess

env = dict(os.environ)
env["HOME"] = os.environ["CLAUDE_STATUS_HOME"]

try:
    result = subprocess.run(
        ["claude", "auth", "status"],
        capture_output=True,
        text=True,
        timeout=5,
        env=env,
        check=False,
    )
except FileNotFoundError:
    print("UNAVAILABLE")
    raise SystemExit(0)
except subprocess.TimeoutExpired:
    print("TIMEOUT")
    raise SystemExit(0)

try:
    payload = json.loads(result.stdout)
except Exception:
    if result.returncode != 0:
        print("ERROR")
    else:
        print("INVALID")
    raise SystemExit(0)

print("LOGGED_IN" if payload.get("loggedIn") else "LOGGED_OUT")
PYEOF
}

file_has_oauth_payload() {
  local source_file="$1"
  OAUTH_CHECK_FILE="$source_file" python3 << 'PYEOF'
import json
import os
from pathlib import Path

source = Path(os.environ["OAUTH_CHECK_FILE"])
try:
    payload = json.loads(source.read_text())
except Exception:
    print("NO")
    raise SystemExit(0)

oauth = payload.get("claudeAiOauth") if isinstance(payload, dict) else None
token = oauth.get("accessToken") if isinstance(oauth, dict) else None
print("YES" if isinstance(token, str) and bool(token) else "NO")
PYEOF
}

find_latest_oauth_backup_in_dir() {
  local target_dir="$1"
  TARGET_DIR="$target_dir" python3 << 'PYEOF'
import os
from pathlib import Path

base = Path(os.environ["TARGET_DIR"]).expanduser()
if not base.exists() or not base.is_dir():
    print("")
    raise SystemExit(0)

candidates = [p for p in base.glob("claude-code-keychain.backup.*.json") if p.is_file()]
if not candidates:
    print("")
    raise SystemExit(0)

latest = max(candidates, key=lambda p: p.stat().st_mtime)
print(str(latest))
PYEOF
}

resolve_oauth_source_file() {
  local preferred_file="${1:-}"
  local candidate

  if [ -n "$preferred_file" ] && [ -f "$preferred_file" ]; then
    if [ "$(file_has_oauth_payload "$preferred_file")" = "YES" ]; then
      echo "$preferred_file"
      return
    fi
  fi

  candidate="$(find_latest_oauth_backup_in_dir "$DEFAULT_CLAUDE_BACKUP_DIR")"
  if [ -n "$candidate" ] && [ "$(file_has_oauth_payload "$candidate")" = "YES" ]; then
    echo "$candidate"
    return
  fi

  echo ""
}

restore_claude_cli_oauth() {
  local oauth_source="$1"

  if [ -z "$oauth_source" ] || [ ! -f "$oauth_source" ]; then
    return 1
  fi

  CLAUDE_OAUTH_SOURCE="$oauth_source" \
  CLAUDE_OAUTH_USER="$DEFAULT_USER" \
  CLAUDE_OAUTH_BACKUP_DIR="$DEFAULT_CLAUDE_BACKUP_DIR" \
  CLAUDE_OAUTH_CREDENTIALS_FILE="$DEFAULT_CLAUDE_CREDENTIALS_FILE" \
  python3 << 'PYEOF'
import hashlib
import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

source_path = Path(os.environ["CLAUDE_OAUTH_SOURCE"])
backup_dir = Path(os.environ["CLAUDE_OAUTH_BACKUP_DIR"])
credentials_path = Path(os.environ["CLAUDE_OAUTH_CREDENTIALS_FILE"])
account = os.environ.get("CLAUDE_OAUTH_USER") or os.environ.get("USER") or "claude-code-user"

source_data = json.loads(source_path.read_text())
if not isinstance(source_data, dict):
    raise SystemExit("❌ Invalid OAuth source: expected JSON object")

oauth = source_data.get("claudeAiOauth")
if not isinstance(oauth, dict):
    raise SystemExit("❌ Invalid OAuth source: missing .claudeAiOauth object")

access_token = oauth.get("accessToken")
if not isinstance(access_token, str) or not access_token:
    raise SystemExit("❌ Invalid OAuth source: missing .claudeAiOauth.accessToken")

oauth_payload = {"accessToken": access_token}
for key in ("refreshToken", "expiresAt", "scopes", "subscriptionType", "rateLimitTier"):
    value = oauth.get(key)
    if value is not None:
        oauth_payload[key] = value

payload = {"claudeAiOauth": oauth_payload}

oauth_suffix = os.environ.get("CLAUDE_CODE_OAUTH_FILE_SUFFIX")
if oauth_suffix is None:
    oauth_suffix = "-custom-oauth" if os.environ.get("CLAUDE_CODE_CUSTOM_OAUTH_URL") else ""

config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
hash_suffix = ""
if config_dir:
    hash_suffix = "-" + hashlib.sha256(config_dir.encode("utf-8")).hexdigest()[:8]

service_name = f"Claude Code{oauth_suffix}-credentials{hash_suffix}"

backup_dir.mkdir(parents=True, exist_ok=True)
timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
backup_path = backup_dir / f"claude-code-keychain.backup.{timestamp}.json"
backup_written = False

if shutil.which("security"):
    find_cmd = ["security", "find-generic-password", "-a", account, "-w", "-s", service_name]
    existing = subprocess.run(find_cmd, capture_output=True, text=True, check=False)
    existing_payload = existing.stdout.strip()
    if existing.returncode == 0 and existing_payload:
        backup_path.write_text(existing_payload + "\n")
        os.chmod(backup_path, 0o600)
        backup_written = True

if not backup_written and credentials_path.is_file():
    existing_payload = credentials_path.read_text().strip()
    if existing_payload:
        backup_path.write_text(existing_payload + "\n")
        os.chmod(backup_path, 0o600)
        backup_written = True

if backup_written:
    print(f"💾 OAuth backup: {backup_path}")

serialized_payload = json.dumps(payload, separators=(",", ":"))
hex_payload = serialized_payload.encode("utf-8").hex()

keychain_restored = False
if shutil.which("security"):
    write_cmd = ["security", "add-generic-password", "-U", "-a", account, "-s", service_name, "-X", hex_payload]
    write_result = subprocess.run(write_cmd, capture_output=True, text=True, check=False)
    if write_result.returncode == 0:
        keychain_restored = True
        print(f"✅ Restored Claude CLI OAuth to keychain service: {service_name}")
    else:
        message = (write_result.stderr or write_result.stdout or "").strip()
        if message:
            message = message.splitlines()[-1]
            print(f"⚠️  Keychain restore failed ({message}). Falling back to plaintext credentials.")
        else:
            print("⚠️  Keychain restore failed. Falling back to plaintext credentials.")

if not keychain_restored:
    credentials_path.parent.mkdir(parents=True, exist_ok=True)
    credentials_path.write_text(json.dumps(payload, indent=2) + "\n")
    os.chmod(credentials_path, 0o600)
    print(f"✅ Restored Claude CLI OAuth fallback: {credentials_path}")
PYEOF
}

install_claude_like_desktop_launcher() {
  local source_json="$1"
  local launcher_path="$2"
  local runner_path="$SCRIPT_DIR/run_claude_like_desktop.sh"
  local backup_path=""

  if [ ! -f "$runner_path" ]; then
    echo "❌ Missing launcher source script: $runner_path" >&2
    return 1
  fi

  backup_path="$(
    CLAUDE_DESKTOP_LAUNCHER_PATH="$launcher_path" \
    CLAUDE_DESKTOP_LAUNCHER_SOURCE="$source_json" \
    CLAUDE_DESKTOP_LAUNCHER_RUNNER="$runner_path" \
    python3 <<'PYEOF'
import os
import shlex
import shutil
from datetime import datetime
from pathlib import Path

launcher = Path(os.environ["CLAUDE_DESKTOP_LAUNCHER_PATH"]).expanduser()
source = Path(os.environ["CLAUDE_DESKTOP_LAUNCHER_SOURCE"]).expanduser()
runner = Path(os.environ["CLAUDE_DESKTOP_LAUNCHER_RUNNER"]).expanduser()

header = "# Generated by inject_claude_code_auth.sh\n"
body = (
    "#!/bin/bash\n"
    "set -euo pipefail\n\n"
    f"exec {shlex.quote(str(runner))} {shlex.quote(str(source))} -- \"$@\"\n"
)
content = header + body

launcher.parent.mkdir(parents=True, exist_ok=True)

backup = ""
if launcher.exists():
    existing = launcher.read_text()
    if existing != content and "Generated by inject_claude_code_auth.sh" not in existing:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = launcher.with_name(f"{launcher.name}.bak.{timestamp}")
        shutil.copy2(launcher, backup_path)
        backup = str(backup_path)

launcher.write_text(content)
os.chmod(launcher, 0o755)
print(backup)
PYEOF
  )"

  if [ -n "$backup_path" ]; then
    echo "💾 Existing launcher backup: $backup_path"
  fi

  echo "✅ Installed desktop-style Claude launcher: $launcher_path"
  echo "   Source cookies: $source_json"
}

purge_persistent_claude_cli_oauth() {
  local timestamp
  local backup_dir="$DEFAULT_CLAUDE_KEYCHAIN_BACKUP_DIR"
  local services=(
    "Claude Code-credentials"
    "Claude Code-custom-oauth-credentials"
  )
  local service
  local dumped=0
  local deleted=0

  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    local config_hash
    config_hash="$(
      CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" python3 <<'PYEOF'
import hashlib
import os
print(hashlib.sha256(os.environ["CLAUDE_CONFIG_DIR"].encode("utf-8")).hexdigest()[:8])
PYEOF
    )"
    services+=(
      "Claude Code-credentials-${config_hash}"
      "Claude Code-custom-oauth-credentials-${config_hash}"
    )
  fi

  timestamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup_dir"

  if command -v claude >/dev/null 2>&1; then
    HOME="$DEFAULT_HOME" claude auth logout >/dev/null 2>&1 || true
  fi

  for service in "${services[@]}"; do
    if command -v security >/dev/null 2>&1; then
      local payload
      payload="$(security find-generic-password -a "$DEFAULT_USER" -s "$service" -w 2>/dev/null || true)"
      if [ -n "$payload" ]; then
        local backup_file="$backup_dir/${timestamp}.${service// /_}.json"
        printf '%s\n' "$payload" > "$backup_file"
        chmod 600 "$backup_file"
        dumped=1
      fi

      if security delete-generic-password -a "$DEFAULT_USER" -s "$service" >/dev/null 2>&1; then
        deleted=1
        echo "🧹 Removed keychain OAuth service: $service"
      fi
    fi
  done

  if [ -f "$DEFAULT_CLAUDE_CREDENTIALS_FILE" ]; then
    local creds_backup="$backup_dir/${timestamp}.credentials.json"
    cp "$DEFAULT_CLAUDE_CREDENTIALS_FILE" "$creds_backup"
    chmod 600 "$creds_backup"
    rm -f "$DEFAULT_CLAUDE_CREDENTIALS_FILE"
    dumped=1
    deleted=1
    echo "🧹 Removed plaintext Claude CLI OAuth: $DEFAULT_CLAUDE_CREDENTIALS_FILE"
  fi

  if [ "$dumped" -eq 1 ]; then
    echo "💾 OAuth cleanup backup dir: $backup_dir"
  fi

  if [ "$deleted" -eq 0 ]; then
    echo "ℹ️  No persistent Claude CLI OAuth store found to purge."
  fi
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
cookies = data.get("cookies", [])
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

if '"account":null' in body:
    print("INVALID_SESSION")
    raise SystemExit(4)

if '"account":{' in body:
    print("VALID_SESSION")
    raise SystemExit(0)

print("UNKNOWN_RESPONSE")
raise SystemExit(5)
PYEOF
}

SOURCE_JSON="$(resolve_source_file "$SOURCE_JSON_ARG")"

if [ ! -f "$SOURCE_JSON" ]; then
  echo "❌ Source file not found: $SOURCE_JSON"
  echo "   Hint: put file in $DEFAULT_DOWNLOADS_DIR as claude.ai*.json"
  exit 1
fi

if [ ! -f "$TARGET_JSON" ]; then
  echo "❌ Target file not found: $TARGET_JSON"
  echo "   Resolved home directory: $DEFAULT_HOME"
  echo "   Override with: $0 <source_json> <target_json>"
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
    exit 2
    ;;
  MISSING:*)
    echo "❌ Source file is missing auth cookies: ${VALIDATION_MSG#MISSING:}"
    exit 3
    ;;
  HTTP:403)
    if [ "$ALLOW_HTTP_403_FALLBACK" = "1" ]; then
      echo "⚠️  Source validation hit HTTP:403 (Cloudflare challenge)."
      echo "   Continue with file-based Claude Code runtime auth setup."
    else
      echo "❌ Session validation failed with ${VALIDATION_MSG}."
      echo "   Retry in 10-20s or use another export file."
      exit 4
    fi
    ;;
  HTTP:*)
    echo "❌ Session validation failed with ${VALIDATION_MSG}."
    echo "   Retry in 10-20s or use another export file."
    exit 4
    ;;
  *)
    echo "❌ Session validation failed (${VALIDATION_MSG:-unknown_error})."
    exit 5
    ;;
esac

echo "🔄 Injecting Claude Code auth"
echo "   Source: $SOURCE_JSON"
echo "   Target: $TARGET_JSON"

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_JSON="${TARGET_JSON}.bak.${TS}"
cp "$TARGET_JSON" "$BACKUP_JSON"

export SOURCE_JSON TARGET_JSON
CLAUDE_BACKUP_DIR="$DEFAULT_CLAUDE_BACKUP_DIR" python3 << 'PYEOF'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

source_path = Path(os.environ["SOURCE_JSON"])
target_path = Path(os.environ["TARGET_JSON"])
claude_backup_dir = Path(os.environ["CLAUDE_BACKUP_DIR"])

source_data = json.loads(source_path.read_text())
cookies = source_data.get("cookies")
if not isinstance(cookies, list):
    raise SystemExit("❌ Invalid source JSON: missing .cookies array")

preferred_cookie_names = [
    "anthropic-device-id",
    "activitySessionId",
    "sessionKey",
    "routingHint",
    "lastActiveOrg",
    "ajs_user_id",
    "ajs_anonymous_id",
]

def normalize(cookie):
    return {
        "name": cookie.get("name"),
        "value": cookie.get("value"),
        "domain": cookie.get("domain"),
        "path": cookie.get("path", "/"),
        "expirationDate": cookie.get("expirationDate"),
        "secure": bool(cookie.get("secure", False)),
        "httpOnly": bool(cookie.get("httpOnly", False)),
        "sameSite": cookie.get("sameSite", "unspecified"),
    }

all_claude = []
preferred = []
seen = set()
for cookie in cookies:
    if not isinstance(cookie, dict):
        continue
    domain = cookie.get("domain", "")
    name = cookie.get("name")
    value = cookie.get("value")
    if "claude.ai" not in str(domain) or not name or value is None:
        continue

    normalized = normalize(cookie)
    key = (normalized["name"], normalized["domain"], normalized["path"])
    if key in seen:
        continue
    seen.add(key)
    all_claude.append(normalized)

    if name in preferred_cookie_names:
        preferred.append(normalized)

cleaned_cookies = preferred if preferred else all_claude

if not cleaned_cookies:
    raise SystemExit("❌ No claude.ai cookies found in source JSON")

target_data = json.loads(target_path.read_text())
if not isinstance(target_data, dict):
    raise SystemExit("❌ Target JSON must be an object")

def load_json_object(path: Path):
    try:
        data = json.loads(path.read_text())
    except Exception:
        return None
    return data if isinstance(data, dict) else None

def backup_score(data: dict) -> int:
    score = len(data.keys())
    if data.get("hasCompletedOnboarding") is True:
        score += 500
    if isinstance(data.get("auth"), dict):
        score += 300
    if isinstance(data.get("oauthAccount"), dict):
        score += 100
    if isinstance(data.get("tipsHistory"), dict):
        score += 50
    if isinstance(data.get("cachedStatsigGates"), dict):
        score += 50
    return score

def candidate_backup_paths(target: Path):
    candidates = []
    candidates.extend(sorted(target.parent.glob(f"{target.name}.bak.*")))
    for direct_name in (
        f"{target.name}.backup",
        f"{target.name}.backup.*",
    ):
        if "*" in direct_name:
            candidates.extend(sorted(target.parent.glob(direct_name)))
        else:
            path = target.parent / direct_name
            if path.is_file():
                candidates.append(path)

    if claude_backup_dir.is_dir():
        candidates.extend(sorted(claude_backup_dir.glob(".claude.json.backup.*")))

    seen_paths = set()
    unique = []
    for candidate in candidates:
        key = str(candidate)
        if key in seen_paths:
            continue
        seen_paths.add(key)
        unique.append(candidate)
    return unique

# If target is a thin/partially-reset state, hydrate from richest backup first.
needs_hydration = (
    len(target_data.keys()) < 20
    or target_data.get("hasCompletedOnboarding") is not True
)

best_backup_path = None
best_backup_data = None
best_backup_score = -1

for candidate in candidate_backup_paths(target_path):
    data = load_json_object(candidate)
    if not data:
        continue
    score = backup_score(data)
    if score > best_backup_score:
        best_backup_score = score
        best_backup_data = data
        best_backup_path = candidate

if needs_hydration and best_backup_data:
    merged = dict(best_backup_data)
    merged.update(target_data)
    if target_data.get("hasCompletedOnboarding") is not True and best_backup_data.get("hasCompletedOnboarding") is True:
        merged["hasCompletedOnboarding"] = True
    if not isinstance(target_data.get("oauthAccount"), dict) and isinstance(best_backup_data.get("oauthAccount"), dict):
        merged["oauthAccount"] = best_backup_data["oauthAccount"]
    target_data = merged
    print(f"ℹ️  Hydrated target from backup: {best_backup_path}")

target_data["auth"] = {
    "source_file": source_path.name,
    "imported_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "url": source_data.get("url", "https://claude.ai"),
    "cookies": cleaned_cookies,
}

if not isinstance(target_data.get("oauthAccount"), dict):
    candidates = sorted(
        candidate_backup_paths(target_path),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        try:
            backup_data = json.loads(candidate.read_text())
        except Exception:
            continue
        oauth = backup_data.get("oauthAccount")
        if isinstance(oauth, dict) and oauth.get("accountUuid"):
            target_data["oauthAccount"] = oauth
            if "hasCompletedOnboarding" in backup_data:
                target_data["hasCompletedOnboarding"] = backup_data["hasCompletedOnboarding"]
            break

target_path.write_text(json.dumps(target_data, indent=2) + "\n")

critical = {"sessionKey", "routingHint", "activitySessionId"}
present = sorted({c["name"] for c in cleaned_cookies if c["name"] in critical})

print(f"✅ Injected {len(cleaned_cookies)} cookies into {target_path}")
print("✅ Critical cookies found: " + (", ".join(present) if present else "none"))
print(f"✅ Target key count: {len(target_data.keys())}")
PYEOF

echo "💾 Backup: $BACKUP_JSON"

if [ "$INSTALL_LAUNCHER" -eq 1 ]; then
  install_claude_like_desktop_launcher "$SOURCE_JSON" "$LAUNCHER_PATH"
fi

if [ "$RUN_PERSISTENT_OAUTH" -eq 1 ] && command -v claude >/dev/null 2>&1; then
  CLI_STATUS="$(check_claude_cli_status)"

  if [ "$CLI_STATUS" = "LOGGED_OUT" ]; then
    OAUTH_SOURCE_FILE="$(resolve_oauth_source_file "$SOURCE_JSON")"
    if [ -n "$OAUTH_SOURCE_FILE" ]; then
      echo "🔄 Restoring Claude CLI OAuth"
      echo "   OAuth source: $OAUTH_SOURCE_FILE"
      restore_claude_cli_oauth "$OAUTH_SOURCE_FILE" || true
      CLI_STATUS="$(check_claude_cli_status)"
    else
      echo "ℹ️  No local claudeAiOauth backup found to restore Claude CLI auth."
    fi
  fi

  if [ "$CLI_STATUS" = "LOGGED_IN" ]; then
    echo "✅ Claude CLI auth status: logged in."
  fi

  if [ "$CLI_STATUS" = "LOGGED_OUT" ]; then
    echo "⚠️  Claude CLI is still not logged in."
    echo "   Claude Code v2 uses a separate OAuth store (claudeAiOauth); .claude.json cookies are not enough."
    echo "   To skip the login-method selector, run: claude auth login --claudeai"
    echo "   If you already have a long-lived token, use: export CLAUDE_CODE_OAUTH_TOKEN=<token>"
  elif [ "$CLI_STATUS" = "TIMEOUT" ]; then
    echo "ℹ️  Skipped Claude CLI status check (timed out after 5s)."
  elif [ "$CLI_STATUS" = "ERROR" ] || [ "$CLI_STATUS" = "INVALID" ]; then
    echo "ℹ️  Skipped Claude CLI status check (unexpected response)."
  fi
elif [ "$RUN_PERSISTENT_OAUTH" -eq 0 ]; then
  purge_persistent_claude_cli_oauth
  echo "ℹ️  Persistent Claude CLI OAuth was not restored."
  if [ "$INSTALL_LAUNCHER" -eq 1 ]; then
    echo "   Use desktop-style runtime auth instead: $LAUNCHER_PATH"
    echo "   This avoids creating/managing long-lived authorization tokens."
  else
    echo "   Re-run with --launcher or use $SCRIPT_DIR/run_claude_like_desktop.sh directly."
  fi
fi

echo "🎉 Done. Restart Claude Code terminal if it is running."
