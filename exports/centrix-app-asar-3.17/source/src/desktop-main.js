const { app, BrowserWindow, BrowserView, WebContentsView, Menu, ipcMain, nativeTheme, session } = require("electron");
const path = require("node:path");

const {
  normalizeUrl,
  readServicesConfig,
  resetServicesConfig,
  writeServicesConfig
} = require("./shared/service-store");
const { DESKTOP_SHARED_PREFIX } = require("./shared/gibberish-names");

const DEFAULT_ACCOUNT = "default";
const MIN_BROWSER_WIDTH = 420;
const MIN_BROWSER_HEIGHT = 320;

function appMode() {
  if (process.env.CENTRIX_DESKTOP_MODE === "admin") return "admin";
  if (process.argv.includes("--admin")) return "admin";
  return "user";
}

function sanitizePartitionPart(value, fallback = "default") {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || fallback;
}

function titleForMode(mode) {
  return mode === "admin" ? "CentriX Desktop Admin" : "CentriX Desktop App";
}

function rendererFileForMode(mode) {
  return path.join(__dirname, mode === "admin" ? "desktop-admin" : "desktop-user", "index.html");
}

function isAdminMode() {
  return appMode() === "admin";
}

class EmbeddedBrowserManager {
  constructor(window) {
    this.window = window;
    this.tabs = new Map();
    this.activeTab = null;
    this.accountId = DEFAULT_ACCOUNT;
    this.bounds = { x: 320, y: 72, width: 900, height: 700 };

    this.window.on("resize", () => this.applyBounds());
    this.window.on("enter-full-screen", () => this.applyBounds());
    this.window.on("leave-full-screen", () => this.applyBounds());
  }

  async openService(service, accountId = DEFAULT_ACCOUNT) {
    if (!service?.url) {
      throw new Error("Service URL is missing");
    }

    this.accountId = sanitizePartitionPart(accountId);
    const activeService = {
      id: sanitizePartitionPart(service.id, "service"),
      name: String(service.name || "Service"),
      url: normalizeUrl(service.url)
    };

    const tab = this.getOrCreateTab(activeService);
    this.showTab(tab);
    this.applyBounds();

    if (!tab.loaded) {
      tab.loaded = true;
      await tab.webContents.loadURL(activeService.url);
    }

    return this.state();
  }

  getOrCreateTab(service) {
    const tabKey = `${this.accountId}:${service.id}`;
    const existing = this.tabs.get(tabKey);

    if (existing && !existing.webContents.isDestroyed()) {
      existing.service = service;
      return existing;
    }

    const partition = `persist:${DESKTOP_SHARED_PREFIX}${this.accountId}`;
    const ses = session.fromPartition(partition);
    const tab = this.createTab(ses, service, partition);
    this.tabs.set(tabKey, tab);
    this.attachEvents(tab);
    return tab;
  }

  createTab(ses, service, partition) {
    const tab = {
      service,
      partition,
      view: null,
      viewType: "",
      webContents: null,
      attached: false,
      loaded: false,
      lastError: ""
    };

    const webPreferences = {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    };

    if (WebContentsView) {
      tab.view = new WebContentsView({ webPreferences });
      tab.viewType = "WebContentsView";
      tab.webContents = tab.view.webContents;
      return tab;
    }

    tab.view = new BrowserView({ webPreferences });
    tab.viewType = "BrowserView";
    tab.webContents = tab.view.webContents;
    return tab;
  }

  showTab(tab) {
    if (this.activeTab === tab && tab.attached) return;

    this.detachActiveTab();
    this.activeTab = tab;

    if (tab.viewType === "WebContentsView") {
      this.window.contentView.addChildView(tab.view);
    } else {
      this.window.setBrowserView(tab.view);
    }

    tab.attached = true;
  }

  detachActiveTab() {
    const tab = this.activeTab;
    if (!tab || !tab.attached) return;

    try {
      if (tab.viewType === "WebContentsView") {
        this.window.contentView.removeChildView(tab.view);
      } else {
        this.window.setBrowserView(null);
      }
    } catch {
      // Ignore detach errors while switching services.
    }

    tab.attached = false;
  }

