"use strict";
// CentriX Phase B — standalone Node backend (B2 shadow). No Electron.
// Auth (master|staff|account) + a growing set of non-browser routes, reading the SAME Docker DB as the
// App Server. Cookie EXPORT/IMPORT (needs a live Chromium) stays on the Electron worker until B3.

const http = require("node:http");
const { URL } = require("node:url");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto"); // SePay webhook HMAC verify

const localDb = require("./shared/local-db");
const { readServicesConfig, writeServicesConfig, resetServicesConfig } = require("./shared/service-store");
const auth = require("./auth");
const profileCrypto = require("./shared/profile-crypto");
const appAttest = require("./shared/app-attest");
const cookieScope = require("./shared/cookie-scope");
const worker = require("./worker-client");
const profileSnapshot = require("./profile-snapshot");
const pool = require("./pool");
const snapshotStore = require("./snapshot-store");
const serviceVault = require("./service-vault");
const versionGate = require("./shared/version-gate");
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_ENDPOINT } = require("./shared/google-oauth");

// Decode a JWT payload (no signature check — the id_token comes straight from Google's token endpoint over
// TLS in our own server→Google exchange, and we re-validate aud/iss/exp/email_verified below).
function decodeJwtPayload(jwt) {
  const part = String(jwt || "").split(".")[1] || "";
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

// B3/B5 seams (off by default → backend is non-cutover; the App Server still serves these).
const PROFILE_VIA_WORKER = process.env.CENTRIX_PROFILE_VIA_WORKER === "1";
const LOADER_VIA_WORKER = process.env.CENTRIX_LOADER_VIA_WORKER === "1";
// DB-snapshot mode: serve /api/profile/* from a STORED at-rest snapshot (no live Electron custodian) → the
// server no longer needs the always-on App Server. Takes precedence over the worker for cookie pull/push.
const PROFILE_FROM_DB = process.env.CENTRIX_PROFILE_FROM_DB === "1";
const MASTER_SNAPSHOT_KEY = process.env.CENTRIX_MASTER_SNAPSHOT_KEY || "";
const ALLOW_PLAINTEXT_SNAPSHOT = process.env.CENTRIX_ALLOW_PLAINTEXT_SNAPSHOT === "1";
const PROFILE_SINGLE_DEVICE = process.env.CENTRIX_PROFILE_SINGLE_DEVICE === "1";
const PROFILE_EXPORT_GATE = process.env.CENTRIX_EXPORT_GATE !== "0";
const EXPORT_REQUIRE_SIG = process.env.CENTRIX_EXPORT_REQUIRE_SIG === "1";
const EXPORT_GATE_STRICT = process.env.CENTRIX_EXPORT_GATE === "strict";

// ── AUTO RE-SEED single-flight ──────────────────────────────────────────────────────────────────────
// App User báo "dịch vụ bị đá về /login" (/api/pool/session-dead). NHIỀU App User dùng chung 1 profile pool
// sẽ báo CÙNG LÚC → chỉ giữ 1 "job" đang chạy cho mỗi dịch vụ trong RESEED_TTL_MS. Manager worker poll
// /api/manager/reseed-jobs (lấy các dịch vụ cần re-seed), login lại, đẩy snapshot (revision++), rồi
// /api/manager/reseed-done để gỡ cờ. TTL tự gỡ nếu Manager chết giữa chừng.
const AUTO_RESEED_ENABLED = process.env.CENTRIX_AUTO_RESEED === "1";
const RESEED_TTL_MS = Math.max(15000, Number(process.env.CENTRIX_RESEED_TTL_MS) || 60000);
// COOLING: sau khi seed xong (reseed-done), trong khoảng này KHÔNG tạo job seed mới cho dịch vụ đó — cả nhóm
// cùng kéo 1 phiên vừa seed thay vì mỗi báo lại đẻ 1 lần login tươi (single-session: login mới đá phiên cũ →
// đá chính user vừa được cấp). App User vẫn poll revision + kéo phiên đã seed bình thường trong lúc cooling.
const RESEED_COOLING_MS = Math.max(2000, Number(process.env.CENTRIX_RESEED_COOLING_MS) || 6000);
const reseedState = new Map(); // "serviceId::slot" -> { at, state:"pending"|"cooling", reporters:Set, claimedAt, url, service, slot }
const reseedKey = (svc, slot) => String(svc || "").toLowerCase().trim() + "::" + Math.max(1, Number(slot) || 1);
function reseedPrune() { const now = Date.now(); for (const [k, v] of reseedState) { const ttl = v.state === "cooling" ? RESEED_COOLING_MS : RESEED_TTL_MS; if (now - (v.at || 0) > ttl) reseedState.delete(k); } }

// VietQR — TÀI KHOẢN NHẬN tiền (App User dựng QR chuyển khoản). Env-driven, mặc định TPBank (khớp App Server
// remote-tabs-main.vietqrPaymentConfig). App User đọc portal.paymentConfig; nếu thiếu → "Chưa cấu hình tài khoản
// nhận VietQR". Backend Ubuntu (getUserPortal) trước đây KHÔNG gắn field này → đây là chỗ wire.
function vietqrPaymentConfig() {
  return {
    enabled: String(process.env.CENTRIX_VIETQR_ENABLED || "1") !== "0",
    bankBin: String(process.env.CENTRIX_VIETQR_BIN || "970423"),      // TPBank BIN
    bankCode: String(process.env.CENTRIX_VIETQR_CODE || "TPB"),
    accountNo: String(process.env.CENTRIX_VIETQR_ACCOUNT || "00000290281"),
    accountName: String(process.env.CENTRIX_VIETQR_NAME || "TRAN XUAN LOC"),
    template: String(process.env.CENTRIX_VIETQR_TEMPLATE || "compact2"),
  };
}

// BỎ "EFFORT" — chỉ tính/ghi MODEL CHÍNH. Client ghép modelId = "<base>_<effort>" (effort = mức suy luận:
// standard/extended/max/min/low/medium/high/xhigh...). Cắt hậu tố "_<từ-effort>" ở CUỐI để mọi mức effort gộp
// về 1 model chính (bảng giá + "model ghi nhận" gọn, tính theo model chính). Chỉ cắt TỪ EFFORT ĐÃ BIẾT nên
// KHÔNG phá tên model có "_" hợp lệ (vd "gpt_4o"). Bật/tắt qua CENTRIX_STRIP_MODEL_EFFORT (mặc định BẬT).
const STRIP_MODEL_EFFORT = process.env.CENTRIX_STRIP_MODEL_EFFORT !== "0";
const MODEL_EFFORT_WORDS = new Set(["min", "minimal", "low", "medium", "high", "xhigh", "xxhigh", "ultra", "ultrahigh", "standard", "extended", "max", "none", "auto", "default"]);
function stripModelEffort(modelId) {
  let s = String(modelId || "");
  if (!STRIP_MODEL_EFFORT) return s;
  const i = s.lastIndexOf("_");
  if (i > 0 && MODEL_EFFORT_WORDS.has(s.slice(i + 1).toLowerCase())) s = s.slice(0, i);
  return s;
}

// SECURITY (M5): the attest/export-sign keys ship as public build defaults. Enforcing a signature/attest
// check while STILL using the shipped default is false security — anyone who unpacks the app can forge the
// header. Surface it loudly at boot, and hard-FAIL (fail-closed) when the operator opts in with
// CENTRIX_REQUIRE_ROTATED_KEYS=1 (kept opt-in so an in-place deploy isn't taken down before keys are
// rotated + a matching client is shipped). Rotate: set CENTRIX_EXPORT_SIGN_KEY / CENTRIX_APP_ATTEST_SECRET
// to fresh values on the server AND rebuild the App User/App Server client with the SAME values.
(function guardDefaultSecurityKeys() {
  const hardFail = process.env.CENTRIX_REQUIRE_ROTATED_KEYS === "1";
  const problems = [];
  if (EXPORT_REQUIRE_SIG && appAttest.EXPORT_SIGN_KEY_IS_DEFAULT) problems.push("CENTRIX_EXPORT_REQUIRE_SIG=1 but CENTRIX_EXPORT_SIGN_KEY is the shipped default");
  if (EXPORT_GATE_STRICT && appAttest.ATTEST_SECRET_IS_DEFAULT) problems.push("CENTRIX_EXPORT_GATE=strict but CENTRIX_APP_ATTEST_SECRET is the shipped default");
  for (const p of problems) console.error(`[SECURITY] ${p} — the check is verified with a PUBLIC key (forgeable). Rotate the key (server + client build).`);
  if (problems.length && hardFail) { console.error("[SECURITY] CENTRIX_REQUIRE_ROTATED_KEYS=1 → refusing to boot with default enforcement keys."); process.exit(1); }
})();

const PORT = Number(process.env.CENTRIX_BACKEND_PORT || 18778);
const HOST = process.env.CENTRIX_BACKEND_HOST || "127.0.0.1";
const DB_URL = process.env.CENTRIX_LOCAL_DB_URL || "http://127.0.0.1:19779";
const DEFAULT_PROFILE = "default";
// Serve the manager-website SPA bundle so the backend can be the website's sole front door (cutover).
// Off unless CENTRIX_BACKEND_WEB_DIR points at the static dir (e.g. ...\src\remote-server-web).
const WEB_DIR = process.env.CENTRIX_BACKEND_WEB_DIR ? path.resolve(process.env.CENTRIX_BACKEND_WEB_DIR) : "";
// Release dir holding the App User installer (Setup.exe) — served by the version-gate download route.
const RELEASE_DIR = process.env.CENTRIX_RELEASE_DIR ? path.resolve(process.env.CENTRIX_RELEASE_DIR) : "";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json" };
// Serve index.html with a cache-busting ?v= stamped onto the bridge script + no-store, so a plain browser
// reload always pulls the freshest api-ui-bridge.js. Cloudflare force-caches .js for 4h regardless of the
// origin's no-cache, but does NOT cache the HTML — so busting the JS URL from the always-fresh HTML is the
// only reliable way to push a web deploy WITHOUT a manual hard-refresh. The version = the bridge file's
// mtime+size, so it changes on every deploy and is identical across requests otherwise.
async function serveIndexHtml(res) {
  let html = await fsp.readFile(path.join(WEB_DIR, "index.html"), "utf8");
  let ver = "0";
  try { const st = await fsp.stat(path.join(WEB_DIR, "api-ui-bridge.js")); ver = `${Math.round(st.mtimeMs)}-${st.size}`; } catch { /* fall back to 0 */ }
  html = html.split('api-ui-bridge.js"').join(`api-ui-bridge.js?v=${ver}"`);
  const buf = Buffer.from(html, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(buf);
}

async function serveStatic(res, pathname) {
  if (!WEB_DIR) { sendJson(res, 404, { ok: false, error: "static serving disabled (set CENTRIX_BACKEND_WEB_DIR)" }); return; }
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = path.resolve(path.join(WEB_DIR, rel));
  if (full !== WEB_DIR && !full.startsWith(WEB_DIR + path.sep)) { sendJson(res, 403, { ok: false, error: "forbidden" }); return; } // path-traversal guard
  if (full === path.join(WEB_DIR, "index.html")) { try { await serveIndexHtml(res); } catch { sendJson(res, 404, { ok: false, error: "not found" }); } return; }
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, { "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream", "Content-Length": data.length, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  } catch {
    try { await serveIndexHtml(res); } // SPA fallback → the versioned, no-store index
    catch { sendJson(res, 404, { ok: false, error: "not found" }); }
  }
}

// Request scoping (mirror of remote-tabs-main): account tokens are forced to their own id later; for
// master/staff these resolve from x-centrix-* headers, the body, or ?userId=/?profileId=.
function requestUserId(req, url, payload = {}, fallback = "local-user") {
  return localDb.sanitizeId(req.headers["x-centrix-user"] || payload.userId || url.searchParams.get("userId") || fallback, fallback);
}
function requestProfileId(req, url, payload = {}, fallback = DEFAULT_PROFILE) {
  return localDb.sanitizeId(req.headers["x-centrix-profile"] || payload.profileId || url.searchParams.get("profileId") || fallback, fallback);
}

function responseHeaders(contentType, len, extra) {
  const h = {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Cache-Control": "no-store",
    ...(extra || {}),
  };
  if (len != null) h["Content-Length"] = len;
  return h;
}
function sendJson(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, responseHeaders("application/json; charset=utf-8", body.length, extraHeaders));
  res.end(body);
}

// crude per-route rate limiter (staff-login)
const rateBuckets = new Map();
function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) { rateBuckets.set(key, hits); return true; }
  hits.push(now); rateBuckets.set(key, hits); return false;
}

// Cache the App-User version config (portal.appVersion[0].configJson) so the per-request gate doesn't hit
// Docker every call. ~8s TTL; on a transient read failure keep the old config (never lock clients on a blip).
let _verCfg = { cfg: {}, at: 0 };

