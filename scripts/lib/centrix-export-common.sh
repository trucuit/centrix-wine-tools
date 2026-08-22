#!/usr/bin/env zsh
# centrix-export-common.sh
#
# Shared pattern for:
#   export-centrix-cookies.sh  (hook / watch / convert)
#   export-pick-service.sh     (offline dump → cookies/)
#   export-centrix-api.sh      (API → cookies/ via node)
#
# Write path (all three):
#   dump/snapshot JSON → scripts/lib/centrix_cookie_export.py --sidecars
#     → $OUT_DIR/<serviceId>/{service,j2team,sidecars}
#
# Usage (each CLI):
#   SCRIPT_PATH="${0:A}"; SCRIPT_DIR="${SCRIPT_PATH:h}"
#   source "$SCRIPT_DIR/scripts/lib/centrix-export-common.sh"
#   centrix_export_init
#   centrix_parse_shared_flags "$@"
#   set -- "${CENTRIX_POS_ARGS[@]}"
#
[[ -n "${_CENTRIX_EXPORT_COMMON_LOADED:-}" ]] && return 0
_CENTRIX_EXPORT_COMMON_LOADED=1

# ── logging ─────────────────────────────────────────────────
log()  { print -r -- "▸ $*"; }
warn() { print -r -- "! $*" >&2; }
die()  { print -r -- "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing dependency: $1"; }

# ── catalog ────────────────────────────────────────────────────
# Format: id|display|default_url
# Dynamic: read from .centrix-services-cache.json (written by API MJS)
# Fallback: hardcoded list if no cache exists
typeset -ga _CENTRIX_FALLBACK_SERVICES=(
  "chatgpt|ChatGPT|https://chatgpt.com/"
  "notebooklm|GPT-5.5 Pro / NotebookLM|https://chatgpt.com/"
  "claude|Claude|https://claude.ai/new"
  "gemini|Gemini|https://gemini.google.com/"
  "perplexity|Perplexity|https://www.perplexity.ai/"
  "grok|Grok|https://grok.com/"
  "grok-heavy|Grok Heavy|https://grok.com/"
  "microsoft-copilot|Microsoft Copilot|https://copilot.microsoft.com/"
  "deepseek|DeepSeek|https://chat.deepseek.com/"
  "mistral|Mistral|https://chat.mistral.ai/"
  "midjourney|Midjourney|https://www.midjourney.com/"
  "poe|Poe|https://poe.com/"
  "elevenlabs|ElevenLabs|https://elevenlabs.io/app"
  "envato-elements|Envato Elements|https://elements.envato.com/"
  "gamma|Gamma|https://gamma.app/"
  "monica|Monica|https://monica.im/"
  "semrush|Semrush|https://www.semrush.com/"
)

