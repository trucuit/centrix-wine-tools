#!/usr/bin/env zsh
# export-centrix-cookies.sh
# Export cookies from CentriX App User (Wine) → files on Mac for curl / Cookie-Editor / browser.
#
# WHY NOT just read Cookies SQLite?
#   ChatGPT/Claude sessions live in a RAM-only Electron partition (tgbyhnujmik-*).
#   Disk DB .../mkvhszparoue/Network/Cookies is usually EMPTY for those services.
#
# Modes:
#   dump-live   (default)  Patch app once → you open service → dump JSON → convert → restore asar
#   install-hook           Keep dump hook forever: every service-open overwrites cookie files
#   watch                  Watch dumps + convert/overwrite J2TEAM on each service open (run alongside app)
#   disk                   Export whatever is already in Cookies SQLite (often empty)
#   convert                Convert a dump JSON / profile snapshot → cookies.txt + editor JSON
#   uninstall-hook         Remove hook + restore asar.bak if present
#   import-help            Print how to load files into Mac Chrome/Safari/curl
#
# Usage:
#   ./export-centrix-cookies.sh install-hook    # one-time inject, restart app
#   ./export-centrix-cookies.sh watch           # auto overwrite j2team when you open services
#   ./export-centrix-cookies.sh dump-live chatgpt
#   ./export-centrix-cookies.sh dump-live grok  # also writes accounts.x.ai.json
#   ./export-centrix-cookies.sh dump-live deepseek # also writes chat.deepseek.com.json
#   ./export-centrix-cookies.sh convert /path/to/cookies-dump-chatgpt.json
#   ./export-centrix-cookies.sh export-all --chrome # export + import vào Chrome profile riêng
#
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
SCRIPT_NAME="${SCRIPT_PATH:t}"
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
WINE="${WINE:-/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine}"
# Resolve Wine user dir (username differs per Mac)
_wine_user_base=""
for _u in "$USER" pat; do
  if [[ -d "$WINEPREFIX/drive_c/users/$_u/AppData" ]]; then
    _wine_user_base="$WINEPREFIX/drive_c/users/$_u"
    break
  fi
