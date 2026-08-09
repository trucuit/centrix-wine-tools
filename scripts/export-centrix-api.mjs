#!/usr/bin/env node
/**
 * export-centrix-api.mjs
 *
 * Pull CentriX pool cookies via API (no App User UI, no asar hook).
 *
 * Flow: Google PKCE login → health/services/lock (export-gate interaction)
 *       → GET /api/profile/export → AES-GCM decrypt → cookies/<service>/
 *
 * Usage:
 *   ./export-centrix-api.sh login
 *   ./export-centrix-api.sh services
 *   ./export-centrix-api.sh export grok
 *   ./export-centrix-api.sh export chatgpt claude
 *   ./export-centrix-api.sh export all
 *   ./export-centrix-api.sh export all --chrome
 *   ./export-centrix-api.sh status
 *   ./export-centrix-api.sh logout
 *
 * Env:
 *   CENTRIX_APP_VERSION    default from asar / 3.18.1 (User-Agent CentriXAppUser/<ver>)
 *   CENTRIX_SERVER_URL     default https://api-centrixapp-quang.centrix.asia
 *   CENTRIX_SESSION_FILE   default ./.centrix-api-session.json
 *   CENTRIX_OUT_DIR        default ./cookies
 *   J2TEAM_OUT_DIR         optional external injector copy dir
 *   IMPORT_TO_CHROME=1     after export, run import-cookies-to-chrome.sh
 *   CENTRIX_APP_KEY / CENTRIX_APP_ATTEST_SECRET / CENTRIX_EXPORT_SIGN_KEY
 *     (defaults match App User 3.18.x shipped values — friction keys, not hard secrets)
 */

import { createServer } from "node:http";
import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, createDecipheriv } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICES_CACHE_FILE = resolve(ROOT, ".centrix-services-cache.json");

/**
 * Persist the /api/services list to disk so shell scripts (export-pick-service,
 * export-centrix-cookies) can show only the services that are actually available
 * in the current account — instead of a hardcoded catalog.
 */
