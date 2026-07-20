#!/usr/bin/env bash
# download-vps-snapshots.sh
# SSH vào CentriX backend VPS và scp các pool snapshot (*.json) về local cookies/<service>/.
#
# Usage:
#   ./scripts/download-vps-snapshots.sh
#   ./scripts/download-vps-snapshots.sh --list          # chỉ list remote
#   ./scripts/download-vps-snapshots.sh claude-1 chatgpt-1   # subset
#   CENTRIX_VPS_PASS='...' ./scripts/download-vps-snapshots.sh
#
# Env / config:
#   CENTRIX_VPS_HOST   default 103.240.7.254
#   CENTRIX_VPS_USER   default root
#   CENTRIX_VPS_PASS   password (required unless SSH key works)
#   CENTRIX_VPS_PASS_FILE  optional file containing password (one line)
#   CENTRIX_SNAPSHOT_REMOTE  default /opt/centrix/data/centrix-snapshots
#   CENTRIX_COOKIES_DIR      default <repo>/cookies
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_ENV="${CENTRIX_ENV_FILE:-$REPO_ROOT/centrix-backend/.env}"

HOST="${CENTRIX_VPS_HOST:-103.240.7.254}"
USER="${CENTRIX_VPS_USER:-root}"
REMOTE_DIR="${CENTRIX_SNAPSHOT_REMOTE:-/opt/centrix/data/centrix-snapshots}"
COOKIES_DIR="${CENTRIX_COOKIES_DIR:-$REPO_ROOT/cookies}"

# Default service snapshots to pull (basename only)
DEFAULT_FILES=(
  canva-1.json
  chatgpt-1.json
  chatgpt-2.json
  chatgpt-3.json
  chatgpt-4.json
  claude-1.json
  deepseek-1.json
  gemini-1.json
  grok-heavy-1.json
  notebooklm-1.json
  perplexity-1.json
)

die() { echo "error: $*" >&2; exit 1; }
log() { echo "$*" >&2; }

# Resolve password: env → pass file → optional CENTRIX_VPS_PASS= in backend .env (if present)
resolve_pass() {
  if [[ -n "${CENTRIX_VPS_PASS:-}" ]]; then
    printf '%s' "$CENTRIX_VPS_PASS"
    return
  fi
  if [[ -n "${CENTRIX_VPS_PASS_FILE:-}" && -f "$CENTRIX_VPS_PASS_FILE" ]]; then
    head -1 "$CENTRIX_VPS_PASS_FILE" | tr -d '\r\n'
    return
  fi
  if [[ -f "$BACKEND_ENV" ]]; then
    local line
    line="$(grep -E '^CENTRIX_VPS_PASS=' "$BACKEND_ENV" 2>/dev/null | head -1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#CENTRIX_VPS_PASS=}"
      return
    fi
  fi
  # legacy known pass file (optional, gitignored)
  if [[ -f "$REPO_ROOT/.centrix-vps-pass" ]]; then
    head -1 "$REPO_ROOT/.centrix-vps-pass" | tr -d '\r\n'
    return
  fi
  printf ''
}

# Map snapshot basename → local cookies subdir
# chatgpt-3.json → chatgpt, grok-heavy-1.json → grok-heavy, claude-1.json → claude
service_dir_for() {
  local base="$1"
  base="${base%.json}"
  # strip trailing -N slot
  if [[ "$base" =~ ^(.+)-[0-9]+$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "$base"
  fi
}

LIST_ONLY=0
FILES=()
for arg in "$@"; do
  case "$arg" in
    --list|-l) LIST_ONLY=1 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *.json) FILES+=("$arg") ;;
    *)
      # allow bare names: claude-1 / claude-1.json
      if [[ "$arg" == *.* ]]; then
        FILES+=("$arg")
      else
        FILES+=("${arg}.json")
      fi
      ;;
  esac