done
if [[ -z "$_wine_user_base" ]]; then
  _cand=("$WINEPREFIX"/drive_c/users/*/AppData(N))
  (( ${#_cand} > 0 )) && _wine_user_base="${_cand[1]:h}"
fi
_wine_user_base="${_wine_user_base:-$WINEPREFIX/drive_c/users/$USER}"
APP_DIR="${_wine_user_base}/AppData/Local/Programs/CentriX App User"
ASAR="$APP_DIR/resources/app.asar"
ASAR_BAK="$APP_DIR/resources/app.asar.bak-cookie-export"
USERDATA="${_wine_user_base}/AppData/Roaming/mkvhszparoue"
# Cookie exports live inside the project (override with OUT_DIR=...)
OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/cookies}"
TMP_ASAR="${TMPDIR:-/tmp}/centrix-asar-cookie-export-$$"
MARKER_NAME="REQUEST_COOKIE_DUMP"
DUMP_GLOB="cookies-dump-*.json"

mode="${1:-dump-live}"
service_filter="${2:-${SERVICE:-}}"

log()  { print -r -- "▸ $*"; }
die()  { print -r -- "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing dependency: $1"; }

ensure_out() {
  mkdir -p "$OUT_DIR"
}

chrome_ts_to_unix() {
  # Chromium: microseconds since 1601-01-01 → unix seconds
  python3 -c "v=int('${1:-0}'); print(0 if v<=0 else int(v/1_000_000 - 11644473600))"
}

# ── Convert Electron cookie array OR profile snapshot
#    → shared pattern: scripts/lib/centrix_cookie_export.py
#    (same as export-pick-service.sh + export-centrix-api.sh)
#    + sidecars: Netscape / Cookie-Editor / curl / j2team / cookie-header.*
#
convert_dump() {
  local src="$1"
  local force_url="${2:-}"
  [[ -f "$src" ]] || die "file not found: $src"
  ensure_out
  local base="${src:t:r}"
  local nice="${base#cookies-dump-}"
  # Prefer serviceId from dump meta when present
  local sid="$nice"
  local meta_sid=""
  meta_sid=$(python3 -c 'import json,sys
try:
 d=json.load(open(sys.argv[1],encoding="utf-8"))
 print((d.get("serviceId") or "").strip() if isinstance(d,dict) else "")
except Exception:
 pass' "$src" 2>/dev/null) || true
  [[ -n "${meta_sid:-}" ]] && sid="$meta_sid"

  local j2team_dir="${J2TEAM_OUT_DIR:-}"
  local -a _py_args=(
    "$SCRIPT_DIR/scripts/lib/centrix_cookie_export.py"
    --service "$sid"
    --dump "$src"
    --out-dir "$OUT_DIR"
    --sidecars
  )
  [[ -n "${force_url:-}" ]] && _py_args+=(--url "$force_url")
  [[ -n "${j2team_dir:-}" ]] && _py_args+=(--j2team-dir "$j2team_dir")

  log "Export (shared pattern) service=$sid  ←  $src"
  python3 "${_py_args[@]}"

  local service_out="$OUT_DIR/${sid}"
  # alias folder if nice != sid (e.g. dump name vs meta id)
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

# ── Disk SQLite (usually empty for ChatGPT pool) ──
export_disk() {
  need sqlite3
  need python3
  ensure_out
  local db="$USERDATA/Network/Cookies"
  [[ -f "$db" ]] || die "Cookies DB not found: $db"

  # Copy to avoid locks
  local copy="$OUT_DIR/Cookies.copy.db"
  cp -f "$db" "$copy" 2>/dev/null || cp -f "$db" "$copy"
  chmod 600 "$copy"
  if [[ -f "${db}-journal" ]]; then
    cp -f "${db}-journal" "$OUT_DIR/" 2>/dev/null || true
    [[ -f "$OUT_DIR/Cookies-journal" ]] && chmod 600 "$OUT_DIR/Cookies-journal"
  fi

  local json="$OUT_DIR/cookies-dump-disk.json"
  python3 - "$copy" "$json" <<'PY'
import sqlite3, json, sys
from pathlib import Path
db, out = sys.argv[1:3]
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
try:
    rows = con.execute("SELECT * FROM cookies").fetchall()
except Exception as e:
    print("query failed", e)
    rows = []
cookies = []
for r in rows:
    d = dict(r)
    # map chromium → electron-ish
    cookies.append({
        "name": d.get("name"),
        "value": d.get("value") or "",
        "domain": d.get("host_key"),
        "path": d.get("path") or "/",
        "secure": bool(d.get("is_secure")),
        "httpOnly": bool(d.get("is_httponly")),
        "expires_utc": d.get("expires_utc"),
        "sameSite": d.get("samesite"),
    })
Path(out).write_text(json.dumps(cookies, indent=2), encoding="utf-8")
Path(out).chmod(0o600)
print(len(cookies))
PY

  local n
  n=$(python3 -c "import json;print(len(json.load(open('$json'))))")
  log "Disk cookies: $n → $json"
  if (( n == 0 )); then
    log "EMPTY — ChatGPT cookies are RAM-only. Use: $SCRIPT_NAME dump-live chatgpt"
    return 0
  fi
  convert_dump "$json"
}

# Hook body: ALWAYS dump+overwrite on every service-open-ready
HOOK_JS='
// --- CENTRIX_COOKIE_EXPORT_HOOK (auto overwrite on each service open) ---
try {
  const __fs = require("node:fs");
  const __path = require("node:path");
  const __sid = String((activeService && activeService.id) || "unknown");
  const __sname = String((activeService && activeService.name) || __sid);
  const __surl = String((activeService && activeService.url) || "");
  const __ud = app.getPath("userData");
  // Always dump (overwrite) full session cookies for this service open
  const __storagePromise = __sid.includes("deepseek")
    ? tab.webContents.executeJavaScript(`(() => {
        const keys = ["userToken", "settingsJwt", "__appKit_@deepseek/chat_lastSessionValue"];
        return Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]).filter(([, value]) => value !== null));
      })()`, true).catch(() => ({}))
    : Promise.resolve({});
  Promise.all([tab.webContents.session.cookies.get({}), __storagePromise])
    .then(([list, localStorage]) => {
      const payload = {
        url: __surl || "",
        serviceId: __sid,
        serviceName: __sname,
        exportedAt: new Date().toISOString(),
        cookies: list || [],
        localStorage: localStorage || {}
      };
      const out = __path.join(__ud, `cookies-dump-${__sid}.json`);
      // atomic-ish overwrite
      const tmp = out + ".tmp";
      __fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      __fs.renameSync(tmp, out);
      try { __fs.chmodSync(out, 0o600); } catch (_) {}
      // touch marker so external watchers wake immediately
      try { __fs.writeFileSync(__path.join(__ud, "COOKIE_DUMP_LATEST.txt"), `${__sid}\n${out}\n${(list||[]).length}\n`); } catch (_) {}
      writeUserRuntimeLog("cookie-export-dump", { serviceId: __sid, serviceName: __sname, count: (list || []).length, out, overwrite: true });
    })
    .catch((e) => writeUserRuntimeLog("cookie-export-fail", { serviceId: __sid, error: String(e && e.message || e) }));
} catch (e) { /* never break openService */ }
// --- END CENTRIX_COOKIE_EXPORT_HOOK ---
'

