const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog } = require("electron");
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { SHARED_BROWSER_PREFIX, SERVER_CONFIG_DIR } = require("./shared/gibberish-names");
const { verifyAttest, verifyExportSig, ATTEST_SECRET_IS_DEFAULT, EXPORT_SIGN_KEY_IS_DEFAULT } = require("./shared/app-attest");
const { verifyDeviceProof } = require("./shared/dpop-verify");
const {
  readServicesConfig,
  resetServicesConfig,
  writeServicesConfig
} = require("./shared/service-store");
const {
  adjustUserCredit,
  approvePortalTopup,
  checkUserModelUsage,
  createPortalSupportTicket,
  appendLivechatMessage,
  createPortalTopupRequest,
  getAdminSummary,
  getPortalSnapshot,
  getLivechatThreads,
  getUserActivity,
  getUserCreditSummary,
  getUserLocalStore,
  getUserPortal,
  getUserUiCache,
  getUrlHistory,
  saveUrlHistory,
  loginAccountGoogle,
  processSepayWebhook,
  changeAccountPassword,
  orgStructure,
  orgAddDepartment,
  orgAddMember,
  orgAllocateCredit,
  orgUpdateBilling,
  orgReport,
  orgSetEntitlement,
  orgRemoveMember,
  orgDeleteDepartment,
  orgSetMemberRole,
  orgSetMemberLocked,
  setAccountLocked,
  accountLockStatus,
  updateUserBilling,
  adminLogin,
  adminAccountList,
  adminAccountSave,
  adminAccountDelete,
  adminRoleList,
  adminRoleUpsert,
  adminRoleDelete,
  observeModel,
  readLocalDb,
  recordUiRuleReports,
  recordUserActivity,
  resetLocalDb,
  revokeSession,
  saveUserLocalStore,
  saveUserUiCache,
  servicesForUser,
  setModelPrices,
  setPortalSection,
  plansList,
  assignUserPlan,
  setPlanAccess,
  myPlan,
  savePlan,
  selfDowngradePlan,
  setPlanGate,
  setUserModelPolicy,
  setUserServiceVisibility,
  setUserUiRules,
  upsertUser,
  verifyAccountToken
} = require("./shared/local-db");
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_TOKEN_ENDPOINT } = require("./shared/google-oauth");

// Decode a JWT payload (no signature check — used only on an id_token fetched server-to-server from
// Google's TLS token endpoint, so the source is already trusted; we still validate aud/iss/exp/verified).
function decodeJwtPayload(jwt) {
  const part = String(jwt || "").split(".")[1] || "";
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}
const {
  exportProfileSnapshot,
  importProfileSnapshot
} = require("./shared/profile-sync");
const { installCentrixNativeMenu } = require("./shared/native-menu");
const { encryptSnapshot, decryptSnapshot } = require("./shared/profile-crypto");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const HOST = process.env.CENTRIX_REMOTE_HOST || "127.0.0.1";
const PORT = Number(process.env.CENTRIX_REMOTE_TABS_PORT || process.env.CENTRIX_REMOTE_PORT || 19778);
const DEFAULT_URL = process.env.CENTRIX_REMOTE_DEFAULT_URL || "https://chat.zalo.me/";
const DEFAULT_PROFILE = "default";
const UNKNOWN_MODEL_ID = "unknown-model";
const DEFAULT_TABS = ["tab-a", "tab-b"];
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;
const REQUIRE_TOKEN = process.env.CENTRIX_REMOTE_REQUIRE_TOKEN !== "0";
const SHOW_CONTROL_WINDOW = process.env.CENTRIX_REMOTE_SHOW_CONTROL !== "0";
const SHOW_TARGET_WINDOWS = process.env.CENTRIX_REMOTE_SHOW_TARGETS === "1";
const PREOPEN_TABS = process.env.CENTRIX_REMOTE_PREOPEN_TABS !== "0";
const CONTROL_WEB_DIR = process.env.CENTRIX_REMOTE_WEB_DIR || "remote-tabs-web";
const AUTH_CONFIG_DIR = SERVER_CONFIG_DIR;
const AUTH_CONFIG_FILE = "auth.json";
const TUNNEL_CONFIG_FILE = "tunnel.json";
const DEFAULT_TUNNEL_HOSTNAME = process.env.CENTRIX_TUNNEL_HOSTNAME || "api-centrixapp.centrix.asia";
const APP_ICON = path.join(__dirname, "desktop-assets", "favicon.ico");

let controlWindow = null;
let server = null;
let authToken = "";
let tunnelProcess = null;
let tunnelConfig = {
  hostname: DEFAULT_TUNNEL_HOSTNAME,
  token: ""
};

const tabs = new Map();
const sessionProxyRules = new Map();
const observedPartitions = new Set();
const clientTabs = new Map();
const CLIENT_TAB_TTL_MS = 90 * 1000;
const execFileAsync = promisify(execFile);
const FIREWALL_RULE_NAME = `CentriX App Server ${PORT}`;
const CLOUDFLARED_EXE = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
const tunnelState = {
  supported: true,
  running: false,
  status: "stopped",
  publicUrl: "",
  candidateUrl: "",
  message: "Cloudflare Tunnel chua bat.",
  binaryPath: "",
  lastOutput: "",
  startedAt: "",
  exitedAt: "",
  mode: "quick",
  hostname: DEFAULT_TUNNEL_HOSTNAME
};
let tunnelVerificationId = 0;

function sanitizeId(value, fallback) {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80) || fallback;
}

function normalizeUrl(input) {
  const value = String(input || "").trim();
  if (!value) return DEFAULT_URL;

  try {
    return new URL(value).toString();
  } catch {
    return new URL(`https://${value}`).toString();
  }
}

function partitionForProfile(profileId) {
  return `persist:${SHARED_BROWSER_PREFIX}${sanitizeId(profileId, DEFAULT_PROFILE)}`;
}

function responseHeaders(contentType, length) {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    // Allow-Origin:* stays SAFE for the website cookie model: a browser refuses to send credentials
    // (the httpOnly SameSite=Strict cxsid cookie) on a cross-origin request when the response is "*",
    // so cross-site JS can never read authenticated data. App User (Bearer header, no cookie) keeps working.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, x-centrix-token, x-centrix-user, x-centrix-profile",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Defense-in-depth (harmless): no MIME sniffing, no referrer leak, same-origin framing only.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN"
  };

  if (length !== undefined) {
    headers["Content-Length"] = length;
  }

  return headers;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, responseHeaders("application/json; charset=utf-8", Buffer.byteLength(body)));
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, responseHeaders(contentType, Buffer.byteLength(body)));
  res.end(body);
}

function authConfigPath() {
  return path.join(app.getPath("appData"), AUTH_CONFIG_DIR, AUTH_CONFIG_FILE);
}

function tunnelConfigPath() {
  return path.join(app.getPath("appData"), AUTH_CONFIG_DIR, TUNNEL_CONFIG_FILE);
}

async function loadAuthToken() {
  if (process.env.CENTRIX_REMOTE_TOKEN) {
    authToken = String(process.env.CENTRIX_REMOTE_TOKEN).trim();
    return authToken;
  }

  const filePath = authConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed?.token) {
      authToken = String(parsed.token);
      return authToken;
    }
  } catch {
    // Create a token below when the file does not exist or is invalid.
  }

  authToken = crypto.randomBytes(24).toString("base64url");
  await fs.writeFile(
    filePath,
    JSON.stringify({ token: authToken, createdAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
  return authToken;
}

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase() || DEFAULT_TUNNEL_HOSTNAME;
}

function tunnelPublicUrlFromConfig(config = tunnelConfig) {
  return `https://${normalizeHostname(config.hostname)}`;
}

async function loadTunnelConfig() {
  const filePath = tunnelConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    tunnelConfig = {
      hostname: normalizeHostname(parsed?.hostname || DEFAULT_TUNNEL_HOSTNAME),
      token: String(parsed?.token || "")
    };
  } catch {
    tunnelConfig = {
      hostname: DEFAULT_TUNNEL_HOSTNAME,
      token: ""
    };
  }

  tunnelState.hostname = tunnelConfig.hostname;
  return tunnelConfig;
}

async function saveTunnelConfig(next = {}) {
  const hostname = normalizeHostname(next.hostname || tunnelConfig.hostname || DEFAULT_TUNNEL_HOSTNAME);
  const incomingToken = String(next.token || "").trim();
  tunnelConfig = {
    hostname,
    token: incomingToken || tunnelConfig.token || ""
  };
  tunnelState.hostname = tunnelConfig.hostname;
  await fs.mkdir(path.dirname(tunnelConfigPath()), { recursive: true });
  await fs.writeFile(
    tunnelConfigPath(),
    JSON.stringify({ hostname: tunnelConfig.hostname, token: tunnelConfig.token }, null, 2),
    "utf8"
  );
  return tunnelConfig;
}

function publicTunnelConfigSnapshot() {
  return {
    hostname: tunnelConfig.hostname || DEFAULT_TUNNEL_HOSTNAME,
    publicUrl: tunnelPublicUrlFromConfig(),
    hasToken: Boolean(tunnelConfig.token)
  };
}

// Paths an App User (account token) may reach. Everything else under /api/ is
// master-token only (admin). This is a server-side allowlist: an account token
// cannot touch admin routes (credit adjust, model-policy, full DB dump, tunnel,
// tab control, ...) no matter what the client sends.
const ACCOUNT_ALLOWED_PATHS = new Set([
  "/api/me",
  "/api/auth/self-revoke",
  "/api/users/change-password",
  "/api/users/org/structure",
  "/api/users/org/department",
  "/api/users/org/member",
  "/api/users/org/allocate",
  "/api/users/org/billing",
  "/api/users/org/report",
  "/api/users/org/set-entitlement",
  "/api/users/org/remove-member",
  "/api/users/billing",
  "/api/services",
  "/api/profile/export",
  "/api/profile/revision",
  "/api/profile/import",
  "/api/profile/lock",
  "/api/profile/release",
  "/api/profile/takeover",
  "/api/users/local-store",
  "/api/users/ui-cache",
  "/api/users/model-usage/check",
  "/api/users/activity",
  "/api/users/url-history",
  "/api/users/portal/summary",
  "/api/users/plans/me",
  "/api/users/plans/self-downgrade",
  "/api/users/portal/orders",
  "/api/users/portal/invoices",
  "/api/users/portal/support",
  "/api/users/portal/livechat",
  "/api/users/portal/topup-request",
  "/api/users/portal/org",
  "/api/user-tabs/heartbeat",
  "/api/user-tabs/close"
]);

function headerTokenOf(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return String(req.headers["x-centrix-token"] || "").trim();
}

// WEBSITE cookie auth: the staff session token delivered as an httpOnly cookie (cxsid). The browser sends
// it automatically on same-origin requests, so the SPA never reads/stores the token (XSS-safe) and the
// token never appears in a URL/referrer/log (unlike the legacy master ?token=).
function cookieTokenOf(req) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "cxsid") return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

// The per-session proof key an App User presents alongside its bearer token (see CENTRIX_BIND_SESSION_KEY).
function headerSessionOf(req) {
  return String(req.headers["x-centrix-session"] || "").trim();
}

function matchesMasterToken(token) {
  if (!authToken || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns { kind: "master" | "account", account } for a valid caller, or null.
// Master token may arrive via header OR query (the local admin UI + frame <img>
// need ?token=). Account tokens are accepted ONLY from the header, so a user
// token never leaks into a URL / referrer / access log.
async function resolveAuth(req, reqUrl) {
  if (!REQUIRE_TOKEN) return { kind: "master", account: null };
  const headerToken = headerTokenOf(req);
  const queryToken = String(reqUrl.searchParams.get("token") || "").trim();
  // A logged-in staff (cxsid cookie) must STAY permission-limited even if the URL carries ?token=<master>.
  // Resolve a valid staff cookie BEFORE honoring a query master token, so appending ?token=master to a
  // staff-authenticated request can never upgrade it to master (RBAC bypass). The cookie-less desktop admin
  // window has no cxsid, so its ?token= path is unaffected; a header master token still wins outright.
  if (matchesMasterToken(headerToken)) {
    return { kind: "master", account: null };
  }
  // Staff (admin-console) session — from the httpOnly cookie (website) OR the Authorization header
  // (legacy/desktop). Never from ?token=, so it can't leak into a URL/referrer/log. Checked before the
  // account path so a staff token skips the Docker /auth/token round-trip.
  if (STAFF_RBAC !== "off") {
    const staffTok = headerToken || cookieTokenOf(req);
    if (staffTok) {
      const staff = adminSessionGet(staffTok);
      if (staff) return { kind: "staff", staff };
    }
  }
  if (matchesMasterToken(queryToken)) {
    return { kind: "master", account: null };
  }
  if (headerToken) {
    const account = await verifyAccountToken(headerToken, headerSessionOf(req)).catch(() => null);
    if (account) return { kind: "account", account };
  }
  return null;
}

async function isAuthorized(req, reqUrl) {
  return Boolean(await resolveAuth(req, reqUrl));
}

// Simple in-memory sliding-window rate limiter (per server process) for the
// sensitive endpoints. Keyed by client IP + route.
const rateBuckets = new Map();
function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress || "unknown";
}
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return false;
}
const RATE_LIMITS = {
  // "/api/auth/login" removed — endpoint hard-disabled (410) for the security test; re-add when re-enabling.
  "/api/profile/export": [15, 60000],
  "/api/profile/import": [30, 60000],
  "/api/users/change-password": [5, 60000]
};
// Per-DEVICE rate limits at the ORIGIN — Cloudflare Pro edge can only count by IP (a stolen token
// replayed from many IPs slips the edge). These cap sensitive endpoints per device+account.
const DEVICE_RATE_LIMITS = {
  "/api/profile/export": [10, 60000],
  "/api/users/change-password": [5, 60000]
};

// ── App Server staff RBAC (admin-console accounts/roles) ─────────────────────────────────────────
// Flag CENTRIX_STAFF_RBAC: off (today: master auto-login, no staff login, every view visible) | log
// (staff login on, authorization computed and LOGGED but never blocks) | on (staff login on, authz
// ENFORCED: sidebar hidden + routes 403). Master token is always full; an Owner staff role is full.
const STAFF_RBAC = String(process.env.CENTRIX_STAFF_RBAC || "off").toLowerCase();
const STAFF_TTL_MS = Math.max(60000, Number(process.env.CENTRIX_STAFF_TTL_MS || process.env.CENTRIX_AUTH_TTL_MS || 8 * 60 * 60 * 1000));
// WEBSITE cookie: deliver the staff session token as an httpOnly cookie. Add Secure when served over
// HTTPS (set CENTRIX_COOKIE_SECURE=1 behind the Cloudflare tunnel; omit for plain-localhost dev).
const COOKIE_SECURE = process.env.CENTRIX_COOKIE_SECURE === "1";
function staffCookie(value, maxAgeSec) {
  return `cxsid=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${COOKIE_SECURE ? "; Secure" : ""}`;
}
// In-memory admin-console sessions (Node-managed; cleared on restart → staff re-login, owner recovers
// via master token). token -> { username, displayName, role, isOwner, permissions:[...], expiresAt }.
const adminSessions = new Map();
function adminSessionGet(token) {
  const s = token ? adminSessions.get(token) : null;
  if (!s) return null;
  if (Date.now() > s.expiresAt) { adminSessions.delete(token); return null; }
  return s;
}
function revokeAdminSessionsFor(username) {
  const u = String(username || "").trim().toLowerCase();
  for (const [t, s] of adminSessions) if (s.username === u) adminSessions.delete(t);
}
function staffCan(view, perms) {
  return Array.isArray(perms) && (perms.includes("*") || perms.includes(view));
}
// Reads that power the admin shell are CORE (any logged-in staff may call them; the SIDEBAR hides which
// views a role can navigate to). The write/control surface is gated per view key. An unmapped /api/*
// route is DENY for staff in `on` (default-deny). Master/owner bypass the whole map.
const STAFF_CORE_GET = new Set([
  "/api/health", "/api/state", "/api/me", "/api/tabs", "/api/tunnel",
  "/api/users", "/api/services", "/api/admin/services",
  "/api/admin/summary", "/api/admin/credits/ledger", "/api/admin/model-prices", "/api/admin/portal",
  "/api/admin/livechat"
]);
const STAFF_CORE_ANY = new Set([
  "/api/health", "/api/state", "/api/me", "/api/tabs", "/api/auth/staff-logout", "/api/auth/staff-whoami"
]);
const STAFF_ROUTE_VIEW = {
  "/api/tunnel/start": "connection", "/api/tunnel/stop": "connection", "/api/tunnel/config": "connection",
  "/api/open": "loader", "/api/navigate": "loader", "/api/back": "loader", "/api/forward": "loader",
  "/api/reload": "loader", "/api/show": "loader", "/api/hide": "loader", "/api/devtools": "loader",
  "/api/resize": "loader", "/api/click": "loader", "/api/move": "loader", "/api/wheel": "loader",
  "/api/type": "loader", "/api/key": "loader", "/api/close": "loader",
  "/api/profile/import": "loader", "/api/profile/export": "loader", "/api/profile/revision": "loader",
  "/api/profile/lock": "loader", "/api/profile/release": "loader", "/api/profile/takeover": "loader",
  "/api/service/login-status": "loader",
  "/api/models/observe": "loader",
  "/api/users/save": "users", "/api/users/service": "users",
  "/api/admin/credits/adjust": "users", "/api/admin/accounts/set-locked": "users", "/api/auth/revoke": "users",
  "/api/admin/model-prices": "pricing", "/api/users/model-policy": "pricing", "/api/users/model-usage/check": "pricing",
  "/api/users/ui-rules": "access", "/api/users/ui-rules/preview": "access", "/api/users/ui-rules/select": "access",
  "/api/admin/plans/list": "plans", "/api/admin/plans/assign": "plans", "/api/admin/plans/access": "plans",
  "/api/admin/plans/save": "plans", "/api/admin/plans/gate": "plans",
  "/api/admin/billing/approve": "billing",
  "/api/admin/livechat": "support",
  "/api/services/save": "services", "/api/admin/services": "services", "/api/services/reset": "services",
  "/api/local-db/reset": "settings",
  "/api/admin/staff": "roles", "/api/admin/staff/save": "roles", "/api/admin/staff/delete": "roles",
  "/api/admin/roles": "roles", "/api/admin/roles/save": "roles", "/api/admin/roles/delete": "roles"
};
// POST /api/admin/portal handles all portal sections through one route → sub-gate by body.section.
const STAFF_PORTAL_SECTION_VIEW = {
  organizations: "organizations", departments: "organizations", members: "organizations",
  plans: "plans", creditPackages: "credit-packages", topupOrders: "billing", invoices: "billing",
  promotions: "promotions", supportTickets: "support", notifications: "notifications",
  manualInterventions: "manual", interventionLogs: "intervention-log", orgTransactions: "org-transactions",
  appSettings: "settings", aiIntegrations: "ai-integrations", analyticsSnapshots: "analytics",
  rolePermissions: "roles"
};
// Returns { allowed, view } for a staff caller. Owner/"*" → always allowed.
function staffRouteAllowed(method, pathname, staff) {
  const perms = (staff && staff.permissions) || [];
  if ((staff && staff.isOwner) || perms.includes("*")) return { allowed: true, view: "*" };
  const m = String(method || "GET").toUpperCase();
  if (STAFF_CORE_ANY.has(pathname)) return { allowed: true, view: "core" };
  if (m === "GET" && STAFF_CORE_GET.has(pathname)) return { allowed: true, view: "core" };
  if (pathname === "/api/admin/portal" && m === "POST") return { allowed: true, view: "portal" }; // section sub-gated in handler
  const view = STAFF_ROUTE_VIEW[pathname] || null;
  return { allowed: view ? staffCan(view, perms) : false, view };
}

