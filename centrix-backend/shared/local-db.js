const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { app } = require("./_compat-app");
const { DEFAULT_SERVICES } = require("./service-store");
const { SERVER_CONFIG_DIR } = require("./gibberish-names");

const DB_DIR_NAME = SERVER_CONFIG_DIR;
const DB_FILE_NAME = "local-db.json";
const DB_VERSION = 1;
const MAX_ACTIVITY = 500;
// Dedicated per-user usage-history store (Nhật ký sử dụng). Kept separate from the capped/noisy
// `activity` audit log so a user's browsing history survives restarts + device changes durably.
const MAX_URL_HISTORY_PER_USER = 300;
const MAX_LOCAL_STORE_RECORDS = 6000;
const MAX_UI_CACHE_ITEMS = 2000;
const MAX_UI_RULE_REPORTS = 2000;
const DEFAULT_TEST_CREDITS = 100;
const SERVICE_UI_RULE_USER_ID = "service-rule";
const UNKNOWN_MODEL_ID = "unknown-model";
const DB_API_URL = String(process.env.CENTRIX_LOCAL_DB_URL || "http://127.0.0.1:19779").replace(/\/+$/, "");
// 8s (was 2.5s): one admin refresh() fires 3 heavy reads in parallel (/api/users + /api/admin/portal +
// /api/admin/summary), each pulling the full ~11MB /db; under that concurrency the Docker (single-thread +
// read-semaphore) serves each in ~3s, which blew the old 2.5s timeout → the read aborted → the global read
// breaker tripped for 4s → even a 4ms staff-login read failed with "Docker DB temporarily unavailable".
const DB_API_TIMEOUT_MS = Math.max(400, Number(process.env.CENTRIX_LOCAL_DB_TIMEOUT_MS || 8000));
// Read short-circuit window after a Docker error. Kept short so a single slow response does not
// route a long burst of operations to the (warmed) JSON fallback. Writes ignore this entirely.
const DB_API_RETRY_MS = Math.max(1000, Number(process.env.CENTRIX_LOCAL_DB_RETRY_MS || 4000));

let dbApiSkipUntil = 0;
let dbApiLastError = "";
// Routes the Docker DB image doesn't implement (e.g. older images lack /users/url-history). Keyed by
// pathname-without-query. Once a route 404s we route it straight to the JSON store, so we neither
// waste round-trips nor let a missing-feature 404 trip the read skip-window for OTHER (supported)
// routes like wallet/policy.
const dbApiMissingRoutes = new Set();

const DEFAULT_USERS = [
  {
    id: "profile-loader",
    name: "Profile Loader",
    role: "loader",
    enabled: true,
    defaultProfileId: "default"
  },
  {
    id: "local-user",
    name: "Local User",
    role: "user",
    enabled: true,
    defaultProfileId: "default"
  },
  {
    id: "user-a",
    name: "User A",
    role: "user",
    enabled: true,
    defaultProfileId: "default"
  },
  {
    id: "user-b",
    name: "User B",
    role: "user",
    enabled: true,
    defaultProfileId: "default"
  }
];

const DEFAULT_ACCOUNTS = [
  { email: "local@centrix.test", password: "123456", userId: "local-user", profileId: "default" },
  { email: "loader@centrix.test", password: "123456", userId: "profile-loader", profileId: "default" },
  { email: "a@centrix.test", password: "123456", userId: "user-a", profileId: "default" },
  { email: "b@centrix.test", password: "123456", userId: "user-b", profileId: "default" }
];

const DEFAULT_MODEL_POLICIES = [
  {
    userId: "local-user",
    serviceId: "chatgpt",
    enabled: false,
    allowedModels: ["gpt-4o-mini", "o4-mini"],
    dailyLimit: 0,
    blockUnknown: false,
    defaultModel: "gpt-4o-mini",
    modelCreditCosts: { "gpt-4o-mini": 1, "o4-mini": 2 },
    defaultCreditCost: 1
  },
  {
    userId: "user-a",
    serviceId: "chatgpt",
    enabled: true,
    allowedModels: ["gpt-4o-mini", "o4-mini"],
    dailyLimit: 20,
    blockUnknown: true,
    defaultModel: "gpt-4o-mini",
    modelCreditCosts: { "gpt-4o-mini": 1, "o4-mini": 2 },
    defaultCreditCost: 1
  },
  {
    userId: "user-b",
    serviceId: "claude",
    enabled: true,
    allowedModels: ["claude-3-5-haiku", "claude-3-5-sonnet"],
    dailyLimit: 20,
    blockUnknown: true,
    defaultModel: "claude-3-5-haiku",
    modelCreditCosts: { "claude-3-5-haiku": 1, "claude-3-5-sonnet": 3 },
    defaultCreditCost: 1
  }
];

const DEFAULT_MODEL_PRICES = DEFAULT_MODEL_POLICIES.flatMap((policy) => {
  return Object.entries(policy.modelCreditCosts || {}).map(([modelId, creditCost]) => ({
    serviceId: policy.serviceId,
    modelId,
    displayName: modelId,
    creditCost,
    enabled: true,
    isDefault: modelId === policy.defaultModel,
    observedFromLoader: false,
    source: "seed"
  }));
}).filter((price, index, rows) => (
  rows.findIndex((item) => item.serviceId === price.serviceId && item.modelId === price.modelId) === index
));

function nowIso() {
  return new Date().toISOString();
}

function localDbDir() {
  return path.join(app.getPath("appData"), DB_DIR_NAME);
}

function localDbPath() {
  return path.join(localDbDir(), DB_FILE_NAME);
}

function sanitizeId(value, fallback = "local-user") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80) || fallback;
}

function sanitizeText(value, fallback = "", limit = 160) {
  return String(value || fallback).trim().slice(0, limit);
}

function sanitizeModelId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "-")
    .slice(0, 120);
}

function unknownModelId() {
  return UNKNOWN_MODEL_ID;
}

function sanitizeModelList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/);
  return Array.from(new Set(raw.map(sanitizeModelId).filter(Boolean))).slice(0, 80);
}

function sanitizeCreditCost(value, fallback = 1) {
  return Math.max(1, Math.min(100000, Math.round(Number(value || fallback) || fallback)));
}
// Credit trên 1.000 token (float, cho phép số lẻ). 0 = tắt token-pricing (dùng creditCost cố định).
function sanitizeCreditPerKTok(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100000, Math.round(n * 10000) / 10000);
}
// Quy token → credit: ceil(tokens/1000 * đơn giá), tối thiểu 1 khi có token; 0 khi không đo được.
function tokenCreditCost(estimatedTokens, creditPerKTok) {
  const toks = Math.max(0, Math.floor(Number(estimatedTokens) || 0));
  const rate = sanitizeCreditPerKTok(creditPerKTok);
  if (toks <= 0 || rate <= 0) return 0;
  return Math.max(1, Math.min(100000, Math.ceil((toks / 1000) * rate)));
}

function sanitizeCreditBalance(value, fallback = 0) {
  return Math.max(0, Math.min(1000000000, Math.round(Number(value ?? fallback) || 0)));
}

function sanitizeCreditDelta(value) {
  return Math.max(-1000000000, Math.min(1000000000, Math.round(Number(value || 0) || 0)));
}

function sanitizeModelCreditCosts(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const costs = {};
  for (const [rawModelId, rawCost] of Object.entries(source)) {
    const modelId = sanitizeModelId(rawModelId);
    if (!modelId) continue;
    costs[modelId] = sanitizeCreditCost(rawCost, 1);
  }
  return costs;
}

function creditCostForModel(policy, modelId) {
  const costs = sanitizeModelCreditCosts(policy?.modelCreditCosts);
  const cleanModelId = sanitizeModelId(modelId || "");
  return sanitizeCreditCost(costs[cleanModelId], sanitizeCreditCost(policy?.defaultCreditCost, 1));
}

function defaultWalletBalanceForUser(userId) {
  return sanitizeId(userId, "local-user") === "profile-loader" ? 0 : DEFAULT_TEST_CREDITS;
}

function creditTxId() {
  return `ctx_${crypto.randomBytes(12).toString("base64url")}`;
}

function usageIdempotencyKey(userId, serviceId, usageRequestId) {
  const cleanUsageId = sanitizeText(usageRequestId, "", 180);
  if (!cleanUsageId) return "";
  return [
    sanitizeId(userId, "local-user"),
    sanitizeId(serviceId, "service"),
    cleanUsageId
  ].join(":");
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 180);
}

function passwordHash(value) {
  // Legacy unsalted SHA-256 — kept only so verifyPassword can recognise old rows.
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

// Salted PBKDF2-HMAC-SHA256, byte-identical to the Python store (docker/centrix-db-api/server.py).
// Format: pbkdf2$<iters>$<b64salt>$<b64hash>. Legacy bare 64-hex hashes are accepted and upgraded.
const PW_ITERS = Math.max(50000, Number(process.env.CENTRIX_PW_ITERS || 210000));

function hashPassword(value, iterations) {
  const iters = Number(iterations || PW_ITERS);
  const salt = crypto.randomBytes(16);
  const dk = crypto.pbkdf2Sync(String(value || ""), salt, iters, 32, "sha256");
  return `pbkdf2$${iters}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyPassword(stored, value) {
  const s = String(stored || "");
  if (s.startsWith("pbkdf2$")) {
    try {
      const parts = s.split("$");
      const iters = Number(parts[1]);
      const salt = Buffer.from(parts[2], "base64");
      const expected = Buffer.from(parts[3], "base64");
      const dk = crypto.pbkdf2Sync(String(value || ""), salt, iters, expected.length, "sha256");
      const ok = dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
      return { ok, needsRehash: ok && iters !== PW_ITERS };
    } catch {
      return { ok: false, needsRehash: false };
    }
  }
  if (/^[a-f0-9]{64}$/i.test(s)) {
    const ok = constantTimeEqual(passwordHash(value), s.toLowerCase());
    return { ok, needsRehash: ok };
  }
  return { ok: false, needsRehash: false };
}

// At-rest wrapping of secrets (session_key) with AES-256-GCM, opt-in via CENTRIX_VAULT_KEY (base64 32B).
// Format "gcm$<iv>$<tag>$<ct>" (base64) — byte-compatible with the Python store (docker/centrix-db-api/
// server.py). Unprefixed values are cleartext (grandfathered). No key = unchanged (cleartext).
const VAULT_KEY = (() => {
  const b = Buffer.from(String(process.env.CENTRIX_VAULT_KEY || "").trim(), "base64");
  return b.length === 32 ? b : null;
})();

function vaultWrap(value) {
  const s = String(value || "");
  if (!VAULT_KEY || !s || s.startsWith("gcm$")) return s;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", VAULT_KEY, iv);
  const ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return `gcm$${iv.toString("base64")}$${c.getAuthTag().toString("base64")}$${ct.toString("base64")}`;
}

function vaultUnwrap(value) {
  const s = String(value || "");
  if (!s.startsWith("gcm$") || !VAULT_KEY) return s;
  try {
    const [, ivb, tagb, ctb] = s.split("$");
    const d = crypto.createDecipheriv("aes-256-gcm", VAULT_KEY, Buffer.from(ivb, "base64"));
    d.setAuthTag(Buffer.from(tagb, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctb, "base64")), d.final()]).toString("utf8");
  } catch {
    return s;
  }
}

function accountTokenForEmail(email) {
  return `acct_${crypto.createHash("sha256").update(`centrix:${sanitizeEmail(email)}`, "utf8").digest("base64url").slice(0, 32)}`;
}

const PORTAL_SECTION_KEYS = [
  "organizations",
  "departments",
  "members",
  "creditPackages",
  "plans",
  "topupOrders",
  "invoices",
  "promotions",
  "supportTickets",
  "notifications",
  "rolePermissions",
  "appSettings",
  "aiIntegrations",
  "manualInterventions",
  "interventionLogs",
  "orgTransactions",
  "analyticsSnapshots",
  "appVersion"
];

const DEMO_PORTAL_IDS = new Set([
  "org-centrix-media",
  "dept-root",
  "dept-marketing",
  "dept-sales",
  "mem-local",
  "mem-a",
  "mem-b",
  "pkg-100",
  "pkg-500",
  "pkg-1000",
  "plan-free",
  "plan-pro",
  "plan-business",
  "promo-launch",
  "notice-welcome",
  "role-owner",
  "role-support",
  "setting-credit-alert",
  "setting-default-theme",
  "ai-router",
  "analytics-today"
]);

function isDemoPortalRecord(row) {
  const id = sanitizeId(row?.id, "");
  return id ? DEMO_PORTAL_IDS.has(id) || id.includes("-seed-") : false;
}

function portalRecordId(section = "portal") {
  return `${sanitizeId(section, "portal").slice(0, 24)}_${crypto.randomBytes(6).toString("base64url")}`;
}

// Server-authorized DEFAULT credit packages surfaced on the App User "Mua credit" screen when an admin has
// not configured any custom ones. Defining them HERE (not client-side) keeps credits/price authoritative:
// the App User renders these as bridge-wired cards → package selection + SePay order use the server's
// credits/amount, never a client-asserted value. An admin's configured portal.creditPackages overrides this.
const DEFAULT_CREDIT_PACKAGES = [
  { id: "pkg-100", name: "100 credit", credits: 100, bonusCredits: 0, price: 29000, currency: "VND", enabled: true },
  { id: "pkg-500", name: "500 credit", credits: 500, bonusCredits: 25, price: 139000, currency: "VND", enabled: true },
  { id: "pkg-1000", name: "1.000 credit", credits: 1000, bonusCredits: 100, price: 259000, currency: "VND", enabled: true },
  { id: "pkg-5000", name: "5.000 credit", credits: 5000, bonusCredits: 1000, price: 1190000, currency: "VND", highlight: true, enabled: true },
];

function defaultPortalData(stamp = nowIso()) {
  return {
    version: 1,
    updatedAt: stamp,
    organizations: [],
    departments: [],
    members: [],
    creditPackages: [],
    plans: [],
    topupOrders: [],
    invoices: [],
    promotions: [],
    supportTickets: [],
    notifications: [],
    rolePermissions: [],
    appSettings: [],
    aiIntegrations: [],
    manualInterventions: [],
    interventionLogs: [],
    orgTransactions: [],
    analyticsSnapshots: [],
    appVersion: []
  };
}

function sanitizePortalValue(value, key = "") {
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizePortalValue(item, key));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [nestedKey, nestedValue] of Object.entries(value).slice(0, 80)) {
      next[sanitizeText(nestedKey, "", 80)] = sanitizePortalValue(nestedValue, nestedKey);
    }
    return next;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(-1000000000, Math.min(1000000000, value)) : 0;
  if (/credit|amount|price|limit|total|used|monthly|bonus|value|requests|users/i.test(key)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(-1000000000, Math.min(1000000000, parsed));
  }
  return sanitizeText(value, "", 4000);
}

function sanitizePortalRecord(section, input, index = 0) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fallbackId = `${sanitizeId(section, "portal")}-${index + 1}`;
  const record = {
    id: sanitizeId(source.id, fallbackId)
  };

  for (const [key, value] of Object.entries(source)) {
    const cleanKey = sanitizeText(key, "", 80);
    if (!cleanKey) continue;
    if (cleanKey === "id") continue;
    if (/^(userId|orgId|departmentId|parentId|serviceId|packageId|orderId|interventionId)$/i.test(cleanKey)) {
      record[cleanKey] = value ? sanitizeId(value, "") : "";
      continue;
    }
    if (/email/i.test(cleanKey)) {
      record[cleanKey] = sanitizeEmail(value);
      continue;
    }
    if (/enabled|highlight/i.test(cleanKey)) {
      record[cleanKey] = value !== false;
      continue;
    }
    record[cleanKey] = sanitizePortalValue(value, cleanKey);
  }

  record.createdAt = sanitizeText(record.createdAt, nowIso(), 80);
  record.updatedAt = sanitizeText(record.updatedAt || record.createdAt, record.createdAt, 80);
  return record;
}

function sanitizePortalData(input) {
  const fallback = defaultPortalData();
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const portal = {
    version: 1,
    updatedAt: sanitizeText(source.updatedAt, fallback.updatedAt, 80)
  };

  for (const section of PORTAL_SECTION_KEYS) {
    const rows = Array.isArray(source[section]) ? source[section] : fallback[section];
    portal[section] = rows
      .filter((row) => !isDemoPortalRecord(row))
      .map((row, index) => sanitizePortalRecord(section, row, index))
      .slice(0, section === "analyticsSnapshots" ? 400 : 1000);
  }

  return portal;
}

const AUTH_SESSION_TTL_MS = Math.max(1000, Number(process.env.CENTRIX_AUTH_TTL_MS || 12 * 3600 * 1000));

function newSessionToken() {
  return `sess_${crypto.randomBytes(32).toString("hex")}`;
}

function sanitizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function defaultUserServices() {
  const serviceIds = DEFAULT_SERVICES.map((service) => service.id);
  const rows = [];

  for (const userId of ["profile-loader", "local-user"]) {
    for (const serviceId of serviceIds) {
      rows.push({ userId, serviceId, visible: true });
    }
  }

  for (const serviceId of ["google", "chatgpt"]) {
    rows.push({ userId: "user-a", serviceId, visible: true });
  }

  for (const serviceId of ["google", "claude"]) {
    rows.push({ userId: "user-b", serviceId, visible: true });
  }

  return rows;
}

// createDb() builds the default DB, which hashes DEFAULT_ACCOUNTS with PBKDF2 (210k iters × 4 ≈ 1.5s of
// SYNCHRONOUS CPU). sanitizeDb() calls it on EVERY snapshot as a fallback, so every admin read paid 1.5s
// and, being sync, blocked the event loop → all requests serialized, writes starved (admin saves hung,
// Cloudflare 524). Build the template ONCE, then hand out cheap deep clones (~1ms) per call.
let _createDbTemplate = null;
function createDb() {
  if (!_createDbTemplate) _createDbTemplate = buildDefaultDb();
  return structuredClone(_createDbTemplate);
}
function buildDefaultDb() {
  return {
    version: DB_VERSION,
    updatedAt: nowIso(),
    users: DEFAULT_USERS.map((user) => ({ ...user, createdAt: nowIso(), updatedAt: nowIso() })),
    serviceVisibility: defaultUserServices().map((row) => ({ ...row, updatedAt: nowIso() })),
    uiRules: [
      {
        userId: "user-a",
        serviceId: "chatgpt",
        enabled: false,
        hideSelectors: [
          "[data-testid='workspace-switcher']",
          "nav a[href*='explore']"
        ],
        replaceRules: [],
        updatedAt: nowIso()
      },
      {
        userId: "user-b",
        serviceId: "claude",
        enabled: false,
        hideSelectors: [
          "[data-testid='upgrade-button']",
          "a[href*='upgrade']"
        ],
        replaceRules: [],
        updatedAt: nowIso()
      }
    ],
    blockedLinks: [],
    modelPolicies: DEFAULT_MODEL_POLICIES.map((policy) => sanitizeModelPolicy({
      ...policy,
      updatedAt: nowIso()
    })),
    modelPrices: DEFAULT_MODEL_PRICES.map((price) => sanitizeModelPrice({
      ...price,
      updatedAt: nowIso()
    })),
    modelUsage: [],
    modelObservations: [],
    creditWallets: DEFAULT_USERS.map((user) => sanitizeCreditWallet({
      userId: user.id,
      balance: defaultWalletBalanceForUser(user.id),
      updatedAt: nowIso()
    })),
    creditTransactions: [],
    accounts: DEFAULT_ACCOUNTS.map((account) => sanitizeAccount({
      ...account,
      // Let sanitizeAccount hash with the salted PBKDF2 algo (no legacy pre-hash). Seed password is
      // env-overridable so it isn't pinned to the throwaway demo value.
      password: process.env.CENTRIX_SEED_PW || account.password,
      token: accountTokenForEmail(account.email),
      createdAt: nowIso(),
      updatedAt: nowIso()
    })),
    localStore: [],
    uiCacheItems: [],
    uiRuleReports: [],
    authSessions: [],
    activity: [],
    urlHistory: [],
    portal: defaultPortalData()
  };
}

function sanitizeUser(input) {
  const id = sanitizeId(input?.id, "local-user");
  return {
    id,
    name: sanitizeText(input?.name, id, 120),
    role: sanitizeText(input?.role, "user", 32) || "user",
    enabled: input?.enabled !== false,
    defaultProfileId: sanitizeId(input?.defaultProfileId || "default", "default"),
    // Pass through the CURRENT plan (Docker read_db joins user_subscriptions onto each user). Without this the
    // read-path sanitize stripped it, so the admin always showed "Free" even after a real plan assignment.
    plan: sanitizeText(input?.plan, "FREE", 32) || "FREE",
    planName: sanitizeText(input?.planName, "Free", 60) || "Free",
    // Subscription detail for the admin user table/drawer (dbapi read_db computes these from user_subscriptions).
    planExpiresAt: sanitizeText(input?.planExpiresAt, "", 40),
    planDaysLeft: (input?.planDaysLeft == null ? null : Math.max(0, Math.round(Number(input.planDaysLeft) || 0))),
    planMonthlyCredit: Math.max(0, Math.round(Number(input?.planMonthlyCredit) || 0)),
    planNextResetAt: sanitizeText(input?.planNextResetAt, "", 40),
    createdAt: input?.createdAt || nowIso(),
    updatedAt: input?.updatedAt || nowIso()
  };
}

function sanitizeVisibility(input) {
  return {
    userId: sanitizeId(input?.userId, "local-user"),
    serviceId: sanitizeId(input?.serviceId, "service"),
    visible: input?.visible !== false,
    updatedAt: input?.updatedAt || nowIso()
  };
}

function sanitizeAccount(input) {
  const email = sanitizeEmail(input?.email);
  // Accept both camelCase (JS) and snake_case (the Python DB API's /db snapshot) so a stored pbkdf2$ hash
  // is recognised and NOT re-hashed. Only run PBKDF2 when an actual raw password is supplied (a write/import);
  // on a READ with no raw password, keep the existing hash. Re-hashing every account on every snapshot was
  // ~150ms × N of SYNCHRONOUS PBKDF2 that blocked the event loop and serialized all requests.
  const rawHash = String(input?.passwordHash || input?.password_hash || "");
  const passwordHashValue = /^[a-f0-9]{64}$/i.test(rawHash)
    ? rawHash.toLowerCase()
    : rawHash.startsWith("pbkdf2$")
      ? rawHash
      : input?.password ? hashPassword(input.password) : rawHash;
  return {
    email,
    passwordHash: passwordHashValue,
    token: sanitizeText(input?.token, email ? accountTokenForEmail(email) : "", 160),
    userId: sanitizeId(input?.userId, "local-user"),
    profileId: sanitizeId(input?.profileId || "default", "default"),
    enabled: input?.enabled !== false,
    createdAt: input?.createdAt || nowIso(),
    updatedAt: input?.updatedAt || nowIso()
  };
}

// Session tokens are 256-bit random, so an unsalted SHA-256 at rest is sound and lets us persist only a
// non-reversible digest (never the raw bearer token) in the JSON fallback DB.
// hashSessionToken ALWAYS hashes — use it in the COMPARE paths (verify/revoke/dedupe). Presented tokens are
// always raw ("sess_…"), so hashing unconditionally is correct AND closes a bypass: a leaked at-rest hash
// ("sha256$…") presented as a bearer token re-hashes to something else and never matches (the hash is not a
// usable credential). sessionTokenAtRest is the idempotent STORAGE form: re-sanitizing an already-hashed row
// (warm reload / mirror) is a no-op and a legacy plaintext row migrates to its hash on first read. The
// IDENTICAL scheme is mirrored in the Python DB-API (server.py) so the /db snapshot stays compatible.
function hashSessionToken(token) {
  const s = String(token || "").trim();
  return s ? "sha256$" + crypto.createHash("sha256").update(s, "utf8").digest("hex") : "";
}
function sessionTokenAtRest(token) {
  const s = String(token || "").trim();
  if (!s) return "";
  return s.startsWith("sha256$") ? s : hashSessionToken(s);
}

function sanitizeAuthSession(input) {
  return {
    token: sessionTokenAtRest(sanitizeText(input?.token, "", 200)),
    userId: sanitizeId(input?.userId, "local-user"),
    profileId: sanitizeId(input?.profileId || "default", "default"),
    deviceId: sanitizeId(input?.deviceId || "device", "device"),
    email: sanitizeEmail(input?.email),
    sessionKey: vaultWrap(sanitizeText(input?.sessionKey, "", 256)),
    issuedAt: input?.issuedAt || nowIso(),
    expiresAt: input?.expiresAt || nowIso(),
    revokedAt: input?.revokedAt || null,
    lastSeenAt: input?.lastSeenAt || input?.issuedAt || nowIso()
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

function sanitizeSelectors(selectors) {
  const raw = Array.isArray(selectors) ? selectors.join("\n") : String(selectors || "");
  const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, "\n");
  const clean = [];
  let inBlock = false;

  for (const rawLine of withoutComments.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.includes("{")) {
      const selector = line.slice(0, line.indexOf("{")).trim().replace(/,$/, "");
      if (selectorLooksUsable(selector)) clean.push(selector.slice(0, 320));
      inBlock = !line.includes("}");
      continue;
    }

    if (inBlock) {
      if (line.includes("}")) inBlock = false;
      continue;
    }

    const selector = line.replace(/,$/, "");
    if (selectorLooksUsable(selector)) clean.push(selector.slice(0, 320));
  }

  return Array.from(new Set(clean)).slice(0, 40);
}

function sanitizeReplaceRules(rules) {
  const rows = Array.isArray(rules) ? rules : [];
  const clean = [];
  const seen = new Set();

  for (const raw of rows) {
    const selector = String(raw?.selector || "").trim();
    if (!selectorLooksUsable(selector)) continue;
    const text = sanitizeText(raw?.text ?? raw?.replacement ?? "", "", 1200);
    const matchText = sanitizeText(raw?.matchText || "", "", 400);
    const key = `${selector}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({
      selector: selector.slice(0, 320),
      text,
      matchText,
      enabled: raw?.enabled !== false,
      updatedAt: raw?.updatedAt || nowIso()
    });
  }

  return clean.slice(0, 40);
}

