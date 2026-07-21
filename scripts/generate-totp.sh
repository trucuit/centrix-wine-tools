#!/usr/bin/env bash
# generate-totp.sh — in TOTP (RFC 6238) 6 chữ số từ Base32 secret.
#
# Usage:
#   ./scripts/generate-totp.sh                        # alias mặc định: gptpro2
#   ./scripts/generate-totp.sh gptpro2
#   ./scripts/generate-totp.sh notebooklm
#   ./scripts/generate-totp.sh --secret 'BASE32...'
#   ./scripts/generate-totp.sh BASE32SECRET
#   ./scripts/generate-totp.sh --watch gptpro2        # refresh mỗi giây
#   ./scripts/generate-totp.sh --copy gptpro2         # copy clipboard (macOS pbcopy)
#   ./scripts/generate-totp.sh --vps notebooklm       # lấy secret từ vault VPS
#   ./scripts/generate-totp.sh --vps --list           # list vault entries có TOTP
#   ./scripts/generate-totp.sh --json gptpro2
#
# Env:
#   CENTRIX_TOTP_SECRET     secret Base32 (override)
#   CENTRIX_TOTP_ALIAS      default alias (default: gptpro2)
#   CENTRIX_TOTP_FILE       file map alias→secret (default: <repo>/.centrix-totp)
#   CENTRIX_VPS_HOST/USER/PASS  (giống download-vps-snapshots.sh)
#
# File .centrix-totp (gitignored), mỗi dòng: alias=BASE32  hoặc  alias BASE32
#   gptpro2=N7NM2WTN4DKTZ3VPHI4WM2AN747DYA5F
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST="${CENTRIX_VPS_HOST:-103.240.7.254}"
USER="${CENTRIX_VPS_USER:-root}"
VAULT_REMOTE="${CENTRIX_VAULT_REMOTE:-/opt/centrix/data/service-accounts.json}"
CRYPTO_REMOTE="${CENTRIX_CRYPTO_REMOTE:-/opt/centrix/backend/shared/profile-crypto.js}"
TOTP_FILE="${CENTRIX_TOTP_FILE:-$REPO_ROOT/.centrix-totp}"
DEFAULT_ALIAS="${CENTRIX_TOTP_ALIAS:-gptpro2}"

# Built-in pool aliases (override bằng .centrix-totp hoặc --secret / --vps)
# gptpro2 = ChatGPT Pro pool (notebooklm::1)
# Note: plain functions — macOS ships Bash 3.2 (no assoc arrays).
builtin_secret() {
  case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
    gptpro2|notebooklm|chatgpt-pro|chatgptpro)
      printf '%s' 'N7NM2WTN4DKTZ3VPHI4WM2AN747DYA5F'
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

list_builtin_aliases() {
  printf '%s\n' gptpro2 notebooklm chatgpt-pro
}

die() { echo "error: $*" >&2; exit 1; }
log() { echo "$*" >&2; }

usage() {
  sed -n '2,28p' "$0"
}

resolve_pass() {
  if [[ -n "${CENTRIX_VPS_PASS:-}" ]]; then
    printf '%s' "$CENTRIX_VPS_PASS"
    return
  fi
  if [[ -n "${CENTRIX_VPS_PASS_FILE:-}" && -f "$CENTRIX_VPS_PASS_FILE" ]]; then
    head -1 "$CENTRIX_VPS_PASS_FILE" | tr -d '\r\n'
    return
  fi
  if [[ -f "$REPO_ROOT/.centrix-vps-pass" ]]; then
    head -1 "$REPO_ROOT/.centrix-vps-pass" | tr -d '\r\n'
    return
  fi
  local envf="${CENTRIX_ENV_FILE:-$REPO_ROOT/centrix-backend/.env}"
  if [[ -f "$envf" ]]; then
    local line
    line="$(grep -E '^CENTRIX_VPS_PASS=' "$envf" 2>/dev/null | head -1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#CENTRIX_VPS_PASS=}"
      return
    fi
  fi
  printf ''
}

