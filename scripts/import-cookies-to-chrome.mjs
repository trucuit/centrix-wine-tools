#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SERVICE_CONFIG = {
  chatgpt: { url: "https://chatgpt.com", domains: ["chatgpt.com", "openai.com"], source: "notebooklm" },
  notebooklm: { url: "https://chatgpt.com", domains: ["chatgpt.com", "openai.com"] },
  claude: { url: "https://claude.ai", domains: ["claude.ai", "anthropic.com"] },
  gemini: { url: "https://gemini.google.com", domains: ["gemini.google.com", "google.com"] },
  perplexity: { url: "https://www.perplexity.ai", domains: ["perplexity.ai"] },
  grok: { url: "https://grok.com", domains: ["grok.com", "x.ai"], source: "grok-heavy" },
  "grok-heavy": { url: "https://grok.com", domains: ["grok.com", "x.ai"] },
  "microsoft-copilot": { url: "https://copilot.microsoft.com", domains: ["copilot.microsoft.com", "microsoft.com", "bing.com"] },
  deepseek: { url: "https://chat.deepseek.com/sign_in", domains: ["deepseek.com"] },
  "envato-elements": { url: "https://elements.envato.com", domains: ["envato.com"] },
  poe: { url: "https://www.capcut.com", domains: ["capcut.com", "poe.com"] },
  gamma: { url: "https://gamma.app", domains: ["gamma.app"] },
  monica: { url: "https://monica.im", domains: ["monica.im"] },
  semrush: { url: "https://www.semrush.com", domains: ["semrush.com", "noxtools.com"] },
};

const DEEPSEEK_STORAGE_KEYS = new Set([
  "userToken",
  "settingsJwt",
  "__appKit_@deepseek/chat_lastSessionValue",
]);

export function domainAllowed(domain, roots) {
  const normalized = String(domain || "").replace(/^\./, "").toLowerCase();
  return roots.some((root) => normalized === root || normalized.endsWith(`.${root}`));
}

export function normalizeCookie(cookie, allowedDomains, now = Date.now() / 1000) {
  if (!cookie?.name || cookie.value == null || !domainAllowed(cookie.domain, allowedDomains)) return null;
  const expires = Number(cookie.expirationDate);
  if (!cookie.session && Number.isFinite(expires) && expires > 0 && expires <= now) return null;
  const result = {
    name: String(cookie.name), value: String(cookie.value), domain: String(cookie.domain),
    path: cookie.path || "/", secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly),
  };
  const sameSite = { no_restriction: "None", none: "None", lax: "Lax", strict: "Strict" }[String(cookie.sameSite || "").toLowerCase()];
  if (sameSite) result.sameSite = sameSite;
  if (!cookie.session && Number.isFinite(expires) && expires > 0) result.expires = expires;
  if (cookie.partitionKey?.topLevelSite) result.partitionKey = cookie.partitionKey;
  return result;
}

