#!/usr/bin/env zsh
# export-pick-service.sh
#
# Chọn service → export cookie J2TEAM ra máy (KHÔNG cần mở app).
# Nguồn: dump đã có từ CentriX App User (hook) trên disk.
#
# ChatGPT đặc biệt: export 2 file
#   - chatgpt.com.json          (cookie chatgpt.com + openai liên quan chat)
#   - auth.openai.com.json      (cookie auth.openai.com cho /log-in)
# Grok: export thêm accounts.x.ai.json, gồm .x.ai SSO cookies.
# DeepSeek: export thêm chat.deepseek.com.json cho trang /sign_in.
#
# Usage:
#   ./export-pick-service.sh              # menu chọn
#   ./export-pick-service.sh chatgpt      # non-interactive
#   ./export-pick-service.sh claude gemini
#   ./export-pick-service.sh all          # mọi service có dump
#   ./export-pick-service.sh grok --chrome # export + import vào Chrome profile riêng
#   ./export-pick-service.sh --list
#
set -euo pipefail
setopt NULL_GLOB 2>/dev/null || true

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"

IMPORT_TO_CHROME="${IMPORT_TO_CHROME:-0}"
typeset -a _positional_args=()
for _arg in "$@"; do
  if [[ "$_arg" == "--chrome" ]]; then
    IMPORT_TO_CHROME=1
  else
    _positional_args+=("$_arg")
  fi
done
set -- "${_positional_args[@]}"