ssh_cmd() {
  local remote_cmd="$1"
  local pass target
  pass="$(resolve_pass)"
  target="${USER}@${HOST}"
  if [[ -z "$pass" ]]; then
    ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password,publickey \
      "$target" "$remote_cmd"
    return
  fi
  command -v expect >/dev/null 2>&1 || die "expect required for password auth (or use SSH key)"
  CENTRIX_SSH_TARGET="$target" \
  CENTRIX_SSH_CMD="$remote_cmd" \
  CENTRIX_SCP_PASS="$pass" \
  expect <<'EOF'
set timeout 90
set password $env(CENTRIX_SCP_PASS)
set target $env(CENTRIX_SSH_TARGET)
set cmd $env(CENTRIX_SSH_CMD)
spawn ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no $target $cmd
expect {
  -re "(?i)are you sure you want to continue connecting" { send "yes\r"; exp_continue }
  -re "(?i)password:" { send "$password\r" }
  timeout { puts stderr "TIMEOUT"; exit 1 }
}
expect {
  -re "(?i)permission denied" { puts stderr "AUTH_FAILED"; exit 2 }
  eof {}
  timeout { puts stderr "SSH TIMEOUT"; exit 1 }
}
catch wait result
set code [lindex $result 3]
if {$code == ""} { set code 0 }
exit $code
EOF
}