# Load services from API cache file (.centrix-services-cache.json)
# Written by export-centrix-api.mjs on login/connect/services commands
_load_services_from_cache() {
  local cache_file="${SCRIPT_DIR:-.}/.centrix-services-cache.json"
  [[ -f "$cache_file" ]] || return 1
  local _py="${PYTHON:-python3}"
  command -v "$_py" >/dev/null 2>&1 || _py=python3
  command -v "$_py" >/dev/null 2>&1 || return 1
  local lines
  lines=$("$_py" -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    for s in data.get("services", []):
        sid = s.get("id", "")
        name = s.get("name", sid)
        url = s.get("url", "")
        if sid:
            print(f"{sid}|{name}|{url}")
except Exception:
    pass
' "$cache_file" 2>/dev/null)
  [[ -z "$lines" ]] && return 1
  CENTRIX_KNOWN_SERVICES=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && CENTRIX_KNOWN_SERVICES+=("$line")
  done <<< "$lines"
  return 0
}

typeset -ga CENTRIX_KNOWN_SERVICES=()
_load_services_from_cache || CENTRIX_KNOWN_SERVICES=("${_CENTRIX_FALLBACK_SERVICES[@]}")

# ── init paths / env ────────────────────────────────────────
centrix_export_init() {
  : "${SCRIPT_DIR:?centrix_export_init: SCRIPT_DIR required}"
  setopt NULL_GLOB 2>/dev/null || true

  SCRIPT_PATH="${SCRIPT_PATH:-}"
  SCRIPT_NAME="${SCRIPT_NAME:-${SCRIPT_PATH:t}}"
  [[ -z "$SCRIPT_NAME" && -n "${0:-}" ]] && SCRIPT_NAME="${0:t}"

  WINEPREFIX="${WINEPREFIX:-$SCRIPT_DIR/wine-prefix-centrix}"
  WINE="${WINE:-/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine}"

  # Wine user base (username differs per Mac)
  if [[ -z "${_wine_user_base:-}" ]]; then
    _wine_user_base=""
    local _u
    for _u in "$USER" pat; do
      if [[ -d "$WINEPREFIX/drive_c/users/$_u/AppData" ]]; then
        _wine_user_base="$WINEPREFIX/drive_c/users/$_u"
        break
      fi
    done
    if [[ -z "$_wine_user_base" ]]; then
      local -a _cand
      _cand=("$WINEPREFIX"/drive_c/users/*/AppData(N))
      (( ${#_cand} > 0 )) && _wine_user_base="${_cand[1]:h}"
    fi
    _wine_user_base="${_wine_user_base:-$WINEPREFIX/drive_c/users/$USER}"
  fi

  APP_DIR="${APP_DIR:-${_wine_user_base}/AppData/Local/Programs/CentriX App User}"
  ASAR="${ASAR:-$APP_DIR/resources/app.asar}"
  ASAR_BAK="${ASAR_BAK:-$APP_DIR/resources/app.asar.bak-cookie-export}"
  APP_ASAR="${APP_ASAR:-$ASAR}"

  if [[ -z "${USERDATA:-}" ]]; then
    # v0.1.339+ uses centrix-ai-frontend; older builds used mkvhszparoue
    if [[ -d "${_wine_user_base}/AppData/Roaming/centrix-ai-frontend" ]]; then
      USERDATA="${_wine_user_base}/AppData/Roaming/centrix-ai-frontend"
    else
      USERDATA="${_wine_user_base}/AppData/Roaming/mkvhszparoue"
    fi
  fi

  OUT_DIR="${OUT_DIR:-${CENTRIX_OUT_DIR:-$SCRIPT_DIR/cookies}}"
  CENTRIX_OUT_DIR="${CENTRIX_OUT_DIR:-$OUT_DIR}"
  J2TEAM_DIR="${J2TEAM_OUT_DIR:-${J2TEAM_DIR:-}}"
  J2TEAM_OUT_DIR="${J2TEAM_OUT_DIR:-$J2TEAM_DIR}"

  SHARED_EXPORT_PY="${SHARED_EXPORT_PY:-$SCRIPT_DIR/scripts/lib/centrix_cookie_export.py}"
  IMPORT_SH="${IMPORT_SH:-$SCRIPT_DIR/import-cookies-to-chrome.sh}"
  API_MJS="${API_MJS:-$SCRIPT_DIR/scripts/export-centrix-api.mjs}"

  CENTRIX_SESSION_FILE="${CENTRIX_SESSION_FILE:-$SCRIPT_DIR/.centrix-api-session.json}"
  CENTRIX_SERVER_URL="${CENTRIX_SERVER_URL:-https://api-centrixapp-quang.centrix.asia}"

  IMPORT_TO_CHROME="${IMPORT_TO_CHROME:-0}"
  TMP_ASAR="${TMP_ASAR:-${TMPDIR:-/tmp}/centrix-asar-cookie-export-$$}"
  MARKER_NAME="${MARKER_NAME:-REQUEST_COOKIE_DUMP}"

  # Python (agent / minimal PATH)
  if [[ -z "${PYTHON:-}" ]]; then
    local _py
    for _py in /opt/homebrew/bin/python3 /usr/bin/python3 python3; do
      if command -v "$_py" >/dev/null 2>&1 || [[ -x "$_py" ]]; then
        PYTHON="$_py"
        break
      fi
    done
  fi
  PYTHON="${PYTHON:-python3}"

  typeset -ga CENTRIX_POS_ARGS=()
}

# Strip shared flags; remaining → CENTRIX_POS_ARGS
centrix_parse_shared_flags() {
  IMPORT_TO_CHROME="${IMPORT_TO_CHROME:-0}"
  CENTRIX_POS_ARGS=()
  local a
  for a in "$@"; do
    case "$a" in
      --chrome) IMPORT_TO_CHROME=1 ;;
      *) CENTRIX_POS_ARGS+=("$a") ;;
    esac
  done
  export IMPORT_TO_CHROME
}

ensure_out() {
  mkdir -p "$OUT_DIR"
  [[ -n "${J2TEAM_DIR:-}" ]] && mkdir -p "$J2TEAM_DIR" "$J2TEAM_DIR/centrix" 2>/dev/null || true
}

need_python() {
  if ! command -v "$PYTHON" >/dev/null 2>&1 && [[ ! -x "$PYTHON" ]]; then
    die "python3 required (set PYTHON=/path/to/python3)"
  fi
  [[ -f "$SHARED_EXPORT_PY" ]] || die "missing shared exporter: $SHARED_EXPORT_PY"
}

# ── service aliases (pool) ──────────────────────────────────
# CENTRIX_NO_ALIASES=1 → identity
resolve_service_id() {
  local raw="${1:l}"
  raw="${raw// /}"
  if [[ "${CENTRIX_NO_ALIASES:-0}" == "1" ]]; then
    print -r -- "$raw"
    return
  fi
  case "$raw" in
    chatgpt|gpt|gpt-5|pro|chatgpt-pro|gpt-pro) print -r -- "notebooklm" ;;
    grok|grok-4)                   print -r -- "grok-heavy" ;;
    *)                             print -r -- "$raw" ;;
  esac
}

service_url_hint() {
  local sid="$1" row rest
  for row in "${CENTRIX_KNOWN_SERVICES[@]}"; do
    if [[ "${row%%|*}" == "$sid" ]]; then
      print -r -- "${row##*|}"
      return 0
    fi
  done
  case "$sid" in
    chatgpt|notebooklm|*gpt*) print -r -- "https://chatgpt.com" ;;
    claude*)                  print -r -- "https://claude.ai" ;;
    gemini*)                  print -r -- "https://gemini.google.com" ;;
    grok*)                    print -r -- "https://grok.com" ;;
    deepseek*)                print -r -- "https://chat.deepseek.com" ;;
    perplexity*)              print -r -- "https://www.perplexity.ai" ;;
    envato*)                  print -r -- "https://elements.envato.com" ;;
    *)                        print -r -- "" ;;
  esac
}

lookup_known_service() {
  local id="$1" row
  for row in "${CENTRIX_KNOWN_SERVICES[@]}"; do
    if [[ "${row%%|*}" == "$id" ]]; then
      print -r -- "$row"
      return 0
    fi
  done
  return 1
}

# ── dump path helpers ───────────────────────────────────────
resolve_dump_path() {
  local p="${1:-}"
  [[ -n "$p" ]] || return 1
  [[ -f "$p" ]] && { print -r -- "$p"; return 0; }
  if [[ "$p" != */* && "$p" != *\\* ]]; then
    [[ -f "$USERDATA/$p" ]] && { print -r -- "$USERDATA/$p"; return 0; }
    [[ -f "$USERDATA/cookies-dump-${p}.json" ]] && {
      print -r -- "$USERDATA/cookies-dump-${p}.json"
      return 0
    }
  fi
  local norm="${p//\\//}"
  if [[ "$norm" == [Cc]:/* ]]; then
    local rest="${norm#?:/}"
    rest="${rest#/}"
    if [[ -f "$WINEPREFIX/drive_c/$rest" ]]; then
      print -r -- "$WINEPREFIX/drive_c/$rest"
      return 0
    fi
    local base="${norm:t}"
    [[ -f "$USERDATA/$base" ]] && { print -r -- "$USERDATA/$base"; return 0; }
  fi
  return 1
}

find_dump_for() {
  local sid="$1" f peer
  peer=$(resolve_service_id "$sid")
  # Aliased ids (chatgpt→notebooklm, grok→grok-heavy): prefer the *pool* dump first.
  # Otherwise cookies-dump-chatgpt.json (old free slot) wins over GPT-5.5 Pro dump.
  if [[ -n "$peer" && "$peer" != "$sid" ]]; then
    for f in \
      "$USERDATA/cookies-dump-${peer}.json" \
      "$USERDATA/cookies-dump-${sid}.json"
    do
      [[ -f "$f" ]] && { print -r -- "$f"; return 0; }
    done
  else
    for f in \
      "$USERDATA/cookies-dump-${sid}.json" \
      "$USERDATA/cookies-dump-${peer}.json"
    do
      [[ -f "$f" ]] && { print -r -- "$f"; return 0; }
    done
  fi
  case "$sid" in
    notebooklm|chatgpt|gpt|gpt-5|pro|chatgpt-pro|gpt-pro)
      for f in \
        "$USERDATA/cookies-dump-notebooklm.json" \
        "$USERDATA/cookies-dump-chatgpt.json"
      do
        [[ -f "$f" ]] && { print -r -- "$f"; return 0; }
      done
      ;;
    grok-heavy|grok|grok-4)
      for f in \
        "$USERDATA/cookies-dump-grok-heavy.json" \
        "$USERDATA/cookies-dump-grok.json"
      do
        [[ -f "$f" ]] && { print -r -- "$f"; return 0; }
      done
      ;;
  esac
  return 1
}

dump_meta_field() {
  # dump_meta_field <file> <field>
  local f="$1" field="$2"
  [[ -f "$f" ]] || return 1
  "$PYTHON" -c '
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
if not isinstance(d,dict):
  print("")
else:
  v=d.get(sys.argv[2])
  print("" if v is None else str(v).strip())
' "$f" "$field" 2>/dev/null || true
}

# ── core write pattern → centrix_cookie_export.py ───────────
# convert_dump <src.json> [url_hint] [source_label]
convert_dump() {
  local src="$1"
  local force_url="${2:-}"
  local source_label="${3:-export}"
  [[ -f "$src" ]] || die "file not found: $src"
  need_python
  ensure_out

  local base="${src:t:r}"
  local nice="${base#cookies-dump-}"
  local sid="$nice"
  local meta_sid
  meta_sid=$(dump_meta_field "$src" "serviceId")
  meta_sid="${meta_sid//$'\n'/}"
  [[ -n "${meta_sid:-}" ]] && sid="$meta_sid"

  local j2team_dir="${J2TEAM_OUT_DIR:-${J2TEAM_DIR:-}}"
  local -a _py_args=(
    "$SHARED_EXPORT_PY"
    --service "$sid"
    --dump "$src"
    --out-dir "$OUT_DIR"
    --source "$source_label"
    --sidecars
  )
  [[ -n "${force_url:-}" ]] && _py_args+=(--url "$force_url")
  [[ -n "${j2team_dir:-}" ]] && _py_args+=(--j2team-dir "$j2team_dir")

  log "Export (shared pattern) service=$sid  ←  $src"
  "$PYTHON" "${_py_args[@]}"

  local service_out="$OUT_DIR/${sid}"
  if [[ "$nice" != "$sid" && -d "$OUT_DIR/$sid" && ! -e "$OUT_DIR/$nice" ]]; then
    ln -sfn "$sid" "$OUT_DIR/$nice" 2>/dev/null || true
  fi

  log "OUT_DIR=$OUT_DIR"
  log "Service folder: $service_out/"
  log "J2TEAM: $service_out/${sid}.json (+ .full.json, specials, sidecars)"
  if [[ -n "$j2team_dir" && -d "$j2team_dir" ]]; then
    log "Also copied → $j2team_dir/"
  fi
}

# process one dump file (url from meta or catalog) + optional chrome
process_dump_file() {
  local f="$1"
  local source_label="${2:-hook-export}"
  [[ -f "$f" ]] || return 1
  local sid="${${f:t}#cookies-dump-}"
  sid="${sid%.json}"
  local hint
  hint=$(service_url_hint "$sid")
  local u
  u=$(dump_meta_field "$f" "url")
  [[ -n "$u" ]] && hint="$u"
  log "Overwrite service JSON: $sid ← $f"
  convert_dump "$f" "$hint" "$source_label"
  if (( IMPORT_TO_CHROME )); then
    import_cookies_to_chrome "$sid" || warn "Chrome import failed for $sid"
  fi
}

import_cookies_to_chrome() {
  local sid="$1"
  [[ -x "$IMPORT_SH" || -f "$IMPORT_SH" ]] || {
    warn "import-cookies-to-chrome.sh missing — skip"
    return 1
  }
  log "Chrome import: $sid"
  zsh "$IMPORT_SH" "$sid" --cookies-dir "$OUT_DIR"
}

# ── App version (fast asar binary scan) ─────────────────────
detect_app_version() {
  if [[ -n "${CENTRIX_APP_VERSION:-}" ]]; then
    print -r -- "$CENTRIX_APP_VERSION"
    return
  fi
  local ver="" asar="${APP_ASAR:-$ASAR}"
  if [[ -f "$asar" ]]; then
    ver=$(
      "$PYTHON" -c '
import re, sys
from pathlib import Path
raw = Path(sys.argv[1]).read_bytes()
m = re.search(rb"APP_VERSION\s*=\s*[\"\x27]([0-9][0-9.]+)[\"\x27]", raw)
if m:
  print(m.group(1).decode())
' "$asar" 2>/dev/null || true
    )
  fi
  print -r -- "${ver:-3.18.1}"
}

# Export env block used by API node CLI
export_api_env() {
  export CENTRIX_APP_VERSION="${CENTRIX_APP_VERSION:-$(detect_app_version)}"
  export CENTRIX_OUT_DIR="$OUT_DIR"
  export CENTRIX_SESSION_FILE
  export CENTRIX_SERVER_URL
  export IMPORT_TO_CHROME
  # Avoid set -e trip on false [[ ]] && …
  if [[ -n "${J2TEAM_OUT_DIR:-}" ]]; then
    export J2TEAM_OUT_DIR
  elif [[ -n "${J2TEAM_DIR:-}" ]]; then
    export J2TEAM_OUT_DIR="$J2TEAM_DIR"
  fi
  return 0
}
