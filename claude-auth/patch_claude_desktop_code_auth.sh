#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_SOURCE="$SCRIPT_DIR/claude_desktop_code_auth/claude-electron-hook.js"

APP_PATH="/Applications/Claude.app"
OPEN_AFTER_PATCH=1
BACKUP_ROOT="$SCRIPT_DIR/backups/claude-desktop-code-auth"

usage() {
  cat <<'EOF'
Usage: ./patch_claude_desktop_code_auth.sh [options]

Patch Claude Desktop so the Code tab reuses auth minted from the Chat session.

Options:
  --app PATH         Claude.app path (default: /Applications/Claude.app)
  --backup-dir PATH  Backup root directory
  --no-open          Do not relaunch Claude after patching
  -h, --help         Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app)
      APP_PATH="${2:?missing value for --app}"
      shift 2
      ;;
    --backup-dir)
      BACKUP_ROOT="${2:?missing value for --backup-dir}"
      shift 2
      ;;
    --no-open)
      OPEN_AFTER_PATCH=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

can_write_parent_dir() {
  local target_path="$1"
  local parent_dir
  local probe_path

  parent_dir="$(dirname "$target_path")"
  probe_path="$parent_dir/.claude-desktop-code-auth-write-probe-$$-$RANDOM"

  if : > "$probe_path" 2>/dev/null; then
    rm -f "$probe_path"
    return 0
  fi

  return 1
}

print_app_management_hint() {
  cat >&2 <<'EOF'
macOS may be blocking terminal-driven edits to app bundles.
If the target app lives under /Applications and this write still fails, grant
App Management to your terminal app and retry:
System Settings > Privacy & Security > App Management
EOF
}

install_file() {
  local source_path="$1"
  local dest_path="$2"
  local use_admin="$3"

  if [ "$use_admin" -eq 1 ]; then
    if sudo cp "$source_path" "$dest_path"; then
      return 0
    fi
  else
    if cp "$source_path" "$dest_path"; then
      return 0
    fi
  fi

  echo "Failed to update: $dest_path" >&2
  print_app_management_hint
  return 1
}

require_cmd python3
require_cmd npx
require_cmd sudo

if [ ! -f "$HOOK_SOURCE" ]; then
  echo "Hook source not found: $HOOK_SOURCE" >&2
  exit 1
fi

ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
INFO_PLIST="$APP_PATH/Contents/Info.plist"

if [ ! -f "$ASAR_PATH" ]; then
  echo "Claude app.asar not found: $ASAR_PATH" >&2
  exit 1
fi

if [ ! -f "$INFO_PLIST" ]; then
  echo "Info.plist not found: $INFO_PLIST" >&2
  exit 1
fi

NEED_READ_ADMIN=0
NEED_WRITE_ADMIN=0

if [ ! -r "$ASAR_PATH" ] || [ ! -r "$INFO_PLIST" ]; then
  NEED_READ_ADMIN=1
fi

if [ ! -w "$ASAR_PATH" ] || [ ! -w "$INFO_PLIST" ]; then
  NEED_WRITE_ADMIN=1
fi

# macOS App Management can block writes into /Applications app bundles even when
# mode bits still report the files as writable. Probe the parent directories to
# decide whether we need to elevate for the final install step.
if ! can_write_parent_dir "$ASAR_PATH" || ! can_write_parent_dir "$INFO_PLIST"; then
  NEED_WRITE_ADMIN=1
fi

NEED_ADMIN=0
if [ "$NEED_READ_ADMIN" -eq 1 ] || [ "$NEED_WRITE_ADMIN" -eq 1 ]; then
  NEED_ADMIN=1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-desktop-code-auth.XXXXXX")"
UNPACK_DIR="$TMP_DIR/unpacked"
PATCHED_ASAR="$TMP_DIR/app.patched.asar"
PATCHED_INFO_PLIST="$TMP_DIR/Info.patched.plist"
SOURCE_ASAR="$ASAR_PATH"
SOURCE_INFO_PLIST="$INFO_PLIST"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"

echo "Claude app: $APP_PATH"
echo "Backup dir: $BACKUP_DIR"

echo "Stopping Claude..."
osascript -e 'tell application "Claude" to quit' >/dev/null 2>&1 || true
sleep 1
pkill -x Claude >/dev/null 2>&1 || true

if [ "$NEED_ADMIN" -eq 1 ]; then
  echo "Requesting administrator privileges to access Claude.app..."
  sudo -v
fi

if [ "$NEED_READ_ADMIN" -eq 1 ]; then
  echo "Copying protected app bundle files into a temporary workspace..."
  SOURCE_ASAR="$TMP_DIR/source.app.asar"
  SOURCE_INFO_PLIST="$TMP_DIR/source.Info.plist"
  sudo cp "$ASAR_PATH" "$SOURCE_ASAR"
  sudo cp "$INFO_PLIST" "$SOURCE_INFO_PLIST"