# Pure-Python TOTP (no pyotp). Prints: CODE\tREMAINING_SEC\tPERIOD
totp_compute() {
  local secret="$1"
  local digits="${2:-6}"
  local period="${3:-30}"
  SECRET="$secret" DIGITS="$digits" PERIOD="$period" python3 - <<'PY'
import base64, hmac, hashlib, struct, time, os, re, sys

secret = re.sub(r"\s+", "", os.environ["SECRET"]).upper()
# pad base32
pad = "=" * ((8 - len(secret) % 8) % 8)
try:
    key = base64.b32decode(secret + pad, casefold=True)
except Exception as e:
    print(f"invalid-base32: {e}", file=sys.stderr)
    sys.exit(2)

digits = int(os.environ.get("DIGITS", "6"))
period = int(os.environ.get("PERIOD", "30"))
now = int(time.time())
counter = now // period
remain = period - (now % period)
msg = struct.pack(">Q", counter)
h = hmac.new(key, msg, hashlib.sha1).digest()
o = h[-1] & 0x0F
code = ((h[o] & 0x7F) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
code = code % (10 ** digits)
print(f"{code:0{digits}d}\t{remain}\t{period}")
PY
}

load_file_secret() {
  local alias="$1"
  [[ -f "$TOTP_FILE" ]] || return 1
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    if [[ "$line" == *"="* ]]; then
      key="${line%%=*}"
      val="${line#*=}"
    else
      key="${line%%[[:space:]]*}"
      val="${line#*[[:space:]]}"
    fi
    key="$(echo "$key" | tr '[:upper:]' '[:lower:]')"
    val="$(echo "$val" | tr -d '[:space:]')"
    if [[ "$key" == "$alias" && -n "$val" ]]; then
      printf '%s' "$val"
      return 0
    fi
  done < "$TOTP_FILE"
  return 1
}

resolve_secret_local() {
  local alias="$1"
  # env wins
  if [[ -n "${CENTRIX_TOTP_SECRET:-}" ]]; then
    printf '%s' "$CENTRIX_TOTP_SECRET"
    return 0
  fi
  local s
  if s="$(load_file_secret "$alias")"; then
    printf '%s' "$s"
    return 0
  fi
  if s="$(builtin_secret "$alias")"; then
    printf '%s' "$s"
    return 0
  fi
  return 1
}

# Looks like base32 secret (not a short alias)
looks_like_secret() {
  local s="$1"
  s="$(echo "$s" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
  [[ ${#s} -ge 16 ]] && [[ "$s" =~ ^[A-Z2-7]+=*$ ]]
}

vps_list_totp() {
  local b64 remote
  remote=$(cat <<'REMOTE'
set -e
PID=$(pgrep -af node | grep -i centrix | head -1 | awk '{print $1}')
export CENTRIX_VAULT_KEY=$(tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -E '^CENTRIX_VAULT_KEY=' | head -1 | cut -d= -f2-)
export CENTRIX_MASTER_SNAPSHOT_KEY=$(tr '\0' '\n' < /proc/$PID/environ 2>/dev/null | grep -E '^CENTRIX_MASTER_SNAPSHOT_KEY=' | head -1 | cut -d= -f2-)
node - <<'NODE'
const fs = require("fs");
const crypto = require("/opt/centrix/backend/shared/profile-crypto.js");
const key = process.env.CENTRIX_VAULT_KEY || process.env.CENTRIX_MASTER_SNAPSHOT_KEY || "";
const db = JSON.parse(fs.readFileSync("/opt/centrix/data/service-accounts.json", "utf8"));
for (const a of (db.accounts || [])) {
  let secret = {};
  try { if (a.secret) secret = crypto.decryptSnapshot(a.secret, key) || {}; } catch {}
  const hasTotp = !!(secret.totpSecret && secret.totpSecret.length);
  if (!hasTotp && a.loginType !== "totp") continue;
  console.log([
    a.id || "",
    a.serviceId || "",
    a.slot || "",
    a.username || "",
    a.loginType || "",
    hasTotp ? "totp" : "no-totp",
  ].join("\t"));
}
NODE
REMOTE
)
  b64=$(printf '%s' "$remote" | base64 | tr -d '\n')
  ssh_cmd "echo $b64 | base64 -d | bash"
}

vps_fetch_secret() {
  local service_or_id="$1"
  local b64 remote
  remote=$(cat <<REMOTE
set -e
PID=\$(pgrep -af node | grep -i centrix | head -1 | awk '{print \$1}')
export CENTRIX_VAULT_KEY=\$(tr '\\0' '\\n' < /proc/\$PID/environ 2>/dev/null | grep -E '^CENTRIX_VAULT_KEY=' | head -1 | cut -d= -f2-)
export CENTRIX_MASTER_SNAPSHOT_KEY=\$(tr '\\0' '\\n' < /proc/\$PID/environ 2>/dev/null | grep -E '^CENTRIX_MASTER_SNAPSHOT_KEY=' | head -1 | cut -d= -f2-)
QUERY=$(printf '%s' "$service_or_id" | sed "s/'/'\\\\''/g")
export QUERY
node - <<'NODE'
const fs = require("fs");
const crypto = require("/opt/centrix/backend/shared/profile-crypto.js");
const key = process.env.CENTRIX_VAULT_KEY || process.env.CENTRIX_MASTER_SNAPSHOT_KEY || "";
const q = String(process.env.QUERY || "").toLowerCase().trim();
const db = JSON.parse(fs.readFileSync("/opt/centrix/data/service-accounts.json", "utf8"));
const aliases = {
  gptpro2: "notebooklm",
  "chatgpt-pro": "notebooklm",
  chatgptpro: "notebooklm",
};
const want = aliases[q] || q;
let found = null;
for (const a of (db.accounts || [])) {
  const id = String(a.id || "").toLowerCase();
  const sid = String(a.serviceId || "").toLowerCase();
  const user = String(a.username || "").toLowerCase();
  const label = String(a.label || "").toLowerCase();
  if (
    id === want ||
    sid === want ||
    id.startsWith(want + "::") ||
    user.includes(want) ||
    label.includes(want) ||
    (want === "notebooklm" && sid === "notebooklm")
  ) {
    found = a;
    break;
  }
}
if (!found) {
  console.error("vault-entry-not-found: " + q);
  process.exit(3);
}
let secret = {};
try {
  if (found.secret) secret = crypto.decryptSnapshot(found.secret, key) || {};
} catch (e) {
  console.error("decrypt-fail: " + e.message);
  process.exit(4);
}
if (!secret.totpSecret) {
  console.error("no-totp-secret for " + (found.id || q));
  process.exit(5);
}
// machine line: secret\\tusername\\tid
console.log([secret.totpSecret, found.username || "", found.id || ""].join("\\t"));
NODE
REMOTE
)
  b64=$(printf '%s' "$remote" | base64 | tr -d '\n')
  ssh_cmd "echo $b64 | base64 -d | bash"
}

WATCH=0
COPY=0
JSON=0
VPS=0
LIST=0
SECRET=""
ALIAS=""
DIGITS=6
PERIOD=30

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -w|--watch) WATCH=1; shift ;;
    -c|--copy) COPY=1; shift ;;
    -j|--json) JSON=1; shift ;;
    --vps) VPS=1; shift ;;
    --list|-l) LIST=1; shift ;;
    --secret)
      SECRET="${2:-}"
      [[ -n "$SECRET" ]] || die "--secret needs value"
      shift 2
      ;;
    --digits)
      DIGITS="${2:-6}"
      shift 2
      ;;
    --period)
      PERIOD="${2:-30}"
      shift 2
      ;;
    --file)
      TOTP_FILE="${2:-}"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      if [[ -z "$ALIAS" && -z "$SECRET" ]]; then
        if looks_like_secret "$1"; then
          SECRET="$1"
        else
          ALIAS="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
        fi
      else
        die "unexpected arg: $1"
      fi
      shift
      ;;
  esac
