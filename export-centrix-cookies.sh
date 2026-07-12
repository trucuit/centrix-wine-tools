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
#    → J2TEAM format {url, cookies[]}  + Netscape + Cookie-Editor ──
#
# J2TEAM / Cookie-Editor compatible fields (matches
# /Volumes/m2/Documents/centriq-cookies-injector/chatgpt.com.json):
#   domain, expirationDate, hostOnly, httpOnly, name, path,
#   sameSite, secure, session, storeId, value
#
convert_dump() {
  local src="$1"
  local force_url="${2:-}"
  [[ -f "$src" ]] || die "file not found: $src"
  ensure_out
  local base="${src:t:r}"
  # strip leading cookies-dump- for nicer names
  local nice="${base#cookies-dump-}"
  local service_out="$OUT_DIR/$nice"
  mkdir -p "$service_out"
  local netscape="$service_out/${base}.cookies.txt"
  local editor="$service_out/${base}.cookie-editor.json"
  local j2team="$service_out/${nice}.j2team.json"
  local curljar="$service_out/${base}.curl.txt"
  local j2team_dir="${J2TEAM_OUT_DIR:-}"

  python3 - "$src" "$netscape" "$editor" "$j2team" "$curljar" "$force_url" "$j2team_dir" <<'PY'
import json, os, sys, re
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime, timezone
from urllib.parse import urlparse

src, netscape_path, editor_path, j2team_path, curl_path, force_url, j2team_dir = sys.argv[1:8]
raw = json.loads(Path(src).read_text(encoding="utf-8"))

def write_private_text(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.chmod(path, 0o600)
    return path

def write_private_json(path: Path, obj):
    return write_private_text(path, json.dumps(obj, indent=2, ensure_ascii=False) + "\n")

# Normalize to list of Electron-like cookie dicts
cookies_in = []
url_hint = (force_url or "").strip()
if isinstance(raw, list):
    cookies_in = raw
elif isinstance(raw, dict):
    if isinstance(raw.get("cookies"), list):
        cookies_in = raw["cookies"]
        url_hint = url_hint or str(raw.get("url") or "")
    elif "name" in raw and ("domain" in raw or "host_key" in raw):
        cookies_in = [raw]
    else:
        for v in raw.values():
            if isinstance(v, list) and v and isinstance(v[0], dict) and "name" in v[0]:
                cookies_in.extend(v)

def host_of(c):
    return (c.get("domain") or c.get("host_key") or c.get("host") or "").strip()

def path_of(c):
    return c.get("path") or "/"

def exp_unix(c):
    # Electron: expirationDate (sec). Chromium SQLite: expires_utc (chrome epoch µs)
    if c.get("expirationDate") is not None:
        try:
            v = float(c["expirationDate"])
            # if ms-ish, compress
            if v > 1e12:
                v = v / 1000.0
            return int(v)
        except Exception:
            pass
    if c.get("expires") is not None:
        try:
            return int(float(c["expires"]))
        except Exception:
            pass
    if c.get("expires_utc") is not None:
        try:
            v = int(c["expires_utc"])
            if v <= 0:
                return 0
            return int(v / 1_000_000 - 11644473600)
        except Exception:
            pass
    return 0

def same_site_of(c):
    raw = c.get("sameSite")
    if raw is None:
        raw = c.get("samesite")
    # Electron may use 0/1/2 or strings
    if isinstance(raw, int):
        return {0: "unspecified", 1: "no_restriction", 2: "lax", 3: "strict"}.get(raw, "unspecified")
    s = str(raw or "unspecified").strip().lower()
    mapping = {
        "no_restriction": "no_restriction",
        "none": "no_restriction",
        "lax": "lax",
        "strict": "strict",
        "unspecified": "unspecified",
        "no_restriction".lower(): "no_restriction",
    }
    if s in ("no_restriction", "none"):
        return "no_restriction"
    if s in mapping:
        return mapping[s]
    if s in ("lax", "strict", "unspecified"):
        return s
    return "unspecified"

def secure(c):
    return bool(c.get("secure") or c.get("is_secure"))

def httponly(c):
    return bool(c.get("httpOnly") or c.get("is_httponly"))

def to_j2team(c):
    domain = host_of(c)
    exp = exp_unix(c)
    host_only = bool(c.get("hostOnly")) if "hostOnly" in c else (not domain.startswith("."))
    session = bool(c.get("session")) if "session" in c else (exp <= 0)
    # j2team sample uses null-less expirationDate as number; session cookies often omit/0
    item = {
        "domain": domain,
        "expirationDate": exp if exp > 0 else 0,
        "hostOnly": host_only,
        "httpOnly": httponly(c),
        "name": c.get("name") or "",
        "path": path_of(c),
        "sameSite": same_site_of(c),
        "secure": secure(c),
        "session": session if exp <= 0 else False,
        "storeId": str(c.get("storeId") or "0"),
        "value": "" if c.get("value") is None else str(c.get("value")),
    }
    # Prefer null expiration for pure session cookies to match some importers
    if item["session"] and not exp:
        item["expirationDate"] = None
    return item

j2 = []
lines = [
    "# Netscape HTTP Cookie File",
    "# Generated by export-centrix-cookies.sh (j2team-compatible)",
    f"# source: {src}",
    "",
]
curl_pairs = []
by_reg = defaultdict(list)
domain_counter = Counter()

for c in cookies_in:
    domain = host_of(c)
    if not domain or c.get("value") is None and "value" not in c:
        # still allow empty string values
        if "value" not in c and c.get("value") is None:
            # skip encrypted-only blobs with no plaintext
            if c.get("encrypted_value") and not c.get("value"):
                continue
    if not domain:
        continue
    name = c.get("name") or ""
    if not name:
        continue
    item = to_j2team(c)
    # if value missing skip
    if item["value"] is None:
        continue
    j2.append(item)
    domain_counter[domain] += 1

    exp = item["expirationDate"] or 0
    sec = "TRUE" if item["secure"] else "FALSE"
    flag = "TRUE" if domain.startswith(".") else "FALSE"
    lines.append("\t".join([
        domain, flag, item["path"], sec, str(int(exp) if exp else 0),
        item["name"], item["value"]
    ]))
    curl_pairs.append(f"{item['name']}={item['value']}")

    d = domain.lstrip(".")
    parts = d.split(".")
    reg = ".".join(parts[-2:]) if len(parts) >= 2 else d
    by_reg[reg].append(f"{item['name']}={item['value']}")

# Infer primary URL for j2team wrapper (like chatgpt.com.json)
if not url_hint:
    # prefer registrable domain with most cookies
    if by_reg:
        top = max(by_reg.items(), key=lambda kv: len(kv[1]))[0]
        url_hint = f"https://{top}"
    else:
        url_hint = "https://chatgpt.com"
if not url_hint.startswith("http"):
    url_hint = "https://" + url_hint.lstrip("/")
# normalize trailing path lightly
try:
    u = urlparse(url_hint)
    url_hint = f"{u.scheme}://{u.netloc}"
except Exception:
    pass

# Map service dump names → canonical url
stem = Path(src).stem.lower()
if "claude" in stem and "claude" not in url_hint:
    url_hint = "https://claude.ai"
elif "chatgpt" in stem or stem.endswith("chatgpt"):
    url_hint = "https://chatgpt.com"
elif "gemini" in stem:
    url_hint = "https://gemini.google.com"
elif "grok" in stem:
    url_hint = "https://grok.com"
elif "perplexity" in stem:
    url_hint = "https://www.perplexity.ai"

# Prefer service meta from dump payload (hook writes serviceId/url)
svc_id = ""
svc_name = ""
if isinstance(raw, dict):
    svc_id = str(raw.get("serviceId") or "").strip()
    svc_name = str(raw.get("serviceName") or "").strip()
    if raw.get("url") and not force_url:
        url_hint = str(raw.get("url") or url_hint)
if not svc_id:
    svc_id = Path(src).stem.replace("cookies-dump-", "").strip() or "unknown"
# sanitize filename
svc_slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", svc_id).strip("-").lower() or "unknown"

host = (urlparse(url_hint).hostname or "").lower()
service_cookies = [
    c for c in j2
    if host and (
        c["domain"].lstrip(".").lower() == host
        or host.endswith("." + c["domain"].lstrip(".").lower())
    )
]

j2team_obj = {
    "url": url_hint,
    "serviceId": svc_id,
    "serviceName": svc_name or svc_id,
    "exportedAt": (raw.get("exportedAt") if isinstance(raw, dict) else None) or datetime.now(timezone.utc).isoformat(),
    "cookies": service_cookies,
}

scoped_lines = [
    "# Netscape HTTP Cookie File",
    "# Generated by export-centrix-cookies.sh (service-scoped)",
    f"# source: {src}",
    "",
]
scoped_curl_pairs = []
for item in service_cookies:
    domain = item["domain"]
    scoped_lines.append("\t".join([
        domain,
        "TRUE" if domain.startswith(".") else "FALSE",
        item["path"],
        "TRUE" if item["secure"] else "FALSE",
        str(int(item["expirationDate"]) if item["expirationDate"] else 0),
        item["name"],
        item["value"],
    ]))
    scoped_curl_pairs.append(f"{item['name']}={item['value']}")

write_private_text(Path(netscape_path), "\n".join(scoped_lines) + "\n")
write_private_json(Path(editor_path), service_cookies)
write_private_json(Path(j2team_path), j2team_obj)
write_private_text(Path(curl_path), "; ".join(scoped_curl_pairs) + "\n")

out_dir = Path(netscape_path).parent
service_dir = out_dir

# 1) PRIMARY: one JSON per SERVICE (overwrite) — J2TEAM-compatible + meta
service_file = service_dir / f"{svc_slug}.json"
# bare j2team shape for extension (url+cookies only) + keep meta sibling
j2team_bare = {"url": url_hint, "cookies": service_cookies}
write_private_json(service_file, j2team_bare)
full_meta = dict(j2team_obj)
full_meta["cookies"] = j2
write_private_json(service_dir / f"{svc_slug}.full.json", full_meta)

# 2) Per-domain files for the selected service only.
scoped_by_reg = defaultdict(list)
for c in service_cookies:
    normalized = c["domain"].lstrip(".").lower()
    parts = normalized.split(".")
    reg = ".".join(parts[-2:]) if len(parts) >= 2 else normalized
    scoped_by_reg[reg].append(c)

for reg, host_cookies in scoped_by_reg.items():
    pairs = [f"{c['name']}={c['value']}" for c in host_cookies]
    write_private_text(out_dir / f"cookie-header.{reg}.txt", "; ".join(pairs) + "\n")
    write_private_json(out_dir / f"{reg}.json", {"url": f"https://{reg}", "cookies": host_cookies})

# ChatGPT authentication lives on a separate OpenAI host.
is_chatgpt = svc_slug in ("chatgpt", "notebooklm") or "chatgpt" in url_hint.lower()
auth_openai_cookies = [
    c for c in j2
    if c["domain"].lstrip(".").lower() == "auth.openai.com"
]
if is_chatgpt and auth_openai_cookies:
    write_private_json(
        out_dir / "auth.openai.com.json",
        {"url": "https://auth.openai.com/log-in", "cookies": auth_openai_cookies},
    )

# Grok authentication lives on a separate x.ai host.
is_grok = "grok" in svc_slug or "grok" in url_hint.lower()
accounts_xai_cookies = [
    c for c in j2
    if c["domain"].lstrip(".").lower() in ("x.ai", "accounts.x.ai")
]
if is_grok and accounts_xai_cookies:
    accounts_xai = {"url": "https://accounts.x.ai/sign-in", "cookies": accounts_xai_cookies}
    write_private_json(out_dir / "accounts.x.ai.json", accounts_xai)

# DeepSeek authentication is scoped to chat.deepseek.com and its parent domain.
is_deepseek = "deepseek" in svc_slug or "deepseek" in url_hint.lower()
deepseek_signin_cookies = [
    c for c in j2
    if c["domain"].lstrip(".").lower() in ("deepseek.com", "chat.deepseek.com")
]
if is_deepseek and deepseek_signin_cookies:
    deepseek_signin = {"url": "https://chat.deepseek.com/sign_in", "cookies": deepseek_signin_cookies}
    write_private_json(out_dir / "chat.deepseek.com.json", deepseek_signin)

deepseek_storage_keys = (
    "userToken",
    "settingsJwt",
    "__appKit_@deepseek/chat_lastSessionValue",
)
deepseek_local_storage = {}
if is_deepseek and isinstance(raw, dict) and isinstance(raw.get("localStorage"), dict):
    deepseek_local_storage = {
        key: raw["localStorage"][key]
        for key in deepseek_storage_keys
        if isinstance(raw["localStorage"].get(key), str) and raw["localStorage"][key]
    }
if deepseek_local_storage:
    write_private_json(
        out_dir / "deepseek.storage.json",
        {"url": "https://chat.deepseek.com", "localStorage": deepseek_local_storage},
    )

# 3) Copy into centriq-cookies-injector
# Optional external injector dir (only if J2TEAM_OUT_DIR set and exists)
if j2team_dir:
    jdir = Path(j2team_dir)
    if jdir.is_dir():
        write_private_json(jdir / f"{svc_slug}.json", j2team_bare)
        if "chatgpt" in svc_slug or svc_slug in ("notebooklm",):
            chatgpt_cookies = [
                c for c in j2
                if "chatgpt.com" in c["domain"].lower()
                or (
                    c["domain"].lower().endswith("openai.com")
                    and "auth.openai.com" not in c["domain"].lower()
                    and "sentinel.openai.com" not in c["domain"].lower()
                )
            ]
            if chatgpt_cookies:
                write_private_json(
                    jdir / "chatgpt.com.json",
                    {"url": "https://chatgpt.com", "cookies": chatgpt_cookies},
                )
            if auth_openai_cookies:
                write_private_json(
                    jdir / "auth.openai.com.json",
                    {"url": "https://auth.openai.com/log-in", "cookies": auth_openai_cookies},
                )
        if "claude" in svc_slug:
            claude_cookies = [
                c for c in j2
                if c["domain"].lstrip(".").lower().endswith("claude.ai")
                or c["domain"].lstrip(".").lower().endswith("anthropic.com")
            ]
            if claude_cookies:
                write_private_json(
                    jdir / "claude.ai.json",
                    {"url": "https://claude.ai", "cookies": claude_cookies},
                )
        if is_grok and accounts_xai_cookies:
            write_private_json(
                jdir / "accounts.x.ai.json",
                {"url": "https://accounts.x.ai/sign-in", "cookies": accounts_xai_cookies},
            )
        if is_deepseek and deepseek_signin_cookies:
            write_private_json(
                jdir / "chat.deepseek.com.json",
                {"url": "https://chat.deepseek.com/sign_in", "cookies": deepseek_signin_cookies},
            )
        cdir = jdir / "centrix"
        if cdir.is_dir():
            write_private_json(cdir / f"{svc_slug}.json", j2team_bare)
            aliases = {
                "chatgpt": ["chatgpt.json", "chatgpt.pro.json"],
                "notebooklm": ["chatgpt.gpt55-pro.json", "gpt-5.5-pro.json"],
                "claude": ["claude.json", "claude.max.json"],
                "gemini": ["gemini.json"],
                "perplexity": ["perplexity.json"],
                "envato-elements": ["envato.json", "envato-elements.json"],
            }
            for key, names in aliases.items():
                if key in svc_slug or svc_slug == key:
                    for name in names:
                        write_private_json(cdir / name, j2team_bare)
            if is_grok and accounts_xai_cookies:
                write_private_json(
                    cdir / "accounts.x.ai.json",
                    {"url": "https://accounts.x.ai/sign-in", "cookies": accounts_xai_cookies},
                )
            if is_deepseek and deepseek_signin_cookies:
                write_private_json(
                    cdir / "chat.deepseek.com.json",
                    {"url": "https://chat.deepseek.com/sign_in", "cookies": deepseek_signin_cookies},
                )

print(f"cookies={len(j2)}")
print(f"service_cookies={len(service_cookies)}")
print(f"service={svc_slug}")
print(f"serviceFile={service_file}")
print(f"url={url_hint}")
print(f"j2team={j2team_path}")
print(f"editor={editor_path}")
print(f"netscape={netscape_path}")
print(f"domains={','.join(sorted(by_reg))}")
print(f"top={domain_counter.most_common(5)}")
if is_grok:
    print(f"accounts_xai_cookies={len(accounts_xai_cookies)}")
if is_chatgpt:
    print(f"auth_openai_cookies={len(auth_openai_cookies)}")
if is_deepseek:
    print(f"deepseek_signin_cookies={len(deepseek_signin_cookies)}")
    print(f"deepseek_local_storage_keys={len(deepseek_local_storage)}")
PY

  log "OUT_DIR=$OUT_DIR"
  log "Service folder: $OUT_DIR/<serviceId>/"
  log "J2TEAM service-scoped: $j2team"
  log "Domain files: $OUT_DIR/*.com.json etc."
  log "Cookie-Editor array: $editor"
  log "Netscape: $netscape"
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
