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

  "$PYTHON" - "$sid" "$dump" "$url_hint" "$OUT_DIR" "$SERVICES_DIR" "$J2TEAM_DIR" <<'PY'
import json, os, re, sys
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
from urllib.parse import urlparse

sid, dump_path, url_hint, out_dir, services_dir, j2team_dir = sys.argv[1:7]
out_dir = Path(out_dir)
services_root = Path(services_dir)
out_dir.mkdir(parents=True, exist_ok=True)

raw = json.loads(Path(dump_path).read_text(encoding="utf-8"))
if isinstance(raw, list):
    cookies_in = raw
    meta = {}
elif isinstance(raw, dict):
    cookies_in = raw.get("cookies") or []
    meta = raw
else:
    raise SystemExit("invalid dump format")

svc_id = str(meta.get("serviceId") or sid).strip() or sid
svc_name = str(meta.get("serviceName") or svc_id).strip()
url = (url_hint or meta.get("url") or "").strip()
if not url:
    # heuristics
    low = svc_id.lower()
    if "claude" in low: url = "https://claude.ai"
    elif "gemini" in low: url = "https://gemini.google.com"
    elif "grok" in low: url = "https://grok.com"
    elif "copilot" in low: url = "https://copilot.microsoft.com"
    elif "deepseek" in low: url = "https://chat.deepseek.com/sign_in"
    elif "envato" in low: url = "https://elements.envato.com"
    elif "perplexity" in low: url = "https://www.perplexity.ai"
    else: url = "https://chatgpt.com"
if not url.startswith("http"):
    url = "https://" + url

def to_j2(c):
    domain = (c.get("domain") or c.get("host_key") or "").strip()
    if not domain:
        return None
    name = c.get("name") or ""
    if not name:
        return None
    exp = c.get("expirationDate")
    try:
        exp = int(float(exp)) if exp not in (None, "") else None
        if exp and exp > 10**12:
            exp = int(exp / 1000)
    except Exception:
        exp = None
    if exp is None and c.get("expires_utc"):
        try:
            v = int(c["expires_utc"])
            exp = int(v / 1_000_000 - 11644473600) if v > 0 else None
        except Exception:
            pass
    ss = c.get("sameSite")
    if ss is None:
        ss = c.get("samesite")
    if isinstance(ss, int):
        ss = {0: "unspecified", 1: "no_restriction", 2: "lax", 3: "strict"}.get(ss, "unspecified")
    ss = str(ss or "unspecified").lower()
    if ss in ("none",):
        ss = "no_restriction"
    secure = bool(c.get("secure") if "secure" in c else c.get("is_secure"))
    http_only = bool(c.get("httpOnly") if "httpOnly" in c else c.get("is_httponly"))
    session = bool(c.get("session")) if "session" in c else (not exp)
    return {
        "domain": domain,
        "expirationDate": exp,
        "hostOnly": not domain.startswith("."),
        "httpOnly": http_only,
        "name": name,
        "path": c.get("path") or "/",
        "sameSite": ss if ss in ("unspecified", "no_restriction", "lax", "strict") else "unspecified",
        "secure": secure,
        "session": session,
        "storeId": str(c.get("storeId") or "0"),
        "value": "" if c.get("value") is None else str(c.get("value")),
    }

all_j2 = []
for c in cookies_in:
    item = to_j2(c)
    if item:
        all_j2.append(item)

def write_private_json(path: Path, obj: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)
    return path

def write_j2team(path: Path, page_url: str, cookies: list):
    obj = {"url": page_url, "cookies": cookies}
    write_private_json(path, obj)
    return path

def filter_domains(cookies, predicates):
    out = []
    for c in cookies:
        d = c["domain"].lower()
        if any(p(d) for p in predicates):
            out.append(c)
    return out

svc_slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", svc_id).strip("-").lower()
services_dir = services_root / svc_slug
services_dir.mkdir(parents=True, exist_ok=True)
written = []

# Scope normal exports to cookies the service host can actually receive.
# Raw partition contents remain available only in the explicit .full.json file.
host = (urlparse(url).hostname or "").lower()
host_cookies = filter_domains(
    all_j2,
    [lambda d, h=host: bool(h) and (d.lstrip(".") == h or h.endswith("." + d.lstrip(".")))],
)
service_cookies = host_cookies

# Primary service export is safe to inject because it is host-scoped.
p_full = services_dir / f"{svc_slug}.json"
write_j2team(p_full, url, service_cookies)
written.append(p_full)

# full meta
meta_out = {
    "url": url,
    "serviceId": svc_id,
    "serviceName": svc_name,
    "exportedAt": meta.get("exportedAt") or datetime.now(timezone.utc).isoformat(),
    "sourceDump": str(dump_path),
    "cookies": all_j2,
}
write_private_json(services_dir / f"{svc_slug}.full.json", meta_out)

# ChatGPT special: split chatgpt + auth
is_chatgpt_family = svc_slug in ("chatgpt", "notebooklm") or "chatgpt" in url

