const { app, BrowserWindow, session } = require("electron");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { CLAUDE_REMOTE_PREFIX } = require("./shared/gibberish-names");

const HOST = "127.0.0.1";
const PORT = Number(process.env.CENTRIX_REMOTE_PORT || 19777);
const DEFAULT_URL = "https://claude.ai/login";
const DEFAULT_ACCOUNT = "default";
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;

let targetWindow = null;
let controlWindow = null;
let server = null;

const remoteState = {
  accountId: DEFAULT_ACCOUNT,
  partition: `persist:${CLAUDE_REMOTE_PREFIX}${DEFAULT_ACCOUNT}`,
  url: DEFAULT_URL,
  title: "",
  loading: false,
  visible: true,
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  lastError: ""
};

function sanitizeAccountId(accountId) {
  return String(accountId || DEFAULT_ACCOUNT).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || DEFAULT_ACCOUNT;
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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function getTargetWebContents() {
  if (!targetWindow || targetWindow.isDestroyed()) {
    throw new Error("Target browser is not available");
  }
  return targetWindow.webContents;
}

async function createTargetBrowser({ accountId = DEFAULT_ACCOUNT, url = DEFAULT_URL, proxyRules = "" } = {}) {
  const cleanAccountId = sanitizeAccountId(accountId);
  const partition = `persist:${CLAUDE_REMOTE_PREFIX}${cleanAccountId}`;
  const targetSession = session.fromPartition(partition);
  const rules = String(proxyRules || "").trim();

  if (rules) {
    await targetSession.setProxy({ proxyRules: rules });
  } else {
    await targetSession.setProxy({ mode: "direct" });
  }

  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.close();
  }

  remoteState.accountId = cleanAccountId;
  remoteState.partition = partition;
  remoteState.url = normalizeUrl(url);
  remoteState.title = "";
  remoteState.loading = false;
  remoteState.visible = true;
  remoteState.lastError = "";

  targetWindow = new BrowserWindow({
    width: remoteState.width,
    height: remoteState.height,
    useContentSize: true,
    show: true,
    title: "CentriX Claude Target Browser",
    backgroundColor: "#ffffff",
    webPreferences: {
      session: targetSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  const wc = targetWindow.webContents;
  wc.setZoomFactor(1);
  wc.setWindowOpenHandler(({ url: nextUrl }) => {
    wc.loadURL(nextUrl).catch((error) => {
      remoteState.lastError = error.message;
    });
    return { action: "deny" };
  });

  wc.on("page-title-updated", (_event, title) => {
    remoteState.title = title || "";
  });

  wc.on("did-start-loading", () => {
    remoteState.loading = true;
  });

  wc.on("did-stop-loading", () => {
    remoteState.loading = false;
    remoteState.url = wc.getURL() || remoteState.url;
    remoteState.title = wc.getTitle() || remoteState.title;
  });

  wc.on("did-navigate", (_event, nextUrl) => {
    remoteState.url = nextUrl;
  });

  wc.on("did-navigate-in-page", (_event, nextUrl) => {
    remoteState.url = nextUrl;
  });

  wc.on("did-fail-load", (_event, _errorCode, errorDescription) => {
    remoteState.loading = false;
    remoteState.lastError = errorDescription || "";
  });

  targetWindow.on("closed", () => {
    targetWindow = null;
    remoteState.visible = false;
  });

  await wc.loadURL(remoteState.url);
  return getState();
}

function getState() {
  if (targetWindow && !targetWindow.isDestroyed()) {
    const bounds = targetWindow.getContentBounds();
    remoteState.visible = targetWindow.isVisible();
    remoteState.width = bounds.width;
    remoteState.height = bounds.height;
    remoteState.url = targetWindow.webContents.getURL() || remoteState.url;
    remoteState.title = targetWindow.webContents.getTitle() || remoteState.title;
    remoteState.loading = targetWindow.webContents.isLoading();
  }

  return {
    ...remoteState,
    controlUrl: `http://${HOST}:${PORT}/`
  };
}

async function handleFrame(_req, res) {
  try {
    const wc = getTargetWebContents();
    const image = await wc.capturePage();
    const png = image.toPNG();
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store, max-age=0",
      "Content-Length": png.length
    });
    res.end(png);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

function sendMouseClick(payload) {
  const wc = getTargetWebContents();
  const x = Math.max(0, Math.round(Number(payload.x || 0)));
  const y = Math.max(0, Math.round(Number(payload.y || 0)));
  const button = payload.button === "right" ? "right" : "left";
  wc.focus();
  wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
  wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
}

function sendMouseMove(payload) {
  const wc = getTargetWebContents();
  const x = Math.max(0, Math.round(Number(payload.x || 0)));
  const y = Math.max(0, Math.round(Number(payload.y || 0)));
  wc.sendInputEvent({ type: "mouseMove", x, y });
}

function sendMouseWheel(payload) {
  const wc = getTargetWebContents();
  const x = Math.max(0, Math.round(Number(payload.x || 0)));
  const y = Math.max(0, Math.round(Number(payload.y || 0)));
  const deltaX = Math.round(Number(payload.deltaX || 0));
  const deltaY = Math.round(Number(payload.deltaY || 0));
  wc.focus();
  wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX, deltaY });
}

function sendKey(key) {
  const wc = getTargetWebContents();
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

async function handleApi(req, res, pathname) {
  try {
    if (req.method === "GET" && pathname === "/api/state") {
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    const payload = await readJson(req);
    const wc = targetWindow && !targetWindow.isDestroyed() ? targetWindow.webContents : null;

    if (pathname === "/api/open") {
      sendJson(res, 200, { ok: true, state: await createTargetBrowser(payload) });
      return;
    }

    if (pathname === "/api/navigate") {
      await getTargetWebContents().loadURL(normalizeUrl(payload.url));
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/back") {
      if (wc?.canGoBack()) wc.goBack();
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/forward") {
      if (wc?.canGoForward()) wc.goForward();
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/reload") {
      getTargetWebContents().reload();
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/show") {
      targetWindow?.show();
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/hide") {
      targetWindow?.hide();
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/devtools") {
      getTargetWebContents().openDevTools({ mode: "detach" });
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/resize") {
      const width = Math.max(800, Math.min(2200, Math.round(Number(payload.width || DEFAULT_WIDTH))));
      const height = Math.max(520, Math.min(1600, Math.round(Number(payload.height || DEFAULT_HEIGHT))));
      targetWindow?.setContentSize(width, height);
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/click") {
      sendMouseClick(payload);
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/move") {
      sendMouseMove(payload);
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/wheel") {
      sendMouseWheel(payload);
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/type") {
      const text = String(payload.text || "");
      if (text) await getTargetWebContents().insertText(text);
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    if (pathname === "/api/key") {
      sendKey(String(payload.key || ""));
      sendJson(res, 200, { ok: true, state: getState() });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Unknown API route" });
  } catch (error) {
    remoteState.lastError = error.message;
    sendJson(res, 500, { ok: false, error: error.message, state: getState() });
  }
}

async function serveStatic(res, pathname) {
  const files = {
    "/": ["remote-web", "index.html", "text/html; charset=utf-8"],
    "/remote.css": ["remote-web", "remote.css", "text/css; charset=utf-8"],
    "/remote.js": ["remote-web", "remote.js", "application/javascript; charset=utf-8"]
  };
  const entry = files[pathname];
  if (!entry) {
    sendText(res, 404, "Not found");
    return;
  }

  const filePath = path.join(__dirname, entry[0], entry[1]);
  const body = await fs.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": entry[2],
    "Cache-Control": "no-store",
    "Content-Length": body.length
  });
  res.end(body);
}

function createServer() {
  server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = reqUrl.pathname;

    if (req.method === "GET" && pathname === "/api/frame") {
      handleFrame(req, res);
      return;
    }

    if (pathname.startsWith("/api/")) {
      handleApi(req, res, pathname);
      return;
    }

    serveStatic(res, pathname).catch((error) => {
      sendJson(res, 500, { ok: false, error: error.message });
    });
  });

  server.listen(PORT, HOST);
}

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "CentriX Claude Remote Web UI",
    backgroundColor: "#f4f6f8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  controlWindow.loadURL(`http://${HOST}:${PORT}/`);
}

app.whenReady().then(async () => {
  app.setAppUserModelId("digital.centrix.claude-remote-web");
  createServer();
  await createTargetBrowser();
  createControlWindow();
  console.log(`CentriX Claude Remote Web UI: http://${HOST}:${PORT}/`);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (server) server.close();
  if (process.platform !== "darwin") app.quit();
});
