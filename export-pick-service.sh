#!/usr/bin/env zsh
# export-pick-service.sh
#
# Chọn service → export cookie từ dump disk (KHÔNG cần mở app lúc export).
#
# Shared write pattern: scripts/lib/centrix-export-common.sh
#   → scripts/lib/centrix_cookie_export.py --sidecars
# (same as export-centrix-cookies.sh + export-centrix-api.sh)
#
# Usage:
#   ./export-pick-service.sh              # menu
#   ./export-pick-service.sh chatgpt
#   ./export-pick-service.sh claude gemini
#   ./export-pick-service.sh all
#   ./export-pick-service.sh grok --chrome
#   ./export-pick-service.sh --list
#
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
SCRIPT_NAME="${SCRIPT_PATH:t}"

source "$SCRIPT_DIR/scripts/lib/centrix-export-common.sh"
centrix_export_init
centrix_parse_shared_flags "$@"
set -- "${CENTRIX_POS_ARGS[@]}"
set +x 2>/dev/null || true
setopt noxtrace 2>/dev/null || true

ensure_out
need_python

# Alias for menu code that used KNOWN_SERVICES name
typeset -ga KNOWN_SERVICES=("${CENTRIX_KNOWN_SERVICES[@]}")

# ── discover dumps ──────────────────────────────────────────
discover_dumps() {
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
  d=json.load(open(path, encoding="utf-8"))
  if isinstance(d,dict):
    name=d.get("serviceName") or name
    url=d.get("url") or ""
    meta_sid=(d.get("serviceId") or "").strip()
    if meta_sid:
      sid=meta_sid
except Exception:
  pass
print(f"{sid}|{path}|{int(st.st_mtime)}|{st.st_size}|{name}|{url}")
PY
  done
}

lookup_known() { lookup_known_service "$@"; }

typeset -a MENU_IDS MENU_LABELS MENU_PATHS MENU_URLS
rebuild_menu() {
  MENU_IDS=(); MENU_LABELS=(); MENU_PATHS=(); MENU_URLS=()
  local line sid dump_file mt sz name url label kname kurl rest
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

  for row in "${KNOWN_SERVICES[@]}"; do
    sid="${row%%|*}"
    rest="${row#*|}"
    kname="${rest%%|*}"
    kurl="${rest#*|}"
    if [[ -n "${dump_path[$sid]:-}" ]]; then
      dump_file="${dump_path[$sid]}"
      name="${dump_name[$sid]:-$kname}"
      url="${dump_url[$sid]:-$kurl}"
      mt="${dump_mt[$sid]}"
      label=$(printf "%-22s %-28s [dump %s]" "$sid" "$name" "$(date -r "$mt" '+%H:%M %d/%m' 2>/dev/null || echo ok)")
    else
      dump_file=$(find_dump_for "$sid" 2>/dev/null || true)
      if [[ -n "$dump_file" && -f "$dump_file" ]]; then
        name="$kname"
        url="$kurl"
        mt=$(stat -f %m "$dump_file" 2>/dev/null || print 0)
        label=$(printf "%-22s %-28s [dump peer %s]" "$sid" "$name" "$(date -r "$mt" '+%H:%M %d/%m' 2>/dev/null || echo ok)")
      else
        dump_file=""
        name="$kname"
        url="$kurl"
        label=$(printf "%-22s %-28s [chưa có dump]" "$sid" "$name")
      fi
    fi
    MENU_IDS+=("$sid")
    MENU_LABELS+=("$label")
    MENU_PATHS+=("$dump_file")
    MENU_URLS+=("$url")
  done

  for sid in ${(k)dump_path}; do
    if (( ${MENU_IDS[(I)$sid]} > 0 )); then
      continue
    fi
    MENU_IDS+=("$sid")
    MENU_LABELS+=("$(printf "%-22s %-28s [dump]" "$sid" "${dump_name[$sid]}")")
    MENU_PATHS+=("${dump_path[$sid]}")
    MENU_URLS+=("${dump_url[$sid]}")
  done
}

