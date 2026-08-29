#!/usr/bin/env zsh
# Shared Wine session cleanup + Electron render flags for CentriX.
# Source from repo-root scripts. Requires WINEPREFIX (and optionally WINE_BIN).

[[ -n "${_CENTRIX_WINE_SESSION_LOADED:-}" ]] && return 0
_CENTRIX_WINE_SESSION_LOADED=1

# software (default): SwiftShader — the only path that paints a usable window
# under Wine on this Mac. gpu: MoltenVK (often white screen).
# Override: CENTRIX_RENDER=gpu ./run-centrix.sh
centrix_apply_render_mode() {
  typeset -ga CENTRIX_ELECTRON_FLAGS
  case "${CENTRIX_RENDER:-software}" in
    gpu)
      unset LIBGL_ALWAYS_SOFTWARE || true
      CENTRIX_ELECTRON_FLAGS=(
        --disable-gpu-sandbox
        --no-sandbox
      )
      ;;
    *)
      export LIBGL_ALWAYS_SOFTWARE=1
      CENTRIX_ELECTRON_FLAGS=(
        --disable-gpu
        --disable-gpu-compositing
        --disable-gpu-sandbox
        --in-process-gpu
        --use-angle=swiftshader
        --use-gl=swiftshader
        --no-sandbox
      )
      ;;
  esac
}

centrix_wine_should_kill() {
  local pid="$1" comm="$2" cmd="$3" prefix="$4"
  local haystack="$comm $cmd"
  [[ -z "$pid" || "$pid" == "$$" || "$pid" == "${PPID:-}" ]] && return 1
  [[ -n "$prefix" && "$haystack" == *"$prefix"* ]] && return 0
  [[ "$haystack" == *"CentriX App User.exe"* || "$haystack" == *"CentriX.exe"* ]] && return 0
  [[ "$comm" == wineserver || "$haystack" == *wineserver* ]] && return 0
  # macOS comm is 16 chars, so match the full command line for Wine Windows procs
  case "$haystack" in
    *services.exe*|*plugplay.exe*|*svchost.exe*|*rpcss.exe*|*winedevice.exe*|*explorer.exe*)
      return 0 ;;
    *start.exe*)
      [[ "$haystack" == *"/desktop=CentriX"* || ( -n "$prefix" && "$haystack" == *"$prefix"* ) ]] && return 0
      ;;
  esac
  [[ "$haystack" == *$'C:\\windows\\system32\\'* ]] && return 0
  return 1
}

# Full prefix teardown. wineserver -k first, then leftover Wine Windows services
# that previous scripts left behind (PPID 1 orphans).
centrix_kill_wine_session() {
  local prefix="${1:-${WINEPREFIX:-}}"
  local wineserver_bin=""
  local pid comm cmd
  local -a leftover=()

  if [[ -n "${WINE_BIN:-}" && -x "${WINE_BIN:h}/wineserver" ]]; then
    wineserver_bin="${WINE_BIN:h}/wineserver"
  elif [[ -x "/Applications/Wine Stable.app/Contents/Resources/wine/bin/wineserver" ]]; then
    wineserver_bin="/Applications/Wine Stable.app/Contents/Resources/wine/bin/wineserver"
  fi

  if [[ -n "$wineserver_bin" && -n "$prefix" && -d "$prefix" ]]; then
    WINEPREFIX="$prefix" "$wineserver_bin" -k 2>/dev/null || true
  fi
  pgrep -x wineserver 2>/dev/null | while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done

  while read -r pid comm cmd; do
    if centrix_wine_should_kill "$pid" "$comm" "$cmd" "$prefix"; then
      kill "$pid" 2>/dev/null || true
    fi
  done < <(ps -axo pid=,comm=,command=)
  sleep 1

  leftover=()
  while read -r pid comm cmd; do
    if centrix_wine_should_kill "$pid" "$comm" "$cmd" "$prefix"; then
      leftover+=("$pid")
    fi
  done < <(ps -axo pid=,comm=,command=)
  (( ${#leftover} > 0 )) && kill -9 "${leftover[@]}" 2>/dev/null || true
  sleep 0.4
}
