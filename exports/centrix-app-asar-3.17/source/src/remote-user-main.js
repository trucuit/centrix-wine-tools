const { app, BrowserWindow, BrowserView, WebContentsView, Menu, nativeTheme, ipcMain, session, shell, dialog, Notification } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeUrl } = require("./shared/service-store");
const { installCentrixNativeMenu } = require("./shared/native-menu");
const {
  exportProfileSnapshot,
  importProfileSnapshot,
  sanitizeProfileId
} = require("./shared/profile-sync");
const { encryptSnapshot, decryptSnapshot, isEncryptedSnapshot } = require("./shared/profile-crypto");
const { USER_RAM_PREFIX, USER_USERDATA_NAME } = require("./shared/gibberish-names");
const { clientAttestHeader, APP_REQUEST_KEY, exportSignHeader } = require("./shared/app-attest");
// SINGLE source of the client version — reported to the server (UA "CentriXAppUser/<APP_VERSION>") so the version
// gate can force-update/emergency-lock, and shown in the UI. Bump this one line per release, then repack.
const APP_VERSION = "3.17";
const { GOOGLE_CLIENT_ID, GOOGLE_AUTH_ENDPOINT, GOOGLE_SCOPE } = require("./shared/google-oauth");
const { deviceIdentity, makeDeviceProof } = require("./remote-user-device");
const { saveSession, loadSession, clearSession } = require("./remote-user-session");
// Anonymize the userData root — MUST run at module load, before harden-runtime / anything resolves
// app.getPath('userData'). (The whenReady setName was too late, so the app fell back to the package name.)
app.setName(USER_USERDATA_NAME);

// Hardening (BAO-VE-COOKIE-CentriX): in shipped builds, refuse the remote-debugging / inspector
// surfaces that let a local process dump the in-RAM browser session over CDP ("Cach B"). No-op in dev.
require("./shared/harden-runtime").hardenRuntimeOrExit();

// Non-persistent (in-memory) partition: the App User's profile lives only in RAM
// while running and never touches disk (no raw Chromium profile to copy or clean).
function userBrowserSession(profileId) {
  return session.fromPartition(`${USER_RAM_PREFIX}${sanitizeProfileId(profileId)}`);
}

const DEFAULT_PROFILE = "default";
const DEFAULT_LOGIN_API_URL = cleanServerUrl(
  process.env.CENTRIX_LOGIN_API_URL ||
    process.env.CENTRIX_SERVER_URL ||
    // Single distributable build: default to THIS server's public Cloudflare Tunnel URL so any device
    // anywhere connects with the one launcher. Requires the tunnel to be running on the App Server.
    "https://api-centrixapp-quang.centrix.asia"
);
const MIN_BROWSER_WIDTH = 420;
const MIN_BROWSER_HEIGHT = 320;
const DEFAULT_DEVICE_ID = `${os.hostname() || "device"}-${Math.random().toString(36).slice(2, 8)}`;
const USER_BROWSER_PRELOAD = path.join(__dirname, "remote-user-browser-preload.js");
const USER_API_UI_BRIDGE = path.join(__dirname, "remote-user", "api-ui-bridge.js");
const APP_ICON = path.join(__dirname, "desktop-assets", "favicon.ico");
const SMOOTH_OPEN_STORAGE_WAIT_MS = 1200;
const LOCAL_STORE_PRELOAD_TIMEOUT_MS = 1800;
const SERVICE_LOAD_TIMEOUT_MS = 15000;
const SERVICE_DOM_STABLE_TIMEOUT_MS = 8000;
const SERVICE_DOM_STABLE_POLL_MS = 140;
const SERVICE_READY_SETTLE_MS = 450;

let mainWindow = null;
let browserManager = null;
let connection = null;
let sessionRestoring = false;     // true while the boot-time persistent-login reconnect is in flight (see whenReady)
let pendingTakeover = null;       // a validated login that is blocked because the account is active on another device
let dpopNonce = "";               // latest DPoP-Nonce the server handed us (sent back in the next proof)
let evictionInProgress = false;   // true while this device is gracefully logging out after being taken over
let connectionEstablishedAt = 0; // ms timestamp of the last successful connect (for the auth grace window)
const AUTH_EXPIRY_GRACE_MS = 12000; // ignore 401s for this long after connect — the freshly issued
// token needs a moment to propagate on the tunnel server, so it transiently 401s every route
// (incl. /api/me) right after connect. Treating that blip as expiry force-logged the user out.
let services = [];
let heartbeatTimer = null;
let syncTimer = null;
let isQuitting = false;
let profileInitialSyncComplete = false;
let profileInitialSyncPromise = null;
let profileStorageSyncPromise = null;
let initialStorageSyncComplete = false;
let currentProfileRevision = 0;       // the profile revision currently APPLIED to the live RAM partition
let stagedProfileRevision = 0;        // a newer revision pre-fetched from the server but NOT yet applied
let stagedProfileSnapshot = null;     // the pre-fetched snapshot; applied only at a safe boundary (service open/reopen)
let profilePushSuppressedUntil = 0; // briefly mute auto-push right after a live-sync pull (multi-device echo guard)
// POOL mode: one service is backed by MANY login profiles on the server; the client pulls the assigned
// pool profile PER-SERVICE on open (export?service=<id>) instead of pulling the whole account profile once.
// Detected from /api/health (server.profilePool). off ⟹ behaviour is identical to before (whole-profile).
// env override: CENTRIX_PROFILE_POOL="1" forces on, "0" forces off; otherwise follow the server.
let profilePoolMode = false;
// Pool re-pull tracking: serviceId -> { revision, assignedProfile, lastProbeAt } of the LAST successful pool
// pull. A warm (already-loaded) tab checks this against the server's current per-service revision so a manager
// RE-SEED (or a reassigned pool slot) triggers a fresh pull+reload instead of keeping the stale/dead login.
const poolPullState = new Map();
// Same-domain collision guard: ALL services of a profile share ONE RAM partition (userBrowserSession keys on
// profileId, NOT service), so two services on the SAME registrable domain (e.g. ChatGPT + "GPT-5.5 Pro", both
// chatgpt.com) OVERWRITE each other's session cookies when pulled. poolDomainOwner tracks which serviceId last
// imported cookies for each registrable domain; opening a service whose domain is currently owned by a DIFFERENT
// service forces a fresh pull+reload so the correct account's cookies are re-imported before the tab shows —
// this closes the "đôi lúc mở ChatGPT bị logout" flip caused by a same-domain sibling clobbering the partition.
const poolDomainOwner = new Map(); // registrableDomain -> serviceId that last wrote cookies for it
function serviceRegistrableKey(service) {
  try {
    const host = new URL(service && service.url ? service.url : "").hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join(".") : host;
  } catch { return ""; }
}
function markPoolDomainOwner(service) { const key = serviceRegistrableKey(service); if (key) poolDomainOwner.set(key, String((service && service.id) || "")); }
function poolDomainClobbered(service) { const key = serviceRegistrableKey(service); if (!key) return false; const owner = poolDomainOwner.get(key); return Boolean(owner) && owner !== String((service && service.id) || ""); }
const POOL_PROBE_CACHE_MS = 15000; // don't re-probe /profile/revision more than once per 15s per service (a
// warm reopen/switch must not block on a network round-trip every time — the manager re-seed still lands within one window)
// ── AUTO RE-SEED: khôi phục phiên khi dịch vụ đá về trang /login ────────────────────────────────────
// App User phát hiện tab đang ở trang đăng nhập (đã từng đăng nhập trước đó) → báo backend "session chết"
// → (VPS/Manager tự login lại account pool → đẩy snapshot mới, revision++) → App User poll revision nhanh
// (BỎ QUA throttle 15s) tới khi tăng → pull profile tươi + reload → vào lại. Bọc sau cờ để rollout an toàn.
// Bản ĐÓNG GÓI không có env → bật auto-reseed MẶC ĐỊNH. Đặt CENTRIX_AUTO_RESEED=0 để tắt khi cần.
if (process.env.CENTRIX_AUTO_RESEED == null || process.env.CENTRIX_AUTO_RESEED === "") process.env.CENTRIX_AUTO_RESEED = "1";
const AUTO_RESEED = String(process.env.CENTRIX_AUTO_RESEED || "").trim() === "1";
if (AUTO_RESEED) console.error("[reseed] client flag ON (auto re-seed enabled)");
const RESEED_POLL_MS = Math.max(1000, Number(process.env.CENTRIX_RESEED_POLL_MS) || 2500); // nhịp poll khi đang khôi phục
const RESEED_WAIT_MS = Math.max(5000, Number(process.env.CENTRIX_RESEED_WAIT_MS) || 70000); // cap chờ tối đa; 70s đủ cho Google (~60s), noxtools vẫn thoát sớm khi xong
const RESEED_COOLDOWN_MS = Math.max(3000, Number(process.env.CENTRIX_RESEED_COOLDOWN_MS) || 10000); // backoff sau 1 lần thất bại (ngắn → thử lại nhanh)
// URL "đang ở trang đăng nhập" — xét theo path/host để tránh dương-tính-giả (URL app thường lẫn từ khoá).
function urlLooksLikeLogin(u, service) {
  const s = String(u || "");
  if (!s) return false;
  try {
    const extra = Array.isArray(service?.loginUrls) ? service.loginUrls : []; // cho phép override theo dịch vụ
    for (const p of extra) { if (p && s.toLowerCase().includes(String(p).toLowerCase())) return true; }
    const url = new URL(s);
    const path = (url.pathname + url.search).toLowerCase();
    const host = url.hostname.toLowerCase();
    if (/(?:\/login|\/log-in|\/signin|\/sign-in|\/auth\b|\/authenticate|\/verify|\/otp|\/2fa|\/mfa)(?:[\/?#]|$)/.test(path)) return true;
    if (/(?:^|\.)accounts\.google\.|(?:^|\.)login\.|(?:^|\.)auth\./.test(host)) return true;
    return false;
  } catch { return false; }
}
// Overlay "đang làm mới phiên" — INJECT vào trang dịch vụ (view nằm TRÊN DOM renderer nên overlay renderer bị
// che; inject vào webContents mới đè lên được). Tự chứa (chỉ dùng biến trình duyệt) để executeJavaScript chạy sạch.
function reseedOverlayShowScript(serviceName) {
  const svc = String(serviceName || "").trim();
  const sub = svc ? ("Đang khôi phục phiên " + svc + " cho bạn — bạn không cần thao tác gì.")
    : "Đang khôi phục phiên đăng nhập cho bạn — bạn không cần thao tác gì.";
  return `(function(){try{
    var id='__cxReseedOv'; var old=document.getElementById(id); if(old) old.remove();
    try{ if(window.__cxReseedIv){clearInterval(window.__cxReseedIv);window.__cxReseedIv=null;} }catch(e){}
    var d=document.createElement('div'); d.id=id;
    d.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;background:rgba(11,15,23,.94);color:#fff;font-family:system-ui,Segoe UI,sans-serif;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);';
    var st=document.createElement('style'); st.textContent='@keyframes __cxspin{to{transform:rotate(360deg)}}@keyframes __cxbar{0%{left:-42%}100%{left:100%}}';
    var sp=document.createElement('div'); sp.style.cssText='width:48px;height:48px;border-radius:50%;border:4px solid rgba(255,255,255,.16);border-top-color:#4f8cff;animation:__cxspin .8s linear infinite;';
    var t=document.createElement('div'); t.textContent='Đang đăng nhập lại tự động…'; t.style.cssText='font-weight:800;font-size:16px;';
    var s=document.createElement('div'); s.textContent=${JSON.stringify(sub)}; s.style.cssText='font-weight:400;font-size:13px;opacity:.78;text-align:center;max-width:360px;line-height:1.5;';
    var bar=document.createElement('div'); bar.style.cssText='position:relative;width:230px;height:4px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;';
    var bi=document.createElement('div'); bi.style.cssText='position:absolute;top:0;height:100%;width:42%;border-radius:3px;background:#4f8cff;animation:__cxbar 1.3s ease-in-out infinite;'; bar.appendChild(bi);
    var s2=document.createElement('div'); s2.textContent='Một số dịch vụ (vd Google) có thể mất tới ~1 phút.'; s2.style.cssText='font-weight:400;font-size:12px;opacity:.55;text-align:center;max-width:360px;';
    var el=document.createElement('div'); el.id='__cxReseedEl'; el.style.cssText='font-weight:600;font-size:12px;opacity:.6;'; el.textContent='Đã đợi 0 giây';
    d.appendChild(st); d.appendChild(sp); d.appendChild(t); d.appendChild(s); d.appendChild(bar); d.appendChild(s2); d.appendChild(el);
    (document.body||document.documentElement).appendChild(d);
    window.__cxReseedT=Date.now();
    window.__cxReseedIv=setInterval(function(){try{var e=document.getElementById('__cxReseedEl'); if(!e){clearInterval(window.__cxReseedIv);window.__cxReseedIv=null;return;} e.textContent='Đã đợi '+Math.round((Date.now()-window.__cxReseedT)/1000)+' giây';}catch(x){}},1000);
  }catch(e){}})();`;
}
function reseedOverlayErrorScript(msg) {
  return `(function(){try{
    try{ if(window.__cxReseedIv){clearInterval(window.__cxReseedIv);window.__cxReseedIv=null;} }catch(e){}
    var d=document.getElementById('__cxReseedOv');
    if(!d){ d=document.createElement('div'); d.id='__cxReseedOv'; d.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(11,15,23,.94);color:#fff;font-family:system-ui,Segoe UI,sans-serif;'; (document.body||document.documentElement).appendChild(d); }
    d.innerHTML='';
    var t=document.createElement('div'); t.textContent='Chưa đăng nhập lại xong'; t.style.cssText='font-weight:800;font-size:16px;';
    var s=document.createElement('div'); s.textContent=${JSON.stringify(String(msg || "Hệ thống vẫn đang xử lý. Bạn có thể bấm Thử lại, hoặc chờ thêm một chút."))}; s.style.cssText='font-weight:400;font-size:13px;opacity:.78;text-align:center;max-width:360px;line-height:1.5;';
    var row=document.createElement('div'); row.style.cssText='display:flex;gap:10px;margin-top:4px;';
    var b1=document.createElement('button'); b1.textContent='Thử lại'; b1.style.cssText='height:38px;padding:0 20px;border:0;border-radius:10px;background:#4f8cff;color:#fff;font-weight:700;font-size:13px;cursor:pointer;'; b1.onclick=function(){try{location.reload();}catch(x){}};
    var b2=document.createElement('button'); b2.textContent='Đóng'; b2.style.cssText='height:38px;padding:0 18px;border:1px solid rgba(255,255,255,.28);border-radius:10px;background:transparent;color:#fff;font-weight:600;font-size:13px;cursor:pointer;'; b2.onclick=function(){try{var e=document.getElementById('__cxReseedOv'); if(e) e.remove();}catch(x){}};
    row.appendChild(b1); row.appendChild(b2);
    d.appendChild(t); d.appendChild(s); d.appendChild(row);
  }catch(e){}})();`;
}
function reseedOverlayHideScript() {
  return "(function(){try{if(window.__cxReseedIv){clearInterval(window.__cxReseedIv);window.__cxReseedIv=null;}var e=document.getElementById('__cxReseedOv'); if(e) e.remove();}catch(e){}})();";
}
// RULES-WITH-PROFILE: hide/replace/userScript rules that arrived INSIDE a profile export snapshot,
// keyed by serviceId. When present they are AUTHORITATIVE over service.uiRules from /api/services —
// the profile "passes through" its service rules before it reaches the user.
let profileUiRules = new Map();

function writeUserRuntimeLog(event, details = {}) {
  try {
    const logPath = path.join(app.getPath("userData"), "centrix-app-user.log");
    const row = JSON.stringify({
      at: new Date().toISOString(),
      event: String(event || "event"),
      ...details
    });
    fs.promises.appendFile(logPath, `${row}\n`, "utf8").catch(() => {});
  } catch {
    // Logging must never affect the browser flow.
  }
}

function cleanServerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function withTimeout(promise, timeoutMs, fallback = null) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => fallback)
  ]);
}

async function pageDomSnapshot(wc) {
  if (!wc || wc.isDestroyed?.()) return { ok: false, reason: "destroyed" };
  return withTimeout(wc.executeJavaScript(`
    (() => {
      const body = document.body;
      const html = body ? body.innerHTML || "" : "";
      const text = body ? body.innerText || "" : "";
      return {
        ok: true,
        readyState: document.readyState,
        url: location.href,
        title: document.title || "",
        htmlLength: html.length,
        textLength: text.trim().length,
        elementCount: body ? body.querySelectorAll("*").length : 0
      };
    })();
  `, true), 900, { ok: false, reason: "snapshot-timeout" })
    .catch((error) => ({ ok: false, reason: error?.message || String(error) }));
}

async function waitForWebContentsDomStable(wc, timeoutMs = SERVICE_DOM_STABLE_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let lastReady = null;

  while (!wc?.isDestroyed?.() && Date.now() <= deadline) {
    const snapshot = await pageDomSnapshot(wc);
    lastReady = snapshot;
    const hasUsableDom = snapshot?.ok === true &&
      snapshot.readyState !== "loading" &&
      (Number(snapshot.elementCount || 0) >= 2 || Number(snapshot.textLength || 0) > 0 || Number(snapshot.htmlLength || 0) > 120);
    if (hasUsableDom) return { ok: true, snapshot };
    await delay(SERVICE_DOM_STABLE_POLL_MS);
  }

  return { ok: false, timeout: true, snapshot: lastReady };
}

async function loadWebContentsUntilStopped(wc, url, timeoutMs = SERVICE_LOAD_TIMEOUT_MS) {
  if (!wc || wc.isDestroyed?.()) throw new Error("Browser tab is closed");
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener("did-stop-loading", onStop);
      wc.removeListener("did-fail-load", onFail);
    };
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve({ ok });
    };
    const onStop = () => finish(true);
    const onFail = (_event, errorCode, errorDescription) => {
      const message = errorDescription || `Load failed ${errorCode}`;
      if (isNavigationAbortError({ message, code: errorCode, errno: errorCode })) {
        finish(true);
        return;
      }
      finish(false, new Error(message));
    };

    wc.once("did-stop-loading", onStop);
    wc.once("did-fail-load", onFail);
    timer = setTimeout(() => finish(false), timeoutMs);

    Promise.resolve(wc.loadURL(url))
      .then(() => finish(true))
      .catch((error) => {
        if (isNavigationAbortError(error)) finish(true);
        else finish(false, error);
      });
  });
}

function isLoopbackServerUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function connectionErrorMessage(error, target) {
  const message = error?.message || String(error || "");
  if (isLoopbackServerUrl(target?.serverUrl) && /fetch failed|ECONNREFUSED|aborted|network/i.test(message)) {
    return "127.0.0.1 la dia chi cua chinh may User. Neu User o may khac, hay nhap Public URL Cloudflare Tunnel tren Server hoac LAN/Tailscale URL.";
  }

  if (/fetch failed|ECONNREFUSED|aborted|network/i.test(message)) {
    return "Khong ket noi duoc may chu CentriX. Kiem tra ket noi mang roi thu lai — neu loi keo dai, may chu co the dang tam gian doan, thu lai sau it phut.";
  }

  return message;
}

function tabIdFor(profileId, serviceId) {
  const profile = sanitizeProfileId(profileId || DEFAULT_PROFILE);
  const service = String(serviceId || "service").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) || "service";
  return `${currentDeviceId()}-${profile}-${service}`;
}

function currentDeviceId() {
  return String(connection?.deviceId || DEFAULT_DEVICE_ID)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80) || DEFAULT_DEVICE_ID;
}

function originOf(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function shouldNavigateToService(currentUrl, targetUrl) {
  const current = String(currentUrl || "");
  if (!current || current === "about:blank") return true;

  const currentOrigin = originOf(current);
  const targetOrigin = originOf(targetUrl);
  return Boolean(currentOrigin && targetOrigin && currentOrigin !== targetOrigin);
}

function fallbackUrlForService(service) {
  const serviceId = String(service?.id || "").toLowerCase();
  if (serviceId === "claude") {
    try {
      return new URL("/new", service.url || "https://claude.ai/").toString();
    } catch {
      return "https://claude.ai/new";
    }
  }
  return normalizeUrl(service?.url || "");
}

function isNavigationAbortError(error) {
  const message = error?.message || String(error || "");
  return /ERR_ABORTED|\(-3\)/i.test(message) || error?.errno === -3 || error?.code === -3;
}

// ── FORCE-UPDATE / EMERGENCY-LOCK overlay (version gate) ──────────────────────────────────────────
// The server returns HTTP 426 for a too-old / blocked / below-forced-latest client on EVERY gated request,
// AND advertises the same verdict on /api/health (which is exempt from the 426 gate). A single native dialog
// the user can just ignore is a hole — so we HARD-LOCK the whole app instead: tear down every open service
// tab, block all server traffic + opening services, and paint a full-screen blocking overlay in the renderer.
// A watchdog keeps polling /api/health so the lock lifts AUTOMATICALLY the moment the admin un-blocks the
// version (no restart needed). Manual-update model: the overlay's "Tải bản mới" opens the installer download.
let versionLocked = false;
let versionLockDownloadUrl = "";
let versionWatchTarget = null;
let versionWatchdogTimer = null;
const VERSION_WATCHDOG_MS = Math.max(5000, Number(process.env.CENTRIX_VERSION_WATCHDOG_MS || 15000));

function versionDownloadUrl(verdict, target) {
  const base = String((target && target.serverUrl) || (connection && connection.serverUrl) || DEFAULT_LOGIN_API_URL || "").replace(/\/+$/, "");
  return base + (verdict && verdict.downloadUrl ? verdict.downloadUrl : "/api/download/app-user");
}

function applyVersionLock(verdict, target) {
  versionLockDownloadUrl = versionDownloadUrl(verdict, target);
  const payload = {
    reason: (verdict && verdict.reason) || "blocked",
    appVersion: APP_VERSION,
    latestVersion: (verdict && verdict.latestVersion) || "",
    notes: (verdict && verdict.notes) || "",
    downloadUrl: versionLockDownloadUrl
  };
  const already = versionLocked;
  versionLocked = true;
  try { if (browserManager) browserManager.closeAll(); } catch { /* tear down every open AI tab, best-effort */ }
  const sendLock = () => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("version:lock", payload); } catch { /* renderer may not be ready */ } };
  sendLock();
  // Re-send a few times: on a fresh launch the lock can fire before the renderer bridge has registered its
  // listener, so a single send could be missed. Cheap and idempotent (the overlay just re-renders).
  for (const d of [400, 1200, 3000]) setTimeout(() => { if (versionLocked) sendLock(); }, d);
  if (!already) writeUserRuntimeLog("version-lock", payload);
  startVersionWatchdog(target); // keep polling so an admin un-block auto-unlocks the app
}

function clearVersionLock() {
  if (!versionLocked) return;
  versionLocked = false;
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("version:unlock", {}); } catch { /* best-effort */ }
  writeUserRuntimeLog("version-unlock", {});
}