  attachEvents(tab) {
    const wc = tab.webContents;

    wc.on("page-title-updated", (_event, title) => {
      if (this.activeTab === tab) {
        this.emit("browser:title", { title });
      }
    });

    wc.on("did-start-loading", () => {
      tab.lastError = "";
      if (this.activeTab === tab) {
        this.emit("browser:loading", { loading: true });
      }
    });

    wc.on("did-stop-loading", () => {
      if (this.activeTab === tab) {
        this.emit("browser:loading", { loading: false });
        this.emit("browser:navigation", this.state());
      }
    });

    wc.on("did-navigate", (_event, url) => {
      if (this.activeTab === tab) {
        this.emit("browser:navigation", { ...this.state(), url });
      }
    });

    wc.on("did-navigate-in-page", (_event, url) => {
      if (this.activeTab === tab) {
        this.emit("browser:navigation", { ...this.state(), url });
      }
    });

    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return;
      tab.lastError = errorDescription || "";
      if (this.activeTab === tab) {
        this.emit("browser:error", {
          errorCode,
          errorDescription,
          url: validatedURL
        });
      }
    });
  }

  setBounds(bounds) {
    const next = {
      x: Math.max(0, Math.round(Number(bounds?.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds?.y) || 0)),
      width: Math.max(MIN_BROWSER_WIDTH, Math.round(Number(bounds?.width) || MIN_BROWSER_WIDTH)),
      height: Math.max(MIN_BROWSER_HEIGHT, Math.round(Number(bounds?.height) || MIN_BROWSER_HEIGHT))
    };

    this.bounds = next;
    this.applyBounds();
    return this.bounds;
  }

  applyBounds() {
    if (!this.activeTab?.view) return;
    this.activeTab.view.setBounds(this.bounds);
  }

  async reload() {
    this.activeTab?.webContents?.reload();
    return this.state();
  }

  state() {
    const tab = this.activeTab;
    const wc = tab?.webContents;

    return {
      activeServiceId: tab?.service?.id || "",
      activeServiceName: tab?.service?.name || "",
      url: wc?.getURL() || tab?.service?.url || "",
      title: wc?.getTitle() || "",
      canGoBack: Boolean(wc?.canGoBack()),
      canGoForward: Boolean(wc?.canGoForward()),
      isLoading: Boolean(wc?.isLoading()),
      viewType: tab?.viewType || "",
      profilePartition: tab?.partition || "",
      openServiceIds: Array.from(this.tabs.values()).map((item) => item.service.id),
      tabCount: this.tabs.size,
      lastError: tab?.lastError || ""
    };
  }

  emit(channel, payload) {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }
}

let mainWindow;
let browserManager;

async function getServiceById(serviceId) {
  const config = await readServicesConfig();
  const enabled = config.services.filter((service) => service.enabled !== false);
  const service = enabled.find((item) => item.id === serviceId) || enabled[0] || config.services[0];

  if (!service) {
    throw new Error("No services are configured");
  }

  return service;
}

function createMainWindow() {
  const mode = appMode();
  mainWindow = new BrowserWindow({
    width: mode === "admin" ? 1180 : 1464,
    height: mode === "admin" ? 820 : 920,
    minWidth: mode === "admin" ? 980 : 1180,
    minHeight: mode === "admin" ? 680 : 720,
    title: titleForMode(mode),
    backgroundColor: "#eef6ff",
    webPreferences: {
      preload: path.join(__dirname, "desktop-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  if (mode === "user") {
    browserManager = new EmbeddedBrowserManager(mainWindow);
  }

  mainWindow.loadFile(rendererFileForMode(mode));
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

app.whenReady().then(() => {
  app.setName(titleForMode(appMode()));
  app.setAppUserModelId(isAdminMode() ? "digital.centrix.desktop-admin" : "digital.centrix.desktop-user");
  nativeTheme.themeSource = "light";
  Menu.setApplicationMenu(null);
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

ipcMain.handle("app:mode", () => appMode());
ipcMain.handle("services:list", () => readServicesConfig());
ipcMain.handle("services:reset", async () => {
  if (!isAdminMode()) throw new Error("Admin mode required");
  return resetServicesConfig();
});
ipcMain.handle("services:save", async (_event, services) => {
  if (!isAdminMode()) throw new Error("Admin mode required");
  return writeServicesConfig(services);
});

ipcMain.handle("browser:set-bounds", (_event, bounds) => {
  if (!browserManager) return null;
  return browserManager.setBounds(bounds);
});
ipcMain.handle("browser:open-service", async (_event, payload = {}) => {
  if (!browserManager) throw new Error("Browser is only available in user mode");
  const service = await getServiceById(payload.serviceId);
  return browserManager.openService(service, payload.accountId || DEFAULT_ACCOUNT);
});
ipcMain.handle("browser:reload", () => {
  if (!browserManager) return null;
  return browserManager.reload();
});
ipcMain.handle("browser:state", () => {
  if (!browserManager) return null;
  return browserManager.state();
});
