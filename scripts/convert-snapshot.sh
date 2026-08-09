#!/usr/bin/env bash
# convert-snapshot.sh
# Offline convert CentriX pool snapshot(s) → Cookie-Editor + optional BE-shaped full/export.
# Clone/generalization of cookies/claude/convert-claude-1-to-claude-ai.sh
#
# Aligns with BE GET /api/profile/export?service=<id> (PROFILE_FROM_DB):
#   decrypt(AT_REST) → cookieScope.scopeSnapshotToServices([svc]) → editor + sidecars
#
# Usage:
#   ./scripts/convert-snapshot.sh                  # interactive pick
#   ./scripts/convert-snapshot.sh claude           # all claude-*.json under cookies/claude/
#   ./scripts/convert-snapshot.sh claude-1         # one profile
#   ./scripts/convert-snapshot.sh claude-1 --full  # + .full.json + .export.json
#   ./scripts/convert-snapshot.sh --all            # every pool snapshot under cookies/
#   ./scripts/convert-snapshot.sh --all --full
#   ./scripts/convert-snapshot.sh --list
#
# Env:
#   CENTRIX_SNAPSHOT_AT_REST_KEY   or centrix-backend/.env
#   INCLUDE_STORAGE=0              strip storage (BE includeStorage=0)
#   WRITE_FULL=1|0                 default 0; --full sets 1
#   CENTRIX_COOKIES_DIR            default <repo>/cookies
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COOKIES_DIR="${CENTRIX_COOKIES_DIR:-$REPO_ROOT/cookies}"
BACKEND_DIR="${CENTRIX_BACKEND_DIR:-$REPO_ROOT/centrix-backend}"
SHARED="$BACKEND_DIR/shared"
PROFILE_CRYPTO="$SHARED/profile-crypto.js"
COOKIE_SCOPE="$SHARED/cookie-scope.js"
ENV_FILE="${CENTRIX_ENV_FILE:-$BACKEND_DIR/.env}"

INCLUDE_STORAGE="${INCLUDE_STORAGE:-1}"
WRITE_FULL="${WRITE_FULL:-0}"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "$*" >&2; }

# ── flags / args ────────────────────────────────────────────────────────────
ALL=0
LIST=0
TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full|-f) WRITE_FULL=1; shift ;;
    --no-full) WRITE_FULL=0; shift ;;
    --all|-a) ALL=1; shift ;;
    --list|-l) LIST=1; shift ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    --) shift; break ;;
    -*) die "unknown flag: $1" ;;
    *) TARGETS+=("$1"); shift ;;
  esac
done

# ── discover pool snapshots: cookies/<svc>/<svc>-N.json ─────────────────────
# Match files that look like CentriX records (contain "blob") later; discover by name.
discover_snapshots() {
  find "$COOKIES_DIR" -mindepth 2 -maxdepth 2 -type f -name '*-*.json' \
    ! -name '*.bak.*' \
    ! -name '*.full.json' \
    ! -name '*.export.json' \
    ! -name '*.j2team.json' \
    ! -name 'cookies-dump-*' \
    2>/dev/null | sort
}

is_pool_snapshot() {
  # quick check: top-level has "blob"
  python3 - "$1" <<'PY' 2>/dev/null
import json,sys
try:
  d=json.load(open(sys.argv[1]))
  sys.exit(0 if isinstance(d,dict) and "blob" in d else 1)
except Exception:
  sys.exit(1)
PY
}

# service id from profile file name: claude-1.json → claude, grok-heavy-1.json → grok-heavy
service_from_profile() {
  local base="$1"
  base="${base%.json}"
  if [[ "$base" =~ ^(.+)-[0-9]+$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "$base"
  fi
}

# Host-scoped editor filename (matches existing cookies/* conventions)
host_json_name() {
  local svc="$1"
  case "$svc" in
    claude) echo "claude.ai.json" ;;
    chatgpt) echo "chatgpt.com.json" ;;
    gemini) echo "gemini.google.com.json" ;;
    deepseek) echo "chat.deepseek.com.json" ;;
    perplexity) echo "perplexity.ai.json" ;;
    notebooklm) echo "chatgpt.com.json" ;;
    grok|grok-heavy) echo "grok.com.json" ;;
    canva) echo "canva.com.json" ;;
    microsoft-copilot) echo "copilot.microsoft.com.json" ;;
    poe) echo "poe.com.json" ;;
    gamma) echo "gamma.app.json" ;;
    monica) echo "monica.im.json" ;;
    envato-elements) echo "elements.envato.com.json" ;;
    semrush) echo "noxtools.com.json" ;;
    *) echo "${svc}.json" ;;
  esac
}