// Poll /api/health directly (public, no auth, exempt from the 426 gate) so the watchdog works BOTH before
// login (serverUrl only) and while connected — and survives the lock without any bypass plumbing.
async function probeVersionHealth(serverUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${String(serverUrl || "").replace(/\/+$/, "")}/api/health`, {
      headers: { "User-Agent": `CentriXAppUser/${APP_VERSION}`, "X-CentriX-App-Key": APP_REQUEST_KEY },
      signal: controller.signal
    });
    const raw = await response.text();
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function startVersionWatchdog(target) {
  if (target && target.serverUrl) versionWatchTarget = target;
  if (versionWatchdogTimer) return;
  const tick = async () => {
    const t = versionWatchTarget || connection;
    const url = t && t.serverUrl;
    if (!url) return;
    try {
      const health = await probeVersionHealth(url);
      const verdict = health && health.versionVerdict;
      if (verdict) applyVersionLock(verdict, t);
      else clearVersionLock();
      // Non-forced "update available" offer (independent of the hard-lock gate above).
      if (health && health.latestApp) maybeOfferUpdate(health.latestApp);
    } catch { /* transient network — keep current lock state until the next tick */ }
  };
  versionWatchdogTimer = setInterval(tick, VERSION_WATCHDOG_MS);
  tick(); // check immediately, don't wait a full interval
}
function stopVersionWatchdog() { if (versionWatchdogTimer) { clearInterval(versionWatchdogTimer); versionWatchdogTimer = null; } versionWatchTarget = null; }

// ── IN-APP AUTO-UPDATE ──────────────────────────────────────────────────────────────────────────────
// The server advertises `latestApp {version, notes, downloadUrl, filename, size, sha256}` on /api/health.
// When it's NEWER than this build, offer an in-app update: download the installer WITH a progress bar,
// verify its sha256 (never run an unverified executable), then launch the installer (visible wizard) which
// closes this app (Inno CloseApplications=yes), overwrites, and relaunches the new version. Prefs (skipped
// version + auto-download) persist in userData/update-prefs.json.
let updateAvailableInfo = null;   // the {version, ...} currently offered (or null)
let updateDownloading = false;
let updateCancelRequested = false;
let updateAbortController = null; // aborts the in-flight download (real cancel + stall timeout)
let pendingUpdateInstaller = "";  // verified Setup path, ARMED to run on app quit (replaces the old .cmd waiter)
let pendingUpdateVersion = "";
// Run the armed installer the moment the app quits (user closed it / clicked "Tắt ứng dụng ngay"). Detached so
// it outlives this process; the Inno PrepareToInstall taskkills any remnant + Sleep(1500) before copying files,
// so there is no file-lock race. No console/cmd window, no auto-relaunch.
app.on("before-quit", () => {
  if (!pendingUpdateInstaller) return;
  const installer = pendingUpdateInstaller;
  pendingUpdateInstaller = "";
  try {
    // FIX for the "update never sticks / popup loops forever": install into the SAME folder the running app
    // lives in (via Inno /DIR), not the installer's fixed AppId dir ({localappdata}\Programs\CentriX App User).
    // A user running a PORTABLE copy from elsewhere (e.g. D:\...\CentriX-App-User\) would otherwise reopen the
    // OLD portable after every "update" — the new files landed in Programs, which they never open. /DIR points
    // the install at path.dirname(execPath) = the app root (writable, no admin), so the copy the user actually
    // reopens IS the upgraded one. For a normally-installed app this equals the default dir → no change.
    const appDir = path.dirname(process.execPath);
    const args = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"];
    if (appDir && /[\\/]/.test(appDir)) args.push("/DIR=" + appDir);
    const child = require("node:child_process").spawn(installer, args, { detached: true, stdio: "ignore" });
    child.unref();
    writeUserRuntimeLog("update-installer-started", { version: pendingUpdateVersion, path: installer, dir: appDir });
  } catch (e) {
    writeUserRuntimeLog("update-error", { reason: "spawn-on-quit-failed", error: (e && e.message) || String(e) });
  }
});
function cmpVerClient(a, b) {
  const A = String(a || "").split("."), B = String(b || "").split(".");
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) { const d = (parseInt(A[i], 10) || 0) - (parseInt(B[i], 10) || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
function updatePrefsFile() { return path.join(app.getPath("userData"), "update-prefs.json"); }
function readUpdatePrefs() { try { return JSON.parse(fs.readFileSync(updatePrefsFile(), "utf8")) || {}; } catch { return {}; } }
function writeUpdatePrefs(p) { try { fs.writeFileSync(updatePrefsFile(), JSON.stringify(p || {})); } catch { /* best-effort */ } }
function sendUpdateEvent(channel, payload) { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); } catch { /* renderer may be gone */ } }

// A finished chat-file download shows a NATIVE OS notification (not just an in-app toast): the service view
// is an OS layer ABOVE the renderer DOM, so an in-app toast can be hidden behind it — a native notification
// is always visible and, on success, clicking it reveals the file in Explorer. Best-effort: if notifications
// are unavailable the file is still saved to Downloads.
function notifyDownloadNative(filename, savePath, ok) {
  try {
    if (!Notification || (typeof Notification.isSupported === "function" && !Notification.isSupported())) return;
    const n = new Notification({
      title: ok ? "Tải xuống hoàn tất" : "Tải xuống thất bại",
      body: ok ? `${filename} — bấm để mở thư mục` : `Không tải được ${filename}`,
    });
    if (ok && savePath) n.on("click", () => { try { shell.showItemInFolder(savePath); } catch { /* explorer may be blocked */ } });
    n.show();
  } catch { /* notifications unavailable — download already saved */ }
}

// Download abuse caps. setSavePath skips the dialog + Chromium's "allow multiple downloads?" prompt, so a
// script inside a (untrusted-content) service view could loop <a download> clicks or point at a huge stream.
// We cap the RATE (drive-by loop) and per-file SIZE (disk-fill) rather than reintroduce the old blanket block.
const DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB per file — generous for real chat files, blocks a DoS stream
const DOWNLOAD_RATE_WINDOW_MS = 60000;
const DOWNLOAD_RATE_MAX = 20; // max auto-saves per 60s across the user's tabs — a human won't hit this; a loop will

// Called on each health poll: decide whether to offer an update.
function maybeOfferUpdate(latestApp) {
  if (!latestApp || !latestApp.version) return;
  if (cmpVerClient(latestApp.version, APP_VERSION) <= 0) return; // not newer than this build
  const prefs = readUpdatePrefs();
  // LOOP-BREAKER (fix "cập nhật xong mở lại vẫn bắt cập nhật"): we ALREADY tried to install this exact
  // version (prefs.attempted set when we armed the installer, in a prior session — the app relaunches to
  // install), yet the cmp above proves we are STILL below it. So the install did NOT stick: the advertised
  // build's APP_VERSION wasn't bumped (mislabeled build), it landed in a folder we don't reopen, or the
  // wizard was cancelled. Re-offering would nag on every single reopen forever. Auto-skip THIS version so we
  // stop — a genuinely higher version advertised later still passes the cmp and is offered normally.
  if (prefs.attempted && String(prefs.attempted.version) === String(latestApp.version)) {
    if (String(prefs.skipped || "") !== String(latestApp.version)) {
      prefs.skipped = String(latestApp.version);
      writeUpdatePrefs(prefs);
      writeUserRuntimeLog("update-loop-suppressed", { current: APP_VERSION, latest: latestApp.version, attemptedAt: prefs.attempted.at });
    }
    return;
  }
  if (prefs.skipped && String(prefs.skipped) === String(latestApp.version)) return; // user skipped this version
  const changed = !updateAvailableInfo || updateAvailableInfo.version !== latestApp.version;
  updateAvailableInfo = { ...latestApp, currentVersion: APP_VERSION };
  if (changed) {
    writeUserRuntimeLog("update-available", { current: APP_VERSION, latest: latestApp.version });
    if (prefs.auto) { downloadAndInstallUpdate().catch(() => {}); return; } // auto-download+install pref
    sendUpdateEvent("update:available", updateAvailableInfo);
  }
}

async function downloadAndInstallUpdate() {
  const info = updateAvailableInfo;
  if (!info || updateDownloading) return { ok: false, error: "busy" };
  updateDownloading = true; updateCancelRequested = false;
  const target = versionWatchTarget || connection;
  const base = String((target && target.serverUrl) || DEFAULT_LOGIN_API_URL || "").replace(/\/+$/, "");
  const url = base + (info.downloadUrl || "/api/download/app-user");
  // basename() the server-supplied filename so it can NEVER escape the temp dir (path traversal).
  const safeName = path.basename(String(info.filename || `CentriX-App-User-Setup-${info.version}.exe`)) || `CentriX-App-User-Setup-${info.version}.exe`;
  const dest = path.join(app.getPath("temp"), safeName);
  const ac = new AbortController();
  updateAbortController = ac;
  const cleanupTemp = () => { try { fs.unlinkSync(dest); } catch { /* ignore */ } };
  let fileStream = null;
  let lastProgressAt = Date.now();
  // Inactivity watchdog: a TCP stall AFTER headers makes reader.read() hang forever — abort so Cancel/timeout
  // actually work and the download can never wedge updateDownloading=true (blocking all future retries).
  const stallTimer = setInterval(() => { if (Date.now() - lastProgressAt > 45000) { try { ac.abort(); } catch { /* ignore */ } } }, 5000);
  try {
    sendUpdateEvent("update:progress", { phase: "download", percent: 0, version: info.version });
    const response = await fetch(url, { signal: ac.signal, headers: { "User-Agent": `CentriXAppUser/${APP_VERSION}`, "X-CentriX-App-Key": APP_REQUEST_KEY } });
    if (!response.ok || !response.body) throw new Error(`http-${response.status}`);
    const total = Number(response.headers.get("content-length")) || Number(info.size) || 0;
    fileStream = fs.createWriteStream(dest);
    // Turn a write-stream error (disk full / temp not writable) into a rejection instead of an unhandled
    // crash + a hung drain-await. Raced against every read/drain/end below; the extra catch mutes the
    // unhandled-rejection warning when it fires while not being awaited.
    const streamError = new Promise((_res, rej) => fileStream.on("error", rej));
    streamError.catch(() => {});
    const hash = crypto.createHash("sha256");
    const reader = response.body.getReader();
    let received = 0, lastEmit = -1, lastEmitAt = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), streamError]);
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      if (!fileStream.write(buf)) await Promise.race([new Promise((r) => fileStream.once("drain", r)), streamError]);
      received += buf.length; lastProgressAt = Date.now();
      const pct = total ? Math.floor((received / total) * 100) : 0;
      const now = Date.now();
      // Throttle to ~10 emits/sec (not once per 1%, which on a fast link floods the IPC + renderer). Always
      // emit the final 100% so the bar lands full before the verify phase.
      if (pct !== lastEmit && (now - lastEmitAt >= 100 || pct >= 100)) {
        lastEmit = pct; lastEmitAt = now;
        sendUpdateEvent("update:progress", { phase: "download", percent: pct, received, total, version: info.version });
      }
    }
    await Promise.race([new Promise((res, rej) => fileStream.end((e) => (e ? rej(e) : res()))), streamError]);
    // FAIL CLOSED: never run an installer we could not verify. Absent hash (server config/stat error) = refuse.
    const digest = hash.digest("hex");
    if (!info.sha256 || digest.toLowerCase() !== String(info.sha256).toLowerCase()) throw new Error("verify-failed");
    sendUpdateEvent("update:progress", { phase: "verify", percent: 100, version: info.version });
    // MANUAL-RESTART install, NO .cmd helper (owner: the waiter .cmd flashed a visible "find …" console window).
    // We ARM the installer instead: remember the verified Setup path, tell the UI to "tắt rồi mở lại", and run
    // the installer from the app's own before-quit hook (see armed-installer handler below) the moment the user
    // closes the app. The Inno [Code] PrepareToInstall taskkills any lingering process + Sleep(1500) before the
    // file copy, so there is no lock race and no waiter script is needed. The app does NOT relaunch itself.
    pendingUpdateInstaller = dest;
    pendingUpdateVersion = info.version;
    updateDownloading = false;
    // Record that we ARMED an installer for this version. If, after the app quits→installs→relaunches, we are
    // still below this version, maybeOfferUpdate's loop-breaker auto-skips it instead of nagging forever.
    try { const p = readUpdatePrefs(); p.attempted = { version: info.version, at: Date.now() }; writeUpdatePrefs(p); } catch { /* best-effort */ }
    sendUpdateEvent("update:installing", { version: info.version });
    writeUserRuntimeLog("update-installer-armed", { version: info.version, path: dest });
    return { ok: true };
  } catch (error) {
    if (fileStream) { try { fileStream.destroy(); } catch { /* ignore */ } }
    cleanupTemp();
    updateDownloading = false;
    const msg = error && error.message;
    const reason = (ac.signal.aborted || msg === "cancelled") ? "cancelled" : (msg === "verify-failed" ? "verify-failed" : "download-failed");
    sendUpdateEvent("update:error", { reason });
    writeUserRuntimeLog("update-error", { reason, error: msg || String(error) });
    return { ok: false, error: reason };
  } finally {
    clearInterval(stallTimer);
    updateAbortController = null;
  }
}

// Back-compat: the 426 path in serverRequest still calls this; it now hard-locks instead of showing a dialog.
function triggerVersionBlock(verdict, target) { applyVersionLock(verdict, target); }

// ── ACCOUNT hard-lock ──────────────────────────────────────────────────────────────────────────────
// Admin "Khóa tài khoản" revokes every session server-side, but a user sitting on an ALREADY-loaded
// service view (or idle on the dashboard) sends no gated request — so nothing 401s and the app keeps
// working. A DEDICATED watchdog polls /api/account/lock-status (public, works even with the now-dead
// token) so the lock is caught within one interval regardless of activity. On lock we HARD-FREEZE exactly
// like the version gate: stop every poll, tear down every tab, block all traffic + opening services, and
// paint a full-screen un-dismissable overlay. Because locking REVOKES the session, "unlock" cannot
// silently resume — the watchdog lifts the freeze back to a clean login screen so the user re-authenticates.
let accountLocked = false;
let accountLockWatchTarget = null;
let accountLockWatchdogTimer = null;
const ACCOUNT_LOCK_WATCHDOG_MS = Math.max(5000, Number(process.env.CENTRIX_ACCOUNT_LOCK_WATCHDOG_MS || 8000));

// Poll the PUBLIC lock-status with the current token (its own fetch, NOT serverRequest, so it is exempt
// from the freeze). Returns true=locked / false=not-locked / null=unknown (transient — decide nothing).
async function probeAccountLocked(target) {
  const serverUrl = String((target && target.serverUrl) || "").replace(/\/+$/, "");
  const token = String((target && target.token) || "");
  if (!serverUrl || !token) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${serverUrl}/api/account/lock-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `CentriXAppUser/${APP_VERSION}`, "X-CentriX-App-Key": APP_REQUEST_KEY },
      body: JSON.stringify({ token }),
      signal: controller.signal
    });
    const raw = await response.text();
    const json = raw ? JSON.parse(raw) : {};
    return (json && json.ok && json.found) ? Boolean(json.locked) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Admin unlocked the account (or the overlay/relogin path fired): lift the freeze and signal the renderer
// to run a REAL logout to the login screen. The renderer drives the secure teardown via disconnectFromServer
// (self-revoke this user's session + wipe borrowed cookies + close tabs), so we don't do a shallow local
// drop here — that was the hole ("Đăng xuất only closed the popup").
function liftAccountLockToRelogin() {
  accountLocked = false;
  stopAccountLockWatchdog();
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("account:unlock", {}); } catch { /* renderer may be gone */ }
  writeUserRuntimeLog("account-unlock-relogin", {});
}

function applyAccountLock() {
  const already = accountLocked;
  accountLocked = true;
  // Freeze everything: stop the polls that would spam a dead token, tear down every open AI tab.
  clearInterval(heartbeatTimer);
  clearTimeout(syncTimer);
  stopProfileLivePoll();
  try { if (browserManager) browserManager.closeAll(); } catch { /* best-effort */ }
  const payload = { reason: "account-locked", message: "Tài khoản của bạn đã bị khóa. Vui lòng liên hệ quản trị viên." };
  const sendLock = () => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("account:lock", payload); } catch { /* renderer may not be ready */ } };
  sendLock();
  // Re-send: on a race the overlay listener may not be registered yet. Idempotent (overlay re-renders).
  for (const d of [400, 1200, 3000]) setTimeout(() => { if (accountLocked) sendLock(); }, d);
  if (!already) writeUserRuntimeLog("account-lock", payload);
  startAccountLockWatchdog(connection); // keep polling so an admin UN-lock auto-lifts to the login screen
}

function startAccountLockWatchdog(target) {
  if (target && target.serverUrl && target.token) accountLockWatchTarget = target;
  if (accountLockWatchdogTimer) return;
  const tick = async () => {
    const t = accountLockWatchTarget || connection;
    if (!t || !t.serverUrl || !t.token) return;
    const locked = await probeAccountLocked(t);
    if (locked === true) applyAccountLock();
    else if (locked === false && accountLocked) liftAccountLockToRelogin();
  };
  accountLockWatchdogTimer = setInterval(tick, ACCOUNT_LOCK_WATCHDOG_MS);
  tick(); // check immediately
}
function stopAccountLockWatchdog() { if (accountLockWatchdogTimer) { clearInterval(accountLockWatchdogTimer); accountLockWatchdogTimer = null; } accountLockWatchTarget = null; }

// Blocked-links watchdog: periodically pull the freshest per-service blocklist (GET /api/services) and
// hard-stop any OPEN tab already sitting on a now-blocked link, so an admin block takes effect on an
// already-open tab within one interval (not only on the next open). Never throws; skips while frozen.
let blockedLinksWatchdogTimer = null;
const BLOCKED_LINKS_WATCHDOG_MS = Math.max(10000, Number(process.env.CENTRIX_BLOCKED_LINKS_WATCHDOG_MS || 30000));
function startBlockedLinksWatchdog() {
  if (blockedLinksWatchdogTimer) return;
  const tick = async () => {
    if (!connection || accountLocked || versionLocked) return;
    // /api/services is a HEAVY read server-side (full scoped config). Only poll while a tab is actually
    // open — with no open tab there is nothing to enforce, and the next service OPEN pulls fresh anyway.
    if (!browserManager || browserManager.tabs.size === 0) return;
    try { await refreshServicesFromServer(); } catch { /* keep last-known blocklist on a transient error */ }
    try { browserManager.enforceBlockedLinksOnOpenTabs(); } catch { /* watchdog must never throw */ }
  };
  blockedLinksWatchdogTimer = setInterval(tick, BLOCKED_LINKS_WATCHDOG_MS);
}
function stopBlockedLinksWatchdog() { if (blockedLinksWatchdogTimer) { clearInterval(blockedLinksWatchdogTimer); blockedLinksWatchdogTimer = null; } }

// AUTO RE-SEED poll: nhiều dịch vụ logout bằng DOM-swap thuần (không phát navigate/load event) → soi active-tab
// định kỳ để vẫn bắt được form login xuất hiện tại chỗ. Nhẹ (1 executeJavaScript/4s trên đúng tab đang xem).
let reseedPollTimer = null;
function startReseedPoll() {
  if (!AUTO_RESEED || reseedPollTimer) return;
  reseedPollTimer = setInterval(() => {
    try {
      if (!connection || accountLocked || versionLocked || !profilePoolMode) return;
      const t = browserManager && browserManager.activeTab;
      if (t && !t.recovering) browserManager.checkLoginState(t, "poll").catch(() => {});
    } catch { /* poll must never throw */ }
  }, Math.max(2000, Number(process.env.CENTRIX_RESEED_DOM_POLL_MS) || 4000));
}

async function serverRequest(pathname, options = {}) {
  // While version-locked, no App-User traffic goes out (heartbeat, polls, opens all stall) — the only
  // exception is the health watchdog (bypassVersionLock) that detects the un-block. This makes the lock a
  // real freeze, not just a visual overlay.
  if (versionLocked && !options.bypassVersionLock) {
    const e = new Error("version-locked");
    e.versionLocked = true;
    throw e;
  }
  // Account hard-lock freezes ALL traffic too (the lock-status watchdog uses its own fetch, not this path).
  if (accountLocked && !options.bypassAccountLock) {
    const e = new Error("account-locked");
    e.accountLocked = true;
    throw e;
  }
  const target = options.connection || connection;
  if (!target?.serverUrl || !target?.token) {
    throw new Error("Server connection is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30000);

  try {
    const response = await fetch(`${target.serverUrl}${pathname}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "X-CentriX-App-Key": APP_REQUEST_KEY, // gate for the Cloudflare Skip WAF rule (edge friction layer)
        "X-CentriX-User": String(target.deviceId || DEFAULT_DEVICE_ID),
        "X-CentriX-Profile": String(target.profileId || DEFAULT_PROFILE),
        // Proof-of-possession factor (enforced server-side only when CENTRIX_BIND_SESSION_KEY=1):
        // a token copied without this per-session key cannot be replayed.
        "X-CentriX-Session": String(target.sessionKey || ""),
        "User-Agent": `CentriXAppUser/${APP_VERSION}`, // distinct client UA so the server export-gate can tell the real app from a script
        "X-CentriX-Attest": clientAttestHeader(target.deviceId || DEFAULT_DEVICE_ID), // Layer 1.3 app attestation (HMAC of build secret)
        "X-CentriX-Proof": makeDeviceProof({ method: options.method || "GET", url: `${target.serverUrl}${pathname}`, token: target.token, nonce: dpopNonce }), // DPoP device-binding (CentriX-KeyHardening §3)
        ...(String(pathname).startsWith("/api/profile/export") ? { "X-CentriX-Sig": exportSignHeader(target.token, target.profileId) } : {}), // origin anti-replay signature
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    try { const nn = response.headers.get("dpop-nonce"); if (nn) dpopNonce = nn; } catch { /* DPoP nonce, best-effort */ }
    const raw = await response.text();
    let result = {};
    try {
      result = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`Server URL khong tra JSON CentriX (${response.status}). Neu dung Cloudflare Tunnel, hay doi den khi Server bao Public URL da kiem tra OK roi copy lai URL moi.`);
    }
    if (!response.ok || !result.ok) {
      writeUserRuntimeLog("server-request-fail", { pathname, status: response.status, ok: result.ok, error: result.error || "", forceLogout: response.status === 401 && target === connection && options.forceLogoutOn401 === true });
      // Drop the local session ONLY when the canonical auth-check (/api/me, forceLogoutOn401:true)
      // returns 401. The tunnel/older server 401s several feature routes (url-history, activity,
      // portal, profile sync) for a freshly-issued token; treating ANY of those 401s as token-expiry
      // force-logged-out the user right after connect → balance showed 0 and the model gate failed
      // open (chat ran free). A genuinely dead token is still caught by the periodic /api/me poll.
      if (
        response.status === 401 &&
        target === connection &&
        options.forceLogoutOn401 === true &&
        (Date.now() - connectionEstablishedAt) > AUTH_EXPIRY_GRACE_MS
      ) {
        forceLogoutOnAuthExpiry();
      }
      // Version gate: ANY 426 (update-required) → show the force-update overlay ONCE, then still throw as a failure.
      if (response.status === 426) { triggerVersionBlock(result, target); }
      const err = new Error(result.error || `HTTP ${response.status}`);
      err.httpStatus = response.status;
      err.payload = result;
      throw err;
    }
    return result;
  } catch (error) {
    // Preserve the structured status/body (e.g. the 423 single-device takeover info) through the
    // human-friendly connection-message wrapper so callers can branch on it.
    const wrapped = new Error(connectionErrorMessage(error, target));
    if (error && error.httpStatus !== undefined) wrapped.httpStatus = error.httpStatus;
    if (error && error.payload !== undefined) wrapped.payload = error.payload;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

function activityDetails(details) {
  if (!details) return "";
  if (typeof details === "string") return details.slice(0, 1000);
  try {
    return JSON.stringify(details).slice(0, 1000);
  } catch {
    return String(details).slice(0, 1000);
  }
}

async function recordClientActivity(input = {}, options = {}) {
  if (!connection) return null;
  return serverRequest("/api/users/activity", {
    method: "POST",
    timeoutMs: options.timeoutMs || 8000,
    tolerateAuthError: true,
    body: {
      userId: connection.deviceId || currentDeviceId(),
      deviceId: currentDeviceId(),
      profileId: connection.profileId || DEFAULT_PROFILE,
      serviceId: input.serviceId || "client",
      action: input.action || "event",
      url: input.url || "",
      title: input.title || "",
      details: activityDetails(input.details)
    }
  }).catch(() => null);
}

async function fetchUserActivity(input = {}) {
  if (!connection) return { activity: [] };
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(500, Math.round(Number(input?.limit || 250)))))
  });
  if (input?.serviceId) params.set("serviceId", String(input.serviceId));
  return serverRequest(`/api/users/activity?${params.toString()}`, {
    timeoutMs: input?.timeoutMs || 8000,
    tolerateAuthError: true
  }).catch(() => ({ ok: false, activity: [] }));
}

// Dedicated per-user usage-history (Nhật ký) — durable server store, separate from the capped
// activity audit log, so it survives restart + device changes.
async function fetchUrlHistory(input = {}) {
  if (!connection) return { ok: false, urlHistory: [] };
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(300, Math.round(Number(input?.limit || 300)))))
  });
  return serverRequest(`/api/users/url-history?${params.toString()}`, {
    timeoutMs: input?.timeoutMs || 8000,
    tolerateAuthError: true
  }).catch(() => ({ ok: false, urlHistory: [] }));
}

async function pushUrlHistory(input = {}) {
  if (!connection) return { ok: false, urlHistory: [] };
  const items = Array.isArray(input?.items) ? input.items.slice(0, 100) : [];
  if (!items.length) return { ok: true, urlHistory: [] };
  return serverRequest("/api/users/url-history", {
    method: "POST",
    timeoutMs: input?.timeoutMs || 8000,
    tolerateAuthError: true,
    body: { items }
  }).catch(() => ({ ok: false, urlHistory: [] }));
}

function activeConnectionMatches(snapshot, profileId) {
  return Boolean(
    connection &&
      snapshot &&
      connection.serverUrl === snapshot.serverUrl &&
      connection.token === snapshot.token &&
      connection.deviceId === snapshot.deviceId &&
      connection.profileId === profileId
  );
}

function emitProfileSyncState(payload = {}) {
  const next = {
    ok: payload.ok !== false,
    status: payload.status || "idle",
    phase: payload.phase || "",
    message: payload.message || "",
    error: payload.error || "",
    profileId: payload.profileId || connection?.profileId || DEFAULT_PROFILE,
    initialReady: profileInitialSyncComplete,
    storageReady: initialStorageSyncComplete,
    profile: payload.profile || null,
    reloadedTabs: payload.reloadedTabs || 0
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("profile:sync-state", next);
  }
  return next;
}

function resetProfileSyncState() {
  profileInitialSyncComplete = false;
  initialStorageSyncComplete = false;
  profileInitialSyncPromise = null;
  profileStorageSyncPromise = null;
  // Session boundary: rules and staged cookies belong to the (server, account) that delivered them.
  // A reconnect to another server/account must NOT inherit the previous session's hide/replace rules
  // (the delivered rows include userScript = code execution) nor apply its staged whole-account
  // snapshot on top of freshly pulled pool cookies.
  profileUiRules = new Map();
  stagedProfileSnapshot = null;
  stagedProfileRevision = 0;
}

function enabledServicesFromConfig(config) {
  return (config?.services || []).filter((service) => service.enabled !== false);
}

function selectorLooksUsable(selector) {
  const clean = String(selector || "").trim();
  if (!clean || clean.length > 500) return false;
  if (/[{};]/.test(clean) || /!important/i.test(clean)) return false;
  if (/^\/\*/.test(clean) || clean.startsWith("* /") || clean.startsWith("@")) return false;
  if (/^[a-z-]+\s*:/i.test(clean)) return false;
  return true;
}

function normalizeHideSelectors(value) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
  const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, "\n");
  const selectors = [];
  let inBlock = false;

  for (const rawLine of withoutComments.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.includes("{")) {
      const selector = line.slice(0, line.indexOf("{")).trim().replace(/,$/, "");
      if (selectorLooksUsable(selector)) selectors.push(selector);
      inBlock = !line.includes("}");
      continue;
    }

    if (inBlock) {
      if (line.includes("}")) inBlock = false;
      continue;
    }

    const selector = line.replace(/,$/, "");
    if (selectorLooksUsable(selector)) selectors.push(selector);
  }

  return Array.from(new Set(selectors)).slice(0, 80);
}

// Single source of truth for a service's UI rules. POOL mode: rules delivered WITH the per-service
// profile export win — every (re)load pulls fresh, so the tab always renders with the rules its
// profile arrived with. NON-pool mode: the whole-account snapshot is pulled only at connect / on a
// revision bump, and rule saves never bump the blob revision — preferring the map there would freeze
// Manager edits/deletes until re-login, so the per-open /api/services fetch stays the source (same DB
// rows, refreshed by serviceByIdFresh on every open). Fallback also covers servers that don't embed
// rules in the export yet.
function uiRulesSourceForService(service) {
  if (profilePoolMode) {
    const delivered = profileUiRules.get(String(service?.id || "").toLowerCase());
    if (Array.isArray(delivered)) return delivered;
  }
  return Array.isArray(service?.uiRules) ? service.uiRules : [];
}

function selectorsForService(service) {
  const selectors = [];
  for (const rule of uiRulesSourceForService(service)) {
    if (rule?.enabled !== true) continue;
    for (const hideRule of rule.hideRules || []) {
      const selector = String(hideRule?.primarySelector || hideRule?.selector || "").trim();
      if (hideRule?.enabled !== false && selectorLooksUsable(selector)) selectors.push(selector);
    }
    selectors.push(...normalizeHideSelectors(rule.hideSelectors || []));
  }
  return Array.from(new Set(selectors)).slice(0, 80);
}

function normalizeReplaceRules(value) {
  const rawRules = Array.isArray(value) ? value : [];
  const clean = [];

  for (const raw of rawRules) {
    if (!raw || typeof raw !== "object") continue;
    const selector = String(raw.selector || "").trim();
    if (!selectorLooksUsable(selector)) continue;
    clean.push({
      selector: selector.slice(0, 500),
      text: String(raw.text ?? raw.replacement ?? "").slice(0, 1200),
      matchText: String(raw.matchText || "").slice(0, 600),
      enabled: raw.enabled !== false
    });
  }

  return clean.slice(0, 80);
}

