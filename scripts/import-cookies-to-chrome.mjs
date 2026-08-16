#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { access, readFile, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stdin as input, stdout as output } from "node:process";

const SERVICE_CONFIG = {
  chatgpt: { url: "https://chatgpt.com", domains: ["chatgpt.com", "openai.com"] },
  notebooklm: { url: "https://chatgpt.com", domains: ["chatgpt.com", "openai.com", "notebooklm.google.com", "google.com"] },
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

/**
 * Load .centrix-services-cache.json and override SERVICE_CONFIG URLs.
 * Pool slots get reassigned (e.g. notebooklm → chatgpt.com), so the cache
 * written by the API MJS is the source of truth for target URLs.
 */
async function applyCacheOverrides(cookiesDir) {
  const cacheFile = resolve(cookiesDir, "..", ".centrix-services-cache.json");
  try {
    const raw = JSON.parse(await readFile(cacheFile, "utf8"));
    for (const svc of raw.services || []) {
      if (!svc.id || !svc.url) continue;
      const targetUrl = svc.url.replace(/\/$/, "");
      let rootHost = "";
      try {
        const host = new URL(targetUrl).hostname;
        rootHost = host.replace(/^www\./, "");
      } catch {}
      if (SERVICE_CONFIG[svc.id]) {
        SERVICE_CONFIG[svc.id].url = targetUrl;
        if (targetUrl.includes("chatgpt.com")) {
          SERVICE_CONFIG[svc.id].domains = ["chatgpt.com", "openai.com"];
        } else if (rootHost && !SERVICE_CONFIG[svc.id].domains.some((d) => rootHost.endsWith(d) || d.endsWith(rootHost))) {
          SERVICE_CONFIG[svc.id].domains = [rootHost];
        }
      } else if (rootHost) {
        // New service from cache — add with URL-derived domain
        SERVICE_CONFIG[svc.id] = { url: targetUrl, domains: [rootHost] };
      }
    }
  } catch { /* cache missing or invalid — use hardcoded defaults */ }
}

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
  const name = String(cookie.name);
  const rawDomain = String(cookie.domain);
  // __Host- cookies must be host-only (no Domain attribute / no leading dot).
  const hostOnly = Boolean(cookie.hostOnly) || name.startsWith("__Host-");
  const domain = hostOnly ? rawDomain.replace(/^\./, "") : rawDomain;
  const result = {
    name, value: String(cookie.value), domain,
    path: cookie.path || "/", secure: Boolean(cookie.secure) || name.startsWith("__Secure-") || name.startsWith("__Host-"),
    httpOnly: Boolean(cookie.httpOnly), hostOnly,
  };
  const sameSiteRaw = String(cookie.sameSite || "").toLowerCase();
  const sameSite = { no_restriction: "None", none: "None", lax: "Lax", strict: "Strict" }[sameSiteRaw];
  // "unspecified" / empty → omit (Chrome default); never send invalid enum values.
  if (sameSite) result.sameSite = sameSite;
  if (!cookie.session && Number.isFinite(expires) && expires > 0) result.expires = expires;
  // Chrome Network.setCookie requires hasCrossSiteAncestor on partitionKey.
  if (cookie.partitionKey?.topLevelSite) {
    result.partitionKey = {
      topLevelSite: String(cookie.partitionKey.topLevelSite),
      hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
    };
  }
  return result;
}

/** True when Chrome rejects browser-level Storage cookie APIs (seen on Chrome 150+). */
export function isBrowserContextUnsupported(error) {
  return /Browser context management is not supported/i.test(String(error?.message || error || ""));
}

/** Map normalized cookie → Network.setCookie params. */
export function toNetworkSetCookieParams(cookie) {
  const path = cookie.path || "/";
  const params = {
    name: cookie.name,
    value: cookie.value,
    path,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  // Host-only / __Host- : CDP needs url, not Domain attribute.
  if (cookie.hostOnly) {
    const host = String(cookie.domain || "").replace(/^\./, "");
    params.url = `https://${host}${path.startsWith("/") ? path : `/${path}`}`;
  } else {
    params.domain = cookie.domain;
  }
  if (cookie.sameSite) params.sameSite = cookie.sameSite;
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) params.expires = cookie.expires;
  if (cookie.partitionKey?.topLevelSite) {
    params.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite,
      hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
    };
  }
  return params;
}

