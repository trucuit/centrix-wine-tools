"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const logPath = process.env.CLAUDE_HOOK_LOG || path.join("/tmp", "claude-electron-hook.log");
const statePath = process.env.CLAUDE_HOOK_STATE || path.join("/tmp", "claude-electron-hook-state.json");
const commandPath = process.env.CLAUDE_HOOK_COMMAND || path.join("/tmp", "claude-electron-hook-command.json");
const commandResultPath = process.env.CLAUDE_HOOK_COMMAND_RESULT || path.join("/tmp", "claude-electron-hook-command-result.json");

const claudeCodeEnvKeys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"];
const syncedCodeAuthScope = "user:inference user:profile user:sessions:claude_code";
const syncedCodeAuthConfig = {
  apiHost: "https://api.anthropic.com",
  clientId: "a473d7bb-17ac-43a7-abc0-a1343d7c2805",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scope: syncedCodeAuthScope,
  cookieUrl: "https://claude.ai",
};

function append(event) {
  try {
    fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...event })}\n`);
  } catch {}
}

function getSyncedCodeAuthState() {
  if (!global.__CLAUDE_SYNCED_CODE_AUTH__) {
    global.__CLAUDE_SYNCED_CODE_AUTH__ = {
      status: "idle",
      token: null,
      expiresAt: null,
      lastUpdatedAt: null,
      lastError: null,
      metadata: null,
      refreshInFlight: null,
      refreshTimer: null,
    };
  }
  return global.__CLAUDE_SYNCED_CODE_AUTH__;
}

function previewSecret(value) {
  if (typeof value !== "string" || !value) return null;
  if (value.length <= 12) return "[redacted]";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sanitizeCommandValue(value) {
  if (typeof value === "string") {
    if (value.length > 8192) {
      return `${value.slice(0, 8192)}...[truncated ${value.length - 8192} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCommandValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const nextValue = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(token|authorization|cookie|sessionkey)/i.test(key)) {
      nextValue[key] = "[redacted]";
    } else {
      nextValue[key] = sanitizeCommandValue(item);
    }
  }
  return nextValue;
}

function getSyncedCodeAuthSnapshot() {
  const state = getSyncedCodeAuthState();
  return {
    status: state.status,
    expiresAt: state.expiresAt,
    lastUpdatedAt: state.lastUpdatedAt,
    lastError: state.lastError,
    metadata: state.metadata ? sanitizeCommandValue(state.metadata) : null,
    tokenPreview: previewSecret(state.token),
  };
}

function getSyncedCodeAuthSecretSnapshot() {
  const state = getSyncedCodeAuthState();
  return {
    status: state.status,
    expiresAt: state.expiresAt,
    lastUpdatedAt: state.lastUpdatedAt,
    lastError: state.lastError,
    metadata: state.metadata ? sanitizeCommandValue(state.metadata) : null,
    token: state.token || null,
    apiHost: syncedCodeAuthConfig.apiHost,
    scope: syncedCodeAuthScope,
  };
}

function writeState(extra = {}) {
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          pid: process.pid,
          syncedCodeAuth: getSyncedCodeAuthSnapshot(),
          ...extra,
        },
        null,
        2,
      ),
    );
  } catch {}
}

function writeCommandResult(extra) {
  try {
    fs.writeFileSync(
      commandResultPath,
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...extra }, null, 2),
    );
  } catch {}
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isSyncedCodeAuthUsable() {
  const state = getSyncedCodeAuthState();
  if (!state.token) return false;
  if (typeof state.expiresAt === "number" && Date.now() >= state.expiresAt) return false;
  return true;
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const raw = crypto.randomBytes(32);
  let state = "";
  for (let index = 0; index < raw.length; index += 1) {
    state += alphabet[raw[index] % alphabet.length];
  }
  return { verifier, challenge, state };
}