async function cacheServicesList(list) {
  if (!Array.isArray(list) || !list.length) return;
  const entries = list
    .filter((s) => (s.enabled !== false))
    .map((s) => ({
      id: s.id || s.serviceId || "",
      name: s.name || s.serviceName || "",
      url: s.url || "",
      enabled: s.enabled !== false,
    }))
    .filter((e) => e.id);
  if (!entries.length) return;
  const payload = { updatedAt: new Date().toISOString(), services: entries };
  try {
    await writeFile(SERVICES_CACHE_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch { /* best-effort */ }
}

/** Match remote-user-main.js APP_VERSION in App User asar (shell detect_app_version overrides). */
const APP_VERSION = String(process.env.CENTRIX_APP_VERSION || "3.18.1").trim() || "3.18.1";
/** Exact UA App User sends — server uaIsClient / uaIsScript check this string. */
const USER_AGENT = `CentriXAppUser/${APP_VERSION}`;
const DEFAULT_SERVER = "https://api-centrixapp-quang.centrix.asia";
const GOOGLE_CLIENT_ID =
  process.env.CENTRIX_GOOGLE_CLIENT_ID ||
  "424062159436-1r8kbv5474cvbh4hinng7jeqb86fm0r3.apps.googleusercontent.com";
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_SCOPE = "openid email profile";

// Same defaults as App User asar (shared/app-attest.js). Override via env if rotated.
const APP_REQUEST_KEY =
  process.env.CENTRIX_APP_KEY || "cxk_28db7719b795d4eaa5a4e00fcb057029a11130eea00ec39a8bbd1467ca2ae5f7";
const APP_ATTEST_SECRET =
  process.env.CENTRIX_APP_ATTEST_SECRET || "cx-attest-v1-7b14d605a9f1e2c3b4d5e6f78f3a9c2e";
const EXPORT_SIGN_KEY =
  process.env.CENTRIX_EXPORT_SIGN_KEY ||
  "cxs_61fb44704212be1f8aaa1d62178b5d9e7989c0e5b613e2c32499405807039402";

const SESSION_FILE = resolve(process.env.CENTRIX_SESSION_FILE || join(ROOT, ".centrix-api-session.json"));
const OUT_DIR = resolve(process.env.CENTRIX_OUT_DIR || join(ROOT, "cookies"));
const SERVER_URL_OVERRIDE = String(process.env.CENTRIX_SERVER_URL || "").trim().replace(/\/+$/, "");
const SERVER_URL = SERVER_URL_OVERRIDE || DEFAULT_SERVER;

/** exportRiskScore: +20 if export < 3s after loginAt; +15 if interactedAt > 60s old */
const MIN_MS_AFTER_LOGIN = 3500;
const MAX_MS_SINCE_INTERACT = 45000;

/**
 * serviceId → default page URL for J2TEAM export.
 * Base list = App User DEFAULT_SERVICES (shared/service-store.js)
 * + pool-only ids seen on this server (grok-heavy, envato-elements, …).
 * Prefer live URLs from /api/services cache when present.
 */
const SERVICE_URLS = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/",
  perplexity: "https://www.perplexity.ai/",
  "microsoft-copilot": "https://copilot.microsoft.com/",
  grok: "https://grok.com/",
  "grok-heavy": "https://grok.com/",
  deepseek: "https://chat.deepseek.com/",
  mistral: "https://chat.mistral.ai/",
  midjourney: "https://www.midjourney.com/",
  poe: "https://poe.com/",
  // pool GPT Pro slot id=notebooklm but URL is chatgpt.com on this deploy
  notebooklm: "https://chatgpt.com/",
  elevenlabs: "https://elevenlabs.io/app",
  // pool / custom services (not always in DEFAULT_SERVICES)
  "envato-elements": "https://elements.envato.com/",
  gamma: "https://gamma.app/",
  monica: "https://monica.im/",
  semrush: "https://www.semrush.com/",
  scribd: "https://www.scribd.com/",
  freepik: "https://www.freepik.com/",
  canva: "https://www.canva.com/",
};

/**
 * Pool profile aliases used by this tooling (server-side profile names).
 * On this CentriX deploy: ChatGPT pool slot often id=notebooklm (GPT-5.5 Pro),
 * Grok Heavy slot id=grok-heavy. Override with CENTRIX_NO_ALIASES=1 to export raw ids.
 */
const ALIASES =
  process.env.CENTRIX_NO_ALIASES === "1"
    ? {}
    : {
        chatgpt: "notebooklm",
        gpt: "notebooklm",
        "gpt-5": "notebooklm",
        pro: "notebooklm",
        "chatgpt-pro": "notebooklm",
        "gpt-pro": "notebooklm",
        grok: "grok-heavy",
        "grok-4": "grok-heavy",
      };

/** Runtime flags (shell sets env; argv --chrome may flip after load). */
function wantChromeImport() {
  return process.env.IMPORT_TO_CHROME === "1";
}
function j2teamOutDir() {
  return String(process.env.J2TEAM_OUT_DIR || "").trim();
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlBuf(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function log(msg) {
  console.error(`▸ ${msg}`);
}

function die(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

class ApiEndpointUnavailableError extends Error {
  constructor(serverUrl, reason) {
    super(`CentriX API unavailable at ${serverUrl}: ${reason}`);
    this.name = "ApiEndpointUnavailableError";
    this.code = "API_ENDPOINT_UNAVAILABLE";
  }
}

function apiServerUrl(session, requestedUrl = "") {
  return (requestedUrl || SERVER_URL_OVERRIDE || session?.serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

async function writePrivateJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    /* ignore */
  }
}

// ── Device key (Ed25519 DPoP) ──────────────────────────────────────────

function jwkThumbprint(jwk) {
  const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(canon).digest("base64url");
}

function loadOrCreateDevice(session) {
  if (session?.devicePem) {
    const priv = createPrivateKey({ key: session.devicePem, format: "pem", type: "pkcs8" });
    const pubJwk = createPublicKey(priv).export({ format: "jwk" });
    return { priv, pubJwk, jkt: jwkThumbprint(pubJwk), pem: session.devicePem };
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const pubJwk = createPublicKey(privateKey).export({ format: "jwk" });
  return { priv: privateKey, pubJwk, jkt: jwkThumbprint(pubJwk), pem };
}

function makeDeviceProof(device, { method, url, token, nonce }) {
  if (!device?.priv) return "";
  const u = new URL(url);
  const header = { alg: "EdDSA", typ: "centrix-dpop", jwk: device.pubJwk };
  const payload = {
    htm: String(method || "GET").toUpperCase(),
    htu: u.origin + u.pathname,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(16).toString("base64url"),
    ath: createHash("sha256").update(String(token || "")).digest("base64url"),
    ...(nonce ? { nonce } : {}),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = b64urlBuf(sign(null, Buffer.from(signingInput), device.priv));
  return `${signingInput}.${sig}`;
}

function clientAttestHeader(deviceId) {
  const ts = Date.now();
  const mac = createHmac("sha256", APP_ATTEST_SECRET)
    .update(`${String(deviceId || "")}:${ts}`)
    .digest("hex")
    .slice(0, 32);
  return `${ts}.${mac}`;
}

function exportSignHeader(token, profileId) {
  const ts = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", EXPORT_SIGN_KEY)
    .update(`${String(token || "")}:${String(profileId || "")}:${ts}`)
    .digest("base64");
  return `${mac}.${ts}`;
}

function decryptSnapshot(payload, keyB64) {
  if (!payload || payload.enc !== "aesgcm" || !payload.iv || !payload.tag || !payload.data) {
    throw new Error("Not an aesgcm snapshot payload");
  }
  const key = Buffer.from(String(keyB64 || ""), "base64");
  if (key.length !== 32) throw new Error("Invalid session key (expected 32 bytes base64)");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const data = Buffer.from(payload.data, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

// ── Session store ──────────────────────────────────────────────────────

async function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const raw = JSON.parse(await readFile(SESSION_FILE, "utf8"));
    if (!raw?.token || !raw?.serverUrl) return null;
    return raw;
  } catch {
    return null;
  }
}

async function saveSession(obj) {
  await writePrivateJson(SESSION_FILE, {
    serverUrl: String(obj.serverUrl || "").replace(/\/+$/, ""),
    token: String(obj.token || ""),
    sessionKey: String(obj.sessionKey || ""),
    profileId: String(obj.profileId || "default"),
    deviceId: String(obj.deviceId || ""),
    expiresAt: obj.expiresAt || null,
    devicePem: obj.devicePem || "",
    email: obj.email || "",
    /** wall-clock when this session was established (local) — used for loginAt risk delay */
    loggedInAt: obj.loggedInAt || Date.now(),
    savedAt: new Date().toISOString(),
  });
  log(`Session saved → ${SESSION_FILE} (mode 600)`);
}

/** Match App User DEFAULT_DEVICE_ID: `${hostname}-${base36}` */
function newDefaultDeviceId() {
  const host = String(hostname() || "device")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${host || "device"}-${suffix}`.slice(0, 80);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function clearSession() {
  try {
    await unlink(SESSION_FILE);
    log("Session cleared");
  } catch {
    log("No session file");
  }
}

// ── HTTP client (mirror remote-user-main.js serverRequest) ─────────────

let dpopNonce = "";
/** last non-export interaction time (local) — keep export < 60s after this */
let lastInteractAt = 0;

/**
 * Headers identical to App User serverRequest (order + field set).
 * Do NOT send Node/undici default UA — server scores +30 for node|undici|curl|…
 * @see remote-tabs-main.js uaIsScript / uaIsClient
 */
function buildAppUserHeaders(session, device, method, fullUrl, pathname, hasBody) {
  const deviceId = String(session?.deviceId || "device");
  const profileId = String(session?.profileId || "default");
  // Same key set & names as Electron main process fetch headers object
  const headers = {
    Authorization: `Bearer ${session.token}`,
    "X-CentriX-App-Key": APP_REQUEST_KEY,
    "X-CentriX-User": deviceId,
    "X-CentriX-Profile": profileId,
    "X-CentriX-Session": String(session.sessionKey || ""),
    "User-Agent": USER_AGENT,
    "X-CentriX-Attest": clientAttestHeader(deviceId),
    "X-CentriX-Proof": makeDeviceProof(device, {
      method,
      url: fullUrl,
      token: session.token,
      nonce: dpopNonce,
    }),
  };
  if (String(pathname).startsWith("/api/profile/export")) {
    headers["X-CentriX-Sig"] = exportSignHeader(session.token, profileId);
  }
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/** Login-only headers (googleLoginApiRequest) — no Bearer/DPoP */
function buildLoginHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "X-CentriX-App-Key": APP_REQUEST_KEY,
  };
}

async function apiRequest(session, device, pathname, options = {}) {
  const base = apiServerUrl(session, options.serverUrl);
  const method = options.method || "GET";
  // Path may include query; DPoP htu is origin+pathname only (no query) — match makeDeviceProof URL parse
  const url = pathname.startsWith("http") ? pathname : `${base}${pathname}`;
  const pathOnly = pathname.startsWith("http") ? new URL(pathname).pathname + (new URL(pathname).search || "") : pathname;
  const hasBody = Boolean(options.body);

  let headers;
  if (options.auth === false) {
    headers = options.headers || buildLoginHeaders();
  } else {
    if (!session?.token) throw new Error("Server connection is not configured");
    headers = buildAppUserHeaders(session, device, method, url, pathOnly, hasBody);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000);
  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        // Prevent undici from using a different UA fallback
        redirect: "follow",
      });
    } catch (error) {
      const reason = error?.name === "AbortError" ? "request timed out" : "network request failed";
      throw new ApiEndpointUnavailableError(base, reason);
    }
    try {
      const nn = res.headers.get("dpop-nonce") || res.headers.get("DPoP-Nonce");
      if (nn) dpopNonce = nn;
    } catch {
      /* ignore */
    }
    const raw = await res.text();
    let json = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      const contentType = res.headers.get("content-type") || "unknown content type";
      throw new ApiEndpointUnavailableError(base, `expected JSON but received ${contentType} (HTTP ${res.status})`);
    }
    if (!res.ok || json.ok === false) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    // Server sets interactedAt on any authenticated non-export path
    if (!String(pathOnly).startsWith("/api/profile/export") && options.auth !== false) {
      lastInteractAt = Date.now();
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tab state shape from LocalBrowserManager.stateForTab — used by heartbeat/close.
 * App sends this as POST body to /api/user-tabs/heartbeat.
 */
function tabStateLike(session, serviceId, pageUrl = "") {
  const url = pageUrl || SERVICE_URLS[serviceId] || "about:blank";
  const name = serviceId || "";
  const deviceId = String(session.deviceId || "");
  return {
    serviceId: String(serviceId || ""),
    serviceName: name,
    url,
    title: "",
    loading: false,
    loaded: true,
    preparing: false,
    errorPageVisible: false,
    canGoBack: false,
    canGoForward: false,
    viewType: "WebContentsView",
    localUser: true,
    userId: deviceId,
    deviceId,
    lastError: "",
    blank: !url || url === "about:blank",
  };
}

/** Same body as recordClientActivity in App User */
async function recordActivity(session, device, input = {}) {
  return apiRequest(session, device, "/api/users/activity", {
    method: "POST",
    timeoutMs: 8000,
    body: {
      userId: session.deviceId,
      deviceId: session.deviceId,
      profileId: session.profileId || "default",
      serviceId: input.serviceId || "client",
      action: input.action || "event",
      url: input.url || "",
      title: input.title || "",
      details:
        typeof input.details === "string"
          ? input.details.slice(0, 1000)
          : input.details
            ? JSON.stringify(input.details).slice(0, 1000)
            : "",
    },
  }).catch(() => null);
}

/**
 * connectToServer equivalent after token exists:
 *   Promise.all([health, services]) → lock → activity connect → me
 */
async function connectLikeApp(session, device) {
  log("connect: GET /api/health + GET /api/services (parallel)");
  const [health, serviceResult] = await Promise.all([
    apiRequest(session, device, "/api/health", { timeoutMs: 15000 }),
    apiRequest(session, device, "/api/services", { timeoutMs: 15000 }),
  ]);
  log(`connect: health ok profilePool=${health.profilePool}`);

  log("connect: POST /api/profile/lock body={}");
  try {
    const lock = await apiRequest(session, device, "/api/profile/lock", {
      method: "POST",
      timeoutMs: 15000,
      body: {},
    });
    log(`connect: lock ok revision=${lock.revision ?? "?"}`);
  } catch (e) {
    if (e.payload?.reason === "device_active" || e.payload?.reason === "takeover_pending") {
      const err = new Error(e.message);
      err.payload = e.payload;
      err.code = "DEVICE_ACTIVE";
      throw err;
    }
    log(`connect: WARN lock ${e.message}`);
  }

  await recordActivity(session, device, {
    serviceId: "client",
    action: "connect",
    title: session.deviceId,
    details: {
      services: (serviceResult.config?.services || serviceResult.services || []).map((s) => s.id || s.serviceId).filter(Boolean),
      profileId: session.profileId,
      serverUrl: session.serverUrl,
    },
  });

  // Cache services list for shell scripts
  const svcList = serviceResult.config?.services || serviceResult.services || [];
  await cacheServicesList(svcList);

  try {
    await apiRequest(session, device, "/api/me", { timeoutMs: 10000 });
    log("connect: GET /api/me ok");
  } catch (e) {
    log(`connect: WARN /api/me ${e.message}`);
  }

  return { health, serviceResult };
}

/**
 * Before export: refresh interaction (score), heartbeat as if service tab open,
 * enforce min delay after loginAt (server loginAt + local loggedInAt).
 */
async function prepareExportLikeApp(session, device, serviceId) {
  const loggedInAt = Number(session.loggedInAt || 0);
  if (loggedInAt) {
    const wait = MIN_MS_AFTER_LOGIN - (Date.now() - loggedInAt);
    if (wait > 0) {
      log(`wait ${wait}ms (exportRiskScore +20 if <3s after login)`);
      await sleep(wait);
    }
  }

  // Fresh interaction — server interactedAt; avoid stale >60s (+15)
  if (!lastInteractAt || Date.now() - lastInteractAt > MAX_MS_SINCE_INTERACT) {
    log("pre-export: refresh interaction (health + services + me)");
    await Promise.all([
      apiRequest(session, device, "/api/health", { timeoutMs: 12000 }).catch(() => null),
      apiRequest(session, device, "/api/services", { timeoutMs: 12000 }).catch(() => null),
    ]);
    await apiRequest(session, device, "/api/me", { timeoutMs: 10000 }).catch(() => null);
  }

  // Mimic open tab heartbeat for this service (App sends while view attached)
  if (serviceId && serviceId !== "profile") {
    const body = tabStateLike(session, serviceId, SERVICE_URLS[serviceId]);
    log(`pre-export: POST /api/user-tabs/heartbeat serviceId=${serviceId}`);
    await apiRequest(session, device, "/api/user-tabs/heartbeat", {
      method: "POST",
      timeoutMs: 10000,
      body,
    }).catch((e) => log(`WARN heartbeat: ${e.message}`));

    await recordActivity(session, device, {
      serviceId,
      action: "open",
      url: body.url,
      title: serviceId,
      details: { via: "api-export-cli", profilePool: true },
    });
  }
}

// ── Google login ───────────────────────────────────────────────────────

function openBrowser(url) {
  const platform = process.platform;
  if (platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else if (platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function googleOAuthInteractive() {
  const codeVerifier = b64urlBuf(randomBytes(48));
  const codeChallenge = b64urlBuf(createHash("sha256").update(codeVerifier).digest());
  const stateTok = b64urlBuf(randomBytes(16));

  return new Promise((resolve, reject) => {
    let settled = false;
    let redirectUri = "";
    const server = createServer((req, res) => {
      let outcome = null;
      try {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        if (u.pathname !== "/") {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = u.searchParams.get("code");
        const st = u.searchParams.get("state");
        const err = u.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:48px;text-align:center'>" +
            "Đăng nhập Google xong. Đóng cửa sổ này và quay lại terminal.</body>"
        );
        if (err) outcome = () => reject(new Error(`Google: ${err}`));
        else if (!code || st !== stateTok) outcome = () => reject(new Error("OAuth state/code invalid"));
        else outcome = () => resolve({ code, codeVerifier, redirectUri });
      } catch (e) {
        outcome = () => reject(e);
      }
      if (outcome && !settled) {
        settled = true;
        try {
          server.close();
        } catch {
          /* ignore */
        }
        outcome();
      }
    });
    server.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl =
        `${GOOGLE_AUTH_ENDPOINT}?` +
        new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GOOGLE_SCOPE,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state: stateTok,
          access_type: "online",
          prompt: "select_account",
        }).toString();
      log("Opening Google sign-in in browser…");
      openBrowser(authUrl);
      console.error(`  (or open: ${authUrl.slice(0, 80)}…)`);
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          server.close();
        } catch {
          /* ignore */
        }
        reject(new Error("Google login timeout (180s)"));
      }
    }, 180000);
  });
}

async function cmdLogin() {
  // Prefer stable device id from previous session so deviceNew risk score doesn't re-fire
  const prev = await loadSession();
  const deviceId = process.env.CENTRIX_DEVICE_ID || prev?.deviceId || newDefaultDeviceId();
  const device = loadOrCreateDevice(prev);
  const oauth = await googleOAuthInteractive();

  // Exact googleLoginApiRequest body + headers (App User)
  log(`POST ${SERVER_URL}/api/auth/google`);
  const loginBody = {
    code: oauth.code,
    codeVerifier: oauth.codeVerifier,
    redirectUri: oauth.redirectUri,
    deviceId,
    deviceJkt: device.jkt,
  };
  let res;
  try {
    res = await fetch(`${SERVER_URL}/api/auth/google`, {
      method: "POST",
      headers: buildLoginHeaders(),
      body: JSON.stringify(loginBody),
    });
  } catch (error) {
    const reason = error?.name === "AbortError" ? "request timed out" : "network request failed";
    throw new ApiEndpointUnavailableError(SERVER_URL, reason);
  }
  const raw = await res.text();
  let result = {};
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    const contentType = res.headers.get("content-type") || "unknown content type";
    throw new ApiEndpointUnavailableError(SERVER_URL, `expected JSON but received ${contentType} (HTTP ${res.status})`);
  }
  if (!res.ok || !result.ok) {
    die(result.error || `Google login HTTP ${res.status}`);
  }

  const conn = result.connection || {};
  // Match connectionPayload construction in loginWithGoogle
  const session = {
    serverUrl: String(conn.serverUrl || SERVER_URL).replace(/\/+$/, ""),
    token: String(conn.token || "").trim(),
    sessionKey: String(conn.sessionKey || ""),
    profileId: String(conn.profileId || result.account?.profileId || "default"),
    deviceId: String(conn.deviceId || conn.userId || result.account?.userId || deviceId),
    expiresAt: conn.expiresAt || null,
    devicePem: device.pem,
    email: result.account?.email || "",
    loggedInAt: Date.now(),
  };
  if (!session.token) die("Login OK but no token in response");
  if (!session.sessionKey) log("WARN: no sessionKey — encrypted export may fail");

  await saveSession(session);
  log(`Logged in as ${session.email || session.deviceId}`);
  log(`server=${session.serverUrl} profile=${session.profileId} device=${session.deviceId}`);

  const dev = loadOrCreateDevice(session);
  try {
    await connectLikeApp(session, dev);
  } catch (e) {
    if (e.code === "DEVICE_ACTIVE" || e.payload?.reason === "device_active" || e.payload?.reason === "takeover_pending") {
      log(`Device busy (${e.payload?.reason || e.code}). Close App User or: ./export-centrix-api.sh takeover`);
      die(e.message);
    }
    log(`WARN connect: ${e.message}`);
  }
}

async function cmdTakeover() {
  const session = await loadSession();
  if (!session) die("No session. Run: ./export-centrix-api.sh login");
  const device = loadOrCreateDevice(session);
  log("POST /api/profile/takeover");
  await apiRequest(session, device, "/api/profile/takeover", { method: "POST", body: {}, timeoutMs: 12000 }).catch((e) =>
    log(`takeover: ${e.message}`)
  );
  const deadline = Date.now() + 16000;
  while (Date.now() < deadline) {
    try {
      await apiRequest(session, device, "/api/profile/lock", { method: "POST", body: {}, timeoutMs: 12000 });
      log("lock acquired after takeover");
      return;
    } catch (e) {
      if (e.payload?.reason === "device_active" || e.payload?.reason === "takeover_pending") {
        log(`waiting… ${e.payload.reason}`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      die(e.message);
    }
  }
  die("Takeover timeout");
}

async function cmdStatus() {
  const session = await loadSession();
  if (!session) {
    console.log(JSON.stringify({ ok: false, loggedIn: false, sessionFile: SESSION_FILE }, null, 2));
    return;
  }
  const device = loadOrCreateDevice(session);
  let health = null;
  let me = null;
  try {
    health = await apiRequest(session, device, "/api/health", { timeoutMs: 10000 });
  } catch (e) {
    health = { error: e.message };
  }
  try {
    me = await apiRequest(session, device, "/api/me", { timeoutMs: 10000 });
  } catch (e) {
    me = { error: e.message };
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        loggedIn: true,
        appVersion: APP_VERSION,
        userAgent: USER_AGENT,
        email: session.email,
        serverUrl: session.serverUrl,
        profileId: session.profileId,
        deviceId: session.deviceId,
        expiresAt: session.expiresAt,
        hasSessionKey: Boolean(session.sessionKey),
        sessionFile: SESSION_FILE,
        health,
        me: me?.error ? me : { ok: me?.ok, userId: me?.userId || me?.account?.userId },
      },
      null,
      2
    )
  );
}

async function cmdServices() {
  const session = await requireSession();
  const device = loadOrCreateDevice(session);
  await apiRequest(session, device, "/api/health", { timeoutMs: 12000 }).catch(() => null);
  const result = await apiRequest(session, device, "/api/services", { timeoutMs: 15000 });
  const list = result.config?.services || result.services || [];
  await cacheServicesList(list);
  for (const s of list) {
    const id = s.id || s.serviceId || "?";
    const name = s.name || s.serviceName || "";
    const url = s.url || "";
    const en = s.enabled === false ? "off" : "on";
    console.log(`${String(id).padEnd(22)} ${en.padEnd(4)} ${String(name).padEnd(22)} ${url}`);
  }
  if (!list.length) console.log(JSON.stringify(result, null, 2));
}

async function requireSession() {
  const session = await loadSession();
  if (!session?.token) die("No session. Run: ./export-centrix-api.sh login");
  return session;
}

function resolveServiceId(id) {
  const raw = String(id || "").toLowerCase().trim();
  return ALIASES[raw] || raw;
}

const SHARED_EXPORT_PY = join(ROOT, "scripts/lib/centrix_cookie_export.py");

/**
 * Shared write pattern with export-pick-service.sh + export-centrix-cookies.sh
 * → scripts/lib/centrix_cookie_export.py (--sidecars for Netscape/curl/editor/j2team)
 */
function writeCookiesViaSharedPattern(serviceId, payload, { urlHint = "", source = "api-export", name = "" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const py =
      process.env.PYTHON ||
      (existsSync("/opt/homebrew/bin/python3") ? "/opt/homebrew/bin/python3" : "python3");
    const args = [
      SHARED_EXPORT_PY,
      "--service",
      serviceId,
      "--stdin",
      "--out-dir",
      OUT_DIR,
      "--url",
      urlHint || "",
      "--source",
      source,
      "--sidecars",
      "--json",
    ];
    if (name) args.push("--name", name);
    const j2 = j2teamOutDir();
    if (j2) args.push("--j2team-dir", j2);
    const child = spawn(py, args, { stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`centrix_cookie_export.py exit ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.trim() || "{}"));
      } catch {
        resolvePromise({ raw: stdout, primary: "" });
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** Optional: import just-exported service into isolated Chrome profile via CDP. */
function importToChrome(serviceId) {
  return new Promise((resolvePromise, reject) => {
    const sh = join(ROOT, "import-cookies-to-chrome.sh");
    if (!existsSync(sh)) {
      log("WARN: import-cookies-to-chrome.sh missing — skip --chrome");
      resolvePromise(null);
      return;
    }
    log(`Chrome import: ${serviceId}`);
    const child = spawn("zsh", [sh, serviceId, "--cookies-dir", OUT_DIR], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`import-cookies-to-chrome exit ${code}`));
      else resolvePromise(true);
    });
  });
}

async function exportOne(session, device, serviceId, opts = {}) {
  const sid = resolveServiceId(serviceId);
  if (serviceId !== sid) log(`Alias ${serviceId} → ${sid}`);

  // Match App User openService: interact + heartbeat, then export?service=
  await prepareExportLikeApp(session, device, sid);

  const profilePool = opts.profilePool !== false;
  // App User pool pull: includeStorage true on open (default)
  const inc = opts.includeStorage !== false ? "1" : "0";
  let path;
  if (profilePool && sid && sid !== "all" && sid !== "profile") {
    path = `/api/profile/export?service=${encodeURIComponent(sid)}&includeStorage=${inc}`;
  } else {
    path = `/api/profile/export?profileId=${encodeURIComponent(session.profileId || "default")}&includeStorage=${inc}`;
  }

  log(`GET ${path}`);
  let result;
  try {
    result = await apiRequest(session, device, path, { timeoutMs: opts.includeStorage !== false ? 90000 : 30000 });
  } catch (e) {
    if (e.payload?.error === "export-blocked") {
      die(
        `export-blocked reason=${e.payload.reason || "?"} score=${e.payload.score ?? "?"} — check UA/attest/interaction timing`
      );
    }
    // Fallback: whole profile if ?service= not supported
    if (profilePool && sid && (e.status === 400 || e.status === 404)) {
      log("service export failed, retry whole profile…");
      await prepareExportLikeApp(session, device, sid);
      result = await apiRequest(
        session,
        device,
        `/api/profile/export?profileId=${encodeURIComponent(session.profileId || "default")}&includeStorage=${inc}`,
        { timeoutMs: 90000 }
      );
    } else {
      throw e;
    }
  }

  let snapshot = result.snapshot || {};
  if (result.encrypted) {
    if (!session.sessionKey) die("Encrypted snapshot but no sessionKey in session file — re-login");
    snapshot = decryptSnapshot(result.encrypted, session.sessionKey);
  }

  // Prefer snapshot/server URL (pool may remap notebooklm → chatgpt.com etc.)
  const pageUrl =
    snapshot.url ||
    result.url ||
    SERVICE_URLS[sid] ||
    (Array.isArray(snapshot.origins) ? snapshot.origins[0] : "") ||
    "";
  const serviceName = snapshot.serviceName || result.serviceName || sid;
  const payload = {
    ...snapshot,
    url: pageUrl || snapshot.url || "",
    serviceId: sid,
    serviceName,
    cookies: Array.isArray(snapshot.cookies) ? snapshot.cookies : [],
    localStorage: snapshot.localStorage || snapshot.storage || {},
    exportedAt: new Date().toISOString(),
    revision: result.revision,
    assignedProfile: result.assignedProfile || null,
    source: "api-export",
  };

  log(`write via shared pattern → scripts/lib/centrix_cookie_export.py (+sidecars)`);
  const written = await writeCookiesViaSharedPattern(sid, payload, {
    urlHint: pageUrl,
    source: "api-export",
    name: serviceName,
  });

  log(
    `service=${written.service || sid} cookies=${written.cookies ?? "?"} revision=${result.revision ?? "?"} → ${written.primary || ""}`
  );

  if (wantChromeImport()) {
    try {
      await importToChrome(sid);
    } catch (e) {
      log(`WARN chrome import ${sid}: ${e.message}`);
    }
  }

  return { serviceId: sid, cookies: written.cookies, primary: written.primary };
}

async function cmdExport(args) {
  const session = await requireSession();
  const device = loadOrCreateDevice(session);

  // Full connect-like handshake (same as App after login / session restore)
  let profilePool = true;
  try {
    const { health } = await connectLikeApp(session, device);
    profilePool = health?.profilePool !== false;
  } catch (e) {
    if (e.code === "DEVICE_ACTIVE" || e.payload?.reason === "device_active" || e.payload?.reason === "takeover_pending") {
      die(`Device lock failed (${e.payload?.reason || e.code}). Close App User or: ./export-centrix-api.sh takeover`);
    }
    if (e.code === "API_ENDPOINT_UNAVAILABLE") {
      die(`${e.message}. Set CENTRIX_SERVER_URL to the active CentriX API URL and retry.`);
    }
    log(`WARN connect: ${e.message} — continuing with best-effort interaction`);
    await apiRequest(session, device, "/api/health", { timeoutMs: 12000 }).catch(() => null);
    await apiRequest(session, device, "/api/services", { timeoutMs: 12000 }).catch(() => null);
  }

  let services = args.filter((a) => !a.startsWith("-") && a !== "all");
  const includeStorage = !args.includes("--no-storage");
  const wantAll = !args.filter((a) => !a.startsWith("-")).length || args.includes("all");

  if (wantAll) {
    try {
      const svc = await apiRequest(session, device, "/api/services", { timeoutMs: 15000 });
      const list = svc.config?.services || svc.services || [];
      services = list.filter((s) => s.enabled !== false).map((s) => s.id || s.serviceId).filter(Boolean);
      if (!services.length) services = Object.keys(SERVICE_URLS);
    } catch {
      services = ["notebooklm", "claude", "grok-heavy", "gemini", "deepseek"];
    }
  }

  // De-dupe aliases
  const seen = new Set();
  const resolved = [];
  for (const s of services) {
    const id = resolveServiceId(s);
    if (seen.has(id)) continue;
    seen.add(id);
    resolved.push(id);
  }

  let ok = 0;
  let fail = 0;
  for (const sid of resolved) {
    try {
      await exportOne(session, device, sid, { profilePool, includeStorage });
      ok += 1;
      // brief gap between exports (human-ish; also avoids rate limit burst)
      await sleep(400 + Math.floor(Math.random() * 400));
    } catch (e) {
      fail += 1;
      console.error(`! ${sid}: ${e.message}`);
      if (e.payload) console.error(`  payload: ${JSON.stringify(e.payload).slice(0, 300)}`);
    }
  }
  log(`Done ok=${ok} fail=${fail} out=${OUT_DIR}`);
  if (fail > 0) process.exitCode = 1;
}

async function cmdLogout() {
  const session = await loadSession();
  if (session) {
    const device = loadOrCreateDevice(session);
    try {
      await apiRequest(session, device, "/api/profile/release", { method: "POST", body: {}, timeoutMs: 8000 });
    } catch {
      /* ignore */
    }
    try {
      await apiRequest(session, device, "/api/auth/self-revoke", { method: "POST", body: {}, timeoutMs: 8000 });
    } catch {
      /* ignore */
    }
  }
  await clearSession();
}

function usage() {
  return `Usage: export-centrix-api.sh [command] [args]
       export-centrix-api.sh              # interactive menu

Commands:
  login              Google OAuth → save session (no App UI)
  takeover           Kick other device then lock
  status             Session + health + /api/me
  services           List services from API
  export [ids…]      Pull cookies (default: all enabled)
  export all         Same
  export grok        Alias → grok-heavy (unless CENTRIX_NO_ALIASES=1)
  export chatgpt     Alias → notebooklm (pool GPT Pro slot)
  export pro         Alias → notebooklm (same pool slot)
  logout             Release + self-revoke + delete session file

Options (export / shell):
  --no-storage       includeStorage=0 (faster)
  --chrome           after each service, import into ./.chrome-cookie-profile

Env:
  CENTRIX_APP_VERSION=${APP_VERSION}   # User-Agent CentriXAppUser/<ver>
  CENTRIX_SERVER_URL=${DEFAULT_SERVER}
  CENTRIX_SESSION_FILE=./.centrix-api-session.json
  CENTRIX_OUT_DIR=./cookies
  J2TEAM_OUT_DIR=                    # optional injector copy
  IMPORT_TO_CHROME=1                 # same as --chrome
  CENTRIX_NO_ALIASES=1               # disable chatgpt→notebooklm etc.
`;
}

function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => resolve(String(ans || "").trim()));
  });
}