/** Map normalized cookie → Storage.Cookie for Storage.setCookies. */
export function toStorageCookie(cookie) {
  const params = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? String(cookie.domain).replace(/^\./, "") : cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (cookie.sameSite) params.sameSite = cookie.sameSite;
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) params.expires = cookie.expires;
  if (cookie.partitionKey?.topLevelSite) {
    params.partitionKey = {
      topLevelSite: cookie.partitionKey.topLevelSite,
      hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
    };
  }
  return params;
}

function cookieIdentityKey(cookie) {
  return `${cookie.domain}\t${cookie.path || "/"}\t${cookie.name}`;
}

/**
 * Prefer Storage.setCookies (browser target). On Chrome builds that return
 * "Browser context management is not supported", fall back to per-cookie
 * Network.setCookie on a page target + Network.getAllCookies verify.
 */
/**
 * Wipe every stored cookie under the service domain roots before inject.
 * Stale twins (old usc_*, session-token vs .0/.1) stack into HTTP 431 and mixed accounts.
 * Chrome 150: Storage.deleteCookies is missing — use Network.deleteCookies on a page target.
 */
export async function clearCookiesForDomains(browserCdp, domainRoots, { port } = {}) {
  const roots = [...new Set((domainRoots || []).map((d) => String(d).replace(/^\./, "").toLowerCase()).filter(Boolean))];
  if (!roots.length) return { cleared: 0 };
  let stored = [];
  try {
    stored = (await browserCdp.call("Storage.getCookies")).cookies || [];
  } catch {
    return { cleared: 0 };
  }
  const targets = stored.filter((cookie) => domainAllowed(cookie.domain, roots));
  if (!targets.length) return { cleared: 0 };

  const pageCdp = await connectPageSession(port, browserCdp);
  let cleared = 0;
  try {
    await pageCdp.call("Network.enable");
    for (const cookie of targets) {
      const params = {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path || "/",
      };
      if (cookie.partitionKey?.topLevelSite) {
        params.partitionKey = {
          topLevelSite: String(cookie.partitionKey.topLevelSite),
          hasCrossSiteAncestor: Boolean(cookie.partitionKey.hasCrossSiteAncestor),
        };
      }
      try {
        await pageCdp.call("Network.deleteCookies", params);
        cleared += 1;
      } catch {
        // best-effort per cookie
      }
    }
  } finally {
    pageCdp.close();
  }
  return { cleared };
}

export async function injectCookies(browserCdp, cookies, { port, domainRoots = [] }) {
  const roots = domainRoots.length
    ? domainRoots
    : [...new Set(cookies.map((c) => String(c.domain || "").replace(/^\./, "").split(".").slice(-2).join(".")))];
  const { cleared } = await clearCookiesForDomains(browserCdp, roots, { port });
  const storageCookies = cookies.map(toStorageCookie);
  try {
    await browserCdp.call("Storage.setCookies", { cookies: storageCookies });
    const stored = (await browserCdp.call("Storage.getCookies")).cookies || [];
    return { method: "Storage", stored, cleared };
  } catch (error) {
    if (!isBrowserContextUnsupported(error)) throw error;
  }

  const pageCdp = await connectPageSession(port, browserCdp);
  try {
    await pageCdp.call("Network.enable");
    let failed = 0;
    for (const cookie of cookies) {
      const result = await pageCdp.call("Network.setCookie", toNetworkSetCookieParams(cookie));
      if (!result?.success) failed += 1;
    }
    if (failed) {
      throw new Error(`Network.setCookie failed for ${failed}/${cookies.length} cookies.`);
    }
    const stored = (await pageCdp.call("Network.getAllCookies")).cookies || [];
    return { method: "Network", stored, cleared };
  } finally {
    pageCdp.close();
  }
}

/** Open/reuse any page target and return a CDP session (for Network domain). */
async function connectPageSession(port, browserCdp) {
  let targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) {
    await browserCdp.call("Target.createTarget", { url: "about:blank" });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) break;
    }
  }
  if (!page?.webSocketDebuggerUrl) {
    throw new Error("Could not open a page target for Network cookie injection.");
  }
  return connectCdp(page.webSocketDebuggerUrl);
}