// Profile lock + revision (server is the single profile owner). One device may
// hold a profile at a time; a lock goes stale if its heartbeat stops; pushes
// require the lock and a matching base revision (anti-overwrite); the previous
// snapshot is backed up before each overwrite.
const PROFILE_LOCK_TTL_MS = Math.max(1000, Number(process.env.CENTRIX_PROFILE_LOCK_TTL_MS || 30000));
// Multi-device by default: any number of devices may log in + use the same account/profile at once.
// Set CENTRIX_PROFILE_SINGLE_DEVICE=1 to restore the old exclusive "one device at a time" lock.
const PROFILE_SINGLE_DEVICE = process.env.CENTRIX_PROFILE_SINGLE_DEVICE === "1";
const PROFILE_BACKUP_KEEP = 3;
// Admin/master profile snapshots: by default the master token may NOT pull/push cookies in PLAINTEXT
// over the wire. Provide a 32-byte base64 key to encrypt them, or explicitly opt into plaintext.
const MASTER_SNAPSHOT_KEY = String(process.env.CENTRIX_MASTER_SNAPSHOT_KEY || "").trim();
const ALLOW_PLAINTEXT_SNAPSHOT = process.env.CENTRIX_ALLOW_PLAINTEXT_SNAPSHOT === "1";
const profileLocks = new Map();      // profileId -> { deviceId, userId, lockedAt, lastBeat }
const profileRevisions = new Map();  // profileId -> integer
const profileBackups = new Map();    // profileId -> [{ revision, at, snapshot }]
const sessionFirstIp = new Map();    // token -> first IP seen
const reportedIpMismatch = new Set();// `${token}:${ip}` already warned
const profileCookieBumpTimers = new Map();    // profileId -> debounce timer for custodian cookie changes
const profileImportSuppressUntil = new Map(); // profileId -> ts until which cookie-driven bumps are ignored
const watchedCookieSessions = new WeakSet();  // custodian sessions already watched
const COOKIE_BUMP_DEBOUNCE_MS = 2000;

// --- Export hard-gate (CentriX-BaoMat-ShipCookie, Layer 6 / P0) ---
// A real App User ALWAYS interacts (health/services handshake, revision poll, heartbeat) before pulling
// /api/profile/export. A naive harvester (login -> export, nothing else) does not. Gate export on
// "this token interacted with a non-export endpoint recently". Safe for every real client (incl. old
// builds); blocks the demonstrated centrix-pull-cookies.js bot. Strict mode additionally denies on a
// high composite risk score — enable only after all clients send the CentriX User-Agent.
const accountSessionState = new Map(); // token -> { loginAt, interactedAt, ua, lastSeen }
const EXPORT_GATE = process.env.CENTRIX_EXPORT_GATE !== "0";            // default ON
const EXPORT_GATE_STRICT = process.env.CENTRIX_EXPORT_GATE === "strict";
// Hard-require the X-CentriX-Sig anti-replay signature on export. Default OFF (the signature is a risk
// SIGNAL until every device ships it); flip CENTRIX_EXPORT_REQUIRE_SIG=1 after all clients are updated.
const EXPORT_REQUIRE_SIG = process.env.CENTRIX_EXPORT_REQUIRE_SIG === "1";
// SECURITY (M5): refuse to pretend the attest/sig gate is real while it is verified with the shipped public
// default key (forgeable by anyone who unpacks the app). Warn loudly at boot; hard-fail only when the
// operator opts in with CENTRIX_REQUIRE_ROTATED_KEYS=1 (so an in-place deploy isn't taken down before keys
// are rotated + a matching client is shipped).
(function guardDefaultSecurityKeys() {
  const problems = [];
  if (EXPORT_REQUIRE_SIG && EXPORT_SIGN_KEY_IS_DEFAULT) problems.push("CENTRIX_EXPORT_REQUIRE_SIG=1 but CENTRIX_EXPORT_SIGN_KEY is the shipped default");
  if (EXPORT_GATE_STRICT && ATTEST_SECRET_IS_DEFAULT) problems.push("CENTRIX_EXPORT_GATE=strict but CENTRIX_APP_ATTEST_SECRET is the shipped default");
  for (const p of problems) console.error(`[SECURITY] ${p} — the check is verified with a PUBLIC key (forgeable). Rotate the key (server + client build).`);
  if (problems.length && process.env.CENTRIX_REQUIRE_ROTATED_KEYS === "1") { console.error("[SECURITY] CENTRIX_REQUIRE_ROTATED_KEYS=1 → refusing to boot with default enforcement keys."); process.exit(1); }
})();
// DPoP device-binding (CentriX-KeyHardening §3). Default OFF = LOG-ONLY (verify + log, never reject) so a
// staged rollout can't lock out live clients. Set CENTRIX_BIND_DEVICE_KEY=1 to ENFORCE on export (block a
// bad/absent proof) — only after all clients ship the device key. Sessions with no bound jkt are grandfathered.
const BIND_DEVICE_KEY = process.env.CENTRIX_BIND_DEVICE_KEY === "1";
const EXPORT_INTERACT_TTL_MS = 600000; // an export must follow a real interaction within 10 min
function sessState(token, create = false) {
  const tk = String(token || "");
  if (!tk) return null;
  let s = accountSessionState.get(tk);
  if (!s && create) {
    if (accountSessionState.size > 20000) accountSessionState.clear();
    s = {}; accountSessionState.set(tk, s);
  }
  return s || null;
}
function uaIsScript(ua) { return /\b(node|undici|python|curl|axios|go-http|okhttp|wget|libwww|httpx|java)\b/i.test(String(ua || "")); }
function uaIsClient(ua) { return /CentriXAppUser\/\d|Electron\/\d/i.test(String(ua || "")); }
const knownDevices = new Map(); // userId -> Set(deviceId) seen this server run (Layer 3 "new device" signal)
function isDeviceNew(userId, deviceId) {
  const u = String(userId || ""); const d = String(deviceId || "");
  if (!u || !d) return false;
  let set = knownDevices.get(u);
  if (!set) { if (knownDevices.size > 20000) knownDevices.clear(); set = new Set(); knownDevices.set(u, set); }
  if (set.has(d)) return false;
  set.add(d); return true;
}
function exportRiskScore(s, ua, extra = {}) {
  let score = 0;
  if (!s || !s.interactedAt) score += 30;                                       // login -> export, no other interaction
  if (uaIsScript(ua) || !uaIsClient(ua)) score += 30;                           // not the CentriX client UA
  if (!extra.attestOk) score += 30;                                             // Layer 1.3: attestation missing/invalid
  if (s && s.loginAt && Date.now() - s.loginAt < 3000) score += 20;            // export too soon after login
  if (s && s.interactedAt && Date.now() - s.interactedAt > 60000) score += 15; // stale interaction
  if (extra.deviceNew) score += 15;                                            // Layer 3: unseen device
  if (extra.ipChanged) score += 20;                                            // Layer 3: IP changed mid-session
  if (extra.sigOk === false) score += 25;                                      // export anti-replay signature missing/invalid
  return score;
}

// Warn (audit) when a session token is used from an IP different from the first
// one seen — a sign a token may have been copied to another machine.
const SESSION_IP_MAX = 20000;
function trackSessionIp(token, ip, account) {
  if (!token || !ip) return;
  // Bound memory: drop the oldest tracking state if the maps grow too large.
  if (sessionFirstIp.size > SESSION_IP_MAX) sessionFirstIp.clear();
  if (reportedIpMismatch.size > SESSION_IP_MAX) reportedIpMismatch.clear();
  const first = sessionFirstIp.get(token);
  if (!first) {
    sessionFirstIp.set(token, ip);
    return;
  }
  if (first === ip) return;
  const pairKey = `${token}:${ip}`;
  if (reportedIpMismatch.has(pairKey)) return;
  reportedIpMismatch.add(pairKey);
  recordUserActivity({
    userId: account?.userId || "local-user",
    deviceId: account?.deviceId || "device",
    profileId: account?.profileId || DEFAULT_PROFILE,
    serviceId: "auth",
    action: "token-ip-mismatch",
    title: "Token dung tu IP khac",
    details: JSON.stringify({ firstIp: first, ip })
  }).catch(() => {});
}

function profileRevision(profileId) {
  return profileRevisions.get(profileId) || 0;
}
function lockIsStale(lock) {
  return !lock || (Date.now() - lock.lastBeat) > PROFILE_LOCK_TTL_MS;
}
function lockHeldBy(profileId, deviceId) {
  const lock = profileLocks.get(profileId);
  return Boolean(lock && !lockIsStale(lock) && lock.deviceId === deviceId);
}
function acquireProfileLock(profileId, deviceId, userId) {
  const lock = profileLocks.get(profileId);
  // Only block another device when single-device mode is explicitly forced. In multi-device mode the
  // shared profile is usable by every device at once; we just record the latest holder for info.
  if (PROFILE_SINGLE_DEVICE && lock && !lockIsStale(lock) && lock.deviceId !== deviceId) {
    return { ok: false, holder: { deviceId: lock.deviceId, lockedAt: lock.lockedAt } };
  }
  profileLocks.set(profileId, {
    deviceId,
    userId,
    lockedAt: lock && lock.deviceId === deviceId ? lock.lockedAt : new Date().toISOString(),
    lastBeat: Date.now()
  });
  return { ok: true, revision: profileRevision(profileId), lockTtlMs: PROFILE_LOCK_TTL_MS };
}
function renewProfileLock(profileId, deviceId) {
  const lock = profileLocks.get(profileId);
  if (lock && lock.deviceId === deviceId) {
    lock.lastBeat = Date.now();
    return true;
  }
  return false;
}
function releaseProfileLock(profileId, deviceId) {
  const lock = profileLocks.get(profileId);
  if (lock && lock.deviceId === deviceId) {
    profileLocks.delete(profileId);
    return true;
  }
  return false;
}

// --- Single ACTIVE DEVICE per ACCOUNT (userId), with graceful takeover ---
// Default ON. A 2nd live device logging into the SAME account is refused at /api/profile/lock with a
// takeover-able reason. The user can evict the other device; the evicted device gets a short grace to
// push its cookies and log out cleanly (no abrupt cookie kill). Set CENTRIX_ACCOUNT_SINGLE_DEVICE=0 off.
const ACCOUNT_SINGLE_DEVICE = process.env.CENTRIX_ACCOUNT_SINGLE_DEVICE !== "0";
const ACTIVE_DEVICE_TTL_MS = Math.max(15000, Number(process.env.CENTRIX_ACTIVE_DEVICE_TTL_MS || 35000)); // holder is "live" if seen within this window
const TAKEOVER_GRACE_MS = Math.max(1000, Number(process.env.CENTRIX_TAKEOVER_GRACE_MS || 5000));          // countdown shown on the evicted device
const TAKEOVER_FORCE_MS = TAKEOVER_GRACE_MS + 4000;                                                        // if the old device never complies, force the slot free
const activeDevices = new Map(); // userId -> { deviceId, token, profileId, since, lastBeat, evictAt, evictBy }

function activeRecLive(rec) {
  return Boolean(rec && (Date.now() - rec.lastBeat) < ACTIVE_DEVICE_TTL_MS);
}
function setActiveHolder(userId, deviceId, token, profileId) {
  activeDevices.set(String(userId), { deviceId: String(deviceId), token: String(token || ""), profileId: String(profileId || ""), since: Date.now(), lastBeat: Date.now(), evictAt: 0, evictBy: "" });
}
// Connect-time gate. Returns { ok:true } when this device may own the account, else a takeover-able reason.
function claimActiveDevice(userId, deviceId, token, profileId) {
  const uid = String(userId || ""); const dev = String(deviceId || "");
  if (!ACCOUNT_SINGLE_DEVICE || !uid || !dev) {
    if (uid && dev) setActiveHolder(uid, dev, token, profileId);
    return { ok: true };
  }
  const rec = activeDevices.get(uid);
  // Free / stale / same device -> grant and become the holder.
  if (!rec || rec.deviceId === dev || !activeRecLive(rec)) {
    setActiveHolder(uid, dev, token, profileId);
    return { ok: true };
  }
  // A different live device holds this account.
  if (rec.evictAt && rec.evictBy === dev) {
    // We already requested the takeover. If the old device has had its full grace+slack and still hasn't
    // left (offline / non-compliant), force the slot free AND revoke its token so it cannot keep going.
    if (Date.now() - rec.evictAt > TAKEOVER_FORCE_MS) {
      if (rec.token) { try { revokeSession({ token: rec.token }).catch(() => {}); } catch { /* best-effort */ } }
      setActiveHolder(uid, dev, token, profileId);
      return { ok: true };
    }
    return { ok: false, reason: "takeover_pending", graceMs: TAKEOVER_GRACE_MS };
  }
  return { ok: false, reason: "device_active", activeDevice: { deviceId: rec.deviceId, since: rec.since, lastBeat: rec.lastBeat } };
}
// Evicted-device discovery: the current holder learns it is being kicked on its next poll/heartbeat.
function evictionStatusFor(userId, deviceId) {
  const rec = activeDevices.get(String(userId || ""));
  if (!rec || rec.deviceId !== String(deviceId || "") || !rec.evictAt) return null;
  return { pending: true, graceMs: TAKEOVER_GRACE_MS, sinceMs: Date.now() - rec.evictAt };
}
// A second device asks to evict the current holder. Soft mark only (holder stays valid during grace).
function requestAccountTakeover(userId, newDeviceId) {
  const uid = String(userId || ""); const dev = String(newDeviceId || "");
  const rec = activeDevices.get(uid);
  if (!rec || rec.deviceId === dev || !activeRecLive(rec)) return { ok: true, evicting: false };
  if (!rec.evictAt) { rec.evictAt = Date.now(); rec.evictBy = dev; }
  return { ok: true, evicting: true, graceMs: TAKEOVER_GRACE_MS };
}
// Keep the holder "live" on any authenticated request (only the actual holder bumps its own beat).
function refreshActiveDevice(userId, deviceId) {
  const rec = activeDevices.get(String(userId || ""));
  if (rec && rec.deviceId === String(deviceId || "")) rec.lastBeat = Date.now();
}
function clearActiveDeviceIfHolder(userId, deviceId) {
  const uid = String(userId || ""); const rec = activeDevices.get(uid);
  if (rec && rec.deviceId === String(deviceId || "")) { activeDevices.delete(uid); return true; }
  return false;
}
function pushProfileBackup(profileId, snapshot) {
  const list = profileBackups.get(profileId) || [];
  list.push({ revision: profileRevision(profileId), at: new Date().toISOString(), snapshot });
  profileBackups.set(profileId, list.slice(-PROFILE_BACKUP_KEEP));
}

// Revisions persist across Server restarts so a restart can't reset them to 0 and
// then accept a stale push. (Locks stay in-memory — sessions reconnect anyway.)
function revisionConfigPath() {
  return path.join(app.getPath("appData"), AUTH_CONFIG_DIR, "profile-revisions.json");
}
async function loadProfileRevisions() {
  try {
    const data = JSON.parse(await fs.readFile(revisionConfigPath(), "utf8"));
    for (const [pid, rev] of Object.entries(data || {})) {
      const n = Number(rev);
      if (Number.isFinite(n) && n >= 0) profileRevisions.set(pid, Math.floor(n));
    }
  } catch {
    // no revisions file yet
  }
}
async function saveProfileRevisions() {
  try {
    const file = revisionConfigPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(Object.fromEntries(profileRevisions), null, 2), "utf8");
  } catch {
    // best-effort
  }
}

// Live profile updates: when the admin (loader browser) logs into / refreshes a service ON THE SERVER,
// Chromium writes the cookies straight into the custodian partition (NOT via /api/profile/import), so
// the revision never moved and logged-in App Users only picked it up after a re-login. We now watch the
// custodian session's cookies and bump the revision (debounced) on any change, so the App User live-poll
// pulls + reloads automatically — no logout/login. Changes caused by a server-side import are suppressed
// (that path bumps the revision itself; self-bumping would make the pushing device reload its own push).
function scheduleCustodianRevisionBump(profileId) {
  const pid = sanitizeId(profileId, DEFAULT_PROFILE);
  // Throttle (NOT trailing-debounce): the FIRST cookie change schedules a bump COOKIE_BUMP_DEBOUNCE_MS
  // later; further changes within that window are coalesced (timer NOT reset), so a chatty page that
  // keeps writing cookies still gets a bump within the window instead of deferring it forever.
  if (profileCookieBumpTimers.has(pid)) return;
  profileCookieBumpTimers.set(pid, setTimeout(() => {
    profileCookieBumpTimers.delete(pid);
    if (Date.now() < (profileImportSuppressUntil.get(pid) || 0)) return; // a server import just bumped explicitly
    const next = profileRevision(pid) + 1;
    profileRevisions.set(pid, next);
    saveProfileRevisions().catch(() => {});
    recordUserActivity({
      userId: "admin", deviceId: "loader", profileId: pid, serviceId: "profile",
      action: "profile-updated-on-server", title: "Profile updated (server/loader)",
      details: JSON.stringify({ revision: next })
    }).catch(() => {});
  }, COOKIE_BUMP_DEBOUNCE_MS));
}

function watchCustodianCookies(targetSession, profileId) {
  if (!targetSession || watchedCookieSessions.has(targetSession)) return;
  watchedCookieSessions.add(targetSession);
  try {
    targetSession.cookies.on("changed", () => scheduleCustodianRevisionBump(profileId));
  } catch { /* cookies API unavailable */ }
}

function requestBaseUrl(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `${HOST}:${PORT}`)
    .split(",")[0]
    .trim();
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || (/trycloudflare\.com|centrix\.asia/i.test(host) ? "https" : "http");
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function requestUserId(req, reqUrl, payload = {}, fallback = "local-user") {
  return sanitizeId(
    req.headers["x-centrix-user"] ||
      payload.userId ||
      reqUrl.searchParams.get("userId") ||
      fallback,
    fallback
  );
}

function requestProfileId(req, reqUrl, payload = {}, fallback = DEFAULT_PROFILE) {
  return sanitizeId(
    req.headers["x-centrix-profile"] ||
      payload.profileId ||
      reqUrl.searchParams.get("profileId") ||
      fallback,
    fallback
  );
}

function requestHasUserScope(req, reqUrl) {
  return Boolean(req.headers["x-centrix-user"] || reqUrl.searchParams.has("userId"));
}

function localAddress() {
  return HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
}

function localBaseUrl() {
  return `http://${localAddress()}:${PORT}`;
}

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  return addresses;
}

const firewallStatus = {
  supported: process.platform === "win32",
  ok: process.platform !== "win32",
  status: process.platform === "win32" ? "checking" : "unsupported",
  ruleName: FIREWALL_RULE_NAME,
  port: PORT,
  message: process.platform === "win32" ? "Dang kiem tra Windows Firewall..." : "Khong phai Windows, bo qua firewall tu dong.",
  adminCommand: `netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${PORT} profile=any`
};

