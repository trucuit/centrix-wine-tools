#!/usr/bin/env zsh
# export-centrix-cookies.sh
# Export cookies from CentriX App User (Wine) → files on Mac for curl / Cookie-Editor / browser.
#
# Shared write pattern: scripts/lib/centrix-export-common.sh
#   → scripts/lib/centrix_cookie_export.py --sidecars
# (same as export-pick-service.sh + export-centrix-api.sh)
#
# WHY NOT just read Cookies SQLite?
#   ChatGPT/Claude sessions live in a RAM-only Electron partition (tgbyhnujmik-*).
#   Disk DB .../mkvhszparoue/Network/Cookies is usually EMPTY for those services.
#
# Modes:
#   dump-live   (default)  Patch app once → you open service → dump JSON → convert
#   install-hook           Keep dump hook forever: every service-open overwrites cookie files
#   watch                  Watch dumps + convert/overwrite on each service open
#   disk                   Export whatever is already in Cookies SQLite (often empty)
#   convert                Convert a dump JSON / profile snapshot
#   uninstall-hook         Remove hook + restore asar.bak if present
#   export-all             Convert all dumps under userData
#   import-help            Print how to load files into Mac Chrome/Safari/curl
#
# Usage:
#   ./export-centrix-cookies.sh install-hook
#   ./export-centrix-cookies.sh watch
#   ./export-centrix-cookies.sh dump-live chatgpt
#   ./export-centrix-cookies.sh convert /path/to/cookies-dump-chatgpt.json
#   ./export-centrix-cookies.sh export-all --chrome
#
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
SCRIPT_NAME="${SCRIPT_PATH:t}"

source "$SCRIPT_DIR/scripts/lib/centrix-export-common.sh"
centrix_export_init
centrix_parse_shared_flags "$@"
set -- "${CENTRIX_POS_ARGS[@]}"

mode="${1:-dump-live}"
service_filter="${2:-${SERVICE:-}}"

# ── Disk SQLite (usually empty for ChatGPT pool) ──
export_disk() {
  need sqlite3
  need_python
  ensure_out
  local db="$USERDATA/Network/Cookies"
  [[ -f "$db" ]] || die "Cookies DB not found: $db"

  local copy="$OUT_DIR/Cookies.copy.db"
  cp -f "$db" "$copy" 2>/dev/null || cp -f "$db" "$copy"
  chmod 600 "$copy"
  if [[ -f "${db}-journal" ]]; then
    cp -f "${db}-journal" "$OUT_DIR/" 2>/dev/null || true
    [[ -f "$OUT_DIR/Cookies-journal" ]] && chmod 600 "$OUT_DIR/Cookies-journal"
  fi

  local json="$OUT_DIR/cookies-dump-disk.json"
  "$PYTHON" - "$copy" "$json" <<'PY'
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
  n=$("$PYTHON" -c "import json;print(len(json.load(open('$json'))))")
  log "Disk cookies: $n → $json"
  if (( n == 0 )); then
    log "EMPTY — ChatGPT cookies are RAM-only. Use: $SCRIPT_NAME dump-live chatgpt"
    return 0
  fi
  convert_dump "$json" "" "disk-export"
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
      const __base = `cookies-dump-${__sid}.json`;
      const out = __path.join(__ud, __base);
      const tmp = out + ".tmp";
      __fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      __fs.renameSync(tmp, out);
      try { __fs.chmodSync(out, 0o600); } catch (_) {}
      // Marker: serviceId + basename only (Mac watch; avoid Wine C:\\ paths)
      try {
        __fs.writeFileSync(
          __path.join(__ud, "COOKIE_DUMP_LATEST.txt"),
          `${__sid}\n${__base}\n${(list || []).length}\n`,
          { mode: 0o600 }
        );
      } catch (_) {}
      writeUserRuntimeLog("cookie-export-dump", { serviceId: __sid, serviceName: __sname, count: (list || []).length, out: __base, overwrite: true });
    })
    .catch((e) => writeUserRuntimeLog("cookie-export-fail", { serviceId: __sid, error: String(e && e.message || e) }));
} catch (e) { /* never break openService */ }
// --- END CENTRIX_COOKIE_EXPORT_HOOK ---
'