/** Dump / backup noise that must not be mixed into a live inject. */
export function isCookieSourceNoise(name) {
  const base = String(name || "");
  return (
    base.endsWith(".full.json")
    || /cookie-editor/i.test(base)
    || /^cookies-dump-/i.test(base)
    || /\.bak(\.|$)/i.test(base)
    || base.endsWith(".storage.json")
    || /-\d+\./.test(base)
    || base.endsWith(".export.json")
  );
}

/**
 * True when filename is a host-scoped export like `auth.openai.com.json`
 * or `chatgpt.com.json` for one of the service allowlisted roots.
 */
export function isHostScopedCookieFile(name, allowedDomains) {
  if (!name?.endsWith(".json") || isCookieSourceNoise(name)) return false;
  const host = name.slice(0, -".json".length).toLowerCase();
  // service/j2team/numbered dumps are not host files
  if (!host.includes(".") || host.endsWith(".j2team") || /-\d+$/.test(host)) return false;
  return domainAllowed(host, allowedDomains);
}

/**
 * Pick which JSON files to read for inject.
 * service mode prefers host-scoped files (chatgpt.com.json, auth.openai.com.json)
 * so bulk dumps with a *different* session cannot overwrite auth cookies.
 */
export function selectCookieSourceFiles(allJson, allowedDomains, mode = "service", serviceName = "") {
  if (mode === "full") {
    if (serviceName && allJson.includes(`${serviceName}.full.json`)) {
      return [`${serviceName}.full.json`];
    }
    const fullFiles = allJson
      .filter((name) => name.endsWith(".full.json") && !/-\d+\.full\.json$/.test(name))
      .sort();
    return fullFiles.length ? fullFiles : allJson.filter((name) => name.endsWith(".full.json")).sort();
  }
  const candidates = allJson
    .filter((name) => name.endsWith(".json") && !isCookieSourceNoise(name))
    .sort();
  const hostFiles = candidates.filter((name) => isHostScopedCookieFile(name, allowedDomains));
  // Prefer host-scoped only when present — avoids mixing non-matching host dumps
  return hostFiles.length ? hostFiles : candidates;
}

/**
 * Load cookies from a service folder.
 * @param {"service"|"full"} mode
 *   - service (default): host-scoped JSON when available (safe inject)
 *   - full: only *.full.json (raw partition dump; still domain-allowlisted)
 */
