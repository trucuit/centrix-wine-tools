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
#   ./setup-centrix-mac.sh --upgrade
#   ./setup-centrix-mac.sh --no-upgrade
#   ./setup-centrix-mac.sh --force-reinstall
#   ./run-centrix.sh
#
# Options:
#   --upgrade       Upgrade without asking when a newer installer is available.
#   --no-upgrade    Keep the installed app; a new Mac is still installed normally.
#   --force-reinstall  Reinstall the selected installer (cannot combine with --no-upgrade).
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
UPGRADE_MODE="ask"
DESKTOP_W="${DESKTOP_W:-1440}"
DESKTOP_H="${DESKTOP_H:-900}"

log()  { print -r -- "▸ $*"; }
ok()   { print -r -- "✓ $*"; }
warn() { print -r -- "! $*" >&2; }
die()  { print -r -- "ERROR: $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --force|--force-reinstall) FORCE=1 ;;
    --upgrade) UPGRADE_MODE="yes" ;;
    --no-upgrade|--skip-upgrade) UPGRADE_MODE="no" ;;
    --help|-h)
      sed -n '1,30p' "$SCRIPT_PATH"
      exit 0
      ;;
    *)
      die "unknown arg: $arg"
      ;;
  esac
done

[[ "$FORCE" == "1" && "$UPGRADE_MODE" == "no" ]] && die "--no-upgrade cannot be combined with --force-reinstall"

# ── find installer .exe in repo ─────────────────────────────
find_installer() {
  local installers=("$SCRIPT_DIR"/CentriX*Setup*.exe(Nn))
  (( ${#installers} > 0 )) || return 1
  INSTALLER="${installers[-1]}"
}

installer_version() {
  local name="${INSTALLER:t}"
  if [[ "$name" =~ '^CentriX(-App-User)?-Setup-([0-9]+(\.[0-9]+)*)\.exe$' ]]; then
    print -r -- "$match[2]"
  fi
}

installed_app_version() {
  local app="$1"
  local asar="${app:h}/resources/app.asar"
  [[ -f "$asar" ]] || return 1
  LC_ALL=C strings "$asar" | awk '
    /APP_VERSION[[:space:]]*=/ {
      sub(/.*APP_VERSION[[:space:]]*=[[:space:]]*"/, "")
      sub(/".*/, "")
      if ($0 ~ /^[0-9.]+$/) {
        print
        exit
      }
    }
  '
}

# Success means $1 is newer than $2. Missing version components compare as zero.
is_newer_version() {
  local -a wanted_parts current_parts
  local wanted="$1" current="$2" i wanted_part current_part
  wanted_parts=("${(@s:.:)wanted}")
  current_parts=("${(@s:.:)current}")

  for (( i = 1; i <= ${#wanted_parts} || i <= ${#current_parts}; i++ )); do
    wanted_part="${wanted_parts[i]:-0}"
    current_part="${current_parts[i]:-0}"
    if (( 10#$wanted_part > 10#$current_part )); then
      return 0
    elif (( 10#$wanted_part < 10#$current_part )); then
      return 1
    fi
  done
  return 1
}

confirm_upgrade() {
  local current="$1" wanted="$2" answer=""
  case "$UPGRADE_MODE" in
    yes) return 0 ;;
    no) return 1 ;;
  esac

  if [[ ! -t 0 ]]; then
    warn "Upgrade available ($current → $wanted), skipped because stdin is not interactive"
    warn "Run with --upgrade to upgrade non-interactively"
    return 1
  fi

  print -n "Upgrade CentriX from $current to $wanted? [y/N] "
  read -r answer
  [[ "$answer" == "y" || "$answer" == "Y" || "$answer" == "yes" || "$answer" == "YES" ]]
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
  find_installer || die "No CentriX*Setup*.exe in $SCRIPT_DIR — pull latest repo or copy installer here"
  ok "Installer: $INSTALLER ($(du -h "$INSTALLER" | awk '{print $1}'))"
  local installer_ver
  installer_ver=$(installer_version)
  [[ -n "$installer_ver" ]] && log "Installer version: $installer_ver"

  export WINEPREFIX
  export WINEDEBUG="-all"
  mkdir -p "$WINEPREFIX"

  local existing existing_ver
  if existing=$(already_installed 2>/dev/null); then
    existing_ver=$(installed_app_version "$existing" 2>/dev/null || true)
    if (( FORCE == 0 )); then
      if [[ -n "$installer_ver" && -n "$existing_ver" ]] && is_newer_version "$installer_ver" "$existing_ver"; then
        if confirm_upgrade "$existing_ver" "$installer_ver"; then
          log "Upgrading CentriX: $existing_ver → $installer_ver"
        else
          ok "CentriX already installed (version $existing_ver): $existing"
          if [[ "$UPGRADE_MODE" == "no" ]]; then
            log "Upgrade available ($existing_ver → $installer_ver), skipped by --no-upgrade"
          elif [[ -t 0 ]]; then
            log "Upgrade available ($existing_ver → $installer_ver), skipped by user"
          fi
          return 0
        fi
      else
        ok "CentriX already installed${existing_ver:+ (version $existing_ver)}: $existing"
        log "Use --force-reinstall to run setup again"
        return 0
      fi
    fi
    if (( FORCE )); then
      warn "Force reinstall…"
    else
      log "Running in-place upgrade…"
    fi
  fi

  log "Closing any running CentriX instances…"
  # match only real CentriX Wine processes; a broad *centrix* would also match
  # this script, tee, invoking shells, log paths — killing the caller mid-run.
  # process substitution avoids the ps|while pipeline that trips set -o pipefail on read EOF.
  while read -r pid cmd; do
    case "$cmd" in
      *"CentriX App User.exe"*|*centrix-shutdown*|*"CentriX-Setup-"*.exe*)
        [[ "$pid" != "$$" ]] && kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done < <(ps -axo pid=,command=)
  sleep 1

  log "Initializing Wine prefix (first run can take 1–2 min)…"
  "$WINE_BIN" wineboot -u 2>/dev/null || "$WINE_BIN" wineboot 2>/dev/null || true

  log "Silent install CentriX (Inno Setup / NSIS)…"
  # Inno: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- | NSIS: /S /currentuser
  if ! "$WINE_BIN" "$INSTALLER" /S /currentuser /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-; then
    warn "Silent install returned non-zero — checking if app exists anyway…"
  fi

  local app app_ver
  if ! app=$(already_installed); then
    die "Install finished but CentriX App User.exe not found under $WINEPREFIX"
  fi
  app_ver=$(installed_app_version "$app" 2>/dev/null || true)
  if [[ -n "$installer_ver" && -n "$app_ver" && "$installer_ver" != "$app_ver" ]]; then
    warn "Installer version $installer_ver completed, but app reports version $app_ver"
  fi
  ok "Installed${app_ver:+ (version $app_ver)}: $app"
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