done
if [[ ${#FILES[@]} -eq 0 ]]; then
  FILES=("${DEFAULT_FILES[@]}")
fi

PASS="$(resolve_pass)"
TARGET="${USER}@${HOST}"

ssh_base=(ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password,publickey -o PubkeyAuthentication=yes)
scp_base=(scp -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password,publickey -o PubkeyAuthentication=yes)

ssh_cmd() {
  local remote_cmd="$1"
  if [[ -z "$PASS" ]]; then
    "${ssh_base[@]}" "${TARGET}" "$remote_cmd"
    return
  fi
  command -v expect >/dev/null 2>&1 || die "expect required for password auth"
  CENTRIX_SSH_TARGET="$TARGET" \
  CENTRIX_SSH_CMD="$remote_cmd" \
  CENTRIX_SCP_PASS="$PASS" \
  expect <<'EOF'
set timeout 120
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

scp_file() {
  local remote_path="$1"
  local local_path="$2"
  if [[ -z "$PASS" ]]; then
    "${scp_base[@]}" "${TARGET}:${remote_path}" "$local_path"
    return
  fi
  command -v expect >/dev/null 2>&1 || die "expect required for password auth"
  # Pass paths as env to avoid shell/expect quoting bugs with special chars
  CENTRIX_SCP_REMOTE="${TARGET}:${remote_path}" \
  CENTRIX_SCP_LOCAL="$local_path" \
  CENTRIX_SCP_PASS="$PASS" \
  expect <<'EOF'
set timeout 180
set password $env(CENTRIX_SCP_PASS)
set remote $env(CENTRIX_SCP_REMOTE)
set local $env(CENTRIX_SCP_LOCAL)
spawn scp -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password -o PubkeyAuthentication=no $remote $local
expect {
  -re "(?i)are you sure you want to continue connecting" { send "yes\r"; exp_continue }
  -re "(?i)password:" { send "$password\r" }
  timeout { puts stderr "TIMEOUT scp auth"; exit 1 }
}
expect {
  -re "(?i)permission denied" { puts stderr "AUTH_FAILED"; exit 2 }
  -re "(?i)no such file" { puts stderr "NOT_FOUND"; exit 3 }
  eof {}
  timeout { puts stderr "SCP TRANSFER TIMEOUT"; exit 1 }
}
catch wait result
set code [lindex $result 3]
if {$code == ""} { set code 0 }
exit $code
EOF
}

log "==> ${TARGET}:${REMOTE_DIR}"
log "    local cookies: ${COOKIES_DIR}"

if [[ "$LIST_ONLY" -eq 1 ]]; then
  ssh_cmd "ls -lah ${REMOTE_DIR}/"
  exit 0
fi

# Verify remote dir
ssh_cmd "test -d ${REMOTE_DIR} && echo REMOTE_OK" | grep -q REMOTE_OK || die "remote dir missing: $REMOTE_DIR"

ok=0
fail=0
declare -a RESULTS=()

for f in "${FILES[@]}"; do
  base="$(basename "$f")"
  [[ "$base" == *.json ]] || base="${base}.json"
  svc="$(service_dir_for "$base")"
  dest_dir="${COOKIES_DIR}/${svc}"
  dest="${dest_dir}/${base}"
  remote="${REMOTE_DIR}/${base}"

  mkdir -p "$dest_dir"
  # backup existing
  if [[ -f "$dest" ]]; then
    cp -p "$dest" "${dest}.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  fi

  log "← ${base}  →  cookies/${svc}/${base}"
  if scp_file "$remote" "$dest"; then
    chmod 600 "$dest" 2>/dev/null || true
    sz="$(wc -c < "$dest" | tr -d ' ')"
    RESULTS+=("OK  ${base}  ${sz}B  →  ${dest}")
    ok=$((ok + 1))
  else
    RESULTS+=("FAIL ${base}")
    fail=$((fail + 1))
  fi
done

log ""
log "=== summary: ok=${ok} fail=${fail} ==="
for line in "${RESULTS[@]}"; do
  log "$line"
done

[[ "$fail" -eq 0 ]] || exit 1
