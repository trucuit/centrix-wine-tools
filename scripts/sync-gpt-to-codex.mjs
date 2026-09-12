#!/usr/bin/env node

/**
 * sync-gpt-to-codex.mjs
 * Extracts active ChatGPT session token from Chrome profile (.chrome-cookie-profile)
 * and injects it into ~/.codex/auth.json to authenticate OpenAI Codex CLI.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";

const CDP_PORT = process.env.CHROME_DEBUG_PORT || 9222;
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const AUTH_FILE = join(CODEX_HOME, "auth.json");
const CHROME_PROFILE_DIR = process.env.CENTRIX_CHROME_PROFILE
  || resolve(process.cwd(), ".chrome-cookie-profile");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function isCdpReady(port) {
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    return Boolean(version?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

async function launchChrome(port, profileDir) {
  const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chromeApp)) {
    throw new Error("Google Chrome not found at " + chromeApp);
  }
  console.log(`▸ Starting Chrome with remote debugging on port ${port}...`);
  const cp = spawn(
    chromeApp,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "https://chatgpt.com",
    ],
    { detached: true, stdio: "ignore" }
  );
  cp.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await isCdpReady(port)) return true;
  }
  throw new Error(`Timed out waiting for Chrome CDP on port ${port}`);
}

async function connectWebSocket(wsUrl) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(wsUrl);
    let id = 1;
    const callbacks = new Map();

    ws.onopen = () => {
      resolvePromise({
        call: (method, params = {}) => {
          return new Promise((resolveCall, rejectCall) => {
            const reqId = id++;
            callbacks.set(reqId, { resolve: resolveCall, reject: rejectCall });
            ws.send(JSON.stringify({ id: reqId, method, params }));
          });
        },
        close: () => ws.close(),
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && callbacks.has(msg.id)) {
          const { resolve: cbResolve, reject: cbReject } = callbacks.get(msg.id);
          callbacks.delete(msg.id);
          if (msg.error) cbReject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else cbResolve(msg.result);
        }
      } catch (err) {
        console.error("WS parse error:", err);
      }
    };

    ws.onerror = (err) => rejectPromise(err);
  });
}

async function findOrCreateChatGPTTab(port) {
  let targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  let page = targets.find((t) => t.type === "page" && t.url?.includes("chatgpt.com") && t.webSocketDebuggerUrl);

  if (page) return page;

  // If there's an about:blank or any page, navigate it
  page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    const browserCdp = await connectWebSocket(version.webSocketDebuggerUrl);
    const newTarget = await browserCdp.call("Target.createTarget", { url: "https://chatgpt.com" });
    browserCdp.close();
    await sleep(2000);
    targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    page = targets.find((t) => t.id === newTarget.targetId) || targets.find((t) => t.type === "page");
  } else {
    const pageCdp = await connectWebSocket(page.webSocketDebuggerUrl);
    await pageCdp.call("Page.navigate", { url: "https://chatgpt.com" });
    pageCdp.close();
    await sleep(2000);
  }

  return page;
}

async function extractSessionFromTab(page) {
  const cdp = await connectWebSocket(page.webSocketDebuggerUrl);
  try {
    // Retry evaluate /api/auth/session up to 5 times (in case page is loading)
    for (let attempt = 1; attempt <= 5; attempt++) {
      const evalRes = await cdp.call("Runtime.evaluate", {
        expression: `(async () => {
          try {
            const res = await fetch("/api/auth/session");
            if (!res.ok) return { error: "HTTP " + res.status };
            return await res.json();
          } catch (e) {
            return { error: e.message };
          }
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });

      const val = evalRes?.result?.value;
      if (val?.accessToken) {
        return val;
      }
      if (attempt < 5) await sleep(1500);
    }
    throw new Error("Could not retrieve session from ChatGPT (is the session logged in?)");
  } finally {
    cdp.close();
  }
}

async function main() {
  console.log("=== Sync ChatGPT Pro Session to Codex CLI ===");

  // 1. Ensure Chrome with CDP is running
  const ready = await isCdpReady(CDP_PORT);
  if (!ready) {
    await launchChrome(CDP_PORT, CHROME_PROFILE_DIR);
  } else {
    console.log(`▸ Chrome remote debugging active on port ${CDP_PORT}`);
  }

  // 2. Locate ChatGPT tab
  const tab = await findOrCreateChatGPTTab(CDP_PORT);
  if (!tab?.webSocketDebuggerUrl) {
    throw new Error("Could not find or open ChatGPT tab in Chrome.");
  }

  // 3. Extract Session
  console.log("▸ Extracting session and access token from Chrome tab...");
  const session = await extractSessionFromTab(tab);
  const accessToken = session.accessToken;
  const user = session.user || {};
  const account = session.account || {};
  const accountId = account.id || "c8602267-b073-440d-a47f-b738cf68655d";

  console.log(`  User:  ${user.name || "Unknown"} (${user.email || "no-email"})`);
  console.log(`  Plan:  ${account.planType || "standard"}`);
  console.log(`  Expires: ${session.expires || "unknown"}`);

  // 4. Prepare auth.json payload
  const authPayload = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: accessToken,
      access_token: accessToken,
      refresh_token: "",
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };

  // 5. Write to ~/.codex/auth.json
  await mkdir(CODEX_HOME, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(authPayload, null, 2), { mode: 0o600 });
  console.log(`✅ Saved credentials → ${AUTH_FILE}`);

  // 6. Verify with codex login status
  try {
    const statusOut = execSync("codex login status", { encoding: "utf8" }).trim();
    console.log(`▸ Codex CLI Status: ${statusOut}`);
  } catch (err) {
    console.warn("▸ Warning checking codex login status:", err.message);
  }

  console.log("\n🎉 Ready! You can now run `codex` in your terminal.");
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