async function ensureWindowsFirewallRule() {
  if (process.platform !== "win32") return;

  try {
    await execFileAsync("netsh", [
      "advfirewall",
      "firewall",
      "show",
      "rule",
      `name=${FIREWALL_RULE_NAME}`
    ], {
      timeout: 15000,
      windowsHide: true
    });
    firewallStatus.ok = true;
    firewallStatus.status = "exists";
    firewallStatus.message = `Windows Firewall da co rule TCP ${PORT}.`;
  } catch (error) {
    try {
      await execFileAsync("netsh", [
        "advfirewall",
        "firewall",
        "add",
        "rule",
        `name=${FIREWALL_RULE_NAME}`,
        "dir=in",
        "action=allow",
        "protocol=TCP",
        `localport=${PORT}`,
        "profile=any"
      ], {
        timeout: 15000,
        windowsHide: true
      });
      firewallStatus.ok = true;
      firewallStatus.status = "created";
      firewallStatus.message = `Da mo Windows Firewall TCP ${PORT}.`;
    } catch (addError) {
      firewallStatus.ok = false;
      firewallStatus.status = "needs-admin";
      firewallStatus.message = `Chua mo duoc Windows Firewall TCP ${PORT}. Hay chay file "Allow CentriX App Server Firewall (Run as Admin).cmd" tren may Server.`;
      firewallStatus.error = addError.message || error.message || String(addError || error);
    }
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findCloudflaredPath() {
  const candidates = [
    process.env.CENTRIX_CLOUDFLARED_PATH,
    path.join(path.dirname(process.execPath), CLOUDFLARED_EXE),
    path.join(process.resourcesPath || "", CLOUDFLARED_EXE),
    path.join(__dirname, "..", "tools", "cloudflared", CLOUDFLARED_EXE),
    path.join(__dirname, "..", "cloudflared", CLOUDFLARED_EXE)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      tunnelState.binaryPath = candidate;
      return candidate;
    }
  }

  tunnelState.binaryPath = "";
  return "";
}

function updateTunnelOutput(text) {
  const value = String(text || "").trim();
  if (!value) return;
  tunnelState.lastOutput = value.slice(-2000);
  if (tunnelState.mode === "named" && /Registered tunnel connection/i.test(value) && tunnelState.candidateUrl) {
    verifyTunnelUrl(tunnelState.candidateUrl).catch(() => {});
  }
  const match = value.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match) {
    const nextUrl = match[0].replace(/\/+$/, "");
    if (nextUrl === tunnelState.candidateUrl || nextUrl === tunnelState.publicUrl) return;
    tunnelState.candidateUrl = nextUrl;
    tunnelState.publicUrl = "";
    tunnelState.status = "verifying";
    tunnelState.running = true;
    tunnelState.message = "Da nhan URL Cloudflare, dang kiem tra /api/health...";
    verifyTunnelUrl(nextUrl).catch(() => {});
  } else if (/ERR|failed|error/i.test(value) && !tunnelState.publicUrl) {
    tunnelState.status = "error";
    tunnelState.running = Boolean(tunnelProcess);
    tunnelState.message = value.split(/\r?\n/).slice(-1)[0] || "Cloudflare Tunnel loi.";
  }
}

function publicBaseUrl() {
  return tunnelState.publicUrl || "";
}

function tunnelSnapshot() {
  return {
    ...tunnelState,
    config: publicTunnelConfigSnapshot(),
    publicUrl: publicBaseUrl(),
    displayUrl: tunnelState.publicUrl || tunnelState.candidateUrl || ""
  };
}

async function verifyTunnelUrl(url) {
  const verifyId = ++tunnelVerificationId;

  for (let attempt = 1; attempt <= 18; attempt += 1) {
    if (verifyId !== tunnelVerificationId || url !== tunnelState.candidateUrl) return;

    try {
      const response = await fetch(`${url}/api/health`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000)
      });
      const contentType = String(response.headers.get("content-type") || "");
      if (response.ok && contentType.includes("application/json")) {
        const result = await response.json();
        if (result?.ok) {
          tunnelState.publicUrl = url;
          tunnelState.status = "ready";
          tunnelState.running = true;
          tunnelState.message = "Public URL da kiem tra OK. Nhap URL nay vao App User.";
          return;
        }
      }
      tunnelState.status = "verifying";
      tunnelState.message = `Dang doi Cloudflare route san sang (${attempt}/18)...`;
    } catch (error) {
      tunnelState.status = "verifying";
      tunnelState.message = `Dang doi Cloudflare route san sang (${attempt}/18): ${error.message || "chua ket noi duoc"}`;
    }

    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  if (verifyId === tunnelVerificationId && url === tunnelState.candidateUrl && !tunnelState.publicUrl) {
    tunnelState.status = "not-ready";
    tunnelState.running = true;
    tunnelState.message = "Cloudflare da cap URL nhung route chua tra JSON CentriX. Bam Tat Tunnel roi Bat Tunnel de lay URL moi.";
  }
}

function quickTunnelConfigPath() {
  return path.join(app.getPath("userData"), "cloudflared-quick-tunnel.yml");
}

async function ensureQuickTunnelConfig() {
  const filePath = quickTunnelConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "loglevel: info\n", "utf8");
  return filePath;
}

async function startCloudflareTunnel() {
  if (tunnelProcess && !tunnelProcess.killed) {
    return tunnelSnapshot();
  }

  if (!tunnelConfig.token) {
    tunnelState.running = false;
    tunnelState.status = "missing-token";
    tunnelState.publicUrl = "";
    tunnelState.candidateUrl = tunnelPublicUrlFromConfig();
    tunnelState.mode = "named";
    tunnelState.hostname = tunnelConfig.hostname || DEFAULT_TUNNEL_HOSTNAME;
    tunnelState.message = `Can Cloudflare Tunnel Token de dung domain ${tunnelPublicUrlFromConfig()}. Tao Tunnel trong Cloudflare Zero Trust roi dan token vao o Cloudflare Tunnel Token.`;
    return tunnelSnapshot();
  }

  const binary = await findCloudflaredPath();
  if (!binary) {
    tunnelState.running = false;
    tunnelState.status = "missing";
    tunnelState.message = `Khong tim thay ${CLOUDFLARED_EXE}. Hay build lai Server portable de kem Cloudflare Tunnel.`;
    return tunnelSnapshot();
  }

  tunnelState.running = true;
  tunnelState.status = "starting";
  tunnelState.publicUrl = "";
  tunnelState.candidateUrl = "";
  tunnelState.mode = "named";
  tunnelState.hostname = tunnelConfig.hostname || DEFAULT_TUNNEL_HOSTNAME;
  tunnelState.message = `Dang bat Cloudflare named tunnel cho ${tunnelPublicUrlFromConfig()}...`;
  tunnelState.startedAt = new Date().toISOString();
  tunnelState.exitedAt = "";
  tunnelState.lastOutput = "";
  const quickConfig = await ensureQuickTunnelConfig();
  const args = [
    "tunnel",
    "--config",
    quickConfig,
    "--no-autoupdate",
    "run",
    "--token",
    tunnelConfig.token
  ];

  tunnelState.candidateUrl = tunnelPublicUrlFromConfig();
  verifyTunnelUrl(tunnelState.candidateUrl).catch(() => {});

  tunnelProcess = spawn(binary, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  tunnelProcess.stdout.on("data", (chunk) => updateTunnelOutput(chunk.toString("utf8")));
  tunnelProcess.stderr.on("data", (chunk) => updateTunnelOutput(chunk.toString("utf8")));
  tunnelProcess.on("error", (error) => {
    tunnelState.running = false;
    tunnelState.status = "error";
    tunnelState.message = error.message || "Khong bat duoc Cloudflare Tunnel.";
    tunnelState.lastOutput = tunnelState.message;
  });
  tunnelProcess.on("exit", (code, signal) => {
    tunnelProcess = null;
    tunnelState.running = false;
    tunnelState.exitedAt = new Date().toISOString();
    if (tunnelState.status !== "stopping") {
      tunnelState.status = code === 0 ? "stopped" : "error";
      tunnelState.message = code === 0
        ? "Cloudflare Tunnel da dung."
        : `Cloudflare Tunnel da thoat (${signal || code}).`;
    } else {
      tunnelState.status = "stopped";
      tunnelState.message = "Cloudflare Tunnel da dung.";
    }
  });

  return tunnelSnapshot();
}

async function stopCloudflareTunnel() {
  tunnelState.status = "stopping";
  tunnelState.message = "Dang tat Cloudflare Tunnel...";
  tunnelState.publicUrl = "";
  tunnelState.candidateUrl = "";
  tunnelVerificationId += 1;

  if (!tunnelProcess) {
    tunnelState.running = false;
    tunnelState.status = "stopped";
    tunnelState.message = "Cloudflare Tunnel da dung.";
    return tunnelSnapshot();
  }

  const pid = tunnelProcess.pid;
  try {
    if (process.platform === "win32" && pid) {
      await execFileAsync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        timeout: 8000,
        windowsHide: true
      });
    } else {
      tunnelProcess.kill("SIGTERM");
    }
  } catch {
    try {
      tunnelProcess.kill();
    } catch {
      // The process may have already exited.
    }
  }

  tunnelProcess = null;
  tunnelState.running = false;
  tunnelState.status = "stopped";
  tunnelState.message = "Cloudflare Tunnel da dung.";
  tunnelState.exitedAt = new Date().toISOString();
  return tunnelSnapshot();
}

function authQuery() {
  return REQUIRE_TOKEN && authToken ? `&token=${encodeURIComponent(authToken)}` : "";
}

async function readJson(req) {
  // Cap the body so an unauthenticated POST can't exhaust memory (DoS). 8MB matches the backend's proven
  // limit and comfortably fits profile-import snapshots; override via CENTRIX_MAX_BODY_BYTES. Over-limit
  // aborts the stream and throws → handleApi's try/catch turns it into an error response (fail-closed).
  const MAX = Number(process.env.CENTRIX_MAX_BODY_BYTES || 8 * 1024 * 1024);
  let raw = "";
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX) { const e = new Error("Payload too large"); e.statusCode = 413; req.destroy(); throw e; }
    raw += chunk;
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function vietqrPaymentConfig() {
  // Bank account that receives VietQR top-ups — printed on the QR (addInfo = order payCode) and matched by
  // the SePay webhook. Kept in the App Server ENV so it can be changed WITHOUT rebuilding/re-signing the
  // App User. Defaults to the configured TPBank account; override any field via CENTRIX_VIETQR_* env.
  return {
    enabled: String(process.env.CENTRIX_VIETQR_ENABLED || "1") !== "0",
    bankBin: String(process.env.CENTRIX_VIETQR_BIN || "970423"),      // TPBank BIN
    bankCode: String(process.env.CENTRIX_VIETQR_CODE || "TPB"),
    accountNo: String(process.env.CENTRIX_VIETQR_ACCOUNT || "00000290281"),
    accountName: String(process.env.CENTRIX_VIETQR_NAME || "TRAN XUAN LOC"),
    template: String(process.env.CENTRIX_VIETQR_TEMPLATE || "compact2")
  };
}

function selectorLooksUsable(selector) {
  const clean = String(selector || "").trim();
  if (!clean || clean.length > 500) return false;
  if (/[{};]/.test(clean) || /!important/i.test(clean)) return false;
  if (/^\/\*/.test(clean) || clean.startsWith("* /") || clean.startsWith("@")) return false;
  if (/^[a-z-]+\s*:/i.test(clean)) return false;
  return true;
}

function sanitizeHideSelectors(value) {
  const raw = Array.isArray(value) ? value.join("\n") : String(value || "");
  const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, "\n");
  const selectors = [];
  let inBlock = false;

  for (const rawLine of withoutComments.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.includes("{")) {
      const selector = line.slice(0, line.indexOf("{")).trim().replace(/,$/, "");
      if (selectorLooksUsable(selector)) selectors.push(selector.slice(0, 320));
      inBlock = !line.includes("}");
      continue;
    }

    if (inBlock) {
      if (line.includes("}")) inBlock = false;
      continue;
    }

    const selector = line.replace(/,$/, "");
    if (selectorLooksUsable(selector)) selectors.push(selector.slice(0, 320));
  }

  return Array.from(new Set(selectors)).slice(0, 80);
}

function sanitizeReplaceRules(value) {
  const rows = Array.isArray(value) ? value : [];
  const clean = [];
  const seen = new Set();

  for (const raw of rows) {
    const selector = String(raw?.selector || "").trim();
    if (!selectorLooksUsable(selector)) continue;
    const text = String(raw?.text ?? raw?.replacement ?? "").slice(0, 1200);
    const matchText = String(raw?.matchText || "").slice(0, 400);
    const key = `${selector}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({
      selector: selector.slice(0, 320),
      text,
      matchText,
      enabled: raw?.enabled !== false
    });
  }

  return clean.slice(0, 40);
}

function stableUiRuleId(userId, serviceId, selector) {
  return `hide_${crypto.createHash("sha1").update(`${userId || ""}:${serviceId || ""}:${selector || ""}`).digest("hex").slice(0, 16)}`;
}

function sanitizeUiFingerprint(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    tag: String(source.tag || "").slice(0, 32).toLowerCase(),
    role: String(source.role || "").slice(0, 80),
    ariaLabel: String(source.ariaLabel || "").slice(0, 160),
    textSnippet: String(source.textSnippet || "").slice(0, 240),
    classCount: Math.max(0, Math.min(200, Math.round(Number(source.classCount || 0)) || 0)),
    childTags: Array.isArray(source.childTags) ? source.childTags.map((item) => String(item || "").slice(0, 32)).filter(Boolean).slice(0, 16) : [],
    rectRatio: Math.max(0, Math.min(100, Number(source.rectRatio || 0) || 0))
  };
}

function sanitizeHideRules(value, selectors = [], context = {}) {
  const rows = Array.isArray(value) ? value : [];
  const clean = [];
  const seen = new Set();
  const userId = sanitizeId(context.userId || "local-user", "local-user");
  const serviceId = sanitizeId(context.serviceId || "service", "service");
  const pushRule = (raw, index) => {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { primarySelector: raw };
    const primarySelector = String(source.primarySelector || source.selector || "").trim();
    if (!selectorLooksUsable(primarySelector) || seen.has(primarySelector)) return;
    seen.add(primarySelector);
    clean.push({
      id: String(source.id || stableUiRuleId(userId, serviceId, primarySelector)).slice(0, 100),
      version: Math.max(1, Math.round(Number(source.version || 1)) || 1),
      domain: String(source.domain || context.domain || "").slice(0, 160),
      scope: source.scope && typeof source.scope === "object" ? {
        urlPattern: String(source.scope.urlPattern || "").slice(0, 500),
        pageState: String(source.scope.pageState || "").slice(0, 80)
      } : { urlPattern: "", pageState: "" },
      primarySelector: primarySelector.slice(0, 500),
      anchorSelector: selectorLooksUsable(source.anchorSelector) ? String(source.anchorSelector).trim().slice(0, 500) : "",
      fingerprint: sanitizeUiFingerprint(source.fingerprint),
      expectation: {
        minMatches: Math.max(0, Math.round(Number(source.expectation?.minMatches ?? 1)) || 0),
        ...(source.expectation?.maxMatches !== undefined ? { maxMatches: Math.max(0, Math.round(Number(source.expectation.maxMatches) || 0)) } : {})
      },
      action: ["hide", "remove", "collapse"].includes(source.action) ? source.action : "hide",
      failMode: ["open", "closed"].includes(source.failMode) ? source.failMode : "open",
      createdAt: String(source.createdAt || new Date().toISOString()).slice(0, 80),
      lastVerifiedAt: String(source.lastVerifiedAt || "").slice(0, 80),
      health: {
        state: ["green", "yellow", "red", "unknown"].includes(source.health?.state) ? source.health.state : "unknown",
        recentMissRate: Math.max(0, Math.min(1, Number(source.health?.recentMissRate || 0) || 0)),
        lastSeenMatchingAt: String(source.health?.lastSeenMatchingAt || "").slice(0, 80)
      },
      enabled: source.enabled !== false,
      note: String(source.note || `selector ${index + 1}`).slice(0, 240)
    });
  };

  rows.forEach(pushRule);
  sanitizeHideSelectors(selectors).forEach((selector, index) => {
    if (!seen.has(selector)) pushRule({ primarySelector: selector, note: "legacy selector" }, index);
  });
  return clean.slice(0, 80);
}

function hideCssForSelector(selector) {
  return `${selector} { display: none !important; visibility: hidden !important; pointer-events: none !important; }`;
}

function cssForHideRule(rule) {
  const selector = String(rule?.primarySelector || rule || "").trim();
  if (!selectorLooksUsable(selector)) return "";
  if (rule?.action === "collapse") {
    return `${selector} { display: block !important; max-height: 0 !important; height: 0 !important; min-height: 0 !important; overflow: hidden !important; opacity: 0 !important; pointer-events: none !important; }`;
  }
  return hideCssForSelector(selector);
}

function replaceRulesScript(rules) {
  return `
(() => {
  const rules = ${JSON.stringify(sanitizeReplaceRules(rules))};
  let applied = 0;

  function textForNode(node) {
    return "value" in node ? String(node.value || "") : String(node.textContent || "");
  }

  function replaceNode(node, text) {
    if (!node || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.tagName)) return false;
    if ("value" in node && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) {
      if (String(node.value || "") === text) return false;
      node.value = text;
      node.setAttribute("value", text);
      return true;
    }
    if (node.isContentEditable) {
      if (String(node.textContent || "") === text) return false;
      node.textContent = text;
      return true;
    }
    if (String(node.textContent || "") === text) return false;
    node.textContent = text;
    return true;
  }

  for (const rule of rules) {
    if (!rule || rule.enabled === false || !rule.selector) continue;
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(rule.selector)); } catch { continue; }
    for (const node of nodes) {
      if (!node || node.dataset?.centrixVisualRuleInternal === "true") continue;
      const previous = textForNode(node);
      if (rule.matchText && !previous.includes(rule.matchText)) continue;
      if (replaceNode(node, rule.text || "")) {
        node.setAttribute("data-centrix-replaced", "true");
        applied += 1;
      }
    }
  }
  return { applied, rules: rules.length };
})()
`;
}

function sanitizeUserScript(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .slice(0, 30000);
}

function userScriptRunner(script, context = {}) {
  const cleanScript = sanitizeUserScript(script);
  if (!cleanScript.trim()) return "";
  return `
