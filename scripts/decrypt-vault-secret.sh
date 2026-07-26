#!/usr/bin/env bash
# decrypt-vault-secret.sh
# Decrypt service-accounts.json entries trên VPS → plaintext password + TOTP secret.
#
# Usage:
#   ./scripts/decrypt-vault-secret.sh                    # list tất cả accounts
#   ./scripts/decrypt-vault-secret.sh gptpro2            # tìm theo username/label/id
#   ./scripts/decrypt-vault-secret.sh notebooklm         # tìm theo serviceId
#   ./scripts/decrypt-vault-secret.sh --all              # decrypt ALL entries
#   ./scripts/decrypt-vault-secret.sh --json gptpro2     # output JSON
#   CENTRIX_VPS_PASS='...' ./scripts/decrypt-vault-secret.sh gptpro2
#
# Env:
#   CENTRIX_VPS_HOST   default 103.240.7.254
#   CENTRIX_VPS_USER   default root
#   CENTRIX_VPS_PASS   password (required unless SSH key works)
#
# How it works:
#   1. SSH vào VPS, đọc CENTRIX_VAULT_KEY từ centrix.env
#   2. Dùng node crypto (aes-256-gcm) decrypt trường `secret` của mỗi account
#   3. Output plaintext { password, totpSecret } cho account được query
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HOST="${CENTRIX_VPS_HOST:-103.240.7.254}"
USER="${CENTRIX_VPS_USER:-root}"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "$*" >&2; }

resolve_pass() {
  if [[ -n "${CENTRIX_VPS_PASS:-}" ]]; then
    printf '%s' "$CENTRIX_VPS_PASS"; return
  fi
  if [[ -n "${CENTRIX_VPS_PASS_FILE:-}" && -f "$CENTRIX_VPS_PASS_FILE" ]]; then
    head -1 "$CENTRIX_VPS_PASS_FILE" | tr -d '\r\n'; return
  fi
  local envf="${CENTRIX_ENV_FILE:-$REPO_ROOT/centrix-backend/.env}"
  if [[ -f "$envf" ]]; then
    local line
    line="$(grep -E '^CENTRIX_VPS_PASS=' "$envf" 2>/dev/null | head -1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#CENTRIX_VPS_PASS=}"; return
    fi
  fi
  if [[ -f "$REPO_ROOT/.centrix-vps-pass" ]]; then
    head -1 "$REPO_ROOT/.centrix-vps-pass" | tr -d '\r\n'; return
  fi
  printf ''
}

# SSH exec, returning only stdout (strips expect noise)
ssh_exec() {
  local remote_cmd="$1"
  local pass target raw
  pass="$(resolve_pass)"
  target="${USER}@${HOST}"

  if [[ -z "$pass" ]]; then
    ssh -o StrictHostKeyChecking=accept-new "$target" "$remote_cmd"
    return
  fi
  command -v expect >/dev/null 2>&1 || die "expect required for password auth"

  raw="$(CENTRIX_SSH_TARGET="$target" \
    CENTRIX_SSH_CMD="$remote_cmd" \
    CENTRIX_SCP_PASS="$pass" \
    expect <<'EOF'
set timeout 90
set password $env(CENTRIX_SCP_PASS)
set target $env(CENTRIX_SSH_TARGET)
set cmd $env(CENTRIX_SSH_CMD)
log_user 0
spawn ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no $target $cmd
expect {
  -re "(?i)are you sure you want to continue connecting" { send "yes\r"; exp_continue }
  -re "(?i)password:" { send "$password\r" }
  timeout { puts stderr "TIMEOUT"; exit 1 }
}
log_user 1
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
  )"
  printf '%s' "$raw"
}

# ── flags ────────────────────────────────────────────────────────────────────
ALL=0
LIST=0
JSON=0
QUERY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    -a|--all) ALL=1; shift ;;
    -l|--list) LIST=1; shift ;;
    -j|--json) JSON=1; shift ;;
    --) shift; break ;;
    -*) die "unknown flag: $1" ;;
    *) QUERY="$1"; shift ;;
  esac
done

if [[ "$LIST" -eq 1 ]]; then
  MODE="list"
elif [[ "$ALL" -eq 1 ]]; then
  MODE="all"
elif [[ -n "$QUERY" ]]; then
  MODE="query"
else
  MODE="list"
fi

log "==> decrypt-vault  ${USER}@${HOST}  mode=$MODE${QUERY:+  query=$QUERY}"

# Build the Node.js script to run on VPS
NODE_SCRIPT='
const crypto = require("crypto");
const fs = require("fs");

const envContent = fs.readFileSync("/opt/centrix/centrix.env", "utf8");
const vaultKey = (envContent.match(/^CENTRIX_VAULT_KEY=(.+)$/m) || [])[1] || "";
const mode = process.env.MODE || "list";
const query = (process.env.QUERY || "").toLowerCase().trim();

