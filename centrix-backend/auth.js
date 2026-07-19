"use strict";
// CentriX Phase B backend — auth layer ported VERBATIM from remote-tabs-main.js (master | staff | account).
// No Electron. Reuses local-db (Docker) for account + staff credential verification.

const crypto = require("node:crypto");
const localDb = require("./shared/local-db");

const REQUIRE_TOKEN = process.env.CENTRIX_REMOTE_REQUIRE_TOKEN !== "0";
const STAFF_RBAC = String(process.env.CENTRIX_STAFF_RBAC || "off").toLowerCase();
const STAFF_TTL_MS = Math.max(60000, Number(process.env.CENTRIX_STAFF_TTL_MS || process.env.CENTRIX_AUTH_TTL_MS || 8 * 60 * 60 * 1000));
const COOKIE_SECURE = process.env.CENTRIX_COOKIE_SECURE === "1";

// Master token (admin). Shadow: env CENTRIX_REMOTE_TOKEN, else generate (printed at boot).
let authToken = String(process.env.CENTRIX_REMOTE_TOKEN || "").trim();
if (!authToken) authToken = crypto.randomBytes(24).toString("base64url");
function getMasterToken() { return authToken; }

// ---- token extraction (identical to App Server) ----
function headerTokenOf(req) {
  const a = String(req.headers.authorization || "");
  if (a.toLowerCase().startsWith("bearer ")) return a.slice(7).trim();
  return String(req.headers["x-centrix-token"] || "").trim();
}
function cookieTokenOf(req) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "cxsid") return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}
function headerSessionOf(req) { return String(req.headers["x-centrix-session"] || "").trim(); }
function matchesMasterToken(token) {
  if (!authToken || !token) return false;
  const a = Buffer.from(token), b = Buffer.from(authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- staff sessions (in-memory, same model; cleared on restart → re-login, owner via master) ----
function staffCookie(value, maxAgeSec) {
  return `cxsid=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${COOKIE_SECURE ? "; Secure" : ""}`;
}
function clearStaffCookie() { return "cxsid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"; }
// STATELESS signed sessions so they survive the multi-worker cluster (2026-07-08 congestion fix). An in-memory
// Map is per-process, so a session made on one worker was invisible to the next → the web admin bounced back to
// the login screen. The token is now self-contained: `stf.<base64url(payload)>.<hmac>`, verified SYNC on ANY
// worker via a shared secret (CENTRIX_STAFF_SESSION_SECRET — MUST be set + identical for every worker; falls
// back to the per-process master token when unset = single-worker only). Perms are baked at login, so a
// role/disable change applies on the staff's NEXT login (≤ STAFF_TTL_MS), not live. Legacy opaque `stf_` tokens
// still resolve via the in-memory Map (empty after restart → those users re-login once).
const SESSION_SECRET = String(process.env.CENTRIX_STAFF_SESSION_SECRET || "").trim() || authToken;
const adminSessions = new Map();     // legacy opaque tokens (pre-cluster)
const _sessionDenylist = new Map();  // stateless token → expiry, for best-effort logout within THIS worker
function _signSession(payloadStr) { return crypto.createHmac("sha256", SESSION_SECRET).update(payloadStr).digest("base64url"); }
function adminSessionGet(token) {
  if (!token) return null;
  if (token.startsWith("stf.")) {
    const dot = token.indexOf(".", 4);
    if (dot < 0) return null;
    const p = token.slice(4, dot), mac = token.slice(dot + 1);
    const expected = _signSession(p);
    const a = Buffer.from(mac), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let obj; try { obj = JSON.parse(Buffer.from(p, "base64url").toString("utf8")); } catch { return null; }
    if (!obj || Date.now() > (Number(obj.expiresAt) || 0)) return null;
    const dl = _sessionDenylist.get(token);
    if (dl && Date.now() < dl) return null;   // logged out on this worker (best-effort)
    return obj;
  }
  const s = adminSessions.get(token);          // legacy opaque token
  if (!s) return null;
  if (Date.now() > s.expiresAt) { adminSessions.delete(token); return null; }
  return s;
}
function adminSessionPut(staff) {
  const expiresAt = Date.now() + STAFF_TTL_MS;
  const p = Buffer.from(JSON.stringify({ ...staff, expiresAt }), "utf8").toString("base64url");
  return { token: `stf.${p}.${_signSession(p)}`, expiresAt };
}
function adminSessionDelete(token) {
  if (!token) return;
  adminSessions.delete(token);
  if (token.startsWith("stf.")) {           // stateless: block on this worker until it would expire anyway
    _sessionDenylist.set(token, Date.now() + STAFF_TTL_MS);
    if (_sessionDenylist.size > 5000) { const now = Date.now(); for (const [t, e] of _sessionDenylist) if (e < now) _sessionDenylist.delete(t); }
  }
}
// Role/permission/enabled change: with stateless baked-perms sessions this only clears LEGACY sessions; the
// change otherwise takes effect on the staff's next login (≤ STAFF_TTL_MS). Kept so callers don't break.
function revokeAdminSessionsFor(username) {
  const u = String(username || "").trim().toLowerCase();
  for (const [t, s] of adminSessions) if (s.username === u) adminSessions.delete(t);
}
function activeStaffUsernames() {
  const set = new Set();
  for (const s of adminSessions.values()) if (s.username) set.add(s.username);
  return Array.from(set);
}
function updateStaffSessions(username, patch) {
  const u = String(username || "").trim().toLowerCase();
  for (const [t, s] of adminSessions) {
    if (s.username !== u) continue;
    if (!patch) { adminSessions.delete(t); continue; }
    adminSessions.set(t, { ...s, ...patch });
  }
}

// ---- App-User interaction tracking (EXPORT_GATE always-on "a real client interacts before pulling") ----
// Mirrors the App Server: a login→export bot that never makes a normal request is blocked. token → lastMs.
// CLUSTER-SAFE (2026-07-10): map này vốn per-worker trong cụm 8 worker → request export rơi vào worker chưa
// từng thấy request thường của token đó bị 403 no-client-interaction NGẪU NHIÊN ("lâu lâu khách không nạp
// được profile"). Fix: broadcast dấu tương tác qua primary relay (cluster-launcher {cxRelay:1}) cho mọi worker,
// throttle 60s/token để đàn poll không thành bão IPC. Không nới lỏng gate: vẫn đòi 1 request thường đã-auth
// trong TTL — chỉ khôi phục đúng ngữ nghĩa 1-process.
const EXPORT_INTERACT_TTL_MS = Math.max(60000, Number(process.env.CENTRIX_EXPORT_INTERACT_TTL_MS || 10 * 60 * 1000));
const INTERACT_BCAST_MS = 60000;
const accountInteraction = new Map();
const _interactSent = new Map(); // token → lần broadcast cuối (throttle)
function _pruneInteract() { // chống phình: dọn dấu đã quá TTL khi map lớn
  if (accountInteraction.size < 5000) return;
  const cut = Date.now() - EXPORT_INTERACT_TTL_MS * 2;
  for (const [t, at] of accountInteraction) { if (at < cut) { accountInteraction.delete(t); _interactSent.delete(t); } }
}
function recordInteraction(token) {
  if (!token) return;
  const now = Date.now();
  accountInteraction.set(token, now);
  _pruneInteract();
  if (typeof process.send === "function" && now - (_interactSent.get(token) || 0) >= INTERACT_BCAST_MS) {
    _interactSent.set(token, now);
    try { process.send({ cxRelay: 1, type: "interact", token, at: now }); } catch { /* primary gone — bỏ qua */ }
  }
}
process.on("message", (msg) => {
  if (!msg || msg.cxRelay !== 1 || msg.type !== "interact" || !msg.token) return;
  const at = Number(msg.at) || Date.now();
  if (at > (accountInteraction.get(msg.token) || 0)) accountInteraction.set(msg.token, at);
});
function interactedWithin(token, ttlMs) {
  const at = token ? accountInteraction.get(token) : 0;
  return !!at && Date.now() - at < (ttlMs || EXPORT_INTERACT_TTL_MS);
}

// ---- resolveAuth → { kind: master|staff|account, ... } | null ----
async function resolveAuth(req, url) {
  if (!REQUIRE_TOKEN) return { kind: "master", account: null };
  const headerToken = headerTokenOf(req);
  const queryToken = String(url.searchParams.get("token") || "").trim();
  // A logged-in staff (cxsid cookie) must STAY permission-limited even if the URL carries ?token=<master>.
  // Resolve a valid staff cookie BEFORE honoring a query master token, so appending ?token=master to a
  // staff-authenticated request can never upgrade it to master (RBAC bypass). The cookie-less desktop
  // Electron admin window has no cxsid, so its ?token=master path below is unaffected. A header master
  // token (operator/back-channel, never leaked in a URL) still wins outright.
  if (matchesMasterToken(headerToken)) return { kind: "master", account: null };
  if (STAFF_RBAC !== "off") {
    const staffTok = headerToken || cookieTokenOf(req);
    if (staffTok) { const staff = adminSessionGet(staffTok); if (staff) return { kind: "staff", staff }; }
  }
  if (matchesMasterToken(queryToken)) return { kind: "master", account: null };
  if (headerToken) {
    const account = await localDb.verifyAccountToken(headerToken, headerSessionOf(req)).catch(() => null);
    if (account) return { kind: "account", account };
  }
  return null;
}

// ---- gating constants (ported verbatim) ----
const ACCOUNT_ALLOWED_PATHS = new Set([
  "/api/me", "/api/auth/self-revoke", "/api/users/change-password",
  "/api/users/org/structure", "/api/users/org/department", "/api/users/org/member",
  "/api/users/org/allocate", "/api/users/org/billing", "/api/users/org/report",
  "/api/users/org/set-entitlement", "/api/users/org/remove-member", "/api/users/billing",
  "/api/users/delete-account",
  "/api/services", "/api/profile/export", "/api/profile/revision", "/api/profile/import",
  "/api/profile/lock", "/api/profile/release", "/api/profile/takeover",
  "/api/users/local-store", "/api/users/ui-cache", "/api/users/model-usage/check", "/api/users/model-usage/release",
  "/api/users/activity", "/api/users/url-history", "/api/users/portal/summary",
  "/api/users/plans/me", "/api/users/plans/self-downgrade", "/api/users/portal/orders",
  "/api/users/portal/invoices", "/api/users/portal/support", "/api/users/portal/livechat",
  "/api/users/portal/topup-request", "/api/users/portal/org", "/api/users/money/buy-credit", "/api/users/money/buy-plan",
  "/api/user-tabs/heartbeat", "/api/user-tabs/close",
  "/api/pool/session-dead", "/api/pool/slot-cooldown",
]);
function staffCan(view, perms) { return Array.isArray(perms) && (perms.includes("*") || perms.includes(view)); }
const STAFF_CORE_GET = new Set([
  "/api/health", "/api/state", "/api/me", "/api/tabs", "/api/tunnel",
  "/api/users", "/api/services", "/api/admin/services",
  "/api/admin/summary", "/api/admin/credits/ledger", "/api/admin/model-prices", "/api/admin/portal",
  "/api/admin/livechat", "/api/admin/pool", "/api/admin/service-accounts", "/api/admin/announcement",
]);
const STAFF_CORE_ANY = new Set([
  "/api/health", "/api/state", "/api/me", "/api/tabs", "/api/auth/staff-logout", "/api/auth/staff-whoami",
  "/api/auth/staff-change-password",
]);
const STAFF_ROUTE_VIEW = {
  "/api/tunnel/start": "connection", "/api/tunnel/stop": "connection", "/api/tunnel/config": "connection",
  "/api/admin/upload-installer": "connection",
  "/api/open": "loader", "/api/navigate": "loader", "/api/back": "loader", "/api/forward": "loader",
  "/api/reload": "loader", "/api/show": "loader", "/api/hide": "loader", "/api/devtools": "loader",
  "/api/resize": "loader", "/api/click": "loader", "/api/move": "loader", "/api/wheel": "loader",
  "/api/type": "loader", "/api/key": "loader", "/api/close": "loader",
  "/api/profile/import": "loader", "/api/profile/export": "loader", "/api/profile/revision": "loader",
  "/api/profile/lock": "loader", "/api/profile/release": "loader", "/api/profile/takeover": "loader",
  "/api/service/login-status": "loader", "/api/models/observe": "loader", "/api/frame": "loader",
  "/api/admin/pool/delete-profile": "loader", "/api/admin/pool/capacity": "loader", "/api/admin/pool/clear-cooldown": "loader",
  "/api/admin/announcement": "connection",
  "/api/manager/reseed-jobs": "loader", "/api/manager/reseed-done": "loader",
  "/api/manager/vault-entry": "loader", "/api/manager/vault-status": "loader", "/api/admin/pool/reseed-now": "loader",
  "/api/admin/service-accounts/save": "loader", "/api/admin/service-accounts/delete": "loader",
  "/api/users/save": "users", "/api/users/service": "users",
  "/api/admin/credits/adjust": "users", "/api/admin/accounts/set-locked": "users", "/api/admin/accounts/delete": "users", "/api/auth/revoke": "users",
  "/api/admin/money/topup": "users", "/api/admin/money/adjust": "users",
  "/api/admin/model-prices": "pricing", "/api/users/model-policy": "pricing", "/api/users/model-usage/check": "pricing",
  "/api/users/ui-rules": "access", "/api/users/ui-rules/preview": "access", "/api/users/ui-rules/select": "access",
  "/api/users/blocked-links": "access",
  "/api/admin/plans/list": "plans", "/api/admin/plans/assign": "plans", "/api/admin/plans/access": "plans",
  "/api/admin/plans/save": "plans", "/api/admin/plans/gate": "plans", "/api/admin/plans/update-subscription": "users", "/api/admin/plans/convert-legacy": "users",
  "/api/admin/billing/approve": "billing", "/api/admin/livechat": "support",
  "/api/services/save": "services", "/api/admin/services": "services", "/api/services/reset": "services",
  "/api/local-db/reset": "settings",
  "/api/admin/staff": "roles", "/api/admin/staff/save": "roles", "/api/admin/staff/delete": "roles",
  "/api/admin/roles": "roles", "/api/admin/roles/save": "roles", "/api/admin/roles/delete": "roles",
};
const STAFF_PORTAL_SECTION_VIEW = {
  organizations: "organizations", departments: "organizations", members: "organizations",
  plans: "plans", creditPackages: "credit-packages", topupOrders: "billing", invoices: "billing",
  promotions: "promotions", supportTickets: "support", notifications: "notifications",
  manualInterventions: "manual", interventionLogs: "intervention-log", orgTransactions: "org-transactions",
  appSettings: "settings", aiIntegrations: "ai-integrations", analyticsSnapshots: "analytics",
  rolePermissions: "roles",
};
function staffRouteAllowed(method, pathname, staff) {
  const perms = (staff && staff.permissions) || [];
  if ((staff && staff.isOwner) || perms.includes("*")) return { allowed: true, view: "*" };
  const m = String(method || "GET").toUpperCase();
  if (STAFF_CORE_ANY.has(pathname)) return { allowed: true, view: "core" };
  if (m === "GET" && STAFF_CORE_GET.has(pathname)) return { allowed: true, view: "core" };
  if (pathname === "/api/admin/portal" && m === "POST") return { allowed: true, view: "portal" };
  const view = STAFF_ROUTE_VIEW[pathname] || null;
  return { allowed: view ? staffCan(view, perms) : false, view };
}

// LIVE staff permissions (fixes "role/quyền cho manager đôi lúc reset về chưa-role"): staff tokens BAKE perms
// at login, and the old in-memory refreshLiveStaffPermissions is a no-op under the cluster (stateless tokens
// aren't in the legacy Map). Re-resolve the staff's CURRENT perms from the DB per request, cached briefly PER
// WORKER, so a role/permission change (or a disable) applies within ~STAFF_PERM_TTL on EVERY worker with NO
// re-login. A transient dbapi error KEEPS the last-known perms (never drops to empty → no phantom "chưa role").
const _staffPermCache = new Map(); // username -> { perms:[], at:ms }
const STAFF_PERM_TTL_MS = Math.max(3000, Number(process.env.CENTRIX_STAFF_PERM_TTL_MS || 15000));
async function liveStaffPerms(staff) {
  const baked = (staff && Array.isArray(staff.permissions)) ? staff.permissions : [];
  if (!staff || staff.isOwner || baked.includes("*")) return baked; // owner = always full, skip the DB hit
  const username = String(staff.username || "").trim().toLowerCase();
  if (!username) return baked;
  const now = Date.now();
  const cached = _staffPermCache.get(username);
  if (cached && (now - cached.at) < STAFF_PERM_TTL_MS) return cached.perms;
  try {
    const res = await localDb.adminAccountGet(username);
    const acc = res && res.account;
    if (!acc || acc.enabled === false) { const perms = []; _staffPermCache.set(username, { perms, at: now }); return perms; } // disabled/deleted → kicked
    const perms = await localDb.adminResolvePermissions(acc); // throws on a transient dbapi error → caught below
    if (_staffPermCache.size > 2000) _staffPermCache.clear();
    _staffPermCache.set(username, { perms, at: now });
    return perms;
  } catch {
    return (cached && cached.perms) || baked; // keep last-known on a transient dbapi error, never empty
  }
}

// Central gate: resolveAuth + account-allowlist + staff-RBAC. Returns { ok, auth } or { ok:false, status, error }.
async function gate(req, url) {
  const auth = await resolveAuth(req, url);
  if (!auth) return { ok: false, status: 401, error: "Unauthorized" };
  const pathname = url.pathname;
  // Refresh baked staff perms from the DB (see liveStaffPerms) so a role/permission change applies live,
  // cluster-wide, with no re-login. Mutates auth.staff in place → every downstream who.staff check sees it.
  if (auth.kind === "staff" && auth.staff) auth.staff.permissions = await liveStaffPerms(auth.staff);
  if (auth.kind === "account" && !ACCOUNT_ALLOWED_PATHS.has(pathname)) {
    return { ok: false, status: 403, error: "Account token not allowed on this route", auth };
  }
  if (auth.kind === "staff" && STAFF_RBAC === "on") {
    const r = staffRouteAllowed(req.method, pathname, auth.staff);
    if (!r.allowed) return { ok: false, status: 403, error: `Staff missing permission: ${r.view || "(unmapped)"}`, auth };
  }
  // Every authorized NON-export account request marks interaction → the export gate then knows a real client
  // is driving the session (a bare login→export bot never trips this).
  if (auth.kind === "account" && pathname !== "/api/profile/export") recordInteraction(headerTokenOf(req));
  return { ok: true, auth };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 8 * 1024 * 1024) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

module.exports = {
  STAFF_RBAC, getMasterToken, resolveAuth, gate, readJsonBody,
  headerTokenOf, cookieTokenOf, staffCookie, clearStaffCookie,
  adminSessionPut, adminSessionGet, adminSessionDelete, revokeAdminSessionsFor,
  activeStaffUsernames, updateStaffSessions,
  recordInteraction, interactedWithin, EXPORT_INTERACT_TTL_MS,
  STAFF_PORTAL_SECTION_VIEW, staffCan,
};
