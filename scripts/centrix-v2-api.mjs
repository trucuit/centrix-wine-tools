#!/usr/bin/env node
/**
 * centrix-v2-api.mjs
 *
 * CentriX Desktop v2 API (api.cetrix.app) — managed-profile lease flow.
 *
 * Flow: OTP login → accessToken → assign serviceId → snapshot → AES-GCM decrypt → cookies/
 *
 * Usage:
 *   ./export-centrix-api.sh login                    # OTP login
 *   ./export-centrix-api.sh export chatgpt            # export chatgpt cookies
 *   ./export-centrix-api.sh export gptpro             # export GPT Pro cookies
 *   ./export-centrix-api.sh export gptpro --chrome    # + inject into Chrome
 *   ./export-centrix-api.sh status                    # check session
 *   ./export-centrix-api.sh services                  # list available services
 *   ./export-centrix-api.sh logout                    # clear session
 *
 * Env:
 *   CENTRIX_V2_API_URL     default https://api.cetrix.app
 *   CENTRIX_V2_SESSION     default ./.cetrix-session.json
 *   CENTRIX_OUT_DIR        default ./cookies
 *   CENTRIX_APP_VERSION    default 0.1.391
 *   IMPORT_TO_CHROME=1     after export, run import-cookies-to-chrome.sh
 */

import { createHash, createDecipheriv } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const API_BASE = String(process.env.CENTRIX_V2_API_URL || "https://api.cetrix.app").trim().replace(/\/+$/, "");
const SESSION_FILE = resolve(process.env.CENTRIX_V2_SESSION || join(ROOT, ".cetrix-session.json"));
const OUT_DIR = resolve(process.env.CENTRIX_OUT_DIR || join(ROOT, "cookies"));
const APP_VERSION = String(process.env.CENTRIX_APP_VERSION || "0.1.391").trim();

const SERVICE_URLS = {
  chatgpt: "https://chatgpt.com/",
  gptpro: "https://chatgpt.com/",
  notebooklm: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/",
  perplexity: "https://www.perplexity.ai/",
  copilot: "https://copilot.microsoft.com/",
  "microsoft-copilot": "https://copilot.microsoft.com/",
  grok: "https://grok.com/",
  "grok-heavy": "https://grok.com/",
  deepseek: "https://chat.deepseek.com/",
  canva: "https://www.canva.com/",
  monica: "https://monica.im/",
  freepik: "https://www.freepik.com/",
  gamma: "https://gamma.app/",
  quillbot: "https://quillbot.com/",
  scribd: "https://www.scribd.com/",
  "envato-elements": "https://elements.envato.com/",
  zoom: "https://zoom.us/",
  semrush: "https://www.semrush.com/",
  notion: "https://app.notion.com/",
  mistral: "https://chat.mistral.ai/",
  midjourney: "https://www.midjourney.com/",
  poe: "https://poe.com/",
  elevenlabs: "https://elevenlabs.io/app",
};

/** Known service aliases mapping to canonical service IDs in CentriX API catalog */
const SERVICE_ALIASES = {
  // ChatGPT Pro (GPT-5.6 Pro)
  "gpt pro": "gptpro",
  "gpt-pro": "gptpro",
  gpt_pro: "gptpro",
  gptpro: "gptpro",
  "chatgpt pro": "gptpro",
  "chatgpt-pro": "gptpro",
  chatgpt_pro: "gptpro",
  chatgptpro: "gptpro",
  "gpt 5": "gptpro",
  "gpt-5": "gptpro",
  gpt5: "gptpro",
  pro: "gptpro",

  // ChatGPT Standard
  chatgpt: "chatgpt",
  "chat gpt": "chatgpt",
  "chat-gpt": "chatgpt",
  chat_gpt: "chatgpt",
  gpt: "chatgpt",

  // Grok Heavy
  "grok heavy": "grok-heavy",
  "grok-heavy": "grok-heavy",
  grok_heavy: "grok-heavy",
  grokheavy: "grok-heavy",
  heavy: "grok-heavy",

  // Grok Standard
  grok: "grok",

  // Microsoft Copilot
  copilot: "copilot",
  "microsoft copilot": "copilot",
  "microsoft-copilot": "copilot",
  microsoft_copilot: "copilot",
  "ms copilot": "copilot",
  "ms-copilot": "copilot",
  ms_copilot: "copilot",

  // Envato Elements
  "envato elements": "envato-elements",
  "envato-elements": "envato-elements",
  envato_elements: "envato-elements",
  envato: "envato-elements",
  elements: "envato-elements",

  // Freepik / Magnific
  freepik: "freepik",
  magnific: "freepik",

  // Claude
  claude: "claude",
  "claude ai": "claude",
  "claude-ai": "claude",

  // Gemini
  gemini: "gemini",
  google: "gemini",

  // Perplexity
  perplexity: "perplexity",
  sonar: "perplexity",

  // Others
  deepseek: "deepseek",
  canva: "canva",
  monica: "monica",
  gamma: "gamma",
  quillbot: "quillbot",
  scribd: "scribd",
  zoom: "zoom",
  semrush: "semrush",
  notion: "notion",
  mistral: "mistral",
  midjourney: "midjourney",
  poe: "poe",
  elevenlabs: "elevenlabs",
};