async function fetchJson(electron, url, options = {}) {
  const response = await electron.net.fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: typeof response.headers?.entries === "function"
      ? Object.fromEntries(response.headers.entries())
      : {},
    text,
    json,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryOAuthResponse(response) {
  if (!response) return true;
  if (response.ok) return false;
  return response.status >= 500 || response.status === 429;
}

async function fetchJsonWithRetry(electron, url, options = {}, retryLabel = "request") {
  let lastResponse = null;
  let lastError = null;
  const delays = [0, 800, 1800, 3200];

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const response = await fetchJson(electron, url, options);
      lastResponse = response;
      if (!shouldRetryOAuthResponse(response) || attempt === delays.length - 1) {
        return response;
      }
      append({ type: "oauth_retry", label: retryLabel, attempt: attempt + 1, status: response.status, preview: response.text.slice(0, 160) });
    } catch (error) {
      lastError = error;
      append({ type: "oauth_retry_error", label: retryLabel, attempt: attempt + 1, message: String(error) });
      if (attempt === delays.length - 1) throw error;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error(`${retryLabel} failed`);
}

async function getSessionCookiePair(electron) {
  const cookies = electron.session.defaultSession.cookies;
  const [orgCookies, sessionCookies] = await Promise.all([
    cookies.get({ name: "lastActiveOrg", url: syncedCodeAuthConfig.cookieUrl }),
    cookies.get({ name: "sessionKey", url: syncedCodeAuthConfig.cookieUrl }),
  ]);
  const orgId = orgCookies[0]?.value || null;
  const sessionKey = sessionCookies[0]?.value || null;
  if (!orgId) throw new Error("missing lastActiveOrg cookie");
  if (!sessionKey) throw new Error("missing sessionKey cookie");
  return { orgId, sessionKey };
}

async function mintSyncedCodeAuthToken(electron) {
  const { orgId, sessionKey } = await getSessionCookiePair(electron);
  const { verifier, challenge, state } = await createPkcePair();

  const authorizeResponse = await fetchJsonWithRetry(
    electron,
    `${syncedCodeAuthConfig.apiHost}/v1/oauth/${orgId}/authorize`,
    {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${sessionKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        response_type: "code",
        client_id: syncedCodeAuthConfig.clientId,
        organization_uuid: orgId,
        redirect_uri: syncedCodeAuthConfig.redirectUri,
        scope: syncedCodeAuthConfig.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
    },
    "oauth_authorize",
  );

  if (!authorizeResponse.ok) {
    throw new Error(`oauth authorize failed: HTTP ${authorizeResponse.status} ${authorizeResponse.text.slice(0, 600)}`);
  }

  const redirectUri = authorizeResponse.json?.redirect_uri;
  const code = redirectUri ? new URL(redirectUri).searchParams.get("code") : null;
  if (!code) {
    throw new Error("oauth authorize response did not include code");
  }

  const tokenResponse = await fetchJsonWithRetry(electron, `${syncedCodeAuthConfig.apiHost}/v1/oauth/token`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      Authorization: `Bearer ${sessionKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: syncedCodeAuthConfig.clientId,
      code,
      redirect_uri: syncedCodeAuthConfig.redirectUri,
      state,
      code_verifier: verifier,
    }),
  }, "oauth_token_exchange");

  if (!tokenResponse.ok) {
    throw new Error(`oauth token exchange failed: HTTP ${tokenResponse.status} ${tokenResponse.text.slice(0, 600)}`);
  }

  const token = tokenResponse.json?.access_token;
  if (typeof token !== "string" || !token) {
    throw new Error("oauth token exchange did not return access_token");
  }

  return {
    token,
    orgId,
    scope: syncedCodeAuthConfig.scope,
    apiHost: syncedCodeAuthConfig.apiHost,
    clientId: syncedCodeAuthConfig.clientId,
    redirectUri: syncedCodeAuthConfig.redirectUri,
    expiresIn: tokenResponse.json?.expires_in ?? null,
  };
}

async function refreshSyncedCodeAuth(electron, reason = "manual") {
  const state = getSyncedCodeAuthState();
  if (state.refreshInFlight) return state.refreshInFlight;

  state.status = "refreshing";
  state.lastError = null;
  writeState({ status: "ready" });

  state.refreshInFlight = (async () => {
    try {
      const minted = await mintSyncedCodeAuthToken(electron);
      state.token = minted.token;
      state.expiresAt = typeof minted.expiresIn === "number"
        ? Date.now() + minted.expiresIn * 1000 - 60_000
        : null;
      state.lastUpdatedAt = new Date().toISOString();
      state.status = "ready";
      state.metadata = {
        reason,
        orgId: minted.orgId,
        scope: minted.scope,
        apiHost: minted.apiHost,
        clientId: minted.clientId,
        redirectUri: minted.redirectUri,
        expiresIn: minted.expiresIn,
      };
      append({
        type: "synced_code_auth_ready",
        reason,
        orgId: minted.orgId,
        scope: minted.scope,
        tokenPreview: previewSecret(minted.token),
      });
    } catch (error) {
      state.status = state.token ? "stale" : "error";
      state.lastError = String(error);
      append({
        type: "synced_code_auth_error",
        reason,
        message: String(error),
        tokenPreview: previewSecret(state.token),
      });
    } finally {
      state.refreshInFlight = null;
      writeState({ status: "ready" });
    }
  })();

  return state.refreshInFlight;
}

function scheduleSyncedCodeAuthRefresh(electron, reason = "scheduled") {
  const state = getSyncedCodeAuthState();
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    refreshSyncedCodeAuth(electron, reason).catch(() => {});
  }, 300);
}

function looksLikeClaudeCodePath(value) {
  return typeof value === "string" &&
    value.includes("/Application Support/Claude/claude-code/") &&
    value.includes("/claude.app/Contents/MacOS/claude");
}

function inspectSpawnTarget(command, args = []) {
  const commandText = typeof command === "string" ? command : "";
  const argList = Array.isArray(args) ? args.filter((item) => typeof item === "string") : [];
  const hits = [commandText, ...argList];
  const directClaudeBinary = hits.some((value) => looksLikeClaudeCodePath(value));
  const wrappedByDisclaimer = commandText.endsWith("/Contents/Helpers/disclaimer") && hits.some((value) => looksLikeClaudeCodePath(value));
  return {
    commandText,
    argList,
    shouldPatch: directClaudeBinary || wrappedByDisclaimer,
  };
}

function sanitizeSpawnOptions(command, args, options) {
  if (isObject(options) && options.__claudeHookSkipSanitize) {
    return { changed: false, options };
  }

  const target = inspectSpawnTarget(command, args);
  if (!target.shouldPatch) {
    return { changed: false, options };
  }

  const nextOptions = isObject(options) ? { ...options } : {};
  const nextEnv = { ...(nextOptions.env || process.env) };
  const removedKeys = [];

  for (const key of claudeCodeEnvKeys) {
    if (Object.prototype.hasOwnProperty.call(nextEnv, key)) {
      removedKeys.push(key);
      delete nextEnv[key];
    }
  }

  if (isSyncedCodeAuthUsable()) {
    const state = getSyncedCodeAuthState();
    nextEnv.CLAUDE_CODE_OAUTH_TOKEN = state.token;
    nextEnv.CLAUDE_CODE_OAUTH_SCOPES = syncedCodeAuthScope;
    nextEnv.ANTHROPIC_BASE_URL = syncedCodeAuthConfig.apiHost;
    nextEnv.ANTHROPIC_API_KEY = "";
    append({
      type: "spawn_env_synced_auth",
      command: target.commandText,
      args: target.argList,
      removedKeys,
      tokenPreview: previewSecret(state.token),
      scope: syncedCodeAuthScope,
    });
  } else {
    const electron = global.__CLAUDE_HOOK_ELECTRON__ || null;
    if (electron) scheduleSyncedCodeAuthRefresh(electron, "spawn_without_token");
    append({
      type: "spawn_env_sanitized",
      command: target.commandText,
      args: target.argList,
      removedKeys,
    });
  }

  nextOptions.env = nextEnv;
  return { changed: true, options: nextOptions };
}

function installChildProcessHooks() {
  if (global.__CLAUDE_ELECTRON_CHILD_PROCESS_HOOKS__) return;
  global.__CLAUDE_ELECTRON_CHILD_PROCESS_HOOKS__ = true;

  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function patchedSpawn(command, args, options) {
    let nextArgs = args;
    let nextOptions = options;
    if (!Array.isArray(nextArgs) && isObject(nextArgs)) {
      nextOptions = nextArgs;
      nextArgs = [];
    }
    const sanitized = sanitizeSpawnOptions(command, nextArgs, nextOptions);
    return originalSpawn.call(this, command, nextArgs, sanitized.options);
  };

  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
    let nextArgs = args;
    let nextOptions = options;
    if (!Array.isArray(nextArgs) && isObject(nextArgs)) {
      nextOptions = nextArgs;
      nextArgs = [];
    }
    const sanitized = sanitizeSpawnOptions(command, nextArgs, nextOptions);
    return originalSpawnSync.call(this, command, nextArgs, sanitized.options);
  };

  const originalExecFile = childProcess.execFile;
  childProcess.execFile = function patchedExecFile(file, args, options, callback) {
    let nextArgs = args;
    let nextOptions = options;
    let nextCallback = callback;

    if (typeof nextArgs === "function") {
      nextCallback = nextArgs;
      nextArgs = [];
      nextOptions = undefined;
    } else if (!Array.isArray(nextArgs)) {
      nextCallback = typeof nextOptions === "function" ? nextOptions : nextCallback;
      nextOptions = nextArgs;
      nextArgs = [];
    } else if (typeof nextOptions === "function") {
      nextCallback = nextOptions;
      nextOptions = undefined;
    }

    const sanitized = sanitizeSpawnOptions(file, nextArgs, nextOptions);
    return originalExecFile.call(this, file, nextArgs, sanitized.options, nextCallback);
  };

  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = function patchedExecFileSync(file, args, options) {
    let nextArgs = args;
    let nextOptions = options;
    if (!Array.isArray(nextArgs) && nextArgs !== undefined) {
      nextOptions = nextArgs;
      nextArgs = [];
    }
    const sanitized = sanitizeSpawnOptions(file, nextArgs || [], nextOptions);
    return originalExecFileSync.call(this, file, nextArgs || [], sanitized.options);
  };
}

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function summarizeView(view, depth = 0) {
  if (!view || depth > 4) return null;
  const result = {
    type: safeCall(() => view.constructor?.name, "unknown"),
    bounds: safeCall(() => view.getBounds?.(), null),
    visible: safeCall(() => view.getVisible?.(), null),
  };
  const wc = safeCall(() => view.webContents, null);
  if (wc) {
    result.webContents = {
      id: safeCall(() => wc.id, null),
      type: safeCall(() => wc.getType?.(), null),
      url: safeCall(() => wc.getURL?.(), null),
      title: safeCall(() => wc.getTitle?.(), null),
    };
  }
  const children = safeCall(() => view.children, null);
  if (Array.isArray(children) && children.length > 0) {
    result.children = children.map((child) => summarizeView(child, depth + 1));
  }
  return result;
}

function snapshotApp(electron) {
  const { BrowserWindow, webContents } = electron;
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  return {
    windows: windows.map((win) => ({
      id: safeCall(() => win.id, null),
      title: safeCall(() => win.getTitle(), null),
      url: safeCall(() => win.webContents.getURL(), null),
      visible: safeCall(() => win.isVisible(), null),
      focused: safeCall(() => win.isFocused(), null),
      bounds: safeCall(() => win.getBounds(), null),
      contentView: safeCall(() => summarizeView(win.contentView), null),
    })),
    webContents: webContents.getAllWebContents().map((wc) => ({
      id: safeCall(() => wc.id, null),
      type: safeCall(() => wc.getType(), null),
      url: safeCall(() => wc.getURL(), null),
      title: safeCall(() => wc.getTitle(), null),
      destroyed: safeCall(() => wc.isDestroyed(), null),
      ownerWindowId: safeCall(() => BrowserWindow.fromWebContents(wc)?.id, null),
      hostWebContentsId: safeCall(() => wc.hostWebContents?.id, null),
      openerId: safeCall(() => wc.opener?.id, null),
    })),
  };
}

function getWebContentsById(electron, id) {
  return electron.webContents.getAllWebContents().find((wc) => wc.id === id) || null;
}

async function runCommand(command, electron) {
  if (command.action === "inspectApp") {
    const result = { ok: true, action: command.action, result: snapshotApp(electron) };
    writeCommandResult(result);
    append({
      type: "command_result",
      action: command.action,
      ok: true,
      summary: {
        windows: result.result.windows.length,
        webContents: result.result.webContents.length,
      },
    });
    return;
  }

  if (command.action === "getSyncedCodeAuthStatus") {
    const result = { ok: true, action: command.action, result: getSyncedCodeAuthSnapshot() };
    writeCommandResult(result);
    append({ type: "command_result", action: command.action, ok: true, result: result.result });
    return;
  }

  if (command.action === "refreshSyncedCodeAuth") {
    append({ type: "command_start", action: command.action });
    try {
      await refreshSyncedCodeAuth(electron, "command");
      const result = { ok: true, action: command.action, result: getSyncedCodeAuthSnapshot() };
      writeCommandResult(result);
      append({ type: "command_result", action: command.action, ok: true, result: result.result });
    } catch (error) {
      const result = { ok: false, action: command.action, error: String(error) };
      writeCommandResult(result);
      append({ type: "command_result", ...result });
    }
    return;
  }

  if (command.action === "getSyncedCodeAuthToken") {
    const result = { ok: true, action: command.action, result: getSyncedCodeAuthSecretSnapshot() };
    writeCommandResult(result);
    append({ type: "command_result", action: command.action, ok: true, result: { ...getSyncedCodeAuthSnapshot(), token: "[redacted]" } });
    return;
  }

  if (command.action === "executeInWebContents") {
    append({ type: "command_start", action: command.action, webContentsId: command.webContentsId });
    const wc = getWebContentsById(electron, Number(command.webContentsId));
    if (!wc) {
      const result = { ok: false, action: command.action, error: "webcontents_not_found", webContentsId: command.webContentsId };
      writeCommandResult(result);
      append({ type: "command_result", ...result });
      return;
    }
    try {
      const commandResult = await wc.executeJavaScript(String(command.script || ""), true);
      const result = {
        ok: true,
        action: command.action,
        webContentsId: wc.id,
        result: sanitizeCommandValue(commandResult),
      };
      writeCommandResult(result);
      append({ type: "command_result", action: command.action, ok: true, webContentsId: wc.id });
    } catch (error) {
      const result = { ok: false, action: command.action, error: String(error), webContentsId: wc.id };
      writeCommandResult(result);
      append({ type: "command_result", ...result });
    }
    return;
  }

  const result = { ok: false, action: command.action, error: "unknown_action" };
  writeCommandResult(result);
  append({ type: "command_result", ...result });
}

function installCommandLoop(electron) {
  if (global.__CLAUDE_ELECTRON_COMMAND_LOOP__) return;
  global.__CLAUDE_ELECTRON_COMMAND_LOOP__ = true;
  let lastMtime = 0;
  append({ type: "command_loop_started", commandPath, commandResultPath });
  setInterval(async () => {
    try {
      if (!fs.existsSync(commandPath)) return;
      const stat = fs.statSync(commandPath);
      if (stat.mtimeMs <= lastMtime) return;
      lastMtime = stat.mtimeMs;
      append({ type: "command_seen", mtimeMs: stat.mtimeMs, commandPath });
      const command = JSON.parse(fs.readFileSync(commandPath, "utf8"));
      await runCommand(command, electron);
    } catch (error) {
      append({ type: "command_error", message: String(error) });
      writeCommandResult({ ok: false, error: String(error) });
    }
  }, 500);
}

function installCookieListener(electron) {
  const ses = electron.session.defaultSession;
  if (!ses || ses.__claudeHookCookieListenerInstalled) return;
  ses.__claudeHookCookieListenerInstalled = true;
  ses.cookies.on("changed", (event, cookie, cause, removed) => {
    if (removed) return;
    if (cookie?.name === "sessionKey" || cookie?.name === "lastActiveOrg") {
      append({ type: "cookie_changed", name: cookie.name, cause });
      scheduleSyncedCodeAuthRefresh(electron, `cookie:${cookie.name}`);
    }
  });
}

function install() {
  if (global.__CLAUDE_ELECTRON_HOOK_INSTALLED__) return;
  global.__CLAUDE_ELECTRON_HOOK_INSTALLED__ = true;

  append({ type: "hook_loaded", argv: process.argv.slice(0, 8), execPath: process.execPath });

  let electron;
  try {
    electron = require("electron");
  } catch (error) {
    append({ type: "hook_skip", reason: "require_electron_failed", message: String(error) });
    return;
  }

  if (!electron.app || !electron.session) {
    append({ type: "hook_skip", reason: "missing_app_or_session" });
    return;
  }

  global.__CLAUDE_HOOK_ELECTRON__ = electron;

  installChildProcessHooks();
  installCommandLoop(electron);

  const onReady = () => {
    writeState({ status: "ready" });
    append({ type: "app_ready" });
    installCookieListener(electron);
    scheduleSyncedCodeAuthRefresh(electron, "app_ready");
  };

  electron.app.on("ready", onReady);
  if (electron.app.isReady()) {
    onReady();
  }
}

install();