async function sessionSummaryLine() {
  const s = await loadSession();
  if (!s?.token) return "session: (chưa login)";
  return `session: ${s.email || s.deviceId} · profile=${s.profileId} · ${s.serverUrl}`;
}

/** Interactive menu when no CLI args */
async function interactiveMenu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const summary = await sessionSummaryLine();
    console.log("");
    console.log(`CentriX API export · App User ${APP_VERSION} (không mở App UI)`);
    console.log("────────────────────────────────────");
    console.log(`  ${summary}`);
    console.log(`  UA: ${USER_AGENT}`);
    console.log("────────────────────────────────────");
    console.log("  1) login      — Google OAuth, lưu session");
    console.log("  2) export     — chọn service, pull cookie");
    console.log("  3) export all — mọi service enabled");
    console.log("  4) status     — session + health + /api/me");
    console.log("  5) services   — list service từ API");
    console.log("  6) takeover   — đá device khác rồi lock");
    console.log("  7) logout     — revoke + xóa session file");
    console.log("  q) quit");
    console.log("");

    const choice = await ask(rl, "Chọn [1-7 / q]: ");
    if (!choice || choice === "q" || choice === "Q" || choice === "0") {
      console.log("Bye.");
      return;
    }

    switch (choice) {
      case "1":
      case "login":
        rl.close();
        await cmdLogin();
        return;
      case "2":
      case "export": {
        const services = await pickExportServices(rl);
        rl.close();
        if (!services) return;
        await cmdExport(services);
        return;
      }
      case "3":
      case "all":
        rl.close();
        await cmdExport(["all"]);
        return;
      case "4":
      case "status":
        rl.close();
        await cmdStatus();
        return;
      case "5":
      case "services":
        rl.close();
        await cmdServices();
        return;
      case "6":
      case "takeover":
        rl.close();
        await cmdTakeover();
        return;
      case "7":
      case "logout":
        rl.close();
        await cmdLogout();
        return;
      default:
        console.log("Lựa chọn không hợp lệ.");
        rl.close();
        return;
    }
  } catch (e) {
    rl.close();
    throw e;
  }
}