/**
 * Resolve an array of service tokens (e.g. ["gpt", "pro", "claude"])
 * into canonical service IDs (e.g. ["gptpro", "claude"]).
 */
function resolveServices(tokens) {
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    const t1 = String(tokens[i] || "").toLowerCase().trim();
    if (!t1) {
      i++;
      continue;
    }
    // Check 2-token match first (e.g. "gpt pro", "grok heavy", "ms copilot")
    if (i + 1 < tokens.length) {
      const t2 = String(tokens[i + 1] || "").toLowerCase().trim();
      const combined = `${t1} ${t2}`;
      const hyphenCombined = `${t1}-${t2}`;
      if (SERVICE_ALIASES[combined]) {
        result.push(SERVICE_ALIASES[combined]);
        i += 2;
        continue;
      }
      if (SERVICE_ALIASES[hyphenCombined]) {
        result.push(SERVICE_ALIASES[hyphenCombined]);
        i += 2;
        continue;
      }
    }
    // Single token match
    const resolved = SERVICE_ALIASES[t1] || t1;
    result.push(resolved);
    i++;
  }
  return [...new Set(result)];
}

/** Services that also need auth.openai.com cookies injected + tab opened */
const AUTH_OPENAI_SERVICES = new Set(["chatgpt", "gptpro", "notebooklm"]);

// ── helpers ─────────────────────────────────────────────────

const log = (...a) => console.log("▸", ...a);
const warn = (...a) => console.error("!", ...a);

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

// ── session ─────────────────────────────────────────────────