export async function loadServiceCookies(serviceDir, allowedDomains, mode = "service", serviceName = "") {
  if (mode !== "service" && mode !== "full") {
    throw new Error(`Invalid cookie mode: ${mode}. Use "service" or "full".`);
  }
  const allJson = (await readdir(serviceDir)).filter((name) => name.endsWith(".json"));
  const files = selectCookieSourceFiles(allJson, allowedDomains, mode, serviceName);
  const cookies = [];
  const rejected = { invalid: 0, duplicate: 0 };
  const seen = new Map(); // key → index in cookies
  for (const file of files) {
    const parsed = JSON.parse(await readFile(resolve(serviceDir, file), "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed.cookies;
    if (!Array.isArray(list)) continue;
    for (const rawCookie of list) {
      const cookie = normalizeCookie(rawCookie, allowedDomains);
      if (!cookie) { rejected.invalid += 1; continue; }
      const key = `${cookie.domain}\t${cookie.path}\t${cookie.name}\t${cookie.partitionKey?.topLevelSite || ""}`;
      if (seen.has(key)) {
        // Prefer the cookie that expires later (fresher session).
        const prevIndex = seen.get(key);
        const prev = cookies[prevIndex];
        const prevExp = Number(prev.expires) || 0;
        const nextExp = Number(cookie.expires) || 0;
        if (nextExp > prevExp) cookies[prevIndex] = cookie;
        rejected.duplicate += 1;
        continue;
      }
      seen.set(key, cookies.length);
      cookies.push(cookie);
    }
  }

  // NextAuth chunk conflict resolution: if chunked token (.0) exists for a domain,
  // remove unchunked single token to prevent server auth rejection.
  const hasChunkedSessionToken = new Set(
    cookies
      .filter((c) => c.name.endsWith(".0"))
      .map((c) => `${c.domain}\t${c.name.slice(0, -2)}`)
  );
  if (hasChunkedSessionToken.size > 0) {
    const filteredCookies = cookies.filter((c) => {
      const key = `${c.domain}\t${c.name}`;
      if (hasChunkedSessionToken.has(key)) {
        rejected.duplicate += 1;
        return false;
      }
      return true;
    });
    cookies.length = 0;
    cookies.push(...filteredCookies);
  }

  return { cookies, rejected, files: files.length, mode, sourceFiles: files };
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
    mode: "service", // "service" | "full"
    modeExplicit: false,
    pick: false,
    cookiesDir: resolve(process.env.CENTRIX_COOKIES_DIR || "cookies"),
    profileDir: resolve(process.env.CENTRIX_CHROME_PROFILE || ".chrome-cookie-profile"),
    port: Number(process.env.CENTRIX_CHROME_PORT || 9222),
    open: true, json: false, dryRun: false,
  };
  const args = [...argv];
  // Positional service only if first token is not a flag
  if (args[0] && !args[0].startsWith("-")) {
    options.service = args.shift();
  }
  while (args.length) {
    const flag = args.shift();
    if (flag === "--cookies-dir") options.cookiesDir = resolve(args.shift() || "");
    else if (flag === "--profile-dir") options.profileDir = resolve(args.shift() || "");
    else if (flag === "--port") options.port = Number(args.shift());
    else if (flag === "--chrome") options.chrome = resolve(args.shift() || "");
    else if (flag === "--mode") {
      const mode = String(args.shift() || "").toLowerCase();
      if (mode !== "service" && mode !== "full") throw new Error(`Invalid --mode ${mode}. Use service or full.`);
      options.mode = mode;
      options.modeExplicit = true;
    }
    else if (flag === "--full") { options.mode = "full"; options.modeExplicit = true; }
    else if (flag === "--mode-service") { options.mode = "service"; options.modeExplicit = true; }
    else if (flag === "--pick" || flag === "-i" || flag === "--interactive") options.pick = true;
    else if (flag === "--no-open") options.open = false;
    else if (flag === "--json") options.json = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "-h" || flag === "--help") options.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

async function pathExists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

/** List supported services that have cookie data under cookiesDir. */
export async function listImportableServices(cookiesDir) {
  const ids = Object.keys(SERVICE_CONFIG);
  const rows = [];
  for (const id of ids) {
    const config = SERVICE_CONFIG[id];
    const source = config.source || id;
    const dir = resolve(cookiesDir, source);
    let hasService = false;
    let hasFull = false;
    try {
      const names = await readdir(dir);
      hasService = names.some((n) => n.endsWith(".json") && !n.endsWith(".full.json"));
      hasFull = names.some((n) => n.endsWith(".full.json"));
    } catch {
      // missing folder
    }
    rows.push({
      id,
      source,
      url: config.url,
      hasService,
      hasFull,
      available: hasService || hasFull,
    });
  }
  return rows;
}

function printServiceMenu(rows) {
  console.log("");
  console.log("=== Import cookies → Chrome ===");
  console.log("");
  console.log("Chọn service:");
  console.log("────────────────────────────────────────────────────────────");
  rows.forEach((row, index) => {
    const n = String(index + 1).padStart(2, " ");
    const marks = [
      row.hasService ? "service✓" : "service✗",
      row.hasFull ? "full✓" : "full✗",
    ].join(" ");
    const alias = row.source !== row.id ? `  (source: ${row.source})` : "";
    console.log(`  ${n}) ${row.id.padEnd(18)} ${marks}  ${row.url}${alias}`);
  });
  console.log("────────────────────────────────────────────────────────────");
  console.log("  q) quit");
  console.log("");
}

function printModeMenu() {
  console.log("");
  console.log("Chọn cookie source:");
  console.log("  1) service  — scoped JSON (an toàn inject, mặc định)");
  console.log("  2) full     — *.full.json (raw partition dump)");
  console.log("");
}

async function promptLine(rl, question) {
  const answer = await rl.question(question);
  return String(answer || "").trim();
}

/**
 * Interactive: pick service id + mode (service|full).
 * Returns { service, mode } or null if cancelled.
 */
export async function interactivePick(cookiesDir, { needService = true, needMode = true } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Interactive pick requires a TTY. Pass <service> and optionally --mode service|full.");
  }
  const rl = createInterface({ input, output });
  try {
    let service = "";
    let mode = "service";

    if (needService) {
      const rows = await listImportableServices(cookiesDir);
      if (!rows.some((r) => r.available)) {
        throw new Error(`No cookie folders under ${cookiesDir}. Export first (export-pick-service / export-centrix-api).`);
      }
      printServiceMenu(rows);
      while (!service) {
        const ans = await promptLine(rl, "Chọn service [số hoặc id]: ");
        if (!ans || ans === "q" || ans === "Q") return null;
        if (/^\d+$/.test(ans)) {
          const idx = Number(ans) - 1;
          if (idx >= 0 && idx < rows.length) {
            service = rows[idx].id;
            if (!rows[idx].available) {
              console.log(`  ! ${service}: chưa có cookie folder — vẫn tiếp tục nếu bạn chắc.`);
            }
          } else {
            console.log("  Số không hợp lệ.");
          }
        } else if (SERVICE_CONFIG[ans]) {
          service = ans;
        } else {
          console.log(`  Unknown service: ${ans}. Supported: ${Object.keys(SERVICE_CONFIG).join(", ")}`);
        }
      }
    }

    if (needMode) {
      printModeMenu();
      while (true) {
        const ans = await promptLine(rl, "Chọn mode [1/service, 2/full] (Enter = service): ");
        if (!ans || ans === "1" || ans === "s" || ans === "service") { mode = "service"; break; }
        if (ans === "2" || ans === "f" || ans === "full") { mode = "full"; break; }
        if (ans === "q" || ans === "Q") return null;
        console.log("  Chọn 1 (service) hoặc 2 (full).");
      }
    }

    console.log(`→ service=${service || "(set later)"}  mode=${mode}`);
    console.log("");
    return { service, mode };
  } finally {
    rl.close();
  }
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
  const host = new URL(targetUrl).hostname;

  // Retry outer loop: page may redirect or reload after cookie inject (e.g. DeepSeek sign_in → chat).
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 1000;

  for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
    // 1. Find the page target
    let target;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl && (() => { try { return new URL(candidate.url).hostname === host; } catch { return false; } })());
      if (target) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!target) throw new Error(`Could not find a page for ${targetUrl} to import localStorage.`);

    // 2. Wait for page to be at least interactive (handles fresh tab / redirect)
    const pageCdp = await connectCdp(target.webSocketDebuggerUrl);
    try {
      await pageCdp.call("Page.enable");
      for (let waitAttempt = 0; waitAttempt < 30; waitAttempt += 1) {
        const readyState = await pageCdp.call("Runtime.evaluate", {
          returnByValue: true,
          expression: "document.readyState",
        });
        const state = readyState.result?.value;
        if (state === "interactive" || state === "complete") break;
        await new Promise((r) => setTimeout(r, 200));
      }

      // 3. Set localStorage
      const serialized = JSON.stringify(JSON.stringify(entries));
      const result = await pageCdp.call("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => { try { const entries = JSON.parse(${serialized}); for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); return Object.keys(entries).filter((key) => localStorage.getItem(key) === entries[key]).length; } catch { return 0; } })()`,
      });
      const applied = Number(result.result?.value || 0);
      if (applied === expectedKeys.length) {
        await pageCdp.call("Page.reload", { ignoreCache: false });
        return applied;
      }

      // Verification failed — retry after delay (page may be mid-redirect)
      if (retry < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw new Error(`localStorage verification failed: expected ${expectedKeys.length}, found ${applied} (after ${MAX_RETRIES} retries).`);
    } finally { pageCdp.close(); }
  }
  return 0;
}