inject_dump_hook() {
  need npx
  need_python
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
  HOOK_JS="$HOOK_JS" "$PYTHON" - "$main" <<'PY'
from pathlib import Path
import os, re, sys

main = Path(sys.argv[1])
text = main.read_text(encoding="utf-8")
hook = os.environ["HOOK_JS"]

text = re.sub(
    r"\n// --- CENTRIX_COOKIE_EXPORT_HOOK.*?// --- END CENTRIX_COOKIE_EXPORT_HOOK ---\n?",
    "\n",
    text,
    flags=re.S,
)

m = re.search(
    r'writeUserRuntimeLog\(\s*"service-open-ready"\s*,\s*\{.*?\n\s*\}\)\s*;',
    text,
    flags=re.S,
)
if not m:
    raise SystemExit("could not find service-open-ready log site to inject")

insert_at = m.end()
text = text[:insert_at] + "\n" + hook + text[insert_at:]
main.write_text(text, encoding="utf-8")
print(f"hook installed at offset {insert_at} (always overwrite on service open)")
PY

  log "Repack asar…"
  npx --yes @electron/asar pack "$TMP_ASAR" "$ASAR"
  rm -rf "$TMP_ASAR"
  mkdir -p "$USERDATA"
  : > "$USERDATA/$MARKER_NAME"
  if [[ -f "$USERDATA/COOKIE_DUMP_LATEST.txt" ]]; then
    local _sid _line2 _n _resolved
    _sid=$(sed -n '1p' "$USERDATA/COOKIE_DUMP_LATEST.txt" 2>/dev/null || true)
    _line2=$(sed -n '2p' "$USERDATA/COOKIE_DUMP_LATEST.txt" 2>/dev/null || true)
    _n=$(sed -n '3p' "$USERDATA/COOKIE_DUMP_LATEST.txt" 2>/dev/null || true)
    if [[ -n "$_sid" ]]; then
      _resolved=$(resolve_dump_path "$_line2" 2>/dev/null || true)
      if [[ -n "$_resolved" ]]; then
        print -r -- "${_sid}"$'\n'"${_resolved:t}"$'\n'"${_n:-0}" > "$USERDATA/COOKIE_DUMP_LATEST.txt"
      else
        print -r -- "${_sid}"$'\n'"cookies-dump-${_sid}.json"$'\n'"${_n:-0}" > "$USERDATA/COOKIE_DUMP_LATEST.txt"
      fi
    fi
  fi
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

export_all_services() {
  ensure_out
  local n=0 f base
  for f in "$USERDATA"/cookies-dump-*.json(N); do
    [[ -f "$f" ]] || continue
    base="${f:t}"
    [[ "$base" == *cookie-editor* ]] && continue
    [[ "$base" == "cookies-dump-disk.json" ]] && continue
    process_dump_file "$f" "hook-export" && (( n++ )) || true
  done
  log "Built $n service cookie folder(s) under $OUT_DIR/"
  print -r -- "---- service folders ----"
  ls -lad "$OUT_DIR"/*/ 2>/dev/null || true
}

watch_dumps() {
  set +x 2>/dev/null || true
  setopt localoptions noxtrace 2>/dev/null || true
  need_python
  ensure_out
  [[ -d "$USERDATA" ]] || die "userData not found: $USERDATA (run CentriX once first)"
  local j2team_dir="${J2TEAM_OUT_DIR:-}"
  [[ -n "$j2team_dir" ]] && export J2TEAM_OUT_DIR="$j2team_dir"
  log "Watching $USERDATA/cookies-dump-*.json"
  log "On each service open → overwrite $OUT_DIR/ (project cookies/)"
  [[ -n "$j2team_dir" ]] && log "Also copy → $j2team_dir"
  if [[ ! -f "$ASAR_BAK" ]]; then
    log "NOTE: hook not installed (no asar.bak). New dumps need: $SCRIPT_NAME install-hook"
  fi
  log "Ctrl+C to stop"

  typeset -A seen
  local f _mt _sz _key latest_raw latest

  for f in "$USERDATA"/cookies-dump-*.json(N); do
    _mt=$(stat -f %m "$f" 2>/dev/null || print 0)
    _sz=$(stat -f %z "$f" 2>/dev/null || print 0)
    seen[$f]="${_mt}:${_sz}"
    process_dump_file "$f" "hook-export" || true
  done

  while true; do
    for f in "$USERDATA"/cookies-dump-*.json(N); do
      _mt=$(stat -f %m "$f" 2>/dev/null || print 0)
      _sz=$(stat -f %z "$f" 2>/dev/null || print 0)
      _key="${_mt}:${_sz}"
      if [[ "${seen[$f]:-}" != "$_key" ]]; then
        seen[$f]="$_key"
        sleep 0.3
        process_dump_file "$f" "hook-export" || true
      fi
    done
    if [[ -f "$USERDATA/COOKIE_DUMP_LATEST.txt" ]]; then
      latest_raw=$(sed -n '2p' "$USERDATA/COOKIE_DUMP_LATEST.txt" 2>/dev/null)
      [[ -z "$latest_raw" ]] && latest_raw=$(sed -n '1p' "$USERDATA/COOKIE_DUMP_LATEST.txt" 2>/dev/null)
      latest=$(resolve_dump_path "$latest_raw" 2>/dev/null || true)
      if [[ -n "$latest" && -f "$latest" ]]; then
        _mt=$(stat -f %m "$latest" 2>/dev/null || print 0)
        _sz=$(stat -f %z "$latest" 2>/dev/null || print 0)
        _key="${_mt}:${_sz}"
        if [[ "${seen[$latest]:-}" != "$_key" ]]; then
          seen[$latest]="$_key"
          process_dump_file "$latest" "hook-export" || true
        fi
      fi
    fi
    sleep 1
  done
}

install_hook_and_restart() {
  inject_dump_hook
  log "Restart CentriX to load hook…"
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
  local since_epoch="${2:-0}"
  local i=0
  log "Waiting up to ${timeout}s for fresh cookie dumps in userData…"
  log "→ In CentriX: open (or re-open) the service so the hook fires."
  while (( i < timeout )); do
    local found=()
    found=("$USERDATA"/cookies-dump-*.json(N))
    if (( ${#found} > 0 )); then
      local f _mt n
      for f in "${found[@]}"; do
        if [[ -n "$service_filter" && "$f" != *"${service_filter}"* ]]; then
          continue
        fi
        _mt=$(stat -f %m "$f" 2>/dev/null || print 0)
        (( _mt < since_epoch )) && continue
        n=$("$PYTHON" -c "import json;d=json.load(open('$f'));print(len(d.get('cookies',d) if isinstance(d,dict) else d))" 2>/dev/null || echo 0)
        if (( n > 0 )); then
          log "Found $f ($n cookies, mtime=${_mt})"
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
  local wait_since
  wait_since=$(date +%s)
  nohup "$WINE" explorer /desktop=CentriX,1440x900 "$exe" \
    --disable-gpu --disable-gpu-compositing --no-sandbox \
    >/tmp/centrix-cookie-export-run.log 2>&1 &
  log "CentriX launching (pid $!) — open a service to dump+overwrite cookies."

  local dump
  if ! dump=$(wait_for_dumps 180 "$wait_since"); then
    die "No fresh cookie dump. Open a service in CentriX, or check /tmp/centrix-cookie-export-run.log"
  fi

  local f _mt
  for f in "$USERDATA"/cookies-dump-*.json(N); do
    if [[ -n "$service_filter" && "$f" != *"${service_filter}"* ]]; then
      continue
    fi
    _mt=$(stat -f %m "$f" 2>/dev/null || print 0)
    (( _mt < wait_since )) && continue
    process_dump_file "$f" "hook-export" || true
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
Shared pattern: scripts/lib/centrix_cookie_export.py (+sidecars)

1) curl
   curl -sS -b "$OUT_DIR/<service>/cookies-dump-*.cookies.txt" -L 'https://…'

2) Chrome — Cookie-Editor or:
   ./import-cookies-to-chrome.sh <service>
   ./export-centrix-cookies.sh export-all --chrome

3) Related CLIs (same pattern)
   ./export-pick-service.sh <service>
   ./export-centrix-api.sh export <service>

NOTES
   • Disk DB is usually empty; prefer dump-live / install-hook + watch.
   • Session cookies may expire; pool slots may rotate.

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
    convert_dump "$2" "${3:-}" "convert"
    if (( IMPORT_TO_CHROME )); then
      _convert_sid="${${2:t}#cookies-dump-}"
      _convert_sid="${_convert_sid%.json}"
      import_cookies_to_chrome "$_convert_sid" || true
    fi
    ;;
  import-help|help-import) import_help ;;
  -h|--help|help)
    sed -n '1,40p' "$SCRIPT_PATH"
    ;;
  *)
    die "unknown mode: $mode (dump-live|install-hook|watch|export-all|disk|convert|uninstall-hook|import-help)"
    ;;
esac