fi

echo "Extracting app.asar..."
npx --yes asar extract "$SOURCE_ASAR" "$UNPACK_DIR"

if [ ! -f "$UNPACK_DIR/package.json" ]; then
  echo "Extracted package.json missing" >&2
  exit 1
fi

if [ ! -f "$UNPACK_DIR/.vite/build/index.pre.js" ]; then
  echo "Expected main bundle missing: $UNPACK_DIR/.vite/build/index.pre.js" >&2
  exit 1
fi

cp "$HOOK_SOURCE" "$UNPACK_DIR/claude-electron-hook.js"

cat > "$UNPACK_DIR/hooked-entry.js" <<'EOF'
"use strict";

try {
  require("./claude-electron-hook.js");
} catch (error) {
  try {
    require("fs").appendFileSync(
      "/tmp/claude-electron-hook-bootstrap.err",
      `${new Date().toISOString()} ${String(error)}\n`,
    );
  } catch {}
}

module.exports = require("./.vite/build/index.pre.js");
EOF

python3 - "$UNPACK_DIR/package.json" <<'PY'
import json
import sys
from pathlib import Path

package_path = Path(sys.argv[1])
data = json.loads(package_path.read_text())
data["main"] = "hooked-entry.js"
package_path.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "Packing patched app.asar..."
npx --yes asar pack "$UNPACK_DIR" "$PATCHED_ASAR"

HEADER_HASH="$(
python3 - "$PATCHED_ASAR" <<'PY'
import hashlib
import struct
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    header = f.read(16)
_, _, _, header_string_size = struct.unpack("<4I", header)
with open(path, "rb") as f:
    f.seek(16)
    header_bytes = f.read(header_string_size)
print(hashlib.sha256(header_bytes).hexdigest())
PY
)"

python3 - "$SOURCE_INFO_PLIST" "$PATCHED_INFO_PLIST" "$HEADER_HASH" <<'PY'
import plistlib
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
header_hash = sys.argv[3]
with source_path.open("rb") as f:
    data = plistlib.load(f)

integrity = data.setdefault("ElectronAsarIntegrity", {})
resource_integrity = integrity.setdefault("Resources/app.asar", {})
resource_integrity["algorithm"] = "SHA256"
resource_integrity["hash"] = header_hash

with output_path.open("wb") as f:
    plistlib.dump(data, f)
PY

if [ "$NEED_READ_ADMIN" -eq 1 ]; then
  sudo cp "$ASAR_PATH" "$BACKUP_DIR/app.asar"
  sudo cp "$INFO_PLIST" "$BACKUP_DIR/Info.plist"
else
  cp "$ASAR_PATH" "$BACKUP_DIR/app.asar"
  cp "$INFO_PLIST" "$BACKUP_DIR/Info.plist"
fi

if [ "$NEED_WRITE_ADMIN" -eq 1 ]; then
  echo "Updating protected Claude.app files..."
else
  echo "Updating Claude.app files..."
fi

install_file "$PATCHED_ASAR" "$ASAR_PATH" "$NEED_WRITE_ADMIN"
install_file "$PATCHED_INFO_PLIST" "$INFO_PLIST" "$NEED_WRITE_ADMIN"

# Re-sign the app bundle — modifying app.asar / Info.plist invalidates the
# original code signature and macOS will refuse to launch (error 163).
echo "Re-signing Claude.app (ad-hoc)..."
if [ "$NEED_WRITE_ADMIN" -eq 1 ]; then
  sudo codesign --force --deep --sign - "$APP_PATH"
  sudo xattr -rd com.apple.quarantine "$APP_PATH" 2>/dev/null || true
else
  codesign --force --deep --sign - "$APP_PATH"
  xattr -rd com.apple.quarantine "$APP_PATH" 2>/dev/null || true
fi

cat > "$BACKUP_DIR/metadata.json" <<EOF
{
  "appPath": "$(printf '%s' "$APP_PATH")",
  "asarPath": "$(printf '%s' "$ASAR_PATH")",
  "infoPlist": "$(printf '%s' "$INFO_PLIST")",
  "headerHash": "$HEADER_HASH",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

if [ "$OPEN_AFTER_PATCH" -eq 1 ]; then
  echo "Relaunching Claude..."
  open -a "$APP_PATH"
fi

echo
echo "Patched successfully."
echo "Backup: $BACKUP_DIR"
echo "Hook: $HOOK_SOURCE"
echo "Asar integrity hash: $HEADER_HASH"
echo
echo "Next:"
echo "1. Open Chat in Claude Desktop and ensure it is logged in."
echo "2. Switch to Code."
echo "3. The hook will mint a synced token from Chat and inject it into Code spawns."
echo
echo "State file: /tmp/claude-electron-hook-state.json"
echo "Log file: /tmp/claude-electron-hook.log"