export async function loadServiceCookies(serviceDir, allowedDomains) {
  const files = (await readdir(serviceDir)).filter((name) => name.endsWith(".json") && !name.endsWith(".full.json"));
  const cookies = [];
  const rejected = { invalid: 0, duplicate: 0 };
  const seen = new Set();
  for (const file of files) {
    const parsed = JSON.parse(await readFile(resolve(serviceDir, file), "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed.cookies;
    if (!Array.isArray(list)) continue;
    for (const rawCookie of list) {
      const cookie = normalizeCookie(rawCookie, allowedDomains);
      if (!cookie) { rejected.invalid += 1; continue; }
      const key = `${cookie.domain}\t${cookie.path}\t${cookie.name}\t${cookie.partitionKey?.topLevelSite || ""}`;
      if (seen.has(key)) { rejected.duplicate += 1; continue; }
      seen.add(key);
      cookies.push(cookie);
    }
  }
  return { cookies, rejected, files: files.length };
}

export async function loadServiceStorage(serviceDir, service) {
  if (service !== "deepseek") return {};
  try {
    const parsed = JSON.parse(await readFile(resolve(serviceDir, "deepseek.storage.json"), "utf8"));
    if (new URL(parsed.url).origin !== "https://chat.deepseek.com" || typeof parsed.localStorage !== "object") return {};
    return Object.fromEntries(Object.entries(parsed.localStorage).filter(([key, value]) => DEEPSEEK_STORAGE_KEYS.has(key) && typeof value === "string" && value));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    service: "",
    cookiesDir: resolve(process.env.CENTRIX_COOKIES_DIR || "cookies"),
    profileDir: resolve(process.env.CENTRIX_CHROME_PROFILE || ".chrome-cookie-profile"),
    port: Number(process.env.CENTRIX_CHROME_PORT || 9222),
    open: true, json: false, dryRun: false,
  };
  const args = [...argv];
  options.service = args.shift() || "";
  if (options.service === "-h" || options.service === "--help") { options.help = true; options.service = ""; }
  while (args.length) {
    const flag = args.shift();
    if (flag === "--cookies-dir") options.cookiesDir = resolve(args.shift() || "");
    else if (flag === "--profile-dir") options.profileDir = resolve(args.shift() || "");
    else if (flag === "--port") options.port = Number(args.shift());
    else if (flag === "--chrome") options.chrome = resolve(args.shift() || "");
    else if (flag === "--no-open") options.open = false;
    else if (flag === "--json") options.json = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "-h" || flag === "--help") options.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

async function findChrome(explicit) {
  const candidates = [explicit, process.env.CHROME_BIN,
    "/Volumes/m2/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    resolve(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate, fsConstants.X_OK); return candidate; } catch {}
  }
  throw new Error("Google Chrome binary not found. Set CHROME_BIN or pass --chrome <path>.");
}

async function waitForEndpoint(port, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Chrome CDP endpoint did not start on 127.0.0.1:${port}.`);
}

async function ensureChrome(options) {
  try { return await waitForEndpoint(options.port, 1); } catch {}
  const chrome = await findChrome(options.chrome);
  const child = spawn(chrome, [`--user-data-dir=${options.profileDir}`, `--remote-debugging-port=${options.port}`,
    "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "about:blank"],
  { detached: true, stdio: "ignore" });
  child.unref();
  return waitForEndpoint(options.port);
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolveCall, rejectCall } = pending.get(message.id); pending.delete(message.id);
    if (message.error) rejectCall(new Error(message.error.message)); else resolveCall(message.result || {});
  });
  return {
    call(method, params = {}) { return new Promise((resolveCall, rejectCall) => { const id = nextId++; pending.set(id, { resolveCall, rejectCall }); socket.send(JSON.stringify({ id, method, params })); }); },
    close() { socket.close(); },
  };
}

async function openOrReload(port, targetUrl, browserCdp) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const host = new URL(targetUrl).hostname;
  const match = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl && (() => { try { const current = new URL(target.url).hostname; return current === host || current.endsWith(`.${host}`); } catch { return false; } })());
  if (!match) { await browserCdp.call("Target.createTarget", { url: targetUrl }); return "opened"; }
  const pageCdp = await connectCdp(match.webSocketDebuggerUrl);
  try { await pageCdp.call("Page.reload", { ignoreCache: false }); } finally { pageCdp.close(); }
  return "reloaded";
}

async function applyLocalStorage(port, targetUrl, entries) {
  const expectedKeys = Object.keys(entries);
  if (!expectedKeys.length) return 0;
  let target;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const host = new URL(targetUrl).hostname;
    target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl && (() => { try { return new URL(candidate.url).hostname === host; } catch { return false; } })());
    if (target) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!target) throw new Error(`Could not find a page for ${targetUrl} to import localStorage.`);
  const pageCdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    const serialized = JSON.stringify(JSON.stringify(entries));
    const result = await pageCdp.call("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => { const entries = JSON.parse(${serialized}); for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); return Object.keys(entries).filter((key) => localStorage.getItem(key) === entries[key]).length; })()`,
    });
    const applied = Number(result.result?.value || 0);
    if (applied !== expectedKeys.length) throw new Error(`localStorage verification failed: expected ${expectedKeys.length}, found ${applied}.`);
    await pageCdp.call("Page.reload", { ignoreCache: false });
    return applied;
  } finally { pageCdp.close(); }
}

function usage() {
  return `Usage: ./import-cookies-to-chrome.sh <service> [options]\n\nOptions:\n  --cookies-dir <path>  Cookie root (default: ./cookies)\n  --profile-dir <path>  Isolated Chrome profile\n  --port <number>       CDP port (default: 9222)\n  --chrome <path>       Chrome executable\n  --no-open             Do not open/reload service\n  --dry-run             Validate without starting Chrome\n  --json                Machine-readable result`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.service) { console.log(usage()); process.exitCode = options.help ? 0 : 2; return; }
  const config = SERVICE_CONFIG[options.service];
  if (!config) throw new Error(`Unsupported service: ${options.service}. Supported: ${Object.keys(SERVICE_CONFIG).join(", ")}`);
  const sourceService = config.source || options.service;
  const serviceDir = resolve(options.cookiesDir, sourceService);
  const loaded = await loadServiceCookies(serviceDir, config.domains);
  const localStorageEntries = await loadServiceStorage(serviceDir, sourceService);
  if (!loaded.cookies.length) throw new Error(`No valid cookies found in ${serviceDir}.`);
  if (options.dryRun) { console.log(JSON.stringify({ service: options.service, sourceService, dryRun: true, files: loaded.files, cookies: loaded.cookies.length, localStorageKeys: Object.keys(localStorageEntries).length, rejected: loaded.rejected }, null, options.json ? 0 : 2)); return; }
  const endpoint = await ensureChrome(options);
  const cdp = await connectCdp(endpoint.webSocketDebuggerUrl);
  let action = "not-opened";
  let localStorageApplied = 0;
  try {
    await cdp.call("Storage.setCookies", { cookies: loaded.cookies });
    const stored = (await cdp.call("Storage.getCookies")).cookies || [];
    const expected = new Set(loaded.cookies.map((cookie) => `${cookie.domain}\t${cookie.path}\t${cookie.name}`));
    const storedKeys = new Set(stored.map((cookie) => `${cookie.domain}\t${cookie.path}\t${cookie.name}`));
    const verified = [...expected].filter((key) => storedKeys.has(key)).length;
    if (verified !== expected.size) throw new Error(`Cookie verification failed: expected ${expected.size}, found ${verified}.`);
    if (options.open) action = await openOrReload(options.port, config.url, cdp);
    if (options.open && Object.keys(localStorageEntries).length) {
      localStorageApplied = await applyLocalStorage(options.port, config.url, localStorageEntries);
      action = `${action}+storage`;
    }
    console.log(JSON.stringify({ service: options.service, sourceService, imported: expected.size, localStorageApplied, files: loaded.files, rejected: loaded.rejected, action, profileDir: options.profileDir, target: config.url }, null, options.json ? 0 : 2));
  } finally { cdp.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