function usage() {
  return `Usage: ./import-cookies-to-chrome.sh [service] [options]
       ./import-cookies-to-chrome.sh              # interactive menu (TTY)
       ./import-cookies-to-chrome.sh --pick       # force interactive menu

Cookie source:
  --mode service|full   service = scoped JSON (default, safe inject)
                        full    = only *.full.json (raw dump, still domain-filtered)
  --mode-service        same as --mode service
  --full                same as --mode full

Options:
  -i, --pick            Interactive: chọn service + mode
  --cookies-dir <path>  Cookie root (default: ./cookies)
  --profile-dir <path>  Isolated Chrome profile
  --port <number>       CDP port (default: 9222)
  --chrome <path>       Chrome executable
  --no-open             Do not open/reload service
  --dry-run             Validate without starting Chrome
  --json                Machine-readable result

Examples:
  ./import-cookies-to-chrome.sh                 # menu chọn service + mode
  ./import-cookies-to-chrome.sh grok
  ./import-cookies-to-chrome.sh grok --full
  ./import-cookies-to-chrome.sh chatgpt --mode full --dry-run`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); process.exitCode = 0; return; }

  // Override SERVICE_CONFIG URLs from the live services cache
  await applyCacheOverrides(options.cookiesDir);

  const wantInteractive = options.pick || !options.service;
  if (wantInteractive) {
    if (!input.isTTY) {
      console.log(usage());
      process.exitCode = 2;
      return;
    }
    const picked = await interactivePick(options.cookiesDir, {
      needService: !options.service,
      needMode: !options.modeExplicit,
    });
    if (!picked) { console.log("Cancelled."); process.exitCode = 0; return; }
    if (!options.service) options.service = picked.service;
    if (!options.modeExplicit) options.mode = picked.mode;
  }

  if (!options.service) { console.log(usage()); process.exitCode = 2; return; }
  const config = SERVICE_CONFIG[options.service];
  if (!config) throw new Error(`Unsupported service: ${options.service}. Supported: ${Object.keys(SERVICE_CONFIG).join(", ")}`);
  const sourceService = config.source || options.service;
  const serviceDir = resolve(options.cookiesDir, sourceService);
  const loaded = await loadServiceCookies(serviceDir, config.domains, options.mode, sourceService);
  const localStorageEntries = options.mode === "service"
    ? await loadServiceStorage(serviceDir, sourceService)
    : {};
  if (!loaded.cookies.length) {
    const hint = options.mode === "full"
      ? `No valid cookies in ${sourceService}/*.full.json (mode=full).`
      : `No valid cookies found in ${serviceDir} (mode=service).`;
    throw new Error(hint);
  }
  if (options.dryRun) {
    console.log(JSON.stringify({
      service: options.service, sourceService, mode: options.mode, dryRun: true,
      files: loaded.files, sourceFiles: loaded.sourceFiles, cookies: loaded.cookies.length,
      authOpenai: loaded.cookies.filter((c) => String(c.domain).includes("auth.openai")).length,
      localStorageKeys: Object.keys(localStorageEntries).length, rejected: loaded.rejected,
    }, null, options.json ? 0 : 2));
    return;
  }
  const endpoint = await ensureChrome(options);
  const cdp = await connectCdp(endpoint.webSocketDebuggerUrl);
  let action = "not-opened";
  let localStorageApplied = 0;
  try {
    const { method: injectMethod, stored } = await injectCookies(cdp, loaded.cookies, {
      port: options.port,
      domainRoots: config.domains,
    });
    const expected = new Set(loaded.cookies.map((cookie) => cookieIdentityKey(cookie)));
    const storedKeys = new Set(stored.map((cookie) => cookieIdentityKey(cookie)));
    const verified = [...expected].filter((key) => storedKeys.has(key)).length;
    if (verified !== expected.size) {
      throw new Error(`Cookie verification failed: expected ${expected.size}, found ${verified} (via ${injectMethod}).`);
    }
    if (options.open) action = await openOrReload(options.port, config.url, cdp);
    if (options.open && Object.keys(localStorageEntries).length) {
      localStorageApplied = await applyLocalStorage(options.port, config.url, localStorageEntries);
      action = `${action}+storage`;
    }
    console.log(JSON.stringify({
      service: options.service, sourceService, mode: options.mode, imported: expected.size,
      injectMethod, localStorageApplied, files: loaded.files, sourceFiles: loaded.sourceFiles,
      authOpenai: loaded.cookies.filter((c) => String(c.domain).includes("auth.openai")).length,
      rejected: loaded.rejected, action,
      profileDir: options.profileDir, target: config.url,
    }, null, options.json ? 0 : 2));
  } finally { cdp.close(); }
}

const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