async function readSession() {
  try {
    const raw = await readFile(SESSION_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeSession(data) {
  await mkdir(dirname(SESSION_FILE), { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

async function clearSession() {
  try { await unlink(SESSION_FILE); } catch { /* ok */ }
}

// ── API fetch ─────────────────────────────────────────────

async function api(path, opts = {}) {
  const session = await readSession();
  const headers = {
    "content-type": "application/json",
    "x-centrix-app-version": APP_VERSION,
    "x-centrix-platform": process.platform,
    "x-centrix-arch": process.arch,
    ...opts.headers,
  };
  if (session?.accessToken) headers.authorization = `Bearer ${session.accessToken}`;
  const url = `${API_BASE}${path}`;
  let response = await fetch(url, { ...opts, headers });

  // auto-refresh on 401
  if (response.status === 401 && session?.refreshToken) {
    const refreshed = await refreshAccessToken(session.refreshToken);
    if (refreshed) {
      headers.authorization = `Bearer ${refreshed}`;
      response = await fetch(url, { ...opts, headers });
    }
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body?.error?.message || body?.error || body?.message || `HTTP ${response.status}`);
    err.code = body?.error?.code || body?.error || response.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function refreshAccessToken(refreshToken) {
  try {
    const response = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const accessToken = String(data?.accessToken || "").trim();
    const nextRefresh = String(data?.refreshToken || refreshToken).trim();
    if (!accessToken) return null;
    const session = await readSession();
    await writeSession({ ...session, accessToken, refreshToken: nextRefresh });
    log("Access token refreshed");
    return accessToken;
  } catch {
    return null;
  }
}

// ── commands ─────────────────────────────────────────────

async function cmdLogin() {
  const session = await readSession();
  const defaultEmail = session?.email || "";
  const emailHint = defaultEmail ? ` [${defaultEmail}]` : "";
  const email = (await prompt(`Email${emailHint}: `)) || defaultEmail;
  if (!email) { warn("No email provided"); process.exit(1); }

  log("Requesting OTP for", email, "...");
  const otpResult = await fetch(`${API_BASE}/v1/auth/request-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then(r => r.json());

  if (!otpResult.challengeId) {
    warn("Failed to request OTP:", otpResult.error || otpResult.message || JSON.stringify(otpResult));
    process.exit(1);
  }

  log("OTP sent to", email, `(expires in ${otpResult.expiresInSeconds}s)`);
  const code = await prompt("Enter OTP code: ");
  if (!code) { warn("No OTP code"); process.exit(1); }

  log("Verifying OTP...");
  const authResult = await fetch(`${API_BASE}/v1/auth/verify-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: otpResult.challengeId, email, code }),
  }).then(r => r.json());

  if (!authResult.accessToken) {
    warn("OTP verification failed:", authResult.error?.message || authResult.error || JSON.stringify(authResult));
    process.exit(1);
  }

  await writeSession({
    email: authResult.user?.email || email,
    userId: authResult.user?.id,
    userName: authResult.user?.name,
    accessToken: authResult.accessToken,
    refreshToken: authResult.refreshToken,
    sessionId: authResult.sessionId,
    accessExpiresInSeconds: authResult.accessExpiresInSeconds,
    refreshExpiresInSeconds: authResult.refreshExpiresInSeconds,
  });

  log("Logged in as", authResult.user?.email || email);
  log("Session saved →", SESSION_FILE);
}

async function cmdStatus() {
  const session = await readSession();
  if (!session?.accessToken) {
    warn("Not logged in. Run: ./export-centrix-api.sh login");
    process.exit(1);
  }
  log("Session file:", SESSION_FILE);
  log("Email:", session.email || "unknown");
  log("User:", session.userName || "unknown");
  log("Saved at:", session.savedAt || "unknown");

  try {
    const me = await api("/v1/auth/me");
    log("Server says:", me.user?.email, "status=" + me.user?.status);
  } catch (e) {
    warn("Session expired or invalid:", e.message);
  }
}

async function cmdLogout() {
  try { await api("/v1/auth/logout", { method: "POST" }); } catch { /* best effort */ }
  await clearSession();
  log("Logged out, session cleared");
}

async function cmdServices() {
  try {
    const data = await api("/v1/catalog/services");
    if (data.services) {
      log("Available services (from API catalog):");
      for (const s of data.services) {
        log(`  ${(s.id || s.serviceId).padEnd(20)}  ${s.name || ""}`);
      }
      return;
    }
  } catch { /* fallback to local catalog */ }

  log("Service catalog (local):");
  for (const [id, url] of Object.entries(SERVICE_URLS)) {
    log(`  ${id.padEnd(20)} ${url}`);
  }
}

async function cmdExport(serviceIds, chromeImport) {
  const session = await readSession();
  if (!session?.accessToken) {
    warn("Not logged in. Run: ./export-centrix-api.sh login");
    process.exit(1);
  }

  if (!serviceIds.length) {
    warn("Specify service(s): ./export-centrix-api.sh export chatgpt gptpro");
    warn("Available:", Object.keys(SERVICE_URLS).join(", "));
    process.exit(1);
  }

  // expand "all"
  if (serviceIds.includes("all")) {
    serviceIds = Object.keys(SERVICE_URLS);
  }

  let okCount = 0;
  let failCount = 0;

  for (const serviceId of serviceIds) {
    log(`\n── ${serviceId} ──`);
    try {
      const { cookies, snapshot } = await exportService(serviceId);
      if (cookies.length > 0) {
        await writeCookieFiles(serviceId, cookies, snapshot);
        okCount++;

        if (chromeImport) {
          await importToChrome(serviceId);
          // Also inject auth.openai.com cookies + open tab for OpenAI services
          if (AUTH_OPENAI_SERVICES.has(serviceId)) {
            await injectAuthOpenai(serviceId, cookies);
          }
        }
      } else {
        warn(`${serviceId}: no cookies in snapshot`);
        failCount++;
      }
    } catch (e) {
      warn(`${serviceId}: ${e.code || ""} ${e.message}`);
      if (e.body) warn("  payload:", JSON.stringify(e.body));
      failCount++;
    }
  }

  log(`\n▸ Done ok=${okCount} fail=${failCount} out=${OUT_DIR}`);
  if (failCount > 0) process.exitCode = 1;
}

async function exportService(serviceId) {
  // 1. Assign
  log(`assign ${serviceId}...`);
  const idempotencyKey = `cli-${serviceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const assignResult = await api("/v1/managed-profiles/assign", {
    method: "POST",
    body: JSON.stringify({
      serviceId,
      idempotencyKey,
      ttlSeconds: 1800,
      stickySeconds: 900,
      reclaim: true,
    }),
  });

  const assignment = assignResult.assignment;
  const leaseToken = assignResult.leaseToken;
  if (!assignment?.id || !leaseToken) throw new Error("ASSIGN_FAILED: no assignment/leaseToken");

  log(`assigned profile=${assignment.profileId?.slice(0, 8)}… snapshot=v${assignment.snapshotVersion}`);

  // 2. Snapshot
  log("fetching snapshot...");
  const snapshotResult = await api(`/v1/managed-profiles/${encodeURIComponent(assignment.id)}/snapshot`, {
    method: "GET",
    headers: { "x-managed-lease-token": leaseToken },
  });

  if (!snapshotResult.envelope) throw new Error("SNAPSHOT_EMPTY: no envelope");

  // 3. Decrypt
  log("decrypting envelope...");
  const envelope = snapshotResult.envelope;
  const key = createHash("sha256").update(leaseToken).digest();
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plainBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const snapshot = JSON.parse(plainBuf.toString("utf8"));

  const cookies = snapshot.cookies || [];
  log(`decrypted: ${cookies.length} cookies, service=${snapshot.serviceId}`);

  // 4. Release lease (best-effort, don't block)
  api(`/v1/managed-profiles/${encodeURIComponent(assignment.id)}/release`, {
    method: "POST",
    body: JSON.stringify({ leaseToken, reason: "cli_export_done" }),
  }).catch(() => {});

  return { cookies, snapshot };
}

async function writeCookieFiles(serviceId, cookies, snapshot = {}) {
  const serviceDir = join(OUT_DIR, serviceId);
  await mkdir(serviceDir, { recursive: true });

  const serviceUrl = SERVICE_URLS[serviceId] || `https://${serviceId}.com/`;

  // 1. Raw service JSON (full snapshot cookies)
  const serviceFile = join(serviceDir, `${serviceId}.json`);
  const serviceData = {
    url: serviceUrl,
    cookies: cookies.map((c) => ({
      domain: c.domain,
      expirationDate: c.expirationDate || c.expires || (Date.now() / 1000 + 86400 * 30),
      hostOnly: !String(c.domain).startsWith("."),
      httpOnly: !!c.httpOnly,
      name: c.name,
      path: c.path || "/",
      sameSite: c.sameSite || "unspecified",
      secure: !!c.secure,
      session: !!c.session,
      storeId: "0",
      value: c.value,
    })),
  };
  await writeFile(serviceFile, JSON.stringify(serviceData, null, 2), { mode: 0o600 });

  // 2. Split by domain for import-cookies-to-chrome.sh
  const byDomain = {};
  for (const c of serviceData.cookies) {
    const dom = String(c.domain).replace(/^\./, "");
    if (!byDomain[dom]) byDomain[dom] = [];
    byDomain[dom].push(c);
  }
  for (const [dom, domCookies] of Object.entries(byDomain)) {
    const domFile = join(serviceDir, `${dom}.json`);
    await writeFile(domFile, JSON.stringify(domCookies, null, 2), { mode: 0o600 });
  }

  // 3. Sidecars for Chrome import & storage injection (matches centrix-service-api.sh pattern)
  if (snapshot && typeof snapshot === "object") {
    // Service-level full snapshot
    const fullFile = join(serviceDir, `${serviceId}.full.json`);
    await writeFile(fullFile, JSON.stringify(snapshot, null, 2), { mode: 0o600 });

    // Service-level localStorage (used by import-cookies-to-chrome.mjs)
    if (snapshot.localStorage && Object.keys(snapshot.localStorage).length > 0) {
      const storageFile = join(serviceDir, `${serviceId}.storage.json`);
      await writeFile(storageFile, JSON.stringify(snapshot.localStorage, null, 2), { mode: 0o600 });
    }

    // Root-level session and cookie files
    const rootSessionFile = join(OUT_DIR, `session-${serviceId}.json`);
    await writeFile(rootSessionFile, JSON.stringify(snapshot, null, 2), { mode: 0o600 });

    const rootCookieFile = join(OUT_DIR, `cookies-${serviceId}.json`);
    await writeFile(rootCookieFile, JSON.stringify(serviceData.cookies, null, 2), { mode: 0o600 });
  }

  const sessionTokens = cookies.filter((c) => c.name?.includes("session"));
  log(`saved ${cookies.length} cookies → ${serviceDir}/`);
  if (sessionTokens.length) {
    for (const c of sessionTokens) {
      log(`  session: ${c.name} (${c.domain})`);
    }
  }
}

async function importToChrome(serviceId) {
  const importScript = join(ROOT, "import-cookies-to-chrome.sh");
  if (!existsSync(importScript)) {
    warn("import-cookies-to-chrome.sh not found, skipping Chrome import");
    return;
  }
  log(`importing ${serviceId} to Chrome...`);
  return new Promise((res) => {
    const child = spawn(importScript, [serviceId], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, CENTRIX_COOKIES_DIR: OUT_DIR },
    });
    child.on("close", (code) => {
      if (code !== 0) warn(`Chrome import exited with code ${code}`);
      res();
    });
  });
}

/**
 * Inject auth.openai.com cookies via CDP and open a tab.
 * The snapshot contains cookies for auth.openai.com domain but
 * import-cookies-to-chrome.sh only sets them via Storage API.
 * This function uses CDP Network.setCookie for each auth.openai.com cookie
 * then opens auth.openai.com in a new tab.
 */
async function injectAuthOpenai(serviceId, cookies) {
  const authCookies = cookies.filter((c) => {
    const dom = String(c.domain || "");
    return dom.includes("auth.openai.com") || dom.includes("openai.com");
  });
  if (!authCookies.length) {
    log("no auth.openai.com cookies in snapshot, skipping");
    return;
  }

  log(`injecting ${authCookies.length} auth.openai.com cookies via CDP...`);
  try {
    const targetsResp = await fetch("http://127.0.0.1:9222/json/list");
    const targets = await targetsResp.json();
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page) { warn("no CDP page target"); return; }

    const { WebSocket } = await import("ws").catch(() => ({ WebSocket: globalThis.WebSocket }));
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => socket.addEventListener("open", r, { once: true }));

    let id = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => {
      const m = JSON.parse(String(data));
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result || {});
      }
    });
    const call = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        socket.send(JSON.stringify({ id: i, method, params }));
      });

    // Clear old auth cookies
    await call("Network.enable");
    const existing = await call("Network.getCookies", { urls: ["https://auth.openai.com"] });
    for (const c of existing.cookies || []) {
      await call("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path });
    }

    // Inject new cookies
    let injected = 0;
    for (const c of authCookies) {
      const domain = String(c.domain || "");
      const secure = c.secure !== false;
      const sameSite = ({ lax: "Lax", strict: "Strict", none: "None" })[String(c.sameSite || "").toLowerCase()] || "Lax";
      try {
        await call("Network.setCookie", {
          name: c.name,
          value: c.value,
          domain,
          path: c.path || "/",
          secure,
          httpOnly: !!c.httpOnly,
          sameSite,
          expires: c.expirationDate || c.expires || (Date.now() / 1000 + 86400 * 30),
          url: `https://${domain.replace(/^\./, "")}/`,
        });
        injected++;
      } catch { /* skip */ }
    }
    log(`auth.openai.com: ${injected}/${authCookies.length} cookies injected via CDP`);

    // Open auth.openai.com in new tab
    try {
      await fetch("http://127.0.0.1:9222/json/new?https://auth.openai.com/", { method: "PUT" });
      log("opened auth.openai.com tab");
    } catch {
      // Fallback: navigate current tab
      await call("Page.enable");
      await call("Page.navigate", { url: "https://auth.openai.com/" });
    }

    socket.close();
  } catch (e) {
    warn(`auth.openai.com CDP inject failed: ${e.message}`);
  }
}