function replaceRulesForService(service) {
  const rules = [];
  const seen = new Set();

  for (const rule of uiRulesSourceForService(service)) {
    if (rule?.enabled !== true) continue;
    for (const replaceRule of normalizeReplaceRules(rule.replaceRules || [])) {
      const key = `${replaceRule.selector}\n${replaceRule.text}\n${replaceRule.matchText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push(replaceRule);
    }
  }

  return rules.slice(0, 80);
}

function hideCssRulesForService(service) {
  const cssRules = [];
  const seen = new Set();
  const pushCss = (selector, action = "hide") => {
    if (!selectorLooksUsable(selector) || seen.has(selector)) return;
    seen.add(selector);
    if (action === "collapse") {
      cssRules.push(`${selector} { display: block !important; max-height: 0 !important; height: 0 !important; min-height: 0 !important; overflow: hidden !important; opacity: 0 !important; pointer-events: none !important; }`);
      return;
    }
    cssRules.push(`${selector} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`);
  };

  for (const rule of uiRulesSourceForService(service)) {
    if (rule?.enabled !== true) continue;
    for (const hideRule of rule.hideRules || []) {
      const selector = String(hideRule?.primarySelector || hideRule?.selector || "").trim();
      if (hideRule?.enabled !== false) pushCss(selector, hideRule?.action || "hide");
    }
    for (const selector of normalizeHideSelectors(rule.hideSelectors || [])) {
      pushCss(selector, "hide");
    }
  }
  return cssRules.slice(0, 80);
}

// Verbatim custom CSS the manager wrote (rides the same ui_rules row as the hide selectors). Applied AS-IS,
// NOT selector-wrapped — this is the "CSS tùy chỉnh" box, so `.foo{display:none} .bar{opacity:0}` works whole.
function customCssForService(service) {
  const blocks = [];
  const seen = new Set();
  for (const rule of uiRulesSourceForService(service)) {
    if (rule?.enabled !== true) continue;
    const css = String(rule.customCss || "").trim();
    if (css && !seen.has(css)) { seen.add(css); blocks.push(css); }
  }
  return blocks.join("\n");
}

function hideCssTextForService(service) {
  // Selector-wrapped hides + the manager's raw custom CSS share ONE insertCSS payload (applyUiRules re-inserts
  // it on every (re)open, so the App User always shows the manager's LATEST hide + custom CSS).
  const hide = hideCssRulesForService(service).join("\n");
  const custom = customCssForService(service);
  return custom ? (hide ? `${hide}\n${custom}` : custom) : hide;
}

function encodeBase64Url(value) {
  return Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function uiHideArgumentForService(service) {
  const css = hideCssTextForService(service);
  return `--centrix-ui-hide-css=${encodeBase64Url(css)}`;
}

function uiReplaceArgumentForService(service) {
  return `--centrix-ui-replace-rules=${encodeBase64Url(JSON.stringify(replaceRulesForService(service)))}`;
}

function sanitizeUserScript(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .slice(0, 30000);
}

// SECURITY: a service's `userScript` runs as arbitrary JS inside the logged-in service page (via the
// preload `new Function` runner and executeJavaScript). A compromised server/config could push a script
// that steals the user's authenticated session or acts as them. So userScript is DISABLED by default and
// only runs when the operator explicitly opts in on the App User process. Hide-CSS + declarative
// replace-text (separate helpers) are unaffected — they remain the default UI-rule surface.
const ALLOW_UI_USERSCRIPT = process.env.CENTRIX_ALLOW_UI_USERSCRIPT === "1";

function userScriptsForService(service) {
  if (!ALLOW_UI_USERSCRIPT) return []; // fail-closed: no userScript execution unless explicitly enabled
  const scripts = [];
  const seen = new Set();
  for (const rule of uiRulesSourceForService(service)) {
    if (rule?.enabled !== true) continue;
    const script = sanitizeUserScript(rule.userScript || "").trim();
    if (!script || seen.has(script)) continue;
    seen.add(script);
    scripts.push(script);
  }
  return scripts;
}

function uiUserScriptArgumentForService(service) {
  return `--centrix-ui-user-script=${encodeBase64Url(userScriptsForService(service).join("\n\n;"))}`;
}

function userScriptRunnerForService(service) {
  const script = userScriptsForService(service).join("\n\n;");
  if (!script.trim()) return "";
  const serviceId = String(service?.id || "service");
  const key = crypto.createHash("sha1").update(`${serviceId}:${script}`, "utf8").digest("hex").slice(0, 16);
  // CSP-SAFE: KHÔNG dùng `new Function(...)` (= eval) — site CSP nghiêm ngặt (ChatGPT…) chặn 'unsafe-eval'
  // nên userScript không chạy. Thay vào đó NỘI TUYẾN thân script làm body của một async function expression;
  // executeJavaScript chạy code inject ở top-level (không bị CSP chặn) và function expression KHÔNG phải eval.
  // Build bằng NỐI CHUỖI (không template literal) để backtick/${ } trong script không phá cấu trúc runner.
  return "(async () => {\n"
    + '  const attr = "data-centrix-userscript-' + key + '";\n'
    + "  const root = document.documentElement || document.body;\n"
    + '  if (root && root.getAttribute(attr) === "1") return { ok: true, skipped: true, reason: "already-ran" };\n'
    + '  if (root) root.setAttribute(attr, "1");\n'
    + "  const context = { mode: \"app-user\", serviceId: " + JSON.stringify(serviceId)
    + ", serviceName: " + JSON.stringify(String(service?.name || "")) + ", url: location.href };\n"
    + "  window.__centrixUserScriptContext = context;\n"
    + "  try {\n"
    + "    const value = await (async function (context) {\n"
    + script + "\n"
    + "    }).call(window, context);\n"
    + "    return { ok: true, value: value === undefined ? null : String(value).slice(0, 500) };\n"
    + "  } catch (error) {\n"
    + "    return { ok: false, error: error && error.message ? error.message : String(error) };\n"
    + "  }\n"
    + "})()";
}

function normalizeUiCacheItems(value) {
  const rows = Array.isArray(value) ? value : [];
  const clean = [];
  const seen = new Set();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const href = String(raw.href || "").trim();
    const chatId = String(raw.chatId || raw.itemId || "").trim();
    const key = chatId || href;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push({
      itemId: String(raw.itemId || key).slice(0, 220),
      chatId: chatId.slice(0, 160),
      href: href.slice(0, 1000),
      title: String(raw.title || "Untitled").trim().slice(0, 240) || "Untitled",
      source: String(raw.source || "cache").slice(0, 40),
      firstSeenAt: String(raw.firstSeenAt || raw.lastSeenAt || new Date().toISOString()).slice(0, 64),
      lastSeenAt: String(raw.lastSeenAt || raw.updatedAt || new Date().toISOString()).slice(0, 64),
      sessionId: String(raw.sessionId || "").slice(0, 120)
    });
  }
  return clean.slice(0, 120);
}

function replaceRulesScriptForService(service) {
  const rules = replaceRulesForService(service);
  if (!rules.length) return "";

  // PERSISTENT replace: a one-shot querySelectorAll+textContent is undone the moment the SPA (ChatGPT/…)
  // re-renders that node, so "đổi text" never stuck. Re-apply on every DOM mutation (rAF-debounced, self-
  // converging because replaceElement no-ops when the text already matches) + a short interval backstop for
  // late/lazy nodes. Registers window.__cxAppReplaceCleanup so a later apply (rule cleared) tears it down.
  return `(() => {
    // Tear down any prior CentriX replace observer FIRST so a changed/cleared rule set doesn't leave the old
    // one running (that kept re-applying stale "đổi text" even after the rule was removed).
    try { if (window.__cxAppReplaceCleanup) window.__cxAppReplaceCleanup(); } catch (e) {}
    const rules = ${JSON.stringify(rules)};
    function shouldReplace(element, rule) {
      if (!rule.matchText) return true;
      const current = "value" in element ? String(element.value || "") : String(element.textContent || "");
      return current.includes(rule.matchText);
    }
    function replaceElement(element, text) {
      if (!element || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) return false;
      if ("value" in element && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) {
        if (String(element.value || "") === text) return false;
        element.value = text; element.setAttribute("value", text); return true;
      }
      if (element.isContentEditable) {
        if (String(element.textContent || "") === text) return false;
        element.textContent = text; return true;
      }
      if (String(element.textContent || "") === text) return false;
      element.textContent = text; return true;
    }
    function applyAll() {
      let applied = 0;
      for (const rule of rules) {
        if (!rule || rule.enabled === false || !rule.selector) continue;
        let elements = [];
        try { elements = Array.from(document.querySelectorAll(rule.selector)); } catch { continue; }
        for (const element of elements) { if (shouldReplace(element, rule) && replaceElement(element, String(rule.text || ""))) applied += 1; }
      }
      return applied;
    }
    applyAll();
    let raf = 0;
    const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; applyAll(); }); };
    let obs = null; try { obs = new MutationObserver(schedule); obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (e) {}
    let ticks = 0;
    const iv = setInterval(() => { applyAll(); if (++ticks > 40) clearInterval(iv); }, 1000);
    // Expose a teardown so the NEXT applyUiRules (e.g. after the rule is cleared) can stop this observer.
    window.__cxAppReplaceCleanup = function () { try { obs && obs.disconnect(); } catch (e) {} try { clearInterval(iv); } catch (e) {} window.__cxAppReplaceCleanup = null; };
    return { ok: true, rules: rules.length, persistent: true };
  })();`;
}

function collectUiCacheScript(service) {
  const serviceId = String(service?.id || "service");
  return `(() => {
    const serviceId = ${JSON.stringify(serviceId)};
    const now = new Date().toISOString();
    const localKey = "centrix_custom_ui_cache:" + serviceId + ":" + location.origin;
    const sessionKey = "centrix_custom_ui_session:" + serviceId + ":" + location.origin;

    function readStore(storage, key) {
      try {
        const parsed = JSON.parse(storage.getItem(key) || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function writeStore(storage, key, value) {
      try {
        storage.setItem(key, JSON.stringify(value.slice(0, 160)));
      } catch {
        // Storage can be blocked by the page.
      }
    }

    function chatIdFromPath(pathname) {
      const match = String(pathname || "").match(/^\\/(?:chat|chats|c|conversation|conversations)\\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]).slice(0, 160) : "";
    }

    function cleanTitle(anchor) {
      return String(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || anchor.title || "Untitled")
        .replace(/\\s+/g, " ")
        .trim()
        .slice(0, 180) || "Untitled";
    }

    function getChatsFromDOM() {
      const rows = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        if (anchor.closest("[data-centrix-ui-cache='true']")) continue;
        let url;
        try {
          url = new URL(anchor.getAttribute("href") || "", location.origin);
        } catch {
          continue;
        }
        if (url.origin !== location.origin) continue;
        const chatId = chatIdFromPath(url.pathname);
        if (!chatId) continue;
        const href = url.pathname + url.search + url.hash;
        rows.push({
          itemId: chatId || href,
          chatId,
          href,
          title: cleanTitle(anchor),
          source: "dom",
          firstSeenAt: now,
          lastSeenAt: now
        });
      }
      const currentId = chatIdFromPath(location.pathname);
      if (currentId) {
        rows.push({
          itemId: currentId,
          chatId: currentId,
          href: location.pathname + location.search + location.hash,
          title: String(document.title || currentId).replace(/\\s+-\\s+Claude$/i, "").replace(/\\s+/g, " ").trim().slice(0, 180) || "Current chat",
          source: "location",
          firstSeenAt: now,
          lastSeenAt: now
        });
      }
      return rows;
    }

    function mergeChats(...lists) {
      const map = new Map();
      for (const item of lists.flat()) {
        if (!item || (!item.href && !item.chatId && !item.itemId)) continue;
        const chatId = String(item.chatId || chatIdFromPath(item.href || "") || item.itemId || "").slice(0, 160);
        const href = String(item.href || "").slice(0, 1000);
        const key = chatId || href;
        if (!key) continue;
        const old = map.get(key);
        const lastSeenAt = [old?.lastSeenAt, item.lastSeenAt, item.updatedAt, now].filter(Boolean).sort().at(-1);
        map.set(key, {
          ...old,
          ...item,
          itemId: String(item.itemId || key).slice(0, 220),
          chatId,
          href,
          title: String(item.title || old?.title || "Untitled").replace(/\\s+/g, " ").trim().slice(0, 180) || "Untitled",
          firstSeenAt: old?.firstSeenAt || item.firstSeenAt || now,
          lastSeenAt,
          source: item.source || old?.source || "dom"
        });
      }
      return Array.from(map.values())
        .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
        .slice(0, 160);
    }

    const domChats = getChatsFromDOM();
    const sessionChats = readStore(sessionStorage, sessionKey);
    const localChats = readStore(localStorage, localKey);
    const merged = mergeChats(localChats, sessionChats, domChats);
    writeStore(sessionStorage, sessionKey, merged);
    writeStore(localStorage, localKey, merged);
    return { items: merged, domCount: domChats.length, count: merged.length, url: location.href, title: document.title || "" };
  })();`;
}

function requestBodyText(details) {
  const chunks = [];
  for (const item of details.uploadData || []) {
    if (item.bytes) chunks.push(Buffer.from(item.bytes));
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

// TÍNH TIỀN THEO TOKEN: ước lượng token của INPUT gửi lên dịch vụ = số ký tự body / tỉ lệ (VN ≈ 3,5 ký tự/
// token, chỉnh qua CENTRIX_TOKEN_CHARS_PER_TOKEN). File đính kèm upload qua endpoint riêng nên body ≈ prompt +
// metadata nhỏ. Server chỉ ÁP token-pricing khi model có credit_per_ktok > 0; else vẫn giá cố định như cũ.
const TOKEN_CHARS_PER_TOKEN = (() => {
  const v = Number(process.env.CENTRIX_TOKEN_CHARS_PER_TOKEN);
  return Number.isFinite(v) && v > 0 ? v : 3.5;
})();
// (b) Trần token/request: chặn 1 lần gửi body dị thường ước ra token khổng lồ. 0 = không kẹp. Server cũng kẹp lại.
const MAX_TOKENS_PER_REQUEST = (() => {
  const v = Number(process.env.CENTRIX_MAX_TOKENS_PER_REQUEST);
  return Number.isFinite(v) && v >= 0 ? v : 2000000;
})();
// (a) Ngưỡng credit hỏi xác nhận trước khi gửi (chống paste nhầm tốn nhiều). 0 = tắt.
const CHARGE_CONFIRM_CREDITS = (() => {
  const v = Number(process.env.CENTRIX_CHARGE_CONFIRM_CREDITS);
  return Number.isFinite(v) && v >= 0 ? v : 50;
})();
function estimateTokensFromRequest(details) {
  const body = requestBodyText(details);
  const chars = body ? body.length : 0;
  if (chars <= 0) return 0;
  let toks = Math.ceil(chars / TOKEN_CHARS_PER_TOKEN);
  if (MAX_TOKENS_PER_REQUEST > 0) toks = Math.min(toks, MAX_TOKENS_PER_REQUEST);
  return toks;
}
// (a) Hỏi xác nhận native khi 1 lần gửi ước tính tốn >= ngưỡng credit. Trả true = tiếp tục, false = hủy gửi.
async function confirmLargeCharge(service, creditCost, estimatedTokens) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return true; // không có cửa sổ → không chặn
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Hủy", "Tiếp tục"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      title: "Xác nhận chi phí",
      message: `Lần gửi này ước tính tốn ${creditCost} credit`,
      detail: `Dịch vụ: ${(service && (service.name || service.id)) || ""}\nƯớc lượng ~${Number(estimatedTokens || 0).toLocaleString("vi-VN")} token.\nTiếp tục gửi?`
    });
    return response === 1;
  } catch {
    return true; // lỗi dialog → không chặn người dùng
  }
}

function findModelInValue(value, depth = 0) {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findModelInValue(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  for (const [key, nested] of Object.entries(value)) {
    if (/^(model|model_id|modelId|model_slug|modelSlug|selected_model|selectedModel|target_model|targetModel)$/i.test(key) && typeof nested === "string") {
      return nested.trim();
    }
  }

  for (const nested of Object.values(value)) {
    const found = findModelInValue(nested, depth + 1);
    if (found) return found;
  }
  return "";
}

function modelFromRequestBody(rawBody) {
  const body = String(rawBody || "").trim();
  if (!body) return "";

  try {
    const parsed = JSON.parse(body);
    const found = findModelInValue(parsed);
    if (found) return found;
  } catch {
    // Try form data below.
  }

  try {
    const form = new URLSearchParams(body);
    return form.get("model") || form.get("model_id") || form.get("model_slug") || form.get("selected_model") || "";
  } catch {
    return "";
  }
}

function modelFromRequest(details) {
  try {
    const parsed = new URL(details.url);
    const queryModel = parsed.searchParams.get("model") || parsed.searchParams.get("model_id") || parsed.searchParams.get("model_slug");
    if (queryModel) return queryModel.trim();
  } catch {
    // Fall through to request body.
  }
  return modelFromRequestBody(requestBodyText(details));
}

// Capture the reasoning EFFORT / thinking tier alongside the model so each tier can be priced.
//  - ChatGPT  : model="gpt-5-5-thinking" + thinking_effort="standard"|"extended"|"max".
//  - Claude.ai: model="claude-opus-4-8"  + effort="low|medium|high|xhigh|max"  (Opus reasoning slider),
//               and/or thinking_mode="extended" (Haiku extended-thinking). thinking_mode="auto"/"off"
//               means no explicit deeper reasoning → keep the BASE model id (no suffix).
// Priority: a real effort value (PRIMARY) wins over thinking_mode (SECONDARY); neutral values are dropped.
const EFFORT_PRIMARY_KEY_RE = /^(thinking_effort|reasoning_effort|reasoningEffort|effort)$/i;
const EFFORT_SECONDARY_KEY_RE = /^(thinking_mode|reasoning_mode|reasoningMode|thinkingMode)$/i;
const EFFORT_NEUTRAL_VALUES = new Set(["", "auto", "off", "none", "default", "disabled", "false", "0"]);
function isNeutralEffort(value) { return EFFORT_NEUTRAL_VALUES.has(String(value == null ? "" : value).trim().toLowerCase()); }
function findEffortKeyDeep(value, keyRe, depth = 0) {
  if (depth > 8 || value == null || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) { const f = findEffortKeyDeep(item, keyRe, depth + 1); if (f) return f; }
    return "";
  }
  for (const [key, nested] of Object.entries(value)) {
    if (keyRe.test(key) && (typeof nested === "string" || typeof nested === "number")) {
      const s = String(nested).trim();
      if (s && !isNeutralEffort(s)) return s;
    }
  }
  for (const nested of Object.values(value)) { const f = findEffortKeyDeep(nested, keyRe, depth + 1); if (f) return f; }
  return "";
}
function findEffortInValue(value) {
  return findEffortKeyDeep(value, EFFORT_PRIMARY_KEY_RE) || findEffortKeyDeep(value, EFFORT_SECONDARY_KEY_RE);
}
function effortFromRequest(details) {
  try {
    const parsed = new URL(details.url);
    const q = parsed.searchParams.get("thinking_effort") || parsed.searchParams.get("reasoning_effort")
      || parsed.searchParams.get("effort") || parsed.searchParams.get("thinking_mode") || parsed.searchParams.get("reasoning_mode");
    if (q && !isNeutralEffort(q)) return q.trim();
  } catch { /* fall through to body */ }
  const body = requestBodyText(details);
  if (body) {
    try { const f = findEffortInValue(JSON.parse(body)); if (f) return f; } catch { /* not json */ }
    try {
      const form = new URLSearchParams(body);
      const f = form.get("thinking_effort") || form.get("reasoning_effort") || form.get("effort")
        || form.get("thinking_mode") || form.get("reasoning_mode");
      if (f && !isNeutralEffort(f)) return f.trim();
    } catch { /* ignore */ }
  }
  return "";
}
function sanitizeEffort(effort) {
  return String(effort || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24);
}
// Combine into a single pricing key, e.g. "gpt-5-5-thinking_standard". "_" survives the server's
// sanitize_model_id (which strips ":"), so model_prices(serviceId, modelId) prices each effort tier.
function combineModelEffort(modelId, effort) {
  const e = sanitizeEffort(effort);
  return (modelId && e) ? `${modelId}_${e}` : modelId;
}

function likelyModelRequest(details, service) {
  if (String(details.method || "").toUpperCase() !== "POST") return false;
  if (!["fetch", "xhr"].includes(String(details.resourceType || ""))) return false;
  try {
    const parsed = new URL(details.url);
    const serviceId = String(service?.id || "").toLowerCase();
    if (serviceId === "chatgpt") {
      return /\/backend-api\/(?:f\/)?conversation|\/backend-api\/conversation\/prepare|\/backend-api\/conversation\/model/i.test(parsed.pathname);
    }
    if (serviceId === "claude") {
      return /\/chat_conversations|\/completion|\/append_message|\/retry/i.test(parsed.pathname);
    }
    if (serviceId === "gemini") {
      return /StreamGenerate/i.test(parsed.pathname);
    }
    if (serviceId === "perplexity") {
      return /perplexity_ask/i.test(parsed.pathname);
    }
    if (serviceId === "deepseek") {
      return /\/chat\/completion/i.test(parsed.pathname);
    }
    if (serviceId === "grok") {
      return /\/app-chat\/conversations|\/responses/i.test(parsed.pathname);
    }
    if (serviceId === "poe") {
      // Poe uses ONE GraphQL endpoint for everything; only the send-message mutation is a real prompt.
      return /\/api\/gql_POST\/?$/i.test(parsed.pathname) && !!poeSendMessageBody(details);
    }
    return /conversation|completion|message|chat|model/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function requestPathname(details) {
  try {
    return new URL(details.url).pathname;
  } catch {
    return "";
  }
}

function shouldConsumeModelQuota(details, service) {
  if (String(details.method || "").toUpperCase() !== "POST") return false;
  if (!["fetch", "xhr"].includes(String(details.resourceType || ""))) return false;

  const pathname = requestPathname(details);
  const serviceId = String(service?.id || "").toLowerCase();

  if (serviceId === "chatgpt") {
    // ChatGPT can send prepare/model metadata calls around the real prompt.
    // Only the conversation submit endpoint should spend daily model credit.
    return /^\/backend-api\/(?:f\/)?conversation\/?$/i.test(pathname);
  }

  if (serviceId === "claude") {
    return /\/chat_conversations\/[^/]+\/(?:completion|append_message|retry)\/?$/i.test(pathname) ||
      /\/(?:completion|append_message|retry)\/?$/i.test(pathname);
  }

  // Gemini submits the prompt via the lamda BardFrontendService StreamGenerate RPC (model is not in
  // the request — charged at the service default model cost). The `title`/`batchexecute` RPCs are
  // excluded so only the real prompt submit spends credit.
  if (serviceId === "gemini") {
    return /\/StreamGenerate(?:\/|$)/i.test(pathname);
  }

  // Perplexity submits via the SSE ask endpoint.
  if (serviceId === "perplexity") {
    return /\/(?:sse\/)?perplexity_ask(?:\/|$)/i.test(pathname);
  }

  // SPECULATIVE (known public endpoints, pending live capture): DeepSeek streams the prompt to
  // /api/v0/chat/completion; Grok submits to /rest/app-chat/conversations/new or .../responses.
  // Model is not reliably in the request → charged at the service default cost.
  if (serviceId === "deepseek") {
    return /\/chat\/completion(?:s)?(?:\/|$)/i.test(pathname);
  }
  if (serviceId === "grok") {
    return /\/app-chat\/conversations\/(?:new\b|[^/]+\/responses)(?:\/|$)/i.test(pathname) ||
      /\/conversations\/[^/]+\/responses(?:\/|$)/i.test(pathname);
  }

  // Poe: charge ONLY the send-message GraphQL mutation on /api/gql_POST (all other gql ops are free).
  if (serviceId === "poe") {
    return /\/api\/gql_POST\/?$/i.test(pathname) && !!poeSendMessageBody(details);
  }

  if (/\/(?:model|models|settings|config|profile|history|list|status|metadata)(?:\/|$)/i.test(pathname)) {
    return false;
  }
  return /\/(?:conversation|completion|message|chat)(?:\/|$)/i.test(pathname);
}

function requestBodyDigest(details) {
  const body = requestBodyText(details);
  return crypto.createHash("sha1").update(body || "").digest("hex");
}

// --- Capture-mode body skeleton (endpoint/field DISCOVERY only, env-gated) -------------------------
// Preserves the request STRUCTURE — every key name — and any short "model-id-like" value (e.g. "grok-3",
// "gemini-2.5-pro", "eleven_multilingual_v2", effort/mode flags), but REDACTS all prose (prompt text)
// and anything that looks like a token/secret/long-random blob to a "<str:N>" length marker. It never
// stores the user's prompt content — only enough to see WHICH field carries the model. Used solely when
// CENTRIX_GATE_CAPTURE=1; shipped builds never call it.
const CAPTURE_ID_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,47}$/;           // short id-like: model slugs, tiers, modes
const CAPTURE_SENSITIVE_KEY_RE = /token|auth|secret|key|cookie|session|bearer|password|sign|jwt|csrf|cred/i;
const CAPTURE_PROMPT_KEY_RE = /^(?:q|query|query_str|querystr|prompt|message|text|content|input|dsl_query|human|humaninput)$/i;
const CAPTURE_RANDOMISH_RE = /^(?:[0-9a-f]{16,}|[A-Za-z0-9_-]{32,})$/i;     // hex/uuid/long-random -> redact even if id-like
function captureRedactValue(key, value) {
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value !== "string") return value;
  const k = String(key || "");
  if (CAPTURE_SENSITIVE_KEY_RE.test(k)) return `<redacted:${value.length}>`;
  if (CAPTURE_PROMPT_KEY_RE.test(k)) return `<str:${value.length}>`;       // prompt/query field -> never log content
  if (CAPTURE_ID_VALUE_RE.test(value) && !CAPTURE_RANDOMISH_RE.test(value)) return value; // keep model-id-like
  return `<str:${value.length}>`;                                          // prose / long value -> length only
}
function captureWalk(value, key, depth, budget) {
  if (depth > 6) return "<deep>";
  if (budget.n <= 0) return "<capped>";
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length && i < 4 && budget.n > 0; i++) { budget.n--; out.push(captureWalk(value[i], key, depth + 1, budget)); }
    if (value.length > 4) out.push(`…(+${value.length - 4})`);
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) { if (budget.n <= 0) { out["…"] = "capped"; break; } budget.n--; out[k] = captureWalk(v, k, depth + 1, budget); }
    return out;
  }
  return captureRedactValue(key, value);
}
function redactedBodySkeleton(details) {
  const body = requestBodyText(details);
  if (!body) return null;
  const budget = { n: 200 };
  try { return captureWalk(JSON.parse(body), "", 0, budget); } catch { /* not json */ }
  try {
    const form = new URLSearchParams(body);
    const out = {};
    for (const [k, v] of form.entries()) { if (budget.n <= 0) break; budget.n--; out[k] = captureRedactValue(k, v); }
    return { _form: out };
  } catch { return `<raw:${body.length}>`; }
}
function topLevelKeys(details) {
  const body = requestBodyText(details);
  if (!body) return [];
  try { const p = JSON.parse(body); if (p && typeof p === "object" && !Array.isArray(p)) return Object.keys(p).slice(0, 40); } catch { /* not json */ }
  try { return [...new URLSearchParams(body).keys()].slice(0, 40); } catch { return []; }
}

const USAGE_REQUEST_DEDUP_TTL_MS = 8000;
const recentUsageRequestIds = new Map();

function usageRequestIdFor(details, service, modelId) {
  // The content key identifies "the same logical model request" (same service,
  // model, path and body). We deliberately do NOT fold wall-clock time into the
  // key: the old Math.floor(Date.now()/5000) bucket double-charged any retry that
  // straddled a 5s boundary (new bucket -> new key -> second debit). Instead each
  // content key keeps ONE stable id for a TTL window starting at first sight, so
  // genuine retries within the window reuse the id (the server's UNIQUE idempotency
  // key dedupes the debit) while a later resend gets a fresh id / fresh charge.
  const contentKey = crypto.createHash("sha1")
    .update([
      service?.id || "service",
      modelId || "__unknown__",
      requestPathname(details),
      requestBodyDigest(details)
    ].join("|"))
    .digest("hex");

  const now = Date.now();
  for (const [key, entry] of recentUsageRequestIds) {
    if (entry.expiresAt <= now) recentUsageRequestIds.delete(key);
  }

  const existing = recentUsageRequestIds.get(contentKey);
  if (existing && existing.expiresAt > now) return existing.id;

  const id = crypto.createHash("sha1")
    .update(`${contentKey}|${now}|${crypto.randomBytes(8).toString("hex")}`)
    .digest("hex");
  recentUsageRequestIds.set(contentKey, { id, expiresAt: now + USAGE_REQUEST_DEDUP_TTL_MS });
  return id;
}

// Only http/https (and about:blank) are allowed to load in a service tab.
// chrome://, devtools://, file://, etc. could expose the profile/disk and are
// blocked. about:blank is allowed because services use it for transient frames.
function isAllowedNavScheme(url) {
  const value = String(url || "").trim();
  if (!value || value === "about:blank") return true;
  try {
    const scheme = new URL(value).protocol;
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

// ── Manual blocked links (admin-managed, per service, delivered on GET /api/services) ────────────────
// A simple, ReDoS-safe glob: escape every regex meta, then turn the escaped "*" back into ".*". No other
// wildcards, so a malicious pattern can never build a catastrophic-backtracking regex.
function globToRegExp(pattern) {
  const escaped = String(pattern || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}
// Return the matching block rule (or null). exact/prefix are case-sensitive on the full URL; origin compares
// hosts via originOf; glob supports a single "*". Fail-OPEN: a bad pattern is skipped, never blocks wrongly.
function matchesBlockedLink(url, service) {
  const value = String(url || "");
  if (!value || value === "about:blank") return null;
  const list = Array.isArray(service?.blockedLinks) ? service.blockedLinks : [];
  for (const rule of list) {
    if (!rule || rule.enabled === false) continue;
    const pattern = String(rule.pattern || "");
    if (!pattern) continue;
    try {
      if (rule.matchType === "exact") { if (value === pattern) return rule; }
      else if (rule.matchType === "origin") { if (originOf(value) && originOf(value) === originOf(pattern)) return rule; }
      else if (rule.matchType === "glob") { if (globToRegExp(pattern).test(value)) return rule; }
      else if (value.startsWith(pattern)) return rule; // "prefix" (default)
    } catch { /* a broken rule must never break navigation */ }
  }
  return null;
}
function blockedLinkMessage(rule, service) {
  const custom = String(rule?.message || "").trim();
  if (custom) return custom;
  const name = service?.name || service?.id || "Dịch vụ";
  return `${name}: link này đã bị quản trị viên chặn.`;
}
// The GLOBAL (serviceId="") rules, collected across all services and deduped. Every service carries the
// global rows, so this is only needed for requests whose origin matches NO configured service (cross-origin
// api hosts, redirect targets) — those must still honor an all-service block.
function globalBlockedLinkRules() {
  const seen = new Map();
  for (const service of services) {
    for (const rule of (Array.isArray(service?.blockedLinks) ? service.blockedLinks : [])) {
      if (!rule || rule.serviceId || !rule.pattern) continue;
      seen.set(`${rule.matchType}|${rule.pattern}`, rule);
    }
  }
  return [...seen.values()];
}

// Deterrent hardening for a service/main webContents (the user still controls
// their machine): block DevTools shortcuts + force-close DevTools, block
// navigation to non-web schemes, and keep popups inside the same hardened
// pipeline (deny non-web popups, harden web popups). devTools is also disabled
// via webPreferences.
// Rounded corners for the embedded service view, matching the design's service card (border-radius
// 14px). Only WebContentsView (a View) supports setBorderRadius; on a BrowserView fallback this is a
// no-op. Best-effort: never let a missing/older API throw and block opening a service.
const SERVICE_VIEW_BORDER_RADIUS = 14;
function applyServiceViewRadius(view) {
  if (!view || typeof view.setBorderRadius !== "function") return;
  try {
    view.setBorderRadius(SERVICE_VIEW_BORDER_RADIUS);
  } catch {
    // older Electron / unsupported — leave square rather than crash the open flow
  }
}

function hardenServiceWebContents(wc) {
  if (!wc) return;
  // DEV-ONLY: env CX_DEVTOOLS=1 (chạy-từ-source) → KHÔNG chặn phím DevTools + KHÔNG auto-close. Production = chặn như cũ.
  if (process.env.CX_DEVTOOLS !== "1") {
    wc.on("before-input-event", (event, input) => {
      const key = String(input.key || "").toLowerCase();
      const isDevtoolsCombo = key === "f12" ||
        ((input.control || input.meta) && input.shift && (key === "i" || key === "j" || key === "c"));
      if (isDevtoolsCombo) event.preventDefault();
    });
    wc.on("devtools-opened", () => {
      try { wc.closeDevTools(); } catch { /* ignore */ }
    });
  }
  wc.on("will-navigate", (event, url) => {
    if (!isAllowedNavScheme(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavScheme(url)) return { action: "deny" };
    // Allow web popups (needed for OAuth login flows) but force them through the
    // same hardened, devTools-off, sandboxed webPreferences.
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false }
      }
    };
  });
}

function defaultPolicyModel(service) {
  const policyDefault = String(service?.modelPolicy?.defaultModel || "").trim();
  if (policyDefault) return policyDefault;
  const serviceDefault = String(service?.defaultModel || "").trim();
  if (serviceDefault) return serviceDefault;
  const prices = Array.isArray(service?.modelPrices) ? service.modelPrices : [];
  const enabledPrices = prices.filter((price) => price?.enabled !== false && price?.modelId);
  const priceDefault = enabledPrices.find((price) => price.isDefault === true) || enabledPrices[0] || null;
  return String(priceDefault?.modelId || "").trim();
}

function modelPolicyEnabled(service) {
  return service?.modelPricingEnabled === true ||
    service?.modelPolicy?.enabled === true ||
    (Array.isArray(service?.modelPrices) && service.modelPrices.length > 0);
}

// ---------------------------------------------------------------------------
// Per-service model resolution — fixes the "wrong captured model name" for every service except
// chatgpt/claude. Only those two have a VERIFIED clean top-level `model` field in their submit body, so
// only they may trust the greedy findModelInValue deep-search. For any other service that deep-search
// grabs a STRAY/unrelated 'model'-ish field (or a version-stamped id from an auxiliary POST) → a wrong
// name AND a wrong price row in the usage/price table. Until each service's real submit field is
// confirmed via live capture (CENTRIX_GATE_CAPTURE=1) we pin the service's clean default model instead
// of trusting a stray value. Grok is special-cased: its real field is `modelName` (outside the shared
// whitelist regex), so we read it explicitly here rather than widening the global whitelist — widening
// it would let OTHER services' stray camelCase fields leak in.
const MODEL_FIELD_VERIFIED_SERVICES = new Set(["chatgpt", "claude"]);

function parseBodyJson(details) {
  try { const p = JSON.parse(requestBodyText(details)); return (p && typeof p === "object") ? p : null; }
  catch { return null; }
}

// Poe routes EVERY operation through /api/gql_POST; the message submit is queryName==="sendMessageMutation"
// and the chosen bot/model is variables.bot (e.g. "Assistant","GPT-4o","Claude-3.5-Sonnet"). Confirmed by
// live capture 2026-07-05. Returns the parsed send-message body, or null for any other gql op.
function poeSendMessageBody(details) {
  const p = parseBodyJson(details);
  if (p && (p.queryName === "sendMessageMutation" || p.operationName === "sendMessageMutation")) return p;
  return null;
}

// Per-service model reader for services whose model lives in a NON-standard field (all confirmed via live
// capture 2026-07-05). Returns "" when this service carries no model in the request (caller uses default).
function serviceModelFromBody(serviceId, details) {
  if (serviceId === "perplexity") {
    // params.model_preference: Perplexity's internal model codes ("pplx_pro","gpt54","claude37",...).
    const p = parseBodyJson(details);
    const v = p && p.params && p.params.model_preference;
    return typeof v === "string" ? v.trim() : "";
  }
  if (serviceId === "poe") {
    const p = poeSendMessageBody(details);
    const v = p && p.variables && p.variables.bot;
    return typeof v === "string" ? v.trim() : "";
  }
  if (serviceId === "grok") {
    // Grok /rest/app-chat/conversations/new has NO model slug; the tier is `modeId` ("fast","expert",...).
    const p = parseBodyJson(details);
    const v = p && p.modeId;
    return typeof v === "string" ? v.trim() : "";
  }
  return "";
}

// The trusted base model id used for pricing/usage. Never returns a stray deep-searched value for an
// unverified service; returns "" only when there is genuinely nothing to charge (non-quota request).
function trustedBaseModelId(details, service, isQuotaRequest) {
  const serviceId = String(service?.id || "").toLowerCase();
  const fallback = isQuotaRequest ? defaultPolicyModel(service) : "";
  if (serviceId === "grok") {
    // No model slug in the body → clean default base + `modeId` tier suffix (e.g. "grok-4_fast"); an
    // unpriced tier resolves to the base server-side, a priced one is charged per-mode.
    const mode = sanitizeEffort(serviceModelFromBody("grok", details));
    return (fallback && mode) ? `${fallback}_${mode}` : fallback;
  }
  if (serviceId === "perplexity" || serviceId === "poe") {
    // Real user-selected model lives in a confirmed non-standard field (params.model_preference / variables.bot).
    return serviceModelFromBody(serviceId, details) || fallback;
  }
  if (MODEL_FIELD_VERIFIED_SERVICES.has(serviceId)) {
    return modelFromRequest(details) || fallback;
  }
  // No clean field confirmed (gemini/mistral f.req or no model in body; deepseek likely WebSocket;
  // copilot/midjourney/elevenlabs) → pin the clean default so no stray name/price reaches the table.
  return fallback;
}

function modelBlockedMessage(result, service, modelId) {
  const name = service?.name || service?.id || "dich vu";
  if (result?.reason === "account-locked") {
    return `${name}: tai khoan da bi khoa — lien he quan tri vien.`;
  }
  if (result?.reason === "insufficient-credit") {
    return `${name}: khong du credit de dung model ${modelId || result.modelId || "unknown"}. Con ${result?.balance ?? 0} credit.`;
  }
  if (result?.reason === "safety-daily-cap-reached" || result?.reason === "daily-limit-reached") {
    return `${name}: model ${modelId || result.modelId || "unknown"} da cham safety cap trong ngay.`;
  }
  if (result?.reason === "model-price-disabled") {
    return `${name}: model ${modelId || result.modelId || "unknown"} dang bi tat trong bang gia.`;
  }
  if (result?.reason === "model-not-allowed") {
    return `${name}: model ${modelId || result.modelId || "unknown"} khong duoc phep cho user nay.`;
  }
  if (result?.reason === "unknown-model-blocked") {
    return `${name}: request bi chan vi khong doc duoc model.`;
  }
  if (result?.reason === "gate-unreachable") {
    return `${name}: tam thoi khong xac minh duoc model voi server, da chan de an toan. Thu lai sau.`;
  }
  return `${name}: request model bi chan theo policy.`;
}

function encodeScriptValue(value) {
  return JSON.stringify(value).replace(/<\/script/gi, "<\\/script");
}

function escapeHtmlForInjectedPage(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serviceViewportChromeCss() {
  return `
    #centrix-webview-chat-button {
      all: initial !important;
      box-sizing: border-box !important;
      position: fixed !important;
      right: 22px !important;
      bottom: 22px !important;
      width: 56px !important;
      height: 56px !important;
      border-radius: 999px !important;
      border: 1px solid rgba(255,255,255,.38) !important;
      background: linear-gradient(180deg,#2ea7ff,#0b7bdd) !important;
      color: #fff !important;
      z-index: 2147483647 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-shadow: 0 16px 36px rgba(30,147,245,.34) !important;
      cursor: pointer !important;
      font: 700 13px/1 "Segoe UI", system-ui, sans-serif !important;
    }
    #centrix-webview-chat-button:hover {
      transform: translateY(-1px) !important;
      background: linear-gradient(180deg,#5ac8ff,#0b7bdd) !important;
    }
    #centrix-webview-chat-panel {
      all: initial !important;
      box-sizing: border-box !important;
      position: fixed !important;
      right: 22px !important;
      bottom: 88px !important;
      width: min(360px, calc(100vw - 44px)) !important;
      height: min(548px, calc(100vh - 122px)) !important;
      min-height: 420px !important;
      border-radius: 14px !important;
      border: 1px solid rgba(30,147,245,.22) !important;
      background: #f3f7fc !important;
      color: #0f172a !important;
      z-index: 2147483647 !important;
      display: none !important;
      box-shadow: 0 24px 56px rgba(15,23,42,.24) !important;
      overflow: hidden !important;
      font: 13px/1.4 "Segoe UI", system-ui, sans-serif !important;
    }
    #centrix-webview-chat-panel[data-open="1"] {
      display: block !important;
    }
    #centrix-webview-chat-panel * {
      box-sizing: border-box !important;
      font-family: "Segoe UI", system-ui, sans-serif !important;
    }
    #centrix-webview-chat-panel button,
    #centrix-webview-chat-panel input {
      pointer-events: auto !important;
    }
    #centrix-webview-chat-panel [data-centrix-chat-mode][data-active="1"] {
      background: #fff !important;
      color: #0f82df !important;
    }
    #centrix-webview-chat-panel [data-centrix-chat-mode][data-active="0"] {
      background: rgba(255,255,255,.18) !important;
      color: #eaf6ff !important;
    }
    #centrix-webview-chat-panel [data-centrix-chat-send]:hover {
      background: #0b7bdd !important;
    }
  `;
}

function serviceViewportChromeScript(service) {
  const serviceName = encodeScriptValue(String(service?.name || "dich vu"));
  return `
    (() => {
      const serviceName = ${serviceName};
      const clean = (value) => String(value || "").replace(/[&<>"']/g, "");
      const upsert = (id, tagName) => {
        let node = document.getElementById(id);
        if (!node) {
          node = document.createElement(tagName);
          node.id = id;
          document.documentElement.appendChild(node);
        }
        return node;
      };

      document.getElementById("centrix-webview-corner-left")?.remove();
      document.getElementById("centrix-webview-corner-right")?.remove();

      const panel = upsert("centrix-webview-chat-panel", "div");
      panel.innerHTML = [
        '<div style="height:108px;background:linear-gradient(180deg,#1f9bfa,#0f82df);padding:15px 16px 14px;color:#fff;">',
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">',
        '<div style="display:flex;align-items:center;gap:11px;min-width:0;">',
        '<div style="width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M21 12a8 8 0 0 1-8 8H7l-4 2 1.2-4.2A8 8 0 1 1 21 12Z"/></svg></div>',
        '<div style="min-width:0;"><div style="font-size:15px;font-weight:800;letter-spacing:0;">Hỗ trợ CentriX AI</div>',
        '<div style="font-size:11px;opacity:.88;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Trong ' + clean(serviceName) + ' · phản hồi trong vài phút</div></div>',
        '</div>',
        '<button type="button" data-centrix-chat-close style="width:30px;height:30px;border:0;border-radius:9px;background:transparent;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:24px;line-height:1;">×</button>',
        '</div>',
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">',
        '<button type="button" style="height:30px;border:0;border-radius:7px;background:#fff;color:#0f82df;font-weight:800;font-size:12px;cursor:pointer;">Trợ lý AI</button>',
        '<button type="button" style="height:30px;border:0;border-radius:7px;background:rgba(255,255,255,.18);color:#eaf6ff;font-weight:800;font-size:12px;cursor:pointer;">Nhân viên CSKH</button>',
        '</div>',
        '</div>',
        '<div style="height:calc(100% - 108px);display:flex;flex-direction:column;">',
        '<div style="flex:1;min-height:0;padding:16px 16px 12px;overflow:auto;background:#f3f7fc;">',
        '<div style="max-width:270px;background:#fff;border:1px solid #dbe4ef;border-radius:12px;padding:11px 13px;color:#0f172a;font-size:13px;line-height:1.45;box-shadow:0 4px 14px rgba(15,23,42,.04);">Xin chào! Mình là trợ lý AI của CentriX.<br>Mình giúp gì cho bạn về credit, gói cước hay cách dùng dịch vụ?</div>',
        '</div>',
        '<div style="padding:12px;background:#f3f7fc;border-top:1px solid #d9e3ef;display:flex;gap:8px;">',
        '<input aria-label="Nhập tin nhắn" placeholder="Nhập tin nhắn..." style="flex:1;min-width:0;height:38px;border:1px solid #cbd8e8;border-radius:10px;padding:0 12px;color:#0f172a;background:#fff;outline:none;font-size:13px;">',
        '<button type="button" aria-label="Gửi" style="width:42px;height:38px;border:0;border-radius:11px;background:#1e93f5;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 18px rgba(30,147,245,.24);"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></button>',
        '</div>',
        '</div>'
      ].join("");

      const chatButtons = Array.from(panel.querySelectorAll("button"));
      const closeButton = panel.querySelector("[data-centrix-chat-close]");
      const tabButtons = chatButtons.filter((item) => item !== closeButton).slice(0, 2);
      const sendButton = chatButtons.filter((item) => item !== closeButton).slice(-1)[0];
      const input = panel.querySelector("input");
      const log = Array.from(panel.querySelectorAll("div")).find((item) => {
        const style = item.getAttribute("style") || "";
        return style.includes("overflow:auto") && style.includes("flex:1");
      });
      const welcome = log?.firstElementChild || null;
      const replies = {
        ai: "Mình đã nhận tin nhắn. Bạn mô tả thêm vấn đề hoặc mã giao dịch để mình kiểm tra nhanh hơn nhé.",
        cskh: "Mình đã chuyển yêu cầu sang nhân viên CSKH. Bạn để lại nội dung cần hỗ trợ, đội ngũ sẽ phản hồi trong vài phút."
      };
      const welcomes = {
        ai: "Xin chào! Mình là trợ lý AI của CentriX.<br>Mình giúp gì cho bạn về credit, gói cước hay cách dùng dịch vụ?",
        cskh: "Bạn đang ở kênh Nhân viên CSKH.<br>Gửi nội dung cần hỗ trợ, CentriX sẽ tiếp nhận và phản hồi sớm."
      };
      let activeMode = panel.dataset.centrixChatMode || "ai";
      const setMode = (mode) => {
        activeMode = mode === "cskh" ? "cskh" : "ai";
        panel.dataset.centrixChatMode = activeMode;
        tabButtons.forEach((tab, index) => {
          const isActive = (index === 0 && activeMode === "ai") || (index === 1 && activeMode === "cskh");
          tab.dataset.active = isActive ? "1" : "0";
          tab.style.background = isActive ? "#fff" : "rgba(255,255,255,.18)";
          tab.style.color = isActive ? "#0f82df" : "#eaf6ff";
        });
        if (welcome) welcome.innerHTML = welcomes[activeMode];
      };
      const appendMessage = (role, text) => {
        if (!log || !text) return;
        const row = document.createElement("div");
        const isUser = role === "user";
        row.style.cssText = [
          "display:flex",
          "justify-content:" + (isUser ? "flex-end" : "flex-start"),
          "margin-top:10px"
        ].join(";");
        const bubble = document.createElement("div");
        bubble.textContent = text;
        bubble.style.cssText = [
          "max-width:270px",
          "border-radius:12px",
          "padding:10px 12px",
          "font:13px/1.45 Segoe UI,system-ui,sans-serif",
          "box-shadow:0 4px 14px rgba(15,23,42,.04)",
          isUser ? "background:#1e93f5" : "background:#fff",
          isUser ? "border:0" : "border:1px solid #dbe4ef",
          isUser ? "color:#fff" : "color:#0f172a"
        ].join(";");
        row.appendChild(bubble);
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      };
      const sendMessage = () => {
        const text = String(input?.value || "").trim();
        if (!text) return;
        appendMessage("user", text);
        input.value = "";
        window.setTimeout(() => appendMessage("bot", replies[activeMode]), 100);
      };
      if (closeButton) closeButton.textContent = "×";
      if (tabButtons[0]) tabButtons[0].textContent = "Trợ lý AI";
      if (tabButtons[1]) tabButtons[1].textContent = "Nhân viên CSKH";
      if (input) {
        input.setAttribute("aria-label", "Nhập tin nhắn");
        input.placeholder = "Nhập tin nhắn...";
        input.onkeydown = (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            sendMessage();
          }
        };
      }
      tabButtons.forEach((tab, index) => {
        tab.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          setMode(index === 0 ? "ai" : "cskh");
        };
      });
      if (sendButton) {
        sendButton.setAttribute("aria-label", "Gửi");
        sendButton.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          sendMessage();
        };
      }
      setMode(activeMode);

      const button = upsert("centrix-webview-chat-button", "button");
      button.type = "button";
      button.title = "CentriX Chat";
      button.setAttribute("aria-label", "CentriX Chat");
      button.innerHTML = '<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.8 8.4 9.8 9.8 0 0 1-4-.8L3 20l1.1-4.5a8.1 8.1 0 0 1-.9-3.8 8.4 8.4 0 0 1 8.8-8.4 8.4 8.4 0 0 1 9 8.2Z"/></svg>';
      const setOpen = (open) => {
        panel.dataset.open = open ? "1" : "0";
        button.innerHTML = open
          ? '<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
          : '<svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.8 8.4 9.8 9.8 0 0 1-4-.8L3 20l1.1-4.5a8.1 8.1 0 0 1-.9-3.8 8.4 8.4 0 0 1 8.8-8.4 8.4 8.4 0 0 1 9 8.2Z"/></svg>';
      };
      button.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setOpen(panel.dataset.open !== "1");
      };
      panel.querySelector("[data-centrix-chat-close]")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      });
    })()
  `;
}

function clampBrowserNumber(value, min, max) {
  const clean = Math.round(Number(value));
  const fallback = Math.round(Number(min) || 0);
  const floor = Math.round(Number(min) || 0);
  const ceiling = Math.max(floor, Math.round(Number(max) || floor));
  if (!Number.isFinite(clean)) return fallback;
  return Math.min(ceiling, Math.max(floor, clean));
}

class LocalBrowserManager {
  constructor(window) {
    this.window = window;
    this.tabs = new Map();
    this.activeTab = null;
    this.profileId = DEFAULT_PROFILE;
    this.bounds = { x: 302, y: 14, width: 1100, height: 880 };
    this.boundsApplyTimer = null;
    this.modelGateSessions = new Set();
    this.modelUsageDedup = new Map();
    this.pendingCharges = new Map(); // request.id -> staged charge, settled only on a successful (2xx) response
    this.localStorePreloadedKeys = new Set();
    this.localStorePreloadPromise = null;
    this.openRequestSerial = 0;

    this.window.on("resize", () => this.scheduleApplyBounds());
    this.window.on("enter-full-screen", () => this.scheduleApplyBounds());
    this.window.on("leave-full-screen", () => this.scheduleApplyBounds());
  }

  setProfile(profileId) {
    const nextProfileId = sanitizeProfileId(profileId || DEFAULT_PROFILE);
    if (nextProfileId === this.profileId) return;
    const previousProfileId = this.profileId;
    this.closeAll();
    this.profileId = nextProfileId;
    this.localStorePreloadedKeys.clear();
    this.localStorePreloadPromise = null;
    // Defense-in-depth: wipe the switched-away (RAM-only) partition so its borrowed cookies don't
    // linger in memory for the app's lifetime. Best-effort; nothing is on disk to wipe.
    if (previousProfileId && previousProfileId !== nextProfileId) {
      userBrowserSession(previousProfileId).clearStorageData().catch(() => {});
    }
  }

  // Renderer bounds arrive in CSS pixels; view.setBounds() wants window DIP. They only differ when the
  // page is zoomed (DIP = CSS px × zoomFactor) — unconverted, a zoomed renderer pins the native view to
  // the wrong rect (shrunk top-left / overflowing the card). Convert ONCE here, at the IPC boundary:
  // everything stored in this.bounds afterwards is DIP, and internal re-applies must NOT re-scale.
  rendererToDip(bounds) {
    if (!bounds || typeof bounds !== "object") return bounds;
    let zoom = 1;
    try { zoom = Number(this.window?.webContents?.getZoomFactor?.()) || 1; } catch {}
    if (Math.abs(zoom - 1) < 0.001) return bounds;
    return {
      x: Number(bounds.x) * zoom,
      y: Number(bounds.y) * zoom,
      width: Number(bounds.width) * zoom,
      height: Number(bounds.height) * zoom
    };
  }

  setBounds(bounds) {
    this.bounds = this.normalizeBounds(this.rendererToDip(bounds));
    this.applyBounds();
    return this.bounds;
  }

  setTabBounds(tab, bounds = this.bounds) {
    if (!tab?.view?.setBounds) return null;
    const normalized = this.normalizeBounds(bounds);
    this.bounds = normalized;
    tab.view.setBounds(normalized);
    return normalized;
  }

  scheduleApplyBounds() {
    if (this.boundsApplyTimer) return;
    this.boundsApplyTimer = setTimeout(() => {
      this.boundsApplyTimer = null;
      this.applyBounds();
    }, 0);
  }

  normalizeBounds(bounds = {}) {
    const win = this.window;
    const contentBounds = win?.getContentBounds?.() || win?.getBounds?.() || {};
    const rawW = Math.round(Number(contentBounds.width) || 0);
    const rawH = Math.round(Number(contentBounds.height) || 0);
    // DEGENERATE-CONTENT GUARD: while the window is minimized / occluded / mid-restore (alt-tab away then
    // back), getContentBounds() briefly reports a tiny/zero size. Clamping to it collapses the service view
    // into the top-left corner at MIN size — and because setBounds() STORES the result into this.bounds,
    // that corner rect becomes permanent (the renderer dedups on sameBounds so it never re-sends a fix).
    // So: if the content size looks degenerate, keep the last good bounds untouched; a later resize/focus
    // with a real size re-applies correctly (reapplyBoundsBurst on window focus drives that).
    const minimized = !!(win && typeof win.isMinimized === "function" && win.isMinimized());
    const notVisible = !!(win && typeof win.isVisible === "function" && !win.isVisible());
    if ((minimized || notVisible || rawW < MIN_BROWSER_WIDTH || rawH < MIN_BROWSER_HEIGHT)
        && this.bounds && Number(this.bounds.width) >= MIN_BROWSER_WIDTH && Number(this.bounds.height) >= MIN_BROWSER_HEIGHT) {
      return this.bounds;
    }
    const contentWidth = Math.max(MIN_BROWSER_WIDTH, rawW || MIN_BROWSER_WIDTH);
    const contentHeight = Math.max(MIN_BROWSER_HEIGHT, rawH || MIN_BROWSER_HEIGHT);
    const x = clampBrowserNumber(bounds?.x, 0, Math.max(0, contentWidth - MIN_BROWSER_WIDTH));
    const y = clampBrowserNumber(bounds?.y, 0, Math.max(0, contentHeight - MIN_BROWSER_HEIGHT));
    const maxWidth = Math.max(MIN_BROWSER_WIDTH, contentWidth - x);
    const maxHeight = Math.max(MIN_BROWSER_HEIGHT, contentHeight - y);

    return {
      x,
      y,
      width: clampBrowserNumber(bounds?.width, MIN_BROWSER_WIDTH, maxWidth),
      height: clampBrowserNumber(bounds?.height, MIN_BROWSER_HEIGHT, maxHeight)
    };
  }

  async openService(service, bounds, options = {}) {
    if (versionLocked) return { ok: false, error: "version-locked", locked: true }; // no service opens while locked
    if (accountLocked) return { ok: false, error: "account-locked", locked: true }; // frozen while the account is locked
    if (!service?.url) throw new Error("Service URL is missing");
    const requestSerial = ++this.openRequestSerial;
    const isLatestRequest = () => requestSerial === this.openRequestSerial;
    const emitPrepareIfLatest = (activeService, status, message) => {
      if (isLatestRequest()) this.emitPrepare(activeService, status, message);
    };
    if (bounds) this.setBounds(bounds);
    const serviceUrl = normalizeUrl(service.url);
    const requestedUrl = normalizeUrl(options.url || options.targetUrl || "");
    const targetUrl = requestedUrl && originOf(requestedUrl) === originOf(serviceUrl)
      ? requestedUrl
      : serviceUrl;

    const activeService = {
      id: String(service.id || "service"),
      name: String(service.name || "Service"),
      url: targetUrl,
      iconUrl: String(service.iconUrl || ""),
      modelPricingEnabled: service.modelPricingEnabled === true,
      defaultModel: String(service.defaultModel || ""),
      defaultCreditCost: Number(service.defaultCreditCost || 1),
      uiRules: Array.isArray(service.uiRules) ? service.uiRules : [],
      uiCacheItems: normalizeUiCacheItems(service.uiCacheItems || []),
      modelPolicy: service.modelPolicy || null,
      modelPrices: Array.isArray(service.modelPrices) ? service.modelPrices : [],
      blockedLinks: Array.isArray(service.blockedLinks) ? service.blockedLinks : []
    };

    writeUserRuntimeLog("service-open-start", {
      serviceId: activeService.id,
      serviceName: activeService.name,
      targetUrl: activeService.url,
      profileId: this.profileId,
      requestSerial
    });

    emitPrepareIfLatest(activeService, "profile", "Dang chuan bi profile dang nhap...");
    // Best-effort: prep needs the CentriX server connection, but the embedded service loads from its
    // own profile cookies and MUST open even when the connection is missing (session expired).
    await waitForStorageSyncForSmoothOpen(SMOOTH_OPEN_STORAGE_WAIT_MS).catch(() => null);
    if (!isLatestRequest()) return this.state();
    activeService.uiCacheItems = await this.loadUserUiCache(activeService).catch(() => activeService.uiCacheItems);
    if (!isLatestRequest()) return this.state();

    // RULES-WITH-PROFILE (pool): on a COLD open the tab does not exist yet, so pull this service's
    // assigned pool profile NOW — the export snapshot carries the service's hide/replace rules, and the
    // preload additionalArguments are frozen at webContents creation. Pulling first means the very first
    // render already has the profile-delivered rules baked in (profile "passes through" the rules
    // before it reaches the user). An existing tab keeps the old safe-boundary pull below.
    let poolProfilePulled = false;
    let poolPullFailed = false;
    const existingTab = this.tabs.get(`${this.profileId}:${activeService.id}`);
    // Only pull with a LIVE connection — a pull while disconnected always throws "Server connection is not
    // configured" and would spuriously flag a failure. includeStorage:true so localStorage-based logins (SPA
    // auth tokens) arrive too, not just cookies (the manager seeds storage; the 60s pull timeout covers it).
    if (profilePoolMode && connection && (!existingTab || existingTab.webContents.isDestroyed())) {
      emitPrepareIfLatest(activeService, "profile", "Dang nhan profile dang nhap (pool)...");
      // Any staged whole-account snapshot must land BEFORE the pool pull — pool cookies imported last
      // always win (same order the reload branch used before this cold-open path existed).
      await applyStagedProfileIfAny(this.profileId).catch(() => {});
      await pullServiceProfileFromServer(activeService.id, { includeStorage: true })
        .then(() => { poolProfilePulled = true; markPoolDomainOwner(activeService); })
        .catch((e) => { poolPullFailed = true; writeUserRuntimeLog("service-pool-pull-fail", { serviceId: activeService.id, error: e?.message || String(e) }); });
      if (!isLatestRequest()) return this.state();
    }

    const tab = this.getOrCreateTab(activeService);
    this.setTabBounds(tab, this.bounds);
    tab.errorPageVisible = false;

    // Manual blocked link — the INITIAL open (deep-link/history URL) is a programmatic loadURL, which fires
    // NO will-navigate, so it must be checked here or a blocked target loads cleanly on open. The block page's
    // "Tải lại dịch vụ" button reloads the service BASE url, so a blocked deep-link still lets the user in.
    {
      const blockRule = matchesBlockedLink(activeService.url, activeService);
      if (blockRule) {
        this.handleBlockedNav(tab, activeService.url, blockRule, { replacePage: true });
        return this.state();
      }
    }

    const currentUrl = tab.webContents.getURL();
    // An explicit history URL (e.g. chatgpt.com/c/<id>) on an already-loaded SAME-origin tab must
    // still navigate to it (shouldNavigateToService only triggers on origin change).
    const explicitUrlRequested = targetUrl !== serviceUrl;
    const alreadyAtTarget = normalizeUrl(currentUrl) === targetUrl;
    // WARM re-pull: an already-loaded tab normally skips the pull entirely — but if the manager re-seeded (or
    // the pool slot was reassigned) since our last pull, force the reload branch so the fresh login is pulled
    // + applied instead of the tab keeping a stale/dead session. Skipped when a pull already ran this open.
    let needsPoolRefresh = false;
    if (profilePoolMode && connection && tab.loaded && !poolProfilePulled && !poolPullFailed) {
      // A same-domain sibling (e.g. GPT-5.5 Pro over ChatGPT) may have overwritten this service's cookies in the
      // shared partition since our last pull — detect that LOCALLY (no network) and force a re-pull. Otherwise
      // fall back to the revision probe (manager re-seed / pool slot reassign). OR-only: never suppresses a pull.
      needsPoolRefresh = poolDomainClobbered(activeService) || await poolProfileNeedsRefresh(activeService.id).catch(() => false);
      if (!isLatestRequest()) return this.state();
    }
    if (!tab.loaded || shouldNavigateToService(currentUrl, activeService.url) || (explicitUrlRequested && !alreadyAtTarget) || needsPoolRefresh) {
      try {
        tab.lastError = "";
        tab.preparing = true;
        tab.errorPageVisible = false;
        tab.blankRecoveryAttempts = 0;
        // Safe boundary: this tab is (re)loading, so NOW is when we may swap in a pre-fetched newer
        // profile (admin re-login / cross-device). A tab that just sits running is never touched.
        await applyStagedProfileIfAny(this.profileId).catch(() => {});
        // Pool-mode: bring in THIS service's assigned pool login (cookies+storage) before navigating.
        // Best-effort — a failed pull still lets the tab open; on failure poolPullState stays empty so the
        // NEXT open re-pulls (poolProfileNeedsRefresh returns true for a never-pulled service). Live conn only.
        if (profilePoolMode && connection && !poolProfilePulled) {
          emitPrepareIfLatest(activeService, "profile", "Dang nhan profile dang nhap (pool)...");
          await pullServiceProfileFromServer(activeService.id, { includeStorage: true })
            .then(() => { poolProfilePulled = true; markPoolDomainOwner(activeService); })
            .catch((e) => { poolPullFailed = true; writeUserRuntimeLog("service-pool-pull-fail", { serviceId: activeService.id, error: e?.message || String(e) }); });
          if (!isLatestRequest()) return this.state();
        }
        emitPrepareIfLatest(activeService, "local-store", "Dang nap du lieu local an trong nen...");
        await this.preloadUserLocalStore(tab, LOCAL_STORE_PRELOAD_TIMEOUT_MS).catch(() => null);
        if (!isLatestRequest()) return this.state();
        emitPrepareIfLatest(activeService, "loading", `Dang tai ${activeService.name} trong nen...`);
        const loadResult = await loadWebContentsUntilStopped(tab.webContents, activeService.url, SERVICE_LOAD_TIMEOUT_MS);
        if (!isLatestRequest()) return this.state();
        emitPrepareIfLatest(activeService, "dom-stable", "Dang doi giao dien dich vu on dinh...");
        tab.lastDomReady = await waitForWebContentsDomStable(tab.webContents, SERVICE_DOM_STABLE_TIMEOUT_MS);
        if (!isLatestRequest()) return this.state();
        if (tab.lastDomReady?.ok !== true) {
          const currentLoadedUrl = tab.webContents.getURL() || activeService.url;
          const snapshot = tab.lastDomReady?.snapshot || {};
          const isConfirmedBlankSnapshot = snapshot?.ok === true &&
            snapshot.readyState === "complete" &&
            Number(snapshot.textLength || 0) === 0 &&
            Number(snapshot.elementCount || 0) <= 1 &&
            Number(snapshot.htmlLength || 0) <= 120;
          const shouldBlockWhiteTab = loadResult?.ok === false ||
            !currentLoadedUrl ||
            currentLoadedUrl === "about:blank" ||
            isConfirmedBlankSnapshot;
          writeUserRuntimeLog(shouldBlockWhiteTab ? "service-open-blank-before-show" : "service-open-dom-not-stable", {
            serviceId: activeService.id,
            serviceName: activeService.name,
            url: currentLoadedUrl,
            loadResult,
            domReady: tab.lastDomReady,
            snapshot
          });
          this.recordTabActivity(tab, shouldBlockWhiteTab ? "blank-before-show" : "dom-not-stable-before-show", {
            url: currentLoadedUrl,
            loadOk: loadResult?.ok === true,
            domReady: tab.lastDomReady,
            snapshot
          }, 0);
          if (shouldBlockWhiteTab) {
            const errorMessage = `${activeService.name} tai qua lau va giao dien van trong. Hay thu lai.`;
            tab.loaded = false;
            tab.lastError = errorMessage;
            throw new Error(errorMessage);
          }
        }
        await withTimeout(this.applyUiRules(tab), 1500, null);
        if (!isLatestRequest()) return this.state();
        emitPrepareIfLatest(activeService, "settling", "Dang on dinh giao dien truoc khi hien thi...");
        await delay(SERVICE_READY_SETTLE_MS);
        tab.loaded = true;
        writeUserRuntimeLog("service-open-ready", {
          serviceId: activeService.id,
          serviceName: activeService.name,
          url: tab.webContents.getURL(),
          loadResult,
          domReady: tab.lastDomReady
        });
      } catch (error) {
        if (isNavigationAbortError(error)) {
          // A superseded navigation is normal — but if the pool pull FAILED, don't claim the tab is loaded:
          // leaving it not-loaded makes the next open re-enter this reload branch (and re-pull) instead of
          // reusing a logged-out tab forever.
          tab.loaded = !poolPullFailed;
          tab.lastError = "";
        } else {
          tab.loaded = false;
          tab.lastError = error.message || "Load failed";
          writeUserRuntimeLog("service-open-error", {
            serviceId: activeService.id,
            serviceName: activeService.name,
            url: tab.webContents.getURL() || activeService.url,
            error: tab.lastError
          });
          if (!isLatestRequest()) return this.state();
          throw error;
        }
      } finally {
        tab.preparing = false;
      }
    } else {
      emitPrepareIfLatest(activeService, "ready", `${activeService.name} da san sang.`);
    }

    if (!isLatestRequest()) return this.state();
    this.showTab(tab);
    this.applyBounds();
    tab.webContents.focus();
    this.applyUiRules(tab).catch(() => {});
    this.recordTabActivity(tab, "open-service", { requestedUrl: activeService.url }, 0);
    this.emit("browser:navigation", this.state());
    heartbeatClientTabs().catch(() => {});
    scheduleProfilePush();
    return this.state();
  }

  getOrCreateTab(service) {
    const key = `${this.profileId}:${service.id}`;
    const existing = this.tabs.get(key);
    if (existing && !existing.webContents.isDestroyed()) {
      existing.service = service;
      return existing;
    }

    const targetSession = userBrowserSession(this.profileId);
    this.configureModelGate(targetSession);
    const tab = this.createTab(targetSession, service);
    this.tabs.set(key, tab);
    this.attachEvents(tab);
    return tab;
  }

  createTab(targetSession, service) {
    const tab = {
      service,
      view: null,
      viewType: "",
      webContents: null,
      attached: false,
      loaded: false,
      lastError: "",
      blankRecoveryTimer: null,
      blankRecoveryAttempts: 0,
      storageReloaded: false,
      preparing: false,
      errorPageVisible: false,
      localStoreReloadedOrigins: new Set(),
      lastActivitySignature: "",
      lastActivityAt: 0,
      lastUiCacheSyncAt: 0,
      uiCacheTimers: []
    };

    const webPreferences = {
      session: targetSession,
      preload: USER_BROWSER_PRELOAD,
      additionalArguments: [
        uiHideArgumentForService(service),
        uiReplaceArgumentForService(service),
        uiUserScriptArgumentForService(service)
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false, // off in the chat box: Chromium's spellcheck/autocorrect can fight a Vietnamese IME
      devTools: false
    };

    // Prefer WebContentsView: it extends View, so setBorderRadius() can round the embedded page to
    // match the design's rounded service card. BrowserView (deprecated, no rounding) is only a fallback
    // for runtimes that lack WebContentsView.
    if (WebContentsView) {
      tab.view = new WebContentsView({ webPreferences });
      tab.viewType = "WebContentsView";
      tab.webContents = tab.view.webContents;
      applyServiceViewRadius(tab.view);
      hardenServiceWebContents(tab.webContents);
      return tab;
    }

    tab.view = new BrowserView({ webPreferences });
    tab.viewType = "BrowserView";
    tab.webContents = tab.view.webContents;
    hardenServiceWebContents(tab.webContents);
    return tab;
  }

  configureModelGate(targetSession) {
    const key = `${this.profileId}:${targetSession.partition || "default"}`;
    if (this.modelGateSessions.has(key)) return;
    this.modelGateSessions.add(key);

    targetSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      this.handleModelPolicyRequest(details)
        .then((result) => callback({ cancel: result.cancel === true }))
        .catch(() => callback({ cancel: false }));
    });

    // Charge ONLY when the service actually answered. onBeforeRequest stages a pending charge (no debit);
    // here we settle it: a successful response (2xx) debits the credit, anything else (HTTP error, or a
    // request that never got a response) does NOT — so a failed/unanswered chat never costs the customer.
    targetSession.webRequest.onResponseStarted({ urls: ["<all_urls>"] }, (details) => {
      if (this.pendingCharges.has(details.id)) this.settlePendingCharge(details).catch(() => {});
    });
    targetSession.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => {
      this.discardPendingCharge(details.id); // network failure / aborted -> no charge
    });

    // Let the user SAVE files from a chat (attachments, generated files, images, exports). The old code
    // blocked ALL downloads "so cookies can't be saved" — but cookies/the profile live in the partition's
    // cookie store and are NEVER exposed as a DownloadItem, so allowing downloads cannot leak them; the block
    // only broke a legitimate feature. Files go to the OS Downloads folder (browser-like) under a
    // non-clobbering name. Completion is confirmed with a native OS notification (the service view overlays
    // the DOM, so an in-app toast may be hidden), and browser:download is emitted for the in-app UI.
    targetSession.on("will-download", (event, item, srcWebContents) => {
      // Attribute to the tab that started the download (this handler is per-SESSION → could be a background tab).
      const srcTab = srcWebContents ? [...this.tabs.values()].find((t) => t.webContents === srcWebContents) : null;
      const serviceId = srcTab?.service?.id || this.activeTab?.service?.id || "";
      let safe = "download";
      try {
        safe = (String(item.getFilename() || "download")
          .replace(/[\/\\]/g, "_")                // no path separators (traversal)
          .replace(/[<>:"|?*\x00-\x1f]/g, "_")    // no Windows-illegal / control chars (kills ADS "f:evil", drive-abs)
          .replace(/^\.+/, "")                    // no leading dots (dotfile / traversal remnant)
          .replace(/[. ]+$/, "")                  // Windows strips trailing dots/spaces → normalize so the collision check matches disk
          .trim()
          .slice(0, 180)) || "download";
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(safe)) safe = "_" + safe; // reserved device name → a file, not the device

        // Drive-by guard: cap how many auto-saves happen per window across the user's tabs.
        const now = Date.now();
        this._downloadTimes = (this._downloadTimes || []).filter((t) => now - t < DOWNLOAD_RATE_WINDOW_MS);
        if (this._downloadTimes.length >= DOWNLOAD_RATE_MAX) {
          event.preventDefault();
          writeUserRuntimeLog("download-rate-limited", { serviceId, filename: safe, recent: this._downloadTimes.length });
          this.emit("browser:download", { state: "fail", filename: safe, reason: "rate-limited" });
          return;
        }
        this._downloadTimes.push(now);

        const dir = app.getPath("downloads");
        const ext = path.extname(safe);
        const base = path.basename(safe, ext);
        let savePath = path.join(dir, safe);
        for (let i = 1; fs.existsSync(savePath) && i < 10000; i++) savePath = path.join(dir, `${base} (${i})${ext}`);
        item.setSavePath(savePath); // full path set → skips the native Save-As dialog (auto-save like a browser)
        this.emit("browser:download", { state: "start", filename: safe, savePath, total: item.getTotalBytes() });
        writeUserRuntimeLog("download-start", { serviceId, filename: safe, total: item.getTotalBytes() });
        let lastEmit = 0;
        item.on("updated", (_e, s) => {
          try {
            // Size cap: a file over the per-file limit (declared OR streamed) is cancelled → no disk-fill.
            if (item.getTotalBytes() > DOWNLOAD_MAX_BYTES || item.getReceivedBytes() > DOWNLOAD_MAX_BYTES) {
              try { item.cancel(); } catch { /* already finished */ }
              writeUserRuntimeLog("download-too-large", { serviceId, filename: safe, total: item.getTotalBytes() });
              return;
            }
            if (s !== "progressing") return;
            const now2 = Date.now();
            if (now2 - lastEmit < 200) return; // throttle progress emits (~5/sec)
            lastEmit = now2;
            this.emit("browser:download", { state: "progress", filename: safe, received: item.getReceivedBytes(), total: item.getTotalBytes() });
          } catch { /* window/item gone mid-download */ }
        });
        item.once("done", (_e, s) => {
          try {
            const ok = s === "completed";
            this.emit("browser:download", { state: ok ? "done" : "fail", filename: safe, savePath: ok ? savePath : "", reason: ok ? "" : String(s || "") });
            writeUserRuntimeLog(ok ? "download-done" : "download-fail", { serviceId, filename: safe, state: String(s || "") });
            notifyDownloadNative(safe, ok ? savePath : "", ok);
          } catch { /* window gone at completion time */ }
        });
      } catch (err) {
        // Never silently drop: if our handling throws, DON'T preventDefault — let Electron's default Save-As
        // dialog take over so the user can still save the file.
        writeUserRuntimeLog("download-handler-error", { error: String((err && err.message) || err).slice(0, 200) });
        try { this.emit("browser:download", { state: "fail", filename: safe, reason: "handler-error" }); } catch { /* window gone */ }
      }
    });
  }

  serviceForRequestUrl(url) {
    const origin = originOf(url);
    return services.find((service) => modelPolicyEnabled(service) && originOf(service.url) === origin) || null;
  }

  notifyModelBlocked(service, result, modelId, url) {
    const message = modelBlockedMessage(result, service, modelId);
    for (const tab of this.tabs.values()) {
      if (tab.service?.id !== service?.id) continue;
      tab.lastError = message;
      if (this.activeTab === tab) {
        this.emit("browser:error", {
          errorCode: 403,
          errorDescription: message,
          url
        });
      }
    }
  }

  // Surface a blocked-link hit: toast the active tab + log. opts.replacePage also paints the full block page
  // (used when the tab is ALREADY on the blocked url — SPA route / watchdog — vs a prevented top-level nav).
  handleBlockedNav(tab, url, rule, opts = {}) {
    if (!tab) return;
    const message = blockedLinkMessage(rule, tab.service);
    tab.lastError = message;
    writeUserRuntimeLog("blocked-link", { serviceId: tab.service?.id || "", url: String(url || "").slice(0, 300), matchType: rule?.matchType || "" });
    if (this.activeTab === tab) this.emit("browser:error", { errorCode: 403, errorDescription: message, url });
    if (opts.replacePage) this.showServiceErrorPage(tab, message, { url, blockedLink: true }).catch(() => {});
  }

  // Throttled per-service toast for cancelled sub-resource requests (onBeforeRequest can fire many times).
  notifyLinkBlockedThrottled(service, url, rule) {
    const now = Date.now();
    if (!this._blockedToastAt) this._blockedToastAt = new Map();
    const last = this._blockedToastAt.get(service?.id) || 0;
    if (now - last < 4000) return;
    this._blockedToastAt.set(service?.id, now);
    const message = blockedLinkMessage(rule, service);
    for (const tab of this.tabs.values()) {
      if (tab.service?.id !== service?.id) continue;
      tab.lastError = message;
      if (this.activeTab === tab) this.emit("browser:error", { errorCode: 403, errorDescription: message, url });
    }
    writeUserRuntimeLog("blocked-link-subresource", { serviceId: service?.id || "", url: String(url || "").slice(0, 300), matchType: rule?.matchType || "" });
  }

  // Watchdog hook: re-check every open tab's CURRENT url against the freshest per-service blocklist and
  // hard-stop any tab already sitting on a now-blocked link (covers a block added AFTER the tab was opened).
  enforceBlockedLinksOnOpenTabs() {
    for (const tab of this.tabs.values()) {
      if (!tab || !tab.webContents || tab.webContents.isDestroyed()) continue;
      const fresh = services.find((item) => item.id === tab.service?.id);
      if (fresh && tab.service) tab.service.blockedLinks = Array.isArray(fresh.blockedLinks) ? fresh.blockedLinks : [];
      let current = "";
      try { current = tab.webContents.getURL(); } catch { current = ""; }
      const rule = matchesBlockedLink(current, tab.service);
      if (rule && !tab.errorPageVisible) this.handleBlockedNav(tab, current, rule, { replacePage: true });
    }
  }

  recordTabActivity(tab, action, details = {}, throttleMs = 3000) {
    if (!connection || !tab?.webContents || tab.webContents.isDestroyed()) return;
    const state = this.stateForTab(tab);
    const signature = `${action}|${state.serviceId}|${state.url}|${state.title}`;
    const now = Date.now();
    if (throttleMs > 0 && tab.lastActivitySignature === signature && now - tab.lastActivityAt < throttleMs) {
      return;
    }

    tab.lastActivitySignature = signature;
    tab.lastActivityAt = now;
    recordClientActivity({
      serviceId: state.serviceId || tab.service?.id || "service",
      action,
      url: state.url,
      title: state.title || tab.service?.name || "",
      details: {
        serviceName: state.serviceName || tab.service?.name || "",
        loading: state.loading,
        ...details
      }
    }).catch(() => {});
  }

  shouldConsumeQuotaForRequest(details, service, modelId) {
    if (!shouldConsumeModelQuota(details, service)) return false;

    const now = Date.now();
    for (const [key, stamp] of this.modelUsageDedup.entries()) {
      if (now - stamp > 5000) this.modelUsageDedup.delete(key);
    }

    const key = [
      service?.id || "service",
      modelId || "__unknown__",
      requestPathname(details),
      requestBodyDigest(details)
    ].join("|");

    if (this.modelUsageDedup.has(key)) return false;
    this.modelUsageDedup.set(key, now);
    return true;
  }

  async handleModelPolicyRequest(details) {
    // Manual blocked link (sub-resource / SPA fetch/XHR / programmatic load): cancel the request outright.
    // MUST run before the !connection fail-open AND must NOT use serviceForRequestUrl — that helper filters
    // on modelPolicyEnabled, so a service with blocked links but no pricing would never be resolved and the
    // network seam (the only one catching fetch/XHR) would silently do nothing. Resolve by ORIGIN only; for
    // a cross-origin request (api hosts, redirect targets) fall back to the GLOBAL (all-service) rules.
    {
      const requestOrigin = originOf(details.url);
      const blockService = services.find((item) => originOf(item.url) === requestOrigin) || null;
      const blockRule = blockService
        ? matchesBlockedLink(details.url, blockService)
        : matchesBlockedLink(details.url, { blockedLinks: globalBlockedLinkRules() });
      if (blockRule) {
        this.notifyLinkBlockedThrottled(blockService || this.activeTab?.service || null, details.url, blockRule);
        return { cancel: true };
      }
    }
    if (!connection) return { cancel: false };
    const service = this.serviceForRequestUrl(details.url);
    // ENDPOINT/FIELD DISCOVERY capture (env-gated, OFF by default). Runs BEFORE the !service and
    // likelyModelRequest filters so it ALSO catches cross-origin API hosts (e.g. api.elevenlabs.io) that
    // serviceForRequestUrl doesn't map by origin. Shipped builds set no env → logs NOTHING. Even when ON it
    // records only field NAMES + model-id-like values + a redacted skeleton — never prompt text or tokens
    // (see redactedBodySkeleton). Purpose: discover each service's real submit endpoint + model field so we
    // can add precise per-service patterns (P1) like chatgpt/claude, then this block can be removed.
    if (process.env.CENTRIX_GATE_CAPTURE === "1") {
      try {
        const method = String(details.method || "").toUpperCase();
        if (method === "POST" && ["fetch", "xhr"].includes(String(details.resourceType || ""))) {
          const _eff = effortFromRequest(details) || "";
          const _greedy = modelFromRequest(details) || "";
          writeUserRuntimeLog("gate-post", {
            serviceId: service?.id || "(unmatched)",
            host: originOf(details.url),
            path: requestPathname(details),
            originMatched: !!service,
            greedyModel: _greedy,      // what the OLD greedy deep-search picked (often the WRONG field)
            greedyEffort: _eff,
            likely: service ? likelyModelRequest(details, service) : false,
            consume: service ? shouldConsumeModelQuota(details, service) : false,
            bodyKeys: topLevelKeys(details),
            bodySkeleton: redactedBodySkeleton(details), // structure-preserving, prompt/token-redacted
            bodyDigest: requestBodyDigest(details)
          });
        }
      } catch { /* logging must never affect the flow */ }
    }
    if (!service) return { cancel: false };
    if (!likelyModelRequest(details, service)) return { cancel: false };

    const isQuotaRequest = shouldConsumeModelQuota(details, service);
    // Trusted base model: only chatgpt/claude may use the greedy deep-search; grok reads its real
    // `modelName` field; every other (unverified) service pins its clean default so a stray deep-searched
    // field can never land a wrong name/price in the usage + price table. See trustedBaseModelId().
    const baseModelId = trustedBaseModelId(details, service, isQuotaRequest);
    // Effort/thinking-tier suffix ONLY where the effort field is verified (chatgpt/claude); elsewhere a
    // stray deep-searched effort would corrupt the price key (e.g. "gemini-2.5-pro_turbo").
    const detectedEffort = MODEL_FIELD_VERIFIED_SERVICES.has(String(service?.id || "").toLowerCase())
      ? effortFromRequest(details) : "";
    // detectedModelId mirrors the trusted base (never a stray value that would pollute the price table).
    const detectedModelId = baseModelId;
    // Price/charge per model+effort: the effective modelId encodes the effort (e.g. "gpt-5-5-thinking_standard").
    const modelId = combineModelEffort(baseModelId, detectedEffort);
    if (!modelId && !isQuotaRequest) return { cancel: false };

    // CHECK ONLY here (consume:false) — NEVER debit on the request itself. The debit is settled later,
    // on a SUCCESSFUL (2xx) response (settlePendingCharge), so a chat the service never answers / errors
    // out is NOT charged. consume:false reads the same allow decision (model enabled? + balance) without
    // writing, so it still blocks a disabled model or a no-credit account.
    // Ước lượng token của input NGAY tại đây (body chỉ có ở request gốc) → dùng cho CẢ pre-check lẫn settle
    // (cùng 1 số → quyết định "đủ tiền?" khớp với số credit trừ khi settle). Server bỏ qua nếu model chưa bật token-pricing.
    const estimatedTokens = estimateTokensFromRequest(details);
    const checkBody = {
      serviceId: service.id,
      modelId,
      detectedModelId,
      usageRequestId: "",
      estimatedTokens,
      deviceId: currentDeviceId(),
      profileId: connection.profileId || DEFAULT_PROFILE,
      url: String(details.url || "").slice(0, 2048),
      consume: false
    };

    let result = null;
    try {
      result = await serverRequest("/api/users/model-usage/check", { method: "POST", timeoutMs: 5000, body: checkBody });
    } catch (error) {
      // FAIL CLOSED on a dead session: a 401 here PAST the post-connect grace window means the account
      // token was revoked — almost always an admin "Khóa tài khoản". The embedded service talks DIRECTLY to
      // chatgpt.com (NOT proxied), so cancelling THIS submit is the ONLY thing that stops the chat. Block it,
      // surface the locked message, and fire the lock probe so the BrowserView is torn down at once.
      if (error && error.httpStatus === 401 && (Date.now() - connectionEstablishedAt) > AUTH_EXPIRY_GRACE_MS) {
        this.notifyModelBlocked(service, { reason: "account-locked" }, modelId, details.url);
        maybeForceLogoutIfLocked().catch(() => {});
        return { cancel: true };
      }
      // FAIL OPEN for everything else (network blip, timeout, transient 5xx, or a 401 still INSIDE the grace
      // window so a freshly-issued token isn't blocked): never block a paying customer because the gate is
      // unreachable. Nothing is staged, so this request simply isn't billed (we couldn't verify it).
      return { cancel: false };
    }

    // Block ONLY when the server explicitly denies — model NOT enabled, or OUT of credit. Nothing else blocks.
    if (result.allowed === false) {
      this.emitCreditUsage(service, result, modelId, details.url, { allowed: false, detectedModelId, usageRequestId: "" });
      this.notifyModelBlocked(service, result, modelId, details.url);
      return { cancel: true };
    }

    // Allowed + a real prompt submit -> STAGE a pending charge, settled later only if the response is 2xx.
    if (isQuotaRequest && this.shouldConsumeQuotaForRequest(details, service, modelId || "__unknown__")) {
      // (a) Ngưỡng xác nhận: lần gửi tốn nhiều credit (paste lớn) → hỏi trước; hủy = KHÔNG gửi + KHÔNG charge.
      const preCost = Number(result.creditCost) || 0;
      if (CHARGE_CONFIRM_CREDITS > 0 && preCost >= CHARGE_CONFIRM_CREDITS) {
        const proceed = await confirmLargeCharge(service, preCost, estimatedTokens);
        if (!proceed) return { cancel: true };
      }
      const now = Date.now();
      for (const [rid, p] of this.pendingCharges) { if (now - p.at > 60000) this.pendingCharges.delete(rid); } // sweep orphans
      this.pendingCharges.set(details.id, {
        service,
        modelId,
        detectedModelId,
        usageRequestId: usageRequestIdFor(details, service, modelId || "__unknown__"),
        url: String(details.url || "").slice(0, 2048),
        profileId: connection.profileId || DEFAULT_PROFILE,
        estimatedTokens, // gửi lại y hệt khi settle để trừ đúng số credit theo token

        // Carry the pre-check's cost + balance so settle can update the UI optimistically (instantly)
        // instead of waiting for the consume round-trip through the tunnel (the ~5s lag the user saw).
        creditCost: Number(result.creditCost),
        balanceAtCheck: Number(result.balance ?? result.remaining ?? result.wallet?.balance),
        at: now
      });
    }
    return { cancel: false };
  }

  // Settle a staged charge once the service has answered. Only a 2xx response debits credit; an HTTP
  // error response (4xx/5xx) does not — the customer didn't get a working answer. Never blocks or throws.
  async settlePendingCharge(details) {
    const pending = this.pendingCharges.get(details.id);
    if (!pending) return;
    this.pendingCharges.delete(details.id);
    const status = Number(details.statusCode || 0);
    if (status < 200 || status >= 300) return; // not a successful response -> no charge
    if (!connection) return;
    // OPTIMISTIC balance update: the consume round-trip (App User -> Cloudflare tunnel -> App Server ->
    // Docker -> back) can take several seconds, so the balance lagged the visible answer. Update the UI
    // NOW — the instant the service responds — using the cost + balance the pre-check already returned,
    // then reconcile to the authoritative number when the settle replies. Both emits carry the SAME
    // usageRequestId, so applyCreditUsagePayload toasts/counts once and only snaps the number on reconcile.
    const optCost = Number(pending.creditCost);
    if (Number.isFinite(optCost) && optCost > 0) {
      const optBalance = Number.isFinite(pending.balanceAtCheck) ? Math.max(0, pending.balanceAtCheck - optCost) : null;
      this.emitCreditUsage(
        pending.service,
        { allowed: true, reason: "allowed", creditCost: optCost, balance: optBalance, remaining: optBalance },
        pending.modelId,
        pending.url,
        { allowed: true, detectedModelId: pending.detectedModelId, usageRequestId: pending.usageRequestId }
      );
    }
    try {
      const result = await serverRequest("/api/users/model-usage/check", {
        method: "POST",
        timeoutMs: 5000,
        body: {
          serviceId: pending.service?.id || "",
          modelId: pending.modelId,
          detectedModelId: pending.detectedModelId,
          usageRequestId: pending.usageRequestId, // idempotency key -> the server debits this id at most once
          estimatedTokens: pending.estimatedTokens, // cùng số token với pre-check → trừ credit khớp
          deviceId: currentDeviceId(),
          profileId: pending.profileId,
          url: pending.url,
          consume: true
        }
      });
      if (result && result.allowed !== false) {
        this.emitCreditUsage(pending.service, result, pending.modelId, pending.url, {
          allowed: true,
          detectedModelId: pending.detectedModelId,
          usageRequestId: pending.usageRequestId
        });
      }
    } catch {
      // The customer already got their answer; a failed settle just means this one isn't billed. Never block.
    }
  }

  discardPendingCharge(id) {
    this.pendingCharges.delete(id);
  }

  emitCreditUsage(service, result = {}, modelId = "", url = "", extra = {}) {
    const allowed = extra.allowed !== false && result.allowed !== false;
    this.emit("credit:usage", {
      allowed,
      serviceId: service?.id || "",
      serviceName: service?.name || service?.id || "Service",
      modelId: modelId || result.modelId || "",
      detectedModelId: extra.detectedModelId || "",
      usageRequestId: extra.usageRequestId || "",
      reason: result.reason || (allowed ? "allowed" : "blocked"),
      creditCost: result.creditCost ?? null,
      balance: result.balance ?? null,
      remaining: result.remaining ?? null,
      idempotent: result.idempotent === true,
      url: String(url || "").slice(0, 2048),
      message: allowed
        ? `${service?.name || service?.id || "Service"} da tru ${result.creditCost ?? 0} credit. Con ${result.balance ?? 0} credit.`
        : modelBlockedMessage(result, service, modelId)
    });
  }

  showTab(tab) {
    if (this.activeTab === tab && tab.attached) return;
    this.detachActiveTab();
    this.activeTab = tab;
    this.setTabBounds(tab, this.bounds);

    if (tab.viewType === "WebContentsView") {
      this.window.contentView.addChildView(tab.view);
      applyServiceViewRadius(tab.view);
    } else {
      this.window.setBrowserView(tab.view);
    }

    tab.attached = true;
    this.setTabBounds(tab, this.bounds);
  }

  detachActiveTab() {
    const tab = this.activeTab;
    if (!tab?.attached) return;

    try {
      if (tab.viewType === "WebContentsView") {
        this.window.contentView.removeChildView(tab.view);
      } else {
        this.window.setBrowserView(null);
      }
    } catch {
      // View can already be detached while switching or closing.
    }

    tab.attached = false;
    // TẮT/ẨN/CHUYỂN dịch vụ → XOÁ throttle probe của nó, để lần MỞ LẠI kiểm tra revision NGAY (không đợi hết
    // cửa sổ POOL_PROBE_CACHE_MS). Nhờ vậy "tắt dịch vụ có profile cũ, mở lại liền" sẽ nhận profile mới nhất
    // Manager vừa đẩy, thay vì phải đợi ~15s. Chỉ reset đồng hồ probe (giữ nguyên revision baseline) → mở lại
    // chỉ probe 1 GET nhẹ; nếu Manager re-seed (rev tăng) mới re-pull.
    if (profilePoolMode && tab.service?.id) {
      const st = poolPullState.get(String(tab.service.id).toLowerCase());
      if (st) st.lastProbeAt = 0;
    }
  }

  closeAll() {
    this.openRequestSerial += 1;
    this.detachActiveTab();
    for (const tab of this.tabs.values()) {
      for (const timer of tab.uiCacheTimers || []) clearTimeout(timer);
      tab.uiCacheTimers = [];
      this.recordTabActivity(tab, "close-service", { reason: "disconnect" }, 0);
      try {
        if (tab.webContents && !tab.webContents.isDestroyed()) {
          if (typeof tab.webContents.close === "function") {
            tab.webContents.close();
          } else if (typeof tab.webContents.destroy === "function") {
            tab.webContents.destroy();
          }
        }
      } catch {
        // Closing best-effort during disconnect.
      }
    }
    this.tabs.clear();
    this.activeTab = null;
  }

  closeServicesNotIn(allowedServiceIds) {
    const allowed = new Set(allowedServiceIds || []);
    for (const [key, tab] of this.tabs.entries()) {
      if (allowed.has(tab.service?.id)) continue;
      const wasActive = this.activeTab === tab;
      for (const timer of tab.uiCacheTimers || []) clearTimeout(timer);
      tab.uiCacheTimers = [];
      this.recordTabActivity(tab, "close-service", { reason: "permission-refresh" }, 0);
      if (wasActive) this.detachActiveTab();
      try {
        if (tab.webContents && !tab.webContents.isDestroyed()) {
          if (typeof tab.webContents.close === "function") {
            tab.webContents.close();
          } else if (typeof tab.webContents.destroy === "function") {
            tab.webContents.destroy();
          }
        }
      } catch {
        // Best-effort cleanup when permissions change.
      }
      this.tabs.delete(key);
      if (wasActive) this.activeTab = null;
    }
  }

  attachEvents(tab) {
    const wc = tab.webContents;

    wc.setZoomFactor(1);
    wc.setWindowOpenHandler(({ url }) => {
      // FAIL CLOSED: never loadURL a non-web scheme (file:/chrome:/devtools:/data:/…). A window.open to such
      // a scheme is denied outright — the tab must not navigate to it. http/https/about:blank pass, so real
      // OAuth/login popups and target=_blank links still redirect into the tab exactly as before.
      if (!isAllowedNavScheme(url)) return { action: "deny" };
      const blockRule = matchesBlockedLink(url, tab.service);
      if (blockRule) { this.handleBlockedNav(tab, url, blockRule); return { action: "deny" }; }
      if (String(url || "") !== "about:blank") tab.errorPageVisible = false;
      wc.loadURL(url).catch((error) => {
        tab.lastError = error.message;
      });
      return { action: "deny" };
    });

    wc.on("will-navigate", (_event, url) => {
      // Manual blocked link: stop the navigation dead and keep the tab on its current page (toast only).
      const blockRule = matchesBlockedLink(url, tab.service);
      if (blockRule) { _event.preventDefault(); this.handleBlockedNav(tab, url, blockRule); return; }
      if (isAllowedNavScheme(url) && String(url || "") !== "about:blank") {
        tab.errorPageVisible = false;
      }
    });

    // A server 3xx to a blocked link fires will-redirect (NOT will-navigate) — without this seam a redirect
    // walks straight into the blocked URL. Abort mid-flight and paint the block page (the original load is dead).
    wc.on("will-redirect", (event, url) => {
      const blockRule = matchesBlockedLink(url, tab.service);
      if (blockRule) { event.preventDefault(); this.handleBlockedNav(tab, url, blockRule, { replacePage: true }); }
    });

    wc.on("page-title-updated", (_event, title) => {
      if (this.activeTab === tab) this.emit("browser:title", { title });
      // Persist the FRESH conversation title to the server (ChatGPT/Claude set it after load) so the
      // usage history keeps the right title cross-device. Signature-deduped + throttled.
      this.recordTabActivity(tab, "navigate", {}, 2500);
      heartbeatClientTabs().catch(() => {});
    });

    wc.on("did-start-loading", () => {
      if (!tab.errorPageVisible) tab.lastError = "";
      clearTimeout(tab.blankRecoveryTimer);
      if (this.activeTab === tab) this.emit("browser:loading", { loading: true });
      heartbeatClientTabs().catch(() => {});
    });

    wc.on("dom-ready", () => {
      this.applyUserLocalStore(tab).catch(() => {});
      this.applyUiRules(tab).catch(() => {});
      this.checkLoginState(tab, "dom-ready").catch(() => {}); // AUTO RE-SEED: soi DOM login (logout không đổi URL)
    });

    wc.on("did-stop-loading", () => {
      this.applyUiRules(tab).catch(() => {});
      this.captureUserLocalStore(tab).catch(() => {});
      this.checkLoginState(tab, "did-stop").catch(() => {}); // AUTO RE-SEED: bắt logout reload cùng URL
      this.syncUiCache(tab, "page-loaded").catch(() => {});
      this.scheduleUiCacheSync(tab, "page-settle");
      if (!tab.preparing) this.scheduleBlankRecovery(tab);
      this.recordTabActivity(tab, "page-loaded", {}, 5000);
      if (this.activeTab === tab) {
        this.emit("browser:loading", { loading: false });
        this.emit("browser:navigation", this.state());
      }
      heartbeatClientTabs().catch(() => {});
      scheduleProfilePush();
    });

    wc.on("did-navigate", () => {
      this.syncUiCache(tab, "navigate").catch(() => {});
      this.scheduleUiCacheSync(tab, "navigate-settle");
      this.recordTabActivity(tab, "navigate", {}, 3000);
      if (this.activeTab === tab) this.emit("browser:navigation", this.state());
      heartbeatClientTabs().catch(() => {});
      scheduleProfilePush();
      this.maybeDetectSessionLoss(tab); // AUTO RE-SEED: đá về /login → khởi động khôi phục phiên
    });

    wc.on("did-navigate-in-page", () => {
      // SPA route change (history.pushState) fires NO will-navigate/network request — catch a blocked
      // in-page route here and paint the block page (the tab is already sitting on the blocked url).
      let current = ""; try { current = wc.getURL(); } catch { current = ""; }
      const blockRule = matchesBlockedLink(current, tab.service);
      if (blockRule) { this.handleBlockedNav(tab, current, blockRule, { replacePage: true }); return; }
      this.syncUiCache(tab, "navigate-in-page").catch(() => {});
      this.scheduleUiCacheSync(tab, "spa-settle");
      this.recordTabActivity(tab, "navigate-in-page", {}, 3000);
      if (this.activeTab === tab) this.emit("browser:navigation", this.state());
      heartbeatClientTabs().catch(() => {});
      scheduleProfilePush();
      this.maybeDetectSessionLoss(tab); // AUTO RE-SEED: bắt cả logout kiểu SPA (pushState về /login)
    });

    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return;
      tab.lastError = errorDescription || "";
      writeUserRuntimeLog("service-load-error", {
        serviceId: tab.service?.id || "",
        serviceName: tab.service?.name || "",
        url: validatedURL || tab.webContents.getURL(),
        errorCode,
        errorDescription
      });
      this.recordTabActivity(tab, "load-error", { errorCode, errorDescription }, 0);
      if (this.activeTab === tab) {
        this.emit("browser:error", {
          errorCode,
          errorDescription,
          url: validatedURL
        });
      }
    });
  }

  async applyUiRules(tab) {
    if (!tab?.webContents || tab.webContents.isDestroyed()) return;
    const wc = tab.webContents;
    // REVERSIBLE: undo the PREVIOUS application first, so clearing/changing a rule in the Manager actually
    // takes effect on the next (re)open. This used to be ADD-ONLY — the old hide-CSS stayed inserted and the
    // persistent replace observer kept running forever, so "xoá rule + lưu nhưng App User vẫn dính".
    for (const k of ["uiFrameCssKey", "uiHideCssKey"]) {
      if (tab[k]) { try { await wc.removeInsertedCSS(tab[k]); } catch { /* already gone */ } tab[k] = ""; }
    }
    try { await wc.executeJavaScript("(function(){try{window.__cxAppReplaceCleanup&&window.__cxAppReplaceCleanup();}catch(e){}})()", true); } catch { /* ignore */ }
    try { tab.uiFrameCssKey = await wc.insertCSS(serviceViewportChromeCss(), { cssOrigin: "user" }); } catch { /* ignore */ }
    await wc.executeJavaScript(serviceViewportChromeScript(tab.service), true).catch(() => null);
    const css = hideCssTextForService(tab.service);
    if (css) { try { tab.uiHideCssKey = await wc.insertCSS(css, { cssOrigin: "user" }); } catch { /* ignore */ } }
    const replaceScript = replaceRulesScriptForService(tab.service);
    if (replaceScript) await wc.executeJavaScript(replaceScript, true).catch(() => null);
    const userScript = userScriptRunnerForService(tab.service);
    if (userScript) await wc.executeJavaScript(userScript, true).catch(() => null);
  }

  // AUTO RE-SEED — phát hiện mất phiên: tab điều hướng tới trang /login SAU KHI đã từng đăng nhập được
  // (wasAuthed) → coi là bị đá ra → khởi động khôi phục. Chỉ chạy ở pool-mode + khi bật cờ.
  // Đồng bộ ngược cho các call cũ.
  maybeDetectSessionLoss(tab) { this.checkLoginState(tab, "nav").catch(() => {}); }

  // Phát hiện mất phiên bằng URL + DOM: nhiều dịch vụ (noxtools…) khi logout KHÔNG đổi URL sang /login mà
  // render lại form đăng nhập tại chỗ → phải soi DOM (có ô password + chữ login). wasAuthed chặn dương-tính lần
  // đầu. Gọi ở did-navigate / in-page / dom-ready / did-stop-loading + poll active-tab.
  async checkLoginState(tab, reason) {
    if (!AUTO_RESEED || !profilePoolMode) return;
    if (!tab || !tab.service?.id || !tab.webContents || tab.webContents.isDestroyed() || tab.recovering) return;
    let url = ""; try { url = tab.webContents.getURL(); } catch { return; }
    let dom = {};
    try {
      dom = await tab.webContents.executeJavaScript(`(function(){try{
        var pw=document.querySelector('input[type=password]');
        var vis=!!(pw && pw.offsetParent!==null && pw.getClientRects().length>0);
        var t=((document.body&&document.body.innerText)||'').toLowerCase().slice(0,4000);
        return { hasPw:vis, loginWord:/(log ?in|sign ?in|đăng nhập|log ?out được|phiên đăng nhập)/.test(t) };
      }catch(e){ return { err:String(e&&e.message||e) }; }})()`, true);
    } catch (e) { dom = { err: "exec:" + (e && e.message) }; }
    const isLoginUrl = urlLooksLikeLogin(url, tab.service);
    const looksLoggedOut = isLoginUrl || (dom.hasPw === true);
    console.error("[reseed] check(" + reason + ")", tab.service.id, "url=" + String(url).slice(0, 60), "isLoginUrl=" + isLoginUrl, "hasPw=" + dom.hasPw, "loginWord=" + dom.loginWord, "wasAuthed=" + !!tab.wasAuthed, dom.err ? ("err=" + dom.err) : "");
    if (!looksLoggedOut) { tab.wasAuthed = true; tab.everAuthed = true; return; } // đang đăng nhập bình thường
    if (!tab.everAuthed) return;                            // tab CHƯA TỪNG đăng nhập → bỏ (mở lần đầu tự hiện login)
    if (tab.reseedCooldownUntil && Date.now() < tab.reseedCooldownUntil) return; // đang backoff sau lần thất bại
    console.error("[reseed] TRIGGER recovery for", tab.service.id, "reason=" + reason);
    this.beginSessionRecovery(tab).catch((e) => console.error("[reseed] recovery err", e && e.message));
  }

  // Khôi phục phiên: báo backend "session chết" rồi POLL revision nhanh (bỏ qua throttle 15s) tới khi
  // Manager/VPS đẩy snapshot mới (revision tăng / slot đổi) → pull profile tươi + reload tab → vào lại.
  async beginSessionRecovery(tab) {
    const svc = tab.service;
    const sid = String(svc.id).toLowerCase();
    if (tab.recovering) return;                                   // đang khôi phục dịch vụ này rồi
    const now = Date.now();
    if (tab.reseedCooldownUntil && now < tab.reseedCooldownUntil) return; // backoff sau lần thất bại
    tab.recovering = true;
    const wc = tab.webContents;
    const prevState = poolPullState.get(sid) || {};
    let baseRev = Number(prevState.revision) || 0; // let: cập nhật khi phiên kéo về chết để chờ bump kế
    const baseAssigned = prevState.assignedProfile || null;
    // Overlay "Đang làm mới phiên…" đè lên trang login (inject vào view — renderer DOM bị view che).
    try { if (wc && !wc.isDestroyed()) await wc.executeJavaScript(reseedOverlayShowScript(svc.name || sid), true); } catch { /* ignore */ }
    if (this.activeTab === tab) this.emit("browser:reseeding", { serviceId: sid, active: true }); // tín hiệu chrome (nếu cần)
    recordClientActivity({ serviceId: sid, action: "session-lost-detected", title: svc.name || sid }).catch(() => {});
    let curUrl = ""; try { curUrl = tab.webContents.getURL(); } catch { /* ignore */ }
    // Gửi kèm URL đang kẹt (trang cần auth) → worker load ĐÚNG url đó để ép form login (service.url có thể là
    // trang chủ public không hiện form → vault không điền được). RETRY: 1 blip mạng không được làm mất job.
    const postDead = async () => {
      for (let i = 0; i < 3; i += 1) {
        try { const r = await serverRequest("/api/pool/session-dead", { method: "POST", body: { service: sid, url: curUrl }, timeoutMs: 8000 }); return (r && r.status) || "queued"; }
        catch { await new Promise((r) => setTimeout(r, 1000)); }
      }
      console.error("[reseed] báo session-dead thất bại 3 lần (mạng?)"); return "";
    };
    // Kéo profile mới nhất + reload + xác minh đã đăng nhập. true=OK, false=cookie chưa xác thực, null=lỗi mạng.
    const attemptRecover = async (tag) => {
      let pulled = null;
      try { pulled = await pullServiceProfileFromServer(sid, { includeStorage: true }); }
      catch (e) { console.error("[reseed] pull lỗi (" + tag + "):", e && e.message); return null; }
      if (!tab.webContents || tab.webContents.isDestroyed()) return false;
      // Sau khi có cookie tươi: về ĐÚNG trang dịch vụ (svc.url) — KHÔNG để rơi vào trang "đã đăng nhập hẳn"
      // (dashboard tài khoản như noxtools /secure/member) mà trang login hay redirect tới. Chỉ GIỮ nguyên (reload)
      // khi đang ở deep-link THẬT trong chính dịch vụ (cùng origin + không phải trang login) → không mất chỗ user xem.
      let recoverTarget = "";
      try {
        const cu = new URL(curUrl), su = new URL(svc.url || curUrl);
        recoverTarget = (cu.origin === su.origin && !urlLooksLikeLogin(curUrl, svc)) ? "" : (svc.url || "");
      } catch { recoverTarget = svc.url || ""; }
      if (recoverTarget) { try { await tab.webContents.loadURL(recoverTarget); } catch { try { tab.webContents.reload(); } catch (e) { /* */ } } }
      else tab.webContents.reload();
      await new Promise((r) => setTimeout(r, 3500));
      let stillLogin = false;
      try { stillLogin = await tab.webContents.executeJavaScript(`(function(){try{var pw=document.querySelector('input[type=password]');return !!(pw&&pw.offsetParent!==null&&pw.getClientRects().length>0);}catch(e){return false;}})()`, true); } catch { /* ignore */ }
      const ok = !stillLogin;
      console.error("[reseed] pull+verify (" + tag + "): cookies=" + (pulled && pulled.imported && pulled.imported.cookieCount != null ? pulled.imported.cookieCount : "?") + " stillLogin=" + stillLogin + " → " + (ok ? "OK" : "chưa xác thực"));
      return ok;
    };
    let reportStatus = await postDead();
    const deadline = Date.now() + RESEED_WAIT_MS;
    const REREPORT_MS = Math.max(4000, Number(process.env.CENTRIX_RESEED_REREPORT_MS) || 8000);
    let refreshed = false, lastReport = Date.now(), bumpSeen = false;
    // Nếu backend đang COOLING (vừa có phiên tươi) → thử kéo NGAY, khỏi chờ bump.
    if (reportStatus === "cooling" && tab.recovering) { const r = await attemptRecover("cooling"); if (r === true) refreshed = true; if (r !== null) bumpSeen = true; }
    while (!refreshed && Date.now() < deadline && tab.recovering && tab.webContents && !tab.webContents.isDestroyed()) {
      await new Promise((r) => setTimeout(r, RESEED_POLL_MS));
      // Re-report CHỈ khi CHƯA thấy seed nào (chưa bump) và đã quá REREPORT_MS → khơi seed/phá cooling. Khi đã
      // có seed rồi thì thôi re-report (tránh đẻ seed mới đá chính phiên đang verify = churn single-session).
      if (!bumpSeen && Date.now() - lastReport > REREPORT_MS) { lastReport = Date.now(); reportStatus = await postDead(); }
      let info; try { info = await serverRequest(`/api/profile/revision?service=${encodeURIComponent(sid)}`, { timeoutMs: 8000 }); } catch { continue; }
      const rev = Number(info?.revision);
      const assigned = info?.assignedProfile || null;
      const bumped = (Number.isFinite(rev) && rev > baseRev) || (assigned && baseAssigned && assigned !== baseAssigned);
      if (!bumped) continue;
      bumpSeen = true; // đã có seed → ngừng re-report để không đẻ seed mới đá phiên này (churn)
      const r = await attemptRecover("bump");
      if (r === true) { refreshed = true; break; }
      if (r === false) baseRev = rev; // phiên kéo về CHẾT → cập nhật mốc; nếu có seed MỚI (bump khác) sẽ thử lại
      // r === null (lỗi mạng) → thử lại vòng sau
    }
    tab.recovering = false;
    if (this.activeTab === tab) this.emit("browser:reseeding", { serviceId: sid, active: false });
    if (refreshed) {
      // reload() đã xoá overlay; gỡ thêm phòng khi reload chưa kịp (best-effort).
      try { if (wc && !wc.isDestroyed()) await wc.executeJavaScript(reseedOverlayHideScript(), true); } catch { /* ignore */ }
      // GRACE NGẮN: chỉ đủ để reload ổn định, KHÔNG chặn lần logout thật sau đó ("cứ thấy logout là nạp lại").
      tab.reseedCooldownUntil = Date.now() + Math.max(2000, Number(process.env.CENTRIX_RESEED_SUCCESS_GRACE_MS) || 5000);
      recordClientActivity({ serviceId: sid, action: "session-recovered", title: svc.name || sid }).catch(() => {});
    } else {
      tab.reseedCooldownUntil = Date.now() + RESEED_COOLDOWN_MS; // chống loop khi cookie chết kéo dài
      try { if (wc && !wc.isDestroyed()) await wc.executeJavaScript(reseedOverlayErrorScript(), true); } catch { /* ignore */ }
      if (this.activeTab === tab) this.emit("browser:error", { errorDescription: "Không làm mới được phiên. Vui lòng thử lại sau ít phút." });
      recordClientActivity({ serviceId: sid, action: "session-recover-timeout", title: svc.name || sid }).catch(() => {});
    }
  }

  async loadUserUiCache(service) {
    if (!connection || !service?.id) return [];
    const result = await serverRequest(
      `/api/users/ui-cache?serviceId=${encodeURIComponent(service.id)}`,
      { timeoutMs: 5000 }
    );
    return normalizeUiCacheItems(result?.cache?.items || []);
  }

  async syncUiCache(tab, reason = "dom") {
    if (!connection || !tab?.service?.id || !tab?.webContents || tab.webContents.isDestroyed()) return 0;
    const now = Date.now();
    if (now - Number(tab.lastUiCacheSyncAt || 0) < 2500) return 0;
    tab.lastUiCacheSyncAt = now;

    await delay(350);
    const collected = await tab.webContents.executeJavaScript(collectUiCacheScript(tab.service), true).catch(() => null);
    const items = normalizeUiCacheItems(collected?.items || []);
    if (!items.length) {
      return 0;
    }

    const result = await serverRequest("/api/users/ui-cache", {
      method: "POST",
      timeoutMs: 6000,
      body: {
        serviceId: tab.service.id,
        items,
        source: reason,
        sessionId: currentDeviceId()
      }
    }).catch(() => null);

    const merged = normalizeUiCacheItems(result?.items || items);
    tab.service.uiCacheItems = merged;
    this.recordTabActivity(tab, "ui-cache-sync", {
      reason,
      domCount: Number(collected?.domCount || 0),
      count: merged.length
    }, 5000);
    return merged.length;
  }

  scheduleUiCacheSync(tab, reason = "settle") {
    if (!tab?.webContents || tab.webContents.isDestroyed()) return;
    for (const timer of tab.uiCacheTimers || []) clearTimeout(timer);
    tab.uiCacheTimers = [1200, 3200, 7000].map((ms) => setTimeout(() => {
      this.syncUiCache(tab, reason).catch(() => {});
    }, ms));
  }

  async preloadUserLocalStore(tab, timeoutMs = LOCAL_STORE_PRELOAD_TIMEOUT_MS) {
    if (!connection || !tab?.service?.id || !tab?.webContents || tab.webContents.isDestroyed()) return 0;
    const origin = originOf(tab.service.url);
    if (!origin || tab.localStoreReloadedOrigins.has(origin)) return 0;
    const preloadKey = `${tab.service.id}|${origin}`;
    if (this.localStorePreloadedKeys.has(preloadKey)) {
      tab.localStoreReloadedOrigins.add(origin);
      return 0;
    }

    const result = await serverRequest(
      `/api/users/local-store?serviceId=${encodeURIComponent(tab.service.id)}&origin=${encodeURIComponent(origin)}`,
      { timeoutMs: 8000 }
    ).catch(() => null);
    const items = result?.store?.items || {};
    const itemCount = Object.keys(items).length;

    if (!itemCount) {
      tab.localStoreReloadedOrigins.add(origin);
      return 0;
    }

    const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    paintWhenInitiallyHidden: false,
    icon: APP_ICON,
    webPreferences: {
      session: tab.webContents.session,
      contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });

    try {
      const loaded = await withTimeout(
        win.webContents.loadURL(origin).then(() => true).catch(() => false),
        timeoutMs,
        false
      );
      if (!loaded) return 0;
      const appliedCount = await win.webContents.executeJavaScript(`
        (() => {
          const items = ${encodeScriptValue(items)};
          for (const [key, value] of Object.entries(items)) {
            localStorage.setItem(key, String(value));
          }
          return Object.keys(items).length;
        })()
      `, true).catch(() => 0);
      tab.localStoreReloadedOrigins.add(origin);
      this.localStorePreloadedKeys.add(preloadKey);
      if (appliedCount > 0) {
        this.recordTabActivity(tab, "local-store-preload", { origin, count: appliedCount }, 0);
      }
      return appliedCount || 0;
    } finally {
      if (!win.isDestroyed()) win.close();
    }
  }

  async preloadLocalStoreForService(service, timeoutMs = LOCAL_STORE_PRELOAD_TIMEOUT_MS) {
    if (!connection || !service?.id || !service?.url) return 0;
    const origin = originOf(service.url);
    if (!origin) return 0;
    const preloadKey = `${service.id}|${origin}`;
    if (this.localStorePreloadedKeys.has(preloadKey)) return 0;

    const result = await serverRequest(
      `/api/users/local-store?serviceId=${encodeURIComponent(service.id)}&origin=${encodeURIComponent(origin)}`,
      { timeoutMs: 8000 }
    ).catch(() => null);
    const items = result?.store?.items || {};
    const itemCount = Object.keys(items).length;
    if (!itemCount) {
      this.localStorePreloadedKeys.add(preloadKey);
      return 0;
    }

    const targetSession = userBrowserSession(this.profileId);
    const win = new BrowserWindow({
      width: 900,
      height: 700,
      show: false,
      paintWhenInitiallyHidden: false,
      icon: APP_ICON,
      webPreferences: {
        session: targetSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });

    try {
      const loaded = await withTimeout(
        win.webContents.loadURL(origin).then(() => true).catch(() => false),
        timeoutMs,
        false
      );
      if (!loaded) return 0;
      const appliedCount = await win.webContents.executeJavaScript(`
        (() => {
          const items = ${encodeScriptValue(items)};
          for (const [key, value] of Object.entries(items)) {
            localStorage.setItem(key, String(value));
          }
          return Object.keys(items).length;
        })()
      `, true).catch(() => 0);
      this.localStorePreloadedKeys.add(preloadKey);
      if (appliedCount > 0) {
        recordClientActivity({
          serviceId: service.id,
          action: "local-store-background-preload",
          url: origin,
          title: service.name || service.id,
          details: { origin, count: appliedCount }
        }).catch(() => {});
      }
      return appliedCount || 0;
    } finally {
      if (!win.isDestroyed()) win.close();
    }
  }

  preloadLocalStoreForServices(serviceList = services, options = {}) {
    if (this.localStorePreloadPromise) return this.localStorePreloadPromise;
    const list = (Array.isArray(serviceList) ? serviceList : [])
      .filter((service) => service?.id && service?.url)
      .slice(0, 16);
    const timeoutMs = options.timeoutMs || LOCAL_STORE_PRELOAD_TIMEOUT_MS;
    this.localStorePreloadPromise = (async () => {
      let count = 0;
      for (const service of list) {
        count += await this.preloadLocalStoreForService(service, timeoutMs).catch(() => 0);
      }
      return count;
    })().finally(() => {
      this.localStorePreloadPromise = null;
    });
    return this.localStorePreloadPromise;
  }

  scheduleBlankRecovery(tab) {
    if (tab?.errorPageVisible) return;
    clearTimeout(tab.blankRecoveryTimer);
    tab.blankRecoveryTimer = setTimeout(() => {
      this.recoverBlankTab(tab).catch(() => {});
    }, 3500);
  }

  async recoverBlankTab(tab) {
    if (!tab?.webContents || tab.webContents.isDestroyed() || tab.webContents.isLoading() || tab.errorPageVisible) return;
    if (tab.blankRecoveryAttempts >= 2) {
      const message = `${tab.service?.name || "Dich vu"} dang hien trang trong sau nhieu lan tai lai.`;
      writeUserRuntimeLog("service-blank-recovery-exhausted", {
        serviceId: tab.service?.id || "",
        serviceName: tab.service?.name || "",
        url: tab.webContents.getURL() || "",
        attempts: tab.blankRecoveryAttempts
      });
      await this.showServiceErrorPage(tab, message, {
        reason: "blank-recovery-exhausted",
        attempts: tab.blankRecoveryAttempts
      });
      return;
    }

    const info = await tab.webContents.executeJavaScript(`
      (() => ({
        href: location.href,
        title: document.title || "",
        readyState: document.readyState || "",
        bodyTextLength: (document.body?.innerText || "").trim().length,
        childCount: document.body?.children?.length || 0
      }))()
    `, true).catch(() => null);

    const url = tab.webContents.getURL() || "";
    const looksBlank = !info || url === "about:blank" || (info.readyState === "complete" && info.bodyTextLength === 0 && info.childCount <= 1);
    if (!looksBlank) {
      tab.blankRecoveryAttempts = 0;
      return;
    }

    tab.blankRecoveryAttempts += 1;
    const fallbackUrl = fallbackUrlForService(tab.service);
    tab.lastError = `Trang dang trang, dang thu tai lai ${tab.service?.name || "dich vu"}...`;
    writeUserRuntimeLog("service-blank-recovery", {
      serviceId: tab.service?.id || "",
      serviceName: tab.service?.name || "",
      url,
      attempt: tab.blankRecoveryAttempts,
      info
    });
    if (this.activeTab === tab) {
      this.emit("browser:error", {
        errorCode: 0,
        errorDescription: tab.lastError,
        url
      });
    }

    if (fallbackUrl && originOf(fallbackUrl) === originOf(url || tab.service?.url) && fallbackUrl !== url) {
      await tab.webContents.loadURL(fallbackUrl);
      tab.loaded = true;
      return;
    }

    if (typeof tab.webContents.reloadIgnoringCache === "function") {
      tab.webContents.reloadIgnoringCache();
    } else {
      tab.webContents.reload();
    }
  }

  reloadOpenTabsAfterStorageSync() {
    let count = 0;
    const now = Date.now();
    for (const tab of this.tabs.values()) {
      if (!tab?.webContents || tab.webContents.isDestroyed()) continue;
      if (tab === this.activeTab) continue; // NEVER reload the session the user is actively viewing
      // Debounce so two concurrent devices don't reload each other in a storm.
      if (tab.lastStorageReloadAt && now - tab.lastStorageReloadAt < 12000) continue;
      const url = tab.webContents.getURL();
      // Reload the CURRENT page so the provider's latest state (e.g. a conversation just created on the
      // other device) is re-fetched. Fall back to the service URL only when the tab is blank.
      const targetUrl = (!url || url === "about:blank") ? fallbackUrlForService(tab.service) : url;
      if (!targetUrl) continue;
      tab.lastStorageReloadAt = now;
      tab.blankRecoveryAttempts = 0;
      try {
        tab.webContents.loadURL(targetUrl).catch((error) => {
          tab.lastError = error.message || "Reload failed";
        });
        count += 1;
      } catch (error) {
        tab.lastError = error.message || "Reload failed";
      }
    }
    return count;
  }

  async showServiceErrorPage(tab, message, details = {}) {
    if (!tab?.webContents || tab.webContents.isDestroyed()) return;
    const service = tab.service || {};
    const retryUrl = fallbackUrlForService(service) || service.url || "";
    tab.lastError = message || "Khong tai duoc dich vu.";
    tab.loaded = false;
    tab.errorPageVisible = true;
    this.recordTabActivity(tab, "service-error-page", {
      message: tab.lastError,
      retryUrl,
      ...details
    }, 0);
    if (this.activeTab === tab) {
      this.emit("browser:error", {
        errorCode: 0,
        errorDescription: tab.lastError,
        url: tab.webContents.getURL() || retryUrl
      });
    }

    try {
      await tab.webContents.loadURL("about:blank");
      const html = `
        <style>
          html,body{height:100%;margin:0;background:#f4f8fc;color:#0f172a;font-family:Segoe UI,system-ui,sans-serif}
          body{display:grid;place-items:center}
          .box{width:min(520px,calc(100vw - 40px));padding:28px;border:1px solid #d8e3ef;border-radius:14px;background:#fff;box-shadow:0 18px 48px rgba(15,23,42,.10);text-align:center}
          .icon{width:48px;height:48px;margin:0 auto 14px;border-radius:14px;background:#1e93f5;color:#fff;display:grid;place-items:center;font-weight:800}
          h1{margin:0 0 8px;font-size:20px;line-height:1.25}
          p{margin:0 0 18px;color:#5b6677;font-size:14px;line-height:1.5}
          button{border:0;border-radius:10px;background:#1e93f5;color:#fff;font-weight:700;font-size:14px;padding:10px 16px;cursor:pointer}
        </style>
        <div class="box">
          <div class="icon">CX</div>
          <h1>${escapeHtmlForInjectedPage(service.name || "Dich vu")} chua hien giao dien</h1>
          <p>${escapeHtmlForInjectedPage(tab.lastError)} App da chan man hinh trang de ban biet trang chua tai xong.</p>
          ${retryUrl ? `<button id="retry">Tai lai dich vu</button>` : ""}
        </div>
      `;
      await tab.webContents.executeJavaScript(`
        (() => {
          document.open();
          document.write(${JSON.stringify(html)});
          document.close();
          const retryUrl = ${JSON.stringify(retryUrl)};
          document.getElementById("retry")?.addEventListener("click", () => {
            if (retryUrl) location.href = retryUrl;
          });
        })()
      `, true);
    } catch (error) {
      writeUserRuntimeLog("service-error-page-failed", {
        serviceId: service.id || "",
        error: error?.message || String(error)
      });
    }
  }

  async applyUserLocalStore(tab) {
    if (!connection || !tab?.webContents || tab.webContents.isDestroyed()) return;
    const origin = originOf(tab.webContents.getURL());
    if (!origin || !tab.service?.id) return;
    if (tab.localStoreReloadedOrigins.has(origin)) return;

    const result = await serverRequest(
      `/api/users/local-store?serviceId=${encodeURIComponent(tab.service.id)}&origin=${encodeURIComponent(origin)}`,
      { timeoutMs: 10000 }
    );
    const items = result.store?.items || {};
    if (!Object.keys(items).length) return;

    const script = `
      (() => {
        const items = ${encodeScriptValue(items)};
        for (const [key, value] of Object.entries(items)) {
          localStorage.setItem(key, String(value));
        }
        return Object.keys(items).length;
      })()
    `;
    const appliedCount = await tab.webContents.executeJavaScript(script, true);
    if (appliedCount > 0 && !tab.localStoreReloadedOrigins.has(origin)) {
      this.recordTabActivity(tab, "local-store-download", { origin, count: appliedCount }, 0);
      tab.localStoreReloadedOrigins.add(origin);
      tab.blankRecoveryAttempts = 0;
    }
  }

  async captureUserLocalStore(tab) {
    if (!connection || !tab?.webContents || tab.webContents.isDestroyed() || !tab.service?.id) return;
    const script = `
      (() => {
        const items = {};
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key) items[key] = localStorage.getItem(key);
        }
        return { origin: location.origin, items };
      })()
    `;
    const result = await tab.webContents.executeJavaScript(script, true);
    if (!result?.origin || !result.items) return;
    const saved = await serverRequest("/api/users/local-store", {
      method: "POST",
      timeoutMs: 10000,
      body: {
        serviceId: tab.service.id,
        origin: result.origin,
        items: result.items
      }
    });
    this.recordTabActivity(tab, "local-store-upload", {
      origin: result.origin,
      count: saved?.saved || Object.keys(result.items || {}).length
    }, 15000);
  }

  applyBounds() {
    if (!this.activeTab?.view) return;
    this.setTabBounds(this.activeTab, this.bounds);
  }

  // Re-apply the service view bounds a few times after the window regains focus (alt-tab back). During the
  // restore, getContentBounds() is briefly degenerate; normalizeBounds keeps this.bounds untouched then, and
  // these staggered re-applies land once the window reports its real size — snapping the view back into the
  // card frame instead of leaving it collapsed in the top-left corner.
  reapplyBoundsBurst() {
    if (!this.activeTab?.view) return;
    for (const d of [0, 90, 240, 500]) {
      setTimeout(() => { try { if (this.activeTab?.view) this.applyBounds(); } catch { /* ignore */ } }, d);
    }
  }

  async reload() {
    const tab = this.activeTab;
    if (!tab?.webContents || tab.webContents.isDestroyed()) return this.state();
    if (tab.errorPageVisible || !tab.webContents.getURL() || tab.webContents.getURL() === "about:blank") {
      const targetUrl = fallbackUrlForService(tab.service);
      if (targetUrl) {
        tab.errorPageVisible = false;
        tab.loaded = false;
        tab.blankRecoveryAttempts = 0;
        tab.webContents.loadURL(targetUrl).catch((error) => {
          tab.lastError = error.message || "Reload failed";
        });
        return this.state();
      }
    }
    tab.webContents.reload();
    return this.state();
  }

  home() {
    this.openRequestSerial += 1;
    this.detachActiveTab();
    this.activeTab = null;
    return this.state();
  }

  stateForTab(tab) {
    const wc = tab?.webContents;
    const url = wc?.getURL() || tab?.service?.url || "";
    const lastError = tab?.lastError || "";
    return {
      tabId: tabIdFor(this.profileId, tab?.service?.id),
      profileId: this.profileId,
      serviceId: tab?.service?.id || "",
      serviceName: tab?.service?.name || "",
      url,
      title: wc?.getTitle() || "",
      loading: Boolean(wc?.isLoading()),
      loaded: Boolean(tab?.loaded),
      preparing: Boolean(tab?.preparing),
      errorPageVisible: Boolean(tab?.errorPageVisible),
      canGoBack: Boolean(wc?.canGoBack()),
      canGoForward: Boolean(wc?.canGoForward()),
      viewType: tab?.viewType || "",
      localUser: true,
      userId: currentDeviceId(),
      deviceId: currentDeviceId(),
      lastError,
      blank: !url || url === "about:blank"
    };
  }

  states() {
    return Array.from(this.tabs.values()).map((tab) => this.stateForTab(tab));
  }

  state() {
    const active = this.stateForTab(this.activeTab);
    const tabStates = this.states();
    return {
      ...active,
      activeServiceId: active.serviceId,
      openServiceIds: tabStates.map((item) => item.serviceId),
      loadedServiceIds: tabStates.filter((item) => item.loaded).map((item) => item.serviceId),
      preparingServiceIds: tabStates.filter((item) => item.preparing || (item.loading && !item.loaded)).map((item) => item.serviceId),
      tabCount: this.tabs.size,
      bounds: this.bounds
    };
  }

  emitPrepare(service, status, message) {
    this.emit("browser:prepare", {
      serviceId: service?.id || "",
      serviceName: service?.name || "Dich vu",
      status,
      message
    });
  }

  emit(channel, payload) {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }
}

// RULES-WITH-PROFILE: lift the UI rules embedded in an export snapshot into profileUiRules.
// scopeServiceId set (pool pull) → that service's entry is replaced wholesale (an empty array is
// meaningful: the manager deleted the rules, so stale ones must not survive). No scope (whole-profile
// pull) → the snapshot carries the FULL authoritative set for every granted service, so the map is
// rebuilt from scratch (services whose rules were deleted drop out). Returns the row count, or -1
// when the server predates rules-in-profile (no uiRules key → keep the /api/services fallback).
function captureProfileUiRules(snapshot, scopeServiceId = "") {
  const rows = Array.isArray(snapshot?.uiRules) ? snapshot.uiRules : null;
  if (!rows) return -1;
  if (scopeServiceId) {
    const sid = String(scopeServiceId).toLowerCase();
    // Defensive scoping: a misconfigured server (worker mode ignoring ?service=) may return the rules
    // of EVERY granted service — never file another service's rows (incl. its userScript) under this one.
    const scoped = rows.filter((row) => {
      const rowSid = String(row?.serviceId || "").toLowerCase();
      return !rowSid || rowSid === sid;
    });
    profileUiRules.set(sid, scoped);
    return scoped.length;
  }
  const grouped = new Map();
  for (const row of rows) {
    const sid = String(row?.serviceId || "").toLowerCase();
    if (!sid) continue;
    if (!grouped.has(sid)) grouped.set(sid, []);
    grouped.get(sid).push(row);
  }
  profileUiRules = grouped;
  return rows.length;
}

async function pullProfileFromServer(profileId = connection?.profileId || DEFAULT_PROFILE, options = {}) {
  const cleanProfileId = sanitizeProfileId(profileId);
  const includeStorage = options.includeStorage !== false;
  const result = await serverRequest(`/api/profile/export?profileId=${encodeURIComponent(cleanProfileId)}&includeStorage=${includeStorage ? "1" : "0"}`, {
    connection: options.connection,
    timeoutMs: includeStorage ? 60000 : 30000
  });
  const targetSession = userBrowserSession(cleanProfileId);
  const sessionKey = (options.connection || connection)?.sessionKey || "";
  let snapshot = result.snapshot || {};
  if (isEncryptedSnapshot(result.encrypted)) {
    if (!sessionKey) throw new Error("Thieu session key de giai ma profile");
    snapshot = decryptSnapshot(result.encrypted, sessionKey);
  }
  // Rules ride the profile: capture them even for stage-only pulls — rules are not cookies, applying
  // them sooner never disturbs the live session.
  captureProfileUiRules(snapshot);
  // Stage-only (live-sync): keep the newer profile in memory WITHOUT importing it into the live RAM
  // partition the user is browsing. It is applied later at a safe boundary so the active session is
  // never disturbed (no cookie re-import, no reload).
  if (options.stageOnly) {
    stagedProfileSnapshot = snapshot;
    if (Number.isFinite(Number(result.revision))) stagedProfileRevision = Number(result.revision);
    return { staged: true, revision: stagedProfileRevision, server: result.summary };
  }
  const imported = await importProfileSnapshot(targetSession, snapshot);
  if (Number.isFinite(Number(result.revision))) currentProfileRevision = Number(result.revision);
  recordClientActivity({
    serviceId: "profile-sync",
    action: "profile-download",
    title: cleanProfileId,
    details: {
      includeStorage,
      server: result.summary || null,
      imported
    }
  }).catch(() => {});
  return { server: result.summary, imported, includeStorage };
}

// POOL pull: fetch the pool profile the SERVER assigns for THIS service (export?service=<id>) and merge
// its cookies into the live partition. The server returns a snapshot already scoped to the one service and
// re-encrypted to this device's session key; importProfileSnapshot is ADDITIVE so this never disturbs the
// cookies of other services already open in the same partition.
async function pullServiceProfileFromServer(serviceId, options = {}) {
  const cleanService = String(serviceId || "").toLowerCase();
  if (!cleanService) return null;
  const includeStorage = options.includeStorage === true; // default cookies-only → fastest "logged-in" open
  const target = options.connection || connection;
  const cleanProfileId = sanitizeProfileId(target?.profileId || DEFAULT_PROFILE);
  const result = await serverRequest(
    `/api/profile/export?service=${encodeURIComponent(cleanService)}&includeStorage=${includeStorage ? "1" : "0"}`,
    { connection: options.connection, timeoutMs: includeStorage ? 60000 : 20000 }
  );
  const sessionKey = target?.sessionKey || "";
  let snapshot = result.snapshot || {};
  if (isEncryptedSnapshot(result.encrypted)) {
    if (!sessionKey) throw new Error("Thieu session key de giai ma profile");
    snapshot = decryptSnapshot(result.encrypted, sessionKey);
  }
  const uiRuleCount = captureProfileUiRules(snapshot, cleanService);
  const imported = await importProfileSnapshot(userBrowserSession(cleanProfileId), snapshot);
  // Remember what we just pulled so a warm reopen can tell whether the pool profile changed since.
  poolPullState.set(cleanService, {
    revision: Number(result.revision) || 0,
    rulesRevision: Number(result.rulesRevision) || 0,
    assignedProfile: result.assignedProfile || null
  });
  recordClientActivity({
    serviceId: "profile-sync",
    action: "service-profile-download",
    title: cleanService,
    details: { assignedProfile: result.assignedProfile || null, revision: result.revision, includeStorage, imported, uiRules: uiRuleCount }
  }).catch(() => {});
  return { assignedProfile: result.assignedProfile || null, imported, revision: result.revision, uiRules: uiRuleCount };
}

// Warm-tab refresh check (pool mode): has the pool profile for this service been re-seeded or reassigned
// since our last pull? Lightweight probe of /api/profile/revision?service=. Returns true = re-pull+reload.
// Fail-OPEN: a never-pulled service returns true (must pull); a probe error returns false (don't disrupt a
// working tab just because the probe blipped).
async function poolProfileNeedsRefresh(serviceId) {
  if (!profilePoolMode || !connection) return false;
  const cleanService = String(serviceId || "").toLowerCase();
  const prev = poolPullState.get(cleanService);
  if (!prev) return true; // never pulled in this session -> pull
  // Throttle: a rapid warm reopen/switch must not eat a network round-trip every time. Within the window we
  // assume no change (a manager re-seed still lands on the next probe after the window).
  if (prev.lastProbeAt && Date.now() - prev.lastProbeAt < POOL_PROBE_CACHE_MS) return false;
  let info;
  try {
    info = await serverRequest(`/api/profile/revision?service=${encodeURIComponent(cleanService)}`, { timeoutMs: 8000 });
  } catch {
    return false;
  }
  prev.lastProbeAt = Date.now();
  const rev = Number(info?.revision);
  const rulesRev = Number(info?.rulesRevision);
  const assigned = info?.assignedProfile || null;
  if (assigned && prev.assignedProfile && assigned !== prev.assignedProfile) return true; // pool slot reassigned
  if (Number.isFinite(rev) && rev > (Number(prev.revision) || 0)) return true;            // manager re-seeded
  if (Number.isFinite(rulesRev) && rulesRev > (Number(prev.rulesRevision) || 0)) return true; // manager changed hide/replace/custom-CSS
  return false;
}

// Apply a pre-fetched (staged) profile into the live RAM partition. Called ONLY at a safe boundary (a
// service being cold-opened / reopened / switched-with-reload) so the session the user is actively
// viewing is never disturbed mid-use.
async function applyStagedProfileIfAny(profileId = connection?.profileId || DEFAULT_PROFILE) {
  if (!stagedProfileSnapshot || stagedProfileRevision <= currentProfileRevision) return false;
  const cleanProfileId = sanitizeProfileId(profileId);
  const snapshot = stagedProfileSnapshot;
  const revision = stagedProfileRevision;
  try {
    await importProfileSnapshot(userBrowserSession(cleanProfileId), snapshot);
    currentProfileRevision = revision;
    stagedProfileSnapshot = null;
    // We just imported cookies that originated elsewhere (admin / other device). Mute our auto-push
    // briefly so we don't echo them straight back to the server and ping-pong revisions between devices.
    profilePushSuppressedUntil = Date.now() + 9000;
    recordClientActivity({ serviceId: "profile-sync", action: "profile-staged-applied", title: cleanProfileId, details: { revision } }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function pushProfileToServer(options = {}) {
  if (!connection) return null;
  // Pool-mode: the cookies in this partition are BORROWED from manager-seeded pool profiles. Never push them
  // back — that would corrupt the shared pool login and could leak one customer's session into another's.
  // Pool profiles are owned/refreshed by managers via the manager app, not by borrowers.
  if (profilePoolMode) return null;
  const cleanProfileId = sanitizeProfileId(connection.profileId || DEFAULT_PROFILE);
  const targetSession = userBrowserSession(cleanProfileId);
  const includeStorage = options.includeStorage !== false && initialStorageSyncComplete;
  const snapshot = await exportProfileSnapshot(targetSession, {
    profileId: cleanProfileId,
    services,
    includeStorage,
    scopeCookies: true
  });
  const sessionKey = connection?.sessionKey || "";
  const body = { profileId: cleanProfileId, baseRevision: currentProfileRevision };
  if (sessionKey) body.encrypted = encryptSnapshot(snapshot, sessionKey);
  else body.snapshot = snapshot;
  const uploaded = await serverRequest("/api/profile/import", {
    method: "POST",
    timeoutMs: 60000,
    body
  });
  if (Number.isFinite(Number(uploaded?.revision))) currentProfileRevision = Number(uploaded.revision);
  if (options.recordActivity !== false) {
    await recordClientActivity({
      serviceId: "profile-sync",
      action: "profile-upload",
      title: cleanProfileId,
      details: {
        includeStorage,
        reason: options.reason || "manual",
        summary: uploaded?.summary || null
      }
    });
  }
  return uploaded;
}

async function releaseProfileLock() {
  if (!connection) return;
  await serverRequest("/api/profile/release", { method: "POST", timeoutMs: 8000, body: {} }).catch(() => null);
}

function scheduleProfilePush() {
  if (!connection) return;
  if (profilePoolMode) return; // pool-mode never pushes borrowed cookies back (see pushProfileToServer)
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    // Multi-device echo guard: a push fired right after a live-sync pull would just re-upload the
    // cookies we imported from another device, bumping the revision and looping every device into a
    // reload. Skip it during the suppression window (the user's own later changes still push).
    if (Date.now() < profilePushSuppressedUntil) return;
    pushProfileToServer({ recordActivity: false, reason: "auto" }).catch(() => {});
  }, 5000);
}

async function heartbeatClientTabs() {
  if (!connection || !browserManager) return;
  for (const tabState of browserManager.states()) {
    try {
      await serverRequest("/api/user-tabs/heartbeat", {
        method: "POST",
        timeoutMs: 10000,
        body: tabState
      });
    } catch (error) {
      // ACTIVE lock-enforcement for an OPEN view: the heartbeat fires only while a service view is attached
      // (exactly the threat window). A 401 past the grace window means the token died mid-session — probe
      // lock-status and tear the view down WITH the locked message. Covers an IDLE view (reading already-
      // loaded chat, no new model request). Non-401 / in-grace errors are ignored (the 5s revision poll
      // remains the backstop). Do NOT use forceLogoutOn401 here — that routes to the generic expiry path.
      if (error && error.httpStatus === 401 && (Date.now() - connectionEstablishedAt) > AUTH_EXPIRY_GRACE_MS) {
        maybeForceLogoutIfLocked().catch(() => {});
        return;
      }
    }
  }
}

async function closeClientTabs(tabStates) {
  if (!connection || !browserManager) return;
  // Accept a pre-captured tab list so callers that close the views first (disconnectFromServer)
  // can still notify the server about the tabs that WERE open; fall back to the live list otherwise.
  const list = Array.isArray(tabStates) ? tabStates : browserManager.states();
  for (const tabState of list) {
    await serverRequest("/api/user-tabs/close", {
      method: "POST",
      timeoutMs: 10000,
      body: tabState
    }).catch(() => {});
  }
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    heartbeatClientTabs().catch(() => {});
  }, 5000);
}

function startLocalStoreBackgroundPreload(syncConnection, syncProfileId) {
  if (!browserManager || !activeConnectionMatches(syncConnection, syncProfileId)) return null;
  emitProfileSyncState({
    status: "preload-loading",
    phase: "local-store",
    profileId: syncProfileId,
    message: "Dang nap san du lieu dich vu trong nen..."
  });
  return browserManager.preloadLocalStoreForServices(services)
    .then((count) => {
      if (!activeConnectionMatches(syncConnection, syncProfileId)) return null;
      emitProfileSyncState({
        status: "preload-ready",
        phase: "local-store",
        profileId: syncProfileId,
        message: count
          ? `Da nap san localStorage cho dich vu (${count} muc).`
          : "Da kiem tra du lieu dich vu trong nen."
      });
      return count;
    })
    .catch((error) => {
      if (!activeConnectionMatches(syncConnection, syncProfileId)) return null;
      emitProfileSyncState({
        ok: false,
        status: "preload-error",
        phase: "local-store",
        profileId: syncProfileId,
        message: "Khong nap san du lieu dich vu trong nen.",
        error: error.message || String(error)
      });
      return null;
    });
}

const PROFILE_LIVE_POLL_MS = 5000;
let profileLivePollTimer = null;
let profileLiveSyncInFlight = false;

// Cheap probe of the Server's profile revision so we can detect a session the admin just loaded (via
// the loader browser) and re-sync WITHOUT restarting App User.
async function fetchServerProfileRevision(profileId = connection?.profileId || DEFAULT_PROFILE) {
  if (!connection) return null;
  const cleanProfileId = sanitizeProfileId(profileId);
  const result = await serverRequest(`/api/profile/revision?profileId=${encodeURIComponent(cleanProfileId)}`, {
    timeoutMs: 8000,
    tolerateAuthError: true
  }).catch(() => null);
  // A null result can be a locked session 401 (verify_account_token now rejects a locked account on EVERY
  // request) — probe the public lock-status and boot out WITH a clear message in <=5s, well before the
  // /api/me 12s-grace path. The probe returns locked:false for transient blips, so no false logout.
  if (!result) { maybeForceLogoutIfLocked().catch(() => {}); return null; }
  // The server piggybacks the single-device eviction flag on this 5s poll — act on it as soon as it lands.
  if (result && result.evict) handleEvictionSignal(result.evict);
  const revision = Number(result?.revision);
  return Number.isFinite(revision) ? revision : null;
}

// PRE-FETCH (stage) a newer Server profile WITHOUT touching the live session. When the admin re-loads
// data or another device pushes, we only fetch + decrypt + keep it in memory. The active service the
// customer is using is NEVER re-imported or reloaded here; the staged data is applied only at a safe
// boundary (a service being cold-opened / reopened / switched-with-reload — see applyStagedProfileIfAny).
async function syncProfileIfServerNewer() {
  if (!connection || profileLiveSyncInFlight) return { skipped: true };
  const profileId = connection.profileId || DEFAULT_PROFILE;
  // Pool-mode has no whole-account profile to stage, but we still poll the revision endpoint because the
  // server piggybacks the single-device eviction flag on it (fetchServerProfileRevision → handleEvictionSignal
  // + maybeForceLogoutIfLocked). Just don't stage/apply a whole-profile snapshot.
  if (profilePoolMode) {
    await fetchServerProfileRevision(profileId);
    return { skipped: true, pool: true };
  }
  const serverRevision = await fetchServerProfileRevision(profileId);
  const baseline = Math.max(currentProfileRevision, stagedProfileRevision);
  if (serverRevision == null || serverRevision <= baseline) {
    return { skipped: true, revision: serverRevision };
  }
  profileLiveSyncInFlight = true;
  try {
    await pullProfileFromServer(profileId, { includeStorage: false, stageOnly: true });
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Tell the UI a newer profile is staged (it may show a subtle hint). NO reload of the active view.
      mainWindow.webContents.send("profile:update-available", { revision: stagedProfileRevision });
    }
    return { skipped: false, staged: true, revision: stagedProfileRevision };
  } finally {
    profileLiveSyncInFlight = false;
  }
}

function startProfileLivePoll() {
  stopProfileLivePoll();
  profileLivePollTimer = setInterval(() => {
    syncProfileIfServerNewer().catch(() => {});
  }, PROFILE_LIVE_POLL_MS);
}

function stopProfileLivePoll() {
  if (profileLivePollTimer) {
    clearInterval(profileLivePollTimer);
    profileLivePollTimer = null;
  }
}

function startProfileBackgroundSync() {
  if (!connection) throw new Error("Server connection is not configured");

  const syncConnection = { ...connection };
  const syncProfileId = syncConnection.profileId || DEFAULT_PROFILE;
  profileInitialSyncComplete = false;
  initialStorageSyncComplete = false;

  // Pool-mode: there is NO whole-account profile to download here — each service's login arrives on demand
  // (pullServiceProfileFromServer) when the user opens it. Mark sync "ready" immediately so the open path
  // never blocks waiting for a whole-profile pull that will never happen.
  if (profilePoolMode) {
    profileInitialSyncComplete = true;
    initialStorageSyncComplete = true;
    profileInitialSyncPromise = Promise.resolve({ stale: false, profile: null });
    profileStorageSyncPromise = profileInitialSyncPromise;
    emitProfileSyncState({
      status: "profile-ready",
      phase: "profile",
      profileId: syncProfileId,
      message: "San sang. Mo dich vu de nhan profile dang nhap (pool)."
    });
    return profileInitialSyncPromise;
  }

  emitProfileSyncState({
    status: "profile-loading",
    phase: "profile",
    profileId: syncProfileId,
    message: "Dang tai cookie/profile tu Server..."
  });

  profileInitialSyncPromise = (async () => {
    const profile = await pullProfileFromServer(syncProfileId, {
      includeStorage: false,
      connection: syncConnection
    });

    if (!activeConnectionMatches(syncConnection, syncProfileId)) {
      return { stale: true, profile };
    }

    profileInitialSyncComplete = true;
    emitProfileSyncState({
      status: "profile-ready",
      phase: "profile",
      profileId: syncProfileId,
      message: "Profile da san sang. Co the mo dich vu.",
      profile
    });
    // Defer per-service localStorage preload until the user opens a service.
    // Preloading every granted service at startup makes the service list feel slow.
    return { stale: false, profile };
  })();

  profileInitialSyncPromise.catch((error) => {
    if (!activeConnectionMatches(syncConnection, syncProfileId)) return;
    profileInitialSyncComplete = false;
    emitProfileSyncState({
      ok: false,
      status: "profile-error",
      phase: "profile",
      profileId: syncProfileId,
      message: "Khong tai duoc profile tu Server.",
      error: error.message || String(error)
    });
  });

  profileStorageSyncPromise = profileInitialSyncPromise
    .then(async (initialResult) => {
      if (initialResult?.stale || !activeConnectionMatches(syncConnection, syncProfileId)) {
        return initialResult;
      }

      emitProfileSyncState({
        status: "storage-loading",
        phase: "storage",
        profileId: syncProfileId,
        message: "Cookie/profile da san sang. Dang dong bo localStorage nen..."
      });

      const backgroundProfile = await pullProfileFromServer(syncProfileId, {
        includeStorage: true,
        connection: syncConnection
      });

      if (!activeConnectionMatches(syncConnection, syncProfileId)) {
        return { stale: true, profile: initialResult.profile, backgroundProfile };
      }

      initialStorageSyncComplete = true;
      const storageCount = backgroundProfile?.imported?.storageCount || 0;
      const reloadedTabs = storageCount ? browserManager?.reloadOpenTabsAfterStorageSync() || 0 : 0;
      recordClientActivity({
        serviceId: "profile-sync",
        action: "profile-storage-download",
        title: syncProfileId,
        details: {
          storageCount,
          reloadedTabs,
          includeStorage: true
        }
      }).catch(() => {});

      const syncPayload = {
        ok: true,
        profile: backgroundProfile,
        reloadedTabs
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("profile:background-sync", syncPayload);
      }
      emitProfileSyncState({
        status: "storage-ready",
        phase: "storage",
        profileId: syncProfileId,
        message: storageCount
          ? `Da dong bo localStorage (${storageCount} muc).`
          : "Da kiem tra localStorage nen.",
        profile: backgroundProfile,
        reloadedTabs
      });
      return { stale: false, profile: initialResult.profile, backgroundProfile };
    })
    .catch((error) => {
      if (!activeConnectionMatches(syncConnection, syncProfileId) || !profileInitialSyncComplete) return null;

      const payload = {
        ok: false,
        error: error.message || String(error)
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("profile:background-sync", payload);
      }
      emitProfileSyncState({
        ok: false,
        status: "storage-error",
        phase: "storage",
        profileId: syncProfileId,
        message: "Profile da san sang, nhung localStorage nen chua dong bo xong.",
        error: payload.error
      });
      return null;
    });

  return profileInitialSyncPromise;
}

async function waitForInitialProfileSync() {
  if (profileInitialSyncComplete) return { ok: true };
  if (!profileInitialSyncPromise) {
    startProfileBackgroundSync();
  }

  emitProfileSyncState({
    status: "profile-waiting",
    phase: "profile",
    message: "Dang cho profile san sang truoc khi mo dich vu..."
  });

  const result = await profileInitialSyncPromise;
  if (result?.stale || !profileInitialSyncComplete) {
    throw new Error("Profile sync bi ngat. Hay dang nhap lai.");
  }
  return result;
}

async function waitForStorageSyncForSmoothOpen(timeoutMs = SMOOTH_OPEN_STORAGE_WAIT_MS) {
  const initial = await waitForInitialProfileSync();
  if (initialStorageSyncComplete || !profileStorageSyncPromise) return initial;

  emitProfileSyncState({
    status: "storage-waiting",
    phase: "storage",
    message: "Dang chuan bi localStorage trong nen truoc khi mo dich vu..."
  });

  await Promise.race([
    profileStorageSyncPromise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]).catch(() => null);

  return {
    ok: true,
    storageReady: initialStorageSyncComplete
  };
}

async function refreshServicesFromServer() {
  if (!connection) {
    return { config: { services } };
  }

  const serviceResult = await serverRequest("/api/services", {
    timeoutMs: 10000
  });
  const freshServices = enabledServicesFromConfig(serviceResult.config);
  // A 200 with an EMPTY/missing services list is treated as transient (server mid-warmup, JSON-fallback
  // without this user's row) — adopting it would closeServicesNotIn([]) = close EVERY open tab. Now that
  // the blocked-links watchdog calls this every tick, keep the last-known list instead of mass-closing.
  if (!freshServices.length) {
    return { config: { ...(serviceResult.config || {}), services } };
  }
  services = freshServices;
  browserManager?.closeServicesNotIn(services.map((service) => service.id));
  return {
    config: { ...(serviceResult.config || {}), services }
  };
}

async function fetchMe() {
  if (!connection) return null;
  // /api/me is the canonical auth check — the ONLY request allowed to force a logout on 401.
  return serverRequest("/api/me", { timeoutMs: 10000, forceLogoutOn401: true }).catch(() => null);
}

async function changeAccountPassword(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  const currentPassword = String(payload?.current ?? payload?.currentPassword ?? "");
  const newPassword = String(payload?.next ?? payload?.newPassword ?? "");
  if (newPassword.length < 6) throw new Error("Mat khau moi phai tu 6 ky tu tro len");
  if (newPassword === currentPassword) throw new Error("Mat khau moi phai khac mat khau hien tai");
  // No forceLogoutOn401 — a wrong current password must NOT log the user out (it returns 400 anyway).
  return serverRequest("/api/users/change-password", {
    method: "POST",
    timeoutMs: 12000,
    body: { currentPassword, newPassword }
  });
}

async function fetchPortalSummary() {
  if (!connection) return null;
  return serverRequest("/api/users/portal/summary", { timeoutMs: 10000 }).catch(() => null);
}

// --- Org self-service (org-admin) ---
async function fetchOrgStructure(payload = {}) {
  if (!connection) return null;
  return serverRequest("/api/users/org/structure", { method: "POST", timeoutMs: 12000, body: payload || {} }).catch(() => null);
}
async function orgAddDepartment(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/department", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function orgAddMember(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/member", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function orgAllocate(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/allocate", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function orgUpdateBilling(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/billing", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function orgReport(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/report", { method: "POST", timeoutMs: 15000, body: payload || {} });
}
async function orgSetEntitlement(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/set-entitlement", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function orgRemoveMember(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/remove-member", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function orgDeleteDepartment(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/department-delete", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function orgSetMemberRole(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/set-role", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function orgSetMemberLocked(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/org/set-locked", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function planMe(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/plans/me", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function planSelfDowngrade(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/plans/self-downgrade", { method: "POST", timeoutMs: 12000, body: payload || {} });
}
async function updateUserBilling(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/billing", { method: "POST", timeoutMs: 12000, body: payload || {} });
}

async function deleteAccount(payload = {}) {
  // Self-service HARD delete of the CURRENT account (server forces the userId to this token — the body is
  // ignored for targeting). Returns { ok:true, deleted:true } or, on the org-owner refusal, a 409 whose body
  // { ok:false, code:"ORG_OWNER" } is surfaced to the renderer via err.payload by the IPC handler.
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/delete-account", { method: "POST", timeoutMs: 20000, body: payload || {} });
}

async function createTopupRequest(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/portal/topup-request", {
    method: "POST",
    timeoutMs: 12000,
    body: payload || {}
  });
}

async function buyCreditWithMoney(payload = {}) {
  // Mua credit bằng ví VND: trừ VND + cộng credit nguyên tử ở dbapi. 402 = thiếu tiền.
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/money/buy-credit", { method: "POST", timeoutMs: 15000, body: payload || {} });
}

async function buyPlanWithMoney(payload = {}) {
  // Mua gói cước bằng ví VND: trừ VND + kích hoạt gói + cộng credit gói. 402 = thiếu tiền.
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/money/buy-plan", { method: "POST", timeoutMs: 15000, body: payload || {} });
}

async function createSupportTicket(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/portal/support", {
    method: "POST",
    timeoutMs: 12000,
    body: payload || {}
  });
}

async function sendLivechatMessage(payload = {}) {
  if (!connection) throw new Error("Chua dang nhap");
  return serverRequest("/api/users/portal/livechat", {
    method: "POST",
    timeoutMs: 12000,
    body: payload || {}
  });
}

function loginApiCandidates() {
  const candidates = [DEFAULT_LOGIN_API_URL];
  if (!isLoopbackServerUrl(DEFAULT_LOGIN_API_URL)) {
    candidates.push("http://127.0.0.1:19778");
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function loginApiRequest(baseUrl, payload = {}) {
  // Password login REMOVED — this client is Google-only. Backstop: never POST /api/auth/login.
  throw new Error("Password login is disabled. Use Google sign-in.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `CentriXAppUser/${APP_VERSION}`, "X-CentriX-App-Key": APP_REQUEST_KEY },
      body: JSON.stringify({
        email: String(payload.email || "").trim().toLowerCase(),
        password: String(payload.password || ""),
        deviceId: currentDeviceId(),
        deviceJkt: deviceIdentity().jkt
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    let result = {};
    try {
      result = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`Login API khong tra JSON CentriX (${response.status})`);
    }
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `Login API HTTP ${response.status}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function base64urlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Interactive Google OAuth (installed-app / loopback pattern): open the consent screen in the USER'S
// DEFAULT BROWSER, catch the redirect on a 127.0.0.1 loopback server, return the authorization code +
// PKCE verifier. The code is exchanged for an id_token by the APP SERVER (the client never holds the
// Google client secret). No embedded Electron popup — the system browser owns the Google session.
function googleOAuthInteractive() {
  const http = require("node:http");
  const codeVerifier = base64urlEncode(crypto.randomBytes(48));
  const codeChallenge = base64urlEncode(crypto.createHash("sha256").update(codeVerifier).digest());
  const stateTok = base64urlEncode(crypto.randomBytes(16));
  return new Promise((resolve, reject) => {
    let settled = false;
    let redirectUri = "";
    function cleanup() {
      try { server.close(); } catch { /* ignore */ }
    }
    function finish(fn) { if (settled) return; settled = true; cleanup(); fn(); }
    const server = http.createServer((req, res) => {
      let outcome = null;
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname !== "/") { res.writeHead(404); res.end(); return; }
        const code = u.searchParams.get("code");
        const st = u.searchParams.get("state");
        const err = u.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:48px;text-align:center'>Đăng nhập Google xong. Bạn có thể đóng cửa sổ này và quay lại CentriX.</body>");
        if (err) outcome = () => reject(new Error("Google: " + err));
        else if (!code || st !== stateTok) outcome = () => reject(new Error("OAuth state/code khong hop le"));
        else outcome = () => resolve({ code, codeVerifier, redirectUri });
      } catch (e) {
        outcome = () => reject(e);
      }
      if (outcome) finish(outcome);
    });
    server.on("error", (e) => finish(() => reject(e)));
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = `${GOOGLE_AUTH_ENDPOINT}?` + new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: stateTok,
        access_type: "online",
        prompt: "select_account"
      }).toString();
      // Open the consent screen in the USER'S DEFAULT BROWSER instead of an embedded Electron window.
      // Rationale: (1) Google blocks OAuth in embedded webviews on many flows (disallowed_useragent); the
      // system browser is the supported, robust path. (2) The 127.0.0.1 loopback redirect above is reachable
      // from any browser on THIS machine, so the code still comes back to our server. (3) prompt=select_account
      // (in the auth URL) forces a real account chooser every time, so there is no in-app popup AND no
      // stale-account pin from an app-owned cookie jar (the old bug the ephemeral partition worked around).
      // There is no window "closed" signal to detect a user cancel, so the 180s timeout is the only backstop.
      shell.openExternal(authUrl).catch((e) => finish(() => reject(e)));
    });
    setTimeout(() => finish(() => reject(new Error("Het thoi gian dang nhap Google"))), 180000);
  });
}