# ── Live dump: asar hook ──
inject_dump_hook() {
  need npx
  need python3
  [[ -f "$ASAR" ]] || die "app.asar not found: $ASAR"

  if [[ ! -f "$ASAR_BAK" ]]; then
    log "Backup asar → $ASAR_BAK"
    cp -f "$ASAR" "$ASAR_BAK"
  else
    log "Backup already exists (keep original): $ASAR_BAK"
  fi

  rm -rf "$TMP_ASAR"
  log "Extract asar…"
  npx --yes @electron/asar extract "$ASAR" "$TMP_ASAR"

  local main="$TMP_ASAR/src/remote-user-main.js"
  [[ -f "$main" ]] || die "main not found in asar (unexpected build layout)"

  log "Install/refresh cookie dump hook (overwrite on every service open)…"
  HOOK_JS="$HOOK_JS" python3 - "$main" <<'PY'
from pathlib import Path
import os, re, sys
main = Path(sys.argv[1])
text = main.read_text(encoding="utf-8")
hook = os.environ["HOOK_JS"]
# Remove old hook if present
text2 = re.sub(
    r"\n// --- CENTRIX_COOKIE_EXPORT_HOOK.*?// --- END CENTRIX_COOKIE_EXPORT_HOOK ---\n?",
    "\n",
    text,
    flags=re.S,
)
text = text2
needle = 'writeUserRuntimeLog("service-open-ready", {'
idx = text.find(needle)
if idx < 0:
    raise SystemExit("could not find service-open-ready log site to inject")
rest = text[idx:]
close_rel = rest.find("\n        });")
if close_rel < 0:
    raise SystemExit("could not find closing }); for service-open-ready")
insert_at = idx + close_rel + len("\n        });")
text = text[:insert_at] + "\n" + hook + text[insert_at:]
main.write_text(text, encoding="utf-8")
print("hook installed (always overwrite on service open)")
PY

  log "Repack asar…"
  npx --yes @electron/asar pack "$TMP_ASAR" "$ASAR"
  rm -rf "$TMP_ASAR"
  # keep permanent enable marker (optional; hook always runs now)
  : > "$USERDATA/$MARKER_NAME"
  log "Hook active: mỗi lần service-open-ready → ghi đè cookies-dump-<id>.json"
}

restore_asar() {
  if [[ -f "$ASAR_BAK" ]]; then
    log "Restore original asar"
    mv -f "$ASAR_BAK" "$ASAR"
  fi
  rm -f "$USERDATA/$MARKER_NAME"
  rm -rf "$TMP_ASAR"
}

uninstall_hook() {
  restore_asar
  log "Hook removed. Restart CentriX to load clean asar."
}

# Map serviceId → default site URL for j2team
service_url_hint() {
  case "$1" in
    chatgpt|notebooklm|*gpt*) print -r -- "https://chatgpt.com" ;;
    claude*) print -r -- "https://claude.ai" ;;
    gemini*) print -r -- "https://gemini.google.com" ;;
    grok*) print -r -- "https://grok.com" ;;
    deepseek*) print -r -- "https://chat.deepseek.com/sign_in" ;;
    perplexity*) print -r -- "https://www.perplexity.ai" ;;
    envato*) print -r -- "https://elements.envato.com" ;;
    *) print -r -- "" ;;
  esac
}

# Convert one dump and overwrite outputs (Desktop + centriq-cookies-injector)
process_dump_file() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  local sid="${${f:t}#cookies-dump-}"
  sid="${sid%.json}"
  local hint
  hint=$(service_url_hint "$sid")
  # prefer url inside dump if present
  if command -v python3 >/dev/null; then
    local u
    u=$(python3 -c "import json;d=json.load(open('$f'));print(d.get('url') or '')" 2>/dev/null || true)
    [[ -n "$u" ]] && hint="$u"
  fi
  log "Overwrite service JSON: $sid ← $f"
  convert_dump "$f" "$hint"
  if (( IMPORT_TO_CHROME )); then
    "$SCRIPT_DIR/import-cookies-to-chrome.sh" "$sid" --cookies-dir "$OUT_DIR"
  fi
}