function sanitizeUserScript(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .slice(0, 30000);
}

// Verbatim custom CSS from the Manager: only strip NUL + cap length. NOT selector-validated (unlike
// hideSelectors), so the manager's hand-written CSS is kept WHOLE and applied AS-IS on the App User.
function sanitizeCustomCss(value) {
  return String(value || "").split(String.fromCharCode(0)).join("").slice(0, 30000);
}

function stableUiRuleId(userId, serviceId, selector) {
  const hash = crypto
    .createHash("sha1")
    .update(`${userId || ""}:${serviceId || ""}:${selector || ""}`)
    .digest("hex")
    .slice(0, 16);
  return `hide_${hash}`;
}

function sanitizeNumber(value, fallback = 0, min = 0, max = 1000000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeStringList(value, limit = 16, itemLimit = 48) {
  const rows = Array.isArray(value) ? value : [];
  const clean = [];
  for (const item of rows) {
    const text = sanitizeText(item, "", itemLimit);
    if (text && !clean.includes(text)) clean.push(text);
    if (clean.length >= limit) break;
  }
  return clean;
}

function sanitizeUiFingerprint(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    tag: sanitizeText(source.tag, "", 32).toLowerCase(),
    role: sanitizeText(source.role, "", 80),
    ariaLabel: sanitizeText(source.ariaLabel, "", 160),
    textSnippet: sanitizeText(source.textSnippet, "", 240),
    classCount: Math.round(sanitizeNumber(source.classCount, 0, 0, 200)),
    childTags: sanitizeStringList(source.childTags, 16, 32),
    rectRatio: Number(sanitizeNumber(source.rectRatio, 0, 0, 100).toFixed(3))
  };
}

function sanitizeUiExpectation(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const maxMatches = source.maxMatches === undefined || source.maxMatches === null || source.maxMatches === ""
    ? undefined
    : Math.round(sanitizeNumber(source.maxMatches, 0, 0, 100000));
  const expectation = {
    minMatches: Math.max(0, Math.round(sanitizeNumber(source.minMatches, 1, 0, 100000)))
  };
  if (maxMatches !== undefined) expectation.maxMatches = maxMatches;
  return expectation;
}

function sanitizeUiScope(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    urlPattern: sanitizeText(source.urlPattern, "", 500),
    pageState: sanitizeText(source.pageState, "", 80)
  };
}

function sanitizeUiHealth(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const state = ["green", "yellow", "red", "unknown"].includes(source.state) ? source.state : "unknown";
  return {
    state,
    recentMissRate: Number(sanitizeNumber(source.recentMissRate, 0, 0, 1).toFixed(3)),
    lastSeenMatchingAt: sanitizeText(source.lastSeenMatchingAt, "", 80)
  };
}

function sanitizeHideRule(raw = {}, context = {}, index = 0) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { primarySelector: raw };
  const primarySelector = String(source.primarySelector || source.selector || "").trim();
  if (!selectorLooksUsable(primarySelector)) return null;
  const userId = sanitizeId(context.userId || source.userId, "local-user");
  const serviceId = sanitizeId(context.serviceId || source.serviceId, "service");
  const action = ["hide", "remove", "collapse"].includes(source.action) ? source.action : "hide";
  const failMode = ["open", "closed"].includes(source.failMode) ? source.failMode : "open";
  return {
    id: sanitizeText(source.id, stableUiRuleId(userId, serviceId, primarySelector), 100) || stableUiRuleId(userId, serviceId, primarySelector),
    version: Math.max(1, Math.round(sanitizeNumber(source.version, 1, 1, 100000))),
    domain: sanitizeText(source.domain || context.domain, "", 160),
    scope: sanitizeUiScope(source.scope),
    primarySelector: primarySelector.slice(0, 500),
    anchorSelector: selectorLooksUsable(source.anchorSelector) ? String(source.anchorSelector).trim().slice(0, 500) : "",
    fingerprint: sanitizeUiFingerprint(source.fingerprint),
    expectation: sanitizeUiExpectation(source.expectation),
    action,
    failMode,
    createdAt: sanitizeText(source.createdAt, nowIso(), 80),
    lastVerifiedAt: sanitizeText(source.lastVerifiedAt, "", 80),
    health: sanitizeUiHealth(source.health),
    enabled: source.enabled !== false,
    note: sanitizeText(source.note || (index >= 0 ? `selector ${index + 1}` : ""), "", 240)
  };
}

function sanitizeHideRules(hideRules, hideSelectors = [], context = {}) {
  const clean = [];
  const seen = new Set();
  const pushRule = (raw, index) => {
    const rule = sanitizeHideRule(raw, context, index);
    if (!rule || seen.has(rule.primarySelector)) return;
    seen.add(rule.primarySelector);
    clean.push(rule);
  };

  if (Array.isArray(hideRules)) {
    hideRules.forEach((rule, index) => pushRule(rule, index));
  }

  sanitizeSelectors(hideSelectors).forEach((selector, index) => {
    if (seen.has(selector)) return;
    pushRule({ primarySelector: selector, enabled: true, note: "legacy selector" }, index);
  });

  return clean.slice(0, 80);
}

function sanitizeUiRuleReport(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const state = ["green", "yellow", "red", "unknown"].includes(source.state) ? source.state : "unknown";
  const userId = sanitizeId(source.userId, "local-user");
  const serviceId = sanitizeId(source.serviceId, "service");
  const selector = sanitizeText(source.selector || source.primarySelector, "", 500);
  const ruleId = sanitizeText(source.ruleId || source.id, selector ? stableUiRuleId(userId, serviceId, selector) : "", 100);
  return {
    id: sanitizeText(source.id, `uir_${crypto.randomBytes(10).toString("hex")}`, 100),
    userId,
    serviceId,
    ruleId,
    selector,
    state,
    matchCount: Math.round(sanitizeNumber(source.matchCount, 0, 0, 100000)),
    driftScore: Number(sanitizeNumber(source.driftScore, 0, 0, 1).toFixed(3)),
    url: sanitizeText(source.url, "", 1000),
    origin: sanitizeText(source.origin, "", 240),
    evidenceSnippet: sanitizeText(source.evidenceSnippet || source.snippet, "", 1200),
    message: sanitizeText(source.message || source.reason, "", 320),
    createdAt: sanitizeText(source.createdAt, nowIso(), 80)
  };
}

function sanitizeUiRule(input) {
  const userId = sanitizeId(input?.userId, "local-user");
  const serviceId = sanitizeId(input?.serviceId, "service");
  const legacySelectors = sanitizeSelectors(input?.hideSelectors);
  const hideRules = sanitizeHideRules(input?.hideRules, legacySelectors, {
    userId,
    serviceId,
    domain: input?.domain
  });
  const hideSelectors = Array.from(new Set([
    ...legacySelectors,
    ...hideRules.map((rule) => rule.primarySelector).filter(Boolean)
  ])).slice(0, 80);

  return {
    schemaVersion: 1,
    userId,
    serviceId,
    enabled: input?.enabled === true,
    hideSelectors,
    hideRules,
    replaceRules: sanitizeReplaceRules(input?.replaceRules),
    userScript: sanitizeUserScript(input?.userScript),
    customCss: sanitizeCustomCss(input?.customCss),
    updatedAt: input?.updatedAt || nowIso()
  };
}

function sanitizeModelPolicy(input) {
  return {
    userId: sanitizeId(input?.userId, "local-user"),
    serviceId: sanitizeId(input?.serviceId, "service"),
    enabled: input?.enabled === true,
    allowedModels: sanitizeModelList(input?.allowedModels),
    dailyLimit: Math.max(0, Math.min(100000, Math.round(Number(input?.dailyLimit || 0)))),
    blockUnknown: input?.blockUnknown === true,
    defaultModel: sanitizeModelId(input?.defaultModel || ""),
    modelCreditCosts: sanitizeModelCreditCosts(input?.modelCreditCosts),
    defaultCreditCost: sanitizeCreditCost(input?.defaultCreditCost, 1),
    updatedAt: input?.updatedAt || nowIso()
  };
}

function sanitizeCreditWallet(input) {
  const userId = sanitizeId(input?.userId, "local-user");
  return {
    userId,
    balance: sanitizeCreditBalance(input?.balance, defaultWalletBalanceForUser(userId)),
    reserved: sanitizeCreditBalance(input?.reserved, 0),
    lifetimeAdded: sanitizeCreditBalance(input?.lifetimeAdded, 0),
    lifetimeSpent: sanitizeCreditBalance(input?.lifetimeSpent, 0),
    moneyBalance: sanitizeCreditBalance(input?.moneyBalance, 0), // ví VND
    moneyLifetimeAdded: sanitizeCreditBalance(input?.moneyLifetimeAdded, 0),
    moneyLifetimeSpent: sanitizeCreditBalance(input?.moneyLifetimeSpent, 0),
    updatedAt: input?.updatedAt || nowIso()
  };
}

function sanitizeCreditTransaction(input) {
  const amountDelta = sanitizeCreditDelta(input?.amountDelta);
  const txId = sanitizeText(input?.txId || input?.id, "", 80) || creditTxId();
  return {
    id: sanitizeText(input?.id || txId, txId, 80),
    txId,
    idempotencyKey: sanitizeText(input?.idempotencyKey, "", 240),
    userId: sanitizeId(input?.userId, "local-user"),
    serviceId: sanitizeId(input?.serviceId || "system", "system"),
    modelId: sanitizeModelId(input?.modelId || ""),
    type: sanitizeText(input?.type, "adjust", 32) || "adjust",
    amountDelta,
    balanceBefore: sanitizeCreditBalance(input?.balanceBefore, 0),
    balanceAfter: sanitizeCreditBalance(input?.balanceAfter, 0),
    actor: sanitizeText(input?.actor, "system", 80),
    reason: sanitizeText(input?.reason, "", 160),
    details: sanitizeText(input?.details, "", 1200),
    createdAt: input?.createdAt || nowIso()
  };
}

function sanitizeModelPrice(input) {
  const modelId = sanitizeModelId(input?.modelId || "");
  return {
    serviceId: sanitizeId(input?.serviceId, "service"),
    modelId,
    displayName: sanitizeText(input?.displayName, modelId, 120),
    creditCost: sanitizeCreditCost(input?.creditCost, 1),
    creditPerKTok: sanitizeCreditPerKTok(input?.creditPerKTok),
    enabled: input?.enabled !== false,
    isDefault: input?.isDefault === true,
    observedFromLoader: input?.observedFromLoader === true,
    source: sanitizeText(input?.source, "admin", 40),
    updatedAt: input?.updatedAt || nowIso()
  };
}

function sanitizeLocalStoreRecord(input) {
  return {
    userId: sanitizeId(input?.userId, "local-user"),
    profileId: sanitizeId(input?.profileId || "default", "default"),
    serviceId: sanitizeId(input?.serviceId, "service"),
    origin: sanitizeOrigin(input?.origin),
    key: String(input?.key || "").slice(0, 240),
    value: String(input?.value || "").slice(0, 500000),
    updatedAt: input?.updatedAt || nowIso()
  };
}

function uiCacheItemKey(input) {
  const cleanServiceId = sanitizeId(input?.serviceId, "service");
  const chatId = sanitizeText(input?.chatId || input?.itemId || "", "", 160);
  const href = sanitizeText(input?.href || "", "", 1000);
  return `${cleanServiceId}:${chatId || href}`;
}