async function googleLoginApiRequest(baseUrl, oauth) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${baseUrl}/api/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `CentriXAppUser/${APP_VERSION}`, "X-CentriX-App-Key": APP_REQUEST_KEY },
      body: JSON.stringify({
        code: oauth.code,
        codeVerifier: oauth.codeVerifier,
        redirectUri: oauth.redirectUri,
        deviceId: currentDeviceId(),
        deviceJkt: deviceIdentity().jkt
      }),
      signal: controller.signal
    });
    const raw = await response.text();
    let result = {};
    try { result = raw ? JSON.parse(raw) : {}; } catch { const e = new Error(`Google login API khong tra JSON (${response.status})`); e.fromServer = true; throw e; }
    // A blocked / too-old version is refused right at login (the auth route is gated too). Hard-lock the app
    // NOW so the user sees the lock screen instead of a bare "update-required" login error — and the watchdog
    // (token-less health poll) then auto-unlocks the moment the admin re-allows the version.
    if (response.status === 426) { try { applyVersionLock(result, { serverUrl: baseUrl }); } catch { /* best-effort */ } }
    if (!response.ok || !result.ok) { const e = new Error(result.error || `Google login API HTTP ${response.status}`); e.fromServer = true; throw e; }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function loginWithGoogle() {
  // OAuth runs ONCE (one window). The auth code is single-use, so once a candidate's exchange succeeds we
  // commit to it; a server-side rejection is final; only a connection failure tries the next candidate.
  const oauth = await googleOAuthInteractive();
  let result = null, usedBase = null, lastError = null;
  for (const baseUrl of loginApiCandidates()) {
    try { result = await googleLoginApiRequest(baseUrl, oauth); usedBase = baseUrl; break; }
    catch (error) { lastError = error; if (error.fromServer) throw error; }
  }
  if (!result) throw new Error(connectionErrorMessage(lastError, { serverUrl: DEFAULT_LOGIN_API_URL }));
  const loginConnection = result.connection || {};
  const connectionPayload = {
    serverUrl: cleanServerUrl(loginConnection.serverUrl || usedBase),
    token: String(loginConnection.token || "").trim(),
    deviceId: String(loginConnection.deviceId || loginConnection.userId || result.account?.userId || DEFAULT_DEVICE_ID),
    profileId: sanitizeProfileId(loginConnection.profileId || result.account?.profileId || DEFAULT_PROFILE),
    sessionKey: String(loginConnection.sessionKey || ""),
    expiresAt: String(loginConnection.expiresAt || "")
  };
  try {
    const connected = await connectToServer(connectionPayload);
    return {
      ...connected,
      account: result.account || {},
      connection: {
        serverUrl: connectionPayload.serverUrl,
        deviceId: connectionPayload.deviceId,
        userId: connectionPayload.deviceId,
        profileId: connectionPayload.profileId,
        tokenType: "account"
      }
    };
  } catch (connectErr) {
    if (connectErr && connectErr.code === "DEVICE_ACTIVE") {
      pendingTakeover = { connection: connectionPayload, account: result.account || {}, email: result.account?.email || "" };
      return {
        ok: false, needTakeover: true,
        reason: connectErr.reason || "device_active",
        activeDevice: connectErr.activeDevice || null,
        graceMs: connectErr.graceMs || 5000,
        account: result.account || {}
      };
    }
    throw connectErr;
  }
}