function printHelp() {
  console.log(`CentriX API v2 · ${APP_VERSION} (${API_BASE})`);
  console.log();
  console.log("Usage:");
  console.log("  ./export-centrix-api.sh               Interactive menu (TTY)");
  console.log("  ./export-centrix-api.sh gpt pro       Export GPT Pro cookies (shorthand)");
  console.log("  ./export-centrix-api.sh export <svc>  Export cookies (gptpro, chatgpt, claude...)");
  console.log("  ./export-centrix-api.sh export all    Export all services");
  console.log("  ./export-centrix-api.sh <svc> --chrome Export + inject into Chrome");
  console.log("  ./export-centrix-api.sh status        Check session");
  console.log("  ./export-centrix-api.sh services      List available services");
  console.log("  ./export-centrix-api.sh login         OTP login");
  console.log("  ./export-centrix-api.sh logout        Clear session");
  console.log();
  console.log("Aliases supported:");
  console.log("  gpt pro, gptpro, gpt-pro, pro, chatgpt-pro, gpt 5 -> gptpro");
  console.log("  chatgpt, gpt                                       -> chatgpt");
  console.log("  grok heavy, grok-heavy, heavy                      -> grok-heavy");
  console.log("  copilot, ms copilot, microsoft copilot             -> copilot");
  console.log("  envato, envato elements, envato-elements           -> envato-elements");
  console.log();
  console.log("Env:");
  console.log(`  CENTRIX_V2_API_URL    ${API_BASE}`);
  console.log(`  CENTRIX_V2_SESSION    ${SESSION_FILE}`);
  console.log(`  CENTRIX_OUT_DIR       ${OUT_DIR}`);
  console.log(`  CENTRIX_APP_VERSION   ${APP_VERSION}`);
}