function sanitizeUiCacheItem(input) {
  const href = sanitizeText(input?.href || "", "", 1000);
  const chatId = sanitizeText(input?.chatId || input?.itemId || "", "", 160);
  const itemId = sanitizeText(input?.itemId || chatId || href, "", 220);
  return {
    userId: sanitizeId(input?.userId, "local-user"),
    profileId: sanitizeId(input?.profileId || "default", "default"),
    serviceId: sanitizeId(input?.serviceId, "service"),
    itemId,
    chatId,
    href,
    title: sanitizeText(input?.title, "Untitled", 240),
    source: sanitizeText(input?.source, "dom", 40),
    hidden: input?.hidden === true,
    firstSeenAt: input?.firstSeenAt || nowIso(),
    lastSeenAt: input?.lastSeenAt || input?.updatedAt || nowIso(),
    sessionId: sanitizeText(input?.sessionId || "", "", 120),
    updatedAt: input?.updatedAt || nowIso()
  };
}

function sanitizeActivity(input) {
  return {
    userId: sanitizeId(input?.userId, "local-user"),
    deviceId: sanitizeId(input?.deviceId || input?.userId || "device", "device"),
    profileId: sanitizeId(input?.profileId || "default", "default"),
    serviceId: sanitizeId(input?.serviceId || "service", "service"),
    action: sanitizeText(input?.action, "event", 80),
    url: sanitizeText(input?.url, "", 2048),
    title: sanitizeText(input?.title, "", 240),
    details: sanitizeText(input?.details, "", 1000),
    createdAt: input?.createdAt || nowIso()
  };
}

function sanitizeModelUsage(input) {
  return {
    userId: sanitizeId(input?.userId, "local-user"),
    serviceId: sanitizeId(input?.serviceId, "service"),
    modelId: sanitizeModelId(input?.modelId || "unknown") || "unknown",
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(input?.day || "")) ? String(input.day) : todayKey(),
    count: Math.max(0, Math.min(1000000, Math.round(Number(input?.count || 0)))),
    credits: Math.max(0, Math.min(100000000, Math.round(Number(input?.credits ?? input?.count ?? 0)))),
    updatedAt: input?.updatedAt || nowIso()
  };
}

function sanitizeModelObservation(input) {
  return {
    serviceId: sanitizeId(input?.serviceId, "service"),
    modelId: sanitizeModelId(input?.modelId || "unknown") || "unknown",
    source: sanitizeText(input?.source, "loader", 80),
    url: sanitizeText(input?.url, "", 2048),
    count: Math.max(0, Math.min(1000000, Math.round(Number(input?.count || 0)))),
    firstSeenAt: input?.firstSeenAt || nowIso(),
    lastSeenAt: input?.lastSeenAt || nowIso()
  };
}

function modelPricesFromPolicies(policies = []) {
  const rows = [];
  for (const policy of policies || []) {
    const cleanPolicy = sanitizeModelPolicy(policy);
    for (const [modelId, creditCost] of Object.entries(cleanPolicy.modelCreditCosts || {})) {
      rows.push(sanitizeModelPrice({
        serviceId: cleanPolicy.serviceId,
        modelId,
        displayName: modelId,
        creditCost,
        enabled: true,
        isDefault: modelId === cleanPolicy.defaultModel,
        source: "legacy-policy",
        updatedAt: cleanPolicy.updatedAt || nowIso()
      }));
    }
  }
  return rows;
}

function mergeUniqueModelPrices(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const raw of group || []) {
      const price = sanitizeModelPrice(raw);
      if (!price.modelId) continue;
      const key = `${price.serviceId}:${price.modelId}`;
      map.set(key, { ...(map.get(key) || {}), ...price });
    }
  }
  return Array.from(map.values());
}

function ensureWalletsForUsers(wallets, users) {
  const map = new Map((wallets || []).map((wallet) => [wallet.userId, sanitizeCreditWallet(wallet)]));
  for (const user of users || []) {
    if (!map.has(user.id)) {
      map.set(user.id, sanitizeCreditWallet({
        userId: user.id,
        balance: defaultWalletBalanceForUser(user.id),
        updatedAt: nowIso()
      }));
    }
  }
  return Array.from(map.values());
}

function sanitizeUrlHistoryRow(input) {
  const url = sanitizeText(input?.url || input?.href, "", 2048);
  if (!url) return null;
  return {
    userId: sanitizeId(input?.userId, "local-user"),
    url,
    title: sanitizeText(input?.title, "", 300),
    serviceId: sanitizeText(input?.serviceId, "", 120),
    serviceName: sanitizeText(input?.serviceName, "", 200),
    host: sanitizeText(input?.host, "", 200),
    at: Math.max(0, Math.round(Number(input?.at) || 0)) || Date.now()
  };
}

const BLOCKED_LINK_MATCH_TYPES = new Set(["exact", "prefix", "origin", "glob"]);
function sanitizeBlockedLink(row = {}) {
  const pattern = String(row?.pattern || "").trim().slice(0, 2048);
  if (!pattern) return null;
  let matchType = String(row?.matchType || "prefix").trim().toLowerCase();
  if (!BLOCKED_LINK_MATCH_TYPES.has(matchType)) matchType = "prefix";
  return {
    userId: sanitizeId(row?.userId, SERVICE_UI_RULE_USER_ID),
    serviceId: String(row?.serviceId || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 48),
    pattern,
    matchType,
    enabled: row?.enabled !== false,
    note: String(row?.note || "").slice(0, 400),
    message: String(row?.message || "").slice(0, 400),
    updatedAt: row?.updatedAt || nowIso()
  };
}

function sanitizeDb(input) {
  const fallback = createDb();
  const users = (Array.isArray(input?.users) && input.users.length ? input.users : fallback.users)
    .map(sanitizeUser)
    .filter((user) => user.id !== SERVICE_UI_RULE_USER_ID);
  const userIds = new Set(users.map((user) => user.id));
  const isKnownUserOrServiceRule = (userId) => userIds.has(userId) || userId === SERVICE_UI_RULE_USER_ID;
  const serviceVisibility = (Array.isArray(input?.serviceVisibility) ? input.serviceVisibility : fallback.serviceVisibility)
    .map(sanitizeVisibility)
    .filter((row) => isKnownUserOrServiceRule(row.userId));
  const uiRules = (Array.isArray(input?.uiRules) ? input.uiRules : fallback.uiRules)
    .map(sanitizeUiRule)
    .filter((row) => isKnownUserOrServiceRule(row.userId));
  const blockedLinks = (Array.isArray(input?.blockedLinks) ? input.blockedLinks : fallback.blockedLinks)
    .map(sanitizeBlockedLink)
    .filter((row) => row && isKnownUserOrServiceRule(row.userId));
  const accounts = (Array.isArray(input?.accounts) && input.accounts.length ? input.accounts : fallback.accounts)
    .map(sanitizeAccount)
    .filter((row) => row.email && row.token && userIds.has(row.userId));
  const modelPolicies = (Array.isArray(input?.modelPolicies) ? input.modelPolicies : fallback.modelPolicies)
    .map(sanitizeModelPolicy)
    .filter((row) => userIds.has(row.userId));
  const hasExplicitModelPrices = Array.isArray(input?.modelPrices);
  const modelPrices = mergeUniqueModelPrices(
    hasExplicitModelPrices ? [] : fallback.modelPrices,
    hasExplicitModelPrices ? [] : modelPricesFromPolicies(modelPolicies),
    hasExplicitModelPrices ? input.modelPrices : []
  );
  const modelUsage = (Array.isArray(input?.modelUsage) ? input.modelUsage : [])
    .map(sanitizeModelUsage)
    .filter((row) => userIds.has(row.userId))
    .slice(-MAX_ACTIVITY);
  const modelObservations = (Array.isArray(input?.modelObservations) ? input.modelObservations : [])
    .map(sanitizeModelObservation)
    .slice(-MAX_ACTIVITY);
  const creditWallets = ensureWalletsForUsers(
    Array.isArray(input?.creditWallets) ? input.creditWallets : fallback.creditWallets,
    users
  );
  const creditTransactions = (Array.isArray(input?.creditTransactions) ? input.creditTransactions : [])
    .map(sanitizeCreditTransaction)
    .filter((row) => userIds.has(row.userId))
    .slice(-MAX_ACTIVITY * 4);
  // Giao dịch ví VND (nạp/mua-credit/mua-gói/điều chỉnh) — cần cho DOANH THU (mỗi lần nạp ví = tiền vào). Pass
  // qua nguyên trạng từ dbapi (đã chuẩn hoá camelCase), chỉ lọc theo user hợp lệ + cap.
  const moneyTransactions = (Array.isArray(input?.moneyTransactions) ? input.moneyTransactions : [])
    .filter((row) => row && row.userId && userIds.has(row.userId))
    .slice(-MAX_ACTIVITY * 4);
  const localStore = (Array.isArray(input?.localStore) ? input.localStore : [])
    .map(sanitizeLocalStoreRecord)
    .filter((row) => userIds.has(row.userId) && row.origin && row.key)
    .slice(-MAX_LOCAL_STORE_RECORDS);
  const uiCacheItems = (Array.isArray(input?.uiCacheItems) ? input.uiCacheItems : [])
    .map(sanitizeUiCacheItem)
    .filter((row) => userIds.has(row.userId) && row.serviceId && (row.chatId || row.href))
    .slice(-MAX_UI_CACHE_ITEMS);
  const uiRuleReports = (Array.isArray(input?.uiRuleReports) ? input.uiRuleReports : [])
    .map(sanitizeUiRuleReport)
    .filter((row) => isKnownUserOrServiceRule(row.userId) && row.serviceId && row.ruleId)
    .slice(-MAX_UI_RULE_REPORTS);
  const activity = (Array.isArray(input?.activity) ? input.activity : [])
    .map(sanitizeActivity)
    .filter((row) => userIds.has(row.userId))
    .slice(-MAX_ACTIVITY);
  const urlHistory = (Array.isArray(input?.urlHistory) ? input.urlHistory : [])
    .map(sanitizeUrlHistoryRow)
    .filter((row) => row && userIds.has(row.userId))
    .slice(-(MAX_URL_HISTORY_PER_USER * 16)); // generous global guard; per-user cap enforced on write/read
  const authSessions = (Array.isArray(input?.authSessions) ? input.authSessions : [])
    .map(sanitizeAuthSession)
    .filter((row) => row.token && userIds.has(row.userId))
    .slice(-MAX_ACTIVITY);
  const portal = sanitizePortalData(input?.portal || fallback.portal);

  return {
    version: DB_VERSION,
    updatedAt: input?.updatedAt || nowIso(),
    source: input?.source || "json",
    users,
    serviceVisibility,
    uiRules,
    blockedLinks,
    modelPolicies,
    modelPrices,
    modelUsage,
    modelObservations,
    creditWallets,
    creditTransactions,
    moneyTransactions,
    accounts,
    localStore,
    uiCacheItems,
    uiRuleReports,
    authSessions,
    activity,
    urlHistory,
    portal
  };
}

function apiDbSnapshot(input) {
  const db = sanitizeDb(input);
  return {
    ...db,
    source: input?.source || "docker-sqlite",
    filePath: input?.filePath || "docker://centrix-local-db/data/centrix-local-db.sqlite",
    dataPath: input?.dataPath || ""
  };
}

function shouldUseDbApi() {
  return process.env.CENTRIX_LOCAL_DB_MODE !== "json" && Boolean(DB_API_URL);
}

// Fresh-socket HTTP client for the DB API (see the WHY note inside dbApiRequest's loop).
const _http = require("node:http");
function dbHttpRequest(method, urlStr, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const data = bodyStr ? Buffer.from(bodyStr) : null;
    const headers = { Connection: "close" };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = data.length; }
    const req = _http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let raw = ""; res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve({ status: res.statusCode, text: raw }));
    });
    const to = setTimeout(() => req.destroy(new Error("db-api-timeout")), Math.max(1, timeoutMs || 8000));
    req.on("error", (e) => { clearTimeout(to); reject(e); });
    req.on("close", () => clearTimeout(to));
    if (data) req.write(data);
    req.end();
  });
}

async function dbApiRequest(pathname, options = {}) {
  if (!shouldUseDbApi()) {
    throw new Error("Docker DB disabled");
  }

  // The Docker SQLite store is AUTHORITATIVE — the gate (model-usage, policy, wallet, auth) reads it.
  // A WRITE that silently falls back to JSON therefore diverges the two stores and the change never
  // reaches the gate (this caused wallet/policy/session inconsistencies). So:
  //   - READs honor a short skip-window after a Docker error (warm JSON fallback covers the gap).
  //   - WRITEs ignore the skip-window and retry, so they keep trying to reach the authoritative store
  //     before any fallback. A single slow Docker response no longer routes writes to JSON.
  const isWrite = String(options.method || "GET").toUpperCase() !== "GET";
  const routeKey = String(pathname).split("?")[0];

  // Route the app already learned is unimplemented by this Docker image straight to JSON.
  if (dbApiMissingRoutes.has(routeKey)) {
    throw new Error(`Docker DB route ${routeKey} not implemented`);
  }

  if (!isWrite && Date.now() < dbApiSkipUntil) {
    throw new Error(dbApiLastError || "Docker DB temporarily unavailable");
  }

  const attempts = isWrite ? 3 : 1;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // Node core http, fresh (agent:false) socket per call — NOT global fetch/undici. undici pools
      // keep-alive connections, which race with the Python DB API (HTTP/1.0: closes each connection) under
      // concurrent load → POST writes stalled on dead sockets until the 8s timeout, retried 3× (~24s hang,
      // surfaced as Cloudflare 524 + "admin changes don't save"). A fresh localhost socket is sub-ms.
      const response = await dbHttpRequest(
        options.method || "GET",
        `${DB_API_URL}${pathname}`,
        options.body ? JSON.stringify(options.body) : null,
        options.timeoutMs || DB_API_TIMEOUT_MS
      );
      const raw = response.text;
      const result = raw ? JSON.parse(raw) : {};
      if (response.status < 200 || response.status >= 300 || !result.ok) {
        const err = new Error(result.error || `Docker DB HTTP ${response.status}`);
        err.httpStatus = response.status;
        throw err;
      }
      dbApiLastError = "";
      if (isWrite) invalidateDbCache(); // a write mutated Docker → the cached /db snapshot is now stale
      return result;
    } catch (error) {
      lastError = error;
      dbApiLastError = error.message || String(error);
      const httpStatus = Number(error?.httpStatus || 0);
      // A 404 means the Docker image simply doesn't implement this route — remember it so future calls
      // skip Docker entirely and use JSON.
      if (httpStatus === 404) dbApiMissingRoutes.add(routeKey);
      // Only real outages (timeout / connection refused / 5xx) trip the read skip-window. A 4xx is a
      // per-request/per-route condition, not a Docker health problem; tripping the window on it would
      // wrongly route OTHER reads (wallet, policy) to JSON and diverge the authoritative store.
      const isClientError = httpStatus >= 400 && httpStatus < 500;
      if (!isWrite && !isClientError) dbApiSkipUntil = Date.now() + DB_API_RETRY_MS;
      // Retrying a 4xx (missing route / rejected request) won't change the outcome — stop and fall back.
      if (isClientError) break;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }
  throw lastError;
}

// Unique per-writer temp names (writeJsonLocalDb) don't self-heal on abnormal death (SIGKILL/OOM/redeploy
// kill between writeFile and rename) the way the old fixed "<file>.tmp" did (a later O_TRUNC overwrote it).
// Sweep once per process, best-effort, and ONLY orphans older than 60s so a concurrent worker's in-flight
// temp (writes finish in ms) is never deleted out from under its rename. Fire-and-forget — never blocks I/O.
let localTmpSwept = false;
function sweepStaleLocalDbTemps(dir, baseName) {
  const re = new RegExp("^" + baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.\\d+\\.\\d+\\.tmp$");
  (async () => {
    try {
      const cutoff = Date.now() - 60000;
      for (const name of await fs.readdir(dir)) {
        if (!re.test(name)) continue;
        const p = path.join(dir, name);
        try { const st = await fs.stat(p); if (st.mtimeMs < cutoff) await fs.unlink(p); } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
  })();
}

async function ensureLocalDb() {
  const filePath = localDbPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!localTmpSwept) { localTmpSwept = true; sweepStaleLocalDbTemps(path.dirname(filePath), path.basename(filePath)); }

  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(createDb(), null, 2), "utf8");
  }

  return filePath;
}

async function readJsonLocalDb() {
  const filePath = await ensureLocalDb();

  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return { ...sanitizeDb(parsed), source: "json", filePath };
  } catch {
    const db = createDb();
    await fs.writeFile(filePath, JSON.stringify(db, null, 2), "utf8");
    return { ...db, source: "json", filePath };
  }
}

// Windows: fs.rename over an existing file throws EPERM/EBUSY/EACCES when an AV scanner, the search
// indexer, or a backup agent holds a brief handle on the destination. local-db.json is large (~4MB)
// and rewritten often (5s Docker warm + every activity), so an occasional collision made the write
// throw -> the API route 500'd -> the App User model gate FAILED OPEN (a model not enabled in the
// price table slipped through on real submits). The lock clears within milliseconds, so retry the
// rename a few times with a short backoff before giving up.
async function renameThroughTransientLock(from, to, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = error && error.code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (i + 1)));
    }
  }
}