function decrypt(secret, key) {
  if (!secret || !secret.enc) return null;
  try {
    const keyBuf = Buffer.from(key, "base64");
    const iv = Buffer.from(secret.iv, "base64");
    const tag = Buffer.from(secret.tag, "base64");
    const data = Buffer.from(secret.data, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuf, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(data, null, "utf8");
    dec += decipher.final("utf8");
    try { return JSON.parse(dec); } catch { return dec; }
  } catch (e) {
    return { _error: e.message };
  }
}

const sa = JSON.parse(fs.readFileSync("/opt/centrix/data/service-accounts.json", "utf8"));
const results = [];

for (const a of sa.accounts || []) {
  const id = String(a.id || "").toLowerCase();
  const sid = String(a.serviceId || "").toLowerCase();
  const user = String(a.username || "").toLowerCase();
  const label = String(a.label || "").toLowerCase();

  if (mode === "list") {
    results.push({
      id: a.id, serviceId: a.serviceId, slot: a.slot,
      username: a.username, label: a.label || "",
      loginType: a.loginType, totpSet: a.totpSet,
      status: a.status || "", enabled: a.enabled,
    });
    continue;
  }

  if (mode === "query") {
    const match = id === query || sid === query ||
      id.startsWith(query + "::") ||
      user.includes(query) || label.includes(query);
    if (!match) continue;
  }

  const plain = decrypt(a.secret, vaultKey);
  results.push({
    id: a.id, serviceId: a.serviceId, slot: a.slot,
    username: a.username, label: a.label || "",
    loginType: a.loginType,
    password: plain && plain.password ? plain.password : undefined,
    totpSecret: plain && plain.totpSecret ? plain.totpSecret : undefined,
    decryptError: plain && plain._error ? plain._error : undefined,
    status: a.status || "", enabled: a.enabled,
    updatedAt: a.updatedAt || "",
  });
}

console.log(JSON.stringify(results));
'

# Base64-encode the full remote script to avoid quoting issues
REMOTE_SCRIPT="$(printf 'export MODE="%s" QUERY="%s"; node -e %s' \
  "$MODE" "$QUERY" "$(printf '%s' "$NODE_SCRIPT" | python3 -c 'import sys,shlex; print(shlex.quote(sys.stdin.read()))')")"
B64="$(printf '%s' "$REMOTE_SCRIPT" | base64 | tr -d '\n')"

OUTPUT="$(ssh_exec "echo $B64 | base64 -d | bash")"

# Extract JSON array from output (may contain expect noise)
JSON_LINE="$(echo "$OUTPUT" | tr -d '\r' | python3 -c '
import sys
for line in sys.stdin:
    line = line.strip()
    if line.startswith("["):
        print(line)
        break
' 2>/dev/null)"
if [[ -z "$JSON_LINE" ]]; then
  die "no JSON output from VPS (raw: $(echo "$OUTPUT" | head -3))"
fi

if [[ "$JSON" -eq 1 ]]; then
  echo "$JSON_LINE" | python3 -m json.tool 2>/dev/null || echo "$JSON_LINE"
  exit 0
fi

# Pretty output
JDATA="$JSON_LINE" python3 - "$MODE" <<'PY'
import json, sys, os

mode = sys.argv[1]
data = json.loads(os.environ["JDATA"])

if mode == "list":
    print(f"{'ID':<24} {'Service':<18} {'Slot':<5} {'Username':<35} {'Type':<8} {'TOTP':<5} {'Status':<8} {'On'}")
    print("-" * 130)
    for a in data:
        totp = '✓' if a.get('totpSet') else ''
        on = '✓' if a.get('enabled') else '✗'
        print(f"{a.get('id',''):<24} {a.get('serviceId',''):<18} {str(a.get('slot','')):<5} {a.get('username',''):<35} {a.get('loginType',''):<8} {totp:<5} {a.get('status',''):<8} {on}")
else:
    if not data:
        print("(no matches)", file=sys.stderr)
        sys.exit(1)
    for a in data:
        print(f"─── {a.get('id','')} ───")
        print(f"  Service:    {a.get('serviceId','')}")
        print(f"  Username:   {a.get('username','')}")
        if a.get('label'):
            print(f"  Label:      {a.get('label','')}")
        pw = a.get('password')
        if pw:
            print(f"  Password:   {pw}")
        totp = a.get('totpSecret')
        if totp:
            print(f"  TOTP:       {totp}")
        err = a.get('decryptError')
        if err:
            print(f"  Error:      {err}")
        print(f"  Status:     {a.get('status','')}")
        print(f"  Updated:    {a.get('updatedAt','')}")
        print()
PY