/**
 * Pick services for export:
 *  - number keys from known list
 *  - free text ids
 *  - a / all
 */
async function pickExportServices(rl) {
  const known = [
    ["a", "all", "Mọi service enabled trên account"],
    ["1", "chatgpt", "→ notebooklm (GPT-5.5 Pro / chatgpt.com)"],
    ["2", "grok", "→ grok-heavy"],
    ["3", "claude", "Claude"],
    ["4", "gemini", "Gemini"],
    ["5", "deepseek", "DeepSeek"],
    ["6", "perplexity", "Perplexity"],
    ["7", "microsoft-copilot", "Microsoft Copilot"],
    ["8", "notebooklm", "notebooklm (raw id)"],
    ["9", "grok-heavy", "grok-heavy (raw id)"],
  ];

  console.log("");
  console.log("Chọn service export (số hoặc id, nhiều cái cách nhau space):");
  for (const [key, id, note] of known) {
    console.log(`  ${key}) ${id.padEnd(20)} ${note}`);
  }
  console.log("  (hoặc gõ id tùy ý: claude gemini …)");
  console.log("");

  const ans = await ask(rl, "Export: ");
  if (!ans || ans === "q" || ans === "Q") {
    console.log("Cancelled.");
    return null;
  }

  const tokens = ans.split(/[\s,]+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (low === "a" || low === "all") {
      out.push("all");
      continue;
    }
    const hit = known.find(([k, id]) => k === low || id === low);
    if (hit) out.push(hit[1]);
    else out.push(tok);
  }

  // storage option
  const stor = await ask(rl, "includeStorage? [Y/n]: ");
  if (stor === "n" || stor === "N" || stor === "no") out.push("--no-storage");

  return out.length ? out : ["all"];
}

async function main() {
  // Shell may strip --chrome into IMPORT_TO_CHROME; still accept it on argv
  const argv = process.argv.slice(2).filter((a) => {
    if (a === "--chrome") {
      process.env.IMPORT_TO_CHROME = "1";
      return false;
    }
    return true;
  });
  const [cmd, ...rest] = argv;
  if (cmd === "-h" || cmd === "--help") {
    console.log(usage());
    process.exit(0);
  }
  // No args → interactive menu
  if (!cmd || cmd === "menu" || cmd === "-i" || cmd === "--interactive") {
    await interactiveMenu();
    return;
  }
  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "takeover":
      await cmdTakeover();
      break;
    case "status":
      await cmdStatus();
      break;
    case "services":
      await cmdServices();
      break;
    case "export":
      await cmdExport(rest);
      break;
    case "logout":
      await cmdLogout();
      break;
    default:
      die(`Unknown command: ${cmd}\n${usage()}`);
  }
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  });
}