ALL_SNAPS=()
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  is_pool_snapshot "$p" && ALL_SNAPS+=("$p")
done < <(discover_snapshots)

if [[ ${#ALL_SNAPS[@]} -eq 0 ]]; then
  die "no pool snapshots found under $COOKIES_DIR (need *-<n>.json with blob)"
fi

if [[ "$LIST" -eq 1 ]]; then
  log "Pool snapshots under $COOKIES_DIR:"
  i=1
  for p in "${ALL_SNAPS[@]}"; do
    base="$(basename "$p")"
    svc="$(service_from_profile "$base")"
    sz="$(wc -c < "$p" | tr -d ' ')"
    printf '  %2d) %-22s  %8s B  %s\n' "$i" "$base" "$sz" "$p"
    i=$((i + 1))
  done
  exit 0
fi

# ── resolve selection → list of snapshot paths ──────────────────────────────
SELECTED=()

if [[ "$ALL" -eq 1 ]]; then
  SELECTED=("${ALL_SNAPS[@]}")
elif [[ ${#TARGETS[@]} -gt 0 ]]; then
  for t in "${TARGETS[@]}"; do
    if [[ -f "$t" ]]; then
      SELECTED+=("$(cd "$(dirname "$t")" && pwd)/$(basename "$t")")
      continue
    fi
    # bare profile or service
    name="${t%.json}"
    matched=0
    for p in "${ALL_SNAPS[@]}"; do
      base="$(basename "$p" .json)"
      svc="$(service_from_profile "$base.json")"
      if [[ "$base" == "$name" || "$svc" == "$name" || "$(basename "$p")" == "$t" ]]; then
        SELECTED+=("$p")
        matched=1
      fi
    done
    [[ "$matched" -eq 1 ]] || die "no snapshot matched: $t (try --list)"
  done
else
  # interactive
  if [[ ! -t 0 ]]; then
    die "no service selected (non-interactive). Pass name, --all, or run in a TTY."
  fi
  log "Select snapshot(s) to convert  (numbers, comma-separated; or service name; or 'all')"
  log "  f = toggle full sidecars (currently: WRITE_FULL=$WRITE_FULL)"
  log ""
  i=1
  for p in "${ALL_SNAPS[@]}"; do
    base="$(basename "$p")"
    sz="$(wc -c < "$p" | tr -d ' ')"
    printf '  %2d) %-22s  %8s B\n' "$i" "$base" "$sz"
    i=$((i + 1))
  done
  log ""
  read -r -p "Choice: " choice
  choice="$(echo "$choice" | tr -d '[:space:]')"
  [[ -n "$choice" ]] || die "empty choice"

  # allow "f" prefix or suffix to mean full
  if [[ "$choice" == *f* && "$choice" != all && ! "$choice" =~ ^[0-9,]+$ ]]; then
    :
  fi
  if [[ "$choice" == *",f" || "$choice" == "f,"* || "$choice" == f ]]; then
    WRITE_FULL=1
    choice="${choice//f/}"
    choice="${choice//,,/,}"
    choice="${choice#,}"
    choice="${choice%,}"
  fi
  if [[ "$choice" == *"--full"* ]]; then
    WRITE_FULL=1
    choice="${choice//--full/}"
  fi

  if [[ "$choice" == "all" || "$choice" == "a" || -z "$choice" && "$ALL" -eq 1 ]]; then
    SELECTED=("${ALL_SNAPS[@]}")
  elif [[ "$choice" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
    IFS=',' read -r -a nums <<< "$choice"
    for n in "${nums[@]}"; do
      [[ "$n" =~ ^[0-9]+$ ]] || die "bad index: $n"
      idx=$((n - 1))
      [[ "$idx" -ge 0 && "$idx" -lt ${#ALL_SNAPS[@]} ]] || die "index out of range: $n"
      SELECTED+=("${ALL_SNAPS[$idx]}")
    done
  else
    # service / profile name
    name="${choice%.json}"
    matched=0
    for p in "${ALL_SNAPS[@]}"; do
      base="$(basename "$p" .json)"
      svc="$(service_from_profile "$base.json")"
      if [[ "$base" == "$name" || "$svc" == "$name" ]]; then
        SELECTED+=("$p")
        matched=1
      fi
    done
    [[ "$matched" -eq 1 ]] || die "no snapshot matched: $choice"
  fi
fi

# de-dupe preserve order (bash 3.2-safe, no assoc arrays required)
UNIQ=()
for p in "${SELECTED[@]}"; do
  skip=0
  for u in "${UNIQ[@]+"${UNIQ[@]}"}"; do
    [[ "$u" == "$p" ]] && { skip=1; break; }
  done
  [[ "$skip" -eq 1 ]] || UNIQ+=("$p")
done
SELECTED=("${UNIQ[@]}")
[[ ${#SELECTED[@]} -gt 0 ]] || die "nothing selected"

# ── key + tools ─────────────────────────────────────────────────────────────
[[ -f "$PROFILE_CRYPTO" ]] || die "profile-crypto not found: $PROFILE_CRYPTO"
[[ -f "$COOKIE_SCOPE" ]] || die "cookie-scope not found: $COOKIE_SCOPE"
command -v node >/dev/null 2>&1 || die "node required"

if [[ -z "${CENTRIX_SNAPSHOT_AT_REST_KEY:-}" ]]; then
  [[ -f "$ENV_FILE" ]] || die "set CENTRIX_SNAPSHOT_AT_REST_KEY or provide $ENV_FILE"
  CENTRIX_SNAPSHOT_AT_REST_KEY="$(
    grep -E '^CENTRIX_SNAPSHOT_AT_REST_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-
  )"
fi
[[ -n "${CENTRIX_SNAPSHOT_AT_REST_KEY:-}" ]] || die "CENTRIX_SNAPSHOT_AT_REST_KEY empty"

export CENTRIX_SNAPSHOT_AT_REST_KEY PROFILE_CRYPTO COOKIE_SCOPE INCLUDE_STORAGE WRITE_FULL

log "==> convert ${#SELECTED[@]} snapshot(s)  full=$WRITE_FULL  includeStorage=$INCLUDE_STORAGE"

ok=0
fail=0

convert_one() {
  local in_path="$1"
  local base svc out_dir host_out
  base="$(basename "$in_path")"
  svc="$(service_from_profile "$base")"
  out_dir="$(dirname "$in_path")"
  host_out="$out_dir/$(host_json_name "$svc")"

  log "→ $base  (service=$svc)  →  $(basename "$host_out")${WRITE_FULL:+ + full/export}"

  IN="$in_path" OUT="$host_out" SERVICE_ID="$svc" \
  node <<'NODE'
"use strict";
const fs = require("fs");
const path = require("path");
const profileCrypto = require(process.env.PROFILE_CRYPTO);
const cookieScope = require(process.env.COOKIE_SCOPE);

// Mirrors shared/service-store.js (+ pool ids not in default list)
const DEFAULT_SERVICES = {
  chatgpt: {
    id: "chatgpt", name: "ChatGPT",
    url: "https://chatgpt.com/", loginUrl: "https://chatgpt.com/",
    cookieDomains: ["chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com"],
  },
  claude: {
    id: "claude", name: "Claude",
    url: "https://claude.ai/new", loginUrl: "https://claude.ai/new",
    cookieDomains: ["claude.ai", "anthropic.com"],
  },
  gemini: {
    id: "gemini", name: "Gemini",
    url: "https://gemini.google.com/", loginUrl: "https://gemini.google.com/",
    cookieDomains: ["gemini.google.com", "google.com"],
  },
  perplexity: {
    id: "perplexity", name: "Perplexity",
    url: "https://www.perplexity.ai/", loginUrl: "https://www.perplexity.ai/",
    cookieDomains: ["perplexity.ai"],
  },
  "microsoft-copilot": {
    id: "microsoft-copilot", name: "Microsoft Copilot",
    url: "https://copilot.microsoft.com/", loginUrl: "https://copilot.microsoft.com/",
    cookieDomains: ["copilot.microsoft.com", "microsoft.com"],
  },
  grok: {
    id: "grok", name: "Grok",
    url: "https://grok.com/", loginUrl: "https://grok.com/",
    cookieDomains: ["grok.com", "x.ai", "x.com"],
  },
  "grok-heavy": {
    id: "grok-heavy", name: "Grok Heavy",
    url: "https://grok.com/", loginUrl: "https://grok.com/",
    cookieDomains: ["grok.com", "x.ai", "x.com"],
  },
  deepseek: {
    id: "deepseek", name: "DeepSeek",
    url: "https://chat.deepseek.com/", loginUrl: "https://chat.deepseek.com/",
    cookieDomains: ["deepseek.com", "chat.deepseek.com"],
  },
  notebooklm: {
    id: "notebooklm", name: "GPT-5.5 Pro",
    url: "https://chatgpt.com/", loginUrl: "https://chatgpt.com/",
    cookieDomains: ["chatgpt.com", "openai.com", "notebooklm.google.com", "google.com"],
  },
  canva: {
    id: "canva", name: "Canva",
    url: "https://www.canva.com/", loginUrl: "https://www.canva.com/",
    cookieDomains: ["canva.com"],
  },
  poe: {
    id: "poe", name: "Poe",
    url: "https://poe.com/", loginUrl: "https://poe.com/",
    cookieDomains: ["poe.com"],
  },
  gamma: {
    id: "gamma", name: "Gamma",
    url: "https://gamma.app/", loginUrl: "https://gamma.app/",
    cookieDomains: ["gamma.app"],
  },
  monica: {
    id: "monica", name: "Monica",
    url: "https://monica.im/", loginUrl: "https://monica.im/",
    cookieDomains: ["monica.im"],
  },
  "envato-elements": {
    id: "envato-elements", name: "Envato Elements",
    url: "https://elements.envato.com/", loginUrl: "https://elements.envato.com/",
    cookieDomains: ["envato.com", "elements.envato.com"],
  },
  semrush: {
    id: "semrush", name: "SEMrush",
    url: "https://www.semrush.com/", loginUrl: "https://www.semrush.com/",
    cookieDomains: ["semrush.com", "noxtools.com"],
  },
};

const inPath = process.env.IN;
const outPath = process.env.OUT;
const serviceId = String(process.env.SERVICE_ID || "").trim();
const includeStorage = process.env.INCLUDE_STORAGE !== "0";
const writeFull = process.env.WRITE_FULL === "1";
const key = process.env.CENTRIX_SNAPSHOT_AT_REST_KEY;

let svc = DEFAULT_SERVICES[serviceId];
if (!svc) {
  // fallback: scope by filename service id with generic domains from id
  svc = {
    id: serviceId,
    name: serviceId,
    url: `https://${serviceId}.com/`,
    loginUrl: `https://${serviceId}.com/`,
    cookieDomains: [serviceId.replace(/-/g, ".")],
  };
  console.error(`warn: unknown service '${serviceId}' — using fallback cookieDomains=${JSON.stringify(svc.cookieDomains)}`);
}

const rec = JSON.parse(fs.readFileSync(inPath, "utf8"));
if (!rec || !rec.blob) {
  console.error("error: not a CentriX snapshot record (need { blob, revision, updatedAt })");
  process.exit(2);
}

let snapshot;
try {
  snapshot = profileCrypto.decryptSnapshot(rec.blob, key);
} catch (e) {
  console.error("error: decrypt failed:", e.message || e);
  process.exit(3);
}

// BE parity: scopeCookies for the granted service
snapshot = cookieScope.scopeSnapshotToServices(snapshot, [svc]);
if (!includeStorage) snapshot = { ...snapshot, storage: [] };
snapshot = { ...snapshot, uiRules: [] };

const revision = Number(rec.revision) || 0;
const assignedProfile = snapshot.profileId || path.basename(inPath, ".json") || serviceId;
const serviceUrl = svc.url || svc.loginUrl || "https://example.com/";

function cookieToEditor(c) {
  const domain = String(c.domain || c.host_key || "").trim();
  if (!domain || !c.name) return null;
  let exp = c.expirationDate;
  if (exp != null && exp !== "") {
    exp = Number(exp);
    if (Number.isFinite(exp) && exp > 1e12) exp = Math.floor(exp / 1000);
    else if (Number.isFinite(exp)) exp = Math.floor(exp);
    else exp = undefined;
  } else exp = undefined;
  let ss = c.sameSite != null ? c.sameSite : c.samesite;
  if (typeof ss === "number") {
    ss = { 0: "unspecified", 1: "no_restriction", 2: "lax", 3: "strict" }[ss] || "unspecified";
  }
  ss = String(ss || "unspecified").toLowerCase();
  if (ss === "none") ss = "no_restriction";
  if (!["unspecified", "no_restriction", "lax", "strict"].includes(ss)) ss = "unspecified";
  const secure = Boolean("secure" in c ? c.secure : c.is_secure);
  const httpOnly = Boolean("httpOnly" in c ? c.httpOnly : c.is_httponly);
  const session = exp == null ? true : Boolean(c.session);
  const out = {
    domain,
    hostOnly: !domain.startsWith("."),
    httpOnly,
    name: String(c.name),
    path: c.path || "/",
    sameSite: ss,
    secure,
    session: exp == null ? session : false,
    storeId: String(c.storeId || "0"),
    value: c.value == null ? "" : String(c.value),
  };
  if (exp != null) out.expirationDate = exp;
  return out;
}

const editorCookies = [];
for (const c of snapshot.cookies || []) {
  if (!c || typeof c !== "object") continue;
  const item = cookieToEditor(c);
  if (item) editorCookies.push(item);
}

const summary = {
  profileId: assignedProfile,
  service: serviceId,
  cookies: (snapshot.cookies || []).length,
  origins: (snapshot.origins || []).length,
  storage: (snapshot.storage || []).length,
  uiRules: 0,
};

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

const editorPayload = { url: serviceUrl, cookies: editorCookies };
writeJson(outPath, editorPayload);

// Also write cookies/<svc>/<svc>.json (service-level alias used by many tools)
const svcJson = path.join(path.dirname(outPath), `${serviceId}.json`);
writeJson(svcJson, editorPayload);

const written = [outPath, svcJson];
const profileBase = path.basename(inPath, ".json");

if (writeFull) {
  // Prefer profile-scoped names when converting a specific slot so multi-slot
  // services (chatgpt-1..4) don't clobber each other.
  const fullPath = path.join(path.dirname(outPath), `${profileBase}.full.json`);
  const exportPath = path.join(path.dirname(outPath), `${profileBase}.export.json`);
  // Plus service-level latest aliases (overwrite) for convenience
  const fullAlias = path.join(path.dirname(outPath), `${serviceId}.full.json`);
  const exportAlias = path.join(path.dirname(outPath), `${serviceId}.export.json`);

  const fullBody = {
    url: serviceUrl,
    serviceId,
    serviceName: svc.name,
    profileId: assignedProfile,
    revision,
    updatedAt: rec.updatedAt || null,
    exportedAt: new Date().toISOString(),
    source: path.basename(inPath),
    sourceDump: "centrix-snapshot-at-rest",
    beParity: "decrypt + cookieScope.scopeSnapshotToServices (no auth/pool/uiRules DB)",
    cookies: editorCookies,
    storage: snapshot.storage || [],
    origins: snapshot.origins || [],
    uiRules: [],
  };
  const exportLike = {
    ok: true,
    assignedProfile,
    snapshot,
    revision,
    rulesRevision: 0,
    summary,
    updatedAt: rec.updatedAt || null,
    note: "Offline convert: snapshot is plaintext. Live API returns encrypted with sessionKey instead of snapshot.",
  };
  writeJson(fullPath, fullBody);
  writeJson(exportPath, exportLike);
  writeJson(fullAlias, fullBody);
  writeJson(exportAlias, exportLike);
  written.push(fullPath, exportPath, fullAlias, exportAlias);
}

console.log(JSON.stringify({
  ok: true,
  in: inPath,
  out: written,
  assignedProfile,
  revision,
  updatedAt: rec.updatedAt || null,
  summary,
  full: writeFull,
  service: { id: svc.id, url: svc.url, cookieDomains: svc.cookieDomains },
}, null, 2));
NODE
}

for p in "${SELECTED[@]}"; do
  if convert_one "$p"; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    log "FAIL $p"
  fi
done

log ""
log "=== done: ok=${ok} fail=${fail} full=${WRITE_FULL} ==="
[[ "$fail" -eq 0 ]] || exit 1