# Rebuild all service JSON files from existing dumps
export_all_services() {
  ensure_out
  local n=0
  local f
  # Only raw dumps: cookies-dump-<serviceId>.json (skip *.cookie-editor*, disk empty, etc.)
  for f in "$USERDATA"/cookies-dump-*.json(N); do
    [[ -f "$f" ]] || continue
    local base="${f:t}"
    # skip noise
    [[ "$base" == *cookie-editor* ]] && continue
    [[ "$base" == "cookies-dump-disk.json" ]] && continue
    process_dump_file "$f" && (( n++ )) || true
  done
  log "Built $n service cookie folder(s) under $OUT_DIR/"
  print -r -- "---- service folders ----"
  setopt NULL_GLOB 2>/dev/null || true
  ls -lad "$OUT_DIR"/*/ 2>/dev/null || true
}

# Watch userdata dumps; on change → overwrite j2team files
watch_dumps() {
  set +x 2>/dev/null || true
  need python3
  ensure_out
  local j2team_dir="${J2TEAM_OUT_DIR:-}"
  [[ -n "$j2team_dir" ]] && export J2TEAM_OUT_DIR="$j2team_dir"
  log "Watching $USERDATA/cookies-dump-*.json"
  log "On each service open → overwrite $OUT_DIR/ (project cookies/)"
  [[ -n "$j2team_dir" ]] && log "Also copy → $j2team_dir"
  log "Ctrl+C to stop"

  # seed: process existing dumps once
  local f
  for f in "$USERDATA"/cookies-dump-*.json(N); do
    process_dump_file "$f" || true
  done

  # poll mtimes (portable, no fswatch required)
  typeset -A seen
  while true; do
    for f in "$USERDATA"/cookies-dump-*.json(N); do
      local _mt _sz _key
      _mt=$(stat -f %m "$f" 2>/dev/null || print 0)
      _sz=$(stat -f %z "$f" 2>/dev/null || print 0)
      _key="${_mt}:${_sz}"
      if [[ "${seen[$f]:-}" != "$_key" ]]; then
        seen[$f]="$_key"
        sleep 0.3
        process_dump_file "$f" || true
      fi
    done
    if [[ -f "$USERDATA/COOKIE_DUMP_LATEST.txt" ]]; then
      local latest
      latest=$(sed -n '2p' "$USERDATA/COOKIE_DUMP_LATEST.txt" 2>/dev/null)
      if [[ -n "$latest" && -f "$latest" ]]; then
        _mt=$(stat -f %m "$latest" 2>/dev/null || print 0)
        _sz=$(stat -f %z "$latest" 2>/dev/null || print 0)
        _key="${_mt}:${_sz}"
        if [[ "${seen[$latest]:-}" != "$_key" ]]; then
          seen[$latest]="$_key"
          process_dump_file "$latest" || true
        fi
      fi
    fi
    sleep 1
  done
}

install_hook_and_restart() {
  inject_dump_hook
  log "Restart CentriX to load hook…"
  # kill without self-match
  pgrep -x wineserver | while read p; do kill "$p" 2>/dev/null; done
  ps -axo pid=,comm= | while read -r pid comm; do
    case "$comm" in
      *CentriX*|*centrix*) kill "$pid" 2>/dev/null || true ;;
    esac
  done
  sleep 2
  export WINEPREFIX WINEDEBUG="-all" LIBGL_ALWAYS_SOFTWARE=1
  local exe="$APP_DIR/CentriX App User.exe"
  nohup "$WINE" explorer /desktop=CentriX,1440x900 "$exe" \
    --disable-gpu --disable-gpu-compositing --no-sandbox \
    >/tmp/centrix-wine-run.log 2>&1 &
  log "CentriX restarted (pid $!). Mở service → cookie files tự ghi đè."
  log "Chạy song song: $SCRIPT_NAME watch"
}

wait_for_dumps() {
  local timeout="${1:-180}"
  local i=0
  log "Waiting up to ${timeout}s for cookie dumps in userData…"
  log "→ In CentriX: open (or re-open) the service (e.g. ChatGPT) so the hook fires."
  while (( i < timeout )); do
    local found=()
    found=("$USERDATA"/cookies-dump-*.json(N))
    if (( ${#found} > 0 )); then
      local f
      for f in "${found[@]}"; do
        # skip empty arrays?
        local n
        n=$(python3 -c "import json;d=json.load(open('$f'));print(len(d.get('cookies',d) if isinstance(d,dict) else d))" 2>/dev/null || echo 0)
        if (( n > 0 )); then
          log "Found $f ($n cookies)"
          print -r -- "$f"
          return 0
        fi
      done
    fi
    sleep 2
    (( i += 2 ))
    (( i % 20 == 0 )) && log "…still waiting (${i}s) — re-click the service in CentriX"
  done
  return 1
}

dump_live() {
  ensure_out
  # Keep hook after dump (overwrite-on-open is the desired behavior)
  inject_dump_hook

  log "Restart CentriX so the hook loads…"
  pgrep -x wineserver | while read p; do kill "$p" 2>/dev/null; done
  ps -axo pid=,comm= | while read -r pid comm; do
    case "$comm" in
      *CentriX*|*centrix*) kill "$pid" 2>/dev/null || true ;;
    esac
  done
  sleep 2
  export WINEPREFIX WINEDEBUG="-all" LIBGL_ALWAYS_SOFTWARE="${LIBGL_ALWAYS_SOFTWARE:-1}"
  local exe="$APP_DIR/CentriX App User.exe"
  nohup "$WINE" explorer /desktop=CentriX,1440x900 "$exe" \
    --disable-gpu --disable-gpu-compositing --no-sandbox \
    >/tmp/centrix-cookie-export-run.log 2>&1 &
  log "CentriX launching (pid $!) — open a service to dump+overwrite cookies."

  local dump
  if ! dump=$(wait_for_dumps 180); then
    die "No cookie dump. Open a service in CentriX, or check /tmp/centrix-cookie-export-run.log"
  fi

  local f
  for f in "$USERDATA"/cookies-dump-*.json(N); do
    if [[ -n "$service_filter" && "$f" != *"${service_filter}"* ]]; then
      continue
    fi
    process_dump_file "$f" || true
  done

  log "Done. Hook stays installed — mỗi lần mở service sẽ ghi đè dump."
  log "Auto J2TEAM: $SCRIPT_NAME watch"
  log "Files: $OUT_DIR"
  ls -la "$OUT_DIR" | tail -20
}

import_help() {
  cat <<EOF

=== Import cookies onto this Mac ===

Output folder: $OUT_DIR

1) curl / scripts (easiest test)
   curl -sS -b "$OUT_DIR/cookies-dump-chatgpt.cookies.txt" -L 'https://chatgpt.com/' -o /tmp/cg.html
   # or header file:
   # curl -sS -H "Cookie: \$(cat $OUT_DIR/cookie-header.chatgpt.com.txt)" -L 'https://chatgpt.com/'

2) Chrome / Edge / Brave — Cookie-Editor extension
   - Install "Cookie-Editor" (or EditThisCookie)
   - Open https://chatgpt.com
   - Import → paste contents of:
       $OUT_DIR/*.cookie-editor.json

3) Manual
   - DevTools → Application → Cookies → add rows from the JSON

NOTES
   • Session cookies may expire quickly; pool slots may be rotated by CentriX server.
   • Exporting shared/pool logins may violate CentriX / OpenAI ToS — use only on accounts you own / are allowed to use.
   • Disk DB is usually empty; prefer dump-live.
   • Grok exports accounts.x.ai.json with .x.ai SSO cookies for device approval.
   • DeepSeek exports chat.deepseek.com.json for https://chat.deepseek.com/sign_in.

EOF
}

case "$mode" in
  dump-live|live|dump) dump_live ;;
  install-hook|install) install_hook_and_restart ;;
  watch|watch-dumps)   watch_dumps ;;
  uninstall-hook|uninstall) uninstall_hook ;;
  export-all|all|services) export_all_services ;;
  disk)                export_disk ;;
  convert)
    [[ -n "${2:-}" ]] || die "usage: $SCRIPT_NAME convert <dump.json>"
    convert_dump "$2" "${3:-}"
    if (( IMPORT_TO_CHROME )); then
      _convert_sid="${${2:t}#cookies-dump-}"
      _convert_sid="${_convert_sid%.json}"
      "$SCRIPT_DIR/import-cookies-to-chrome.sh" "$_convert_sid" --cookies-dir "$OUT_DIR"
    fi
    ;;
  import-help|help-import) import_help ;;
  -h|--help|help)
    sed -n '1,55p' "$SCRIPT_PATH"
    ;;
  *)
    die "unknown mode: $mode (dump-live|install-hook|watch|export-all|disk|convert|uninstall-hook|import-help)"
    ;;
esac