async function cmdMenu() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║             CentriX API Manager (v2)                     ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("  1) 👤 Status         — Kiểm tra phiên đăng nhập & tài khoản");
  console.log("  2) 📋 Services       — Danh sách dịch vụ trong hệ thống");
  console.log("  3) 🍪 Export         — Tải cookies dịch vụ (gptpro, claude...)");
  console.log("  4) 🌐 Export & Chrome— Tải cookies & nạp trực tiếp vào Chrome");
  console.log("  5) 📦 Export All     — Tải cookies cho tất cả dịch vụ");
  console.log("  6) 🔑 Login          — Đăng nhập bằng mã OTP (email)");
  console.log("  7) 🚪 Logout         — Đăng xuất & xoá phiên làm việc");
  console.log("  0) ❌ Thoát");
  console.log("");

  const choice = await prompt("👉 Chọn chức năng [1-7, 0] (mặc định: 1): ");
  switch (choice) {
    case "1":
    case "status":
    case "info":
      await cmdStatus();
      break;
    case "2":
    case "services":
    case "list":
      await cmdServices();
      break;
    case "3":
    case "export": {
      const svc = await prompt("👉 Nhập tên dịch vụ (e.g. gptpro, claude, grok-heavy) [gptpro]: ");
      const target = svc ? resolveServices([svc]) : ["gptpro"];
      await cmdExport(target, false);
      break;
    }
    case "4":
    case "chrome": {
      const svc = await prompt("👉 Nhập tên dịch vụ cần nạp vào Chrome [gptpro]: ");
      const target = svc ? resolveServices([svc]) : ["gptpro"];
      await cmdExport(target, true);
      break;
    }
    case "5":
    case "all":
      await cmdExport(["all"], false);
      break;
    case "6":
    case "login":
      await cmdLogin();
      break;
    case "7":
    case "logout":
      await cmdLogout();
      break;
    case "0":
    case "q":
    case "exit":
      console.log("Thoát.");
      break;
    default:
      await cmdStatus();
      break;
  }
}