async function loginWithAccount(payload = {}) {
  // Password login REMOVED — this client is Google-only. Use loginWithGoogle.
  throw new Error("Password login is disabled. Use Google sign-in.");
  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "");
  if (!email || !password) {
    throw new Error("Missing email or password");
  }

  let lastError = null;
  for (const baseUrl of loginApiCandidates()) {
    try {
      writeUserRuntimeLog("login-try", { baseUrl });
      const loginResult = await loginApiRequest(baseUrl, { email, password });
      writeUserRuntimeLog("login-api-ok", { baseUrl, returnedServerUrl: loginResult?.connection?.serverUrl || "", hasToken: !!(loginResult?.connection?.token) });
      const loginConnection = loginResult.connection || {};
      const connectionPayload = {
        serverUrl: cleanServerUrl(loginConnection.serverUrl || baseUrl),
        token: String(loginConnection.token || "").trim(),
        deviceId: String(loginConnection.deviceId || loginConnection.userId || loginResult.account?.userId || DEFAULT_DEVICE_ID),
        profileId: sanitizeProfileId(loginConnection.profileId || loginResult.account?.profileId || DEFAULT_PROFILE),
        sessionKey: String(loginConnection.sessionKey || "")
      };
      try {
        const connected = await connectToServer(connectionPayload);
        return {
          ...connected,
          account: loginResult.account || { email },
          connection: {
            serverUrl: connectionPayload.serverUrl,
            deviceId: connectionPayload.deviceId,
            userId: connectionPayload.deviceId,
            profileId: connectionPayload.profileId,
            tokenType: loginConnection.tokenType || "account"
          }
        };
      } catch (connectErr) {
        if (connectErr && connectErr.code === "DEVICE_ACTIVE") {
          // Credentials are valid but the account is active on another device. Stash this validated login
          // so a user-confirmed takeover can finish it, and tell the UI to show the takeover prompt.
          pendingTakeover = { connection: connectionPayload, account: loginResult.account || { email }, email };
          return {
            ok: false,
            needTakeover: true,
            reason: connectErr.reason || "device_active",
            activeDevice: connectErr.activeDevice || null,
            graceMs: connectErr.graceMs || 5000,
            account: loginResult.account || { email }
          };
        }
        throw connectErr; // other connect failures fall through to candidate fallback below
      }
    } catch (error) {
      lastError = error;
      writeUserRuntimeLog("login-candidate-failed", { baseUrl, error: String(error && error.message || error) });
    }
  }

  writeUserRuntimeLog("login-failed-all", { error: String(lastError && lastError.message || lastError) });
  throw new Error(connectionErrorMessage(lastError, { serverUrl: DEFAULT_LOGIN_API_URL }));
}