(async () => {
  const script = ${JSON.stringify(cleanScript)};
  const context = ${JSON.stringify(context || {})};
  try {
    window.__centrixUserScriptContext = context;
    const run = new Function("context", script);
    const value = await run.call(window, context);
    return {
      ok: true,
      value: value === undefined ? null : String(value).slice(0, 500)
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
})()
`;
}

function uiRuleHealthScript(rules, context = {}) {
  const cleanRules = sanitizeHideRules(rules, [], context).filter((rule) => rule.enabled !== false);
  return `
(() => {
  const rules = ${JSON.stringify(cleanRules)};
  const now = new Date().toISOString();
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const snippet = (node) => normalize("value" in node ? node.value : (node.innerText || node.textContent || "")).slice(0, 240);
  const fingerprintOf = (node) => {
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 };
    return {
      tag: node.tagName ? node.tagName.toLowerCase() : "",
      role: node.getAttribute ? String(node.getAttribute("role") || "") : "",
      ariaLabel: node.getAttribute ? String(node.getAttribute("aria-label") || "") : "",
      textSnippet: snippet(node),
      classCount: node.classList ? node.classList.length : 0,
      childTags: Array.from(node.children || []).slice(0, 16).map((child) => child.tagName.toLowerCase()),
      rectRatio: rect.height ? Number((rect.width / rect.height).toFixed(3)) : 0
    };
  };
  const driftScore = (expected, actual) => {
    if (!expected || !actual) return 0;
    let checks = 0;
    let misses = 0;
    for (const key of ["tag", "role", "ariaLabel"]) {
      if (expected[key]) {
        checks += 1;
        if (String(expected[key]) !== String(actual[key] || "")) misses += 1;
      }
    }
    if (expected.textSnippet) {
      checks += 1;
      if (!String(actual.textSnippet || "").includes(String(expected.textSnippet).slice(0, 40))) misses += 1;
    }
    if (Array.isArray(expected.childTags) && expected.childTags.length) {
      checks += 1;
      const expectedTags = expected.childTags.join(",");
      const actualTags = (actual.childTags || []).join(",");
      if (expectedTags !== actualTags) misses += 1;
    }
    return checks ? Number((misses / checks).toFixed(3)) : 0;
  };
  const query = (selector) => {
    if (!selector) return [];
    try { return Array.from(document.querySelectorAll(selector)); } catch { return []; }
  };
  const reports = [];
  for (const rule of rules) {
    const primary = query(rule.primarySelector);
    const anchor = primary.length ? [] : query(rule.anchorSelector);
    const matches = primary.length ? primary : anchor;
    const expectation = rule.expectation || { minMatches: 1 };
    const tooFew = primary.length < Number(expectation.minMatches || 0);
    const tooMany = expectation.maxMatches !== undefined && primary.length > Number(expectation.maxMatches || 0);
    const actual = matches[0] ? fingerprintOf(matches[0]) : null;
    const drift = actual ? driftScore(rule.fingerprint || {}, actual) : 1;
    let state = "green";
    let message = "primary selector matched";
    if (!primary.length && anchor.length) {
      state = "yellow";
      message = "primary selector missed; anchor matched";
    } else if (!matches.length || tooFew || tooMany) {
      state = "red";
      message = !matches.length ? "selector missed" : (tooMany ? "selector matched too many elements" : "selector matched too few elements");
    } else if (drift >= 0.34) {
      state = "yellow";
      message = "fingerprint drift detected";
    }
    reports.push({
      id: "uir_" + Math.random().toString(16).slice(2) + Date.now().toString(16),
      ruleId: rule.id,
      selector: rule.primarySelector,
      state,
      matchCount: primary.length,
      driftScore: drift,
      url: location.href,
      origin: location.origin,
      evidenceSnippet: matches[0] ? matches[0].outerHTML.slice(0, 1200) : "",
      message,
      createdAt: now
    });
  }
  return { reports, ok: true, checked: reports.length, url: location.href, origin: location.origin, createdAt: now };
})()
`;
}

function originOf(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function requestBodyText(details) {
  const chunks = [];
  for (const item of details.uploadData || []) {
    if (item.bytes) chunks.push(Buffer.from(item.bytes));
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
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

function likelyModelRequest(details, serviceId = "") {
  if (String(details.method || "").toUpperCase() !== "POST") return false;
  if (!["fetch", "xhr"].includes(String(details.resourceType || ""))) return false;
  try {
    const parsed = new URL(details.url);
    const cleanServiceId = String(serviceId || "").toLowerCase();
    if (cleanServiceId === "chatgpt") {
      return /\/backend-api\/(?:f\/)?conversation|\/backend-api\/conversation\/prepare|\/backend-api\/conversation\/model/i.test(parsed.pathname);
    }
    if (cleanServiceId === "claude") {
      return /\/api\/|\/chat_conversations|\/completion|\/append_message|\/retry/i.test(parsed.pathname);
    }
    return /conversation|completion|message|chat|model/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function tabForObservedRequest(url) {
  const requestOrigin = originOf(url);
  if (!requestOrigin) return null;
  for (const tab of tabs.values()) {
    if (!tab?.state?.serviceId) continue;
    const tabUrl = tab.window && !tab.window.isDestroyed()
      ? tab.window.webContents.getURL() || tab.state.url
      : tab.state.url;
    if (originOf(tab.state.url) === requestOrigin || originOf(tabUrl) === requestOrigin) {
      return tab;
    }
  }
  return null;
}

function observeModelRequest(details) {
  const tab = tabForObservedRequest(details.url);
  if (!tab?.state?.serviceId || !likelyModelRequest(details, tab.state.serviceId)) return;
  const modelId = modelFromRequest(details);
  if (!modelId) return;
  observeModel({
    serviceId: tab.state.serviceId,
    modelId,
    source: "loader",
    url: details.url
  }).catch(() => {});
}

// First slice of mục 12 (server-hosted enforcement): when a model request fires
// on a SERVER-hosted tab, check the owning user's policy/credit server-side and
// BLOCK if not allowed — enforcement the client cannot patch away. Loader/admin
// tabs (role "loader") bypass credit, so the admin loader keeps working.
const SERVER_MODEL_ENFORCE = process.env.CENTRIX_SERVER_MODEL_ENFORCE !== "0";
let serverModelSeq = 0;

async function serviceDefaultsForTab(tab) {
  const serviceId = sanitizeId(tab?.state?.serviceId || "", "");
  if (!serviceId) return null;
  try {
    const config = await readServicesConfig();
    return (config.services || []).find((service) => sanitizeId(service.id, "") === serviceId) || null;
  } catch {
    return null;
  }
}

async function enforceServerModelRequest(details) {
  const tab = tabForObservedRequest(details.url);
  if (!tab?.state?.serviceId || !likelyModelRequest(details, tab.state.serviceId)) return { cancel: false };
  const detectedModelId = modelFromRequest(details);
  const service = await serviceDefaultsForTab(tab);
  if (!SERVER_MODEL_ENFORCE && detectedModelId) {
    observeModel({ serviceId: tab.state.serviceId, modelId: detectedModelId, source: "loader", url: details.url }).catch(() => {});
    return { cancel: false };
  }

  const userId = tab.state.userId || "profile-loader";
  try {
    const result = await checkUserModelUsage({
      userId,
      serviceId: tab.state.serviceId,
      modelId: detectedModelId || "",
      serviceDefaultModel: service?.defaultModel || "",
      serviceDefaultCreditCost: service?.defaultCreditCost || 1,
      // Unique per request so every generation debits once. A constant id would
      // dedupe via the idempotency key and let the tab spend after one charge.
      usageRequestId: `srv-${tab.state.tabId || "tab"}-${detectedModelId || "default"}-${Date.now()}-${++serverModelSeq}`,
      url: String(details.url || "").slice(0, 2048),
      consume: true
    });
    const observedModelId = detectedModelId || result?.modelId || "";
    if (observedModelId) {
      observeModel({ serviceId: tab.state.serviceId, modelId: observedModelId, source: "loader", url: details.url }).catch(() => {});
    }
    if (result && result.allowed === false) {
      recordUserActivity({
        userId,
        deviceId: "server-tab",
        profileId: tab.state.profileId || DEFAULT_PROFILE,
        serviceId: tab.state.serviceId,
        action: "model-blocked",
        title: observedModelId || UNKNOWN_MODEL_ID,
        details: JSON.stringify({ reason: result.reason || "blocked", source: "server-observer" })
      }).catch(() => {});
      return { cancel: true };
    }
  } catch {
    // On enforcement error, fail open (do not break browsing).
    return { cancel: false };
  }
  return { cancel: false };
}

function configureModelObserver(targetSession, partition) {
  const key = String(partition || targetSession.partition || "");
  if (observedPartitions.has(key)) return;
  observedPartitions.add(key);

  targetSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    enforceServerModelRequest(details)
      .then((result) => callback({ cancel: result.cancel === true }))
      .catch(() => callback({ cancel: false }));
  });
}

async function clearTabUiPreview(tab) {
  const keys = Array.isArray(tab?.uiPreviewCssKeys) ? tab.uiPreviewCssKeys : [];
  tab.uiPreviewCssKeys = [];
  for (const key of keys) {
    if (!key) continue;
    await tab.window.webContents.removeInsertedCSS(key).catch(() => {});
  }
}

async function applyUiPreviewToTab(tab, options = {}) {
  if (!tab?.window || tab.window.isDestroyed()) {
    throw new Error("Browser nap data chua mo");
  }

  const selectors = sanitizeHideSelectors(options.hideSelectors || options.selectors || []);
  const replaceRules = sanitizeReplaceRules(options.replaceRules || []);
  const userScript = sanitizeUserScript(options.userScript || "");
  const enabled = options.enabled !== false;
  const userId = sanitizeId(options.userId || "local-user", "local-user");
  const serviceId = sanitizeId(options.serviceId || tab.state.serviceId || "service", "service");
  const hideRules = sanitizeHideRules(options.hideRules || [], selectors, {
    userId,
    serviceId,
    domain: originOf(tab.window.webContents.getURL() || tab.state.url || "")
  });
  const finalSelectors = Array.from(new Set([
    ...selectors,
    ...hideRules.map((rule) => rule.primarySelector).filter(Boolean)
  ]));
  tab.uiPreview = {
    enabled,
    selectors: finalSelectors,
    hideRules,
    replaceRules,
    userScript,
    serviceId,
    userId
  };

  await clearTabUiPreview(tab);
  if (!enabled || (finalSelectors.length === 0 && replaceRules.length === 0 && !userScript.trim())) {
    return { applied: 0, replaced: 0, userScript: { ok: true, skipped: true }, selectors: finalSelectors, hideRules, replaceRules, skipped: finalSelectors.length, health: { reports: [] } };
  }

  const health = hideRules.length
    ? await tab.window.webContents.executeJavaScript(uiRuleHealthScript(hideRules, { userId, serviceId }), true).catch((error) => ({
        ok: false,
        error: error.message || String(error),
        reports: []
      }))
    : { ok: true, reports: [] };
  if (Array.isArray(health?.reports) && health.reports.length) {
    await recordUiRuleReports({
      userId,
      serviceId,
      url: health.url || tab.window.webContents.getURL() || "",
      origin: health.origin || "",
      reports: health.reports
    }).catch(() => null);
  }

  const applied = [];
  for (const rule of (hideRules.length ? hideRules : finalSelectors.map((selector) => ({ primarySelector: selector, action: "hide" })))) {
    try {
      const key = await tab.window.webContents.insertCSS(cssForHideRule(rule), { cssOrigin: "user" });
      tab.uiPreviewCssKeys.push(key);
      applied.push(rule.primarySelector || String(rule));
    } catch {
      // Keep testing usable even if one selector is not accepted by Chromium.
    }
  }

  const replacePreview = replaceRules.length
    ? await tab.window.webContents.executeJavaScript(replaceRulesScript(replaceRules), true).catch(() => ({ applied: 0 }))
    : { applied: 0 };
  const userScriptPreview = userScript.trim()
    ? await tab.window.webContents.executeJavaScript(userScriptRunner(userScript, {
        mode: "preview",
        userId,
        serviceId,
        url: tab.window.webContents.getURL() || tab.state.url || ""
      }), true).catch((error) => ({ ok: false, error: error.message || String(error) }))
    : { ok: true, skipped: true };

  return {
    applied: applied.length,
    replaced: Number(replacePreview?.applied || 0),
    userScript: userScriptPreview,
    selectors: finalSelectors,
    hideRules,
    replaceRules,
    health,
    skipped: finalSelectors.length - applied.length
  };
}

function visualSelectScript(options = {}) {
  const action = String(options.action || "hide").slice(0, 24);
  const timeoutMs = Math.max(5000, Math.min(120000, Math.round(Number(options.timeoutMs || 45000))));
  return `
new Promise((resolve) => {
  const action = ${JSON.stringify(action)};
  const startedAt = Date.now();
  const cleanupItems = [];
  const esc = (value) => {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(String(value || ""));
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "\\\\$&");
  };
  const quote = (value) => String(value || "").replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\22 ");
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const nthOfType = (node) => {
    let index = 1;
    let sib = node;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === node.tagName) index += 1;
    }
    return index;
  };
  const stableClass = (item) => {
    const value = String(item || "");
    return value &&
      value.length < 48 &&
      !/^\\d/.test(value) &&
      !/^(css|sc|chakra|mantine|radix|tailwind)-/i.test(value) &&
      !/[a-f0-9]{8,}/i.test(value);
  };
  const textSnippet = (node) => ("value" in node ? node.value : (node.innerText || node.textContent || "")).replace(/\\s+/g, " ").trim().slice(0, 160);
  const fingerprintFor = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      tag: node.tagName ? node.tagName.toLowerCase() : "",
      role: node.getAttribute("role") || "",
      ariaLabel: node.getAttribute("aria-label") || "",
      textSnippet: textSnippet(node),
      classCount: node.classList ? node.classList.length : 0,
      childTags: Array.from(node.children || []).slice(0, 16).map((child) => child.tagName.toLowerCase()),
      rectRatio: rect.height ? Number((rect.width / rect.height).toFixed(3)) : 0
    };
  };
  const selectorFor = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return "";
    const candidates = [];
    const tag = node.tagName.toLowerCase();
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "aria-label", "aria-controls", "name", "role"]) {
      const value = node.getAttribute(attr);
      if (value && value.length < 120) candidates.push(tag + "[" + attr + "=\\"" + quote(value) + "\\"]");
    }
    if (node.id && node.id.length < 120) candidates.push("#" + esc(node.id));
    const classes = Array.from(node.classList || []).filter(stableClass).slice(0, 3);
    if (classes.length) candidates.push(tag + "." + classes.map(esc).join("."));
    for (const candidate of candidates) {
      if (unique(candidate)) return candidate;
    }
    const parts = [];
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      const currentTag = current.tagName.toLowerCase();
      if (current.id && current.id.length < 120) {
        parts.unshift("#" + esc(current.id));
        const path = parts.join(" > ");
        if (unique(path)) return path;
        break;
      }
      parts.unshift(currentTag + ":nth-of-type(" + nthOfType(current) + ")");
      const path = parts.join(" > ");
      if (unique(path)) return path;
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const anchorFor = (node) => {
    let current = node?.parentElement || null;
    while (current && current !== document.documentElement) {
      const selector = selectorFor(current);
      if (selector && selector.length < 320) return selector;
      current = current.parentElement;
    }
    return "";
  };
  const overlay = document.createElement("div");
  overlay.dataset.centrixVisualRuleInternal = "true";
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    border: "2px solid #0b84ff",
    background: "rgba(11,132,255,0.10)",
    boxShadow: "0 0 0 99999px rgba(15,23,42,0.12)",
    display: "none"
  });
  const badge = document.createElement("div");
  badge.dataset.centrixVisualRuleInternal = "true";
  badge.textContent = action === "replace" ? "Click de doi noi dung - mui ten de doi cap" : "Click de an vung nay - mui ten de doi cap";
  Object.assign(badge.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    padding: "7px 9px",
    borderRadius: "8px",
    background: "#0b84ff",
    color: "#fff",
    font: "12px/1.3 Segoe UI, Arial, sans-serif",
    display: "none"
  });
  document.documentElement.append(overlay, badge);
  let baseTarget = null;
  let current = null;
  let depth = 0;
  const targetFromBase = () => {
    let node = baseTarget;
    for (let index = 0; index < depth && node?.parentElement; index += 1) node = node.parentElement;
    return node;
  };
  const paintOverlay = (target) => {
    if (!target || target.dataset?.centrixVisualRuleInternal === "true") return;
    current = target;
    const rect = target.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = rect.left + "px";
    overlay.style.top = rect.top + "px";
    overlay.style.width = Math.max(1, rect.width) + "px";
    overlay.style.height = Math.max(1, rect.height) + "px";
    badge.style.display = "block";
    badge.style.left = Math.max(8, Math.min(window.innerWidth - 180, rect.left)) + "px";
    badge.style.top = Math.max(8, rect.top - 34) + "px";
  };
  const moveOverlay = (target) => {
    if (!target || target.dataset?.centrixVisualRuleInternal === "true") return;
    baseTarget = target;
    paintOverlay(targetFromBase() || target);
  };
  const done = (payload) => {
    for (const item of cleanupItems) item();
    overlay.remove();
    badge.remove();
    resolve(payload);
  };
  const onMove = (event) => {
    const pathTarget = Array.isArray(event.composedPath?.()) ? event.composedPath().find((item) => item?.nodeType === Node.ELEMENT_NODE) : null;
    moveOverlay(pathTarget || document.elementFromPoint(event.clientX, event.clientY) || event.target);
  };
  const onClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const target = current || event.target;
    const rect = target.getBoundingClientRect();
    const primarySelector = selectorFor(target);
    const anchorSelector = anchorFor(target);
    const fingerprint = fingerprintFor(target);
    const draftRule = {
      id: "hide_" + Math.random().toString(16).slice(2) + Date.now().toString(16),
      version: 1,
      domain: location.origin,
      scope: { urlPattern: location.pathname || "", pageState: "" },
      primarySelector,
      anchorSelector,
      fingerprint,
      expectation: { minMatches: 1, maxMatches: 1 },
      action: "hide",
      failMode: "open",
      health: { state: "unknown", recentMissRate: 0, lastSeenMatchingAt: "" },
      enabled: true,
      note: textSnippet(target).slice(0, 120)
    };
    done({
      ok: true,
      action,
      selector: primarySelector,
      primarySelector,
      anchorSelector,
      fingerprint,
      expectation: draftRule.expectation,
      ruleDraft: draftRule,
      text: textSnippet(target).slice(0, 500),
      tagName: target.tagName ? target.tagName.toLowerCase() : "",
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      url: location.href,
      origin: location.origin,
      elapsedMs: Date.now() - startedAt
    });
  };
  const onKey = (event) => {
    if (event.key === "Escape") done({ ok: false, cancelled: true, reason: "escape" });
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      depth = Math.min(depth + 1, 12);
      const next = targetFromBase();
      if (next) paintOverlay(next);
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      depth = Math.max(0, depth - 1);
      const next = targetFromBase();
      if (next) paintOverlay(next);
    }
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  cleanupItems.push(() => document.removeEventListener("mousemove", onMove, true));
  cleanupItems.push(() => document.removeEventListener("click", onClick, true));
  cleanupItems.push(() => document.removeEventListener("keydown", onKey, true));
  cleanupItems.push(() => clearTimeout(timer));
  const timer = setTimeout(() => done({ ok: false, reason: "timeout" }), ${timeoutMs});
})
`;
}

async function selectUiElementOnTab(tab, options = {}) {
  if (!tab?.window || tab.window.isDestroyed()) {
    throw new Error("Chua mo browser nap data de chon vung");
  }
  tab.window.show();
  tab.window.focus();
  return tab.window.webContents.executeJavaScript(visualSelectScript(options), true);
}

async function getProfileSession(profileId, proxyRules) {
  const cleanProfileId = sanitizeId(profileId, DEFAULT_PROFILE);
  const partition = partitionForProfile(cleanProfileId);
  const targetSession = session.fromPartition(partition);
  configureModelObserver(targetSession, partition);
  watchCustodianCookies(targetSession, cleanProfileId);

  if (proxyRules !== undefined) {
    const rules = String(proxyRules || "").trim();
    const previousRules = sessionProxyRules.get(partition);

    if (previousRules !== rules) {
      if (rules) {
        await targetSession.setProxy({ proxyRules: rules });
      } else {
        await targetSession.setProxy({ mode: "direct" });
      }
      sessionProxyRules.set(partition, rules);
    }
  }

  return { targetSession, partition, profileId: cleanProfileId };
}

// --- Per-service login status (Tier 1: cookie presence on the shared custodian partition) ---
// Honest by design: cookie presence => "đã đăng nhập (chưa xác minh)", NEVER a verified claim. A named
// auth-cookie match (service.detect.authCookies) is higher confidence than the generic httpOnly heuristic.
const SERVICE_LOGIN_CACHE = new Map(); // serviceId -> { ts, result }
const SERVICE_LOGIN_TTL_MS = 30000;
const NON_AUTH_COOKIE_RE = /^(__cf_bm|_cfuvid|cf_clearance|__cflb|_ga|_gid|_gat|_gac|_fbp|_fbc|_gcl|amp_|ajs_|_hj|intercom|optimizely|mp_|_pk_|_uet|datadome)/i;
function serviceLoginCookieIsAuth(c) {
  if (!c || !c.value || String(c.value).length < 6) return false;
  if (c.expirationDate && c.expirationDate * 1000 < Date.now()) return false; // expired
  const n = String(c.name || "");
  if (NON_AUTH_COOKIE_RE.test(n)) return false; // ignore analytics / anti-bot noise
  return c.httpOnly === true || /sess|sid|token|auth|login|jwt|account|__secure|csrf|psid/i.test(n);
}
async function detectServiceLogin(service, targetSession) {
  const urls = [];
  if (service.url) urls.push(service.url);
  for (const d of (Array.isArray(service.cookieDomains) ? service.cookieDomains : [])) {
    if (d) urls.push(`https://${String(d).replace(/^\.+/, "")}/`);
  }
  const seen = new Set(); const cookies = [];
  for (const u of urls) {
    let got = [];
    try { got = await targetSession.cookies.get({ url: u }); } catch { got = []; }
    for (const c of got) { const k = `${c.name}|${c.domain}|${c.path}`; if (!seen.has(k)) { seen.add(k); cookies.push(c); } }
  }
  const named = (service.detect && Array.isArray(service.detect.authCookies))
    ? service.detect.authCookies.map((s) => String(s).toLowerCase()) : [];
  let state = "out", confidence = "none";
  if (named.length) {
    const hit = cookies.find((c) => named.includes(String(c.name).toLowerCase()) && c.value
      && !(c.expirationDate && c.expirationDate * 1000 < Date.now()));
    state = hit ? "in" : "out"; confidence = "cookie";
  } else {
    const auth = cookies.filter(serviceLoginCookieIsAuth);
    state = auth.length ? "in" : "out"; confidence = "weak";
  }
  return { serviceId: service.id, state, confidence, account: null, cookieCount: cookies.length, checkedAt: Date.now() };
}
async function serviceLoginStatuses(serviceIds, profileId) {
  const { targetSession } = await getProfileSession(profileId || DEFAULT_PROFILE);
  const cfg = await readServicesConfig();
  const wanted = Array.isArray(serviceIds) && serviceIds.length ? new Set(serviceIds) : null;
  const services = (cfg.services || []).filter((s) => s && s.enabled !== false && (!wanted || wanted.has(s.id)));
  const out = [];
  for (const s of services) {
    const cached = SERVICE_LOGIN_CACHE.get(s.id);
    if (cached && Date.now() - cached.ts < SERVICE_LOGIN_TTL_MS) { out.push(cached.result); continue; }
    let r;
    try { r = await detectServiceLogin(s, targetSession); }
    catch { r = { serviceId: s.id, state: "unknown", confidence: "none", account: null, cookieCount: 0, checkedAt: Date.now() }; }
    SERVICE_LOGIN_CACHE.set(s.id, { ts: Date.now(), result: r });
    out.push(r);
  }
  return out;
}

