#!/usr/bin/env zsh
# run-centrix.sh — launch CentriX App User under Wine (portable across Macs)
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"

# Load paths from setup-centrix-mac.sh if present
if [[ -f "$SCRIPT_DIR/.centrix-env" ]]; then
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.centrix-env"
fi

# Self-healing: if the sourced WINEPREFIX does not exist, fallback to relative path
if [[ -n "${WINEPREFIX:-}" && ! -d "$WINEPREFIX" ]]; then
  unset WINEPREFIX
  unset CENTRIX_EXE
fi

export WINEPREFIX="${WINEPREFIX:-$SCRIPT_DIR/wine-prefix-centrix}"
export WINEDEBUG="${WINEDEBUG:--all}"
export LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"

WINE_BIN="${WINE_BIN:-/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine}"
if [[ ! -f "$WINE_BIN" && ! -x "$WINE_BIN" ]]; then
  print -r -- "ERROR: Wine not found at: $WINE_BIN" >&2
  print -r -- "Run: ./setup-centrix-mac.sh" >&2
  exit 1
fi

# Resolve installed .exe (username may differ per Mac)
EXE="${CENTRIX_EXE:-}"
if [[ -z "$EXE" || ! -f "$EXE" ]]; then
  candidates=(
    "$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/CentriX App User/CentriX App User.exe"
    "$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/CentriX/CentriX.exe"
    "$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/CentriX App User/CentriX.exe"
    "$WINEPREFIX/drive_c/users/pat/AppData/Local/Programs/CentriX App User/CentriX App User.exe"
    "$WINEPREFIX/drive_c/users/pat/AppData/Local/Programs/CentriX/CentriX.exe"
    "$WINEPREFIX/drive_c/users/pat/AppData/Local/Programs/CentriX App User/CentriX.exe"
  )
  EXE=""
  for c in "${candidates[@]}"; do
    if [[ -f "$c" ]]; then EXE="$c"; break; fi
  done
  if [[ -z "$EXE" ]]; then
    found=(
      "$WINEPREFIX"/drive_c/users/*/AppData/Local/Programs/CentriX\ App\ User/CentriX\ App\ User.exe(N)
      "$WINEPREFIX"/drive_c/users/*/AppData/Local/Programs/CentriX\ App\ User/CentriX.exe(N)
      "$WINEPREFIX"/drive_c/users/*/AppData/Local/Programs/CentriX/CentriX.exe(N)
    )
    (( ${#found} > 0 )) && EXE="${found[1]}"
  fi
fi

if [[ -z "$EXE" || ! -f "$EXE" ]]; then
  print -r -- "ERROR: CentriX executable not found under $WINEPREFIX" >&2
  print -r -- "Run: ./setup-centrix-mac.sh" >&2
  exit 1
fi

DESKTOP_W="${DESKTOP_W:-1440}"
DESKTOP_H="${DESKTOP_H:-900}"

print -r -- "▸ WINEPREFIX=$WINEPREFIX"
print -r -- "▸ EXE=$EXE"
print -r -- "▸ Launching Wine desktop ${DESKTOP_W}x${DESKTOP_H}…"

exec "$WINE_BIN" explorer /desktop=CentriX,${DESKTOP_W}x${DESKTOP_H} "$EXE" \
  --disable-gpu \
  --disable-gpu-compositing \
  --disable-gpu-sandbox \
  --in-process-gpu \
  --use-angle=swiftshader \
  --use-gl=swiftshader \
  --no-sandbox \
  "$@"