// User confirmed "đăng xuất thiết bị đang đăng nhập": evict the other device, then finish THIS login once
// the old device has released (or the server force-frees the slot after the grace period).
async function takeoverActiveDevice() {
  if (!pendingTakeover) throw new Error("Khong co phien dang cho de dang xuat thiet bi kia");
  const { connection: conn, account, email } = pendingTakeover;
  writeUserRuntimeLog("takeover-request", { profileId: conn.profileId, deviceId: conn.deviceId });
  // Ask the server to evict whatever device currently holds this account.
  await serverRequest("/api/profile/takeover", { connection: conn, method: "POST", timeoutMs: 12000, body: {} }).catch(() => null);
  // Retry the full connect until the old device releases gracefully (or the server force-frees the slot).
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    try {
      const connected = await connectToServer(conn);
      pendingTakeover = null;
      writeUserRuntimeLog("takeover-success", { profileId: conn.profileId, deviceId: conn.deviceId });
      return {
        ...connected,
        account: account || { email },
        connection: {
          serverUrl: conn.serverUrl,
          deviceId: conn.deviceId,
          userId: conn.deviceId,
          profileId: conn.profileId,
          tokenType: "account"
        }
      };
    } catch (e) {
      if (e && e.code === "DEVICE_ACTIVE") { await new Promise((r) => setTimeout(r, 1500)); continue; }
      pendingTakeover = null;
      throw e;
    }
  }
  throw new Error("Khong the dang xuat thiet bi kia (het thoi gian). Hay thu lai.");
}