if is_chatgpt_family:
    # chatgpt.com (+ openai.com chat related, exclude pure auth host)
    chatgpt_cookies = filter_domains(
        all_j2,
        [
            lambda d: "chatgpt.com" in d,
            lambda d: d.endswith("openai.com") and "auth.openai.com" not in d and "sentinel.openai.com" not in d,
        ],
    )
    # auth only
    auth_cookies = filter_domains(all_j2, [lambda d: "auth.openai.com" in d])

    if chatgpt_cookies or is_chatgpt_family:
        p = write_j2team(services_dir / "chatgpt.com.json", "https://chatgpt.com", chatgpt_cookies)
        written.append(p)
        # Keep the compatibility alias domain-focused; raw data lives in .full.json.
        if svc_slug == "chatgpt":
            write_j2team(services_dir / "chatgpt.json", "https://chatgpt.com", chatgpt_cookies)

    if auth_cookies:
        p = write_j2team(services_dir / "auth.openai.com.json", "https://auth.openai.com/log-in", auth_cookies)
        written.append(p)
        print(f"auth_cookies={len(auth_cookies)}")
    else:
        print("auth_cookies=0")

    print(f"chatgpt_domain_cookies={len(chatgpt_cookies)}")

# Grok special: export the separate x.ai sign-in cookies.
is_grok_family = "grok" in svc_slug or "grok" in url.lower()
accounts_xai_cookies = filter_domains(
    all_j2,
    [
        lambda d: d.lstrip(".") in ("x.ai", "accounts.x.ai")
    ],
)
if is_grok_family and accounts_xai_cookies:
    p = write_j2team(
        services_dir / "accounts.x.ai.json",
        "https://accounts.x.ai/sign-in",
        accounts_xai_cookies,
    )
    written.append(p)
    print(f"accounts_xai_cookies={len(accounts_xai_cookies)}")

# DeepSeek special: preserve the login URL and only cookies applicable there.
is_deepseek_family = "deepseek" in svc_slug or "deepseek" in url.lower()
deepseek_signin_cookies = filter_domains(
    all_j2,
    [lambda d: d.lstrip(".") in ("deepseek.com", "chat.deepseek.com")],
)
if is_deepseek_family and deepseek_signin_cookies:
    p = write_j2team(
        services_dir / "chat.deepseek.com.json",
        "https://chat.deepseek.com/sign_in",
        deepseek_signin_cookies,
    )
    written.append(p)
    print(f"deepseek_signin_cookies={len(deepseek_signin_cookies)}")

deepseek_storage_keys = (
    "userToken",
    "settingsJwt",
    "__appKit_@deepseek/chat_lastSessionValue",
)
deepseek_local_storage = {}
if is_deepseek_family and isinstance(meta.get("localStorage"), dict):
    deepseek_local_storage = {
        key: meta["localStorage"][key]
        for key in deepseek_storage_keys
        if isinstance(meta["localStorage"].get(key), str) and meta["localStorage"][key]
    }
if deepseek_local_storage:
    p = write_private_json(
        services_dir / "deepseek.storage.json",
        {"url": "https://chat.deepseek.com", "localStorage": deepseek_local_storage},
    )
    written.append(p)
    print(f"deepseek_local_storage_keys={len(deepseek_local_storage)}")

# Domain-focused file for primary host of this service
if host:
    if host_cookies:
        page_url = "https://chat.deepseek.com/sign_in" if is_deepseek_family else url
        p = write_j2team(services_dir / f"{host}.json", page_url if page_url.startswith("http") else f"https://{host}", host_cookies)
        written.append(p)

# optional external injector copy
if j2team_dir and str(j2team_dir).strip():
    j2p = Path(j2team_dir)
    if j2p.is_dir():
        centrix = j2p / "centrix"
        centrix.mkdir(exist_ok=True)
        write_j2team(j2p / f"{svc_slug}.json", url, service_cookies)
        write_j2team(centrix / f"{svc_slug}.json", url, service_cookies)
        if is_chatgpt_family:
            if chatgpt_cookies:
                write_j2team(j2p / "chatgpt.com.json", "https://chatgpt.com", chatgpt_cookies)
                write_j2team(centrix / "chatgpt.json", "https://chatgpt.com", chatgpt_cookies)
                write_j2team(centrix / "chatgpt.pro.json", "https://chatgpt.com", chatgpt_cookies)
            if auth_cookies:
                write_j2team(j2p / "auth.openai.com.json", "https://auth.openai.com/log-in", auth_cookies)
        if "claude" in svc_slug:
            write_j2team(centrix / "claude.json", url, service_cookies)
        if "gemini" in svc_slug:
            write_j2team(centrix / "gemini.json", url, service_cookies)
        if is_grok_family and accounts_xai_cookies:
            write_j2team(
                j2p / "accounts.x.ai.json",
                "https://accounts.x.ai/sign-in",
                accounts_xai_cookies,
            )
        if is_deepseek_family and deepseek_signin_cookies:
            write_j2team(
                j2p / "chat.deepseek.com.json",
                "https://chat.deepseek.com/sign_in",
                deepseek_signin_cookies,
            )
            write_j2team(
                centrix / "chat.deepseek.com.json",
                "https://chat.deepseek.com/sign_in",
                deepseek_signin_cookies,
            )

print(f"service={svc_slug}")
print(f"name={svc_name}")
print(f"url={url}")
print(f"cookies={len(all_j2)}")
print(f"primary={p_full}")
for w in written:
    print(f"wrote={w}")
PY
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