// Bumped whenever a service's UI rules are saved. A rule-only edit does NOT move the pool profile's snapshot
// revision, so a WARM App User tab would keep applying stale hide/replace/custom-CSS. Returned by BOTH
// /api/profile/export AND /api/profile/revision from the SAME source, so the value the client stored on its
// last pull equals what the probe returns → the warm tab re-pulls ONLY when the rules actually change (no
// spurious loop). serviceId(lower) → last-change ms. In-memory: a restart resets to 0 (the client cold-pulls
// on reconnect anyway) and Date.now() ensures the first post-restart save still exceeds any client value.
// DB-BACKED so it is consistent across ALL cluster workers AND reflects any rule edit (via the route OR a direct
// DB write) — a warm App User tab re-pulls its service rules when this number increases. Derived from the max
// updated_at of that service's ui_rules rows (the "service-rule" sentinel + per-user rows). A per-worker
// in-memory counter drifted under the 8-worker cluster and missed direct DB edits (2026-07-08).
async function rulesRevisionFor(serviceId) {
  const sid = String(serviceId || "").toLowerCase();
  if (!sid) return 0;
  try {
    const db = await readLocalDb();
    let maxTs = 0;
    for (const r of (db.uiRules || [])) {
      if (String(r.serviceId || "").toLowerCase() !== sid) continue;
      const ts = Date.parse(r.updatedAt || r.updated_at || "") || 0;
      if (ts > maxTs) maxTs = ts;
    }
    return maxTs;
  } catch { return 0; }
}
// ── ANNOUNCEMENT (marquee thông báo App User) ────────────────────────────────────────────────────────
// Nội dung do admin đặt ở web admin, đẩy xuống MỌI App User qua /api/health (client watchdog poll 15s).
// Lưu 1 file JSON nhỏ (announcement.json) trong data dir — dùng CHUNG cho cả cluster 8 worker (cùng đĩa);
// đọc có COALESCE cache 8s để /api/health luôn rẻ; ghi atomic (tmp→rename) như pool-state. KHÔNG đụng dbapi.
const ANNOUNCEMENT_FILE = path.join(snapshotStore.snapshotDir, "announcement.json");
let _ann = { data: null, at: 0 };
let _annInflight = null;
function sanitizeAnnouncement(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const text = String(o.text || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  const tone = o.tone === "warn" ? "warn" : "info";
  const enabled = (o.enabled === true || o.enabled === "true" || o.enabled === 1) && !!text;
  return { enabled, text, tone, updatedAt: String(o.updatedAt || "") };
}
async function readAnnouncementCached() {
  const now = Date.now();
  if (_ann.at && now - _ann.at < 8000) return _ann.data;
  if (!_annInflight) {
    _annInflight = (async () => {
      try {
        const raw = await fsp.readFile(ANNOUNCEMENT_FILE, "utf8");
        _ann = { data: sanitizeAnnouncement(JSON.parse(raw)), at: Date.now() };
      } catch { _ann = { data: sanitizeAnnouncement(null), at: Date.now() }; } // no file / bad json → tắt
      return _ann.data;
    })().finally(() => { _annInflight = null; });
  }
  if (_ann.at) return _ann.data; // stale-while-revalidate: chỉ lần đầu (chưa có value) mới chờ
  return _annInflight;
}
async function writeAnnouncement(payload) {
  const data = sanitizeAnnouncement({ ...(payload || {}), updatedAt: new Date().toISOString() });
  await fsp.mkdir(snapshotStore.snapshotDir, { recursive: true }).catch(() => {});
  const tmp = `${ANNOUNCEMENT_FILE}.${process.pid}.tmp`;
  await snapshotStore.withFsRetry(() => fsp.writeFile(tmp, JSON.stringify(data), "utf8"));
  await snapshotStore.withFsRetry(() => fsp.rename(tmp, ANNOUNCEMENT_FILE));
  _ann = { data, at: Date.now() }; // worker này thấy ngay; các worker khác nhặt qua cache 8s
  return data;
}
// Bản gửi cho client: khi tắt thì KHÔNG lộ text (chỉ enabled:false) để nội dung nháp không rò ra máy khách.
function announcementForClient(a) {
  return a && a.enabled ? { enabled: true, text: a.text, tone: a.tone, updatedAt: a.updatedAt }
                        : { enabled: false, text: "", tone: "info", updatedAt: (a && a.updatedAt) || "" };
}
let _verCfgInflight = null;
async function getVersionConfigCached() {
  const now = Date.now();
  if (_verCfg.at && now - _verCfg.at < 8000) return _verCfg.cfg;
  // COALESCE: /api/health calls this 2-3× per request and the App User watchdog polls health constantly. Without
  // this guard, every 8s expiry let a burst of concurrent health polls EACH fire getPortalSnapshot() at once → a
  // periodic thundering herd of /portal reads pegged the worker (2026-07-08 "app rất chậm"). Now one refresh is
  // shared by all callers that arrive while it is in flight.
  if (!_verCfgInflight) {
    _verCfgInflight = (async () => {
      try {
        const snap = await localDb.getPortalSnapshot(true); // LEAN: version config needs only portal.appVersion, not the 12MB db
        const rec = (((snap && snap.portal && snap.portal.appVersion) || [])[0]) || {};
        let cfg = {};
        if (rec.configJson) { try { cfg = JSON.parse(rec.configJson); } catch { cfg = {}; } }
        _verCfg = { cfg, at: Date.now() };
      } catch { _verCfg.at = Date.now(); } // keep the old cfg on a transient read failure
      return _verCfg.cfg;
    })().finally(() => { _verCfgInflight = null; });
  }
  // STALE-WHILE-REVALIDATE: once we have ANY prior value, serve it instantly and let the refresh finish in the
  // background — no request ever blocks on the /portal read (which can take seconds). Only the very first
  // (cold, no value yet) call waits. The version config changes rarely, so a few seconds of staleness is fine.
  if (_verCfg.at) return _verCfg.cfg;
  return _verCfgInflight;
}

// LIVE-APPLY staff permissions after a role/account change in "Nhóm & Phân quyền". Staff sessions snapshot
// their permissions at login, so editing a ROLE's perms (or a user's role) did NOT reach users already logged
// in — they kept the old perms until re-login. This re-resolves every live session's perms from the DB and
// patches them IN PLACE (no forced logout). A disabled/deleted account gets its sessions revoked (kicked).
async function refreshLiveStaffPermissions() {
  try {
    for (const username of auth.activeStaffUsernames()) {
      try {
        const res = await localDb.adminAccountGet(username);
        const acc = res && res.account;
        if (!acc || acc.enabled === false) { auth.updateStaffSessions(username, null); continue; }
        const permissions = await localDb.adminResolvePermissions(acc);
        auth.updateStaffSessions(username, { permissions, role: acc.role || "", isOwner: !!acc.isOwner, displayName: acc.displayName || "" });
      } catch { /* skip this one, keep going */ }
    }
  } catch { /* best-effort */ }
}

// Resolve the current installer in RELEASE_DIR (configured installerFile, else newest *.exe) and return its
// {filename, size, sha256}, CACHED by path+mtime+size (sha256 of a ~90MB file is expensive — never recompute
// on an unchanged file). The App User's in-app updater uses sha256 to verify the download before running it.
let _dlMeta = { key: "", meta: null };
let _dlInflight = null; // { key, p } — ONE background hash shared by all callers
async function downloadInstallerMeta() {
  if (!RELEASE_DIR) return null;
  try {
    const cfg = await getVersionConfigCached();
    let full = "";
    const wanted = String(cfg.installerFile || "").trim();
    if (wanted) { const f = path.resolve(path.join(RELEASE_DIR, path.basename(wanted))); if (await fsp.stat(f).then(() => true).catch(() => false)) full = f; }
    if (!full) {
      const exes = (await fsp.readdir(RELEASE_DIR).catch(() => [])).filter((n) => /\.exe$/i.test(n));
      if (!exes.length) return null;
      const stats = await Promise.all(exes.map(async (n) => ({ n, m: (await fsp.stat(path.join(RELEASE_DIR, n))).mtimeMs })));
      stats.sort((a, b) => b.m - a.m);
      full = path.join(RELEASE_DIR, stats[0].n);
    }
    const st = await fsp.stat(full);
    const key = `${full}:${st.mtimeMs}:${st.size}`;
    if (_dlMeta.key === key && _dlMeta.meta) return _dlMeta.meta; // warm cache → instant
    // Cache miss (cold start after restart / installer changed). sha256 of a ~90MB file is expensive; hashing it
    // is done ONCE in the background and shared by every concurrent caller. /api/health (the App User's frequent
    // watchdog poll) NEVER blocks on it — it returns immediately, and sha256 appears on a later poll once the
    // hash lands. Before this, each concurrent health poll streamed+hashed the 90MB file independently → dozens
    // of 90MB reads pegged the worker's event loop and health timed out at 10s (2026-07-08 "app rất chậm").
    if (!_dlInflight || _dlInflight.key !== key) {
      _dlInflight = { key, p: (async () => {
        const hash = crypto.createHash("sha256");
        await new Promise((resolve, reject) => { const s = fs.createReadStream(full); s.on("data", (d) => hash.update(d)); s.on("end", resolve); s.on("error", reject); });
        _dlMeta = { key, meta: { filename: path.basename(full), size: st.size, sha256: hash.digest("hex") } };
        return _dlMeta.meta;
      })().catch(() => null).finally(() => { if (_dlInflight && _dlInflight.key === key) _dlInflight = null; }) };
    }
    return null; // don't serve a stale (wrong-file) sha256; latestApp ships without it for ~1s until the hash lands
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST + ":" + PORT}`);
  const pathname = url.pathname;
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, responseHeaders("text/plain", 0)); res.end(); return; }

    // ---------- App User VERSION GATE — force update / emergency lock ----------
    // Only App-User requests (UA "CentriXAppUser/<ver>") are gated; admin/manager (browser UA) are NEVER blocked.
    // Exempt /api/health (a blocked client must still probe) + the installer download (so it can fetch the update).
    {
      const appVer = versionGate.appUserVersion(req.headers["user-agent"]);
      if (appVer) {
        // ĐIỂM DANH VERSION: log 1 lần cho mỗi (version|deviceKey) mỗi worker-lifetime — trả lời được "khách
        // đang chạy bản nào" từ journal (server không lưu version ở đâu khác). Volume ~vài chục dòng/ngày.
        const devKey = String(req.headers["x-centrix-user"] || req.headers["x-centrix-device"] || clientIp(req));
        const verKey = appVer + "|" + devKey;
        if (!global.__cxVerSeen) global.__cxVerSeen = new Set();
        if (!global.__cxVerSeen.has(verKey) && global.__cxVerSeen.size < 5000) {
          global.__cxVerSeen.add(verKey);
          console.log("[appver]", appVer, "dev=" + devKey.slice(0, 24));
        }
      }
      if (appVer && pathname !== "/api/health" && !pathname.startsWith("/api/download/")) {
        const verdict = versionGate.versionVerdict(appVer, await getVersionConfigCached());
        if (verdict) { sendJson(res, 426, { ok: false, error: "update-required", ...verdict, downloadUrl: "/api/download/app-user" }); return; }
      }
    }

    // ---------- PUBLIC ----------
    if (req.method === "GET" && pathname === "/api/health") {
      // Health is EXEMPT from the 426 gate above so a locked client can still reach it. Ship the version
      // verdict here (computed from the caller's UA) so the App User watchdog can lock the whole app
      // proactively AND detect the un-block (verdict → null) to auto-unlock, without a gated request.
      let versionVerdict = null;
      try {
        const appVer = versionGate.appUserVersion(req.headers["user-agent"]);
        if (appVer) {
          const v = versionGate.versionVerdict(appVer, await getVersionConfigCached());
          if (v) versionVerdict = { ...v, downloadUrl: "/api/download/app-user", appVersion: appVer };
        }
      } catch { /* fail-open: never let a config read error lock the app */ }
      // ALWAYS advertise the latest available App-User version (independent of the block gate) so the in-app
      // updater can offer a NON-forced "update available" download. Includes sha256/size so the client can
      // verify the installer before running it. Null when the owner hasn't set latestVersion / no release dir.
      let latestApp = null;
      try {
        const cfg = await getVersionConfigCached();
        if (cfg.latestVersion) {
          const meta = await downloadInstallerMeta();
          latestApp = { version: String(cfg.latestVersion), notes: String(cfg.notes || ""), downloadUrl: "/api/download/app-user", ...(meta || {}) };
        }
      } catch { /* best-effort */ }
      let announcement = { enabled: false, text: "", tone: "info", updatedAt: "" };
      try { announcement = announcementForClient(await readAnnouncementCached()); } catch { /* fail-open: no marquee */ }
      sendJson(res, 200, { ok: true, app: "CentriX Phase-B Backend", mode: "shadow", port: PORT, dbUrl: DB_URL, staffRbac: auth.STAFF_RBAC, profilePool: PROFILE_FROM_DB, versionVerdict, latestApp, announcement });
      return;
    }

    // Staff login MINTS auth → must run before the gate.
    if (req.method === "POST" && pathname === "/api/auth/staff-login") {
      if (auth.STAFF_RBAC === "off") { sendJson(res, 410, { ok: false, error: "Đăng nhập nhân viên chưa bật" }); return; }
      if (rateLimited(`stafflogin:${clientIp(req)}`, 5, 60000)) { sendJson(res, 429, { ok: false, error: "Quá nhiều lần thử, đợi 1 phút" }); return; }
      const body = await auth.readJsonBody(req);
      let staff;
      try { staff = await localDb.adminLogin({ username: body.username || body.email, password: body.password }); }
      catch (e) { sendJson(res, 401, { ok: false, error: (e && e.message) || "Đăng nhập thất bại" }); return; }
      const { token, expiresAt } = auth.adminSessionPut(staff);
      sendJson(res, 200, { ok: true, expiresAt, staff }, { "Set-Cookie": auth.staffCookie(token, Math.floor((expiresAt - Date.now()) / 1000)) });
      return;
    }

    // Google ACCOUNT login — MINTS an account token (verified-email → Docker session) BEFORE the gate, so the
    // App User can log in against the backend ALONE (no App Server). The OAuth code is exchanged server-side
    // (secret never leaves the host), id_token claims validated, the VERIFIED email mapped to a pre-existing
    // account (no auto-create) via the Docker DB. Mirrors the App Server's /api/auth/google exactly.
    if (req.method === "POST" && pathname === "/api/auth/google") {
      if (!GOOGLE_CLIENT_SECRET) { sendJson(res, 500, { ok: false, error: "Google login chua duoc cau hinh tren server" }); return; }
      if (rateLimited(`googlelogin:${clientIp(req)}`, 10, 60000)) { sendJson(res, 429, { ok: false, error: "Quá nhiều lần thử, đợi 1 phút" }); return; }
      const gpayload = await auth.readJsonBody(req);
      const code = String(gpayload.code || ""), codeVerifier = String(gpayload.codeVerifier || ""), redirectUri = String(gpayload.redirectUri || ""), deviceId = String(gpayload.deviceId || "");
      if (!code || !codeVerifier || !redirectUri) { sendJson(res, 400, { ok: false, error: "Thieu tham so OAuth" }); return; }
      let email = "";
      try {
        const form = new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier });
        const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
        const tokenJson = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenJson.id_token) throw new Error(tokenJson.error_description || tokenJson.error || "Khong doi duoc token Google");
        const claims = decodeJwtPayload(tokenJson.id_token);
        if (String(claims.aud || "") !== GOOGLE_CLIENT_ID) throw new Error("Token Google sai aud");
        const iss = String(claims.iss || "");
        if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") throw new Error("Token Google sai iss");
        if (Number(claims.exp || 0) * 1000 <= Date.now()) throw new Error("Token Google het han");
        if (claims.email_verified !== true && String(claims.email_verified) !== "true") throw new Error("Email Google chua xac thuc");
        email = String(claims.email || "").trim().toLowerCase();
      } catch (error) { sendJson(res, 400, { ok: false, error: (error && error.message) || "Xac thuc Google that bai" }); return; }
      if (!email) { sendJson(res, 400, { ok: false, error: "Khong lay duoc email tu Google" }); return; }
      let account;
      try { account = await localDb.loginAccountGoogle({ email, deviceId, deviceJkt: gpayload.deviceJkt, name: gpayload.name }); }
      catch (error) {
        const m = String((error && error.message) || "");
        const friendly = /bi tat|bi khoa|locked|disabled|đã bị khóa/i.test(m) ? "Tài khoản đã bị khóa — liên hệ quản trị viên" : (m || "Tai khoan chua duoc cap");
        sendJson(res, 403, { ok: false, error: friendly }); return;
      }
      const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
      const serverUrl = String(gpayload.serverUrl || (req.headers.host ? `${proto}://${req.headers.host}` : "")).trim().replace(/\/+$/, "");
      // Record the login into the user-visible activity feed. The /api/me recentHistory parser already
      // reads action "login"/"login-new-device" (title = email, details.deviceId) — without this write
      // the App User's "Đăng nhập" history rows never light up. Fire-and-forget, mirrors change-password.
      localDb.recordUserActivity({
        userId: account.userId,
        deviceId: account.deviceId || deviceId || "",
        profileId: account.profileId || DEFAULT_PROFILE,
        serviceId: "auth",
        action: account.newDevice ? "login-new-device" : "login",
        title: account.email || email,
        details: JSON.stringify({ ip: clientIp(req), deviceId: account.deviceId || deviceId || "", via: "google" })
      }).catch(() => {});
      sendJson(res, 200, {
        ok: true,
        account: { email: account.email, userId: account.userId, profileId: account.profileId, user: account.user },
        connection: {
          serverUrl, token: account.token, userId: account.userId,
          deviceId: account.deviceId || deviceId || account.userId,
          profileId: account.profileId || DEFAULT_PROFILE,
          expiresAt: account.expiresAt || null, newDevice: Boolean(account.newDevice),
          sessionKey: account.sessionKey || "", tokenType: "account"
        }
      });
      return;
    }

    // Account lock-status — PUBLIC read (token in the BODY, not the header): a revoked/locked token can still
    // learn it is locked so the App User shows "Tài khoản đã bị khóa" right after its auth dies. {found,locked}.
    if (req.method === "POST" && pathname === "/api/account/lock-status") {
      const body = await auth.readJsonBody(req).catch(() => ({}));
      sendJson(res, 200, { ok: true, ...(await localDb.accountLockStatus({ token: String(body.token || "") })) });
      return;
    }

    // SePay bank-transaction webhook — PUBLIC (SePay servers call it, no app session). SePay signs every delivery
    // with the Secret Key: HMAC-SHA256 over `{timestamp}.{raw_body}`, headers X-SePay-Signature: sha256=<hex> +
    // X-SePay-Timestamp. We HMAC the RAW bytes (never a re-serialized JSON) and timing-safe compare. Enforced only
    // when CENTRIX_SEPAY_SECRET is set; unset → accept+warn so the endpoint is reachable while wiring SePay.
    // (A Cloudflare Skip rule for /api/webhook/sepay is still required — SePay won't send X-CentriX-App-Key.)
    if (req.method === "POST" && pathname === "/api/webhook/sepay") {
      const chunks = []; let total = 0;
      try {
        for await (const chunk of req) {
          chunks.push(chunk); total += chunk.length;
          if (total > 1_000_000) { sendJson(res, 413, { success: false, error: "Payload too large" }); return; }
        }
      } catch { /* fall through with whatever we have */ }
      const rawBuf = Buffer.concat(chunks);
      const secret = String(process.env.CENTRIX_SEPAY_SECRET || "").trim();
      if (secret) {
        const ts = String(req.headers["x-sepay-timestamp"] || "");
        const sig = String(req.headers["x-sepay-signature"] || "");
        const expected = "sha256=" + crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(ts + ".", "utf8"), rawBuf])).digest("hex");
        const a = Buffer.from(sig, "utf8"); const b = Buffer.from(expected, "utf8");
        const sigOk = a.length === b.length && crypto.timingSafeEqual(a, b);
        const maxSkew = Number(process.env.CENTRIX_SEPAY_MAX_SKEW_SEC || 0); // 0 = disabled (avoid clock-drift false rejects)
        const tsFresh = !maxSkew || (Number(ts) > 0 && Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= maxSkew);
        if (!sigOk || !tsFresh) { sendJson(res, 401, { success: false, error: "Invalid signature" }); return; }
      } else {
        // FAIL CLOSED: with no secret we cannot authenticate the sender, so a forged POST could credit a
        // wallet (approve_portal_topup) for free. Reject instead of accepting unverified. 503 (not 401) so
        // SePay keeps retrying — a real payment during the misconfig window is redelivered once the secret
        // is set, not silently lost. Operator MUST set CENTRIX_SEPAY_SECRET = the SePay dashboard Secret Key.
        console.error("[sepay-webhook] CENTRIX_SEPAY_SECRET is not set — REJECTING webhook (fail-closed). Set it to enable auto-credit.");
        sendJson(res, 503, { success: false, error: "SePay webhook not configured" });
        return;
      }
      let body = {};
      try { const raw = rawBuf.toString("utf8"); body = raw.trim() ? JSON.parse(raw) : {}; } catch { body = {}; }
      try { const result = await localDb.processSepayWebhook(body); sendJson(res, 200, { success: true, ...result }); }
      catch (error) { sendJson(res, 502, { success: false, error: (error && error.message) || "sepay webhook failed" }); } // non-2xx → SePay retries
      return;
    }

    // App User installer DOWNLOAD — PUBLIC (a blocked/old client MUST be able to fetch the update). Serves the
    // configured installer, else the newest *.exe, from CENTRIX_RELEASE_DIR. Streamed (installers are large).
    if (req.method === "GET" && pathname === "/api/download/app-user") {
      if (!RELEASE_DIR) { sendJson(res, 404, { ok: false, error: "Chưa cấu hình thư mục release (CENTRIX_RELEASE_DIR)" }); return; }
      try {
        const cfg = await getVersionConfigCached();
        let full = "";
        const wanted = String(cfg.installerFile || "").trim();
        if (wanted) { const f = path.resolve(path.join(RELEASE_DIR, path.basename(wanted))); if (await fsp.stat(f).then(() => true).catch(() => false)) full = f; }
        if (!full) {
          const exes = (await fsp.readdir(RELEASE_DIR).catch(() => [])).filter((n) => /\.exe$/i.test(n));
          if (!exes.length) { sendJson(res, 404, { ok: false, error: "Chưa có file cài (.exe) trong thư mục release" }); return; }
          const stats = await Promise.all(exes.map(async (n) => ({ n, m: (await fsp.stat(path.join(RELEASE_DIR, n))).mtimeMs })));
          stats.sort((a, b) => b.m - a.m);
          full = path.join(RELEASE_DIR, stats[0].n);
        }
        if (full !== RELEASE_DIR && !full.startsWith(RELEASE_DIR + path.sep)) { sendJson(res, 403, { ok: false, error: "forbidden" }); return; }
        const stat = await fsp.stat(full);
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": stat.size, "Content-Disposition": `attachment; filename="${path.basename(full)}"`, "Cache-Control": "no-cache" });
        fs.createReadStream(full).pipe(res);
      } catch (e) { sendJson(res, 500, { ok: false, error: (e && e.message) || "download failed" }); }
      return;
    }

    // ---------- PUBLIC static SPA (manager website bundle) — non-/api GET, no auth (the API it calls is gated) ----------
    if (req.method === "GET" && !pathname.startsWith("/api/")) { await serveStatic(res, pathname); return; }

    // ---------- GATE (master | staff-RBAC | account-allowlist) ----------
    const g = await auth.gate(req, url);
    if (!g.ok) { sendJson(res, g.status, { ok: false, error: g.error }); return; }
    const { auth: who } = g;

    // ---- staff session self routes ----
    if (pathname === "/api/auth/staff-logout") {
      auth.adminSessionDelete(auth.headerTokenOf(req) || auth.cookieTokenOf(req));
      sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearStaffCookie() });
      return;
    }
    if (req.method === "GET" && pathname === "/api/auth/staff-whoami") {
      if (who.kind === "staff") { sendJson(res, 200, { ok: true, staff: who.staff }); return; }
      sendJson(res, 200, { ok: true, staff: { username: "owner", displayName: "Owner (master)", role: "owner", isOwner: true, permissions: ["*"] } });
      return;
    }
    // Đổi mật khẩu của CHÍNH staff đang đăng nhập. Username LẤY TỪ PHIÊN (who.staff) — KHÔNG nhận từ client,
    // nên không đổi được của người khác. Master-token (không có account DB) bị chặn. Verify mật khẩu cũ ở local-db.
    if (req.method === "POST" && pathname === "/api/auth/staff-change-password") {
      if (who.kind !== "staff" || !who.staff || !who.staff.username) {
        sendJson(res, 403, { ok: false, error: "Chỉ nhân viên đã đăng nhập mới đổi được mật khẩu" }); return;
      }
      if (rateLimited(`staffpw:${clientIp(req)}`, 5, 60000)) {
        sendJson(res, 429, { ok: false, error: "Quá nhiều lần thử, đợi 1 phút" }); return;
      }
      const body = await auth.readJsonBody(req).catch(() => ({}));
      try {
        await localDb.changeAdminPassword({
          username: who.staff.username,
          currentPassword: String(body.currentPassword || body.oldPassword || ""),
          newPassword: String(body.newPassword || ""),
        });
      } catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Đổi mật khẩu thất bại" }); return; }
      sendJson(res, 200, { ok: true }); return;
    }

    // ----- admin: UPLOAD App User installer (.exe) into the release dir (master | staff:connection) -----
    // Lets the owner publish a build from the web admin instead of SCP-ing to the server. Handled HERE —
    // BEFORE the JSON body parse below (line ~815) — because the body is a ~90MB raw binary, streamed to a
    // temp file (never buffered) with sha256 computed on the fly, then atomically renamed into place. Auth is
    // already enforced by the gate (account tokens are 403 — route not in ACCOUNT_ALLOWED_PATHS; staff need
    // the "connection" view). Target name comes from the x-centrix-filename header (basename, .exe only).
    // NOTE: through the Cloudflare tunnel the request body is capped (~100MB on the free plan) — a larger
    // installer must still be pushed by SCP. Returns {ok, filename, size, sha256} so the UI can show it and
    // fill the "installerFile" field. The owner still sets latestVersion + Saves the version policy after.
    if (req.method === "POST" && pathname === "/api/admin/upload-installer") {
      if (who.kind === "account") { sendJson(res, 403, { ok: false, error: "forbidden" }); return; }
      // This route publishes an executable that EVERY App User auto-downloads and RUNS. The central gate only
      // enforces the "connection" permission when STAFF_RBAC="on"; in "log" mode a zero-permission staff would
      // slip through. Given the blast radius, require the perm for a staff caller regardless of RBAC mode
      // (master/owner always pass). Belt-and-suspenders over the gate — never a downgrade.
      if (who.kind === "staff") {
        const perms = (who.staff && who.staff.permissions) || [];
        if (!(who.staff.isOwner || perms.includes("*") || perms.includes("connection"))) {
          sendJson(res, 403, { ok: false, error: "Không đủ quyền tải bản cài (cần quyền Kết nối)" }); return;
        }
      }
      if (!RELEASE_DIR) { sendJson(res, 404, { ok: false, error: "Chưa cấu hình thư mục release (CENTRIX_RELEASE_DIR)" }); return; }
      const rawName = path.basename(String(req.headers["x-centrix-filename"] || "").trim());
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/i.test(rawName)) {
        sendJson(res, 400, { ok: false, error: "Tên file không hợp lệ (chỉ .exe, ký tự A-Z 0-9 . _ -)" }); return;
      }
      const finalPath = path.resolve(path.join(RELEASE_DIR, rawName));
      if (finalPath !== RELEASE_DIR && !finalPath.startsWith(RELEASE_DIR + path.sep)) { sendJson(res, 403, { ok: false, error: "forbidden" }); return; }
      const MAX_BYTES = Math.max(1, Number(process.env.CENTRIX_UPLOAD_MAX_MB || 300)) * 1024 * 1024;
      const declared = Number(req.headers["content-length"] || 0);
      if (declared && declared > MAX_BYTES) { sendJson(res, 413, { ok: false, error: `File quá lớn (> ${Math.round(MAX_BYTES / 1048576)}MB)` }); return; }
      try { await fsp.mkdir(RELEASE_DIR, { recursive: true }); } catch { /* dir may already exist */ }
      const tmpPath = path.join(RELEASE_DIR, `.upload-${crypto.randomBytes(8).toString("hex")}.tmp`);
      const hash = crypto.createHash("sha256");
      const out = fs.createWriteStream(tmpPath);
      let received = 0, aborted = false;
      const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch { /* already gone */ } };
      const fail = (status, error) => {
        if (aborted) return; aborted = true;
        try { out.on("close", cleanup); out.destroy(); } catch { cleanup(); }
        try { req.pause(); } catch { /* noop */ } // stop pulling more of the (possibly huge) body into memory
        if (!res.headersSent) sendJson(res, status, { ok: false, error }); // deliver the error BEFORE tearing down
        const kill = () => { try { req.destroy(); } catch { /* noop */ } }; // close the socket once the JSON flushed
        if (res.writableFinished) kill(); else res.on("finish", kill);
      };
      req.on("data", (chunk) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_BYTES) { fail(413, `File quá lớn (> ${Math.round(MAX_BYTES / 1048576)}MB)`); return; }
        hash.update(chunk);
        if (!out.write(chunk)) { req.pause(); out.once("drain", () => { if (!aborted) req.resume(); }); }
      });
      req.on("end", () => { if (!aborted) out.end(); });
      req.on("error", () => fail(400, "Lỗi truyền file"));
      out.on("error", () => fail(500, "Lỗi ghi file"));
      out.on("finish", async () => {
        if (aborted) return;
        aborted = true; // claim the response NOW so a late req 'error' during the rename can't also send/reject
        if (received === 0) { cleanup(); if (!res.headersSent) sendJson(res, 400, { ok: false, error: "File rỗng" }); return; }
        try {
          await fsp.rename(tmpPath, finalPath);
          _dlMeta = { key: "", meta: null }; // force downloadInstallerMeta to recompute for /api/health
          if (!res.headersSent) sendJson(res, 200, { ok: true, filename: rawName, size: received, sha256: hash.digest("hex") });
        } catch (e) { cleanup(); if (!res.headersSent) sendJson(res, 500, { ok: false, error: (e && e.message) || "Lỗi lưu file" }); }
      });
      return;
    }

    // ===================== PROFILE cookie seam — DB-snapshot (no Electron) OR worker (live custodian) =====
    // gate + scope + per-session encrypt/decrypt always run HERE (backend). Source of the raw snapshot:
    // CENTRIX_PROFILE_FROM_DB=1 → stored at-rest snapshot (server needs no App Server); else the worker RPC
    // (live custodian). One of the two flags must be on for these routes to be served here.
    if ((PROFILE_VIA_WORKER || PROFILE_FROM_DB) && (pathname === "/api/profile/export" || pathname === "/api/profile/revision" ||
        pathname === "/api/profile/import" || pathname === "/api/profile/lock" ||
        pathname === "/api/profile/release" || pathname === "/api/profile/takeover")) {
      const isAccount = who.kind === "account";
      const account = who.account || {};
      // LOG luồng profile: 4xx LUÔN được log (backend vốn chỉ log 500 → khách bị 403/404 không để lại dấu vết,
      // không chẩn đoán được "mở dịch vụ không nhận profile"); bật CENTRIX_TRACE_EXPORT=1 để log cả 2xx.
      {
        const origWriteHead = res.writeHead.bind(res);
        const traceAll = process.env.CENTRIX_TRACE_EXPORT === "1";
        res.writeHead = (st, ...rest) => {
          if (traceAll || st >= 400) console.log("[profile]", st, req.method, pathname, "svc=" + (url.searchParams.get("service") || "-"), "user=" + (isAccount ? account.userId : "non-account"));
          return origWriteHead(st, ...rest);
        };
      }

      if (req.method === "GET" && pathname === "/api/profile/export") {
        // EXPORT_GATE (P0) — parity with the App Server (remote-tabs-main): the `!interacted` check is
        // ALWAYS-ON for accounts (a bare login→export bot never interacts → blocked), plus attest/export-sig
        // (strict / require-sig flags). interactedAt is stamped by auth.gate() on every non-export request.
        if (isAccount && PROFILE_EXPORT_GATE) {
          const tk = auth.headerTokenOf(req);
          const interacted = auth.interactedWithin(tk);
          const attestOk = appAttest.verifyAttest(req.headers["x-centrix-user"], req.headers["x-centrix-attest"]);
          const sigOk = appAttest.verifyExportSig(tk, account.profileId, req.headers["x-centrix-sig"]);
          const strictBlock = EXPORT_GATE_STRICT && !attestOk;
          const requireSigBlock = EXPORT_REQUIRE_SIG && !sigOk;
          if (!interacted || strictBlock || requireSigBlock) {
            const reason = !interacted ? "no-client-interaction" : (requireSigBlock ? "bad-signature" : "attestation");
            sendJson(res, 403, { ok: false, error: "export-blocked", reason });
            return;
          }
        }
        const profileId = isAccount ? account.profileId : (url.searchParams.get("profileId") || DEFAULT_PROFILE);
        const includeStorage = url.searchParams.get("includeStorage") !== "0";
        const config = await readServicesConfig();
        const exportServices = isAccount ? (((await localDb.servicesForUser(config, account.userId)).config || {}).services || []) : config.services;
        let snapshot, revision, assignedProfile = null;
        const serviceParam = url.searchParams.get("service");
        if (PROFILE_FROM_DB && serviceParam) {
          // POOL mode: one service is backed by many profiles; assign this user a profile (capacity-fill,
          // sticky, dead-skipped) and return THAT profile's login for the service.
          const svc = (config.services || []).find((s) => s.id === serviceParam);
          if (!svc) { sendJson(res, 404, { ok: false, error: "unknown-service" }); return; }
          // Grant check: an account may only pull a service it was GRANTED (the pool branch must not bypass
          // the per-account grant the way the whole-profile path scopes by exportServices).
          if (isAccount && !exportServices.some((s) => s.id === serviceParam)) { sendJson(res, 403, { ok: false, error: "service-not-granted" }); return; }
          const userId = isAccount ? localDb.sanitizeId(account.userId, "local-user") : (url.searchParams.get("userId") || "anon");
          assignedProfile = await pool.assignProfile(serviceParam, userId, config.services || []);
          if (!assignedProfile) { sendJson(res, 404, { ok: false, error: "no-profile-available", reason: "Dịch vụ này chưa có profile nào còn login trong pool — quản lí cần seed." }); return; }
          const r = await profileSnapshot.getSnapshotForExport(assignedProfile, { services: [svc], scopeCookies: true });
          if (!r.snapshot) { sendJson(res, 404, { ok: false, error: "no-snapshot" }); return; }
          // RULES-WITH-PROFILE: the service's hide/replace/userScript rules (ui_rules table, "service-rule"
          // sentinel wins) ride INSIDE the snapshot — a pool profile never reaches an App User without the
          // service's rules baked into the same (encrypted) payload.
          const poolUiRules = isAccount
            ? ((exportServices.find((s) => s.id === serviceParam) || {}).uiRules || [])
            : await localDb.uiRulesForServiceUser(userId, serviceParam);
          snapshot = includeStorage ? r.snapshot : { ...r.snapshot, storage: [] };
          snapshot = { ...snapshot, uiRules: poolUiRules };
          revision = r.revision;
        } else if (PROFILE_FROM_DB) {
          const r = await profileSnapshot.getSnapshotForExport(profileId, { services: exportServices, scopeCookies: isAccount });
          if (!r.snapshot) { sendJson(res, 404, { ok: false, error: "no-snapshot", reason: "Login chưa được nạp vào kho — quản lí cần đăng nhập + đẩy profile lên." }); return; }
          snapshot = r.snapshot; revision = r.revision;
          if (!includeStorage) snapshot = { ...snapshot, storage: [] };
          // RULES-WITH-PROFILE (whole-profile pull): accounts get the rules of ALL their granted services
          // (exportServices comes from servicesForUser, which attaches merged uiRules per service).
          if (isAccount) snapshot = { ...snapshot, uiRules: exportServices.flatMap((s) => Array.isArray(s.uiRules) ? s.uiRules : []) };
        } else {
          const raw = await worker.getRawSnapshot({ profileId, services: exportServices, includeStorage, scopeCookies: isAccount });
          if (!raw.ok) { sendJson(res, 502, { ok: false, error: "worker getRawSnapshot failed", detail: raw.error || raw.status }); return; }
          snapshot = raw.snapshot;
          // Worker mode has no pool branch, so honor ?service= scoping here too — a scoped pull must
          // never receive OTHER services' rules (the client files them all under the one service).
          if (isAccount) {
            const ruleServices = serviceParam ? exportServices.filter((s) => s.id === serviceParam) : exportServices;
            snapshot = { ...snapshot, uiRules: ruleServices.flatMap((s) => Array.isArray(s.uiRules) ? s.uiRules : []) };
          }
          const revRes = await worker.workerRevision({ profileId });
          revision = revRes.ok ? revRes.revision : 0;
        }
        const summary = { profileId: assignedProfile || profileId, service: serviceParam || null, cookies: (snapshot.cookies || []).length, origins: (snapshot.origins || []).length, storage: (snapshot.storage || []).length, uiRules: Array.isArray(snapshot.uiRules) ? snapshot.uiRules.length : 0 };
        const pullKey = isAccount ? (account.sessionKey || "") : MASTER_SNAPSHOT_KEY;
        if (pullKey) { sendJson(res, 200, { ok: true, assignedProfile, encrypted: profileCrypto.encryptSnapshot(snapshot, pullKey), revision, rulesRevision: await rulesRevisionFor(serviceParam), summary }); return; }
        // Accounts must ALWAYS get a per-session-encrypted snapshot — fail CLOSED, never leak cookies in
        // plaintext just because a session has no key (the admin/master path already refuses below).
        if (isAccount) { sendJson(res, 403, { ok: false, error: "export-blocked", reason: "no-session-key" }); return; }
        if (ALLOW_PLAINTEXT_SNAPSHOT) { sendJson(res, 200, { ok: true, snapshot, revision, summary }); return; }
        sendJson(res, 403, { ok: false, error: "Admin plaintext snapshot disabled. Set CENTRIX_MASTER_SNAPSHOT_KEY (base64 32B) or CENTRIX_ALLOW_PLAINTEXT_SNAPSHOT=1." });
        return;
      }

      if (req.method === "GET" && pathname === "/api/profile/revision") {
        const revServiceParam = url.searchParams.get("service");
        if (PROFILE_FROM_DB && revServiceParam) {
          // POOL mode: report the revision of the POOL profile assigned to THIS user for THIS service, so a
          // WARM App User tab can detect a manager re-seed and re-pull. READ-ONLY peek (no re-pick, no TTL
          // refresh, no disk write) and user-scoped — a service the user was never assigned returns null, so
          // this neither mutates the pool nor leaks another user's/service's slot (unlike assignProfile).
          const revUserId = isAccount ? localDb.sanitizeId(account.userId, "local-user") : (url.searchParams.get("userId") || "anon");
          const revAssigned = await pool.peekAssignment(revServiceParam, revUserId);
          if (!revAssigned) { sendJson(res, 200, { ok: true, service: revServiceParam, assignedProfile: null, revision: 0, rulesRevision: await rulesRevisionFor(revServiceParam) }); return; }
          sendJson(res, 200, { ok: true, service: revServiceParam, assignedProfile: revAssigned, revision: await profileSnapshot.getRevision(revAssigned), rulesRevision: await rulesRevisionFor(revServiceParam) });
          return;
        }
        const profileId = isAccount ? account.profileId : (url.searchParams.get("profileId") || DEFAULT_PROFILE);
        if (PROFILE_FROM_DB) {
          sendJson(res, 200, { ok: true, profileId: localDb.sanitizeId(profileId, DEFAULT_PROFILE), revision: await profileSnapshot.getRevision(profileId) });
          return;
        }
        const r = await worker.workerRevision({ profileId });
        if (!r.ok) { sendJson(res, 502, { ok: false, error: "worker revision failed", detail: r.error || r.status }); return; }
        sendJson(res, 200, { ok: true, profileId: localDb.sanitizeId(profileId, DEFAULT_PROFILE), revision: r.revision });
        return;
      }

      if (req.method === "POST" && pathname === "/api/profile/import") {
        const payload = await auth.readJsonBody(req);
        const profileId = isAccount ? account.profileId : (payload.profileId || (payload.snapshot && payload.snapshot.profileId) || DEFAULT_PROFILE);
        const deviceId = isAccount ? localDb.sanitizeId(account.deviceId, "device") : localDb.sanitizeId(payload.deviceId || "device", "device");
        let snapshot = payload.snapshot || {};
        if (payload.encrypted) {
          const importKey = isAccount ? (account.sessionKey || "") : MASTER_SNAPSHOT_KEY;
          if (!importKey) { sendJson(res, 400, { ok: false, error: "Missing session key for encrypted import" }); return; }
          try { snapshot = profileCrypto.decryptSnapshot(payload.encrypted, importKey); }
          catch { sendJson(res, 400, { ok: false, error: "decrypt failed" }); return; }
        } else if (isAccount) {
          // Accounts MUST push a per-session-encrypted snapshot (contract §3) — never accept a plaintext
          // account import (a stolen bare token could otherwise blind-overwrite the shared custodian cookies).
          sendJson(res, 400, { ok: false, error: "Encrypted snapshot required for account import" }); return;
        } else if (who.kind === "staff") {
          // Staff is AUTHENTICATED (logged in) + holds the "loader" permission (enforced by the gate) → accept
          // the plaintext snapshot over HTTPS; the backend encrypts it at rest. This is how the Manager App
          // seeds logins WITHOUT embedding any master key — auth + permission + HTTPS + at-rest replace it.
          snapshot = payload.snapshot || {};
        } else if (!ALLOW_PLAINTEXT_SNAPSHOT) {
          sendJson(res, 403, { ok: false, error: "Admin plaintext snapshot import disabled. Use CENTRIX_MASTER_SNAPSHOT_KEY or CENTRIX_ALLOW_PLAINTEXT_SNAPSHOT=1." });
          return;
        }
        // Defense-in-depth: scope an account's imported cookies/storage to its GRANTED services so a
        // compromised token cannot inject cross-service cookies into the shared custodian (even if it holds
        // the lock). The admin/master import stays full.
        if (isAccount) {
          const cfg = await readServicesConfig();
          const granted = ((await localDb.servicesForUser(cfg, account.userId)).config || {}).services || [];
          snapshot = cookieScope.scopeSnapshotToServices(snapshot, granted);
        }
        // RULES-WITH-PROFILE: uiRules is an EXPORT-response-only key (resolved fresh from the DB on
        // every export). It must NEVER reach the at-rest blob — a verbatim re-import of an export
        // (ops migration, harness replay, or a hostile account push with an oversized/malicious
        // uiRules payload) would otherwise freeze rules-of-that-day into the shared profile forever.
        if (snapshot && typeof snapshot === "object" && "uiRules" in snapshot) {
          const { uiRules: _dropUiRules, ...cleanSnapshot } = snapshot;
          snapshot = cleanSnapshot;
        }
        // snapshot is already service-scoped for accounts (above), so the store-side scope is a no-op here.
        const put = PROFILE_FROM_DB
          ? await profileSnapshot.putSnapshotFromImport(profileId, snapshot, { baseRevision: payload.baseRevision })
          : await worker.putRawSnapshot({ profileId, snapshot, deviceId, singleDevice: isAccount && PROFILE_SINGLE_DEVICE, baseRevision: payload.baseRevision });
        if (!put.ok) {
          const code = put.error === "profile-locked-by-other" ? 423 : (put.error === "stale-revision" ? 409 : 502);
          sendJson(res, code, { ok: false, error: put.error || "import failed", revision: put.revision }); return;
        }
        let pooledServices = null;
        if (PROFILE_FROM_DB) {
          // Update the service POOL: which services this profile can now serve (and drop dead ones). Surface
          // WHICH services it pooled so the Manager can tell a real seed from "stored but pools nothing" (a
          // capture-before-login) — that silent gap is what left services returning export 404 no-profile.
          try {
            const full = await profileSnapshot.getSnapshotForExport(profileId, { scopeCookies: false });
            if (full.snapshot) pooledServices = await pool.indexProfile(profileId, full.snapshot, (await readServicesConfig()).services || []);
          } catch (e) { pooledServices = null; console.warn("[centrix-backend] pool index failed on import:", e?.message || e); }
        }
        sendJson(res, 200, { ok: true, profileId, revision: put.revision, result: put.result, pooledServices }); return;
      }

      if (req.method === "POST" && pathname === "/api/profile/lock") {
        const payload = await auth.readJsonBody(req);
        const profileId = isAccount ? account.profileId : (payload.profileId || DEFAULT_PROFILE);
        // DB-snapshot mode has no live custodian to lock — concurrency is optimistic via baseRevision on import.
        if (PROFILE_FROM_DB) { sendJson(res, 200, { ok: true, locked: true, mode: "db", profileId: localDb.sanitizeId(profileId, DEFAULT_PROFILE), revision: await profileSnapshot.getRevision(profileId) }); return; }
        const deviceId = isAccount ? localDb.sanitizeId(account.deviceId, "device") : localDb.sanitizeId(payload.deviceId, "device");
        const r = await worker.workerLock({ profileId, deviceId, userId: isAccount ? localDb.sanitizeId(account.userId, "local-user") : undefined });
        if (!r.ok && (!r.status || r.status >= 500)) { sendJson(res, 502, { ok: false, error: "worker lock failed", detail: r.error }); return; }
        sendJson(res, r.ok ? 200 : 423, r); return;
      }
      if (req.method === "POST" && pathname === "/api/profile/release") {
        const payload = await auth.readJsonBody(req);
        const profileId = isAccount ? account.profileId : (payload.profileId || DEFAULT_PROFILE);
        if (PROFILE_FROM_DB) { sendJson(res, 200, { ok: true, released: true, mode: "db" }); return; }
        const deviceId = isAccount ? localDb.sanitizeId(account.deviceId, "device") : localDb.sanitizeId(payload.deviceId, "device");
        const r = await worker.workerRelease({ profileId, deviceId, userId: isAccount ? localDb.sanitizeId(account.userId, "local-user") : undefined });
        sendJson(res, 200, r); return;
      }
      if (req.method === "POST" && pathname === "/api/profile/takeover") {
        if (!isAccount) { sendJson(res, 403, { ok: false, error: "Forbidden" }); return; }
        if (PROFILE_FROM_DB) { sendJson(res, 200, { ok: true, evicting: false, mode: "db" }); return; }
        const r = await worker.workerTakeover({ profileId: account.profileId, userId: localDb.sanitizeId(account.userId, "local-user"), deviceId: localDb.sanitizeId(account.deviceId, "device") });
        sendJson(res, 200, r); return;
      }
    }

    // ===================== AUTO RE-SEED — tín hiệu mất phiên + hàng đợi cho Manager worker ================
    // App User (account) báo dịch vụ bị đá về /login → single-flight 1 job/dịch vụ. Manager worker (staff
    // loader) poll job → login lại → đẩy snapshot → báo done. Bọc sau CENTRIX_AUTO_RESEED.
    // Worker (staff loader) lấy credential đã giải mã của (service, slot) để tự đăng nhập lại.
    if (AUTO_RESEED_ENABLED && req.method === "GET" && pathname === "/api/manager/vault-entry") {
      const svc = String(url.searchParams.get("service") || "").toLowerCase().trim();
      const slot = Math.max(1, Number(url.searchParams.get("slot")) || 1);
      const entry = serviceVault.getSecret(svc, slot);
      if (!entry) { sendJson(res, 404, { ok: false, error: "no-vault-entry" }); return; }
      sendJson(res, 200, { ok: true, entry }); return;
    }
    // Worker báo trạng thái slot sau seed (alive/dead) → web admin thấy sống/chết.
    if (AUTO_RESEED_ENABLED && req.method === "POST" && pathname === "/api/manager/vault-status") {
      const b = await auth.readJsonBody(req);
      await serviceVault.setStatus(String(b.service || "").toLowerCase().trim(), Math.max(1, Number(b.slot) || 1), b.status === "alive" ? "alive" : "dead", b.error, new Date().toISOString());
      sendJson(res, 200, { ok: true }); return;
    }
    // App User (account) báo 1 slot pool chạm weekly/usage limit của Claude → cooldown slot đó (loại tạm khỏi
    // assign tới mốc reset) → user tự rotate sang slot khác. KHÁC session-dead: cookie VẪN sống, KHÔNG re-login.
    // Không gate theo AUTO_RESEED (cooldown độc lập với reseed).
    if (req.method === "POST" && pathname === "/api/pool/slot-cooldown") {
      const body = await auth.readJsonBody(req);
      const svc = String(body.service || body.serviceId || "").toLowerCase().trim();
      if (!svc) { sendJson(res, 400, { ok: false, error: "missing-service" }); return; }
      const slot = Math.max(1, Number(body.slot) || 1);
      const untilMs = Number(body.untilMs) || 0; // mốc reset Claude parse ở client (0 → pool tự fallback DEFAULT)
      const reason = String(body.reason || "weekly-limit").slice(0, 40);
      const r = await pool.setSlotCooldown({ serviceId: svc, slot, untilMs, reason });
      const uid = who.kind === "account" ? localDb.sanitizeId((who.account || {}).userId, "local-user") : "staff";
      console.log("[cooldown] slot-cooldown", svc, "slot", slot, "by", uid, "reason=" + reason, "→ until=" + ((r && r.untilIso) || "?"));
      sendJson(res, 200, { ok: true, ...r });
      return;
    }
    if (AUTO_RESEED_ENABLED && (pathname === "/api/pool/session-dead" || pathname === "/api/manager/reseed-jobs" || pathname === "/api/manager/reseed-done" || pathname === "/api/admin/pool/reseed-now")) {
      // App User báo "session chết"
      if (req.method === "POST" && pathname === "/api/pool/session-dead") {
        const body = await auth.readJsonBody(req);
        const svc = String(body.service || "").toLowerCase().trim();
        if (!svc) { sendJson(res, 400, { ok: false, error: "missing-service" }); return; }
        const slot = Math.max(1, Number(body.slot) || 1); // slot App User được cấp (client cũ không gửi → mặc định 1)
        const key = reseedKey(svc, slot);
        reseedPrune();
        const uid = who.kind === "account" ? localDb.sanitizeId((who.account || {}).userId, "local-user") : "staff";
        const reportUrl = typeof body.url === "string" ? body.url.slice(0, 500) : "";
        const now = Date.now();
        const existing = reseedState.get(key);
        if (existing && existing.state === "pending") { existing.reporters.add(uid); if (!existing.url && reportUrl) existing.url = reportUrl; sendJson(res, 200, { ok: true, status: "in-progress" }); return; }
        if (existing && existing.state === "cooling" && now - (existing.at || 0) < RESEED_COOLING_MS) { sendJson(res, 200, { ok: true, status: "cooling" }); return; } // vừa seed → chờ kéo phiên đó, đừng đẻ seed mới
        reseedState.set(key, { at: now, state: "pending", reporters: new Set([uid]), claimedAt: 0, url: reportUrl, service: svc, slot });
        console.log("[reseed] session-dead", svc, "slot", slot, "by", uid, "url=" + reportUrl, "→ job queued");
        sendJson(res, 200, { ok: true, status: "queued" }); return;
      }
      // Manager worker: lấy danh sách dịch vụ cần re-seed (đánh dấu đã nhận để không log trùng)
      if (req.method === "GET" && pathname === "/api/manager/reseed-jobs") {
        reseedPrune();
        const jobs = [];
        for (const [key, v] of reseedState) { if (v.state !== "pending") continue; v.claimedAt = v.claimedAt || Date.now(); jobs.push({ service: v.service || String(key).split("::")[0], slot: v.slot || 1, at: v.at, reporters: v.reporters.size, url: v.url || "", force: !!v.force }); }
        sendJson(res, 200, { ok: true, jobs }); return;
      }
      // ADMIN ép seed NGAY 1 slot (nút "Seed lại" trên web) → tạo job pending → worker login lại bằng vault.
      if (req.method === "POST" && pathname === "/api/admin/pool/reseed-now") {
        const b = await auth.readJsonBody(req);
        const svc = String(b.service || "").toLowerCase().trim();
        if (!svc) { sendJson(res, 400, { ok: false, error: "missing-service" }); return; }
        const slot = Math.max(1, Number(b.slot) || 1);
        reseedPrune();
        const ent = serviceVault.getSecret(svc, slot);
        reseedState.set(reseedKey(svc, slot), { at: Date.now(), state: "pending", reporters: new Set(["admin"]), claimedAt: 0, url: (ent && ent.loginUrl) || "", force: b.force !== false, service: svc, slot });
        console.log("[reseed] ADMIN reseed-now", svc, "slot", slot, "force=" + (b.force !== false) + " → job queued");
        sendJson(res, 200, { ok: true, status: "queued" }); return;
      }
      // Manager worker: báo re-seed xong (gỡ cờ single-flight) — ok:false thì vẫn gỡ để lần sau thử lại
      if (req.method === "POST" && pathname === "/api/manager/reseed-done") {
        const body = await auth.readJsonBody(req);
        const svc = String(body.service || "").toLowerCase().trim();
        const slot = Math.max(1, Number(body.slot) || 1);
        const key = reseedKey(svc, slot);
        // Vào COOLING (không xoá hẳn) → chặn seed mới trong RESEED_COOLING_MS để cả nhóm kéo phiên vừa seed. Cooling
        // theo TỪNG slot (cooling slot 1 không chặn seed slot 2).
        if (svc) { const prev = reseedState.get(key) || {}; reseedState.set(key, { at: Date.now(), state: "cooling", reporters: new Set(), claimedAt: 0, url: prev.url || "", service: svc, slot }); }
        console.log("[reseed] reseed-done", svc, "slot", slot, "ok=" + (body.ok !== false) + " → cooling " + Math.round(RESEED_COOLING_MS / 1000) + "s");
        sendJson(res, 200, { ok: true }); return;
      }
    }

    // ===================== LOADER seam (B5) — drive the custodian login browser from the website ==========
    // Admin/staff(loader) only (these paths are NOT in ACCOUNT_ALLOWED_PATHS → accounts 403 at the gate).
    // Off unless CENTRIX_LOADER_VIA_WORKER=1. /api/frame streams the PNG; the rest return { ok, state }.
    if (LOADER_VIA_WORKER) {
      if (req.method === "GET" && pathname === "/api/frame") {
        const tabId = url.searchParams.get("tabId") || "tab-a";
        const r = await worker.workerLoader("frame", tabId, {});
        if (!r.ok || !r.framePng) { sendJson(res, 502, { ok: false, error: "worker frame failed", detail: r.error || r.status }); return; }
        const png = Buffer.from(r.framePng, "base64");
        res.writeHead(200, responseHeaders("image/png", png.length));
        res.end(png);
        return;
      }
      const LOADER_VERB = {
        "/api/open": "open", "/api/navigate": "navigate", "/api/back": "back", "/api/forward": "forward",
        "/api/reload": "reload", "/api/show": "show", "/api/hide": "hide", "/api/devtools": "devtools",
        "/api/resize": "resize", "/api/click": "click", "/api/move": "move", "/api/wheel": "wheel",
        "/api/type": "type", "/api/key": "key", "/api/close": "close", "/api/service/login-status": "login-status",
      };
      if (LOADER_VERB[pathname]) {
        const args = req.method === "POST" ? await auth.readJsonBody(req) : Object.fromEntries(url.searchParams.entries());
        const tabId = args.tabId || url.searchParams.get("tabId") || "tab-a";
        const r = await worker.workerLoader(LOADER_VERB[pathname], tabId, args);
        if (!r.ok && (!r.status || r.status >= 500)) { sendJson(res, 502, { ok: false, error: "worker loader failed", detail: r.error }); return; }
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }
    }

    // ---- services: account callers get a SCOPED config (granted services only); admin gets the raw one ----
    if (req.method === "GET" && (pathname === "/api/services" || pathname === "/api/admin/services")) {
      const config = await readServicesConfig();
      if (who.kind === "account") {
        const scopeUserId = localDb.sanitizeId(who.account.userId, "local-user");
        const scoped = await localDb.servicesForUser(config, scopeUserId);
        sendJson(res, 200, {
          ok: true, source: "server-api",
          serviceCount: (scoped.config && scoped.config.services && scoped.config.services.length) || 0,
          config: scoped.config, services: (scoped.config && scoped.config.services) || [],
          user: scoped.user, uiRules: scoped.uiRules, modelPolicies: scoped.modelPolicies || [], localDbPath: scoped.filePath,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true, source: "server-api",
        serviceCount: (config && config.services && config.services.length) || 0,
        config, services: (config && config.services) || [],
      });
      return;
    }

    // ---- App-User self credit (account-scoped, lean Docker read — same payload the App User polls) ----
    if (req.method === "GET" && pathname === "/api/me") {
      const isAccount = who.kind === "account";
      const meUserId = isAccount
        ? localDb.sanitizeId(who.account.userId, "local-user")
        : localDb.sanitizeId(url.searchParams.get("userId") || "local-user", "local-user");
      const summary = await localDb.getUserCreditSummary(meUserId).catch(() => null);
      const wallet = (summary && summary.wallet) || {};
      const userTxns = Array.isArray(summary && summary.transactions) ? summary.transactions : [];
      const userActivity = Array.isArray(summary && summary.activity) ? summary.activity : [];
      const today = new Date().toISOString().slice(0, 10);
      const month = new Date().toISOString().slice(0, 7);
      const debits = userTxns.filter((tx) => tx.type === "debit");
      const spentToday = debits.filter((tx) => String(tx.createdAt || "").slice(0, 10) === today).reduce((s, tx) => s + Math.abs(Number(tx.amountDelta || 0)), 0);
      const spentThisMonth = debits.filter((tx) => String(tx.createdAt || "").slice(0, 7) === month).reduce((s, tx) => s + Math.abs(Number(tx.amountDelta || 0)), 0);
      const recentTransactions = userTxns.slice(-40).reverse().map((tx) => ({
        type: tx.type || "", amountDelta: Number(tx.amountDelta || 0), balanceAfter: Number(tx.balanceAfter || 0),
        modelId: tx.modelId || "", serviceId: tx.serviceId || "", reason: tx.reason || "", createdAt: tx.createdAt || "",
      }));
      const histItems = recentTransactions.map((t) => ({ kind: t.type, modelId: t.modelId, serviceId: t.serviceId, amountDelta: t.amountDelta, createdAt: t.createdAt }));
      const opensRaw = [], logins = [];
      for (const a of userActivity) {
        const at = a.createdAt || a.at || "";
        if (!at) continue;
        if (a.action === "open-service") {
          opensRaw.push({ kind: "open-service", serviceId: a.serviceId || "", serviceName: a.title || a.serviceId || "", createdAt: at });
        } else if (a.action === "login" || a.action === "login-new-device") {
          let deviceId = "";
          try { deviceId = String(JSON.parse(a.details || "{}").deviceId || ""); } catch { /* ignore */ }
          logins.push({ kind: a.action, deviceId, email: a.title || "", createdAt: at });
        }
      }
      opensRaw.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const opens = [];
      for (const o of opensRaw) { const prev = opens[opens.length - 1]; if (prev && prev.serviceId === o.serviceId) continue; opens.push(o); if (opens.length >= 15) break; }
      logins.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const recentHistory = [...histItems, ...opens, ...logins.slice(0, 5)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 40);
      sendJson(res, 200, {
        ok: true, userId: meUserId, email: isAccount ? who.account.email : "",
        balance: Number(wallet.balance || 0), lifetimeAdded: Number(wallet.lifetimeAdded || 0), lifetimeSpent: Number(wallet.lifetimeSpent || 0),
        moneyBalance: Number(wallet.moneyBalance || 0), moneyLifetimeAdded: Number(wallet.moneyLifetimeAdded || 0), moneyLifetimeSpent: Number(wallet.moneyLifetimeSpent || 0), // ví VND
        spentToday, spentThisMonth, recentTransactions, recentHistory,
      });
      return;
    }

    // ---- App-User self READ routes (account-scoped GET reads) — ported from the App Server so the App User's
    // activity / url-history / localStorage / ui-cache / portal panels work on the backend. The POST writers for
    // these already exist below; this adds the missing GET variants (were 405 via the POST-only gate).
    if (req.method === "GET" && (pathname === "/api/users/activity" || pathname === "/api/users/url-history"
      || pathname === "/api/users/local-store" || pathname === "/api/users/ui-cache" || pathname.startsWith("/api/users/portal/"))) {
      const acct = who.kind === "account";
      const uId = acct ? localDb.sanitizeId(who.account.userId, "local-user") : localDb.sanitizeId(url.searchParams.get("userId") || "local-user", "local-user");
      const pId = acct ? localDb.sanitizeId(who.account.profileId, DEFAULT_PROFILE) : (url.searchParams.get("profileId") || DEFAULT_PROFILE);
      const serviceId = url.searchParams.get("serviceId") || "";
      if (pathname === "/api/users/activity") {
        const limit = Math.max(1, Math.min(500, Math.round(Number(url.searchParams.get("limit") || 250))));
        const r = await localDb.getUserActivity({ userId: uId, profileId: pId, serviceId, limit });
        sendJson(res, 200, { ok: true, activity: r.activity || [] }); return;
      }
      if (pathname === "/api/users/url-history") {
        const limit = Math.max(1, Math.min(300, Math.round(Number(url.searchParams.get("limit") || 300))));
        const r = await localDb.getUrlHistory({ userId: uId, limit });
        sendJson(res, 200, { ok: true, urlHistory: r.urlHistory || [] }); return;
      }
      if (pathname === "/api/users/local-store") {
        const origin = url.searchParams.get("origin") || "";
        sendJson(res, 200, { ok: true, store: await localDb.getUserLocalStore({ userId: uId, profileId: pId, serviceId, origin }) }); return;
      }
      if (pathname === "/api/users/ui-cache") {
        sendJson(res, 200, { ok: true, cache: await localDb.getUserUiCache({ userId: uId, profileId: pId, serviceId }) }); return;
      }
      // /api/users/portal/* (summary etc.) — the App User reads its billing/portal snapshot here.
      const portal = await localDb.getUserPortal({ userId: uId });
      portal.paymentConfig = vietqrPaymentConfig(); // tài khoản nhận VietQR (App User dựng QR); thiếu field này = không thanh toán được
      sendJson(res, 200, { ok: true, portal, summary: {
        balance: Number((portal.wallet && portal.wallet.balance) || 0),
        packages: (portal.packages || []).length, orders: (portal.orders || []).length,
        invoices: (portal.invoices || []).length, tickets: (portal.tickets || []).length,
      } });
      return;
    }

    // ---- admin / manager READ routes (parity with the App Server, same Docker DB) ----
    // NOTE: the App Server bundles the full ~12MB `db` in these; the backend returns lean named slices
    // (same as /api/admin/summary). Re-add `db` only if a cutover diff shows the bridge consumes it.
    if (req.method === "GET" && pathname === "/api/users") {
      const db = await localDb.readLocalDb();
      const cfg = await readServicesConfig();
      sendJson(res, 200, {
        ok: true, users: db.users || [], services: cfg.services || [],
        // accounts (email map) + creditWallets/creditTransactions are what the admin user table joins onto each
        // user for email/plan/credit columns. App Server's /api/users ships these; without them 18778 showed
        // user IDs with blank email/credit ("không đồng bộ với bản 19778").
        accounts: db.accounts || [], creditWallets: db.creditWallets || [], creditTransactions: db.creditTransactions || [], moneyTransactions: (db.moneyTransactions || []).slice(-250),
        serviceVisibility: db.serviceVisibility || [], uiRules: db.uiRules || [], uiRuleReports: (db.uiRuleReports || []).slice(-300),
        modelPolicies: db.modelPolicies || [], modelPrices: db.modelPrices || [], modelUsage: db.modelUsage || [], modelObservations: db.modelObservations || [],
        // Activity log + UI-cache admin views read these from /api/users' main refresh (the SPA never calls the
        // dedicated /api/users/activity|ui-cache sub-routes). CAPPED slices (not the full 2000+ rows) — this is the
        // hottest endpoint; shipping every row on each poll bloated the response + blocked the event loop on stringify.
        activity: (db.activity || []).slice(-250), uiCacheItems: (db.uiCacheItems || []).slice(-300), uiCacheCount: (db.uiCacheItems || []).length, localStoreCount: (db.localStoreCount != null ? db.localStoreCount : (db.localStore || []).length),
      });
      return;
    }
    if (req.method === "GET" && pathname === "/api/admin/credits/ledger") {
      const sp = url.searchParams;
      // Có filter/phân trang → query TRỰC TIẾP (không cap ~2000 như snapshot) để dịch vụ ít dùng (Claude...) hiện lại.
      if (sp.has("q") || sp.has("serviceId") || sp.has("userId") || sp.has("limit") || sp.has("offset")) {
        try {
          const r = await localDb.queryCreditTransactions({
            userId: sp.get("userId") || "",
            serviceId: sp.get("serviceId") || "",
            q: sp.get("q") || "",
            limit: Number(sp.get("limit")) || 20,
            offset: Number(sp.get("offset")) || 0,
          });
          sendJson(res, 200, { ok: true, transactions: r.transactions || [], total: r.total || 0, limit: r.limit, offset: r.offset });
        } catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "ledger-query-failed" }); }
        return;
      }
      const db = await localDb.readLocalDb();
      sendJson(res, 200, { ok: true, wallets: db.creditWallets || [], transactions: db.creditTransactions || [] });
      return;
    }
    if (req.method === "GET" && pathname === "/api/admin/model-prices") {
      const db = await localDb.readLocalDb();
      sendJson(res, 200, { ok: true, modelPrices: db.modelPrices || [] });
      return;
    }
    if (req.method === "GET" && pathname === "/api/admin/summary") {
      const r = await localDb.getAdminSummary();
      sendJson(res, 200, { ok: true, summary: r.summary });
      return;
    }
    // Admin-console staff accounts + roles (Nhóm & Phân quyền). loadStaffAdmin() reads result.accounts /
    // result.roles DIRECTLY (not portal/db) → dedicated routes; they must NOT be portal-aliased (aliasing
    // /api/admin/roles made it return {portal,db} → SPA r.roles undefined → the roles panel rendered empty).
    if (req.method === "GET" && pathname === "/api/admin/staff") {
      const r = await localDb.adminAccountList();
      sendJson(res, 200, { ok: true, accounts: (r && r.accounts) || [] });
      return;
    }
    if (req.method === "GET" && pathname === "/api/admin/roles") {
      const r = await localDb.adminRoleList();
      sendJson(res, 200, { ok: true, roles: (r && r.roles) || [] });
      return;
    }

    // These admin panels (Tổ chức/B2B, Khuyến mãi, Cài đặt, Hỗ trợ, Hóa đơn) all read the SAME portal
    // snapshot — the App Server aliases them to /api/admin/portal. Without the aliases the backend 404'd them, so
    // those panels fell back to the design's demo data on 18778. Include `db` for parity with the App Server.
    if (req.method === "GET" && [
      "/api/admin/portal", "/api/admin/organizations", "/api/admin/billing",
      "/api/admin/support", "/api/admin/settings", "/api/admin/promotions",
    ].includes(pathname)) {
      const snap = await localDb.getPortalSnapshot();
      sendJson(res, 200, { ok: true, portal: snap.portal, db: snap.db });
      return;
    }
    if (req.method === "GET" && pathname === "/api/admin/livechat") {
      const r = await localDb.getLivechatThreads();
      sendJson(res, 200, { ok: true, threads: (r && r.threads) || [] });
      return;
    }
    if (req.method === "GET" && pathname === "/api/admin/pool") {
      const cfg = await readServicesConfig();
      sendJson(res, 200, {
        ok: true,
        pool: await pool.poolStatus(cfg.services || []),
        assignments: await pool.poolAssignments(), // AI đang dùng profile(slot) nào của dịch vụ nào
        recentAssignments: await pool.poolRecentAssignments(), // gán ĐÃ hết TTL trong 24h (phiên dài, tab mở > TTL)
        profiles: await pool.poolProfiles(), // profile Manager đã đẩy (revision/updatedAt/services + capacity)
        capacity: await pool.getCapacity(), // sức chứa {default, byService, byProfile}
        cooldowns: await pool.getCooldowns(), // slot đang bị loại tạm (weekly/usage limit) + mốc reset
      });
      return;
    }
    // Thông báo App User (marquee) — admin đọc để sửa (trả FULL text kể cả khi tắt). Admin.
    if (req.method === "GET" && pathname === "/api/admin/announcement") {
      sendJson(res, 200, { ok: true, announcement: await readAnnouncementCached() });
      return;
    }
    // Danh sách tài khoản dịch vụ (vault) — KHÔNG kèm secret thật (chỉ cờ hasPassword/hasTotp). Admin.
    if (req.method === "GET" && pathname === "/api/admin/service-accounts") {
      sendJson(res, 200, { ok: true, accounts: serviceVault.list(), hasKey: serviceVault.hasKey() });
      return;
    }
    // Electron-only control endpoints the admin SPA's refresh() STILL calls. The headless backend has no in-app
    // tunnel/tab control, but refresh() does getJson("/api/tabs") WITHOUT a .catch (api-ui-bridge.js:4007) → a 405
    // here REJECTS the whole Promise.all → EVERY admin panel renders empty (this is the real "18778 thiếu mọi UI"
    // bug, not login). Return benign stubs so the SPA hydrates normally. (/api/tunnel + /api/tunnel/config are
    // already .catch(()=>null) in the SPA, but stub them too for a clean connection panel — the real tunnel is the
    // external cloudflared service, managed outside the app.)
    if (req.method === "GET" && pathname === "/api/tabs") { sendJson(res, 200, { ok: true, tabs: [] }); return; }
    if (req.method === "GET" && pathname === "/api/tunnel") { sendJson(res, 200, { ok: true, tunnel: { supported: false, running: false, status: "n/a", mode: "external", message: "Tunnel do cloudflared (ngoài ứng dụng) quản lý", config: {}, publicUrl: "", hostname: "" } }); return; }
    if (req.method === "GET" && pathname === "/api/tunnel/config") { sendJson(res, 200, { ok: true, config: {} }); return; }

    // ===================== WRITE routes (POST, pure DB) ============================================
    // In-memory/Electron coordination (profile lock/release/takeover, user-tabs heartbeat/close, ui-rules
    // preview/select, tunnel, loader verbs, profile import/export) stays on the worker → 404 here.
    if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "Method not allowed", pathname }); return; }
    const payload = await auth.readJsonBody(req);
    // Xóa 1 profile đã đẩy (gỡ pool + hủy gán + xóa snapshot). Admin (loader). Đặt SAU khi payload đã parse.
    if (pathname === "/api/admin/pool/delete-profile") {
      const r = await pool.removeProfile(payload.profileId);
      sendJson(res, r.ok ? 200 : 400, r);
      return;
    }
    // Đặt sức chứa (số user/slot) — scope: profile|service|default; value<1 = xóa override. Admin (loader).
    if (pathname === "/api/admin/pool/capacity") {
      const r = await pool.setPoolCapacity({ scope: payload.scope, key: payload.key, value: payload.value });
      sendJson(res, r.ok ? 200 : 400, r);
      return;
    }
    // Gỡ cooldown 1 slot (cho slot dùng lại NGAY, không đợi mốc reset). Admin (loader).
    if (pathname === "/api/admin/pool/clear-cooldown") {
      const r = await pool.clearSlotCooldown(payload.profileId);
      sendJson(res, r.ok ? 200 : 400, r);
      return;
    }
    // Đặt/tắt thông báo marquee App User (đẩy xuống mọi App User qua /api/health). Admin.
    if (pathname === "/api/admin/announcement") {
      const data = await writeAnnouncement({ text: payload.text, tone: payload.tone, enabled: payload.enabled });
      sendJson(res, 200, { ok: true, announcement: data });
      return;
    }
    // VAULT TẬP TRUNG — quản lý tài khoản dịch vụ / slot cho auto-login (web admin). Admin.
    if (pathname === "/api/admin/service-accounts/save") {
      if (!serviceVault.hasKey()) { sendJson(res, 400, { ok: false, error: "no-vault-key", reason: "Backend chưa đặt CENTRIX_VAULT_KEY (base64 32B) để mã hoá vault." }); return; }
      try { const r = await serviceVault.upsert(payload, new Date().toISOString()); sendJson(res, 200, { ok: true, account: r }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "save-failed" }); }
      return;
    }
    if (pathname === "/api/admin/service-accounts/delete") {
      const r = await serviceVault.remove(String(payload.id || ""));
      sendJson(res, 200, r);
      return;
    }
    const isAccount = who.kind === "account";
    const account = who.account || {};
    const scopedUserId = requestUserId(req, url, payload);
    const scopedProfileId = requestProfileId(req, url, payload);
    const effectiveUserId = isAccount ? localDb.sanitizeId(account.userId, "local-user") : scopedUserId;
    const effectiveProfileId = isAccount ? localDb.sanitizeId(account.profileId, DEFAULT_PROFILE) : scopedProfileId;

    // ----- Org self-service (org-admin account) — ported from the App Server. callerUserId is FORCED from the
    // authenticated token (after the payload spread) so account A can never act as account B; the data layer
    // (require_org_admin) checks the caller owns/admins the target org. Org-fund top-up stays MASTER-only (elsewhere).
    {
      const ORG_ROUTES = {
        "/api/users/org/structure": ["orgStructure", "Loi to chuc"],
        "/api/users/org/department": ["orgAddDepartment", "Loi them phong ban"],
        "/api/users/org/member": ["orgAddMember", "Loi them thanh vien"],
        "/api/users/org/allocate": ["orgAllocateCredit", "Loi phan bo"],
        "/api/users/org/billing": ["orgUpdateBilling", "Loi luu thong tin thanh toan"],
        "/api/users/org/report": ["orgReport", "Loi bao cao"],
        "/api/users/org/set-entitlement": ["orgSetEntitlement", "Loi dat han muc"],
        "/api/users/org/remove-member": ["orgRemoveMember", "Loi go thanh vien"],
        "/api/users/org/department-delete": ["orgDeleteDepartment", "Loi xoa phong ban"],
        "/api/users/org/set-role": ["orgSetMemberRole", "Loi doi vai tro"],
        "/api/users/org/set-locked": ["orgSetMemberLocked", "Loi khoa thanh vien"],
      };
      const org = ORG_ROUTES[pathname];
      if (org) {
        if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
        try { sendJson(res, 200, await localDb[org[0]]({ ...payload, callerUserId: effectiveUserId })); }
        catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || org[1] }); }
        return;
      }
    }

    // ----- App-User self: logout (revoke OWN session) + tab heartbeat/close (no-op in DB-mode) -----
    if (pathname === "/api/auth/self-revoke") {
      // Revoke ONLY the caller's own token (from the authenticated header, never the body) — account logout.
      const selfToken = isAccount ? auth.headerTokenOf(req) : "";
      if (!selfToken) { sendJson(res, 400, { ok: false, error: "No account session to revoke" }); return; }
      await localDb.revokeSession({ token: selfToken });
      sendJson(res, 200, { ok: true });
      return;
    }
    // ----- App-User self: HARD-DELETE own account + ALL data (irreversible). Target is ALWAYS effectiveUserId
    // (forced from the token, never the body) so account A can never delete account B. Refuses if the account
    // owns an org (409 + code ORG_OWNER). On success the Docker purge already dropped the session; revoke the
    // caller token too for good measure so the deleted account's token is dead immediately.
    if (pathname === "/api/users/delete-account") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      let result;
      try { result = await localDb.deleteUserAccount({ userId: effectiveUserId, email: account.email }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Loi xoa tai khoan" }); return; }
      if (result && result.ok === false) { sendJson(res, 409, result); return; } // org-owner refusal etc.
      try { const selfToken = auth.headerTokenOf(req); if (selfToken) await localDb.revokeSession({ token: selfToken }); } catch { /* best-effort */ }
      sendJson(res, 200, { ok: true, deleted: true });
      return;
    }
    if (pathname === "/api/user-tabs/heartbeat" || pathname === "/api/user-tabs/close") {
      // Live tab/device coordination lived in the Electron worker. In DB-mode the single-device lock is enforced
      // via the profile lock + the /api/me 401 path, so these are safe no-ops (the App User tolerates them).
      sendJson(res, 200, { ok: true, mode: "db-noop" });
      return;
    }

    // ----- admin: settings / session revoke -----
    if (pathname === "/api/local-db/reset") { const db = await localDb.resetLocalDb(); sendJson(res, 200, { ok: true, db }); return; }
    if (pathname === "/api/auth/revoke") {
      const result = await localDb.revokeSession({ token: payload.token, userId: payload.userId, deviceId: payload.deviceId });
      sendJson(res, 200, { ok: true, ...result }); return;
    }
    if (pathname === "/api/users/change-password") {
      if (!isAccount || !account.email) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      const currentPassword = String(payload.currentPassword || ""), newPassword = String(payload.newPassword || "");
      if (newPassword.length < 6) { sendJson(res, 400, { ok: false, error: "Mat khau moi phai tu 6 ky tu tro len" }); return; }
      if (newPassword === currentPassword) { sendJson(res, 400, { ok: false, error: "Mat khau moi phai khac mat khau hien tai" }); return; }
      try { await localDb.changeAccountPassword({ email: account.email, currentPassword, newPassword }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Doi mat khau that bai" }); return; }
      localDb.recordUserActivity({ userId: account.userId, deviceId: account.deviceId, profileId: account.profileId || DEFAULT_PROFILE, serviceId: "auth", action: "change-password", title: account.email || "", details: JSON.stringify({ ip: clientIp(req) }) }).catch(() => {});
      sendJson(res, 200, { ok: true }); return;
    }

    // ----- users / pricing / access -----
    if (pathname === "/api/users/save") { const db = await localDb.upsertUser(payload.user || payload); sendJson(res, 200, { ok: true, db }); return; }
    if (pathname === "/api/users/service") { const db = await localDb.setUserServiceVisibility(payload.userId || scopedUserId, payload.serviceId, payload.visible !== false); sendJson(res, 200, { ok: true, db }); return; }
    if (pathname === "/api/users/ui-rules") { const db = await localDb.setUserUiRules(payload.userId || scopedUserId, payload.serviceId, payload.hideSelectors || [], payload.enabled === true, payload.replaceRules || [], payload.hideRules || [], payload.userScript || "", payload.customCss || ""); sendJson(res, 200, { ok: true, db }); return; }
    if (pathname === "/api/users/blocked-links") { const db = await localDb.setUserBlockedLinks({ userId: payload.userId || "service-rule", links: payload.links || [] }); sendJson(res, 200, { ok: true, db }); return; }
    if (pathname === "/api/users/model-policy") { const db = await localDb.setUserModelPolicy({ ...payload, userId: payload.userId || scopedUserId, serviceId: payload.serviceId }); sendJson(res, 200, { ok: true, db }); return; }
    if (pathname === "/api/users/model-usage/check") {
      // BỎ EFFORT ngay tại cửa vào: model chính dùng cho CẢ tính giá (checkUserModelUsage) LẪN ghi nhận
      // (observeModel/recordUserActivity) → bảng giá + "model ghi nhận" chỉ còn model chính. Áp cho mọi client.
      if (payload.modelId) payload.modelId = stripModelEffort(payload.modelId);
      if (payload.detectedModelId) payload.detectedModelId = stripModelEffort(payload.detectedModelId);
      const usageServiceId = localDb.sanitizeId(payload.serviceId || "service", "service");
      const usageConfig = await readServicesConfig().catch(() => null);
      const usageScoped = usageConfig ? await localDb.servicesForUser(usageConfig, effectiveUserId).catch(() => null) : null;
      const usageService = ((usageScoped && usageScoped.config && usageScoped.config.services) || (usageConfig && usageConfig.services) || []).find((s) => localDb.sanitizeId(s.id, "service") === usageServiceId) || null;
      const result = await localDb.checkUserModelUsage({ ...payload, userId: effectiveUserId, serviceId: usageServiceId, serviceDefaultModel: (usageService && usageService.defaultModel) || "", serviceDefaultCreditCost: (usageService && usageService.defaultCreditCost) || 1, consume: payload.consume !== false });
      const usageModelId = String(result.modelId || payload.modelId || (usageService && usageService.defaultModel) || "").trim();
      const observedModelId = String(payload.modelId || result.modelId || (usageService && usageService.defaultModel) || "").trim();
      if (payload.consume !== false && result.idempotent !== true) {
        if (observedModelId) await localDb.observeModel({ serviceId: usageServiceId, modelId: observedModelId, source: "user", url: payload.url || "" }).catch(() => {});
        await localDb.recordUserActivity({
          userId: effectiveUserId,
          deviceId: isAccount ? localDb.sanitizeId(account.deviceId, "device") : localDb.sanitizeId(payload.deviceId || effectiveUserId, "device"),
          profileId: effectiveProfileId, serviceId: usageServiceId,
          action: result.allowed === false ? "model-blocked" : "model-usage", url: payload.url || "", title: usageModelId || "unknown model",
          details: JSON.stringify({ modelId: usageModelId || result.modelId || "", requestedModelId: payload.modelId || "", detectedModelId: payload.detectedModelId || "", defaultedModel: Boolean(result.defaultedModel), usageRequestId: payload.usageRequestId || payload.idempotencyKey || "", creditCost: result.creditCost ?? null, balance: result.balance ?? null, remaining: result.remaining ?? null, count: (result.usage && result.usage.count) ?? null, credits: (result.usage && result.usage.credits) ?? null, estimatedTokens: payload.estimatedTokens ?? null, tokens: (result.usage && result.usage.tokens) ?? null, reason: result.reason || "" }),
        }).catch(() => {});
        // Debit thành công = user ĐANG DÙNG dịch vụ → chạm gán pool (refresh TTL / hồi sinh từ recent) để web
        // admin luôn hiện đúng Slot #N trong suốt phiên chat dài. Fire-and-forget: không chậm đường tính credit.
        if (result.allowed !== false) {
          pool.touchAssignment(usageServiceId, effectiveUserId, (usageConfig && usageConfig.services) || [])
            .then((ok) => { if (process.env.CENTRIX_TRACE_EXPORT === "1") console.log("[touch]", usageServiceId, effectiveUserId, "=>", ok); })
            .catch((e) => { if (process.env.CENTRIX_TRACE_EXPORT === "1") console.log("[touch-err]", usageServiceId, effectiveUserId, (e && e.message) || e); });
        }
      }
      sendJson(res, 200, { ok: true, ...result }); return;
    }
    // RESERVE LEDGER: client gọi khi HỦY request trước khi gửi (từ chối confirm) → nhả hold đã reserve ở pre-check.
    if (pathname === "/api/users/model-usage/release") {
      const relServiceId = localDb.sanitizeId(payload.serviceId || "service", "service");
      const result = await localDb.releaseModelUsage({ ...payload, userId: effectiveUserId, serviceId: relServiceId });
      sendJson(res, 200, { ok: true, ...result }); return;
    }

    // ----- admin: money / accounts / pricing / plans -----
    if (pathname === "/api/admin/credits/adjust") { const db = await localDb.adjustUserCredit({ ...payload, userId: payload.userId || scopedUserId, actor: payload.actor || "admin" }); sendJson(res, 200, { ok: true, db }); return; }
    // VÍ VND: nạp tiền thủ công (+) / điều chỉnh (+/-) cho 1 user. TIỀN THẬT → dbapi không lỗi mới trả 200; lỗi
    // (dbapi down / trừ quá số dư) trả 400 kèm message thay vì 500 trần.
    if (pathname === "/api/admin/money/topup") {
      try { const db = await localDb.topupMoney({ userId: payload.userId || scopedUserId, amountVnd: payload.amountVnd, note: payload.note, type: "topup", actor: (who.staff && who.staff.username) || "admin" }); sendJson(res, 200, { ok: true, db }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "money-topup-failed" }); }
      return;
    }
    if (pathname === "/api/admin/money/adjust") {
      try { const db = await localDb.adjustMoney({ userId: payload.userId || scopedUserId, amountDelta: payload.amountDelta, note: payload.note, actor: (who.staff && who.staff.username) || "admin" }); sendJson(res, 200, { ok: true, db }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "money-adjust-failed" }); }
      return;
    }
    if (pathname === "/api/admin/accounts/set-locked") { const result = await localDb.setAccountLocked({ userId: payload.userId || "", locked: !!payload.locked }); sendJson(res, 200, { ok: true, ...result }); return; }
    if (pathname === "/api/admin/accounts/delete") {
      // Admin HARD-DELETE of an arbitrary end-user account + ALL data (irreversible). Gated by auth.gate
      // (master, or staff with the "users" view — see auth.js). Refuses org owners (409 + code ORG_OWNER).
      const targetUserId = String(payload.userId || scopedUserId || "").trim();
      const targetEmail = String(payload.email || "").trim();
      if (!targetUserId && !targetEmail) { sendJson(res, 400, { ok: false, error: "Thiếu userId" }); return; }
      let result;
      try { result = await localDb.deleteUserAccount({ userId: targetUserId, email: targetEmail }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Lỗi xóa tài khoản" }); return; }
      if (result && result.ok === false) { sendJson(res, 409, result); return; } // org-owner refusal etc.
      sendJson(res, 200, { ok: true, userId: result.userId || targetUserId }); return;
    }
    if (pathname === "/api/admin/model-prices") { const db = await localDb.setModelPrices(payload); sendJson(res, 200, { ok: true, db }); return; }
    if (pathname === "/api/admin/plans/list") { sendJson(res, 200, { ok: true, ...(await localDb.plansList(payload)) }); return; }
    if (pathname === "/api/admin/plans/assign") { sendJson(res, 200, { ok: true, ...(await localDb.assignUserPlan(payload)) }); return; }
    if (pathname === "/api/admin/plans/update-subscription") { sendJson(res, 200, { ok: true, ...(await localDb.updateUserSubscription(payload)) }); return; }
    if (pathname === "/api/admin/plans/convert-legacy") { sendJson(res, 200, { ok: true, ...(await localDb.convertUserToLegacy(payload)) }); return; }
    if (pathname === "/api/admin/plans/access") { sendJson(res, 200, { ok: true, ...(await localDb.setPlanAccess(payload)) }); return; }
    if (pathname === "/api/admin/plans/save") { sendJson(res, 200, { ok: true, ...(await localDb.savePlan(payload)) }); return; }
    if (pathname === "/api/admin/plans/delete") {
      try { sendJson(res, 200, { ok: true, ...(await localDb.deletePlan(payload)) }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Xóa gói thất bại" }); }
      return;
    }
    if (pathname === "/api/admin/plans/gate") { sendJson(res, 200, { ok: true, ...(await localDb.setPlanGate(payload)) }); return; }

    // ----- admin: portal section writes (staff sub-gated by section) -----
    if (pathname === "/api/admin/portal") {
      const sgStaff = who.kind === "staff" ? who.staff : null;
      if (sgStaff && !(sgStaff.isOwner || (sgStaff.permissions || []).includes("*"))) {
        const sectionView = auth.STAFF_PORTAL_SECTION_VIEW[String(payload.section || "")] || null;
        const allowed = sectionView ? auth.staffCan(sectionView, sgStaff.permissions) : false;
        if (auth.STAFF_RBAC === "on" && !allowed) { sendJson(res, 403, { ok: false, error: "Không đủ quyền", view: sectionView }); return; }
        if (auth.STAFF_RBAC === "log" && !allowed) console.warn(`[staff-rbac:log] ${sgStaff.username} POST /api/admin/portal section=${payload.section} view=${sectionView} -> WOULD-BLOCK`);
      }
      const result = await localDb.setPortalSection(payload);
      if (String(payload.section || "") === "appVersion") {
        // Refresh the version-config cache IMMEDIATELY from the just-written portal so the gate AND
        // /api/health agree on the very next request. Without this, the 8s stale window let the App User
        // watchdog read the OLD verdict for a few seconds → the lock overlay flickered off-then-on right
        // after an admin toggled the policy.
        try {
          const rec = (((result.portal && result.portal.appVersion) || [])[0]) || {};
          let cfg = {}; if (rec.configJson) { try { cfg = JSON.parse(rec.configJson); } catch { cfg = {}; } }
          _verCfg = { cfg, at: Date.now() };
        } catch { _verCfg = { cfg: {}, at: 0 }; }
      }
      sendJson(res, 200, { ok: true, portal: result.portal, db: result.db }); return;
    }

    // ----- staff / role CRUD (owner-gated edits) -----
    if (pathname === "/api/admin/staff/save" || pathname === "/api/admin/staff/delete" || pathname === "/api/admin/roles/save" || pathname === "/api/admin/roles/delete") {
      const mgr = who.kind === "staff" ? who.staff : null;
      if (mgr && !auth.staffCan("roles", mgr.permissions)) { sendJson(res, 403, { ok: false, error: "Không đủ quyền" }); return; }
      const ownerOnly = pathname.startsWith("/api/admin/roles/") || (pathname === "/api/admin/staff/save" && (payload.isOwner || String(payload.role || "") === "owner"));
      if (ownerOnly && mgr && !mgr.isOwner) { sendJson(res, 403, { ok: false, error: "Chỉ chủ sở hữu mới chỉnh vai trò/quyền" }); return; }
    }
    if (pathname === "/api/admin/staff/save") {
      const username = String(payload.username || payload.email || "").trim().toLowerCase();
      try { const result = await localDb.adminAccountSave(payload); await refreshLiveStaffPermissions(); sendJson(res, 200, { ok: true, ...result }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Lỗi lưu nhân viên" }); }
      return;
    }
    if (pathname === "/api/admin/staff/delete") {
      const username = String(payload.username || "").trim().toLowerCase();
      try { await localDb.adminAccountDelete({ username }); await refreshLiveStaffPermissions(); sendJson(res, 200, { ok: true, username }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Lỗi xóa nhân viên" }); }
      return;
    }
    if (pathname === "/api/admin/roles/save") {
      try { const result = await localDb.adminRoleUpsert({ roleKey: payload.roleKey, name: payload.name, perms: payload.perms }); await refreshLiveStaffPermissions(); sendJson(res, 200, { ok: true, ...result }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Lỗi lưu vai trò" }); }
      return;
    }
    if (pathname === "/api/admin/roles/delete") {
      try { const result = await localDb.adminRoleDelete({ roleKey: payload.roleKey }); await refreshLiveStaffPermissions(); sendJson(res, 200, { ok: true, ...result }); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Lỗi xóa vai trò" }); }
      return;
    }

    // ----- live chat (agent send) -----
    if (pathname === "/api/admin/livechat") {
      if (isAccount) { sendJson(res, 403, { ok: false, error: "Master token required" }); return; }
      const result = await localDb.appendLivechatMessage({ userId: localDb.sanitizeId(payload.userId, "local-user"), from: "agent", text: payload.text });
      sendJson(res, 200, { ok: true, record: result.record, portal: result.portal }); return;
    }

    // ----- billing approve (money) -----
    if (pathname === "/api/admin/billing/approve") {
      const result = await localDb.approvePortalTopup({ ...payload, actor: payload.actor || "admin" });
      sendJson(res, 200, { ok: true, order: result.order, portal: result.portal, db: result.db }); return;
    }

    // ----- App-User: mua credit BẰNG VÍ VND (account-scoped) — trừ VND + cộng credit nguyên tử ở dbapi.
    // Giá + credit lấy TỪ GÓI (packageId, server-authoritative) — client KHÔNG gửi được giá tự chế.
    if (pathname === "/api/users/money/buy-credit") {
      const buyerId = isAccount ? localDb.sanitizeId(account.userId, "local-user") : scopedUserId;
      try {
        const db = await localDb.buyCreditWithMoney({ userId: buyerId, packageId: payload.packageId, actor: buyerId });
        const w = (db.creditWallets || []).find((x) => x.userId === buyerId) || {};
        sendJson(res, 200, { ok: true, moneyBalance: Number(w.moneyBalance || 0), balance: Number(w.balance || 0) });
      } catch (e) {
        const msg = (e && e.message) || "buy-credit-failed";
        sendJson(res, msg === "insufficient-money" ? 402 : 400, { ok: false, error: msg });
      }
      return;
    }

    // ----- App-User: mua GÓI CƯỚC bằng ví VND — trừ VND + kích hoạt gói + cộng credit gói (nguyên tử ở dbapi).
    if (pathname === "/api/users/money/buy-plan") {
      const buyerId = isAccount ? localDb.sanitizeId(account.userId, "local-user") : scopedUserId;
      try {
        const db = await localDb.buyPlanWithMoney({ userId: buyerId, planCode: payload.planCode, durationMonths: payload.durationMonths, actor: buyerId });
        const w = (db.creditWallets || []).find((x) => x.userId === buyerId) || {};
        sendJson(res, 200, { ok: true, moneyBalance: Number(w.moneyBalance || 0), balance: Number(w.balance || 0) });
      } catch (e) {
        const msg = (e && e.message) || "buy-plan-failed";
        sendJson(res, msg === "insufficient-money" ? 402 : 400, { ok: false, error: msg });
      }
      return;
    }

    // ----- App-User portal self-service -----
    if (pathname === "/api/users/portal/topup-request") {
      const result = await localDb.createPortalTopupRequest({ ...payload, userId: effectiveUserId });
      sendJson(res, 200, { ok: true, order: result.order, portal: result.userPortal || null }); return;
    }
    if (pathname === "/api/users/portal/support") {
      const result = await localDb.createPortalSupportTicket({ ...payload, userId: effectiveUserId });
      sendJson(res, 200, { ok: true, ticket: result.ticket, portal: result.userPortal || null }); return;
    }
    if (pathname === "/api/users/portal/livechat") {
      const result = await localDb.appendLivechatMessage({ userId: effectiveUserId, from: "user", text: payload.text });
      sendJson(res, 200, { ok: true, record: result.record, portal: result.userPortal || null }); return;
    }

    // ----- org self-service (account org-admin; callerUserId FORCED from token) -----
    const orgRoutes = {
      "/api/users/org/structure": localDb.orgStructure,
      "/api/users/org/department": localDb.orgAddDepartment,
      "/api/users/org/member": localDb.orgAddMember,
      "/api/users/org/allocate": localDb.orgAllocateCredit,
      "/api/users/org/billing": localDb.orgUpdateBilling,
      "/api/users/org/report": localDb.orgReport,
      "/api/users/org/set-entitlement": localDb.orgSetEntitlement,
      "/api/users/org/remove-member": localDb.orgRemoveMember,
      "/api/users/org/department-delete": localDb.orgDeleteDepartment,
      "/api/users/org/set-role": localDb.orgSetMemberRole,
      "/api/users/org/set-locked": localDb.orgSetMemberLocked,
    };
    if (orgRoutes[pathname]) {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgRoutes[pathname]({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Loi to chuc" }); }
      return;
    }

    // ----- plans / billing (account) -----
    if (pathname === "/api/users/plans/me") {
      try { sendJson(res, 200, await localDb.myPlan({ ...payload, userId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Loi doc goi cuoc" }); } return;
    }
    if (pathname === "/api/users/plans/self-downgrade") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await localDb.selfDowngradePlan({ ...payload, userId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Loi ha cap goi" }); } return;
    }
    if (pathname === "/api/users/billing") {
      try { sendJson(res, 200, await localDb.updateUserBilling({ ...payload, userId: effectiveUserId, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: (e && e.message) || "Loi luu thong tin hoa don" }); } return;
    }

    // ----- user data sync -----
    if (pathname === "/api/users/activity") {
      const result = await localDb.recordUserActivity({ ...payload, userId: effectiveUserId, profileId: effectiveProfileId });
      sendJson(res, 200, { ok: true, activity: (result.activity || []).slice(-250) }); return;
    }
    if (pathname === "/api/users/url-history") {
      const result = await localDb.saveUrlHistory({ items: Array.isArray(payload && payload.items) ? payload.items : [], userId: effectiveUserId });
      sendJson(res, 200, { ok: true, urlHistory: result.urlHistory || [] }); return;
    }
    if (pathname === "/api/users/local-store") {
      const result = await localDb.saveUserLocalStore({ ...payload, userId: effectiveUserId, profileId: effectiveProfileId });
      sendJson(res, 200, { ok: true, saved: result.saved || 0, localStoreCount: result.localStoreCount || 0 }); return;
    }
    if (pathname === "/api/users/ui-cache") {
      const result = await localDb.saveUserUiCache({ ...payload, userId: effectiveUserId, profileId: effectiveProfileId });
      sendJson(res, 200, { ok: true, saved: result.saved || 0, items: result.uiCacheItems || [] }); return;
    }

    // ----- model observe (DB write; loader-gated) -----
    if (pathname === "/api/models/observe") { await localDb.observeModel(payload); sendJson(res, 200, { ok: true }); return; }

    // ----- services config -----
    // Belt-and-suspenders: /api/admin/services sits in auth.js ACCOUNT_ALLOWED_PATHS (needed for the GET
    // read path), so an account token can reach this write branch. The catalog is admin/staff-only — block
    // accounts here regardless. /api/services/save and /reset are already gate-blocked for accounts.
    if (pathname === "/api/services/save" || pathname === "/api/admin/services" || pathname === "/api/services/reset") {
      if (isAccount) { sendJson(res, 403, { ok: false, error: "forbidden" }); return; }
    }
    if (pathname === "/api/services/save" || pathname === "/api/admin/services") { sendJson(res, 200, { ok: true, config: await writeServicesConfig(payload.services) }); return; }
    if (pathname === "/api/services/reset") { sendJson(res, 200, { ok: true, config: await resetServicesConfig() }); return; }

    sendJson(res, 404, { ok: false, error: "Route stays on the Electron worker (browser/device-coordination) or is not yet ported.", pathname });
  } catch (err) {
    console.error("[centrix-backend] 500", req.method, pathname, (err && err.stack) || err);
    sendJson(res, 500, { ok: false, error: "internal error" });
  }
});

// Behind a reverse proxy (cloudflared) that reuses keep-alive connections to the origin: keep the
// origin's idle timeout LONGER than the proxy's so Node never closes a connection the proxy is about to
// reuse (that race surfaces as intermittent ECONNRESET / "connection reset by peer" at the edge).
// headersTimeout must exceed keepAliveTimeout.
server.keepAliveTimeout = 75_000;
server.headersTimeout = 76_000;

server.listen(PORT, HOST, () => {
  console.log(`[centrix-backend] Phase-B SHADOW on http://${HOST}:${PORT}  | DB ${DB_URL}  | staffRbac=${auth.STAFF_RBAC}`);
  console.log(`[centrix-backend] master token: ${auth.getMasterToken()}`);
  // Sweep any orphaned installer-upload temp files (a hard crash mid-upload can leave a .upload-*.tmp). These
  // are already excluded from serving (only *.exe is picked), so this just reclaims disk — never touches .exe.
  if (RELEASE_DIR) {
    fsp.readdir(RELEASE_DIR)
      .then((names) => Promise.all(names.filter((n) => /^\.upload-[0-9a-f]+\.tmp$/i.test(n))
        .map((n) => fsp.unlink(path.join(RELEASE_DIR, n)).then(() => console.log(`[centrix-backend] swept orphan upload temp: ${n}`)).catch(() => {}))))
      .catch(() => {}); // release dir missing/unreadable — nothing to sweep
  }
});