// User dismissed the takeover prompt: drop the dangling session created during the blocked login.
async function cancelPendingTakeover() {
  if (!pendingTakeover) return { ok: true };
  try { await serverRequest("/api/auth/self-revoke", { connection: pendingTakeover.connection, method: "POST", timeoutMs: 6000, body: {} }); } catch { /* best-effort */ }
  pendingTakeover = null;
  return { ok: true };
}

async function connectToServer(payload = {}) {
  const nextConnection = {
    serverUrl: cleanServerUrl(payload.serverUrl),
    token: String(payload.token || "").trim(),
    profileId: sanitizeProfileId(payload.profileId || DEFAULT_PROFILE),
    deviceId: String(payload.deviceId || DEFAULT_DEVICE_ID).trim() || DEFAULT_DEVICE_ID,
    sessionKey: String(payload.sessionKey || ""),
    expiresAt: String(payload.expiresAt || "")
  };

  if (!nextConnection.serverUrl || !nextConnection.token) {
    throw new Error("Missing server URL or token");
  }
  writeUserRuntimeLog("connect-start", { serverUrl: nextConnection.serverUrl, profileId: nextConnection.profileId, deviceId: nextConnection.deviceId, hasToken: !!nextConnection.token });

  let health, serviceResult;
  try {
    [health, serviceResult] = await Promise.all([
      serverRequest("/api/health", {
        connection: nextConnection,
        timeoutMs: 15000
      }),
      serverRequest("/api/services", {
        connection: nextConnection,
        timeoutMs: 15000
      })
    ]);
  } catch (e) {
    writeUserRuntimeLog("connect-health-services-failed", { serverUrl: nextConnection.serverUrl, error: String(e && e.message || e) });
    throw e;
  }
  writeUserRuntimeLog("connect-health-services-ok", { serverUrl: nextConnection.serverUrl });

  connection = nextConnection;
  // PERSISTENT LOGIN: seal the session so the next app launch reconnects without a re-login. Cleared only on
  // explicit logout / eviction / token expiry (NOT on a plain quit). Encrypted at rest + DPoP device-bound.
  saveSession(nextConnection);
  startVersionWatchdog(connection); // proactively lock (and later auto-unlock) this session by version policy
  startAccountLockWatchdog(connection); // proactively hard-freeze if an admin locks THIS account mid-session
  startBlockedLinksWatchdog(); // enforce admin link-blocks on already-open tabs within one interval
  startReseedPoll(); // AUTO RE-SEED: soi active-tab định kỳ để bắt logout kiểu DOM-swap
  // Pool-mode is a property of the SERVER (it advertises profilePool on /api/health when it serves
  // per-service pool profiles). env override wins for emergency on/off; default = follow the server.
  profilePoolMode = process.env.CENTRIX_PROFILE_POOL === "1"
    ? true
    : process.env.CENTRIX_PROFILE_POOL === "0"
      ? false
      : (health && health.profilePool === true);
  writeUserRuntimeLog("pool-mode", { profilePoolMode, serverAdvertised: !!(health && health.profilePool) });
  // Take the profile lock. In the DEFAULT multi-device mode the server always grants it (informational
  // only — concurrent devices are allowed). It blocks here ONLY when the server runs with
  // CENTRIX_PROFILE_SINGLE_DEVICE=1, in which case a second live device fails closed below.
  const lock = await serverRequest("/api/profile/lock", { method: "POST", timeoutMs: 15000, body: {} })
    .catch((error) => ({ ok: false, error: error.message, httpStatus: error.httpStatus, payload: error.payload }));
  writeUserRuntimeLog("connect-lock", { ok: lock.ok === true, error: lock.error || "", holder: lock.holder || null, serverUrl: nextConnection.serverUrl });
  if (!lock.ok) {
    connection = null;
    // Single-active-device gate: the account is in use on another device. Surface a structured error so
    // the login flow can offer "đăng xuất thiết bị đang đăng nhập" instead of a dead-end message.
    const body = lock.payload || lock;
    const reason = body && body.reason;
    if (reason === "device_active" || reason === "takeover_pending") {
      const e = new Error("DEVICE_ACTIVE");
      e.code = "DEVICE_ACTIVE";
      e.reason = reason;
      e.activeDevice = body.activeDevice || null;
      e.graceMs = Number(body.graceMs) || 5000;
      throw e;
    }
    throw new Error("Profile dang duoc dung o thiet bi khac. Hay dong o thiet bi kia hoac nho admin thu hoi roi thu lai.");
  }
  connectionEstablishedAt = Date.now(); // start the auth grace window — tolerate transient 401s now
  currentProfileRevision = Number(lock.revision) || 0;
  services = enabledServicesFromConfig(serviceResult.config);
  browserManager?.closeServicesNotIn(services.map((service) => service.id));
  browserManager.setProfile(connection.profileId);
  resetProfileSyncState();
  recordClientActivity({
    serviceId: "client",
    action: "connect",
    title: connection.deviceId,
    details: {
      services: services.map((service) => service.id),
      profileId: connection.profileId,
      serverUrl: connection.serverUrl
    }
  }).catch(() => {});
  startHeartbeat();
  startProfileBackgroundSync();
  startProfileLivePoll();

  return {
    health,
    config: { ...(serviceResult.config || {}), services },
    profile: { pending: true, profileId: connection.profileId },
    profileSync: {
      initialReady: profileInitialSyncComplete,
      storageReady: initialStorageSyncComplete
    },
    deviceId: currentDeviceId(),
    localMode: true
  };
}