function getTabState(tab) {
  if (tab.window && !tab.window.isDestroyed()) {
    const bounds = tab.window.getContentBounds();
    tab.state.visible = tab.window.isVisible();
    tab.state.width = bounds.width;
    tab.state.height = bounds.height;
    tab.state.url = tab.window.webContents.getURL() || tab.state.url;
    tab.state.title = tab.window.webContents.getTitle() || tab.state.title;
    tab.state.loading = tab.window.webContents.isLoading();
    tab.state.canGoBack = tab.window.webContents.canGoBack();
    tab.state.canGoForward = tab.window.webContents.canGoForward();
  } else {
    tab.state.visible = false;
  }

  return {
    ...tab.state,
    tabs: Array.from(tabs.values()).map((item) => ({
      tabId: item.state.tabId,
      profileId: item.state.profileId,
      serviceId: item.state.serviceId,
      serviceName: item.state.serviceName,
      title: item.state.title,
      url: item.state.url,
      loading: item.state.loading,
      visible: item.state.visible,
      localUser: false,
      controlUrl: controlUrlForTab(item.state.tabId)
    })).concat(clientTabStates()),
    controlUrl: controlUrlForTab(tab.state.tabId)
  };
}

function pruneClientTabs() {
  const now = Date.now();
  for (const [key, item] of clientTabs.entries()) {
    if (now - item.lastSeenAt > CLIENT_TAB_TTL_MS) {
      clientTabs.delete(key);
    }
  }
}

function clientTabStates() {
  pruneClientTabs();
  return Array.from(clientTabs.values()).map((item) => ({
    tabId: item.tabId,
    profileId: item.profileId,
    serviceId: item.serviceId,
    serviceName: item.serviceName,
    title: item.title,
    url: item.url,
    loading: item.loading,
    visible: false,
    localUser: true,
    userId: item.userId,
    deviceId: item.deviceId,
    lastSeenAt: new Date(item.lastSeenAt).toISOString(),
    updatedAt: item.updatedAt,
    controlUrl: ""
  }));
}

function allTabStates() {
  return Array.from(tabs.values())
    .map((tab) => ({ ...getTabState(tab), localUser: false }))
    .concat(clientTabStates());
}

function controlUrlForTab(tabId) {
  return `${localBaseUrl()}/?tabId=${encodeURIComponent(tabId)}${authQuery()}`;
}

function wireTabEvents(tab) {
  const wc = tab.window.webContents;

  wc.setZoomFactor(1);
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url).catch((error) => {
      tab.state.lastError = error.message;
    });
    return { action: "deny" };
  });

  wc.on("page-title-updated", (_event, title) => {
    tab.state.title = title || "";
  });

  wc.on("did-start-loading", () => {
    tab.state.loading = true;
    tab.state.lastError = "";
  });

  wc.on("did-stop-loading", () => {
    tab.state.loading = false;
    tab.state.url = wc.getURL() || tab.state.url;
    tab.state.title = wc.getTitle() || tab.state.title;
    if (tab.uiPreview?.enabled && tab.uiPreview.selectors?.length) {
      setTimeout(() => applyUiPreviewToTab(tab, tab.uiPreview).catch(() => {}), 250);
    }
  });

  wc.on("did-navigate", (_event, nextUrl) => {
    tab.state.url = nextUrl;
  });

  wc.on("did-navigate-in-page", (_event, nextUrl) => {
    tab.state.url = nextUrl;
  });

  wc.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (errorCode === -3) return;
    tab.state.loading = false;
    tab.state.lastError = errorDescription || "";
  });

  tab.window.on("closed", () => {
    tabs.delete(tab.state.tabId);
  });
}

