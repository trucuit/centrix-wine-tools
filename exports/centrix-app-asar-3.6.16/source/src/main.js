const { app, BrowserWindow, BrowserView, WebContentsView, ipcMain, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { ACCOUNT_PREFIX } = require("./shared/gibberish-names");

const DEFAULT_URL = "https://claude.ai/login";
const DEFAULT_ACCOUNT = "default";
const TOOLBAR_HEIGHT = 82;
const DEFAULT_BROWSER_CHROME_VISIBLE = process.env.CENTRIX_SHOW_BROWSER_CHROME === "1";
const BROWSER_CHROME_TOGGLE_SHORTCUT = "Ctrl+Shift+U";
const LOG_PANEL_WIDTH = 360;
const COMPACT_LAYOUT_WIDTH = 1180;
const COMPACT_LOG_PANEL_WIDTH = 300;
const MIN_LOG_ITEMS = 80;

let mainWindow;
let browserManager;

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

function summarizeHeaders(headers = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["authorization", "cookie", "set-cookie", "x-csrf-token", "x-xsrf-token"].includes(lower)) {
      clean[key] = "[redacted]";
    } else {
      clean[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return clean;
}

function isBrowserChromeToggleShortcut(input) {
  return (
    input.type === "keyDown" &&
    input.control &&
    input.shift &&
    !input.alt &&
    String(input.key || "").toLowerCase() === "u"
  );
}

class BrowserSessionManager {
  constructor(window) {
    this.window = window;
    this.view = null;
    this.viewType = null;
    this.webContents = null;
    this.accountId = DEFAULT_ACCOUNT;
    this.partition = `persist:${ACCOUNT_PREFIX}${DEFAULT_ACCOUNT}`;
    this.networkLog = [];
    this.browserChromeVisible = DEFAULT_BROWSER_CHROME_VISIBLE;
    this.bounds = { x: 0, y: this.browserChromeHeight(), width: 1200, height: 800 };

    this.window.on("resize", () => this.resize());
    this.window.on("enter-full-screen", () => this.resize());
    this.window.on("leave-full-screen", () => this.resize());
    this.window.webContents.on("before-input-event", (event, input) => {
      this.handleBrowserChromeShortcut(event, input);
    });
  }

  async open({ accountId = DEFAULT_ACCOUNT, url = DEFAULT_URL, proxyRules = "" } = {}) {
    this.accountId = sanitizeAccountId(accountId);
    this.partition = `persist:${ACCOUNT_PREFIX}${this.accountId}`;
    const ses = session.fromPartition(this.partition);

    await this.applyProxy(ses, proxyRules);
    this.destroyView();
    this.createView(ses);
    this.attachEvents();
    this.resize();

    const targetUrl = normalizeUrl(url);
    await this.webContents.loadURL(targetUrl);
    return this.state();
  }

  async applyProxy(ses, proxyRules) {
    const rules = String(proxyRules || "").trim();
    if (!rules) {
      await ses.setProxy({ mode: "direct" });
      return;
    }

    await ses.setProxy({ proxyRules: rules });
  }

  createView(ses) {
    const webPreferences = {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    };

    if (WebContentsView) {
      this.view = new WebContentsView({ webPreferences });
      this.viewType = "WebContentsView";
      this.webContents = this.view.webContents;
      this.webContents.on("before-input-event", (event, input) => {
        this.handleBrowserChromeShortcut(event, input);
      });
      this.window.contentView.addChildView(this.view);
      return;
    }

    this.view = new BrowserView({ webPreferences });
    this.viewType = "BrowserView";
    this.webContents = this.view.webContents;
    this.webContents.on("before-input-event", (event, input) => {
      this.handleBrowserChromeShortcut(event, input);
    });
    this.window.setBrowserView(this.view);
  }

  destroyView() {
    if (!this.view) return;

    try {
      if (this.viewType === "WebContentsView") {
        this.window.contentView.removeChildView(this.view);
      } else {
        this.window.setBrowserView(null);
      }
    } catch {
      // Ignore detach errors while switching accounts.
    }

    try {
      this.webContents?.close({ waitForBeforeUnload: false });
    } catch {
      // Ignore close errors during shutdown.
    }

    this.view = null;
    this.webContents = null;
    this.viewType = null;
  }

  attachEvents() {
    const wc = this.webContents;

    wc.on("page-title-updated", (_event, title) => {
      this.emit("browser:title", { title });
    });

    wc.on("did-start-loading", () => {
      this.emit("browser:loading", { loading: true });
    });

    wc.on("did-stop-loading", () => {
      this.emit("browser:loading", { loading: false });
      this.emit("browser:navigation", this.state());
    });

    wc.on("did-navigate", (_event, url) => {
      this.emit("browser:navigation", { ...this.state(), url });
    });

    wc.on("did-navigate-in-page", (_event, url) => {
      this.emit("browser:navigation", { ...this.state(), url });
    });

    wc.on("console-message", (_event, level, message, line, sourceId) => {
      this.emit("browser:console", {
        level,
        message,
        line,
        sourceId
      });
    });

    wc.session.webRequest.onBeforeRequest((details, callback) => {
      this.recordNetwork({
        phase: "request",
        id: details.id,
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        timestamp: Date.now()
      });
      callback({});
    });

    wc.session.webRequest.onCompleted((details) => {
      this.recordNetwork({
        phase: "response",
        id: details.id,
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        statusCode: details.statusCode,
        fromCache: details.fromCache,
        responseHeaders: summarizeHeaders(details.responseHeaders),
        timestamp: Date.now()
      });
    });

    wc.session.webRequest.onErrorOccurred((details) => {
      this.recordNetwork({
        phase: "error",
        id: details.id,
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        error: details.error,
        timestamp: Date.now()
      });
    });
  }

  resize() {
    if (!this.view) return;

    const contentBounds = this.window.getContentBounds();
    const browserChromeHeight = this.browserChromeHeight();
    const sidePanelWidth =
      contentBounds.width <= COMPACT_LAYOUT_WIDTH ? COMPACT_LOG_PANEL_WIDTH : LOG_PANEL_WIDTH;
    this.bounds = {
      x: 0,
      y: browserChromeHeight,
      width: Math.max(320, contentBounds.width - sidePanelWidth),
      height: Math.max(240, contentBounds.height - browserChromeHeight)
    };

    this.view.setBounds(this.bounds);
  }

  browserChromeHeight() {
    return this.browserChromeVisible ? TOOLBAR_HEIGHT : 0;
  }

  browserChromeState() {
    return {
      browserChromeVisible: this.browserChromeVisible,
      browserChromeHeight: this.browserChromeHeight(),
      toggleShortcut: BROWSER_CHROME_TOGGLE_SHORTCUT
    };
  }

  setBrowserChromeVisible(visible) {
    this.browserChromeVisible = Boolean(visible);
    this.resize();
    const state = this.browserChromeState();
    this.emit("browser:chrome-visibility", state);
    return state;
  }

  toggleBrowserChrome() {
    return this.setBrowserChromeVisible(!this.browserChromeVisible);
  }

  handleBrowserChromeShortcut(event, input) {
    if (!isBrowserChromeToggleShortcut(input)) return;
    event.preventDefault();
    this.toggleBrowserChrome();
  }

  recordNetwork(entry) {
    this.networkLog.push(entry);
    if (this.networkLog.length > MIN_LOG_ITEMS) {
      this.networkLog.splice(0, this.networkLog.length - MIN_LOG_ITEMS);
    }
    this.emit("browser:network", entry);
  }

  emit(channel, payload) {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  state() {
    return {
      accountId: this.accountId,
      partition: this.partition,
      viewType: this.viewType,
      url: this.webContents?.getURL() || "",
      title: this.webContents?.getTitle() || "",
      canGoBack: Boolean(this.webContents?.canGoBack()),
      canGoForward: Boolean(this.webContents?.canGoForward()),
      isLoading: Boolean(this.webContents?.isLoading()),
      ...this.browserChromeState(),
      networkLog: this.networkLog.slice(-30)
    };
  }

  async goBack() {
    if (this.webContents?.canGoBack()) this.webContents.goBack();
    return this.state();
  }

  async goForward() {
    if (this.webContents?.canGoForward()) this.webContents.goForward();
    return this.state();
  }

  async reload() {
    this.webContents?.reload();
    return this.state();
  }

  async navigate(url) {
    await this.webContents?.loadURL(normalizeUrl(url));
    return this.state();
  }

  async captureScreenshot() {
    if (!this.webContents) {
      throw new Error("Browser is not open");
    }

    const image = await this.webContents.capturePage();
    const dir = path.join(app.getPath("userData"), "browser-screenshots");
    await fs.mkdir(dir, { recursive: true });
    const filename = `account-${this.accountId}-${Date.now()}.png`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, image.toPNG());
    return { filePath };
  }

  openDevTools() {
    this.webContents?.openDevTools({ mode: "detach" });
    return this.state();
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: "CentriX Embedded Browser POC",
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  browserManager = new BrowserSessionManager(mainWindow);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.once("did-finish-load", () => {
    browserManager.open({ accountId: DEFAULT_ACCOUNT, url: DEFAULT_URL }).catch((error) => {
      mainWindow.webContents.send("browser:error", error.message);
    });
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId("digital.centrix.embedded-browser-poc");
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("browser:open", (_event, payload) => browserManager.open(payload));
ipcMain.handle("browser:navigate", (_event, url) => browserManager.navigate(url));
ipcMain.handle("browser:back", () => browserManager.goBack());
ipcMain.handle("browser:forward", () => browserManager.goForward());
ipcMain.handle("browser:reload", () => browserManager.reload());
ipcMain.handle("browser:state", () => browserManager.state());
ipcMain.handle("browser:chrome-state", () => browserManager.browserChromeState());
ipcMain.handle("browser:set-chrome-visible", (_event, visible) => browserManager.setBrowserChromeVisible(visible));
ipcMain.handle("browser:screenshot", () => browserManager.captureScreenshot());
ipcMain.handle("browser:devtools", () => browserManager.openDevTools());