// Token expired/revoked: drop the local session WITHOUT calling the Server
// (the token is already dead) and tell the renderer to return to the login screen.
function forceLogoutOnAuthExpiry() {
  if (!connection) return;
  writeUserRuntimeLog("force-logout-auth-expiry", { profileId: connection.profileId || DEFAULT_PROFILE, deviceId: connection.deviceId || "" });
  clearSession(); // token invalid → drop the sealed persistent session so boot doesn't retry a dead token
  clearInterval(heartbeatTimer);
  clearTimeout(syncTimer);
  stopProfileLivePoll();
  const profileId = connection.profileId || DEFAULT_PROFILE;
  connection = null;
  services = [];
  resetProfileSyncState();
  try { browserManager?.closeAll(); } catch { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("connection:expired", { reason: "token-expired", profileId });
  }
}

// Probe the PUBLIC lock-status with the current token (works even AFTER the session is revoked). Only logs
// out when the account is DEFINITELY locked → a transient post-connect/tunnel 401 (locked:false) never
// false-logs-out. This makes the active-session lock message land within one 5s revision-poll cycle.
async function maybeForceLogoutIfLocked() {
  if (!connection || !connection.token) return;
  try {
    const r = await serverRequest("/api/account/lock-status", { method: "POST", timeoutMs: 6000, body: { token: connection.token }, bypassAccountLock: true });
    if (r && r.ok && r.locked) applyAccountLock(); // HARD-FREEZE (overlay + tabs down + traffic off), not a silent logout
  } catch { /* network blip / non-ok: the /api/me 401 path remains the fallback */ }
}

// The account was taken over on another device (server flags it on our revision/heartbeat poll). Log out
// GRACEFULLY: show the 5s banner, then teardown — never an abrupt cookie kill.
function handleEvictionSignal(evict) {
  if (!evict || !evict.pending || evictionInProgress || !connection) return;
  evictionInProgress = true;
  const graceMs = Math.max(1000, Number(evict.graceMs) || 5000);
  writeUserRuntimeLog("evict-signal", { graceMs, profileId: connection.profileId || DEFAULT_PROFILE });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("session:evicting", { graceMs, message: "Đang có thiết bị đăng nhập vào, sẽ logout sau 5 giây" });
  }
  setTimeout(() => { gracefulEvictLogout().catch(() => {}); }, graceMs);
}

async function gracefulEvictLogout() {
  if (!connection) { evictionInProgress = false; return; }
  const profileId = connection.profileId || DEFAULT_PROFILE;
  writeUserRuntimeLog("evict-logout", { profileId });
  // 1) Preserve cookies: final push to the server BEFORE touching the partition (no abrupt kill).
  try { await pushProfileToServer({ includeStorage: true, reason: "evicted" }); } catch { /* best-effort */ }
  // 2) Free the account's active-device slot + kill the session server-side.
  try { await releaseProfileLock(); } catch { /* best-effort */ }
  try { await serverRequest("/api/auth/self-revoke", { method: "POST", timeoutMs: 8000, body: {} }); } catch { /* best-effort */ }
  clearSession(); // evicted by another device → drop the sealed persistent session
  // 3) Tear down locally and return to the login screen.
  clearInterval(heartbeatTimer);
  clearTimeout(syncTimer);
  stopProfileLivePoll();
  try { browserManager?.closeAll(); } catch { /* ignore */ }
  try { await userBrowserSession(profileId).clearStorageData(); } catch { /* ignore */ }
  connection = null;
  services = [];
  resetProfileSyncState();
  evictionInProgress = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("connection:expired", { reason: "device-takeover", profileId });
  }
}

async function disconnectFromServer() {
  clearInterval(heartbeatTimer);
  clearTimeout(syncTimer);
  stopProfileLivePoll();
  stopVersionWatchdog();
  stopAccountLockWatchdog();
  stopBlockedLinksWatchdog();
  accountLocked = false; // leaving the session drops any account-lock freeze (a re-login re-arms the watchdog)
  clearVersionLock(); // leaving the session drops the lock UI; a still-blocked version re-locks on next connect
  // Tear down every open service view IMMEDIATELY, before the network-bound work below. The design's
  // logout() flips the renderer to the login screen synchronously, but a service view is a native
  // WebContentsView/BrowserView — an OS-level layer ABOVE the renderer DOM — so it keeps overlaying
  // (and bleeding over) the login screen until it is detached/destroyed here. Previously closeAll()
  // ran last, after pushProfileToServer (up to a 60s timeout), so the overlay lingered the whole time.
  // Snapshot the open tabs first; the profile push reads cookies/localStorage from the SESSION
  // partition via exportProfileSnapshot (its own hidden windows), not these tabs, so closing them
  // first loses no data.
  const openTabStates = browserManager ? browserManager.states() : [];
  browserManager?.closeAll();
  await pushProfileToServer({ includeStorage: initialStorageSyncComplete, reason: "disconnect" }).catch(() => null);
  await releaseProfileLock();
  await recordClientActivity({
    serviceId: "client",
    action: "disconnect",
    title: connection?.deviceId || currentDeviceId(),
    details: {
      profileId: connection?.profileId || DEFAULT_PROFILE,
      openTabs: openTabStates.map((state) => state.serviceId)
    }
  });
  await closeClientTabs(openTabStates).catch(() => null);
  // Logout = kill the server session NOW (don't wait out the 12h TTL). Must be the last token-bearing
  // call; the endpoint revokes ONLY this caller's own token (derived server-side from the request).
  await serverRequest("/api/auth/self-revoke", { method: "POST", timeoutMs: 8000, body: {} }).catch(() => null);
  clearSession(); // explicit logout → forget the sealed persistent session (next launch shows the login screen)
  // Wipe the borrowed cookies from the in-RAM partition now that the final push is done.
  try { await userBrowserSession(connection.profileId).clearStorageData(); } catch { /* ignore */ }
  connection = null;
  services = [];
  resetProfileSyncState();
  return { ok: true };
}

function serviceById(serviceId) {
  const service = services.find((item) => item.id === serviceId) || services[0];
  if (!service) throw new Error("No services loaded from server");
  return service;
}

async function serviceByIdFresh(serviceId) {
  // ACTUALLY fresh: pull the latest services from the server on open so a UI-rule / visibility change the
  // admin (or the Manager app) just saved applies on THIS open — not only after a full re-login. The old
  // code only refetched when the service was MISSING, so a cached service kept its stale (empty) uiRules
  // forever and hide/replace rules never took effect. Best-effort: fall back to the cache if refresh fails.
  if (connection) await refreshServicesFromServer().catch(() => null);
  const service = services.find((item) => item.id === serviceId) || services[0];
  if (!service) throw new Error("No services loaded from server");
  return service;
}

async function injectUserApiUiBridge() {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
  try {
    const source = await fs.promises.readFile(USER_API_UI_BRIDGE, "utf8");
    await mainWindow.webContents.executeJavaScript(`${source}\n//# sourceURL=centrix-user-api-ui-bridge.js`, true);
  } catch (error) {
    console.error("Failed to inject App User API/UI bridge:", error.message || error);
  }
}

function scheduleUserApiUiBridgeInjection() {
  for (const delayMs of [250, 900, 1800, 3200, 5200]) {
    setTimeout(injectUserApiUiBridge, delayMs);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1464,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    title: "CentriX App User",
    icon: APP_ICON,
    frame: false,
    backgroundColor: "#0e131b",
    webPreferences: {
      preload: path.join(__dirname, "remote-user-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: process.env.CX_DEVTOOLS === "1" // DEV-ONLY: bật DevTools khi chạy-từ-source (env). Production (không env) = tắt.
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);
  mainWindow.on("maximize", () => mainWindow.webContents.send("window:maximized", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window:maximized", false));
  hardenServiceWebContents(mainWindow.webContents);
  if (process.env.CX_DEVTOOLS === "1") { try { mainWindow.webContents.openDevTools({ mode: "detach" }); } catch (e) { /* dev */ } }
  browserManager = new LocalBrowserManager(mainWindow);
  // NOTE: credit deductions already reach the renderer instantly — LocalBrowserManager.emit (line ~2610)
  // forwards every event via this.window.webContents.send, so this.emit("credit:usage", …) in
  // settlePendingCharge already pushes it. The renderer's listen("credit:usage") handler does the instant
  // re-fetch + re-render. (Do NOT call browserManager.on — this class is not an EventEmitter.)
  mainWindow.webContents.on("dom-ready", scheduleUserApiUiBridgeInjection);
  mainWindow.webContents.on("did-finish-load", scheduleUserApiUiBridgeInjection);
  mainWindow.loadFile(path.join(__dirname, "remote-user", "index.html"));
  scheduleUserApiUiBridgeInjection();
  mainWindow.once("ready-to-show", () => {
    scheduleUserApiUiBridgeInjection();
    mainWindow.show();
  });
  // Refresh-on-focus: when the user brings this device's window forward, PRE-FETCH any newer profile
  // from another device into the staging buffer. It is NOT applied to the running service here — the
  // active session stays untouched; staged data lands the next time a service is opened/reloaded.
  // Cheap when nothing changed (only a revision probe).
  mainWindow.on("focus", () => {
    // Snap the service view back into its frame after alt-tab restore (getContentBounds was degenerate
    // mid-restore, which used to leave the view collapsed in the top-left corner). Safe when no service open.
    try { browserManager?.reapplyBoundsBurst?.(); } catch { /* ignore */ }
    if (!connection) return;
    syncProfileIfServerNewer().catch(() => {});
  });
}

app.whenReady().then(() => {
  app.setName(USER_USERDATA_NAME);
  app.setAppUserModelId("digital.centrix.remote-user-local");
  nativeTheme.themeSource = "system";
  installCentrixNativeMenu({
    app,
    Menu,
    BrowserWindow,
    shell,
    dialog,
    getWindow: () => mainWindow,
    appName: "CentriX AI Desktop User",
    appKind: "user",
    version: `v${APP_VERSION}`
  });
  createMainWindow();

  // PERSISTENT LOGIN: if a sealed session exists and isn't past its expiry, reconnect silently so the app
  // opens straight into the logged-in state (renderer skips the login screen on the connection:restored signal).
  // A dead/revoked token self-heals: the reconnect's /api/me 401 → forceLogoutOnAuthExpiry → back to login + clear.
  try {
    const saved = loadSession();
    const notExpired = saved && (!saved.expiresAt || Date.parse(saved.expiresAt) > Date.now() + 60000);
    if (saved && saved.token && notExpired) {
      sessionRestoring = true;
      writeUserRuntimeLog("session-restore-start", { serverUrl: saved.serverUrl, profileId: saved.profileId, hasExpiry: !!saved.expiresAt });
      connectToServer(saved)
        .then(() => { sessionRestoring = false; try { mainWindow && mainWindow.webContents.send("connection:restored", {}); } catch (e) {} writeUserRuntimeLog("session-restore-ok", {}); })
        .catch((e) => { sessionRestoring = false; clearSession(); writeUserRuntimeLog("session-restore-failed", { error: (e && e.message) || String(e) }); });
    } else if (saved) {
      clearSession(); // expired/invalid saved session → drop it
    }
  } catch (e) { sessionRestoring = false; writeUserRuntimeLog("session-restore-error", { error: (e && e.message) || String(e) }); }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", async (event) => {
  if (isQuitting || !connection) return;
  event.preventDefault();
  isQuitting = true;
  clearInterval(heartbeatTimer);
  clearTimeout(syncTimer);
  await pushProfileToServer({ includeStorage: initialStorageSyncComplete, reason: "app-quit" }).catch(() => null);
  await releaseProfileLock();
  await recordClientActivity({
    serviceId: "client",
    action: "app-quit",
    title: connection?.deviceId || currentDeviceId(),
    details: {
      profileId: connection?.profileId || DEFAULT_PROFILE
    }
  });
  await closeClientTabs().catch(() => null);
  // PERSISTENT LOGIN: do NOT self-revoke on a plain quit — the sealed session (session.bin) must stay valid so
  // the next launch reconnects without a re-login. The profile lock IS released above so the device slot frees
  // (the next boot re-takes it). Real logout / eviction / expiry revoke + clear the session elsewhere.
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Abrupt-exit hardening: a crash / OS shutdown skips before-quit, stranding the server profile lock and
// tab heartbeats until their TTLs. Best-effort, time-boxed cleanup so the server frees them promptly.
let abruptCleanupDone = false;
async function bestEffortServerCleanup(reason) {
  if (abruptCleanupDone || !connection) return;
  abruptCleanupDone = true;
  writeUserRuntimeLog("abrupt-cleanup", { reason, profileId: connection?.profileId || DEFAULT_PROFILE });
  await Promise.race([
    (async () => {
      await releaseProfileLock().catch(() => {});
      await closeClientTabs().catch(() => {});
      // PERSISTENT LOGIN: keep the token alive across a crash/OS-shutdown too — do NOT self-revoke here.
    })(),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]).catch(() => {});
}

app.on("render-process-gone", (_event, webContents, details) => {
  writeUserRuntimeLog("render-process-gone", { reason: details?.reason });
  // Only tear down when the MAIN UI died — a single service tab crashing must NOT log the user out.
  if (mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) {
    bestEffortServerCleanup("render-process-gone");
  }
});
app.on("child-process-gone", (_event, details) => {
  writeUserRuntimeLog("child-process-gone", { type: details?.type, reason: details?.reason });
});
app.on("session-end", () => {
  // Windows logoff/shutdown — limited time; fire best-effort cleanup without awaiting.
  writeUserRuntimeLog("session-end", {});
  bestEffortServerCleanup("session-end");
});
process.on("uncaughtException", (error) => {
  writeUserRuntimeLog("uncaught-exception", { error: String((error && error.message) || error) });
});
process.on("unhandledRejection", (reason) => {
  writeUserRuntimeLog("unhandled-rejection", { error: String((reason && reason.message) || reason) });
});

ipcMain.handle("window:minimize", () => { mainWindow?.minimize(); });
ipcMain.handle("window:maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle("window:close", () => { mainWindow?.close(); });
// Version-lock overlay buttons (renderer → main): open the installer download / quit the app.
ipcMain.handle("version:download", () => {
  // Forced-lock "Tải bản mới": prefer the in-app updater (download + verify + wizard) if an update is known;
  // fall back to opening the download URL in the browser (older/edge cases with no latestApp advertised).
  if (updateAvailableInfo) { downloadAndInstallUpdate().catch(() => {}); return { ok: true, inApp: true }; }
  if (versionLockDownloadUrl) shell.openExternal(versionLockDownloadUrl).catch(() => {});
  return { ok: true, url: versionLockDownloadUrl };
});
ipcMain.handle("version:quit", () => { try { app.quit(); } catch { /* ignore */ } return { ok: true }; });

// ── IN-APP AUTO-UPDATE IPC ──
ipcMain.handle("update:install", () => downloadAndInstallUpdate());
ipcMain.handle("update:cancel", () => { updateCancelRequested = true; try { updateAbortController && updateAbortController.abort(); } catch { /* ignore */ } return { ok: true }; });
ipcMain.handle("update:skip", (_e, version) => {
  const p = readUpdatePrefs();
  p.skipped = String(version || (updateAvailableInfo && updateAvailableInfo.version) || "");
  writeUpdatePrefs(p);
  updateAvailableInfo = null;
  return { ok: true, skipped: p.skipped };
});
ipcMain.handle("update:setAuto", (_e, on) => { const p = readUpdatePrefs(); p.auto = !!on; writeUpdatePrefs(p); return { ok: true, auto: p.auto }; });
ipcMain.handle("update:check", () => ({ ok: true, available: updateAvailableInfo, auto: !!readUpdatePrefs().auto }));
ipcMain.handle("version:current", () => ({ ok: true, version: APP_VERSION }));
// Kept for compatibility: any caller of account.logout gets the SAME secure logout as a normal disconnect
// (self-revoke this user's session server-side + wipe borrowed cookies + close tabs + lift any freeze).
// The account-lock overlay now drives logout via the renderer's performLogoutTeardown() → connection:disconnect.
ipcMain.handle("account:logout", () => disconnectFromServer());
ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() === true);
ipcMain.handle("window:bounds", () => mainWindow?.getBounds() || null);
ipcMain.handle("window:move-by", (_event, delta = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  const dx = Math.round(Number(delta.dx) || 0);
  const dy = Math.round(Number(delta.dy) || 0);
  if (!dx && !dy) return mainWindow.getBounds();
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + dx, y + dy, false);
  return mainWindow.getBounds();
});

// connection:login (password) REMOVED — Google-only client. Use connection:login-google.
ipcMain.handle("connection:login-google", () => loginWithGoogle());
ipcMain.handle("connection:connect", (_event, payload) => connectToServer(payload));
ipcMain.handle("connection:disconnect", () => disconnectFromServer());
ipcMain.handle("connection:takeover", () => takeoverActiveDevice());
ipcMain.handle("connection:cancel-takeover", () => cancelPendingTakeover());
// Boot auth-state probe for persistent login: the renderer calls this on startup — if main already holds a
// live connection (or is restoring one from the sealed session), the renderer unlocks the flip to the app
// screen so it skips the login form. { connected, restoring }.
ipcMain.handle("connection:state", () => ({ connected: !!connection, restoring: sessionRestoring }));
ipcMain.handle("profile:pull", async () => pullProfileFromServer(connection?.profileId || DEFAULT_PROFILE));
ipcMain.handle("profile:push", () => pushProfileToServer());
ipcMain.handle("services:list", () => ({ services }));
ipcMain.handle("services:refresh", () => refreshServicesFromServer());
ipcMain.handle("account:me", () => fetchMe());
ipcMain.handle("account:change-password", async (_event, payload = {}) => {
  try {
    await changeAccountPassword(payload);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || "Doi mat khau that bai" };
  }
});
ipcMain.handle("activity:list", (_event, payload = {}) => fetchUserActivity(payload));
ipcMain.handle("url-history:list", (_event, payload = {}) => fetchUrlHistory(payload));
ipcMain.handle("url-history:push", (_event, payload = {}) => pushUrlHistory(payload));
ipcMain.handle("portal:summary", () => fetchPortalSummary());
ipcMain.handle("portal:org-structure", (_event, payload = {}) => fetchOrgStructure(payload));
ipcMain.handle("portal:org-add-department", async (_event, payload = {}) => { try { return await orgAddDepartment(payload); } catch (e) { return { ok: false, error: e?.message || "Loi them phong ban" }; } });
ipcMain.handle("portal:org-add-member", async (_event, payload = {}) => { try { return await orgAddMember(payload); } catch (e) { return { ok: false, error: e?.message || "Loi them thanh vien" }; } });
ipcMain.handle("portal:org-allocate", async (_event, payload = {}) => { try { return await orgAllocate(payload); } catch (e) { return { ok: false, error: e?.message || "Loi phan bo" }; } });
ipcMain.handle("portal:org-update-billing", async (_event, payload = {}) => { try { return await orgUpdateBilling(payload); } catch (e) { return { ok: false, error: e?.message || "Loi luu thong tin thanh toan" }; } });
ipcMain.handle("portal:org-report", async (_event, payload = {}) => { try { return await orgReport(payload); } catch (e) { return { ok: false, error: e?.message || "Loi bao cao" }; } });
ipcMain.handle("portal:org-set-entitlement", async (_event, payload = {}) => { try { return await orgSetEntitlement(payload); } catch (e) { return { ok: false, error: e?.message || "Loi dat han muc" }; } });
ipcMain.handle("portal:org-remove-member", async (_event, payload = {}) => { try { return await orgRemoveMember(payload); } catch (e) { return { ok: false, error: e?.message || "Loi go thanh vien" }; } });
ipcMain.handle("portal:org-delete-department", async (_event, payload = {}) => { try { return await orgDeleteDepartment(payload); } catch (e) { return { ok: false, error: e?.message || "Loi xoa phong ban" }; } });
ipcMain.handle("portal:org-set-role", async (_event, payload = {}) => { try { return await orgSetMemberRole(payload); } catch (e) { return { ok: false, error: e?.message || "Loi doi vai tro" }; } });
ipcMain.handle("portal:org-set-locked", async (_event, payload = {}) => { try { return await orgSetMemberLocked(payload); } catch (e) { return { ok: false, error: e?.message || "Loi khoa thanh vien" }; } });
ipcMain.handle("portal:plan-me", async (_event, payload = {}) => { try { return await planMe(payload); } catch (e) { return { ok: false, error: e?.message || "Loi doc goi cuoc" }; } });
ipcMain.handle("portal:plan-self-downgrade", async (_event, payload = {}) => { try { return await planSelfDowngrade(payload); } catch (e) { return { ok: false, error: e?.message || "Loi ha cap goi" }; } });
ipcMain.handle("portal:update-user-billing", async (_event, payload = {}) => { try { return await updateUserBilling(payload); } catch (e) { return { ok: false, error: e?.message || "Loi luu thong tin hoa don" }; } });
ipcMain.handle("portal:delete-account", async (_event, payload = {}) => { try { return await deleteAccount(payload); } catch (e) { if (e && e.payload && typeof e.payload === "object") return e.payload; /* structured 409 refusal (ORG_OWNER) */ return { ok: false, error: e?.message || "Loi xoa tai khoan" }; } });
ipcMain.handle("portal:topup-request", (_event, payload = {}) => createTopupRequest(payload));
ipcMain.handle("portal:buy-credit-money", (_event, payload = {}) => buyCreditWithMoney(payload));
ipcMain.handle("portal:buy-plan-money", (_event, payload = {}) => buyPlanWithMoney(payload));
ipcMain.handle("portal:support-ticket", (_event, payload = {}) => createSupportTicket(payload));
ipcMain.handle("portal:livechat-send", (_event, payload = {}) => sendLivechatMessage(payload));
ipcMain.handle("browser:set-bounds", (_event, bounds) => browserManager.setBounds(bounds));
ipcMain.handle("browser:open-service", async (_event, payload = {}) => {
  if (versionLocked) return { ok: false, error: "version-locked", locked: true }; // hard-blocked while version-locked
  // Pick up a session the admin just loaded on the Server: if the Server profile is newer, PRE-FETCH
  // it into staging first. openService() then applies the staged profile only on a real (re)load, so a
  // service that's already open and stable is opened/shown without disturbing its running session.
  await syncProfileIfServerNewer().catch(() => {});
  let service;
  try {
    service = await serviceByIdFresh(payload.serviceId);
  } catch (lookupError) {
    // Main's services list can be empty/stale (cleared on session expiry) while the renderer still
    // shows it from cache — fall back to the service object the renderer sent so opening never
    // breaks with "Unknown serviceId".
    const fromRenderer = payload?.service;
    if (fromRenderer?.url && String(fromRenderer.id || "") === String(payload.serviceId || "")) {
      service = fromRenderer;
    } else {
      throw lookupError;
    }
  }
  return browserManager.openService(service, payload.bounds, { url: payload.url });
});
ipcMain.handle("browser:reload", () => browserManager.reload());
ipcMain.handle("browser:home", () => browserManager.home());
ipcMain.handle("browser:back", () => {
  const wc = browserManager.activeTab?.webContents;
  if (wc && !wc.isDestroyed() && wc.canGoBack()) wc.goBack();
  return browserManager.state();
});
ipcMain.handle("browser:forward", () => {
  const wc = browserManager.activeTab?.webContents;
  if (wc && !wc.isDestroyed() && wc.canGoForward()) wc.goForward();
  return browserManager.state();
});
ipcMain.handle("browser:state", () => browserManager.state());