export_one() {
  local sid="$1"
  local dump="${2:-}"
  local url_hint="${3:-}"

  if [[ -z "$dump" || ! -f "$dump" ]]; then
    dump=$(find_dump_for "$sid" 2>/dev/null || true)
  fi
  if [[ -z "$dump" || ! -f "$dump" ]]; then
    dump="$USERDATA/cookies-dump-${sid}.json"
  fi
  [[ -f "$dump" ]] || {
    warn "Chưa có dump cho '$sid'."
    warn "  hook: ./export-centrix-cookies.sh install-hook && watch"
    warn "  api:  ./export-centrix-api.sh export $sid"
    return 1
  }

  if [[ -z "$url_hint" ]]; then
    url_hint=$(dump_meta_field "$dump" "url")
  fi
  if [[ -z "$url_hint" ]]; then
    url_hint=$(service_url_hint "$sid")
  fi

  convert_dump "$dump" "$url_hint" "pick-export"
}

print_list() {
  rebuild_menu
  print -r -- ""
  print -r -- "Service export offline (dump disk) — shared pattern → $OUT_DIR"
  print -r -- "USERDATA=$USERDATA"
  print -r -- "────────────────────────────────────────────────────────────"
  local i
  for i in {1..${#MENU_IDS}}; do
    printf "  %2d) %s\n" "$i" "${MENU_LABELS[$i]}"
  done
  print -r -- "────────────────────────────────────────────────────────────"
  print -r -- "  a) all   q) quit"
  if [[ "${CENTRIX_NO_ALIASES:-0}" != "1" ]]; then
    print -r -- "Aliases: chatgpt|gpt → notebooklm · grok → grok-heavy"
  fi
  print -r -- ""
}

interactive() {
  rebuild_menu
  if (( ${#MENU_IDS} == 0 )); then
    die "Không có dump. Mở CentriX + service 1 lần (hook) rồi chạy lại."
  fi
  print_list
  print -n "Chọn số / id / all: "
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
          warn "Bỏ qua: $tok"
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
  local requested_sid sid dump_file url ok=0 fail=0 i
  rebuild_menu
  typeset -A id_to_path id_to_url processed_ids
  for i in {1..${#MENU_IDS}}; do
    id_to_path[${MENU_IDS[$i]}]="${MENU_PATHS[$i]}"
    id_to_url[${MENU_IDS[$i]}]="${MENU_URLS[$i]}"
  done

  for requested_sid in "$@"; do
    sid=$(resolve_service_id "$requested_sid")
    [[ -n "${processed_ids[$sid]:-}" ]] && continue
    processed_ids[$sid]=1
    [[ "$requested_sid" != "$sid" ]] && log "Alias $requested_sid → $sid"
    dump_file="${id_to_path[$sid]:-}"
    url="${id_to_url[$sid]:-}"
    if [[ -z "$dump_file" || ! -f "$dump_file" ]]; then
      dump_file=$(find_dump_for "$sid" 2>/dev/null || true)
    fi
    if export_one "$sid" "$dump_file" "$url"; then
      (( ++ok ))
      if (( IMPORT_TO_CHROME )); then
        if ! import_cookies_to_chrome "$sid"; then
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

  log "Xong: ok=$ok fail=$fail  out=$OUT_DIR/<serviceId>/"
}

# ── main ────────────────────────────────────────────────────
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
export-pick-service.sh — offline export từ cookies-dump-*.json

Shared pattern: scripts/lib/centrix-export-common.sh
             → scripts/lib/centrix_cookie_export.py --sidecars

Usage:
  ./export-pick-service.sh
  ./export-pick-service.sh chatgpt claude
  ./export-pick-service.sh all
  ./export-pick-service.sh grok --chrome
  ./export-pick-service.sh --list

Related:
  ./export-centrix-cookies.sh install-hook | watch
  ./export-centrix-api.sh export <id>
EOF
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
  typeset -a all=()
  local i
  for i in {1..${#MENU_IDS}}; do
    [[ -n "${MENU_PATHS[$i]}" ]] && all+="${MENU_IDS[$i]}"
  done
  (( ${#all} )) || die "Không có dump nào để export (all)."
  run_picks "${all[@]}"
  exit 0
fi

run_picks "$@"