// ── main ─────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);
  const chromeFlag = rawArgs.includes("--chrome") || rawArgs.includes("-c") || process.env.IMPORT_TO_CHROME === "1";
  const nonFlags = rawArgs.filter((a) => !a.startsWith("-"));

  if (rawArgs.includes("-h") || rawArgs.includes("--help") || nonFlags[0] === "help") {
    printHelp();
    return;
  }

  if (!nonFlags.length) {
    if (process.stdin.isTTY) {
      await cmdMenu();
    } else {
      printHelp();
    }
    return;
  }

  const firstToken = nonFlags[0].toLowerCase().trim();

  switch (firstToken) {
    case "login":
      await cmdLogin();
      break;
    case "status":
    case "info":
      await cmdStatus();
      break;
    case "logout":
      await cmdLogout();
      break;
    case "services":
    case "list":
      await cmdServices();
      break;
    case "menu":
      await cmdMenu();
      break;
    case "export": {
      const targetServices = resolveServices(nonFlags.slice(1));
      await cmdExport(targetServices, chromeFlag);
      break;
    }
    default: {
      // Shorthand: firstToken is not a subcommand, treat nonFlags as service names/aliases (e.g. "gpt pro", "gptpro", "claude")
      const targetServices = resolveServices(nonFlags);
      await cmdExport(targetServices, chromeFlag);
      break;
    }
  }
}

main().catch((e) => {
  warn(e.message || e);
  process.exit(1);
});
