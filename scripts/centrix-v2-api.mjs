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
 *   CENTRIX_APP_VERSION    default 0.1.339
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
const APP_VERSION = String(process.env.CENTRIX_APP_VERSION || "0.1.346").trim();

const SERVICE_URLS = {
  chatgpt: "https://chatgpt.com/",
  gptpro: "https://chatgpt.com/",
  notebooklm: "https://chatgpt.com/",
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
  elevenlabs: "https://elevenlabs.io/app",
  "envato-elements": "https://elements.envato.com/",
  gamma: "https://gamma.app/",
  monica: "https://monica.im/",
  semrush: "https://www.semrush.com/",
};

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
    // Try to list from API (this endpoint may not exist yet)
    const data = await api("/v1/services");
    if (data.services) {
      log("Available services:");
      for (const s of data.services) {
        log(`  ${s.id || s.serviceId}  ${s.name || ""}`);
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
      const cookies = await exportService(serviceId);
      if (cookies.length > 0) {
        await writeCookieFiles(serviceId, cookies);
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

  return cookies;
}

async function writeCookieFiles(serviceId, cookies) {
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
  await writeFile(serviceFile, JSON.stringify(serviceData, null, 2));

  // 2. Split by domain for import-cookies-to-chrome.sh
  const byDomain = {};
  for (const c of serviceData.cookies) {
    const dom = String(c.domain).replace(/^\./, "");
    if (!byDomain[dom]) byDomain[dom] = [];
    byDomain[dom].push(c);
  }
  for (const [dom, domCookies] of Object.entries(byDomain)) {
    const domFile = join(serviceDir, `${dom}.json`);
    await writeFile(domFile, JSON.stringify(domCookies, null, 2));
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

// ── main ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "";
  const rest = args.slice(1);

  const chromeFlag = rest.includes("--chrome") || process.env.IMPORT_TO_CHROME === "1";
  const serviceArgs = rest.filter((a) => !a.startsWith("--"));

  switch (command) {
    case "login":
      await cmdLogin();
      break;
    case "status":
      await cmdStatus();
      break;
    case "logout":
      await cmdLogout();
      break;
    case "services":
      await cmdServices();
      break;
    case "export":
      await cmdExport(serviceArgs, chromeFlag);
      break;
    default:
      console.log(`CentriX API v2 · ${APP_VERSION} (${API_BASE})`);
      console.log();
      console.log("Commands:");
      console.log("  login                 OTP login");
      console.log("  status                Check session");
      console.log("  services              List available services");
      console.log("  export <svc...>       Export cookies (chatgpt, gptpro, claude, ...)");
      console.log("  export all            Export all services");
      console.log("  export <svc> --chrome Also inject into Chrome");
      console.log("  logout                Clear session");
      console.log();
      console.log("Env:");
      console.log(`  CENTRIX_V2_API_URL    ${API_BASE}`);
      console.log(`  CENTRIX_V2_SESSION    ${SESSION_FILE}`);
      console.log(`  CENTRIX_OUT_DIR       ${OUT_DIR}`);
      console.log(`  CENTRIX_APP_VERSION   ${APP_VERSION}`);
      break;
  }
}

main().catch((e) => {
  warn(e.message || e);
  process.exit(1);
});