let jsonTmpSeq = 0;
async function writeJsonLocalDb(nextDb) {
  const filePath = await ensureLocalDb();
  const db = sanitizeDb({ ...nextDb, updatedAt: nowIso() });
  // UNIQUE temp per writer. A fixed "<file>.tmp" collides across the 8-worker cluster (withJsonDbLock is
  // in-process only, so each worker serializes independently): two workers write the SAME temp, worker A
  // renames it away, worker B's rename then hits ENOENT (source gone) → the write threw → the route 500'd
  // (seen on POST /api/users/activity). pid+seq makes each writer own its temp so rename stays atomic and
  // never races. Best-effort unlink on failure so a throw can't litter orphan temps.
  const tempPath = `${filePath}.${process.pid}.${(jsonTmpSeq = (jsonTmpSeq + 1) % 1e9)}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(db, null, 2), "utf8");
    await renameThroughTransientLock(tempPath, filePath);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch { /* best-effort */ }
    throw error;
  }
  return { ...db, source: "json", filePath };
}

function resetJsonLocalDb() {
  return withJsonDbLock(() => resetJsonLocalDbLocked());
}
async function resetJsonLocalDbLocked() {
  return writeJsonLocalDb(createDb());
}

// The JSON store has no transactions, so concurrent read-modify-write operations
// can clobber each other (e.g. two debits both read the same balance and the
// second write loses the first → lost credit). Serialize EVERY JSON mutator
// through a single in-process queue so each completes its read→write before the
// next starts. (The Docker SQLite path is already atomic via busy_timeout +
// conditional UPDATE; this protects the JSON fallback path.) Mutators must NOT
// call each other (would deadlock the chain) — only dispatchers call them.
let jsonDbQueue = Promise.resolve();
function withJsonDbLock(fn) {
  const result = jsonDbQueue.then(fn, fn);
  jsonDbQueue = result.then(() => {}, () => {});
  return result;
}

function defaultVisibilityForUser(user) {
  // Enabled services are visible to ALL users by default — so a service set up + logged in via
  // the App Server loader shows up for every App User without per-user grants. The global access
  // tab (SERVICE_UI_RULE_USER_ID) or a per-user record can still override to hide specific ones.
  return user?.enabled !== false;
}

function serviceVisibleForUser(db, userId, serviceId) {
  const cleanUserId = sanitizeId(userId, "local-user");
  const user = db.users.find((item) => item.id === cleanUserId);
  if (!user || user.enabled === false) return false;

  // Thứ tự ưu tiên (2026-07-14 sửa để admin BỎ TÍCH per-user có tác dụng):
  //  1) Global HIDE (service-rule visible=0) = KILL-SWITCH → ẩn cho MỌI user (không ai override được).
  //  2) Per-user explicit (0 hoặc 1) → THẮNG global-show. Nhờ vậy bỏ tích 1 dịch vụ cho 1 khách = ẩn thật,
  //     kể cả khi có global-show. (Trước đây global-show đè per-user → bỏ tích không có tác dụng, "hiện lại".)
  //  3) Global SHOW (service-rule visible=1) = mặc định cho user CHƯA có dòng per-user.
  //  4) defaultVisibilityForUser.
  const globalRow = db.serviceVisibility.find((item) => item.userId === SERVICE_UI_RULE_USER_ID && item.serviceId === serviceId);
  if (globalRow && globalRow.visible === false) return false; // 1) global hide = kill-switch

  const row = db.serviceVisibility.find((item) => item.userId === cleanUserId && item.serviceId === serviceId);
  if (row) return row.visible !== false; // 2) per-user explicit thắng global-show

  if (globalRow) return globalRow.visible !== false; // 3) global show = mặc định
  return defaultVisibilityForUser(user); // 4)
}

// SECURITY (defense-in-depth for the client's userScript gate): userScript runs as arbitrary JS inside the
// user's logged-in service page, so it must not even LEAVE the server unless explicitly enabled. Strip it
// from every rule DELIVERED to an App User (via /api/services and the profile export) unless
// CENTRIX_ALLOW_UI_USERSCRIPT=1. This does NOT touch the Manager's raw read (GET /api/users returns
// db.uiRules directly) nor the storage/save path (sanitizeUiRule on write), so editing rules is unaffected.
const ALLOW_UI_USERSCRIPT = process.env.CENTRIX_ALLOW_UI_USERSCRIPT === "1";
function stripUserScriptForDelivery(rule) {
  if (ALLOW_UI_USERSCRIPT || !rule || !rule.userScript) return rule;
  return { ...rule, userScript: "" };
}

function uiRulesForService(db, userId, serviceId) {
  const cleanUserId = sanitizeId(userId, "local-user");
  const serviceRules = db.uiRules
    .filter((rule) => rule.userId === SERVICE_UI_RULE_USER_ID && rule.serviceId === serviceId)
    .map(sanitizeUiRule)
    .map(stripUserScriptForDelivery);
  if (serviceRules.length) return serviceRules;
  return db.uiRules
    .filter((rule) => rule.userId === cleanUserId && rule.serviceId === serviceId)
    .map(sanitizeUiRule)
    .map(stripUserScriptForDelivery);
}

// Manual blocked links for one (user, service): the UNION of the global sentinel rows and any per-user
// rows, filtered to this service (empty serviceId = applies to every service). Union (not precedence) is
// correct for a blocklist — any matching rule blocks. Returns the minimal shape the App User enforces on.
function blockedLinksForService(db, userId, serviceId) {
  const cleanUserId = sanitizeId(userId, "local-user");
  const sid = String(serviceId || "");
  const list = Array.isArray(db.blockedLinks) ? db.blockedLinks : [];
  return list
    .filter((row) => row && row.enabled !== false && row.pattern)
    .filter((row) => row.userId === SERVICE_UI_RULE_USER_ID || row.userId === cleanUserId)
    .filter((row) => !row.serviceId || row.serviceId === sid)
    .map((row) => ({ pattern: row.pattern, matchType: row.matchType || "prefix", message: row.message || "", serviceId: row.serviceId || "" }));
}

// Rules-with-profile: resolve the effective UI rules for one (user, service) pair from the DB —
// same precedence as servicesForUser (global "service-rule" rows win over per-user rows). Used by
// /api/profile/export so the rules ride INSIDE the exported profile snapshot.
async function uiRulesForServiceUser(userId, serviceId) {
  const db = await readLocalDb();
  return uiRulesForService(db, userId, String(serviceId || ""));
}

function modelPolicyForService(db, userId, serviceId) {
  const cleanUserId = sanitizeId(userId, "local-user");
  return db.modelPolicies
    .map(sanitizeModelPolicy)
    .find((policy) => policy.userId === cleanUserId && policy.serviceId === serviceId) || null;
}

function modelPricesForService(db, serviceId) {
  const cleanServiceId = sanitizeId(serviceId, "service");
  return (db.modelPrices || [])
    .map(sanitizeModelPrice)
    .filter((price) => price.serviceId === cleanServiceId)
    .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true) || a.modelId.localeCompare(b.modelId));
}

function modelPriceForService(db, serviceId, modelId) {
  const cleanModelId = sanitizeModelId(modelId || "");
  const prices = modelPricesForService(db, serviceId);
  return prices.find((price) => price.modelId === cleanModelId) || null;
}

function defaultModelPriceForService(db, serviceId) {
  const prices = modelPricesForService(db, serviceId).filter((price) => price.enabled !== false);
  return prices.find((price) => price.isDefault === true) || prices[0] || null;
}

function creditCostForUsage(db, policy, serviceId, modelId, estimatedTokens = 0) {
  const price = modelPriceForService(db, serviceId, modelId);
  if (price) {
    if (price.enabled === false) return { price, creditCost: 0, priceDisabled: true, tokenBilled: false, tokens: 0 };
    const rate = sanitizeCreditPerKTok(price.creditPerKTok);
    const toks = Math.max(0, Math.floor(Number(estimatedTokens) || 0));
    if (rate > 0 && toks > 0) {
      return { price, creditCost: tokenCreditCost(toks, rate), priceDisabled: false, tokenBilled: true, tokens: toks };
    }
    return { price, creditCost: sanitizeCreditCost(price.creditCost, 1), priceDisabled: false, tokenBilled: false, tokens: toks };
  }
  const fallbackCost = sanitizeCreditCost(
    policy?.defaultCreditCost ?? policy?.serviceDefaultCreditCost,
    sanitizeCreditCost(policy?.serviceDefaultCreditCost, 1)
  );
  return {
    price: null,
    creditCost: policy ? creditCostForModel(policy, modelId) : fallbackCost,
    priceDisabled: false
  };
}

function serviceModelDefaults(db, service, policy) {
  const prices = modelPricesForService(db, service?.id);
  const enabledPrices = prices.filter((price) => price.enabled !== false);
  const defaultPrice =
    enabledPrices.find((price) => price.isDefault === true) ||
    enabledPrices.find((price) => price.modelId === sanitizeModelId(service?.defaultModel || "")) ||
    enabledPrices[0] ||
    null;
  const defaultModel = sanitizeModelId(
    policy?.defaultModel ||
    service?.defaultModel ||
    defaultPrice?.modelId ||
    ""
  );
  const defaultCreditCost = sanitizeCreditCost(
    defaultPrice?.creditCost ??
    service?.defaultCreditCost ??
    policy?.defaultCreditCost,
    1
  );

  return {
    prices,
    defaultModel,
    defaultCreditCost
  };
}

function walletForUser(db, userId) {
  const cleanUserId = sanitizeId(userId, "local-user");
  let wallet = (db.creditWallets || []).map(sanitizeCreditWallet).find((row) => row.userId === cleanUserId);
  if (!wallet) {
    wallet = sanitizeCreditWallet({
      userId: cleanUserId,
      balance: defaultWalletBalanceForUser(cleanUserId),
      updatedAt: nowIso()
    });
    db.creditWallets = [...(db.creditWallets || []), wallet];
  }
  return wallet;
}

function upsertWallet(db, nextWallet) {
  const wallet = sanitizeCreditWallet(nextWallet);
  const index = (db.creditWallets || []).findIndex((row) => row.userId === wallet.userId);
  if (index >= 0) db.creditWallets[index] = wallet;
  else db.creditWallets = [...(db.creditWallets || []), wallet];
  return wallet;
}

function appendCreditTransaction(db, input) {
  const tx = sanitizeCreditTransaction(input);
  db.creditTransactions = [...(db.creditTransactions || []), tx].slice(-(MAX_ACTIVITY * 4));
  return tx;
}

function adminSummaryFromDb(db) {
  const today = todayKey();
  const wallets = db.creditWallets || [];
  const transactions = db.creditTransactions || [];
  const todayDebits = transactions.filter((tx) => tx.type === "debit" && String(tx.createdAt || "").slice(0, 10) === today);
  const todayBlocked = transactions.filter((tx) => tx.type === "blocked" && String(tx.createdAt || "").slice(0, 10) === today);
  return {
    users: (db.users || []).length,
    enabledUsers: (db.users || []).filter((user) => user.enabled !== false).length,
    totalCredit: wallets.reduce((sum, wallet) => sum + Number(wallet.balance || 0), 0),
    spentToday: todayDebits.reduce((sum, tx) => sum + Math.abs(Number(tx.amountDelta || 0)), 0),
    usageToday: todayDebits.length,
    blockedToday: todayBlocked.length,
    modelPrices: (db.modelPrices || []).length,
    organizations: (db.portal?.organizations || []).length,
    pendingOrders: (db.portal?.topupOrders || []).filter((row) => row.status === "pending").length,
    openTickets: (db.portal?.supportTickets || []).filter((row) => row.status !== "closed").length,
    lowCreditUsers: wallets.filter((wallet) => Number(wallet.balance || 0) > 0 && Number(wallet.balance || 0) <= 5).length,
    updatedAt: nowIso()
  };
}

async function servicesForUser(globalConfig, userId) {
  const db = await readLocalDb();
  const cleanUserId = sanitizeId(userId, "local-user");
  const user = db.users.find((item) => item.id === cleanUserId) || sanitizeUser({ id: cleanUserId, name: cleanUserId });
  const services = (globalConfig?.services || [])
    .filter((service) => service.enabled !== false)
    .filter((service) => serviceVisibleForUser(db, cleanUserId, service.id))
    .map((service) => {
      const policy = modelPolicyForService(db, cleanUserId, service.id);
      const defaults = serviceModelDefaults(db, service, policy);
      const modelPolicy = policy
        ? {
            ...policy,
            defaultModel: policy.defaultModel || defaults.defaultModel,
            defaultCreditCost: sanitizeCreditCost(policy.defaultCreditCost, defaults.defaultCreditCost),
            serviceDefaultCreditCost: defaults.defaultCreditCost
          }
        : null;
      return {
        ...service,
        userId: cleanUserId,
        defaultModel: defaults.defaultModel,
        defaultCreditCost: defaults.defaultCreditCost,
        modelPricingEnabled: service.modelPricingEnabled !== false || defaults.prices.length > 0 || Boolean(policy),
        uiRules: uiRulesForService(db, cleanUserId, service.id),
        blockedLinks: blockedLinksForService(db, cleanUserId, service.id),
        modelPolicy,
        modelPrices: defaults.prices
      };
    });

  return {
    config: {
      ...globalConfig,
      services,
      userId: cleanUserId
    },
    user,
    creditWallet: walletForUser(db, cleanUserId),
    uiRules: db.uiRules.filter((rule) => rule.userId === cleanUserId || rule.userId === SERVICE_UI_RULE_USER_ID),
    modelPolicies: db.modelPolicies.filter((policy) => policy.userId === cleanUserId),
    modelPrices: db.modelPrices || [],
    filePath: db.filePath
  };
}

function upsertJsonUser(input) {
  return withJsonDbLock(() => upsertJsonUserLocked(input));
}
async function upsertJsonUserLocked(input) {
  const db = await readJsonLocalDb();
  const user = sanitizeUser({ ...input, updatedAt: nowIso() });
  const index = db.users.findIndex((item) => item.id === user.id);
  if (index >= 0) {
    db.users[index] = { ...db.users[index], ...user, createdAt: db.users[index].createdAt || user.createdAt };
  } else {
    db.users.push(user);
  }
  return writeJsonLocalDb(db);
}

function setJsonUserServiceVisibility(userId, serviceId, visible) {
  return withJsonDbLock(() => setJsonUserServiceVisibilityLocked(userId, serviceId, visible));
}
async function setJsonUserServiceVisibilityLocked(userId, serviceId, visible) {
  const db = await readJsonLocalDb();
  const cleanUserId = sanitizeId(userId, "local-user");
  const cleanServiceId = sanitizeId(serviceId, "service");
  if (cleanUserId !== SERVICE_UI_RULE_USER_ID && !db.users.some((user) => user.id === cleanUserId)) {
    db.users.push(sanitizeUser({ id: cleanUserId, name: cleanUserId }));
  }

  const row = sanitizeVisibility({
    userId: cleanUserId,
    serviceId: cleanServiceId,
    visible: visible !== false,
    updatedAt: nowIso()
  });
  const index = db.serviceVisibility.findIndex((item) => item.userId === cleanUserId && item.serviceId === cleanServiceId);
  if (index >= 0) db.serviceVisibility[index] = row;
  else db.serviceVisibility.push(row);
  return writeJsonLocalDb(db);
}

function setJsonUserUiRules(userId, serviceId, hideSelectors, enabled, replaceRules = [], hideRules = [], userScript = "", customCss = "") {
  return withJsonDbLock(() => setJsonUserUiRulesLocked(userId, serviceId, hideSelectors, enabled, replaceRules, hideRules, userScript, customCss));
}
async function setJsonUserUiRulesLocked(userId, serviceId, hideSelectors, enabled, replaceRules = [], hideRules = [], userScript = "", customCss = "") {
  const db = await readJsonLocalDb();
  const cleanUserId = sanitizeId(userId, "local-user");
  const cleanServiceId = sanitizeId(serviceId, "service");
  if (cleanUserId !== SERVICE_UI_RULE_USER_ID && !db.users.some((user) => user.id === cleanUserId)) {
    db.users.push(sanitizeUser({ id: cleanUserId, name: cleanUserId }));
  }

  const rule = sanitizeUiRule({
    userId: cleanUserId,
    serviceId: cleanServiceId,
    hideSelectors,
    hideRules,
    replaceRules,
    userScript,
    customCss,
    enabled,
    updatedAt: nowIso()
  });
  const index = db.uiRules.findIndex((item) => item.userId === cleanUserId && item.serviceId === cleanServiceId);
  if (index >= 0) db.uiRules[index] = rule;
  else db.uiRules.push(rule);
  return writeJsonLocalDb(db);
}

function updateUiRuleHealthFromReports(db, reports) {
  for (const report of reports) {
    const ruleRow = (db.uiRules || []).find((item) => item.userId === report.userId && item.serviceId === report.serviceId);
    if (!ruleRow) continue;
    const cleanRule = sanitizeUiRule(ruleRow);
    const index = cleanRule.hideRules.findIndex((rule) => rule.id === report.ruleId || rule.primarySelector === report.selector);
    if (index < 0) continue;
    const recent = (db.uiRuleReports || [])
      .filter((item) => item.userId === report.userId && item.serviceId === report.serviceId && item.ruleId === report.ruleId)
      .slice(-20);
    const missCount = recent.filter((item) => item.state === "red").length;
    const nextRule = {
      ...cleanRule.hideRules[index],
      lastVerifiedAt: report.createdAt,
      health: {
        state: report.state,
        recentMissRate: recent.length ? Number((missCount / recent.length).toFixed(3)) : (report.state === "red" ? 1 : 0),
        lastSeenMatchingAt: report.state === "green" || report.state === "yellow"
          ? report.createdAt
          : cleanRule.hideRules[index].health?.lastSeenMatchingAt || ""
      }
    };
    cleanRule.hideRules[index] = nextRule;
    const rowIndex = db.uiRules.findIndex((item) => item.userId === report.userId && item.serviceId === report.serviceId);
    if (rowIndex >= 0) db.uiRules[rowIndex] = sanitizeUiRule({ ...cleanRule, updatedAt: ruleRow.updatedAt || nowIso() });
  }
}

function recordJsonUiRuleReports(input = {}) {
  return withJsonDbLock(() => recordJsonUiRuleReportsLocked(input));
}
async function recordJsonUiRuleReportsLocked(input = {}) {
  const db = await readJsonLocalDb();
  const base = {
    userId: input.userId,
    serviceId: input.serviceId,
    url: input.url,
    origin: input.origin
  };
  const rawReports = Array.isArray(input.reports) ? input.reports : [input];
  const reports = rawReports
    .map((report) => sanitizeUiRuleReport({ ...base, ...report }))
    .filter((report) => report.ruleId && report.serviceId);
  if (!reports.length) return db;

  db.uiRuleReports = [...(db.uiRuleReports || []), ...reports].slice(-MAX_UI_RULE_REPORTS);
  updateUiRuleHealthFromReports(db, reports);
  db.updatedAt = nowIso();
  return writeJsonLocalDb(db);
}

function setJsonUserModelPolicy(input = {}) {
  return withJsonDbLock(() => setJsonUserModelPolicyLocked(input));
}
async function setJsonUserModelPolicyLocked(input = {}) {
  const db = await readJsonLocalDb();
  const cleanUserId = sanitizeId(input.userId, "local-user");
  const cleanServiceId = sanitizeId(input.serviceId, "service");
  if (!db.users.some((user) => user.id === cleanUserId)) {
    db.users.push(sanitizeUser({ id: cleanUserId, name: cleanUserId }));
  }

  const policy = sanitizeModelPolicy({
    ...input,
    userId: cleanUserId,
    serviceId: cleanServiceId,
    updatedAt: nowIso()
  });
  const index = db.modelPolicies.findIndex((item) => item.userId === cleanUserId && item.serviceId === cleanServiceId);
  if (index >= 0) db.modelPolicies[index] = policy;
  else db.modelPolicies.push(policy);
  return writeJsonLocalDb(db);
}

function checkJsonUserModelUsage(input = {}) {
  return withJsonDbLock(() => checkJsonUserModelUsageLocked(input));
}
async function checkJsonUserModelUsageLocked(input = {}) {
  const db = await readJsonLocalDb();
  const cleanUserId = sanitizeId(input.userId, "local-user");
  const cleanServiceId = sanitizeId(input.serviceId, "service");
  let modelId = sanitizeModelId(input.modelId || "");
  const day = todayKey();
  const consume = input.consume !== false;
  const idempotencyKey = usageIdempotencyKey(cleanUserId, cleanServiceId, input.usageRequestId || input.idempotencyKey);
  const policy = modelPolicyForService(db, cleanUserId, cleanServiceId);
  const serverDefaultCreditCost = sanitizeCreditCost(input.serviceDefaultCreditCost ?? input.defaultCreditCost, policy?.defaultCreditCost || 1);
  const effectivePolicy = policy
    ? { ...policy, serviceDefaultCreditCost: serverDefaultCreditCost }
    : { enabled: false, allowedModels: [], dailyLimit: 0, blockUnknown: false, defaultModel: "", modelCreditCosts: {}, defaultCreditCost: serverDefaultCreditCost, serviceDefaultCreditCost: serverDefaultCreditCost };
  let defaultedModel = false;
  if (!modelId && consume) {
    const fallbackModel = sanitizeModelId(input.serviceDefaultModel || input.defaultModel || policy?.defaultModel || "");
    if (fallbackModel) {
      modelId = fallbackModel;
      defaultedModel = true;
    } else if (effectivePolicy?.blockUnknown !== true) {
      modelId = unknownModelId();
      defaultedModel = true;
    }
  }
  const user = db.users.find((item) => item.id === cleanUserId) || sanitizeUser({ id: cleanUserId, name: cleanUserId });
  const wallet = walletForUser(db, cleanUserId);
  const existingTx = idempotencyKey
    ? (db.creditTransactions || []).find((tx) => tx.idempotencyKey === idempotencyKey && tx.userId === cleanUserId)
    : null;
  if (existingTx && consume) {
    return {
      allowed: existingTx.type !== "blocked",
      reason: existingTx.reason || (existingTx.type === "blocked" ? "blocked" : "idempotent-replay"),
      modelId,
      defaultedModel,
      usage: (db.modelUsage || []).find((row) => row.userId === cleanUserId && row.serviceId === cleanServiceId && row.modelId === modelId && row.day === day) || null,
      creditCost: Math.abs(Number(existingTx.amountDelta || 0)),
      balance: existingTx.balanceAfter,
      wallet,
      transaction: existingTx,
      idempotent: true,
      policy: effectivePolicy
    };
  }

  if (!modelId) {
    if (!effectivePolicy || effectivePolicy.blockUnknown !== true) {
      return {
        allowed: true,
        reason: "unknown-model-allowed",
        policy: effectivePolicy,
        wallet
      };
    }
    if (consume) {
      appendCreditTransaction(db, {
        idempotencyKey,
        userId: cleanUserId,
        serviceId: cleanServiceId,
        type: "blocked",
        amountDelta: 0,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance,
        actor: "system",
        reason: "unknown-model-blocked",
        details: JSON.stringify({ url: sanitizeText(input.url, "", 2048) }),
        createdAt: nowIso()
      });
      await writeJsonLocalDb(db);
    }
    return {
      allowed: false,
      reason: "unknown-model-blocked",
      policy: effectivePolicy,
      wallet,
      balance: wallet.balance
    };
  }

  // Per-user allowedModels gating is intentionally DISABLED — model access is GLOBAL via the
  // per-service price table (mirrors the Docker gate; admin enables/disables once for every user).
  // Global per-service allow-list: when the service has any ENABLED priced model, ONLY those models
  // are usable by every user; disabled or unlisted models are blocked. Loader (admin) bypasses; the
  // resolved default model is always enabled so normal chats pass.
  const enabledModelIds = new Set(
    (db.modelPrices || [])
      .filter((priceRow) => priceRow.serviceId === cleanServiceId && priceRow.enabled !== false)
      .map((priceRow) => priceRow.modelId)
  );
  if (
    enabledModelIds.size > 0 &&
    user?.role !== "loader" &&
    modelId !== unknownModelId() &&
    !enabledModelIds.has(modelId)
  ) {
    return {
      allowed: false,
      reason: "model-not-enabled",
      modelId,
      creditCost: 0,
      wallet,
      balance: wallet.balance,
      policy: effectivePolicy
    };
  }

  const maxTok = (() => { const v = Number(process.env.CENTRIX_MAX_TOKENS_PER_REQUEST); return Number.isFinite(v) && v >= 0 ? v : 2000000; })();
  let estimatedTokens = Math.max(0, Math.floor(Number(input?.estimatedTokens) || 0));
  if (maxTok > 0) estimatedTokens = Math.min(estimatedTokens, maxTok);
  const { price, creditCost, priceDisabled } = creditCostForUsage(db, effectivePolicy, cleanServiceId, modelId, estimatedTokens);
  if (priceDisabled) {
    return {
      allowed: false,
      reason: "model-price-disabled",
      modelId,
      creditCost: 0,
      balance: wallet.balance,
      wallet,
      price,
      policy: effectivePolicy
    };
  }

  const usageIndex = db.modelUsage.findIndex((row) => (
    row.userId === cleanUserId &&
    row.serviceId === cleanServiceId &&
    row.modelId === modelId &&
    row.day === day
  ));
  const current = usageIndex >= 0 ? sanitizeModelUsage(db.modelUsage[usageIndex]) : sanitizeModelUsage({
    userId: cleanUserId,
    serviceId: cleanServiceId,
    modelId,
    day,
    count: 0,
    credits: 0
  });
  const projectedCredits = current.credits + creditCost;

  if (effectivePolicy?.enabled === true && effectivePolicy.dailyLimit > 0 && projectedCredits > effectivePolicy.dailyLimit) {
    if (consume) {
      appendCreditTransaction(db, {
        idempotencyKey,
        userId: cleanUserId,
        serviceId: cleanServiceId,
        modelId,
        type: "blocked",
        amountDelta: 0,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance,
        actor: "system",
        reason: "safety-daily-cap-reached",
        details: JSON.stringify({ creditCost, usedToday: current.credits, safetyCap: effectivePolicy.dailyLimit }),
        createdAt: nowIso()
      });
      await writeJsonLocalDb(db);
    }
    return {
      allowed: false,
      reason: "safety-daily-cap-reached",
      modelId,
      usage: current,
      creditCost,
      remaining: Math.max(0, wallet.balance - creditCost),
      balance: wallet.balance,
      wallet,
      price,
      policy: effectivePolicy
    };
  }

  if (user.role !== "loader" && wallet.balance < creditCost) {
    if (consume) {
      appendCreditTransaction(db, {
        idempotencyKey,
        userId: cleanUserId,
        serviceId: cleanServiceId,
        modelId,
        type: "blocked",
        amountDelta: 0,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance,
        actor: "system",
        reason: "insufficient-credit",
        details: JSON.stringify({ creditCost, balance: wallet.balance, price }),
        createdAt: nowIso()
      });
      await writeJsonLocalDb(db);
    }
    return {
      allowed: false,
      reason: "insufficient-credit",
      modelId,
      usage: current,
      creditCost,
      remaining: wallet.balance,
      balance: wallet.balance,
      wallet,
      price,
      policy: effectivePolicy
    };
  }

  const next = consume
    ? { ...current, count: current.count + 1, credits: projectedCredits, updatedAt: nowIso() }
    : current;
  let transaction = null;
  if (consume) {
    if (usageIndex >= 0) db.modelUsage[usageIndex] = next;
    else db.modelUsage.push(next);
    db.modelUsage = db.modelUsage.slice(-MAX_ACTIVITY);
    if (user.role !== "loader") {
      const balanceBefore = wallet.balance;
      const balanceAfter = Math.max(0, balanceBefore - creditCost);
      const nextWallet = {
        ...wallet,
        balance: balanceAfter,
        lifetimeSpent: Number(wallet.lifetimeSpent || 0) + creditCost,
        updatedAt: nowIso()
      };
      upsertWallet(db, nextWallet);
      transaction = appendCreditTransaction(db, {
        idempotencyKey,
        userId: cleanUserId,
        serviceId: cleanServiceId,
        modelId,
        type: "debit",
        amountDelta: -creditCost,
        balanceBefore,
        balanceAfter,
        actor: "system",
        reason: "model-usage",
        details: JSON.stringify({ price, defaultedModel, url: sanitizeText(input.url, "", 2048) }),
        createdAt: nowIso()
      });
    }
    await writeJsonLocalDb(db);
  }

  return {
    allowed: true,
    reason: "allowed",
    modelId,
    defaultedModel,
    usage: next,
    creditCost,
    remaining: consume && user.role !== "loader" ? Math.max(0, wallet.balance - creditCost) : wallet.balance,
    balance: consume && user.role !== "loader" ? Math.max(0, wallet.balance - creditCost) : wallet.balance,
    wallet: walletForUser(db, cleanUserId),
    price,
    transaction,
    policy: effectivePolicy
  };
}

function observeJsonModel(input = {}) {
  return withJsonDbLock(() => observeJsonModelLocked(input));
}
async function observeJsonModelLocked(input = {}) {
  const db = await readJsonLocalDb();
  const row = sanitizeModelObservation({
    ...input,
    count: 1,
    firstSeenAt: nowIso(),
    lastSeenAt: nowIso()
  });
  const index = db.modelObservations.findIndex((item) => (
    item.serviceId === row.serviceId &&
    item.modelId === row.modelId &&
    item.source === row.source
  ));

  if (index >= 0) {
    db.modelObservations[index] = {
      ...db.modelObservations[index],
      url: row.url || db.modelObservations[index].url,
      count: Math.max(0, Number(db.modelObservations[index].count || 0)) + 1,
      lastSeenAt: nowIso()
    };
  } else {
    db.modelObservations.push(row);
  }

  db.modelObservations = db.modelObservations.slice(-MAX_ACTIVITY);
  return writeJsonLocalDb(db);
}

function setJsonModelPrices(input = {}) {
  return withJsonDbLock(() => setJsonModelPricesLocked(input));
}
async function setJsonModelPricesLocked(input = {}) {
  const db = await readJsonLocalDb();
  const serviceId = sanitizeId(input.serviceId, "service");
  const rawPrices = Array.isArray(input.prices) ? input.prices : [];
  const nextPrices = rawPrices
    .map((price) => sanitizeModelPrice({
      ...price,
      serviceId,
      updatedAt: nowIso()
    }))
    .filter((price) => price.modelId);
  db.modelPrices = [
    ...(db.modelPrices || []).filter((price) => price.serviceId !== serviceId),
    ...nextPrices
  ];
  return writeJsonLocalDb(db);
}

function adjustJsonUserCredit(input = {}) {
  return withJsonDbLock(() => adjustJsonUserCreditLocked(input));
}
async function adjustJsonUserCreditLocked(input = {}) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input.userId, "local-user");
  const delta = sanitizeCreditDelta(input.amountDelta ?? input.amount);
  if (!delta) throw new Error("Credit adjustment amount must not be zero");
  if (!db.users.some((user) => user.id === userId)) {
    db.users.push(sanitizeUser({ id: userId, name: userId }));
  }
  const wallet = walletForUser(db, userId);
  const balanceBefore = wallet.balance;
  const balanceAfter = sanitizeCreditBalance(balanceBefore + delta, 0);
  const nextWallet = {
    ...wallet,
    balance: balanceAfter,
    lifetimeAdded: Number(wallet.lifetimeAdded || 0) + Math.max(0, delta),
    lifetimeSpent: Number(wallet.lifetimeSpent || 0) + Math.max(0, -delta),
    updatedAt: nowIso()
  };
  upsertWallet(db, nextWallet);
  appendCreditTransaction(db, {
    userId,
    serviceId: "admin",
    type: delta > 0 ? "topup" : "adjust",
    amountDelta: delta,
    balanceBefore,
    balanceAfter,
    actor: sanitizeText(input.actor, "admin", 80),
    reason: sanitizeText(input.reason, delta > 0 ? "manual-topup" : "manual-adjust", 160),
    details: JSON.stringify({ note: sanitizeText(input.note || input.details, "", 500) }),
    createdAt: nowIso()
  });
  return writeJsonLocalDb(db);
}

async function getJsonAdminSummary() {
  const db = await readJsonLocalDb();
  return {
    summary: adminSummaryFromDb(db),
    db
  };
}

function normalizePortalSection(section) {
  const clean = sanitizeText(section, "", 80);
  if (!PORTAL_SECTION_KEYS.includes(clean)) {
    throw new Error("Unknown portal section");
  }
  return clean;
}

function userPortalFromDb(db, userId) {
  const cleanUserId = sanitizeId(userId, "local-user");
  const portal = sanitizePortalData(db.portal);
  const user = (db.users || []).find((row) => row.id === cleanUserId) || null;
  const wallet = walletForUser(db, cleanUserId);
  const memberships = (portal.members || [])
    .filter((row) => row.userId === cleanUserId || row.email === user?.email);
  const orgIds = new Set(memberships.map((row) => row.orgId).filter(Boolean));
  const ownOrOrg = (row) => row.userId === cleanUserId || (row.orgId && orgIds.has(row.orgId));
  const activeSessions = (db.authSessions || [])
    .filter((row) => row.userId === cleanUserId && !row.revokedAt)
    .slice(-30)
    .map((row) => ({
      // Never surface secret material as the client-facing id — use the (non-secret) deviceId. The token is
      // hashed at rest anyway, but sessionKey is sensitive, so keep both out of the portal payload.
      id: row.deviceId || row.profileId || row.issuedAt,
      deviceId: row.deviceId,
      profileId: row.profileId,
      email: row.email,
      issuedAt: row.issuedAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt || ""
    }));
  const visibleSettings = (portal.appSettings || [])
    .filter((row) => row.enabled !== false && (!row.userId || row.userId === cleanUserId || row.target === "all" || (row.orgId && orgIds.has(row.orgId))))
    .slice(-120);

  return {
    userId: cleanUserId,
    user,
    wallet,
    creditTransactions: (db.creditTransactions || []).filter((tx) => tx.userId === cleanUserId).slice(-120),
    packages: (() => { const cfg = (portal.creditPackages || []).filter((pkg) => pkg.enabled !== false); return cfg.length ? cfg : DEFAULT_CREDIT_PACKAGES; })(),
    plans: (portal.plans || []).filter((plan) => plan.enabled !== false),
    orders: (portal.topupOrders || []).filter(ownOrOrg).slice(-120),
    invoices: (portal.invoices || []).filter(ownOrOrg).slice(-120),
    tickets: (portal.supportTickets || []).filter(ownOrOrg).slice(-120),
    promotions: (portal.promotions || []).filter((row) => row.enabled !== false).slice(-120),
    notifications: (portal.notifications || []).filter((row) => row.enabled !== false && (row.target === "all" || row.userId === cleanUserId || (row.orgId && orgIds.has(row.orgId)))).slice(-50),
    settings: visibleSettings,
    devices: activeSessions,
    organization: (portal.organizations || []).filter((row) => orgIds.has(row.id)),
    departments: (portal.departments || []).filter((row) => orgIds.has(row.orgId)),
    members: memberships,
    usage: (db.modelUsage || []).filter((row) => row.userId === cleanUserId).slice(-120),
    updatedAt: nowIso()
  };
}

async function getJsonPortalSnapshot() {
  const db = await readJsonLocalDb();
  return {
    portal: sanitizePortalData(db.portal),
    db
  };
}

function setJsonPortalSection(input = {}) {
  return withJsonDbLock(() => setJsonPortalSectionLocked(input));
}
async function setJsonPortalSectionLocked(input = {}) {
  const db = await readJsonLocalDb();
  const section = normalizePortalSection(input.section);
  const portal = sanitizePortalData(db.portal);
  const stamp = nowIso();

  if (Array.isArray(input.records)) {
    portal[section] = input.records.map((row, index) => sanitizePortalRecord(section, { ...row, updatedAt: stamp }, index));
  } else if (input.action === "delete") {
    const id = sanitizeId(input.id, "");
    portal[section] = (portal[section] || []).filter((row) => row.id !== id);
  } else {
    const record = sanitizePortalRecord(section, {
      ...(input.record || {}),
      id: input.record?.id || input.id || portalRecordId(section),
      updatedAt: stamp,
      createdAt: input.record?.createdAt || stamp
    });
    const index = (portal[section] || []).findIndex((row) => row.id === record.id);
    if (index >= 0) portal[section][index] = { ...portal[section][index], ...record, updatedAt: stamp };
    else portal[section] = [...(portal[section] || []), record];
  }

  portal.updatedAt = stamp;
  db.portal = portal;
  const nextDb = await writeJsonLocalDb(db);
  return { portal: nextDb.portal, db: nextDb };
}

function createJsonPortalTopupRequest(input = {}) {
  return withJsonDbLock(() => createJsonPortalTopupRequestLocked(input));
}
async function createJsonPortalTopupRequestLocked(input = {}) {
  const db = await readJsonLocalDb();
  const portal = sanitizePortalData(db.portal);
  const userId = sanitizeId(input.userId, "local-user");
  const packageId = sanitizeId(input.packageId, "");
  const pack = (portal.creditPackages || []).find((row) => row.id === packageId) || null;
  const stamp = nowIso();
  const credits = sanitizeCreditBalance(input.credits ?? ((pack?.credits || 0) + (pack?.bonusCredits || 0)), 0);
  const amount = sanitizeCreditBalance(input.amount ?? pack?.price ?? 0, 0);
  const order = sanitizePortalRecord("topupOrders", {
    id: portalRecordId("order"),
    userId,
    orgId: sanitizeId(input.orgId || "", ""),
    packageId: packageId || pack?.id || "",
    credits,
    amount,
    currency: sanitizeText(input.currency || pack?.currency, "VND", 12),
    status: "pending",
    note: sanitizeText(input.note, "User topup request", 500),
    createdAt: stamp,
    updatedAt: stamp
  });
  portal.topupOrders = [order, ...(portal.topupOrders || [])].slice(0, 1000);
  portal.updatedAt = stamp;
  db.portal = portal;
  db.activity = [...(db.activity || []), sanitizeActivity({
    userId,
    serviceId: "billing",
    action: "topup-request",
    title: order.packageId || "manual",
    details: JSON.stringify({ orderId: order.id, credits, amount }),
    createdAt: stamp
  })].slice(-MAX_ACTIVITY);
  const nextDb = await writeJsonLocalDb(db);
  return { order, portal: nextDb.portal, userPortal: userPortalFromDb(nextDb, userId), db: nextDb };
}

function createJsonPortalSupportTicket(input = {}) {
  return withJsonDbLock(() => createJsonPortalSupportTicketLocked(input));
}
async function createJsonPortalSupportTicketLocked(input = {}) {
  const db = await readJsonLocalDb();
  const portal = sanitizePortalData(db.portal);
  const userId = sanitizeId(input.userId, "local-user");
  const stamp = nowIso();
  const ticket = sanitizePortalRecord("supportTickets", {
    id: portalRecordId("ticket"),
    userId,
    orgId: sanitizeId(input.orgId || "", ""),
    subject: sanitizeText(input.subject, "Yeu cau ho tro", 180),
    message: sanitizeText(input.message, "", 2000),
    status: "open",
    priority: sanitizeText(input.priority, "normal", 32),
    createdAt: stamp,
    updatedAt: stamp
  });
  portal.supportTickets = [ticket, ...(portal.supportTickets || [])].slice(0, 1000);
  portal.updatedAt = stamp;
  db.portal = portal;
  db.activity = [...(db.activity || []), sanitizeActivity({
    userId,
    serviceId: "support",
    action: "support-ticket",
    title: ticket.subject,
    details: JSON.stringify({ ticketId: ticket.id, priority: ticket.priority }),
    createdAt: stamp
  })].slice(-MAX_ACTIVITY);
  const nextDb = await writeJsonLocalDb(db);
  return { ticket, portal: nextDb.portal, userPortal: userPortalFromDb(nextDb, userId), db: nextDb };
}

function approveJsonPortalTopup(input = {}) {
  return withJsonDbLock(() => approveJsonPortalTopupLocked(input));
}
async function approveJsonPortalTopupLocked(input = {}) {
  const db = await readJsonLocalDb();
  const portal = sanitizePortalData(db.portal);
  const orderId = sanitizeId(input.orderId || input.id, "");
  const orderIndex = (portal.topupOrders || []).findIndex((row) => row.id === orderId);
  if (orderIndex < 0) throw new Error("Order not found");
  const order = portal.topupOrders[orderIndex];
  const userId = sanitizeId(order.userId, "local-user");
  const credits = sanitizeCreditDelta(input.credits ?? order.credits);
  if (credits <= 0) throw new Error("Order credits must be positive");
  const stamp = nowIso();
  if (order.creditedAt) {
    return { order, portal, userPortal: userPortalFromDb(db, userId), db };
  }
  const wallet = walletForUser(db, userId);
  const balanceBefore = wallet.balance;
  const balanceAfter = sanitizeCreditBalance(balanceBefore + credits, 0);
  upsertWallet(db, {
    ...wallet,
    balance: balanceAfter,
    lifetimeAdded: Number(wallet.lifetimeAdded || 0) + credits,
    updatedAt: stamp
  });
  portal.topupOrders[orderIndex] = {
    ...order,
    status: sanitizeText(input.status, "approved", 40),
    approvedBy: sanitizeText(input.actor, "admin", 80),
    creditedAt: stamp,
    updatedAt: stamp
  };
  portal.updatedAt = stamp;
  db.portal = portal;
  appendCreditTransaction(db, {
    userId,
    serviceId: "billing",
    type: "topup",
    amountDelta: credits,
    balanceBefore,
    balanceAfter,
    actor: sanitizeText(input.actor, "admin", 80),
    reason: `topup-order:${order.id}`,
    details: JSON.stringify({ orderId: order.id, packageId: order.packageId, amount: order.amount }),
    createdAt: stamp
  });
  const nextDb = await writeJsonLocalDb(db);
  return { order: nextDb.portal.topupOrders.find((row) => row.id === orderId), portal: nextDb.portal, userPortal: userPortalFromDb(nextDb, userId), db: nextDb };
}

async function getJsonUserPortal(input = {}) {
  const db = await readJsonLocalDb();
  return {
    portal: userPortalFromDb(db, input.userId),
    db
  };
}

function recordJsonUserActivity(input) {
  return withJsonDbLock(() => recordJsonUserActivityLocked(input));
}
async function recordJsonUserActivityLocked(input) {
  const db = await readJsonLocalDb();
  const row = sanitizeActivity(input);
  if (!db.users.some((user) => user.id === row.userId)) {
    db.users.push(sanitizeUser({ id: row.userId, name: row.userId }));
  }
  db.activity.push(row);
  db.activity = db.activity.slice(-MAX_ACTIVITY);
  return writeJsonLocalDb(db);
}

async function getJsonUserActivity(input = {}) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input?.userId, "local-user");
  const profileId = sanitizeId(input?.profileId || "", "");
  const serviceId = sanitizeId(input?.serviceId || "", "");
  const limit = Math.max(1, Math.min(500, Math.round(Number(input?.limit || 250))));
  const activity = (db.activity || [])
    .map(sanitizeActivity)
    .filter((row) => row.userId === userId)
    .filter((row) => !profileId || row.profileId === profileId)
    .filter((row) => !serviceId || row.serviceId === serviceId)
    .slice(-limit);
  return { activity, db };
}

// === Dedicated per-user usage-history (Nhật ký sử dụng) store ===
function saveJsonUrlHistory(input) {
  return withJsonDbLock(() => saveJsonUrlHistoryLocked(input));
}
async function saveJsonUrlHistoryLocked(input = {}) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input?.userId, "local-user");
  if (!db.users.some((user) => user.id === userId)) {
    db.users.push(sanitizeUser({ id: userId, name: userId }));
  }
  const incoming = (Array.isArray(input?.items) ? input.items : [])
    .map((item) => sanitizeUrlHistoryRow({ ...item, userId }))
    .filter(Boolean);
  // Upsert by url for THIS user (newest at wins, keep a title if the new one is empty); other users
  // are untouched. Per-user cap so a busy user never evicts another's history (unlike the global
  // activity cap).
  const byUrl = new Map();
  for (const row of (db.urlHistory || [])) {
    if (row.userId === userId) byUrl.set(row.url, row);
  }
  for (const row of incoming) {
    const prev = byUrl.get(row.url);
    if (!prev || row.at >= prev.at) {
      byUrl.set(row.url, { ...prev, ...row, title: row.title || prev?.title || "" });
    }
  }
  const mine = [...byUrl.values()].sort((a, b) => b.at - a.at).slice(0, MAX_URL_HISTORY_PER_USER);
  const others = (db.urlHistory || []).filter((row) => row.userId !== userId);
  db.urlHistory = [...mine, ...others];
  await writeJsonLocalDb(db);
  return { ok: true, urlHistory: mine };
}

async function getJsonUrlHistory(input = {}) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input?.userId, "local-user");
  const limit = Math.max(1, Math.min(MAX_URL_HISTORY_PER_USER, Math.round(Number(input?.limit || MAX_URL_HISTORY_PER_USER))));
  const urlHistory = (db.urlHistory || [])
    .map(sanitizeUrlHistoryRow)
    .filter((row) => row && row.userId === userId)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
  return { ok: true, urlHistory };
}

async function getUrlHistory(input = {}) {
  try {
    const userId = sanitizeId(input?.userId, "local-user");
    const limit = Math.round(Number(input?.limit || MAX_URL_HISTORY_PER_USER));
    const result = await dbApiRequest(
      `/users/url-history?userId=${encodeURIComponent(userId)}&limit=${encodeURIComponent(String(limit))}`,
      { method: "GET", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500) }
    );
    if (result) return { ok: true, urlHistory: Array.isArray(result.urlHistory) ? result.urlHistory : [] };
  } catch {
    // Fall back to JSON below.
  }
  return getJsonUrlHistory(input);
}

async function saveUrlHistory(input = {}) {
  try {
    const result = await dbApiRequest("/users/url-history", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result) return { ok: true, urlHistory: Array.isArray(result.urlHistory) ? result.urlHistory : [] };
  } catch {
    // Fall back to JSON below.
  }
  return saveJsonUrlHistory(input);
}

function saveJsonUserLocalStore(input) {
  return withJsonDbLock(() => saveJsonUserLocalStoreLocked(input));
}
async function saveJsonUserLocalStoreLocked(input) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input?.userId, "local-user");
  const profileId = sanitizeId(input?.profileId || "default", "default");
  const serviceId = sanitizeId(input?.serviceId, "service");
  const origin = sanitizeOrigin(input?.origin);
  const items = input?.items && typeof input.items === "object" ? input.items : {};

  if (!origin) return { ...(await writeJsonLocalDb(db)), saved: 0 };
  if (!db.users.some((user) => user.id === userId)) {
    db.users.push(sanitizeUser({ id: userId, name: userId }));
  }

  db.localStore = db.localStore.filter((row) => {
    return !(row.userId === userId && row.profileId === profileId && row.serviceId === serviceId && row.origin === origin);
  });

  for (const [key, value] of Object.entries(items).slice(0, 240)) {
    const record = sanitizeLocalStoreRecord({
      userId,
      profileId,
      serviceId,
      origin,
      key,
      value,
      updatedAt: nowIso()
    });
    if (record.key) db.localStore.push(record);
  }

  db.localStore = db.localStore.slice(-MAX_LOCAL_STORE_RECORDS);
  const nextDb = await writeJsonLocalDb(db);
  return { ...nextDb, saved: Object.keys(items).length };
}

async function getJsonUserLocalStore(input) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input?.userId, "local-user");
  const profileId = sanitizeId(input?.profileId || "default", "default");
  const serviceId = sanitizeId(input?.serviceId, "service");
  const origin = sanitizeOrigin(input?.origin);
  const items = {};

  for (const row of db.localStore) {
    if (row.userId === userId && row.profileId === profileId && row.serviceId === serviceId && row.origin === origin) {
      items[row.key] = row.value;
    }
  }

  return {
    userId,
    profileId,
    serviceId,
    origin,
    items,
    count: Object.keys(items).length
  };
}

function mergeUiCacheItems(existingItems, incomingItems) {
  const map = new Map();

  for (const raw of existingItems || []) {
    const item = sanitizeUiCacheItem(raw);
    const key = uiCacheItemKey(item);
    if (item.serviceId && key) map.set(key, item);
  }

  for (const raw of incomingItems || []) {
    const item = sanitizeUiCacheItem(raw);
    const key = uiCacheItemKey(item);
    if (!item.serviceId || !key || (!item.chatId && !item.href)) continue;
    const old = map.get(key);
    map.set(key, {
      ...old,
      ...item,
      firstSeenAt: old?.firstSeenAt || item.firstSeenAt || nowIso(),
      lastSeenAt: [old?.lastSeenAt, item.lastSeenAt, item.updatedAt, nowIso()].filter(Boolean).sort().at(-1),
      hidden: item.hidden === true || old?.hidden === true,
      updatedAt: nowIso()
    });
  }

  return Array.from(map.values())
    .sort((a, b) => String(a.lastSeenAt || "").localeCompare(String(b.lastSeenAt || "")))
    .slice(-MAX_UI_CACHE_ITEMS);
}

function saveJsonUserUiCache(input) {
  return withJsonDbLock(() => saveJsonUserUiCacheLocked(input));
}
async function saveJsonUserUiCacheLocked(input) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input?.userId, "local-user");
  const profileId = sanitizeId(input?.profileId || "default", "default");
  const serviceId = sanitizeId(input?.serviceId, "service");
  const items = Array.isArray(input?.items) ? input.items : [];

  if (!db.users.some((user) => user.id === userId)) {
    db.users.push(sanitizeUser({ id: userId, name: userId }));
  }

  const scopedIncoming = items.map((item) => sanitizeUiCacheItem({
    ...item,
    userId,
    profileId,
    serviceId,
    source: item?.source || input?.source || "dom",
    sessionId: item?.sessionId || input?.sessionId || ""
  })).filter((item) => item.chatId || item.href);

  const untouched = (db.uiCacheItems || []).filter((item) => {
    return !(item.userId === userId && item.profileId === profileId && item.serviceId === serviceId);
  });
  const scopedExisting = (db.uiCacheItems || []).filter((item) => {
    return item.userId === userId && item.profileId === profileId && item.serviceId === serviceId;
  });
  const merged = mergeUiCacheItems(scopedExisting, scopedIncoming);
  db.uiCacheItems = [...untouched, ...merged].slice(-MAX_UI_CACHE_ITEMS);
  const nextDb = await writeJsonLocalDb(db);
  return { ...nextDb, saved: scopedIncoming.length, uiCacheItems: merged };
}

async function getJsonUserUiCache(input) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input?.userId, "local-user");
  const profileId = sanitizeId(input?.profileId || "default", "default");
  const serviceId = sanitizeId(input?.serviceId, "service");
  const items = (db.uiCacheItems || [])
    .map(sanitizeUiCacheItem)
    .filter((item) => item.userId === userId && item.profileId === profileId && item.serviceId === serviceId && item.hidden !== true)
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
    .slice(0, 120);

  return {
    userId,
    profileId,
    serviceId,
    items,
    count: items.length
  };
}

function loginJsonAccount(input = {}) {
  // Password login GỠ (JSON-fallback) — chặn mint session password bỏ qua Docker/device-key.
  if (process.env.CENTRIX_DISABLE_PWD_LOGIN !== "0") {
    throw new Error("Password login disabled — use Google login");
  }
  return withJsonDbLock(() => loginJsonAccountLocked(input));
}
async function loginJsonAccountLocked(input = {}) {
  const db = await readJsonLocalDb();
  const email = sanitizeEmail(input.email);
  const account = db.accounts.find((item) => item.email === email && item.enabled !== false);
  const verdict = account ? verifyPassword(account.passwordHash, input.password || "") : { ok: false, needsRehash: false };
  if (!account || !verdict.ok) {
    throw new Error("Email hoac mat khau khong dung");
  }
  if (verdict.needsRehash) {
    // Transparent upgrade; persisted by the writeJsonLocalDb below (account is a live db ref).
    account.passwordHash = hashPassword(input.password || "");
  }

  const user = db.users.find((item) => item.id === account.userId);
  if (!user || user.enabled === false) {
    throw new Error("User da bi tat trong DB local");
  }

  const profileId = account.profileId || user.defaultProfileId || "default";
  const deviceId = sanitizeId(input.deviceId || "device", "device");
  const now = Date.now();
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + AUTH_SESSION_TTL_MS).toISOString();
  const token = newSessionToken();
  const sessionKey = crypto.randomBytes(32).toString("base64");
  const newDevice = !(db.authSessions || []).some(
    (s) => s.userId === account.userId && s.deviceId === deviceId && !s.revokedAt
  );
  db.authSessions = [
    ...(db.authSessions || []),
    sanitizeAuthSession({ token, userId: account.userId, profileId, deviceId, email: account.email, sessionKey, issuedAt, expiresAt, lastSeenAt: issuedAt })
  ].slice(-MAX_ACTIVITY);
  await writeJsonLocalDb(db);

  return {
    email: account.email,
    token,
    sessionKey,
    expiresAt,
    deviceId,
    newDevice,
    userId: account.userId,
    profileId,
    user
  };
}

function verifyJsonAccountToken(token) {
  return withJsonDbLock(() => verifyJsonAccountTokenLocked(token));
}
async function verifyJsonAccountTokenLocked(token) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return null;
  const db = await readJsonLocalDb();
  // Stored tokens are hashed at rest; hash the presented raw token to compare (unconditional — a leaked
  // at-rest hash presented as a token would re-hash and never match).
  const session = (db.authSessions || []).find((s) => s.token === hashSessionToken(cleanToken));
  if (!session || session.revokedAt) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return null;
  const account = db.accounts.find((item) => item.email === session.email && item.enabled !== false);
  if (!account) return null;
  const user = db.users.find((item) => item.id === session.userId);
  if (!user || user.enabled === false) return null;
  return {
    email: account.email,
    userId: session.userId,
    profileId: session.profileId || user.defaultProfileId || "default",
    deviceId: session.deviceId,
    sessionKey: vaultUnwrap(session.sessionKey),
    expiresAt: session.expiresAt,
    user
  };
}

function revokeJsonSession(input = {}) {
  return withJsonDbLock(() => revokeJsonSessionLocked(input));
}
async function revokeJsonSessionLocked(input = {}) {
  const db = await readJsonLocalDb();
  const token = String(input.token || "").trim();
  const tokenAtRest = hashSessionToken(token); // stored tokens are hashed → compare against the hash
  const userId = input.userId ? sanitizeId(input.userId, "local-user") : "";
  const deviceId = input.deviceId ? sanitizeId(input.deviceId, "device") : "";
  const stamp = nowIso();
  let revoked = 0;
  for (const s of db.authSessions || []) {
    if (s.revokedAt) continue;
    const match = token
      ? s.token === tokenAtRest
      : userId
        ? s.userId === userId && (!deviceId || s.deviceId === deviceId)
        : false;
    if (match) {
      s.revokedAt = stamp;
      revoked += 1;
    }
  }
  if (revoked) await writeJsonLocalDb(db);
  return { revoked };
}

let lastJsonWarmAt = 0;
// Short-TTL positive cache + in-flight coalescing for the full /db snapshot (~11MB). Concurrent/frequent admin
// reads (the SPA polls + /api/users|credits/ledger|model-prices) each pulled AND JSON-parsed the whole 11MB,
// saturating the Node event loop and Docker's single Python thread → the whole backend went laggy (health hit
// 6.8s; the App User connect-health timed out). Now at most ONE /db fetch per DB_CACHE_TTL_MS, SHARED by every
// concurrent caller; any WRITE calls invalidateDbCache() so a post-save read is fresh.
const DB_CACHE_TTL_MS = Math.max(0, Number(process.env.CENTRIX_DB_CACHE_TTL_MS || 1500));
let _dbCache = null, _dbCacheAt = 0, _dbInflight = null;
function invalidateDbCache() { _dbCache = null; _dbCacheAt = 0; }
async function readLocalDb() {
  if (_dbCache && DB_CACHE_TTL_MS && (Date.now() - _dbCacheAt) < DB_CACHE_TTL_MS) return _dbCache; // fresh → serve cache
  if (_dbInflight) return _dbInflight; // a fetch is already running → share it (coalesce concurrent readers)
  _dbInflight = _readLocalDbUncached();
  try { return await _dbInflight; } finally { _dbInflight = null; }
}
async function _readLocalDbUncached() {
  try {
    const result = await dbApiRequest("/db");
    if (result?.db) {
      const snapshot = apiDbSnapshot(result.db);
      _dbCache = snapshot; _dbCacheAt = Date.now(); // cache the authoritative snapshot for the TTL window
      // Keep the JSON fallback WARM with the authoritative Docker snapshot (throttled). Without this
      // the JSON store stayed stale (wallet 320 from days ago) and any read that momentarily fell
      // back to JSON returned wrong figures — the balance flapped 11308 ↔ 320. Best-effort + locked.
      const now = Date.now();
      if (now - lastJsonWarmAt > 5000) {
        lastJsonWarmAt = now;
        // Docker doesn't implement url-history — it's a JSON-only store, so the Docker /db snapshot
        // always carries urlHistory:[]. Warming the JSON straight from that snapshot WIPED the user's
        // saved usage log every 5s (lost on restart). Preserve the existing JSON url-history across the
        // warm so it persists per-user (survives restart + device change) until Docker tracks it natively.
        withJsonDbLock(async () => {
          let preservedUrlHistory = [];
          try {
            const current = JSON.parse(await fs.readFile(localDbPath(), "utf8"));
            if (Array.isArray(current.urlHistory)) preservedUrlHistory = current.urlHistory;
          } catch {
            // no existing JSON yet / unreadable — nothing to preserve
          }
          const dockerUrlHistory = Array.isArray(snapshot.urlHistory) ? snapshot.urlHistory : [];
          return writeJsonLocalDb({
            ...snapshot,
            urlHistory: dockerUrlHistory.length ? dockerUrlHistory : preservedUrlHistory
          });
        }).catch(() => {});
      }
      return snapshot;
    }
  } catch {
    // Fall back to JSON storage when Docker Desktop or the DB container is not running.
  }
  return readJsonLocalDb();
}

async function writeLocalDb(nextDb) {
  return writeJsonLocalDb(nextDb);
}

async function resetLocalDb() {
  try {
    const result = await dbApiRequest("/db/reset", {
      method: "POST",
      body: {}
    });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back below.
  }
  return resetJsonLocalDb();
}

async function upsertUser(input) {
  try {
    const result = await dbApiRequest("/users/save", {
      method: "POST",
      body: { user: input }
    });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back below.
  }
  return upsertJsonUser(input);
}

async function setUserServiceVisibility(userId, serviceId, visible) {
  try {
    const result = await dbApiRequest("/users/service", {
      method: "POST",
      body: { userId, serviceId, visible: visible !== false }
    });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back below.
  }
  return setJsonUserServiceVisibility(userId, serviceId, visible);
}

async function setUserUiRules(userId, serviceId, hideSelectors, enabled, replaceRules = [], hideRules = [], userScript = "", customCss = "") {
  try {
    const result = await dbApiRequest("/users/ui-rules", {
      method: "POST",
      body: { userId, serviceId, hideSelectors, hideRules, replaceRules, userScript, customCss, enabled: enabled === true }
    });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back below.
  }
  return setJsonUserUiRules(userId, serviceId, hideSelectors, enabled, replaceRules, hideRules, userScript, customCss);
}

// Replace-all-for-userId (Docker authoritative, JSON mirror fallback). userId defaults to the global
// sentinel so the blocklist applies to every App User.
async function setUserBlockedLinks(input = {}) {
  const userId = input?.userId || SERVICE_UI_RULE_USER_ID;
  const links = Array.isArray(input?.links) ? input.links : [];
  try {
    const result = await dbApiRequest("/users/blocked-links", { method: "POST", body: { userId, links } });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back to the JSON mirror below.
  }
  return setJsonUserBlockedLinks(userId, links);
}
function setJsonUserBlockedLinks(userId, links) {
  return withJsonDbLock(() => setJsonUserBlockedLinksLocked(userId, links));
}
async function setJsonUserBlockedLinksLocked(userId, links) {
  const db = await readJsonLocalDb();
  const cleanUserId = sanitizeId(userId, SERVICE_UI_RULE_USER_ID);
  const stamp = nowIso();
  db.blockedLinks = (Array.isArray(db.blockedLinks) ? db.blockedLinks : []).filter((row) => row.userId !== cleanUserId);
  for (const raw of (Array.isArray(links) ? links : []).slice(0, 200)) {
    const clean = sanitizeBlockedLink({ ...raw, userId: cleanUserId, updatedAt: stamp });
    if (clean) db.blockedLinks.push(clean);
  }
  return writeJsonLocalDb(db);
}

async function recordUiRuleReports(input = {}) {
  try {
    const result = await dbApiRequest("/users/ui-rules/report", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back below.
  }
  return recordJsonUiRuleReports(input);
}

async function setUserModelPolicy(input = {}) {
  try {
    const result = await dbApiRequest("/users/model-policy", {
      method: "POST",
      body: input || {}
    });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back below.
  }
  return setJsonUserModelPolicy(input);
}

async function checkUserModelUsage(input = {}) {
  try {
    const result = await dbApiRequest("/users/model-usage/check", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result) return result;
  } catch {
    // Fall back below.
  }
  return checkJsonUserModelUsage(input);
}

// RESERVE LEDGER: nhả reservation đã GIỮ ở pre-check (client hủy trước khi gửi). Proxy dbapi; JSON-mode = no-op.
async function releaseModelUsage(input = {}) {
  if (!shouldUseDbApi()) return { ok: true, released: false, reason: "json-mode" };
  try {
    const result = await dbApiRequest("/users/model-usage/release", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
    if (result) return result;
  } catch { /* best-effort — nhả hold không được cũng chỉ để TTL chốt (fail-closed) */ }
  return { ok: true, released: false };
}

async function observeModel(input = {}) {
  try {
    const result = await dbApiRequest("/models/observe", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    // Docker returns a light ack now (no full ~12MB db) — observe is fire-and-forget. ok=true means the
    // authoritative write landed, so do NOT fall through to the JSON store (that would double-write/diverge).
    if (result?.ok) return { ok: true };
  } catch {
    // Fall back below.
  }
  return observeJsonModel(input);
}

// Plan-tier gating (Free/Pro/Max) admin proxies — Docker-first (no JSON fallback; plans live only in the DB API).
async function plansList(input = {}) {
  return dbApiRequest("/plans/list", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function assignUserPlan(input = {}) {
  return dbApiRequest("/plans/assign", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function updateUserSubscription(input = {}) {
  // Khách cũ (per-customer): update ONLY expiry + monthly_credit of the user's active sub (keeps services, no re-grant).
  return dbApiRequest("/plans/update-subscription", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function convertUserToLegacy(input = {}) {
  // "Chuyển sang Người dùng CentriX": move a user to PRO_LEGACY, snapshotting their current plan's blocked services.
  return dbApiRequest("/plans/convert-legacy", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function setPlanAccess(input = {}) {
  return dbApiRequest("/plans/access", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function myPlan(input = {}) {
  return dbApiRequest("/plans/me", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
// Sổ giao dịch: query trực tiếp có lọc + phân trang (không cap như snapshot) → dịch vụ ít dùng (Claude...) hiện lại.
async function queryCreditTransactions(input = {}) {
  return dbApiRequest("/admin/credits/query", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function savePlan(input = {}) {
  return dbApiRequest("/plans/save", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function deletePlan(input = {}) {
  return dbApiRequest("/plans/delete", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function selfDowngradePlan(input = {}) {
  return dbApiRequest("/plans/self-downgrade", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function setPlanGate(input = {}) {
  return dbApiRequest("/plans/gate", { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500), body: input || {} });
}
async function setModelPrices(input = {}) {
  try {
    const result = await dbApiRequest("/admin/model-prices", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back below.
  }
  return setJsonModelPrices(input);
}

async function adjustUserCredit(input = {}) {
  try {
    const result = await dbApiRequest("/admin/credits/adjust", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result?.db) return apiDbSnapshot(result.db);
  } catch {
    // Fall back below.
  }
  return adjustJsonUserCredit(input);
}

// ── VÍ TIỀN VND ─────────────────────────────────────────────────────────────────────────────────────
// TIỀN THẬT: KHÔNG fallback JSON. dbapi (SQLite) là nguồn DUY NHẤT — nếu dbapi lỗi thì THROW để caller báo lỗi,
// KHÔNG được ghi vào JSON cache (sẽ split-brain số dư tiền). buy-credit trừ VND + cộng credit nguyên tử trong dbapi.
async function moneyDbRequest(pathname, input) {
  const result = await dbApiRequest(pathname, { method: "POST", timeoutMs: Math.max(DB_API_TIMEOUT_MS, 3000), body: input || {} });
  if (result && result.db) return apiDbSnapshot(result.db);
  throw new Error((result && result.error) || "money-op-failed");
}
async function topupMoney(input = {}) { return moneyDbRequest("/users/money/topup", input); }
async function adjustMoney(input = {}) { return moneyDbRequest("/users/money/adjust", input); }
async function buyCreditWithMoney(input = {}) { return moneyDbRequest("/users/money/buy-credit", input); }
async function buyPlanWithMoney(input = {}) { return moneyDbRequest("/users/money/buy-plan", input); }

async function getUserCreditSummary(userId) {
  // Fast, user-SCOPED, always-fresh wallet read for /api/me. Avoids readLocalDb() (full ~12MB Docker /db
  // read) which under load timed out and fell back to the stale JSON cache, so the App User balance
  // flickered back up to the pre-charge value. Hits Docker's lightweight /users/credit-summary; on any
  // failure falls back to the JSON read-cache (only when Docker is genuinely down).
  const cleanUserId = sanitizeId(userId, "local-user");
  try {
    const result = await dbApiRequest(`/users/credit-summary?userId=${encodeURIComponent(cleanUserId)}`, {
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500)
    });
    if (result?.wallet) {
      return {
        wallet: result.wallet,
        transactions: Array.isArray(result.transactions) ? result.transactions : [],
        activity: Array.isArray(result.activity) ? result.activity : [],
        source: "docker"
      };
    }
  } catch {
    // Fall back to JSON read-cache below.
  }
  const db = await readJsonLocalDb();
  const wallet = walletForUser(db, cleanUserId);
  const transactions = (db.creditTransactions || []).filter((tx) => tx.userId === cleanUserId).slice(-80);
  const activity = (db.activity || []).filter((a) => a.userId === cleanUserId).slice(-60);
  return { wallet, transactions, activity, source: "json" };
}

async function getAdminSummary() {
  try {
    const result = await dbApiRequest("/admin/summary", {
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500)
    });
    if (result?.summary) {
      return {
        summary: result.summary,
        db: result.db ? apiDbSnapshot(result.db) : null
      };
    }
  } catch {
    // Fall back below.
  }
  const result = await getJsonAdminSummary();
  return {
    summary: result.summary,
    db: { ...result.db, source: "json", filePath: result.db.filePath }
  };
}

async function getPortalSnapshot(lean = false) {
  try {
    const result = await dbApiRequest(lean ? "/portal?lean=1" : "/portal", {
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500)
    });
    if (result?.portal) {
      return {
        portal: sanitizePortalData(result.portal),
        db: result.db ? apiDbSnapshot(result.db) : null
      };
    }
  } catch {
    // Fall back below.
  }
  const result = await getJsonPortalSnapshot();
  return {
    portal: result.portal,
    db: { ...result.db, source: "json", filePath: result.db.filePath }
  };
}

// LEAN live-chat read: only the livechat threads, NOT the 12MB full snapshot. Backs the fast "Chat trực
// tiếp" poll. Docker-first; on outage, derive the threads from the JSON portal cache.
async function getLivechatThreads(userId) {
  try {
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : "";
    const result = await dbApiRequest(`/portal/livechat${qs}`, { timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500) });
    if (result && Array.isArray(result.threads)) return { ok: true, threads: result.threads };
  } catch {
    // Fall back to the JSON portal cache below.
  }
  try {
    const snap = await getJsonPortalSnapshot();
    const tickets = (snap && snap.portal && Array.isArray(snap.portal.supportTickets)) ? snap.portal.supportTickets : [];
    return { ok: true, threads: tickets.filter((t) => t && t.channel === "livechat" && (!userId || t.userId === userId)) };
  } catch {
    return { ok: false, threads: [] };
  }
}

async function setPortalSection(input = {}) {
  try {
    const result = await dbApiRequest("/portal/section", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result?.portal) {
      return {
        portal: sanitizePortalData(result.portal),
        db: result.db ? apiDbSnapshot(result.db) : null
      };
    }
  } catch {
    // Fall back below.
  }
  return setJsonPortalSection(input);
}

async function createPortalTopupRequest(input = {}) {
  try {
    const result = await dbApiRequest("/portal/topup-request", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result?.order) {
      return {
        ...result,
        portal: sanitizePortalData(result.portal),
        db: result.db ? apiDbSnapshot(result.db) : null
      };
    }
  } catch {
    // Fall back below.
  }
  return createJsonPortalTopupRequest(input);
}

async function createPortalSupportTicket(input = {}) {
  try {
    const result = await dbApiRequest("/portal/support", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result?.ticket) {
      return {
        ...result,
        portal: sanitizePortalData(result.portal),
        db: result.db ? apiDbSnapshot(result.db) : null
      };
    }
  } catch {
    // Fall back below.
  }
  return createJsonPortalSupportTicket(input);
}

async function appendLivechatMessage(input = {}) {
  // Live chat (App User "Nhân viên CSKH" <-> App Server "Chat trực tiếp") needs the shared Docker store
  // for cross-app sync — NO json fallback (a JSON-only chat would not reach the other app).
  const result = await dbApiRequest("/portal/livechat", {
    method: "POST",
    // Generous timeout: the single-threaded Docker store serializes reads/writes, so a livechat write can
    // queue behind a portal read. 5s headroom keeps a brief congestion spike from aborting a real send.
    timeoutMs: Math.max(DB_API_TIMEOUT_MS, 5000),
    body: input || {}
  });
  return {
    ...result,
    portal: result.portal ? sanitizePortalData(result.portal) : null,
    db: result.db ? apiDbSnapshot(result.db) : null
  };
}

async function approvePortalTopup(input = {}) {
  try {
    const result = await dbApiRequest("/portal/topup-approve", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500),
      body: input || {}
    });
    if (result?.order) {
      return {
        ...result,
        portal: sanitizePortalData(result.portal),
        db: result.db ? apiDbSnapshot(result.db) : null
      };
    }
  } catch {
    // Fall back below.
  }
  return approveJsonPortalTopup(input);
}

async function processSepayWebhook(input = {}) {
  // The SePay webhook MUST reach the AUTHORITATIVE Docker store (it credits a wallet). No JSON fallback:
  // if Docker is unreachable we throw, so the App Server returns a non-2xx and SePay retries delivery
  // later (rather than silently dropping a real payment).
  const result = await dbApiRequest("/portal/sepay-webhook", {
    method: "POST",
    timeoutMs: Math.max(DB_API_TIMEOUT_MS, 4000),
    body: input || {}
  });
  return result;
}

async function getUserPortal(input = {}) {
  try {
    const params = new URLSearchParams({
      userId: sanitizeId(input?.userId, "local-user")
    });
    const result = await dbApiRequest(`/users/portal?${params.toString()}`, {
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 2500)
    });
    if (result?.portal) return result.portal;
  } catch {
    // Fall back below.
  }
  const result = await getJsonUserPortal(input);
  return result.portal;
}

async function recordUserActivity(input) {
  try {
    const result = await dbApiRequest("/users/activity", {
      method: "POST",
      body: input || {}
    });
    // Docker returns only the recent activity slice now (no full db). Don't fall through to JSON on success.
    if (result?.ok) {
      return { activity: Array.isArray(result.activity) ? result.activity.map(sanitizeActivity) : [] };
    }
  } catch {
    // Fall back below.
  }
  return recordJsonUserActivity(input);
}

async function getUserActivity(input = {}) {
  try {
    const params = new URLSearchParams({
      userId: sanitizeId(input?.userId, "local-user"),
      profileId: sanitizeId(input?.profileId || "default", "default"),
      serviceId: sanitizeId(input?.serviceId || "", ""),
      limit: String(Math.max(1, Math.min(500, Math.round(Number(input?.limit || 250)))))
    });
    const result = await dbApiRequest(`/users/activity?${params.toString()}`);
    if (Array.isArray(result?.activity)) {
      return {
        activity: result.activity.map(sanitizeActivity),
        db: result.db ? apiDbSnapshot(result.db) : null
      };
    }
  } catch {
    // Fall back below.
  }
  return getJsonUserActivity(input);
}

async function saveUserLocalStore(input) {
  try {
    const result = await dbApiRequest("/users/local-store", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 4000),
      body: input || {}
    });
    // Docker returns only {saved, localStoreCount} now (no full db). Don't fall through to JSON on success.
    if (result?.ok) {
      return { saved: result.saved || 0, localStoreCount: result.localStoreCount || 0 };
    }
  } catch {
    // Fall back below.
  }
  return saveJsonUserLocalStore(input);
}

async function getUserLocalStore(input) {
  try {
    const params = new URLSearchParams({
      userId: sanitizeId(input?.userId, "local-user"),
      profileId: sanitizeId(input?.profileId || "default", "default"),
      serviceId: sanitizeId(input?.serviceId, "service"),
      origin: sanitizeOrigin(input?.origin)
    });
    const result = await dbApiRequest(`/users/local-store?${params.toString()}`);
    if (result?.store) return result.store;
  } catch {
    // Fall back below.
  }
  return getJsonUserLocalStore(input);
}

async function saveUserUiCache(input) {
  try {
    const result = await dbApiRequest("/users/ui-cache", {
      method: "POST",
      timeoutMs: Math.max(DB_API_TIMEOUT_MS, 4000),
      body: input || {}
    });
    // Docker returns only {saved, items} now (no full db). Don't fall through to JSON on success.
    if (result?.ok) {
      return {
        saved: result.saved || 0,
        uiCacheItems: result.items || result.uiCacheItems || []
      };
    }
  } catch {
    // Fall back below.
  }
  return saveJsonUserUiCache(input);
}

async function getUserUiCache(input) {
  try {
    const params = new URLSearchParams({
      userId: sanitizeId(input?.userId, "local-user"),
      profileId: sanitizeId(input?.profileId || "default", "default"),
      serviceId: sanitizeId(input?.serviceId, "service")
    });
    const result = await dbApiRequest(`/users/ui-cache?${params.toString()}`);
    if (result?.cache) return result.cache;
  } catch {
    // Fall back below.
  }
  return getJsonUserUiCache(input);
}

async function loginAccount(input = {}) {
  // Password login GỠ — thay bằng Google login. Bịt luôn nhánh JSON-fallback (verifyPassword) vốn BỎ QUA
  // gate Docker + device-key (lỗ mint session không bind). Đặt env CENTRIX_DISABLE_PWD_LOGIN=0 để mở lại.
  if (process.env.CENTRIX_DISABLE_PWD_LOGIN !== "0") {
    throw new Error("Password login disabled — use Google login");
  }
  try {
    const result = await dbApiRequest("/auth/login", {
      method: "POST",
      body: {
        email: input.email,
        password: input.password,
        deviceId: input.deviceId,
        deviceJkt: input.deviceJkt
      }
    });
    if (result?.account) {
      // Mirror the Docker-issued session into the JSON store too. Both loginAccount and
      // verifyAccountToken are Docker-first with a JSON fallback; if a later token verification
      // momentarily can't reach Docker (the centrix-local-db container hiccups) it falls back to
      // JSON — which, without this mirror, would NOT contain the Docker-issued token and would
      // 401. That force-logged the user out ~1s after a successful login ("0 cr" + free chat).
      await mirrorAuthSessionToJson(result.account).catch(() => {});
      return result.account;
    }
  } catch {
    // Fall back below.
  }
  return loginJsonAccount(input);
}

// Google Sign-In: the App Server has already verified the Google ID token, so this just asks Docker to
// issue a session for the matched (pre-existing) email. No JSON fallback — if Docker is down, Google
// login fails (email/password login still works with its own fallback).
async function loginAccountGoogle(input = {}) {
  const email = sanitizeEmail(input.email);
  const deviceId = String(input.deviceId || "");
  if (!email) throw new Error("Thieu email");
  const result = await dbApiRequest("/auth/google-login", {
    method: "POST",
    body: { email, deviceId, deviceJkt: String(input.deviceJkt || ""), name: String(input.name || "") }
  });
  if (result?.account) {
    await mirrorAuthSessionToJson(result.account).catch(() => {});
    return result.account;
  }
  throw new Error("Khong tao duoc phien dang nhap Google");
}

// ----- Org self-service wrappers (Docker-first; org-admin actions are rare, no JSON fallback) -----
async function orgStructure(input = {}) {
  return dbApiRequest("/org/structure", { method: "POST", body: input });
}
async function orgAddDepartment(input = {}) {
  return dbApiRequest("/org/department", { method: "POST", body: input });
}
async function orgAddMember(input = {}) {
  return dbApiRequest("/org/member", { method: "POST", body: input });
}
async function orgAllocateCredit(input = {}) {
  return dbApiRequest("/org/allocate", { method: "POST", body: input });
}
async function orgUpdateBilling(input = {}) {
  return dbApiRequest("/org/billing", { method: "POST", body: input });
}
async function orgReport(input = {}) {
  return dbApiRequest("/org/report", { method: "POST", body: input });
}
async function orgSetEntitlement(input = {}) {
  return dbApiRequest("/org/set-entitlement", { method: "POST", body: input });
}
async function orgRemoveMember(input = {}) {
  return dbApiRequest("/org/remove-member", { method: "POST", body: input });
}
async function orgDeleteDepartment(input = {}) {
  return dbApiRequest("/org/department-delete", { method: "POST", body: input });
}
async function orgSetMemberRole(input = {}) {
  return dbApiRequest("/org/set-role", { method: "POST", body: input });
}
async function orgSetMemberLocked(input = {}) {
  return dbApiRequest("/org/set-locked", { method: "POST", body: input });
}
async function setAccountLocked(input = {}) {
  return dbApiRequest("/accounts/set-locked", { method: "POST", body: input });
}
async function accountLockStatus(input = {}) {
  return dbApiRequest("/accounts/lock-status", { method: "POST", body: input });
}
async function updateUserBilling(input = {}) {
  return dbApiRequest("/users/billing", { method: "POST", body: input });
}

async function deleteUserAccount(input = {}) {
  // HARD delete an end-user account + ALL data. Docker (SQLite + portal blob) is authoritative and enforces
  // the org-owner guard. On success we ALSO purge the Node JSON mirror — it's a fallback store AND the SOLE
  // store for urlHistory (Docker has no route), so leaving it would resurrect the user's data on a Docker
  // outage or a same-email re-login. If Docker doesn't implement the route (404) dbApiRequest throws → this
  // rejects and the mirror is left intact (no half-delete).
  const result = await dbApiRequest("/users/delete-account", { method: "POST", body: input });
  if (result && result.refused) {
    // Business-rule refusal (e.g. org owner) — do NOT purge the mirror; surface the code to the caller.
    return { ok: false, code: result.code || "REFUSED", error: result.error || "Khong the xoa tai khoan" };
  }
  const userId = result.userId || input.userId || "";
  const email = result.email || input.email || "";
  try {
    await withJsonDbLock(() => purgeJsonUserLocked({ userId, email }));
  } catch { /* mirror purge best-effort — Docker already deleted the authoritative copy */ }
  return { ok: true, deleted: true, userId, email };
}

async function purgeJsonUserLocked(input = {}) {
  const db = await readJsonLocalDb();
  const userId = sanitizeId(input?.userId, "");
  const email = String(input?.email || "").trim().toLowerCase();
  const mineUser = (row) => !!row && !!userId && row.userId === userId;
  const mineUserOrEmail = (row) => !!row && ((!!userId && row.userId === userId) || (!!email && String(row.email || "").trim().toLowerCase() === email));
  db.users = (db.users || []).filter((u) => !(userId && u.id === userId));
  db.accounts = (db.accounts || []).filter((a) => !mineUserOrEmail(a));
  db.authSessions = (db.authSessions || []).filter((s) => !mineUserOrEmail(s));
  for (const key of ["serviceVisibility", "uiRules", "uiRuleReports", "localStore", "uiCacheItems", "activity", "modelPolicies", "modelUsage", "creditWallets", "creditTransactions", "urlHistory"]) {
    if (Array.isArray(db[key]) && userId) db[key] = db[key].filter((row) => !mineUser(row));
  }
  const portal = db.portal || {};
  for (const section of ["members", "topupOrders", "invoices", "supportTickets", "notifications", "appSettings", "userBilling", "manualInterventions"]) {
    if (Array.isArray(portal[section])) portal[section] = portal[section].filter((row) => !mineUserOrEmail(row));
  }
  db.portal = portal;
  await writeJsonLocalDb(db);
  return { ok: true };
}

// ---- Admin console accounts + roles (App Server RBAC) ------------------------------------------
// Thin Docker-first proxies over admin_accounts / admin_roles. Admin accounts live ONLY in Docker
// (no JSON mirror): on a Docker outage admin login fails cleanly and the operator recovers via the
// master token. PBKDF2 verify happens HERE (Node); Docker only stores the hash string.
async function adminAccountGet(username) {
  const u = String(username || "").trim().toLowerCase();
  return dbApiRequest(`/admin-accounts?username=${encodeURIComponent(u)}`);
}
async function adminAccountList() {
  try {
    return await dbApiRequest("/admin-accounts/list");
  } catch {
    const ownerEmail = String(process.env.CENTRIX_STAFF_OWNER_EMAIL || "owner@centrix.asia").trim().toLowerCase();
    return { accounts: [{ username: ownerEmail, displayName: "Owner", role: "admin", isOwner: 1, permOverrides: "{}", enabled: 1 }] };
  }
}
async function adminAccountUpsert(input = {}) {
  return dbApiRequest("/admin-accounts/upsert", { method: "POST", body: input });
}
async function adminAccountDelete(input = {}) {
  return dbApiRequest("/admin-accounts/delete", { method: "POST", body: input });
}
async function adminAccountTouchLogin(input = {}) {
  return dbApiRequest("/admin-accounts/touch-login", { method: "POST", body: input });
}
async function adminRoleList() {
  try {
    return await dbApiRequest("/admin-roles/list");
  } catch {
    return { roles: [{ id: "admin", name: "Administrator", permissions: "[\"*\"]" }] };
  }
}
async function adminRoleUpsert(input = {}) {
  return dbApiRequest("/admin-roles/upsert", { method: "POST", body: input });
}
async function adminRoleDelete(input = {}) {
  return dbApiRequest("/admin-roles/delete", { method: "POST", body: input });
}

// Effective permission list for an admin account: owner ⇒ ["*"]; otherwise the role's perms with the
// per-account perm_overrides applied ({ "<viewKey>": true adds, false removes }).
async function adminResolvePermissions(account = {}) {
  if (account && account.isOwner) return ["*"];
  // adminRoleList() is allowed to THROW on a transient dbapi error — do NOT swallow it into an empty perm
  // list here. A silent [] would bake a "no permissions" session at login (staff sees "chưa role") and would
  // poison the live-perm cache. Callers (adminLogin, auth.liveStaffPerms) catch and keep last-known / retry.
  const rl = await adminRoleList();
  let perms = [];
  try {
    const row = ((rl && rl.roles) || []).find((r) => String(r.id || "").toLowerCase() === String(account.role || "").toLowerCase());
    if (row && row.permissions) {
      perms = Array.isArray(row.permissions) ? row.permissions : JSON.parse(row.permissions);
    }
  } catch { perms = []; }
  const set = new Set(perms);
  let ov = {};
  try { ov = typeof account.permOverrides === "string" ? JSON.parse(account.permOverrides || "{}") : (account.permOverrides || {}); } catch { ov = {}; }
  for (const [key, val] of Object.entries(ov)) {
    if (val === true) set.add(key);
    else if (val === false) set.delete(key);
  }
  return Array.from(set);
}

// Validate an admin login (username + password). Docker-first, NO JSON fallback (admin accounts are
// Docker-only). Returns the validated account + resolved permissions, or throws a generic error.
async function adminLogin(input = {}) {
  const username = String(input.username || "").trim().toLowerCase();
  const password = String(input.password || "");
  if (!username || !password) throw new Error("Thiếu tài khoản hoặc mật khẩu");
  const ownerEmail = String(process.env.CENTRIX_STAFF_OWNER_EMAIL || "owner@centrix.asia").trim().toLowerCase();
  const ownerPw = String(process.env.CENTRIX_STAFF_OWNER_PW || "");
  if (ownerPw && username === ownerEmail && password === ownerPw) {
    return {
      username: ownerEmail,
      displayName: "Owner",
      role: "admin",
      isOwner: true,
      permissions: ["*"],
      enabled: true
    };
  }
  let res;
  try {
    res = await adminAccountGet(username);
  } catch (err) {
    if (ownerPw && username === ownerEmail && password === ownerPw) {
      return {
        username: ownerEmail,
        displayName: "Owner",
        role: "admin",
        isOwner: true,
        permissions: ["*"],
        enabled: true
      };
    }
    throw err;
  }
  const account = res && res.account;
  if (!account || account.enabled === false) throw new Error("Sai tài khoản hoặc mật khẩu");
  const verdict = verifyPassword(account.passwordHash || "", password);
  if (!verdict.ok) throw new Error("Sai tài khoản hoặc mật khẩu");
  const permissions = await adminResolvePermissions(account);
  adminAccountTouchLogin({ username }).catch(() => {});
  if (verdict.needsRehash) {
    adminAccountUpsert({ username, passwordHash: hashPassword(password) }).catch(() => {});
  }
  return {
    username: account.username,
    displayName: account.displayName || "",
    role: account.role || "",
    isOwner: !!account.isOwner,
    permissions,
    enabled: account.enabled !== false
  };
}

// Create/update an admin account. Accepts a PLAINTEXT `password` (hashed here with PBKDF2 before it
// reaches Docker, which only stores the hash). Partial: only provided fields are written.
async function adminAccountSave(input = {}) {
  const body = { username: String(input.username || input.email || "").trim().toLowerCase() };
  if (input.password) body.passwordHash = hashPassword(String(input.password));
  if ("displayName" in input) body.displayName = input.displayName;
  if ("role" in input) body.role = input.role;
  if ("isOwner" in input) body.isOwner = input.isOwner ? 1 : 0;
  if ("permOverrides" in input) body.permOverrides = input.permOverrides;
  if ("enabled" in input) body.enabled = input.enabled ? 1 : 0;
  return adminAccountUpsert(body);
}

// Đổi mật khẩu của CHÍNH staff (self-service). Caller (server.js) truyền `username` LẤY TỪ PHIÊN, KHÔNG
// từ client → chỉ đổi được của chính mình. Verify mật khẩu cũ (PBKDF2) rồi ghi hash mới (KHÔNG đụng role/quyền).
async function changeAdminPassword(input = {}) {
  const username = String(input.username || "").trim().toLowerCase();
  const currentPassword = String(input.currentPassword || "");
  const newPassword = String(input.newPassword || "");
  if (!username) throw new Error("Thiếu tài khoản");
  if (newPassword.length < 8) throw new Error("Mật khẩu mới tối thiểu 8 ký tự");
  if (newPassword === currentPassword) throw new Error("Mật khẩu mới phải khác mật khẩu hiện tại");
  const res = await adminAccountGet(username);
  const account = res && res.account;
  if (!account || account.enabled === false) throw new Error("Tài khoản không tồn tại hoặc đã bị tắt");
  const verdict = verifyPassword(account.passwordHash || "", currentPassword);
  if (!verdict.ok) throw new Error("Mật khẩu hiện tại không đúng");
  await adminAccountUpsert({ username, passwordHash: hashPassword(newPassword) });
  return { ok: true, username };
}

// Self-service change password: verify the CURRENT password then write a fresh PBKDF2 hash. Docker-first
// (authoritative); a 4xx (e.g. wrong current password) is final and must NOT fall through to JSON, or a
// wrong password could "succeed" against a stale mirror. Only a real Docker outage falls back to JSON.
async function changeAccountPassword(input = {}) {
  const email = sanitizeEmail(input.email);
  const currentPassword = String(input.currentPassword || "");
  const newPassword = String(input.newPassword || "");
  if (!email) throw new Error("Thieu email");
  if (newPassword.length < 6) throw new Error("Mat khau moi phai tu 6 ky tu tro len");
  if (newPassword === currentPassword) throw new Error("Mat khau moi phai khac mat khau hien tai");
  try {
    const result = await dbApiRequest("/auth/change-password", {
      method: "POST",
      body: { email, currentPassword, newPassword }
    });
    if (result?.ok) return { ok: true, email };
  } catch (error) {
    const status = Number(error?.httpStatus || 0);
    if (status >= 400 && status < 500) throw error; // definitive rejection — do not re-check against JSON
    // else: real Docker outage (timeout / 5xx / route missing) → JSON fallback below
  }
  return changeJsonAccountPassword({ email, currentPassword, newPassword });
}

function changeJsonAccountPassword(input = {}) {
  return withJsonDbLock(() => changeJsonAccountPasswordLocked(input));
}
async function changeJsonAccountPasswordLocked(input = {}) {
  const db = await readJsonLocalDb();
  const email = sanitizeEmail(input.email);
  const account = db.accounts.find((item) => item.email === email && item.enabled !== false);
  if (!account) throw new Error("Tai khoan khong ton tai hoac da bi tat");
  const verdict = verifyPassword(account.passwordHash, input.currentPassword || "");
  if (!verdict.ok) throw new Error("Mat khau hien tai khong dung");
  account.passwordHash = hashPassword(input.newPassword || "");
  account.updatedAt = nowIso();
  await writeJsonLocalDb(db);
  return { ok: true, email };
}

// Write a Docker-issued session row into the JSON store so the JSON verify fallback can find the
// same token. Idempotent: skips if the token already exists.
function mirrorAuthSessionToJson(account = {}) {
  return withJsonDbLock(async () => {
    const token = String(account?.token || "").trim();
    if (!token) return;
    const db = await readJsonLocalDb();
    // Stored tokens are hashed at rest; dedupe against the hash of the incoming raw token.
    if ((db.authSessions || []).some((s) => s.token === hashSessionToken(token))) return;
    const stamp = nowIso();
    db.authSessions = [
      ...(db.authSessions || []),
      sanitizeAuthSession({
        token,
        userId: account.userId,
        profileId: account.profileId || "default",
        deviceId: account.deviceId || "device",
        email: account.email,
        sessionKey: account.sessionKey || "",
        issuedAt: stamp,
        expiresAt: account.expiresAt || new Date(Date.now() + AUTH_SESSION_TTL_MS).toISOString(),
        lastSeenAt: stamp
      })
    ].slice(-MAX_ACTIVITY);
    await writeJsonLocalDb(db);
  });
}

// Opt-in proof-of-possession: when on, a valid bearer token must ALSO present its matching per-session
// key (X-CentriX-Session header) or it is rejected — so a token copied WITHOUT the session key cannot
// be replayed. Off by default so it can be rolled out only once every client sends the header.
const BIND_SESSION_KEY = process.env.CENTRIX_BIND_SESSION_KEY === "1";

async function verifyAccountToken(token, presentedSessionKey) {
  let account = null;
  try {
    const result = await dbApiRequest("/auth/token", {
      method: "POST",
      body: { token: String(token || "") }
    });
    // Docker is authoritative and was reached: trust its verdict (account, or null when invalid). Do
    // NOT fall through to the JSON mirror here — that stale fallback is exactly what let a revoked or
    // expired token (Docker answers 401) keep authenticating.
    account = result?.account || null;
  } catch (error) {
    const status = Number(error && error.httpStatus);
    // 401/403 = Docker DEFINITIVELY rejected the token (invalid / revoked / expired): reject, never
    // fall back. Only a genuine Docker outage (timeout / connection / 5xx / missing route) falls back
    // to the JSON mirror so the app keeps working while Docker is unreachable.
    if (status === 401 || status === 403) return null;
    account = await verifyJsonAccountToken(token);
  }
  if (!account) return null;
  // Proof-of-possession check. Grandfather legacy sessions that have no stored session key.
  if (BIND_SESSION_KEY && account.sessionKey) {
    if (!constantTimeEqual(String(presentedSessionKey || ""), account.sessionKey)) return null;
  }
  return account;
}

async function revokeSession(input = {}) {
  try {
    const result = await dbApiRequest("/auth/revoke", {
      method: "POST",
      body: { token: input.token, userId: input.userId, deviceId: input.deviceId }
    });
    if (result && typeof result.revoked === "number") {
      // ALSO invalidate the JSON mirror so that if a later verify briefly falls back to JSON (Docker
      // down), it cannot keep honoring a token that was just revoked. Best-effort; Docker stays the
      // authoritative source for the returned count.
      await revokeJsonSession(input).catch(() => {});
      return { revoked: result.revoked };
    }
  } catch {
    // Docker unreachable — fall back to revoking the JSON mirror only.
  }
  return revokeJsonSession(input);
}

module.exports = {
  adjustUserCredit,
  topupMoney,
  adjustMoney,
  buyCreditWithMoney,
  buyPlanWithMoney,
  approvePortalTopup,
  checkUserModelUsage,
  releaseModelUsage,
  getUserCreditSummary,
  createPortalSupportTicket,
  appendLivechatMessage,
  createPortalTopupRequest,
  processSepayWebhook,
  getAdminSummary,
  getPortalSnapshot,
  getLivechatThreads,
  getUserActivity,
  getUserLocalStore,
  getUserPortal,
  getUserUiCache,
  getUrlHistory,
  saveUrlHistory,
  loginAccount,
  loginAccountGoogle,
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
  deleteUserAccount,
  adminAccountGet,
  adminAccountList,
  adminAccountUpsert,
  adminAccountSave,
  changeAdminPassword,
  adminAccountDelete,
  adminAccountTouchLogin,
  adminRoleList,
  adminRoleUpsert,
  adminRoleDelete,
  adminResolvePermissions,
  adminLogin,
  localDbPath,
  observeModel,
  readLocalDb,
  recordUiRuleReports,
  recordUserActivity,
  resetLocalDb,
  revokeSession,
  sanitizeId,
  saveUserLocalStore,
  saveUserUiCache,
  servicesForUser,
  setModelPrices,
  setPortalSection,
  plansList,
  assignUserPlan,
  updateUserSubscription,
  convertUserToLegacy,
  setPlanAccess,
  myPlan,
  queryCreditTransactions,
  savePlan,
  deletePlan,
  selfDowngradePlan,
  setPlanGate,
  setUserModelPolicy,
  setUserServiceVisibility,
  setUserUiRules,
  setUserBlockedLinks,
  blockedLinksForService,
  uiRulesForServiceUser,
  upsertUser,
  verifyAccountToken,
  writeLocalDb
};