done

if [[ "$LIST" -eq 1 ]]; then
  if [[ "$VPS" -eq 1 ]]; then
    log "==> vault TOTP entries on ${USER}@${HOST}"
    vps_list_totp
    exit 0
  fi
  log "Local aliases (.centrix-totp + built-in):"
  while IFS= read -r k; do
    echo "  $k  (built-in)"
  done < <(list_builtin_aliases)
  if [[ -f "$TOTP_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%%#*}"
      line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      [[ -z "$line" ]] && continue
      echo "  ${line%%=*}  (file)"
    done < "$TOTP_FILE"
  else
    log "  (no $TOTP_FILE)"
  fi
  exit 0
fi

LABEL=""
USERNAME=""
if [[ -z "$SECRET" ]]; then
  ALIAS="${ALIAS:-$DEFAULT_ALIAS}"
  if [[ "$VPS" -eq 1 ]]; then
    log "← vault ${USER}@${HOST}  query=$ALIAS"
    line="$(vps_fetch_secret "$ALIAS")" || die "vps fetch failed"
    SECRET="$(printf '%s' "$line" | cut -f1)"
    USERNAME="$(printf '%s' "$line" | cut -f2)"
    LABEL="$(printf '%s' "$line" | cut -f3)"
  else
    SECRET="$(resolve_secret_local "$ALIAS")" || die "no secret for alias '$ALIAS' (use --secret, .centrix-totp, or --vps)"
    LABEL="$ALIAS"
  fi
else
  LABEL="${ALIAS:-secret}"
fi

SECRET="$(echo "$SECRET" | tr -d '[:space:]')"
[[ -n "$SECRET" ]] || die "empty secret"

print_once() {
  local out code remain period
  out="$(totp_compute "$SECRET" "$DIGITS" "$PERIOD")"
  code="$(printf '%s' "$out" | cut -f1)"
  remain="$(printf '%s' "$out" | cut -f2)"
  period="$(printf '%s' "$out" | cut -f3)"

  if [[ "$JSON" -eq 1 ]]; then
    python3 - "$code" "$remain" "$period" "$LABEL" "$USERNAME" <<'PY'
import json,sys
code, remain, period, label, user = sys.argv[1:6]
print(json.dumps({
  "code": code,
  "remainingSec": int(remain),
  "period": int(period),
  "label": label,
  "username": user or None,
}, ensure_ascii=False))
PY
  else
    if [[ -n "$USERNAME" ]]; then
      log "account: $USERNAME  ($LABEL)  remaining ${remain}s / ${period}s"
    else
      log "label: $LABEL  remaining ${remain}s / ${period}s"
    fi
    printf '%s\n' "$code"
  fi

  if [[ "$COPY" -eq 1 ]]; then
    if command -v pbcopy >/dev/null 2>&1; then
      printf '%s' "$code" | pbcopy
      log "(copied to clipboard)"
    elif command -v xclip >/dev/null 2>&1; then
      printf '%s' "$code" | xclip -selection clipboard
      log "(copied to clipboard)"
    else
      log "warn: no pbcopy/xclip — skip --copy"
    fi
  fi
}

if [[ "$WATCH" -eq 1 ]]; then
  log "watch TOTP (Ctrl+C to stop)"
  while true; do
    if [[ "$JSON" -eq 1 ]]; then
      print_once
    else
      # single-line refresh
      out="$(totp_compute "$SECRET" "$DIGITS" "$PERIOD")"
      code="$(printf '%s' "$out" | cut -f1)"
      remain="$(printf '%s' "$out" | cut -f2)"
      period="$(printf '%s' "$out" | cut -f3)"
      printf '\r%s  %ss left (/%ss)   ' "$code" "$remain" "$period"
      if [[ "$COPY" -eq 1 && "${_last_code:-}" != "$code" ]]; then
        _last_code="$code"
        command -v pbcopy >/dev/null 2>&1 && printf '%s' "$code" | pbcopy
      fi
    fi
    sleep 1
  done
fi

print_once