async function createOrReplaceTab(tabId, options = {}) {
  const cleanTabId = sanitizeId(tabId, DEFAULT_TABS[0]);
  const cleanProfileId = sanitizeId(options.profileId || DEFAULT_PROFILE, DEFAULT_PROFILE);
  const existing = tabs.get(cleanTabId);
  const shouldReplace = existing && !existing.window.isDestroyed() && existing.state.profileId !== cleanProfileId;

  if (shouldReplace) {
    existing.window.close();
    tabs.delete(cleanTabId);
  }

  if (existing && !existing.window.isDestroyed()) {
    await getProfileSession(cleanProfileId, options.proxyRules);
    existing.state.profileId = cleanProfileId;
    existing.state.partition = partitionForProfile(cleanProfileId);
    if (options.serviceId !== undefined) {
      existing.state.serviceId = sanitizeId(options.serviceId, "");
    }
    if (options.serviceName !== undefined) {
      existing.state.serviceName = String(options.serviceName || "").slice(0, 120);
    }
    if (options.url) {
      existing.state.url = normalizeUrl(options.url);
      await existing.window.webContents.loadURL(existing.state.url);
    }
    if (options.show === true || options.focus === true) {
      existing.window.show();
      existing.window.focus();
    }
    return getTabState(existing);
  }

  const { targetSession, partition, profileId } = await getProfileSession(cleanProfileId, options.proxyRules);
  const width = Math.max(800, Math.min(2200, Math.round(Number(options.width || DEFAULT_WIDTH))));
  const height = Math.max(520, Math.min(1600, Math.round(Number(options.height || DEFAULT_HEIGHT))));
  const url = normalizeUrl(options.url || DEFAULT_URL);
  const shouldShowTarget = options.show === true || SHOW_TARGET_WINDOWS;

  const tab = {
    window: new BrowserWindow({
      width,
      height,
      useContentSize: true,
      show: shouldShowTarget,
      paintWhenInitiallyHidden: true,
      title: `CentriX Shared Tab ${cleanTabId}`,
      icon: APP_ICON,
      backgroundColor: "#ffffff",
      webPreferences: {
        session: targetSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    }),
    uiPreview: null,
    uiPreviewCssKeys: [],
    state: {
      tabId: cleanTabId,
      profileId,
      userId: sanitizeId(options.userId || "profile-loader", "profile-loader"),
      serviceId: sanitizeId(options.serviceId, ""),
      serviceName: String(options.serviceName || "").slice(0, 120),
      partition,
      url,
      title: "",
      loading: false,
      visible: shouldShowTarget,
      width,
      height,
      canGoBack: false,
      canGoForward: false,
      lastError: ""
    }
  };

  tabs.set(cleanTabId, tab);
  wireTabEvents(tab);
  await tab.window.webContents.loadURL(url);
  if (options.focus === true) {
    tab.window.show();
    tab.window.focus();
  }
  return getTabState(tab);
}

async function ensureTab(tabId, options = {}) {
  const cleanTabId = sanitizeId(tabId, DEFAULT_TABS[0]);
  const existing = tabs.get(cleanTabId);
  if (existing && !existing.window.isDestroyed()) return existing;

  await createOrReplaceTab(cleanTabId, options);
  return tabs.get(cleanTabId);
}

async function getTabForRequest(tabId) {
  return ensureTab(tabId || DEFAULT_TABS[0], {
    profileId: DEFAULT_PROFILE,
    url: DEFAULT_URL
  });
}

async function targetFromOpenPayload(payload) {
  if (payload.url) {
    return {
      url: normalizeUrl(payload.url),
      serviceId: payload.serviceId || "",
      serviceName: payload.serviceName || ""
    };
  }

  if (payload.serviceId) {
    const config = await readServicesConfig();
    const service = config.services.find((item) => item.id === payload.serviceId && item.enabled !== false);
    if (service?.url) {
      return {
        url: normalizeUrl(service.url),
        serviceId: service.id,
        serviceName: service.name
      };
    }
  }

  return {
    url: DEFAULT_URL,
    serviceId: payload.serviceId || "",
    serviceName: payload.serviceName || ""
  };
}

function getTabWebContents(tab) {
  if (!tab?.window || tab.window.isDestroyed()) {
    throw new Error("Shared browser tab is not available");
  }
  return tab.window.webContents;
}

async function handleFrame(reqUrl, res) {
  try {
    const tabId = reqUrl.searchParams.get("tabId") || reqUrl.searchParams.get("tab") || DEFAULT_TABS[0];
    const tab = await getTabForRequest(tabId);
    const image = await getTabWebContents(tab).capturePage();
    const png = image.toPNG();
    res.writeHead(200, responseHeaders("image/png", png.length));
    res.end(png);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

function sendMouseClick(tab, payload) {
  const wc = getTabWebContents(tab);
  const x = Math.max(0, Math.round(Number(payload.x || 0)));
  const y = Math.max(0, Math.round(Number(payload.y || 0)));
  const button = payload.button === "right" ? "right" : "left";
  wc.focus();
  wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
}

function sendMouseMove(tab, payload) {
  const wc = getTabWebContents(tab);
  const x = Math.max(0, Math.round(Number(payload.x || 0)));
  const y = Math.max(0, Math.round(Number(payload.y || 0)));
  wc.sendInputEvent({ type: "mouseMove", x, y });
}

function sendMouseWheel(tab, payload) {
  const wc = getTabWebContents(tab);
  const x = Math.max(0, Math.round(Number(payload.x || 0)));
  const y = Math.max(0, Math.round(Number(payload.y || 0)));
  const deltaX = Math.round(Number(payload.deltaX || 0));
  const deltaY = Math.round(Number(payload.deltaY || 0));
  wc.focus();
  wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX, deltaY });
}

function sendKey(tab, key) {
  const wc = getTabWebContents(tab);
  const keyCodeMap = {
    Backspace: "Backspace",
    Delete: "Delete",
    Enter: "Enter",
    Escape: "Escape",
    Tab: "Tab",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown"
  };
  const keyCode = keyCodeMap[key] || key;
  wc.focus();
  wc.sendInputEvent({ type: "keyDown", keyCode });
  wc.sendInputEvent({ type: "keyUp", keyCode });
}

async function handleApi(req, res, pathname, reqUrl) {
  let activeTab = null;
  // When the caller is an App User (account token), force every userId/profileId
  // to the token's own account — ignore client-supplied values so account A can
  // never read/write account B's profile, cookies or local-store.
  const isAccount = req._auth?.kind === "account";
  const authAccount = req._auth?.account || null;

  try {
    const limit = RATE_LIMITS[pathname];
    if (limit && rateLimited(`${clientIp(req)}:${pathname}`, limit[0], limit[1])) {
      sendJson(res, 429, { ok: false, error: "Too many requests" });
      return;
    }
    // Per-device cap at the origin (covers the "1 token replayed from many IPs" hole the IP-only edge misses).
    if (isAccount && authAccount) {
      const dlimit = DEVICE_RATE_LIMITS[pathname];
      if (dlimit && rateLimited(`dev:${sanitizeId(authAccount.userId, "local-user")}:${sanitizeId(authAccount.deviceId, "device")}:${pathname}`, dlimit[0], dlimit[1])) {
        sendJson(res, 429, { ok: false, error: "Too many requests (device)" });
        return;
      }
    }

    // /api/auth/login (password) ĐÃ XÓA HẲN — thay bằng đăng nhập Google. Mọi POST /api/auth/login bị
    // chặn 410 sớm (trước auth-gate) ở đầu request handler; KHÔNG còn handler nào gọi loginAccount/mint
    // session password. Để mở lại: xem plan (re-add handler + import loginAccount + isPublicApi/RATE_LIMITS).

    if (req.method === "POST" && pathname === "/api/account/lock-status") {
      // PUBLIC read (token in body): a locked/revoked token can still learn it is locked, so the App User
      // shows a clear "Tài khoản đã bị khóa" message AFTER its auth has already died. Returns {found,locked}.
      const body = await readJson(req).catch(() => ({}));
      const result = await accountLockStatus({ token: String(body.token || "") });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/google") {
      // Public route. The App User sends an OAuth authorization code (PKCE); we exchange it server-side
      // (the secret never leaves the App Server), validate the id_token claims, then map the VERIFIED
      // email to a pre-existing account (no auto-create). Downstream session/lock/single-device is identical.
      if (!GOOGLE_CLIENT_SECRET) {
        sendJson(res, 500, { ok: false, error: "Google login chua duoc cau hinh tren server" });
        return;
      }
      const gpayload = await readJson(req);
      const code = String(gpayload.code || "");
      const codeVerifier = String(gpayload.codeVerifier || "");
      const redirectUri = String(gpayload.redirectUri || "");
      const deviceId = String(gpayload.deviceId || "");
      if (!code || !codeVerifier || !redirectUri) {
        sendJson(res, 400, { ok: false, error: "Thieu tham so OAuth" });
        return;
      }
      let email = "";
      try {
        const form = new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier
        });
        const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString()
        });
        const tokenJson = await tokenRes.json().catch(() => ({}));
        if (!tokenRes.ok || !tokenJson.id_token) {
          throw new Error(tokenJson.error_description || tokenJson.error || "Khong doi duoc token Google");
        }
        const claims = decodeJwtPayload(tokenJson.id_token);
        if (String(claims.aud || "") !== GOOGLE_CLIENT_ID) throw new Error("Token Google sai aud");
        const iss = String(claims.iss || "");
        if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") throw new Error("Token Google sai iss");
        if (Number(claims.exp || 0) * 1000 <= Date.now()) throw new Error("Token Google het han");
        if (claims.email_verified !== true && String(claims.email_verified) !== "true") throw new Error("Email Google chua xac thuc");
        email = String(claims.email || "").trim().toLowerCase();
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || "Xac thuc Google that bai" });
        return;
      }
      if (!email) {
        sendJson(res, 400, { ok: false, error: "Khong lay duoc email tu Google" });
        return;
      }
      let account;
      try {
        account = await loginAccountGoogle({ email, deviceId, deviceJkt: gpayload.deviceJkt });
      } catch (error) {
        const m = String(error.message || "");
        const friendly = /bi tat|bi khoa|locked|disabled|đã bị khóa/i.test(m)
          ? "Tài khoản đã bị khóa — liên hệ quản trị viên"
          : (m || "Tai khoan chua duoc cap");
        sendJson(res, 403, { ok: false, error: friendly });
        return;
      }
      try { const gs = sessState(account?.token, true); if (gs) { gs.loginAt = Date.now(); gs.ua = req.headers["user-agent"] || ""; } } catch { /* best-effort */ }
      const serverUrl = String(gpayload.serverUrl || requestBaseUrl(req)).trim().replace(/\/+$/, "");
      const respDeviceId = account.deviceId || deviceId || account.userId;
      recordUserActivity({
        userId: account.userId,
        deviceId: respDeviceId,
        profileId: account.profileId || DEFAULT_PROFILE,
        serviceId: "auth",
        action: account.newDevice ? "login-google-new-device" : "login-google",
        title: account.email || "",
        details: JSON.stringify({ ip: clientIp(req), via: "google" })
      }).catch(() => {});
      sendJson(res, 200, {
        ok: true,
        account: { email: account.email, userId: account.userId, profileId: account.profileId, user: account.user },
        connection: {
          serverUrl,
          token: account.token,
          userId: account.userId,
          deviceId: respDeviceId,
          profileId: account.profileId || DEFAULT_PROFILE,
          expiresAt: account.expiresAt || null,
          newDevice: Boolean(account.newDevice),
          sessionKey: account.sessionKey || "",
          tokenType: "account"
        }
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/webhook/sepay") {
      // SePay bank-transaction webhook (PUBLIC route — SePay servers call it, no app session). SePay signs
      // EVERY delivery with your Secret Key using HMAC-SHA256 over the string `{timestamp}.{raw_body}` and
      // sends two headers:
      //   X-SePay-Signature: sha256=<hex>
      //   X-SePay-Timestamp: <unix_seconds>
      // We recompute the HMAC over the RAW request bytes (NEVER a re-serialized JSON — that would change
      // the bytes and break the signature) and timing-safe compare. Verified ONLY when CENTRIX_SEPAY_SECRET
      // is set (set the SAME Secret Key in the SePay dashboard AND this server). When it is unset we accept
      // + log a warning so the endpoint is reachable while wiring SePay. NOTE: a Cloudflare Skip rule for
      // /api/webhook/sepay is still required (SePay won't send X-CentriX-App-Key).
      const chunks = [];
      let total = 0;
      try {
        for await (const chunk of req) {
          chunks.push(chunk);
          total += chunk.length;
          if (total > 1_000_000) { sendJson(res, 413, { success: false, error: "Payload too large" }); return; }
        }
      } catch { /* fall through with whatever we have */ }
      const rawBuf = Buffer.concat(chunks);
      const secret = String(process.env.CENTRIX_SEPAY_SECRET || "").trim();
      if (secret) {
        const ts = String(req.headers["x-sepay-timestamp"] || "");
        const sig = String(req.headers["x-sepay-signature"] || "");
        const expected = "sha256=" + crypto.createHmac("sha256", secret)
          .update(Buffer.concat([Buffer.from(ts + ".", "utf8"), rawBuf]))
          .digest("hex");
        const a = Buffer.from(sig, "utf8");
        const b = Buffer.from(expected, "utf8");
        const sigOk = a.length === b.length && crypto.timingSafeEqual(a, b);
        // Replay window: idempotency (dedupe by SePay id) already blocks double-credit, so this is
        // defense-in-depth and ENFORCED ONLY if CENTRIX_SEPAY_MAX_SKEW_SEC > 0 (avoids false rejects from
        // clock drift when left at the default 0 = disabled).
        const maxSkew = Number(process.env.CENTRIX_SEPAY_MAX_SKEW_SEC || 0);
        const tsFresh = !maxSkew || (Number(ts) > 0 && Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) <= maxSkew);
        if (!sigOk || !tsFresh) {
          sendJson(res, 401, { success: false, error: "Invalid signature" });
          return;
        }
      } else {
        // FAIL CLOSED: with no secret we cannot authenticate the sender, so a forged POST could credit a
        // wallet for free. Reject instead of accepting unverified. 503 (not 401) so SePay keeps retrying —
        // a real payment during the misconfig window is redelivered once the secret is set.
        console.error("[sepay-webhook] CENTRIX_SEPAY_SECRET is not set — REJECTING webhook (fail-closed). Set it to enable auto-credit.");
        sendJson(res, 503, { success: false, error: "SePay webhook not configured" });
        return;
      }
      let body = {};
      try { const raw = rawBuf.toString("utf8"); body = raw.trim() ? JSON.parse(raw) : {}; } catch { body = {}; }
      try {
        const result = await processSepayWebhook(body);
        // SePay treats a 2xx (and {"success": true}) as delivered.
        sendJson(res, 200, { success: true, ...result });
      } catch (error) {
        // Non-2xx => SePay retries the delivery later (don't drop a real payment on a transient outage).
        sendJson(res, 502, { success: false, error: error.message || "sepay webhook failed" });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        app: "CentriX Shared Browser Server",
        tokenRequired: REQUIRE_TOKEN,
        host: HOST,
        port: PORT,
        localUrl: localBaseUrl(),
        lanUrls: lanAddresses().map((address) => `http://${address}:${PORT}`),
        firewall: { ...firewallStatus },
        tunnel: tunnelSnapshot(),
        defaultTabs: DEFAULT_TABS,
        profileSync: true,
        staffRbac: STAFF_RBAC
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/tunnel") {
      sendJson(res, 200, {
        ok: true,
        tunnel: tunnelSnapshot()
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/tunnel/config") {
      sendJson(res, 200, {
        ok: true,
        config: publicTunnelConfigSnapshot()
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/tabs") {
      sendJson(res, 200, {
        ok: true,
        tabs: allTabStates()
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/local-db") {
      sendJson(res, 200, {
        ok: true,
        db: await readLocalDb()
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/users") {
      const db = await readLocalDb();
      const servicesConfig = await readServicesConfig();
      sendJson(res, 200, {
        ok: true,
        db,
        users: db.users,
        services: servicesConfig.services,
        serviceVisibility: db.serviceVisibility,
        uiRules: db.uiRules,
        uiRuleReports: db.uiRuleReports || [],
        modelPolicies: db.modelPolicies || [],
        modelPrices: db.modelPrices || [],
        modelUsage: db.modelUsage || [],
        modelObservations: db.modelObservations || [],
        creditWallets: db.creditWallets || [],
        creditTransactions: db.creditTransactions || [],
        localStoreCount: db.localStore.length,
        uiCacheItems: db.uiCacheItems || [],
        uiCacheCount: (db.uiCacheItems || []).length,
        activity: db.activity.slice(-250)
      });
      return;
    }

    // Website: "who am I?" — returns the staff resolved from the httpOnly cookie (or master as a synthetic
    // owner). The SPA calls this on boot to decide login state + permissions (replaces the legacy
    // localStorage token signal). Not logged in => the auth gate already returned 401 before this handler.
    if (req.method === "GET" && pathname === "/api/auth/staff-whoami") {
      const a = req._auth;
      if (a && a.kind === "staff") { sendJson(res, 200, { ok: true, staff: a.staff }); return; }
      if (a && a.kind === "master") {
        sendJson(res, 200, { ok: true, staff: { username: "master", displayName: "Chủ sở hữu (master)", role: "owner", isOwner: true, permissions: ["*"] } });
        return;
      }
      sendJson(res, 401, { ok: false, error: "Chưa đăng nhập" });
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/summary") {
      const result = await getAdminSummary();
      sendJson(res, 200, {
        ok: true,
        summary: result.summary,
        db: result.db
      });
      return;
    }

    // Admin-console staff accounts + roles (Nhóm & Phân quyền). Gated to the "roles" view (Owner) for
    // staff; master always allowed. Account tokens are blocked by the allowlist gate.
    if (req.method === "GET" && pathname === "/api/admin/staff") {
      const result = await adminAccountList();
      sendJson(res, 200, { ok: true, accounts: result.accounts || [] });
      return;
    }
    if (req.method === "GET" && pathname === "/api/admin/roles") {
      const result = await adminRoleList();
      sendJson(res, 200, { ok: true, roles: result.roles || [] });
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/credits/ledger") {
      const db = await readLocalDb();
      sendJson(res, 200, {
        ok: true,
        wallets: db.creditWallets || [],
        transactions: db.creditTransactions || [],
        db
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/model-prices") {
      const db = await readLocalDb();
      sendJson(res, 200, {
        ok: true,
        modelPrices: db.modelPrices || [],
        db
      });
      return;
    }

    if (req.method === "GET" && [
      "/api/admin/portal",
      "/api/admin/organizations",
      "/api/admin/billing",
      "/api/admin/support",
      "/api/admin/settings",
      "/api/admin/roles",
      "/api/admin/promotions"
    ].includes(pathname)) {
      const result = await getPortalSnapshot();
      sendJson(res, 200, {
        ok: true,
        portal: result.portal,
        db: result.db
      });
      return;
    }

    // LEAN live-chat poll: only the livechat threads (~KB) instead of the full 12MB portal snapshot, so the
    // 1.5s "Chat trực tiếp" poll is near-instant. The agent's send still goes through POST /api/admin/livechat.
    if (req.method === "GET" && pathname === "/api/admin/livechat") {
      const result = await getLivechatThreads();
      sendJson(res, 200, { ok: true, threads: (result && result.threads) || [] });
      return;
    }

    if (req.method === "GET" && pathname === "/api/users/local-store") {
      const userId = isAccount ? sanitizeId(authAccount.userId, "local-user") : requestUserId(req, reqUrl);
      const profileId = isAccount ? sanitizeId(authAccount.profileId, DEFAULT_PROFILE) : requestProfileId(req, reqUrl);
      const serviceId = reqUrl.searchParams.get("serviceId") || "";
      const origin = reqUrl.searchParams.get("origin") || "";
      sendJson(res, 200, {
        ok: true,
        store: await getUserLocalStore({ userId, profileId, serviceId, origin })
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/users/ui-cache") {
      const userId = isAccount ? sanitizeId(authAccount.userId, "local-user") : requestUserId(req, reqUrl);
      const profileId = isAccount ? sanitizeId(authAccount.profileId, DEFAULT_PROFILE) : requestProfileId(req, reqUrl);
      const serviceId = reqUrl.searchParams.get("serviceId") || "";
      sendJson(res, 200, {
        ok: true,
        cache: await getUserUiCache({ userId, profileId, serviceId })
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/users/activity") {
      const userId = isAccount ? sanitizeId(authAccount.userId, "local-user") : requestUserId(req, reqUrl);
      const profileId = isAccount ? sanitizeId(authAccount.profileId, DEFAULT_PROFILE) : requestProfileId(req, reqUrl);
      const serviceId = reqUrl.searchParams.get("serviceId") || "";
      const limit = Math.max(1, Math.min(500, Math.round(Number(reqUrl.searchParams.get("limit") || 250))));
      const result = await getUserActivity({ userId, profileId, serviceId, limit });
      sendJson(res, 200, {
        ok: true,
        activity: result.activity || []
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/users/url-history") {
      const userId = isAccount ? sanitizeId(authAccount.userId, "local-user") : requestUserId(req, reqUrl);
      const limit = Math.max(1, Math.min(300, Math.round(Number(reqUrl.searchParams.get("limit") || 300))));
      const result = await getUrlHistory({ userId, limit });
      sendJson(res, 200, {
        ok: true,
        urlHistory: result.urlHistory || []
      });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/users/portal/")) {
      const userId = isAccount ? sanitizeId(authAccount.userId, "local-user") : requestUserId(req, reqUrl);
      const portal = await getUserPortal({ userId });
      portal.paymentConfig = vietqrPaymentConfig(); // VietQR bank account (env-driven; App User builds the QR)
      sendJson(res, 200, {
        ok: true,
        portal,
        summary: {
          balance: Number(portal.wallet?.balance || 0),
          packages: (portal.packages || []).length,
          orders: (portal.orders || []).length,
          invoices: (portal.invoices || []).length,
          tickets: (portal.tickets || []).length,
          organizations: (portal.organization || []).length
        }
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/me") {
      // Account-scoped read of the caller's own wallet (App User credit display).
      const meUserId = isAccount ? sanitizeId(authAccount.userId, "local-user") : requestUserId(req, reqUrl);
      // Fresh, user-SCOPED read straight from Docker (see getUserCreditSummary) — avoids the full ~12MB
      // readLocalDb() that timed out under load and fell back to the stale JSON cache, which made the App
      // User balance flicker back up to the pre-charge value.
      const summary = await getUserCreditSummary(meUserId).catch(() => null);
      const wallet = summary?.wallet || {};
      const userTxns = Array.isArray(summary?.transactions) ? summary.transactions : [];
      const userActivity = Array.isArray(summary?.activity) ? summary.activity : [];
      const today = new Date().toISOString().slice(0, 10);
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM (current calendar month, UTC)
      const debits = userTxns.filter((tx) => tx.type === "debit");
      const spentToday = debits
        .filter((tx) => String(tx.createdAt || "").slice(0, 10) === today)
        .reduce((sum, tx) => sum + Math.abs(Number(tx.amountDelta || 0)), 0);
      const spentThisMonth = debits
        .filter((tx) => String(tx.createdAt || "").slice(0, 7) === month)
        .reduce((sum, tx) => sum + Math.abs(Number(tx.amountDelta || 0)), 0);
      // Recent credit activity (debit/topup/adjust) for the "Hoạt động gần đây" list — newest first.
      const recentTransactions = userTxns
        .slice(-40)
        .reverse()
        .map((tx) => ({
          type: tx.type || "",
          amountDelta: Number(tx.amountDelta || 0),
          balanceAfter: Number(tx.balanceAfter || 0),
          modelId: tx.modelId || "",
          serviceId: tx.serviceId || "",
          reason: tx.reason || "",
          createdAt: tx.createdAt || ""
        }));
      // Combined usage history for the "Lịch sử" tab: credit txns + open-service + login, newest first.
      // Credit usage is always kept in full; service-opens and logins are capped + de-duplicated so a
      // single device repeatedly opening the same service / re-logging in cannot flood the feed and
      // push the meaningful credit history out of the 40-row window.
      const histItems = recentTransactions.map((t) => ({
        kind: t.type,
        modelId: t.modelId,
        serviceId: t.serviceId,
        amountDelta: t.amountDelta,
        createdAt: t.createdAt
      }));
      const opensRaw = [];
      const logins = [];
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
      for (const o of opensRaw) {
        const prev = opens[opens.length - 1];
        if (prev && prev.serviceId === o.serviceId) continue; // collapse back-to-back opens of the same service
        opens.push(o);
        if (opens.length >= 15) break;
      }
      logins.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const recentHistory = [...histItems, ...opens, ...logins.slice(0, 5)]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 40);
      sendJson(res, 200, {
        ok: true,
        userId: meUserId,
        email: isAccount ? authAccount.email : "",
        balance: Number(wallet.balance || 0),
        lifetimeAdded: Number(wallet.lifetimeAdded || 0),
        lifetimeSpent: Number(wallet.lifetimeSpent || 0),
        spentToday,
        spentThisMonth,
        recentTransactions,
        recentHistory
      });
      return;
    }

    if (req.method === "GET" && (pathname === "/api/services" || pathname === "/api/admin/services")) {
      const config = await readServicesConfig();
      if (isAccount || requestHasUserScope(req, reqUrl)) {
        const scopeUserId = isAccount ? sanitizeId(authAccount.userId, "local-user") : requestUserId(req, reqUrl);
        const scoped = await servicesForUser(config, scopeUserId);
        sendJson(res, 200, {
          ok: true,
          source: "server-api",
          serviceCount: scoped.config?.services?.length || 0,
          config: scoped.config,
          user: scoped.user,
          uiRules: scoped.uiRules,
          modelPolicies: scoped.modelPolicies || [],
          localDbPath: scoped.filePath
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        source: "server-api",
        serviceCount: config?.services?.length || 0,
        config
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/profile/revision") {
      // Cheap revision probe so App Users can detect a profile the admin just loaded (via the loader
      // browser) and re-sync WITHOUT a full export/import or a restart.
      const profileId = isAccount ? authAccount.profileId : (reqUrl.searchParams.get("profileId") || DEFAULT_PROFILE);
      const { profileId: cleanProfileId } = await getProfileSession(profileId);
      // Piggyback the single-device eviction signal on this 5s poll so the evicted device can start its
      // graceful 5s logout countdown without any extra request.
      const evict = isAccount ? evictionStatusFor(sanitizeId(authAccount.userId, "local-user"), sanitizeId(authAccount.deviceId, "device")) : null;
      sendJson(res, 200, { ok: true, revision: profileRevision(cleanProfileId), evict });
      return;
    }

    if (req.method === "GET" && pathname === "/api/profile/export") {
      // Hard-gate (P0): a real client interacts before pulling cookies; a login->export bot does not.
      if (isAccount && EXPORT_GATE) {
        const tk = headerTokenOf(req);
        const gs = sessState(tk);
        const ua = req.headers["user-agent"] || "";
        const attestOk = verifyAttest(req.headers["x-centrix-user"], req.headers["x-centrix-attest"]);
        const sigOk = verifyExportSig(tk, authAccount.profileId, req.headers["x-centrix-sig"]);
        const dpopRes = verifyDeviceProof(req.headers["x-centrix-proof"], { expectedJkt: authAccount.deviceJkt || "", token: tk });
        const dpopOk = dpopRes.ok; // DPoP device-binding (log-only unless CENTRIX_BIND_DEVICE_KEY=1)
        const firstIp = sessionFirstIp.get(tk);
        const ipChanged = !!(firstIp && firstIp !== clientIp(req));
        const deviceNew = isDeviceNew(authAccount.userId, authAccount.deviceId);
        const interacted = !!(gs && gs.interactedAt && Date.now() - gs.interactedAt < EXPORT_INTERACT_TTL_MS);
        const score = exportRiskScore(gs, ua, { attestOk, ipChanged, deviceNew, sigOk });
        recordUserActivity({
          userId: authAccount.userId, deviceId: authAccount.deviceId || "device",
          profileId: sanitizeId(authAccount.profileId, DEFAULT_PROFILE), serviceId: "auth",
          action: "export-gate", title: "Cookie export gate",
          details: JSON.stringify({ ip: clientIp(req), score, interacted, attestOk, sigOk, dpopOk, dpopReason: dpopRes.reason || "", boundJkt: Boolean(authAccount.deviceJkt), deviceNew, ipChanged, ua: String(ua).slice(0, 80) })
        }).catch(() => {});
        // Always-on: a real client interacts before pulling. Strict (enable after every client ships
        // attest+UA): also require valid attestation + the CentriX client UA, and deny on high score.
        const strictBlock = EXPORT_GATE_STRICT && (!attestOk || uaIsScript(ua) || !uaIsClient(ua) || score >= 70);
        const requireSigBlock = EXPORT_REQUIRE_SIG && !sigOk;
        const requireDeviceBlock = BIND_DEVICE_KEY && authAccount.deviceJkt && !dpopOk; // enforce only when flag on + session is bound
        if (!interacted || strictBlock || requireSigBlock || requireDeviceBlock) {
          const reason = !interacted ? "no-client-interaction" : (requireDeviceBlock ? "device-binding" : (requireSigBlock ? "bad-signature" : (!attestOk ? "attestation" : (score >= 70 ? "risk" : "client-fingerprint"))));
          sendJson(res, 403, { ok: false, error: "export-blocked", reason, score });
          return;
        }
      }
      const profileId = isAccount ? authAccount.profileId : (reqUrl.searchParams.get("profileId") || DEFAULT_PROFILE);
      const includeStorage = reqUrl.searchParams.get("includeStorage") !== "0";
      const { targetSession, profileId: cleanProfileId } = await getProfileSession(profileId);
      const config = await readServicesConfig();
      // Data minimization: an App User only gets storage for the services it is
      // actually granted + enabled (skip disabled / not-visible services). Admin
      // (master token) still exports the full set.
      const exportServices = isAccount
        ? ((await servicesForUser(config, authAccount.userId)).config?.services || [])
        : config.services;
      const snapshot = await exportProfileSnapshot(targetSession, {
        profileId: cleanProfileId,
        services: exportServices,
        includeStorage,
        scopeCookies: isAccount
      });

      await recordUserActivity({
        userId: isAccount ? authAccount.userId : "admin",
        deviceId: (isAccount ? authAccount.deviceId : "") || "device",
        profileId: cleanProfileId,
        serviceId: "profile",
        action: "profile-pull",
        details: JSON.stringify({ ip: clientIp(req), cookies: snapshot.cookies.length, storage: snapshot.storage.length, includeStorage })
      }).catch(() => {});

      const summary = {
        profileId: cleanProfileId,
        cookies: snapshot.cookies.length,
        origins: snapshot.origins.length,
        storage: snapshot.storage.length
      };
      const revision = profileRevision(cleanProfileId);
      const pullKey = isAccount ? (authAccount.sessionKey || "") : MASTER_SNAPSHOT_KEY;
      // App Users always get the snapshot encrypted with their per-session key. The master/admin token
      // gets it encrypted with CENTRIX_MASTER_SNAPSHOT_KEY when set; raw plaintext is refused unless
      // CENTRIX_ALLOW_PLAINTEXT_SNAPSHOT=1 (audited). A legacy account session with no key keeps working.
      if (pullKey) {
        sendJson(res, 200, { ok: true, encrypted: encryptSnapshot(snapshot, pullKey), revision, summary });
      } else if (isAccount || ALLOW_PLAINTEXT_SNAPSHOT) {
        if (!isAccount) {
          await recordUserActivity({
            userId: "admin", deviceId: "device", profileId: cleanProfileId, serviceId: "profile",
            action: "profile-pull-plaintext", title: "Admin pull plaintext",
            details: JSON.stringify({ ip: clientIp(req) })
          }).catch(() => {});
        }
        sendJson(res, 200, { ok: true, snapshot, revision, summary });
      } else {
        sendJson(res, 403, { ok: false, error: "Admin plaintext snapshot disabled. Set CENTRIX_MASTER_SNAPSHOT_KEY (base64 32B) or CENTRIX_ALLOW_PLAINTEXT_SNAPSHOT=1." });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const tabId = reqUrl.searchParams.get("tabId") || reqUrl.searchParams.get("tab") || DEFAULT_TABS[0];
      activeTab = await getTabForRequest(tabId);
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    const payload = await readJson(req);
    const tabId = payload.tabId || reqUrl.searchParams.get("tabId") || DEFAULT_TABS[0];
    const scopedUserId = requestUserId(req, reqUrl, payload);
    const scopedProfileId = requestProfileId(req, reqUrl, payload);
    // For account tokens these override anything the client sent; for master they
    // fall back to the request-derived scope (admin can act on any user).
    const effectiveUserId = isAccount ? sanitizeId(authAccount.userId, "local-user") : scopedUserId;
    const effectiveProfileId = isAccount ? sanitizeId(authAccount.profileId, DEFAULT_PROFILE) : scopedProfileId;

    if (pathname === "/api/local-db/reset") {
      const db = await resetLocalDb();
      sendJson(res, 200, {
        ok: true,
        db
      });
      return;
    }

    if (pathname === "/api/auth/revoke") {
      // Master-only (account tokens are blocked by the allowlist gate). Revoke a
      // session token, or kick a user/device (all their sessions).
      const result = await revokeSession({
        token: payload.token,
        userId: payload.userId,
        deviceId: payload.deviceId
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === "/api/auth/self-revoke") {
      // Account self-revoke (logout): revoke ONLY the caller's own session token, taken from the
      // authenticated request — never from the body — so it can never revoke another user's session.
      const selfToken = isAccount ? headerTokenOf(req) : "";
      if (!selfToken) {
        sendJson(res, 400, { ok: false, error: "No account session to revoke" });
        return;
      }
      const result = await revokeSession({ token: selfToken });
      // Logout/eviction also frees this account's active-device slot immediately.
      try { clearActiveDeviceIfHolder(sanitizeId(authAccount.userId, "local-user"), sanitizeId(authAccount.deviceId, "device")); } catch { /* best-effort */ }
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "POST" && pathname === "/api/users/change-password") {
      // Account self-service. Email comes from the AUTHENTICATED token (authAccount.email), NEVER from
      // the body — like /api/auth/self-revoke — so account A can never change account B's password.
      if (!isAccount || !authAccount?.email) {
        sendJson(res, 403, { ok: false, error: "Account session required" });
        return;
      }
      const currentPassword = String(payload.currentPassword || "");
      const newPassword = String(payload.newPassword || "");
      if (newPassword.length < 6) {
        sendJson(res, 400, { ok: false, error: "Mat khau moi phai tu 6 ky tu tro len" });
        return;
      }
      if (newPassword === currentPassword) {
        sendJson(res, 400, { ok: false, error: "Mat khau moi phai khac mat khau hien tai" });
        return;
      }
      try {
        await changeAccountPassword({ email: authAccount.email, currentPassword, newPassword });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || "Doi mat khau that bai" });
        return;
      }
      recordUserActivity({
        userId: authAccount.userId,
        deviceId: authAccount.deviceId,
        profileId: authAccount.profileId || DEFAULT_PROFILE,
        serviceId: "auth",
        action: "change-password",
        title: authAccount.email || "",
        details: JSON.stringify({ ip: clientIp(req) })
      }).catch(() => {});
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/profile/lock") {
      const lockProfileId = effectiveProfileId;
      const lockDeviceId = isAccount ? sanitizeId(authAccount.deviceId, "device") : sanitizeId(payload.deviceId, "device");
      // Single-active-device-per-account gate (with takeover). Real accounts only; master is exempt.
      if (isAccount) {
        const claim = claimActiveDevice(effectiveUserId, lockDeviceId, headerTokenOf(req), lockProfileId);
        if (!claim.ok) {
          sendJson(res, 423, {
            ok: false,
            locked: false,
            reason: claim.reason,                         // "device_active" | "takeover_pending"
            activeDevice: claim.activeDevice || null,
            graceMs: claim.graceMs || TAKEOVER_GRACE_MS,
            profileId: lockProfileId
          });
          return;
        }
      }
      const result = acquireProfileLock(lockProfileId, lockDeviceId, effectiveUserId);
      sendJson(res, result.ok ? 200 : 423, {
        ok: result.ok,
        locked: result.ok,
        profileId: lockProfileId,
        revision: profileRevision(lockProfileId),
        holder: result.holder || null,
        lockTtlMs: PROFILE_LOCK_TTL_MS
      });
      return;
    }

    if (pathname === "/api/profile/release") {
      const lockProfileId = effectiveProfileId;
      const lockDeviceId = isAccount ? sanitizeId(authAccount.deviceId, "device") : sanitizeId(payload.deviceId, "device");
      const released = releaseProfileLock(lockProfileId, lockDeviceId);
      // A graceful logout/eviction frees this account's active-device slot so the next device gets in.
      if (isAccount) clearActiveDeviceIfHolder(effectiveUserId, lockDeviceId);
      sendJson(res, 200, { ok: true, released });
      return;
    }

    if (pathname === "/api/profile/takeover") {
      // The NEW device asks to evict whatever device currently holds this account. We only soft-mark the
      // eviction here; the old device sees it on its next revision/heartbeat poll and logs out gracefully.
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Forbidden" }); return; }
      const newDeviceId = sanitizeId(authAccount.deviceId, "device");
      const r = requestAccountTakeover(effectiveUserId, newDeviceId);
      sendJson(res, 200, { ok: true, evicting: r.evicting === true, graceMs: r.graceMs || TAKEOVER_GRACE_MS });
      return;
    }

    if (pathname === "/api/users/save") {
      const db = await upsertUser(payload.user || payload);
      sendJson(res, 200, {
        ok: true,
        db
      });
      return;
    }

    if (pathname === "/api/users/service") {
      const db = await setUserServiceVisibility(
        payload.userId || scopedUserId,
        payload.serviceId,
        payload.visible !== false
      );
      sendJson(res, 200, {
        ok: true,
        db
      });
      return;
    }

    if (pathname === "/api/users/ui-rules") {
      const db = await setUserUiRules(
        payload.userId || scopedUserId,
        payload.serviceId,
        payload.hideSelectors || [],
        payload.enabled === true,
        payload.replaceRules || [],
        payload.hideRules || [],
        payload.userScript || ""
      );
      sendJson(res, 200, {
        ok: true,
        db
      });
      return;
    }

    if (pathname === "/api/users/model-policy") {
      const db = await setUserModelPolicy({
        ...payload,
        userId: payload.userId || scopedUserId,
        serviceId: payload.serviceId
      });
      sendJson(res, 200, {
        ok: true,
        db
      });
      return;
    }

    if (pathname === "/api/users/model-usage/check") {
      const usageServiceId = sanitizeId(payload.serviceId || "service", "service");
      const usageConfig = await readServicesConfig().catch(() => null);
      const usageScoped = usageConfig
        ? await servicesForUser(usageConfig, effectiveUserId).catch(() => null)
        : null;
      const usageService = (usageScoped?.config?.services || usageConfig?.services || [])
        .find((service) => sanitizeId(service.id, "service") === usageServiceId) || null;
      const result = await checkUserModelUsage({
        ...payload,
        userId: effectiveUserId,
        serviceId: usageServiceId,
        serviceDefaultModel: usageService?.defaultModel || "",
        serviceDefaultCreditCost: usageService?.defaultCreditCost || 1,
        consume: payload.consume !== false
      });
      const usageModelId = String(result.modelId || payload.modelId || usageService?.defaultModel || "").trim();
      // The OBSERVED model must be the RAW model the user actually selected — including any reasoning
      // effort suffix (e.g. "claude-opus-4-8_max", "gpt-5-5-thinking_extended") — NOT result.modelId,
      // which the server may have resolved DOWN to the base model for billing (the effort-tier
      // combined→base fallback in check_model_usage). This is what feeds the admin "MODEL GHI NHẬN TỪ
      // TRÌNH DUYỆT" list so each effort tier surfaces and can be priced separately. Billing is
      // unaffected (it already charged the resolved base inside checkUserModelUsage).
      const observedModelId = String(payload.modelId || result.modelId || usageService?.defaultModel || "").trim();
      if (payload.consume !== false && result.idempotent !== true) {
        if (observedModelId) {
          await observeModel({
            serviceId: usageServiceId,
            modelId: observedModelId,
            source: "user",
            url: payload.url || ""
          }).catch(() => {});
        }
        await recordUserActivity({
          userId: effectiveUserId,
          deviceId: isAccount ? sanitizeId(authAccount.deviceId, "device") : sanitizeId(payload.deviceId || effectiveUserId, "device"),
          profileId: effectiveProfileId,
          serviceId: usageServiceId,
          action: result.allowed === false ? "model-blocked" : "model-usage",
          url: payload.url || "",
          title: usageModelId || "unknown model",
          details: JSON.stringify({
            modelId: usageModelId || result.modelId || "",
            requestedModelId: payload.modelId || "",
            detectedModelId: payload.detectedModelId || "",
            defaultedModel: Boolean(result.defaultedModel),
            usageRequestId: payload.usageRequestId || payload.idempotencyKey || "",
            creditCost: result.creditCost ?? null,
            balance: result.balance ?? null,
            remaining: result.remaining ?? null,
            count: result.usage?.count ?? null,
            credits: result.usage?.credits ?? null,
            reason: result.reason || ""
          })
        }).catch(() => {});
      }
      sendJson(res, 200, {
        ok: true,
        ...result
      });
      return;
    }

    if (pathname === "/api/admin/credits/adjust") {
      const db = await adjustUserCredit({
        ...payload,
        userId: payload.userId || scopedUserId,
        actor: payload.actor || "admin"
      });
      sendJson(res, 200, {
        ok: true,
        db
      });
      return;
    }

    if (pathname === "/api/admin/accounts/set-locked") {
      // App Server "Khóa / Mở tài khoản" — master-token only (NOT in ACCOUNT_ALLOWED_PATHS). Flips both
      // enabled flags + revokes sessions in the Docker DB so enforcement is immediate.
      const result = await setAccountLocked({ userId: payload.userId || "", locked: !!payload.locked });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (pathname === "/api/admin/model-prices") {
      const db = await setModelPrices(payload);
      sendJson(res, 200, {
        ok: true,
        db
      });
      return;
    }

    if (pathname === "/api/admin/plans/list") {
      sendJson(res, 200, { ok: true, ...(await plansList(payload)) });
      return;
    }
    if (pathname === "/api/admin/plans/assign") {
      sendJson(res, 200, { ok: true, ...(await assignUserPlan(payload)) });
      return;
    }
    if (pathname === "/api/admin/plans/access") {
      sendJson(res, 200, { ok: true, ...(await setPlanAccess(payload)) });
      return;
    }
    if (pathname === "/api/admin/plans/save") {
      sendJson(res, 200, { ok: true, ...(await savePlan(payload)) });
      return;
    }
    if (pathname === "/api/admin/plans/gate") {
      sendJson(res, 200, { ok: true, ...(await setPlanGate(payload)) });
      return;
    }
    if (pathname === "/api/admin/portal") {
      // Staff sub-gate: this single route writes every portal section; authorize by section→view.
      const sgStaff = req._auth && req._auth.kind === "staff" ? req._auth.staff : null;
      if (sgStaff && !(sgStaff.isOwner || (sgStaff.permissions || []).includes("*"))) {
        const sectionView = STAFF_PORTAL_SECTION_VIEW[String(payload.section || "")] || null;
        const allowed = sectionView ? staffCan(sectionView, sgStaff.permissions) : false;
        if (STAFF_RBAC === "on" && !allowed) { sendJson(res, 403, { ok: false, error: "Không đủ quyền", view: sectionView }); return; }
        if (STAFF_RBAC === "log" && !allowed) console.warn(`[staff-rbac:log] ${sgStaff.username} POST /api/admin/portal section=${payload.section} view=${sectionView} -> WOULD-BLOCK`);
      }
      const result = await setPortalSection(payload);
      sendJson(res, 200, {
        ok: true,
        portal: result.portal,
        db: result.db
      });
      return;
    }

    // ── Admin console: staff login / logout + account & role management (App Server RBAC) ─────────
    if (pathname === "/api/auth/staff-login") {
      if (STAFF_RBAC === "off") { sendJson(res, 410, { ok: false, error: "Đăng nhập nhân viên chưa bật" }); return; }
      if (rateLimited(`stafflogin:${clientIp(req)}`, 5, 60000)) { sendJson(res, 429, { ok: false, error: "Quá nhiều lần thử, đợi 1 phút" }); return; }
      let staff;
      try {
        staff = await adminLogin({ username: payload.username || payload.email, password: payload.password });
      } catch (error) {
        sendJson(res, 401, { ok: false, error: error.message || "Đăng nhập thất bại" });
        return;
      }
      const token = `stf_${crypto.randomBytes(24).toString("base64url")}`;
      const expiresAt = Date.now() + STAFF_TTL_MS;
      adminSessions.set(token, { ...staff, expiresAt });
      // Set the session as an httpOnly cookie (website). Token is NOT returned in the body — the SPA
      // authenticates purely via the cookie the browser auto-sends same-origin.
      res.setHeader("Set-Cookie", staffCookie(token, Math.floor(STAFF_TTL_MS / 1000)));
      sendJson(res, 200, { ok: true, expiresAt, staff });
      return;
    }
    if (pathname === "/api/auth/staff-logout") {
      const tk = headerTokenOf(req) || cookieTokenOf(req);
      if (tk) adminSessions.delete(tk);
      res.setHeader("Set-Cookie", "cxsid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
      sendJson(res, 200, { ok: true });
      return;
    }

    // Staff/role management guard: a staff caller must hold the "roles" view; role/permission edits and
    // granting Owner require an Owner. Master token (mgr === null) is unrestricted.
    if (pathname === "/api/admin/staff/save" || pathname === "/api/admin/staff/delete" ||
        pathname === "/api/admin/roles/save" || pathname === "/api/admin/roles/delete") {
      const mgr = req._auth && req._auth.kind === "staff" ? req._auth.staff : null;
      if (mgr && !staffCan("roles", mgr.permissions)) { sendJson(res, 403, { ok: false, error: "Không đủ quyền" }); return; }
      const ownerOnly = pathname.startsWith("/api/admin/roles/") ||
        (pathname === "/api/admin/staff/save" && (payload.isOwner || String(payload.role || "") === "owner"));
      if (ownerOnly && mgr && !mgr.isOwner) { sendJson(res, 403, { ok: false, error: "Chỉ chủ sở hữu mới chỉnh vai trò/quyền" }); return; }
    }
    if (pathname === "/api/admin/staff/save") {
      const username = String(payload.username || payload.email || "").trim().toLowerCase();
      try {
        const result = await adminAccountSave(payload);
        revokeAdminSessionsFor(username); // role/perm/enabled change → force re-login with fresh perms
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || "Lỗi lưu nhân viên" });
      }
      return;
    }
    if (pathname === "/api/admin/staff/delete") {
      const username = String(payload.username || "").trim().toLowerCase();
      try {
        await adminAccountDelete({ username });
        revokeAdminSessionsFor(username);
        sendJson(res, 200, { ok: true, username });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || "Lỗi xóa nhân viên" });
      }
      return;
    }
    if (pathname === "/api/admin/roles/save") {
      try {
        const result = await adminRoleUpsert({ roleKey: payload.roleKey, name: payload.name, perms: payload.perms });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || "Lỗi lưu vai trò" });
      }
      return;
    }
    if (pathname === "/api/admin/roles/delete") {
      try {
        const result = await adminRoleDelete({ roleKey: payload.roleKey });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || "Lỗi xóa vai trò" });
      }
      return;
    }

    // Live chat (App Server "Chat trực tiếp"): append an AGENT message to a user's livechat thread.
    // Atomic server-side append (no read-modify-write race with the user's own sends). Master only.
    if (pathname === "/api/admin/livechat") {
      if (isAccount) { sendJson(res, 403, { ok: false, error: "Master token required" }); return; }
      const result = await appendLivechatMessage({ userId: sanitizeId(payload.userId, "local-user"), from: "agent", text: payload.text });
      sendJson(res, 200, { ok: true, record: result.record, portal: result.portal });
      return;
    }

    if (pathname === "/api/admin/billing/approve") {
      const result = await approvePortalTopup({
        ...payload,
        actor: payload.actor || "admin"
      });
      sendJson(res, 200, {
        ok: true,
        order: result.order,
        portal: result.portal,
        db: result.db
      });
      return;
    }

    if (pathname === "/api/users/portal/topup-request") {
      const result = await createPortalTopupRequest({
        ...payload,
        userId: effectiveUserId
      });
      sendJson(res, 200, {
        ok: true,
        order: result.order,
        portal: result.userPortal || null
      });
      return;
    }

    // Org self-service (org-admin account). callerUserId is FORCED from the authenticated token (after the
    // payload spread) so account A can never act as account B; require_org_admin (server) checks the caller
    // is owner/admin of the target org. Org-fund top-up stays MASTER-only (not here).
    if (req.method === "POST" && pathname === "/api/users/org/structure") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgStructure({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi to chuc" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/department") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgAddDepartment({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi them phong ban" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/member") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgAddMember({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi them thanh vien" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/allocate") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgAllocateCredit({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi phan bo" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/billing") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgUpdateBilling({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi luu thong tin thanh toan" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/report") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgReport({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi bao cao" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/set-entitlement") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgSetEntitlement({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi dat han muc" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/remove-member") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgRemoveMember({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi go thanh vien" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/department-delete") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgDeleteDepartment({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi xoa phong ban" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/set-role") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgSetMemberRole({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi doi vai tro" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/org/set-locked") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await orgSetMemberLocked({ ...payload, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi khoa thanh vien" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/plans/me") {
      try { sendJson(res, 200, await myPlan({ ...payload, userId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi doc goi cuoc" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/plans/self-downgrade") {
      if (!isAccount) { sendJson(res, 403, { ok: false, error: "Account session required" }); return; }
      try { sendJson(res, 200, await selfDowngradePlan({ ...payload, userId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi ha cap goi" }); }
      return;
    }
    if (req.method === "POST" && pathname === "/api/users/billing") {
      try { sendJson(res, 200, await updateUserBilling({ ...payload, userId: effectiveUserId, callerUserId: effectiveUserId })); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message || "Loi luu thong tin hoa don" }); }
      return;
    }

    if (pathname === "/api/users/portal/support") {
      const result = await createPortalSupportTicket({
        ...payload,
        userId: effectiveUserId
      });
      sendJson(res, 200, {
        ok: true,
        ticket: result.ticket,
        portal: result.userPortal || null
      });
      return;
    }

    // Live chat (App User "Nhân viên CSKH"): append a USER message to this account's livechat thread.
    if (pathname === "/api/users/portal/livechat") {
      const result = await appendLivechatMessage({ userId: effectiveUserId, from: "user", text: payload.text });
      sendJson(res, 200, { ok: true, record: result.record, portal: result.userPortal || null });
      return;
    }

    if (pathname === "/api/models/observe") {
      await observeModel(payload);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/users/ui-rules/preview") {
      const cleanTabId = sanitizeId(payload.tabId || tabId, DEFAULT_TABS[0]);
      activeTab = tabs.get(cleanTabId);
      if (!activeTab || activeTab.window.isDestroyed()) {
        throw new Error("Chua mo browser nap data de preview rule");
      }
      const preview = await applyUiPreviewToTab(activeTab, {
        userId: payload.userId || scopedUserId,
        serviceId: payload.serviceId,
        hideSelectors: payload.hideSelectors || [],
        hideRules: payload.hideRules || [],
        replaceRules: payload.replaceRules || [],
        userScript: payload.userScript || "",
        enabled: payload.enabled === true
      });
      sendJson(res, 200, {
        ok: true,
        preview,
        db: await readLocalDb(),
        state: getTabState(activeTab)
      });
      return;
    }

    if (pathname === "/api/users/ui-rules/select") {
      const cleanTabId = sanitizeId(payload.tabId || tabId, DEFAULT_TABS[0]);
      activeTab = tabs.get(cleanTabId);
      if (!activeTab || activeTab.window.isDestroyed()) {
        throw new Error("Chua mo browser nap data de chon vung");
      }
      const selection = await selectUiElementOnTab(activeTab, {
        action: payload.action || "hide",
        timeoutMs: payload.timeoutMs || 45000
      });
      sendJson(res, 200, {
        ok: true,
        selection,
        state: getTabState(activeTab)
      });
      return;
    }

    if (pathname === "/api/users/activity") {
      const result = await recordUserActivity({
        ...payload,
        userId: effectiveUserId,
        profileId: effectiveProfileId
      });
      sendJson(res, 200, {
        ok: true,
        activity: (result.activity || []).slice(-250)
      });
      return;
    }

    if (pathname === "/api/users/url-history") {
      const result = await saveUrlHistory({
        items: Array.isArray(payload?.items) ? payload.items : [],
        userId: effectiveUserId
      });
      sendJson(res, 200, {
        ok: true,
        urlHistory: result.urlHistory || []
      });
      return;
    }

    if (pathname === "/api/users/local-store") {
      const result = await saveUserLocalStore({
        ...payload,
        userId: effectiveUserId,
        profileId: effectiveProfileId
      });
      sendJson(res, 200, {
        ok: true,
        saved: result.saved || 0,
        localStoreCount: result.localStoreCount || 0
      });
      return;
    }

    if (pathname === "/api/users/ui-cache") {
      const result = await saveUserUiCache({
        ...payload,
        userId: effectiveUserId,
        profileId: effectiveProfileId
      });
      sendJson(res, 200, {
        ok: true,
        saved: result.saved || 0,
        items: result.uiCacheItems || []
      });
      return;
    }

    if (pathname === "/api/user-tabs/heartbeat") {
      const cleanTabId = sanitizeId(payload.tabId || tabId, DEFAULT_TABS[0]);
      const cleanProfileId = isAccount ? effectiveProfileId : sanitizeId(payload.profileId || DEFAULT_PROFILE, DEFAULT_PROFILE);
      const cleanUserId = effectiveUserId;
      const lockDeviceId = isAccount ? sanitizeId(authAccount.deviceId, "device") : sanitizeId(payload.deviceId || "device", "device");
      renewProfileLock(cleanProfileId, lockDeviceId);
      if (isAccount) refreshActiveDevice(cleanUserId, lockDeviceId);
      const key = `${cleanUserId}:${cleanProfileId}:${cleanTabId}`;
      const now = Date.now();

      clientTabs.set(key, {
        tabId: cleanTabId,
        profileId: cleanProfileId,
        userId: cleanUserId,
        serviceId: sanitizeId(payload.serviceId || "service", "service"),
        serviceName: String(payload.serviceName || payload.serviceId || "Service").slice(0, 120),
        title: String(payload.title || "").slice(0, 240),
        url: String(payload.url || "").slice(0, 2048),
        loading: Boolean(payload.loading),
        deviceId: sanitizeId(payload.deviceId || os.hostname() || "device", "device"),
        lastSeenAt: now,
        updatedAt: new Date(now).toISOString()
      });

      sendJson(res, 200, {
        ok: true,
        tab: clientTabs.get(key),
        tabs: allTabStates(),
        evict: isAccount ? evictionStatusFor(cleanUserId, lockDeviceId) : null
      });
      return;
    }

    if (pathname === "/api/user-tabs/close") {
      const cleanTabId = sanitizeId(payload.tabId || tabId, DEFAULT_TABS[0]);
      const cleanProfileId = isAccount ? effectiveProfileId : sanitizeId(payload.profileId || DEFAULT_PROFILE, DEFAULT_PROFILE);
      const cleanUserId = effectiveUserId;
      clientTabs.delete(`${cleanUserId}:${cleanProfileId}:${cleanTabId}`);
      sendJson(res, 200, {
        ok: true,
        closed: cleanTabId,
        tabs: allTabStates()
      });
      return;
    }

    if (pathname === "/api/services/save" || pathname === "/api/admin/services") {
      sendJson(res, 200, {
        ok: true,
        config: await writeServicesConfig(payload.services)
      });
      return;
    }

    if (pathname === "/api/services/reset") {
      sendJson(res, 200, {
        ok: true,
        config: await resetServicesConfig()
      });
      return;
    }

    if (pathname === "/api/tunnel/start") {
      if (payload.hostname || payload.token) {
        await saveTunnelConfig(payload);
      }
      sendJson(res, 200, {
        ok: true,
        tunnel: await startCloudflareTunnel()
      });
      return;
    }

    if (pathname === "/api/tunnel/config") {
      const config = await saveTunnelConfig(payload);
      sendJson(res, 200, {
        ok: true,
        config: publicTunnelConfigSnapshot(),
        saved: {
          hostname: config.hostname,
          hasToken: Boolean(config.token)
        }
      });
      return;
    }

    if (pathname === "/api/tunnel/stop") {
      sendJson(res, 200, {
        ok: true,
        tunnel: await stopCloudflareTunnel()
      });
      return;
    }

    if (pathname === "/api/profile/import") {
      const profileId = isAccount ? authAccount.profileId : (payload.profileId || payload.snapshot?.profileId || DEFAULT_PROFILE);
      const { targetSession, profileId: cleanProfileId } = await getProfileSession(profileId);
      const pushDeviceId = isAccount ? sanitizeId(authAccount.deviceId, "device") : sanitizeId(payload.deviceId || "device", "device");

      // Single-device mode only: account pushes must hold the lock and carry the current base revision
      // so two devices cannot clobber each other. In multi-device mode (default) any of the account's
      // devices may push — cookies are upserted (merged, not wiped) and the revision still bumps so the
      // other devices pick up the change via live-sync. Concurrent edits use last-write-wins per cookie.
      if (isAccount && PROFILE_SINGLE_DEVICE) {
        if (!lockHeldBy(cleanProfileId, pushDeviceId)) {
          sendJson(res, 423, { ok: false, error: "profile-locked-by-other", revision: profileRevision(cleanProfileId) });
          return;
        }
        if (payload.baseRevision == null || Number(payload.baseRevision) !== profileRevision(cleanProfileId)) {
          sendJson(res, 409, { ok: false, error: "stale-revision", revision: profileRevision(cleanProfileId) });
          return;
        }
      }

      let snapshot = payload.snapshot || {};
      if (payload.encrypted) {
        const importKey = isAccount ? (authAccount.sessionKey || "") : MASTER_SNAPSHOT_KEY;
        if (!importKey) {
          sendJson(res, 400, { ok: false, error: "Missing session key for encrypted import" });
          return;
        }
        snapshot = decryptSnapshot(payload.encrypted, importKey);
      } else if (!isAccount && !ALLOW_PLAINTEXT_SNAPSHOT) {
        // Master token may not push cookies in plaintext unless explicitly opted in.
        sendJson(res, 403, { ok: false, error: "Admin plaintext snapshot import disabled. Use CENTRIX_MASTER_SNAPSHOT_KEY or CENTRIX_ALLOW_PLAINTEXT_SNAPSHOT=1." });
        return;
      }

      // Back up the current profile (cookies) before overwriting (best-effort).
      try {
        const config = await readServicesConfig();
        const before = await exportProfileSnapshot(targetSession, { profileId: cleanProfileId, services: config.services, includeStorage: false });
        pushProfileBackup(cleanProfileId, before);
      } catch { /* best-effort */ }

      const result = await importProfileSnapshot(targetSession, {
        ...snapshot,
        profileId: cleanProfileId
      });
      const newRevision = profileRevision(cleanProfileId) + 1;
      profileRevisions.set(cleanProfileId, newRevision);
      saveProfileRevisions().catch(() => {});
      // Suppress the custodian cookie-watcher bump caused by THIS import's own cookie writes (it already
      // bumped explicitly above); a self-bump would make the pushing device reload its own push.
      profileImportSuppressUntil.set(cleanProfileId, Date.now() + COOKIE_BUMP_DEBOUNCE_MS + 2000);

      await recordUserActivity({
        userId: effectiveUserId,
        deviceId: pushDeviceId,
        profileId: cleanProfileId,
        serviceId: "profile",
        action: "profile-push",
        details: JSON.stringify({ ip: clientIp(req), cookies: result.cookieCount || 0, storage: result.storageCount || 0, revision: newRevision })
      }).catch(() => {});

      sendJson(res, 200, {
        ok: true,
        profileId: cleanProfileId,
        revision: newRevision,
        result
      });
      return;
    }

    if (pathname === "/api/open") {
      const target = await targetFromOpenPayload(payload);
      const state = await createOrReplaceTab(tabId, {
        profileId: payload.profileId || DEFAULT_PROFILE,
        userId: payload.userId,
        proxyRules: payload.proxyRules,
        serviceId: target.serviceId,
        serviceName: target.serviceName,
        url: target.url,
        width: payload.width,
        height: payload.height,
        show: payload.show === true,
        focus: payload.focus === true
      });
      sendJson(res, 200, { ok: true, state });
      return;
    }

    // Per-service login status (Tier 1, cookie-based). No tab needed — reads the shared custodian cookies.
    if (pathname === "/api/service/login-status") {
      const profileId = sanitizeId(payload.profileId, DEFAULT_PROFILE);
      const results = await serviceLoginStatuses(payload.serviceIds, profileId);
      sendJson(res, 200, { ok: true, profileId, results });
      return;
    }

    activeTab = await getTabForRequest(tabId);
    const wc = getTabWebContents(activeTab);

    if (pathname === "/api/navigate") {
      await wc.loadURL(normalizeUrl(payload.url));
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/back") {
      if (wc.canGoBack()) wc.goBack();
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/forward") {
      if (wc.canGoForward()) wc.goForward();
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/reload") {
      wc.reload();
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/show") {
      activeTab.window.show();
      activeTab.window.focus();
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/hide") {
      activeTab.window.hide();
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/devtools") {
      wc.openDevTools({ mode: "detach" });
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/resize") {
      const width = Math.max(800, Math.min(2200, Math.round(Number(payload.width || DEFAULT_WIDTH))));
      const height = Math.max(520, Math.min(1600, Math.round(Number(payload.height || DEFAULT_HEIGHT))));
      activeTab.window.setContentSize(width, height);
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/click") {
      sendMouseClick(activeTab, payload);
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/move") {
      sendMouseMove(activeTab, payload);
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/wheel") {
      sendMouseWheel(activeTab, payload);
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/type") {
      const text = String(payload.text || "");
      if (text) await wc.insertText(text);
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/key") {
      sendKey(activeTab, String(payload.key || ""));
      sendJson(res, 200, { ok: true, state: getTabState(activeTab) });
      return;
    }

    if (pathname === "/api/close") {
      activeTab.window.close();
      sendJson(res, 200, { ok: true, closed: tabId });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Unknown API route" });
  } catch (error) {
    if (activeTab) activeTab.state.lastError = error.message;
    sendJson(res, 500, {
      ok: false,
      error: error.message,
      state: activeTab ? getTabState(activeTab) : null
    });
  }
}

async function serveStatic(res, pathname) {
  if (pathname.startsWith("/desktop-assets/")) {
    const fileName = path.basename(pathname);
    const safeFiles = new Set(["logo.png", "logoapp.png", "centrix-logo.png", "favicon.ico", "profile.svg", "setting.svg"]);
    if (!safeFiles.has(fileName)) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(fileName).toLowerCase();
    const contentType = ext === ".svg" ? "image/svg+xml" : "image/png";
    const body = await fs.readFile(path.join(__dirname, "desktop-assets", fileName));
    res.writeHead(200, responseHeaders(contentType, body.length));
    res.end(body);
    return;
  }

  const files = {
    "/": [CONTROL_WEB_DIR, "index.html", "text/html; charset=utf-8"],
    "/index.html": [CONTROL_WEB_DIR, "index.html", "text/html; charset=utf-8"],
    "/remote-tabs.css": ["remote-tabs-web", "remote-tabs.css", "text/css; charset=utf-8"],
    "/remote-tabs.js": ["remote-tabs-web", "remote-tabs.js", "application/javascript; charset=utf-8"],
    "/server.css": ["remote-server-web", "server.css", "text/css; charset=utf-8"],
    "/server.js": ["remote-server-web", "server.js", "application/javascript; charset=utf-8"],
    "/api-ui-bridge.js": ["remote-server-web", "api-ui-bridge.js", "application/javascript; charset=utf-8"]
  };
  const entry = files[pathname];
  if (!entry) {
    sendText(res, 404, "Not found");
    return;
  }

  const filePath = path.join(__dirname, entry[0], entry[1]);
  const body = await fs.readFile(filePath);
  res.writeHead(200, {
    ...responseHeaders(entry[2], body.length),
    // Never let the renderer serve a STALE UI bundle from cache after an asar hot-swap (the bridge.js
    // change wouldn't take effect otherwise). The UI files are tiny + local, so no-store is cheap.
    "Cache-Control": "no-store, must-revalidate"
  });
  res.end(body);
}

function createServer() {
  server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = reqUrl.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204, responseHeaders("text/plain; charset=utf-8", 0));
      res.end();
      return;
    }

    // Đăng nhập email/mật khẩu ĐÃ GỠ — thay bằng đăng nhập Google (/api/auth/google, device-bound).
    // Trả 410 Gone NGAY trước auth-gate (không thể bypass); handler password cũ + loginAccount đã xóa hẳn.
    // MỞ LẠI: xem plan (re-add handler/import + isPublicApi + RATE_LIMITS + CENTRIX_DISABLE_PWD_LOGIN=0).
    if (req.method === "POST" && pathname === "/api/auth/login") {
      sendJson(res, 410, { ok: false, error: "Đăng nhập mật khẩu đã gỡ — dùng đăng nhập Google", code: "password_login_disabled" });
      return;
    }

    const isPublicApi = (req.method === "GET" && pathname === "/api/health") ||
      (req.method === "POST" && pathname === "/api/auth/google") ||
      (req.method === "POST" && pathname === "/api/account/lock-status") ||
      (req.method === "POST" && pathname === "/api/webhook/sepay") ||
      (req.method === "POST" && pathname === "/api/auth/staff-login") ||
      (req.method === "POST" && pathname === "/api/auth/staff-logout");
    if ((pathname.startsWith("/api/") || pathname === "/api/frame") && !isPublicApi) {
      const auth = await resolveAuth(req, reqUrl);
      if (!auth) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      if (auth.kind === "account" && !ACCOUNT_ALLOWED_PATHS.has(pathname)) {
        sendJson(res, 403, { ok: false, error: "Forbidden" });
        return;
      }
      if (auth.kind === "account") {
        const tk = headerTokenOf(req);
        trackSessionIp(tk, clientIp(req), auth.account);
        // Export-gate signal: record that this token interacted with a non-export endpoint (the real
        // client always polls/heartbeats/handshakes; a login->export bot never does).
        const gs = sessState(tk, true);
        if (gs) { gs.lastSeen = Date.now(); if (!gs.ua) gs.ua = req.headers["user-agent"] || ""; if (pathname !== "/api/profile/export") gs.interactedAt = Date.now(); }
        // Keep this account's active-device holder "live" on any request (so an idle but logged-in
        // device with no open tab doesn't look offline and lose its slot). No-op for non-holders.
        refreshActiveDevice(sanitizeId(auth.account.userId, "local-user"), sanitizeId(auth.account.deviceId, "device"));
      }
      if (auth.kind === "staff") {
        // Per-view route authorization. `log` records WOULD-BLOCK but serves; `on` enforces with 403.
        const verdict = staffRouteAllowed(req.method, pathname, auth.staff);
        if (STAFF_RBAC === "on" && !verdict.allowed) {
          sendJson(res, 403, { ok: false, error: "Không đủ quyền", code: "staff_forbidden", view: verdict.view });
          return;
        }
        if (STAFF_RBAC === "log" && !verdict.allowed) {
          console.warn(`[staff-rbac:log] ${auth.staff.username} ${req.method} ${pathname} view=${verdict.view} -> WOULD-BLOCK`);
        }
      }
      req._auth = auth;
    }

    if (req.method === "GET" && pathname === "/api/frame") {
      handleFrame(reqUrl, res);
      return;
    }

    if (pathname.startsWith("/api/")) {
      handleApi(req, res, pathname, reqUrl);
      return;
    }

    serveStatic(res, pathname).catch((error) => {
      sendJson(res, 500, { ok: false, error: error.message });
    });
  });

  server.once("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      dialog.showMessageBox({
        type: "info",
        title: "CentriX App Server dang chay",
        message: `CentriX App Server da dang nghe port ${PORT}.`,
        detail: "Hay dung cua so App Server dang mo, hoac tat process cu truoc khi mo lai."
      }).finally(() => app.quit());
      return;
    }
    throw error;
  });
  server.listen(PORT, HOST);
}

function createControlWindow() {
  const isServerWindow = CONTROL_WEB_DIR === "remote-server-web";
  const webPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  };

  if (isServerWindow) {
    webPreferences.preload = path.join(__dirname, "remote-server-preload.js");
  }

  controlWindow = new BrowserWindow({
    width: isServerWindow ? 1500 : 1180,
    height: isServerWindow ? 920 : 860,
    minWidth: isServerWindow ? 1280 : 960,
    minHeight: isServerWindow ? 760 : 640,
    title: isServerWindow ? "CentriX App Server" : "CentriX Shared Browser Tabs",
    icon: APP_ICON,
    frame: !isServerWindow,
    autoHideMenuBar: true,
    backgroundColor: "#f4f6f8",
    webPreferences
  });
  controlWindow.setMenuBarVisibility(false);
  controlWindow.setAutoHideMenuBar(true);
  controlWindow.on("maximize", () => controlWindow?.webContents.send("control-window:maximized", true));
  controlWindow.on("unmaximize", () => controlWindow?.webContents.send("control-window:maximized", false));

  const controlUrl = CONTROL_WEB_DIR === "remote-server-web"
    ? `${localBaseUrl()}/?${REQUIRE_TOKEN && authToken ? `token=${encodeURIComponent(authToken)}` : ""}`
    : controlUrlForTab(DEFAULT_TABS[0]);
  controlWindow.loadURL(controlUrl);
}

function windowForControlEvent(event) {
  const eventWindow = BrowserWindow.fromWebContents(event.sender);
  if (eventWindow && !eventWindow.isDestroyed()) return eventWindow;
  if (controlWindow && !controlWindow.isDestroyed()) return controlWindow;
  return null;
}

ipcMain.handle("control-window:minimize", (event) => {
  windowForControlEvent(event)?.minimize();
  return true;
});

ipcMain.handle("control-window:maximize", (event) => {
  const win = windowForControlEvent(event);
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});

ipcMain.handle("control-window:close", (event) => {
  windowForControlEvent(event)?.close();
  return true;
});

ipcMain.handle("control-window:is-maximized", (event) => {
  return windowForControlEvent(event)?.isMaximized() === true;
});

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!controlWindow || controlWindow.isDestroyed()) {
      createControlWindow();
      return;
    }
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.show();
    controlWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("digital.centrix.shared-browser-tabs");
    installCentrixNativeMenu({
      app,
      Menu,
      BrowserWindow,
      shell,
      dialog,
      getWindow: () => controlWindow,
      appName: "CentriX AI App Server",
      appKind: "server",
      version: "v3.6.0",
      createWindow: createControlWindow
    });
    await loadAuthToken();
    await loadTunnelConfig();
    await loadProfileRevisions();
    createServer();
    ensureWindowsFirewallRule().catch(() => {});

    // ── Phase B B3: optional PRIVATE RPC for the cloud backend (cookie export/import seam). Additive +
    // DORMANT unless CENTRIX_WORKER_RPC=1. The backend calls getRawSnapshot/putRawSnapshot/revision/lock/
    // loginStatus here (Electron-only ops); bound to 127.0.0.1, auth via shared CENTRIX_WORKER_RPC_SECRET.
    if (process.env.CENTRIX_WORKER_RPC === "1") {
      try {
        const { createWorkerRpcServer } = require("./shared/worker-rpc");
        createWorkerRpcServer({
          secret: process.env.CENTRIX_WORKER_RPC_SECRET || "",
          exportProfileSnapshot, importProfileSnapshot, getProfileSession,
          profileRevision,
          setProfileRevision: (pid, r) => { profileRevisions.set(pid, r); saveProfileRevisions().catch(() => {}); },
          readServicesConfig,
          acquireProfileLock, releaseProfileLock, lockHeldBy, requestAccountTakeover, clearActiveDeviceIfHolder,
          loginStatuses: (serviceIds, profileId) => serviceLoginStatuses(serviceIds, profileId),
          pushProfileBackup,
          suppressBump: (pid) => profileImportSuppressUntil.set(pid, Date.now() + COOKIE_BUMP_DEBOUNCE_MS + 2000),
          // B5 loader: the website admin drives the login browser through these existing tab closures.
          loaderApi: {
            targetFromOpenPayload, createOrReplaceTab, getTabForRequest, getTabWebContents,
            getTabState, normalizeUrl, sendMouseClick, sendMouseMove, sendMouseWheel, sendKey,
            serviceLoginStatuses,
            capture: async (tab) => (await getTabWebContents(tab).capturePage()).toPNG().toString("base64"),
          },
          log: (m) => console.log(m),
        }).start().catch((e) => console.warn("[worker-rpc] start failed:", e && e.message));
      } catch (e) {
        console.warn("[worker-rpc] wiring failed:", e && e.message);
      }
    }

    if (PREOPEN_TABS) {
      for (const tabId of DEFAULT_TABS) {
        await createOrReplaceTab(tabId, {
          profileId: DEFAULT_PROFILE,
          url: DEFAULT_URL
        });
      }
    }

    if (SHOW_CONTROL_WINDOW) {
      createControlWindow();
    }

    console.log(`CentriX Shared Browser Tabs: ${localBaseUrl()}/`);
    console.log(`Token: ${authToken}`);
    for (const address of lanAddresses()) {
      console.log(`LAN: http://${address}:${PORT}/`);
    }
    console.log(`Tab A: ${controlUrlForTab("tab-a")}`);
    console.log(`Tab B: ${controlUrlForTab("tab-b")}`);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createControlWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    stopCloudflareTunnel().catch(() => {});
    if (server) server.close();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    stopCloudflareTunnel().catch(() => {});
  });
}