WINEPREFIX="${WINEPREFIX:-$SCRIPT_DIR/wine-prefix-centrix}"
# Resolve Wine userdata (username differs per Mac)
if [[ -z "${USERDATA:-}" ]]; then
  USERDATA=""
  for _u in "$USER" pat; do
    if [[ -d "$WINEPREFIX/drive_c/users/$_u/AppData/Roaming/mkvhszparoue" ]]; then
      USERDATA="$WINEPREFIX/drive_c/users/$_u/AppData/Roaming/mkvhszparoue"
      break
    fi
  done
  if [[ -z "$USERDATA" ]]; then
    _c=("$WINEPREFIX"/drive_c/users/*/AppData/Roaming/mkvhszparoue(N))
    (( ${#_c} > 0 )) && USERDATA="${_c[1]}"
  fi
  USERDATA="${USERDATA:-$WINEPREFIX/drive_c/users/$USER/AppData/Roaming/mkvhszparoue}"
fi
# Cookie exports inside project (override with OUT_DIR=...)
OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/cookies}"
SERVICES_DIR="$OUT_DIR"
# Optional external injector copy (empty = only project cookies/)
J2TEAM_DIR="${J2TEAM_OUT_DIR:-}"
CONVERT_SH="${CONVERT_SH:-$SCRIPT_DIR/export-centrix-cookies.sh}"

# Known catalog (id|display|default_url)
KNOWN_SERVICES=(
  "chatgpt|ChatGPT|https://chatgpt.com"
  "notebooklm|GPT-5.5 Pro|https://chatgpt.com"
  "claude|Claude|https://claude.ai"
  "gemini|Gemini|https://gemini.google.com"
  "perplexity|Perplexity|https://www.perplexity.ai"
  "grok|Grok|https://grok.com"
  "grok-heavy|Grok Heavy|https://grok.com"
  "microsoft-copilot|Microsoft Copilot|https://copilot.microsoft.com"
  "deepseek|DeepSeek|https://chat.deepseek.com/sign_in"
  "envato-elements|Envato Elements|https://elements.envato.com"
)

log()  { print -r -- "▸ $*"; }
warn() { print -r -- "! $*" >&2; }
die()  { print -r -- "ERROR: $*" >&2; exit 1; }

# Resolve python even when PATH is minimal (agent / restricted shells)
if [[ -z "${PYTHON:-}" ]]; then
  for _py in /opt/homebrew/bin/python3 /usr/bin/python3 python3; do
    if command -v "$_py" >/dev/null 2>&1 || [[ -x "$_py" ]]; then
      PYTHON="$_py"
      break
    fi
  done
fi
[[ -n "${PYTHON:-}" ]] || PYTHON="python3"

need_python() {
  if ! command -v "$PYTHON" >/dev/null 2>&1 && [[ ! -x "$PYTHON" ]]; then
    die "python3 required (set PYTHON=/path/to/python3)"
  fi
}

mkdir -p "$OUT_DIR"
[[ -n "$J2TEAM_DIR" && -d "$J2TEAM_DIR" ]] && mkdir -p "$J2TEAM_DIR/centrix"

# ── discover dumps ──────────────────────────────────────────
discover_dumps() {
  # prints: serviceId|path|mtime|size|name|url
  local f sid
  for f in "$USERDATA"/cookies-dump-*.json(N); do
    [[ -f "$f" ]] || continue
    sid="${${f:t}#cookies-dump-}"
    sid="${sid%.json}"
    [[ "$sid" == "disk" ]] && continue
    [[ "$sid" == *cookie-editor* ]] && continue
    "$PYTHON" - "$f" "$sid" <<'PY'
import json,sys,os
path,sid=sys.argv[1],sys.argv[2]
st=os.stat(path)
name,url=sid,""
try:
  d=json.load(open(path))
  if isinstance(d,dict):
    name=d.get("serviceName") or name
    url=d.get("url") or ""
    # cookies may be nested
except Exception:
  pass
print(f"{sid}|{path}|{int(st.st_mtime)}|{st.st_size}|{name}|{url}")
PY
  done
}

lookup_known() {
  local id="$1" row
  for row in "${KNOWN_SERVICES[@]}"; do
    if [[ "${row%%|*}" == "$id" ]]; then
      print -r -- "$row"
      return 0
    fi
  done
  return 1
}

# Build menu lines into arrays
typeset -a MENU_IDS MENU_LABELS MENU_PATHS MENU_URLS
rebuild_menu() {
  MENU_IDS=(); MENU_LABELS=(); MENU_PATHS=(); MENU_URLS=()
  local line sid dump_file mt sz name url label known kname kurl has
  # index known + dumps
  typeset -A dump_path dump_name dump_url dump_mt
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    sid="${line%%|*}"; rest="${line#*|}"
    dump_file="${rest%%|*}"; rest="${rest#*|}"
    mt="${rest%%|*}"; rest="${rest#*|}"
    sz="${rest%%|*}"; rest="${rest#*|}"
    name="${rest%%|*}"; url="${rest#*|}"
    dump_path[$sid]="$dump_file"
    dump_name[$sid]="$name"
    dump_url[$sid]="$url"
    dump_mt[$sid]="$mt"
  done < <(discover_dumps)

  # known first (stable order)
  for row in "${KNOWN_SERVICES[@]}"; do
    sid="${row%%|*}"
    rest="${row#*|}"
    kname="${rest%%|*}"
    kurl="${rest#*|}"
    if [[ -n "${dump_path[$sid]:-}" ]]; then
      has="dump"
      dump_file="${dump_path[$sid]}"
      name="${dump_name[$sid]:-$kname}"
      url="${dump_url[$sid]:-$kurl}"
      mt="${dump_mt[$sid]}"
      label=$(printf "%-22s %-22s [dump %s]" "$sid" "$name" "$(date -r "$mt" '+%H:%M %d/%m' 2>/dev/null || echo ok)")
    else
      has="missing"
      dump_file=""
      name="$kname"
      url="$kurl"
      label=$(printf "%-22s %-22s [chưa có dump]" "$sid" "$name")
    fi
    MENU_IDS+="$sid"
    MENU_LABELS+="$label"
    MENU_PATHS+="$dump_file"
    MENU_URLS+="$url"
  done

  # extra dumps not in known list
  for sid in ${(k)dump_path}; do
    local found=0
    for k in "${MENU_IDS[@]}"; do
      [[ "$k" == "$sid" ]] && found=1 && break
    done
    (( found )) && continue
    MENU_IDS+="$sid"
    MENU_LABELS+="$(printf "%-22s %-22s [dump]" "$sid" "${dump_name[$sid]}")"
    MENU_PATHS+="${dump_path[$sid]}"
    MENU_URLS+="${dump_url[$sid]}"
  done
}

# ── core export (python) ────────────────────────────────────
export_one() {
  need_python
  local sid="$1"
  local dump="${2:-}"
  local url_hint="${3:-}"

  if [[ -z "$dump" || ! -f "$dump" ]]; then
    dump="$USERDATA/cookies-dump-${sid}.json"
  fi
  [[ -f "$dump" ]] || {
    warn "Chưa có dump cho '$sid'."
    warn "Cần mở service đó 1 lần trong CentriX (hook) rồi chạy lại — không cần mở lúc export."
    warn "  dump path: $dump"
    return 1
  }

  log "Export service=$sid  ←  $dump"

  # Shared pattern: scripts/lib/centrix_cookie_export.py (also used by export-centrix-api)
  local -a _py_args=(
    "$SCRIPT_DIR/scripts/lib/centrix_cookie_export.py"
    --service "$sid"
    --dump "$dump"
    --url "$url_hint"
    --out-dir "$OUT_DIR"
  )
  [[ -n "${J2TEAM_DIR:-}" ]] && _py_args+=(--j2team-dir "$J2TEAM_DIR")
  "$PYTHON" "${_py_args[@]}"
}

print_list() {
  rebuild_menu
  print -r -- ""
  print -r -- "Service có thể export (từ dump trên disk, không cần mở app):"
  print -r -- "────────────────────────────────────────────────────────────"
  local i
  for i in {1..${#MENU_IDS}}; do
    printf "  %2d) %s\n" "$i" "${MENU_LABELS[$i]}"
  done
  print -r -- "────────────────────────────────────────────────────────────"
  print -r -- "  a) all  — export mọi service có dump"
  print -r -- "  q) quit"
  print -r -- ""
}

interactive() {
  rebuild_menu
  if (( ${#MENU_IDS} == 0 )); then
    die "Không có dump nào. Mở CentriX + bấm service 1 lần (hook) rồi chạy lại script này."
  fi
  print_list
  print -n "Chọn số (nhiều số cách nhau bởi space), hoặc id (chatgpt), hoặc all: "
  local ans
  read -r ans
  [[ -z "$ans" ]] && die "cancelled"
  [[ "$ans" == "q" || "$ans" == "Q" ]] && exit 0

  local -a picks=()
  if [[ "$ans" == "a" || "$ans" == "all" || "$ans" == "A" ]]; then
    local i
    for i in {1..${#MENU_IDS}}; do
      [[ -n "${MENU_PATHS[$i]}" ]] && picks+="${MENU_IDS[$i]}"
    done
  else
    local tok
    for tok in ${=ans}; do
      if [[ "$tok" == <-> ]]; then
        local idx=$tok
        if (( idx >= 1 && idx <= ${#MENU_IDS} )); then
          picks+="${MENU_IDS[$idx]}"
        else
          warn "Bỏ qua số không hợp lệ: $tok"
        fi
      else
        picks+="$tok"
      fi
    done
  fi

  (( ${#picks} )) || die "Không chọn service nào"
  run_picks "${picks[@]}"
}

run_picks() {
  local requested_sid sid dump_file url ok=0 fail=0
  rebuild_menu
  typeset -A id_to_path id_to_url processed_ids
  local i
  for i in {1..${#MENU_IDS}}; do
    id_to_path[${MENU_IDS[$i]}]="${MENU_PATHS[$i]}"
    id_to_url[${MENU_IDS[$i]}]="${MENU_URLS[$i]}"
  done

  for requested_sid in "$@"; do
    case "$requested_sid" in
      grok) sid="grok-heavy" ;;
      chatgpt) sid="notebooklm" ;;
      *) sid="$requested_sid" ;;
    esac
    if [[ -n "${processed_ids[$sid]:-}" ]]; then
      continue
    fi
    processed_ids[$sid]=1
    [[ "$requested_sid" != "$sid" ]] && log "Alias $requested_sid → $sid"
    dump_file="${id_to_path[$sid]:-}"
    url="${id_to_url[$sid]:-}"
    if [[ -z "$dump_file" ]]; then
      dump_file="$USERDATA/cookies-dump-${sid}.json"
    fi
    if export_one "$sid" "$dump_file" "$url"; then
      (( ++ok ))
      # highlight chatgpt dual output
      if [[ "$sid" == "chatgpt" || "$sid" == "notebooklm" ]]; then
        log "ChatGPT family → cũng ghi auth.openai.com.json (nếu có cookie auth)"
      fi
      if [[ "$sid" == grok* ]]; then
        log "Grok family → cũng ghi accounts.x.ai.json (gồm .x.ai SSO cookies)"
      fi
      if [[ "$sid" == deepseek* ]]; then
        log "DeepSeek family → cũng ghi chat.deepseek.com.json cho /sign_in"
      fi
      if (( IMPORT_TO_CHROME )); then
        if ! "$SCRIPT_DIR/import-cookies-to-chrome.sh" "$sid" --cookies-dir "$OUT_DIR"; then
          warn "Chrome import thất bại cho '$sid'."
          ok=$((ok - 1))
          (( ++fail ))
        fi
      fi
    else
      (( ++fail ))
    fi
    print -r -- ""
  done

  log "Xong: ok=$ok fail=$fail"
  log "Thư mục service: $OUT_DIR/<serviceId>/"
  ls -lah "$OUT_DIR"/*/*.json 2>/dev/null | grep -v full || true
  if [[ -f "$OUT_DIR/chatgpt/auth.openai.com.json" ]]; then
    log "Auth OpenAI: $OUT_DIR/chatgpt/auth.openai.com.json"
  fi
  if [[ -f "$OUT_DIR/chatgpt/chatgpt.com.json" ]]; then
    log "ChatGPT domain: $OUT_DIR/chatgpt/chatgpt.com.json"
  fi
}

# ── main ────────────────────────────────────────────────────
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '1,30p' "$SCRIPT_PATH"
  exit 0
fi

if [[ "${1:-}" == "--list" || "${1:-}" == "-l" ]]; then
  print_list
  exit 0
fi

if [[ $# -eq 0 ]]; then
  interactive
  exit 0
fi

if [[ "$1" == "all" ]]; then
  rebuild_menu
  local -a all=()
  local i
  for i in {1..${#MENU_IDS}}; do
    [[ -n "${MENU_PATHS[$i]}" ]] && all+="${MENU_IDS[$i]}"
  done
  run_picks "${all[@]}"
  exit 0
fi

run_picks "$@"
