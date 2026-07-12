#!/usr/bin/env zsh
# setup-centrix-mac.sh
#
# Bootstrap CentriX App User (Windows .exe) on another Mac via Wine.
#
# What it does:
#   1. Check macOS / arch (Apple Silicon needs Rosetta for Wine Stable)
#   2. Install Wine Stable (Homebrew cask) if missing
#   3. Create local Wine prefix next to this script
#   4. Silent-install CentriX-App-User-Setup-*.exe into the prefix
#   5. Verify launch path
#
# Usage:
#   cd centrix-wine-tools
#   ./setup-centrix-mac.sh
#   ./setup-centrix-mac.sh --force-reinstall
#   ./run-centrix.sh
#
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
cd "$SCRIPT_DIR"

WINEPREFIX="${WINEPREFIX:-$SCRIPT_DIR/wine-prefix-centrix}"
WINE_APP="${WINE_APP:-/Applications/Wine Stable.app}"
WINE_BIN="${WINE_BIN:-$WINE_APP/Contents/Resources/wine/bin/wine}"
INSTALLER=""
FORCE=0
DESKTOP_W="${DESKTOP_W:-1440}"
DESKTOP_H="${DESKTOP_H:-900}"

log()  { print -r -- "▸ $*"; }
ok()   { print -r -- "✓ $*"; }
warn() { print -r -- "! $*" >&2; }
die()  { print -r -- "ERROR: $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --force|--force-reinstall) FORCE=1 ;;
    --help|-h)
      sed -n '1,25p' "$SCRIPT_PATH"
      exit 0
      ;;
    *)
      die "unknown arg: $arg"
      ;;
  esac
done

# ── find installer .exe in repo ─────────────────────────────
find_installer() {
  local f
  for f in "$SCRIPT_DIR"/CentriX-App-User-Setup*.exe(N); do
    [[ -f "$f" ]] || continue
    INSTALLER="$f"
    return 0
  done
  return 1
}

# ── checks ──────────────────────────────────────────────────
check_os() {
  [[ "$(uname -s)" == "Darwin" ]] || die "macOS only"
  local arch
  arch="$(uname -m)"
  log "macOS arch: $arch"
  if [[ "$arch" == "arm64" ]]; then
    if ! /usr/bin/pgrep -q oahd 2>/dev/null && ! pkgutil --pkg-info com.apple.pkg.RosettaUpdateAuto >/dev/null 2>&1; then
      warn "Rosetta 2 not detected. Wine Stable is x86_64 and needs Rosetta."
      log "Install Rosetta: softwareupdate --install-rosetta --agree-to-license"
      print -n "Install Rosetta now? [y/N] "
      local a
      read -r a
      if [[ "$a" == "y" || "$a" == "Y" ]]; then
        softwareupdate --install-rosetta --agree-to-license
      else
        die "Rosetta required on Apple Silicon"
      fi
    else
      ok "Rosetta available"
    fi
  fi
}

install_wine() {
  if [[ -x "$WINE_BIN" || -f "$WINE_BIN" ]]; then
    ok "Wine found: $WINE_BIN"
    "$WINE_BIN" --version || true
    return 0
  fi
  log "Wine Stable not found — installing via Homebrew cask…"
  command -v brew >/dev/null || die "Homebrew required: https://brew.sh"
  # gstreamer-runtime may need sudo; skip deps if that fails
  if ! brew install --cask wine-stable --skip-cask-deps 2>/dev/null; then
    warn "brew install wine-stable failed; trying without skip-cask-deps…"
    brew install --cask wine-stable || die "Could not install Wine Stable"
  fi
  xattr -dr com.apple.quarantine "$WINE_APP" 2>/dev/null || true
  [[ -f "$WINE_BIN" ]] || die "Wine still missing after install: $WINE_BIN"
  ok "Wine installed: $("$WINE_BIN" --version)"
}

already_installed() {
  local exe="$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/CentriX App User/CentriX App User.exe"
  # Wine often uses "pat" or mac username; also try pat + current user + *
  local candidates=(
    "$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/CentriX App User/CentriX App User.exe"
    "$WINEPREFIX/drive_c/users/pat/AppData/Local/Programs/CentriX App User/CentriX App User.exe"
  )
  local c
  for c in "${candidates[@]}"; do
    [[ -f "$c" ]] && { print -r -- "$c"; return 0; }
  done
  # glob search
  local found
  found=("$WINEPREFIX"/drive_c/users/*/AppData/Local/Programs/CentriX\ App\ User/CentriX\ App\ User.exe(N))
  if (( ${#found} > 0 )); then
    print -r -- "${found[1]}"
    return 0
  fi
  return 1
}

install_centrix() {
  find_installer || die "No CentriX-App-User-Setup*.exe in $SCRIPT_DIR — pull latest repo or copy installer here"
  ok "Installer: $INSTALLER ($(du -h "$INSTALLER" | awk '{print $1}'))"

  export WINEPREFIX
  export WINEDEBUG="-all"
  mkdir -p "$WINEPREFIX"

  local existing
  if existing=$(already_installed 2>/dev/null); then
    if (( FORCE == 0 )); then
      ok "CentriX already installed: $existing"
      log "Use --force-reinstall to run setup again"
      return 0
    fi
    warn "Force reinstall…"
  fi

  log "Initializing Wine prefix (first run can take 1–2 min)…"
  "$WINE_BIN" wineboot -u 2>/dev/null || "$WINE_BIN" wineboot 2>/dev/null || true

  log "Silent install CentriX App User (Inno Setup)…"
  # Inno: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
  if ! "$WINE_BIN" "$INSTALLER" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-; then
    warn "Silent install returned non-zero — checking if app exists anyway…"
  fi

  local app
  if ! app=$(already_installed); then
    die "Install finished but CentriX App User.exe not found under $WINEPREFIX"
  fi
  ok "Installed: $app"
}

write_local_env() {
  # so run-centrix.sh can use relative paths on any Mac
  cat > "$SCRIPT_DIR/.centrix-env" <<EOF
# Generated by setup-centrix-mac.sh — local only (gitignored)
export WINEPREFIX="$WINEPREFIX"
export WINE_BIN="$WINE_BIN"
export CENTRIX_EXE="$(already_installed)"
EOF
  ok "Wrote $SCRIPT_DIR/.centrix-env"
}

print_next() {
  cat <<EOF

════════════════════════════════════════════════════════
 Setup complete on this Mac
════════════════════════════════════════════════════════

  Launch:
    cd "$SCRIPT_DIR"
    ./run-centrix.sh

  Optional cookie tools:
    ./export-centrix-cookies.sh install-hook
    ./export-centrix-cookies.sh watch
    ./export-pick-service.sh
    ./export-pick-service.sh grok      # grok.com + accounts.x.ai SSO
    ./export-pick-service.sh deepseek  # chat.deepseek.com/sign_in

  Prefix (local, not in git):
    $WINEPREFIX

  Login CentriX with Google once on this machine.
════════════════════════════════════════════════════════
EOF
}

# ── main ────────────────────────────────────────────────────
log "CentriX Wine setup — repo: $SCRIPT_DIR"
check_os
install_wine
install_centrix
write_local_env
print_next
