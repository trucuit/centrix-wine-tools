const api = window.centrixLocalUser;
const LOGIN_STORAGE_KEY = "centrixLocalUserLogin";
const SIDEBAR_WIDTH_KEY = "centrixLocalUserSidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "centrixLocalUserSidebarCollapsed";
const SERVICES_REFRESH_INTERVAL_MS = 30000;
const ACCOUNT_REFRESH_INTERVAL_MS = 60000;
const PORTAL_REFRESH_INTERVAL_MS = 60000;
const SERVICES_RENDER_DEBOUNCE_MS = 120;
const HIDDEN_LOAD_MESSAGE = "\u0110ang n\u1ea1p d\u1eef li\u1ec7u \u1ea9n trong n\u1ec1n";
const SERVICE_LOADING_MIN_VISIBLE_MS = 280;
const SERVICE_LOADING_BADGE = "\u0110ang n\u1ea1p";

const els = {
  appShell: document.querySelector("#appShell"),
  sidebarToggle: document.querySelector("#sidebarToggle"),
  sidebarResizer: document.querySelector("#sidebarResizer"),
  miniLogoButton: document.querySelector("#miniLogoButton"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  loginButton: document.querySelector("#loginButton"),
  googleLoginButton: document.querySelector("#googleLoginButton"),
  loginStatus: document.querySelector("#loginStatus"),
  browserViewport: document.querySelector("#browserViewport"),
  homeView: document.querySelector("#homeView"),
  browserCard: document.querySelector("#browserCard"),
  openingView: document.querySelector("#openingView"),
  openingName: document.querySelector("#openingName"),
  openingMsg: document.querySelector("#openingMsg"),
  openingStatus: document.querySelector("#openingStatus"),
  closeServiceButton: document.querySelector("#closeServiceButton"),
  navBackButton: document.querySelector("#navBackButton"),
  navForwardButton: document.querySelector("#navForwardButton"),
  serviceList: document.querySelector("#serviceList"),
  serviceSearch: document.querySelector("#serviceSearch"),
  serviceCount: document.querySelector("#serviceCount"),
  reloadButton: document.querySelector("#reloadButton"),
  logoutButton: document.querySelector("#logoutButton"),
  syncButton: document.querySelector("#showButton"),
  themeOpts: Array.from(document.querySelectorAll(".theme-opt")),
  accountCard: document.querySelector("#accountCard"),
  acctMenu: document.querySelector("#acctMenu"),
  acctName: document.querySelector("#acctName"),
  acctTag: document.querySelector("#acctTag"),
  sidebarFoot: document.querySelector(".sidebar-foot"),
  creditMeter: document.querySelector("#creditMeter"),
  creditBalance: document.querySelector("#creditBalance"),
  creditBar: document.querySelector("#creditBar"),
  urlLog: document.querySelector("#urlLog"),
  urlCount: document.querySelector("#urlCount"),
  urlSearch: document.querySelector("#urlSearch"),
  portalPanel: document.querySelector("#portalPanel"),
  portalTabs: Array.from(document.querySelectorAll(".main-tab[data-user-view]"))
};

const FAV_KEY = "centrixLocalUserFavorites";
const URLLOG_KEY = "centrixLocalUserUrlLog";
let favorites = new Set();
let urlHistory = [];
let urlFilter = "";
let meTimer = 0;
let creditRefreshTimer = 0;
let lastCreditMax = 0;
let meData = null;
let portalState = null;
let lastPortalRefreshAt = 0;
let portalView = localStorage.getItem("centrixLocalUserPortalView") || "overview";
let servicesRenderTimer = 0;
let openServiceSerial = 0;

function loadFavorites() {
  try { favorites = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); } catch { favorites = new Set(); }
}
function saveFavorites() {
  localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(favorites)));
}
function toggleFavorite(serviceId) {
  if (favorites.has(serviceId)) favorites.delete(serviceId);
  else favorites.add(serviceId);
  saveFavorites();
  renderServices();
}

function loadUrlHistory() {
  try { urlHistory = JSON.parse(localStorage.getItem(URLLOG_KEY) || "[]"); } catch { urlHistory = []; }
  if (!Array.isArray(urlHistory)) urlHistory = [];
}
function saveUrlHistory() {
  localStorage.setItem(URLLOG_KEY, JSON.stringify(urlHistory.slice(0, 40)));
}

function cleanUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "about:blank" || raw.startsWith("file:")) return "";
  try {
    return new URL(raw).toString();
  } catch {
    try {
      return new URL(`https://${raw}`).toString();
    } catch {
      return "";
    }
  }
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function hostMatches(recordHost, serviceHost) {
  return Boolean(recordHost && serviceHost && (recordHost === serviceHost || recordHost.endsWith(`.${serviceHost}`)));
}

function serviceForHistoryUrl(entry = {}) {
  const serviceId = String(entry.serviceId || "").toLowerCase();
  const byId = serviceId ? services.find((item) => String(item.id || "").toLowerCase() === serviceId) : null;
  if (byId) return byId;
  const host = hostFromUrl(entry.url);
  return services.find((item) => {
    const serviceHost = hostFromUrl(item.url);
    return hostMatches(host, serviceHost);
  }) || null;
}

function historyDisplayName(entry = {}) {
  const service = serviceForHistoryUrl(entry);
  if (service?.name) return service.name;
  if (entry.name && !/^https?:\/\//i.test(String(entry.name))) return entry.name;
  const host = hostFromUrl(entry.url);
  if (!host) return "Dịch vụ";
  const known = Object.entries(HOST_SERVICE_NAMES)
    .find(([serviceHost]) => hostMatches(host, serviceHost))?.[1];
  if (known) return known;
  const compact = host.replace(/^chat\./, "").split(".")[0] || host;
  return compact.charAt(0).toUpperCase() + compact.slice(1);
}

function recordUrlVisit(serviceId, url) {
  const service = services.find((item) => item.id === serviceId);
  if (!service) return;
  const entry = { serviceId, name: service.name, url: cleanUrl(url || service.url), at: Date.now() };
  if (!entry.url) return;
  urlHistory = [entry, ...urlHistory.filter((u) => !(u.serviceId === serviceId && u.url === entry.url))].slice(0, 40);
  saveUrlHistory();
  renderUrlLog();
}

function relativeTime(ts) {
  const diff = Math.max(0, Date.now() - Number(ts || 0));
  const min = Math.floor(diff / 60000);
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  return `${Math.floor(hr / 24)} ngày trước`;
}

const THEME_KEY = "centrixLocalUserTheme";

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  els.appShell.setAttribute("data-theme", next);
  for (const btn of els.themeOpts) {
    btn.classList.toggle("is-active", btn.dataset.themeSet === next);
  }
  localStorage.setItem(THEME_KEY, next);
}

function loadSavedTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || "light");
}

function setAccountMenuOpen(open) {
  els.acctMenu?.classList.toggle("hidden", !open);
}

function setAccountIdentity() {
  if (els.acctName) els.acctName.textContent = state.connected ? (state.email || "CentriX") : "CentriX Local";
  if (els.acctTag) els.acctTag.textContent = state.connected ? "Đã đăng nhập" : "Local";
  els.sidebarFoot?.classList.toggle("acct-disconnected", !state.connected);
}

const fallbackServices = [];

function displayServices() {
  return services;
}

let services = fallbackServices;
let servicesRefreshTimer = 0;
let lastServicesSignature = "";
let servicePollingFailed = false;
let servicesLoadedFromApi = false;
let servicesApiUpdatedAt = "";

const HOST_SERVICE_NAMES = {
  "chatgpt.com": "ChatGPT",
  "claude.ai": "Claude",
  "gemini.google.com": "Gemini",
  "perplexity.ai": "Perplexity",
  "copilot.microsoft.com": "Microsoft Copilot",
  "grok.com": "Grok",
  "chat.deepseek.com": "DeepSeek",
  "chat.mistral.ai": "Mistral",
  "midjourney.com": "Midjourney",
  "poe.com": "Poe",
  "notebooklm.google.com": "NotebookLM",
  "elevenlabs.io": "ElevenLabs"
};

const state = {
  email: "",
  serverUrl: "",
  token: "",
  deviceId: "local-user",
  profileId: "default",
  activeServiceId: "",
  filter: "",
  connected: false,
  profileSync: {
    status: "idle",
    message: "",
    initialReady: false,
    storageReady: false,
    error: ""
  },
  openServiceIds: new Set(),
  loadedServiceIds: new Set(),
  preparingServiceIds: new Set()
};

function loadSavedLogin() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOGIN_STORAGE_KEY) || "{}");
    els.emailInput.value = saved.email || "local@centrix.test";
  } catch {
    els.emailInput.value = "local@centrix.test";
  }
  els.passwordInput.value = "";
}

function loginDraftFromInputs() {
  return {
    email: String(els.emailInput.value || "").trim().toLowerCase(),
    password: String(els.passwordInput.value || "")
  };
}

function saveLoginDraft() {
  localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({ email: loginDraftFromInputs().email }));
}

function saveLogin() {
  localStorage.setItem(
    LOGIN_STORAGE_KEY,
    JSON.stringify({
      email: state.email,
      serverUrl: state.serverUrl,
      deviceId: state.deviceId,
      profileId: state.profileId
    })
  );
}

function cleanServerUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    return ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function friendlyConnectError(error) {
  const message = error?.message || String(error || "");
  if (isLoopbackUrl(state.serverUrl) && /fetch failed|Failed to fetch|ECONNREFUSED|aborted/i.test(message)) {
    return "127.0.0.1 chỉ dùng khi User và Server cùng một máy. Thiết bị khác hãy nhập Public URL Cloudflare Tunnel trên Server hoặc LAN/Tailscale URL.";
  }

  if (/fetch failed|Failed to fetch|ECONNREFUSED|aborted|network/i.test(message)) {
    return "Không kết nối được Server. Hãy bật Cloudflare Tunnel trong App Server rồi nhập Public URL https://...trycloudflare.com, hoặc kiểm tra LAN/Tailscale port 19778.";
  }

  return message || "Không kết nối được Server.";
}

function setLoginStatus(message, type = "") {
  els.loginStatus.textContent = message;
  els.loginStatus.className = `login-status${type ? ` ${type}` : ""}`;
}

let currentMainView = "home";

function setMainView(view) {
  currentMainView = view;
  els.homeView?.classList.toggle("hidden", view !== "home");
  els.browserCard?.classList.toggle("hidden", view === "home");
  els.openingView?.classList.toggle("hidden", view !== "opening");
  els.appShell?.classList.toggle("browser-active", view === "browser" || view === "opening");
  if (view === "browser") syncBrowserBoundsBurst();
}

function setOpening(name, message, status, isError = false) {
  if (els.openingName && name) els.openingName.textContent = name;
  if (els.openingMsg && message) els.openingMsg.textContent = message;
  if (els.openingStatus && status) els.openingStatus.textContent = status;
  els.openingView?.classList.toggle("is-error", Boolean(isError));
}

function waitForLoadingNotice(startedAt, minMs = SERVICE_LOADING_MIN_VISIBLE_MS) {
  const remaining = Math.max(0, minMs - (performance.now() - Number(startedAt || 0)));
  return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}

function profileReadyForOpen() {
  return state.profileSync.initialReady === true;
}

function profileSyncType() {
  if (state.profileSync.status === "profile-error" || state.profileSync.status === "storage-error") return "error";
  if (state.profileSync.initialReady) return "ready";
  return "loading";
}

function profileSyncLabel() {
  if (state.profileSync.status === "profile-error") return "Profile lỗi";
  if (state.profileSync.storageReady) return "Profile sẵn sàng";
  if (state.profileSync.initialReady) return "Cookie/profile sẵn sàng";
  if (state.profileSync.status === "storage-waiting") return "Đang chuẩn bị storage";
  if (state.profileSync.status === "profile-waiting") return "Đang chờ profile";
  return "Đang tải profile";
}

function servicePrepareLabel(status) {
  if (status === "profile") return "Chuẩn bị profile";
  if (status === "local-store") return "Nạp dữ liệu ẩn";
  if (status === "loading") return "Đang tải ẩn";
  if (status === "dom-stable") return "Kiểm tra giao diện";
  if (status === "settling") return "Đang ổn định UI";
  if (status === "ready") return "Sẵn sàng";
  return "Đang xử lý";
}

function showLoggedInWelcome() {
  setMainView("home");
  renderPortal();
}

function initials(name) {
  return String(name || "C")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function serviceIcon(service) {
  const label = initials(service.name);
  if (!service.iconUrl) return `<span>${label}</span>`;
  return `<img src="${service.iconUrl}" alt="" onerror="this.replaceWith(document.createTextNode('${label}'))" />`;
}

function filteredServices() {
  const query = state.filter.trim().toLowerCase();
  return displayServices().filter((service) => !query || `${service.name} ${service.url}`.toLowerCase().includes(query));
}

function servicesSignature(nextServices) {
  return JSON.stringify((nextServices || []).map((service) => ({
    id: service.id,
    name: service.name,
    url: service.url,
    iconUrl: service.iconUrl,
    enabled: service.enabled !== false
  })));
}

function applyServicesConfig(config, options = {}) {
  const hasApiServices = Array.isArray(config?.services);
  const nextServices = hasApiServices ? config.services : fallbackServices;
  const nextSignature = servicesSignature(nextServices);
  const changed = nextSignature !== lastServicesSignature;

  services = nextServices;
  servicesLoadedFromApi = hasApiServices;
  servicesApiUpdatedAt = config?.updatedAt || "";
  lastServicesSignature = nextSignature;
  if (state.activeServiceId && !services.some((service) => service.id === state.activeServiceId)) {
    state.activeServiceId = "";
  }

  if (changed || options.forceRender) {
    renderServices();
  }

  return changed;
}

function renderServices(options = {}) {
  clearTimeout(servicesRenderTimer);
  if (options.immediate) {
    servicesRenderTimer = 0;
    renderServicesNow();
    return;
  }
  servicesRenderTimer = setTimeout(() => {
    servicesRenderTimer = 0;
    renderServicesNow();
  }, SERVICES_RENDER_DEBOUNCE_MS);
}

function renderServicesNow() {
  els.serviceList.innerHTML = "";
  if (els.serviceCount) els.serviceCount.textContent = String(services.length);

  const sorted = [...filteredServices()].sort((a, b) => (favorites.has(b.id) ? 1 : 0) - (favorites.has(a.id) ? 1 : 0));
  for (const service of sorted) {
    const isSelected = service.id === state.activeServiceId;
    const isOpen = state.openServiceIds.has(service.id);
    const isLoaded = state.loadedServiceIds.has(service.id);
    const isPreparing = state.preparingServiceIds.has(service.id);
    const isFav = favorites.has(service.id);
    const isActive = isSelected && isLoaded && !isPreparing;
    const isPending = state.connected && (isPreparing || (isSelected && !isLoaded));
    let badge = isActive
      ? "Đang chạy"
      : isOpen && isLoaded
        ? "Đã mở"
        : isPending
          ? "Đang nạp"
          : state.connected && !profileReadyForOpen()
            ? "Đang nạp"
            : "Mở";
    if (isPending) badge = SERVICE_LOADING_BADGE;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `service-row${isActive || isPending ? " active" : isOpen ? " open" : ""}`;
    row.innerHTML = `
      <span class="service-icon">${serviceIcon(service)}</span>
      <span class="service-name">${escapeHtml(service.name)}</span>
      <span class="status-badge">${badge}</span>
      <span class="fav-btn${isFav ? " is-fav" : ""}" role="button" title="${isFav ? "Bỏ yêu thích" : "Yêu thích"}">
        <svg viewBox="0 0 24 24"><polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.6 5.8 21 7 14.1 2 9.3 8.9 8.6 12 2" /></svg>
      </span>
    `;
    row.querySelector(".fav-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavorite(service.id);
    });
    row.addEventListener("click", () => openService(service.id));
    els.serviceList.append(row);
  }

  if (!filteredServices().length) {
    const emptyTitle = state.connected && servicesLoadedFromApi ? "Chưa có dịch vụ" : "Đang chờ API dịch vụ";
    const emptyMessage = state.connected && servicesLoadedFromApi
      ? "Server chưa cấp dịch vụ nào cho tài khoản này."
      : "Đăng nhập để tải danh sách dịch vụ từ App Server.";
    els.serviceList.innerHTML = `<div class="empty-browser"><strong>${emptyTitle}</strong><span>${emptyMessage}</span></div>`;
  }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function renderUrlLog() {
  if (!els.urlLog) return;
  const q = urlFilter.trim().toLowerCase();
  const rows = urlHistory.filter((u) => {
    const name = historyDisplayName(u);
    return !q || `${name} ${u.url}`.toLowerCase().includes(q);
  });
  if (els.urlCount) els.urlCount.textContent = String(rows.length);
  els.urlLog.innerHTML = "";
  if (!rows.length) {
    els.urlLog.innerHTML = `<div class="url-empty">${urlHistory.length ? "Không có mục khớp bộ lọc." : "Chưa có lịch sử sử dụng."}</div>`;
    return;
  }
  for (const u of rows) {
    const name = historyDisplayName(u);
    const row = document.createElement("div");
    row.className = "url-row";
    row.title = u.url || "";
    row.innerHTML = `
      <span class="url-ic">${escapeHtml(initials(name))}</span>
      <span class="url-meta"><span class="url-svc">${escapeHtml(name)}</span><span class="url-time">${relativeTime(u.at)}</span></span>
      <button class="url-open" type="button">Mở</button>
    `;
    row.querySelector(".url-open").addEventListener("click", () => {
      const service = serviceForHistoryUrl(u);
      if (service?.id) openService(service.id, u.url);
    });
    els.urlLog.append(row);
  }
}

function formatCredit(value) {
  return Math.round(Number(value || 0)).toLocaleString("vi-VN");
}

function formatMoney(value, currency = "VND") {
  const amount = Math.round(Number(value || 0));
  if (currency === "VND") return `${amount.toLocaleString("vi-VN")} đ`;
  return `${amount.toLocaleString("vi-VN")} ${currency || ""}`.trim();
}

function portalRows(key) {
  const rows = portalState?.[key];
  return Array.isArray(rows) ? rows : [];
}

function parseSettingValue(value, fallback = null) {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { return JSON.parse(trimmed); } catch { return fallback; }
    }
    return trimmed;
  }
  return value ?? fallback;
}

function portalSettingValue(keys, fallback = null) {
  const wanted = Array.isArray(keys) ? keys.map((key) => String(key).toLowerCase()) : [String(keys).toLowerCase()];
  const row = portalRows("settings").find((item) => {
    const id = String(item.id || item.key || item.name || item.settingKey || "").toLowerCase();
    return wanted.includes(id);
  });
  if (!row) return fallback;
  return parseSettingValue(row.value ?? row.data ?? row.items ?? row.config ?? row.content ?? row.text, fallback);
}

function portalArraySetting(keys) {
  const value = portalSettingValue(keys, []);
  return Array.isArray(value) ? value : [];
}

function portalPaymentMethods() {
  const configured = portalArraySetting(["paymentMethods", "payment-methods", "payments"]);
  if (configured.length) return configured;
  return [{
    id: "manual",
    name: "Yeu cau nap thu cong",
    desc: "Tao don tren Server, Admin duyet thi credit duoc cong vao vi.",
    manual: true
  }];
}

function portalVatInfo() {
  const configured = portalSettingValue(["vatInfo", "vat", "billingProfile"], {});
  const user = portalState?.user || {};
  return {
    name: configured?.name || configured?.companyName || user.name || "",
    mst: configured?.mst || configured?.taxCode || "",
    email: configured?.email || state.email || user.email || "",
    addr: configured?.addr || configured?.address || ""
  };
}

function setPortalView(view) {
  portalView = view || "overview";
  localStorage.setItem("centrixLocalUserPortalView", portalView);
  for (const button of els.portalTabs || []) {
    button.classList.toggle("is-active", button.dataset.userView === portalView);
  }
  renderPortal();
  refreshPortalIfStale().catch(() => {});
}

function portalItem(title, meta = "", badge = "") {
  return `
    <div class="portal-item">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(meta)}</span>
      </div>
      ${badge ? `<em>${escapeHtml(badge)}</em>` : ""}
    </div>
  `;
}

const SERVICE_ACCENTS = [
  "linear-gradient(135deg,#10a37f,#0d8a6c)",
  "linear-gradient(135deg,#d97757,#c2410c)",
  "linear-gradient(135deg,#1e93f5,#0b7bdd)",
  "linear-gradient(135deg,#7c3aed,#6d28d9)",
  "linear-gradient(135deg,#db2777,#be185d)",
  "linear-gradient(135deg,#0891b2,#0e7490)",
  "linear-gradient(135deg,#ca8a04,#a16207)"
];
function serviceAccent(service, index) {
  if (service.id === "chatgpt") return SERVICE_ACCENTS[0];
  if (service.id === "claude") return SERVICE_ACCENTS[1];
  return SERVICE_ACCENTS[index % SERVICE_ACCENTS.length];
}
function serviceCost(service) {
  const cost = Number(service.defaultCreditCost || service.creditCost || 0);
  return cost > 0 ? `${formatCredit(cost)} cr` : "theo model";
}

function statCard({ label, value, cap, highlight }) {
  if (highlight) {
    return `<div style="background:linear-gradient(135deg,var(--brand),var(--brand-strong));border:1px solid var(--brand);border-radius:14px;padding:16px 18px;box-shadow:0 8px 20px var(--brand-shadow);">
      <div style="font-size:10.5px;font-weight:700;color:rgba(255,255,255,.85);letter-spacing:.07em;text-transform:uppercase;">${escapeHtml(label)}</div>
      <div style="font-size:22px;font-weight:700;color:#fff;margin:7px 0 3px;letter-spacing:-.02em;">${escapeHtml(value)}</div>
      <div style="font-size:12px;color:rgba(255,255,255,.85);">${escapeHtml(cap)}</div>
    </div>`;
  }
  return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;box-shadow:0 1px 3px var(--shadow);">
    <div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.07em;text-transform:uppercase;">${escapeHtml(label)}</div>
    <div style="font-size:22px;font-weight:700;color:var(--text);margin:7px 0 3px;letter-spacing:-.02em;">${escapeHtml(value)}</div>
    <div style="font-size:12px;color:var(--text-3);">${escapeHtml(cap)}</div>
  </div>`;
}

function renderPortalOverview() {
  const balance = Number(meData?.balance ?? portalState?.wallet?.balance ?? 0);
  const debits = (portalRows("creditTransactions")).filter((tx) => tx.type === "debit");
  const used = debits.reduce((sum, tx) => sum + Math.abs(Number(tx.amountDelta || 0)), 0);
  const quota = Math.max(1, Number(meData?.lifetimeAdded || portalState?.wallet?.lifetimeAdded || balance || 0));
  const pctRem = Math.max(0, Math.min(100, Math.round((balance / Math.max(1, quota)) * 100)));
  const barCol = balance <= 5 ? "var(--danger)" : pctRem <= 20 ? "#d97706" : "var(--brand)";
  const days = Math.max(1, Math.round(balance / 20));

  const stats = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:14px;margin-bottom:18px;">
    ${statCard({ label: "Số dư credit", value: formatCredit(balance), cap: `đủ dùng ~${days} ngày`, highlight: true })}
    ${statCard({ label: "Gói hiện tại", value: "Pro", cap: "gia hạn 15/07/2026" })}
    ${statCard({ label: "Đã dùng tháng này", value: formatCredit(used), cap: `trên ${formatCredit(quota)} credit` })}
    ${statCard({ label: "Thiết bị", value: "1 / 3", cap: "đang đăng nhập" })}
  </div>`;

  const assistantCards = services.map((service, index) => {
    const accent = serviceAccent(service, index);
    return `<div data-open-service="${escapeHtml(service.id)}" style="display:flex;flex-direction:column;gap:9px;padding:12px 13px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);cursor:pointer;" onmouseover="this.style.borderColor='var(--brand)'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <div style="width:32px;height:32px;border-radius:9px;background:${accent};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;flex-shrink:0;">${escapeHtml(initials(service.name))}</div>
        <span style="font-size:10px;font-weight:700;color:var(--text-3);background:var(--surface-3);border:1px solid var(--border-soft);border-radius:6px;padding:2px 6px;white-space:nowrap;">${escapeHtml(serviceCost(service))}</span>
      </div>
      <div style="font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(service.name)}</div>
      <div style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:var(--brand);">Mở<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div>
    </div>`;
  }).join("");
  const assistant = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:16px;">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;"><div style="font-size:15px;font-weight:700;color:var(--text);">Trợ lý AI của bạn</div><div style="font-size:12px;color:var(--text-3);">Bấm để mở — trừ credit theo từng dịch vụ</div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(138px,1fr));gap:10px;">${assistantCards || `<div class="portal-empty">Chưa có dịch vụ.</div>`}</div>
  </div>`;

  const credit = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;margin-bottom:18px;box-shadow:0 1px 3px var(--shadow);">
    <div style="border:1px solid var(--border-soft);border-radius:12px;padding:16px 18px;background:var(--surface-2);">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;"><div style="font-size:12px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;">Số dư credit cá nhân</div><span style="font-size:11px;font-weight:600;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:999px;padding:3px 9px;">Gói Pro · ${formatCredit(quota)} cr/tháng</span></div>
      <div style="display:flex;align-items:baseline;gap:7px;"><div style="font-size:28px;font-weight:700;color:var(--text);letter-spacing:-.02em;line-height:1;">${formatCredit(balance)}</div><div style="font-size:13px;color:var(--text-3);">/ ${formatCredit(quota)} cr còn lại</div></div>
      <div style="height:11px;border-radius:7px;background:var(--surface-3);overflow:hidden;margin:13px 0 8px;"><div style="height:100%;border-radius:7px;width:${pctRem}%;background:${barCol};transition:width .35s ease;"></div></div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span style="font-size:11.5px;font-weight:700;color:${barCol};">${pctRem}% còn lại</span><span style="font-size:11.5px;color:var(--text-3);">đã dùng ${formatCredit(used)} cr</span></div>
      <div style="display:flex;gap:9px;margin-top:14px;flex-wrap:wrap;"><button data-go-view="buy" style="font-size:12.5px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:9px;padding:8px 15px;cursor:pointer;">Mua thêm credit</button><button data-go-view="history" style="font-size:12.5px;font-weight:600;color:var(--text);background:var(--surface);border:1px solid var(--field-border);border-radius:9px;padding:8px 15px;cursor:pointer;">Xem lịch sử dùng</button></div>
    </div>
  </div>`;

  const acts = portalRows("creditTransactions").slice().reverse().slice(0, 4);
  const activityRows = acts.length
    ? acts.map((tx) => {
        const delta = Number(tx.amountDelta || 0);
        const dot = delta < 0 ? "var(--brand)" : "var(--ok)";
        const title = delta < 0 ? `Dùng ${tx.serviceId || "model"} · ${formatCredit(delta)} credit` : `Nạp ${formatCredit(delta)} credit`;
        return `<div style="display:flex;gap:11px;"><div style="width:9px;height:9px;border-radius:50%;background:${dot};margin-top:5px;flex-shrink:0;"></div><div><div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(title)}</div><div style="font-size:11.5px;color:var(--text-3);margin-top:1px;">${escapeHtml(relativeTime(Date.parse(tx.createdAt) || Date.now()))}</div></div></div>`;
      }).join("")
    : `<div class="portal-empty">Chưa có hoạt động nào.</div>`;
  const activity = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;">
    <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px;">Hoạt động gần đây</div>
    <div style="display:flex;flex-direction:column;gap:13px;">${activityRows}</div>
  </div>`;

  return stats + assistant + credit + activity;
}

function usageRows() {
  const tx = portalRows("creditTransactions");
  if (!tx.length) return [];
  return tx.slice().reverse().slice(0, 12).map((t) => {
    const d = Number(t.amountDelta || 0);
    return {
      title: d < 0 ? `Dùng ${t.serviceId || "model"}` : `Nạp credit`,
      time: relativeTime(Date.parse(t.createdAt) || Date.now()),
      meta: `${d > 0 ? "+" : ""}${formatCredit(d)} credit`,
      kind: d < 0 ? "debit" : "credit"
    };
  });
}

function renderPortalHistory() {
  const rows = usageRows();
  return `<div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px;">Lịch sử sử dụng</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${rows.length ? rows.map((ev) => {
        const accent = ev.kind === "credit" ? "var(--ok)" : ev.kind === "plan" ? "var(--brand)" : "var(--brand)";
        const metaColor = ev.kind === "credit" ? "var(--ok-text)" : ev.kind === "plan" ? "var(--text-2)" : "var(--danger)";
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid var(--border-soft);border-left:4px solid ${accent};border-radius:12px;background:var(--surface);padding:13px 16px;"><div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;color:var(--text);">${escapeHtml(ev.title)}</div><div style="font-size:12px;color:var(--text-3);margin-top:2px;">${escapeHtml(ev.time)}</div></div><span style="font-size:13px;font-weight:700;color:${metaColor};white-space:nowrap;flex-shrink:0;">${escapeHtml(ev.meta)}</span></div>`;
      }).join("") : `<div class="portal-empty">Chua co giao dich credit nao tu API.</div>`}
    </div>`;
}

let buyState = { pkg: "p500", pay: "vietqr", promo: "" };

function renderPortalBuy() {
  const pkgs = portalRows("packages").map((pkg) => ({
    id: pkg.id,
    credit: formatCredit(Number(pkg.credits || 0) + Number(pkg.bonusCredits || 0)),
    price: formatMoney(pkg.price, pkg.currency || "VND"),
    bonus: Number(pkg.bonusCredits || 0) > 0 ? `+${formatCredit(pkg.bonusCredits)} credit` : ""
  }));
  if (!pkgs.length) return `<div class="portal-empty">Chua co goi nap credit nao tu Server.</div>`;
  const sel = pkgs.find((p) => p.id === buyState.pkg) || pkgs[0];
  const payments = portalPaymentMethods();
  const pay = payments.find((p) => p.id === buyState.pay) || payments[0];
  const promotions = portalRows("promotions").filter((row) => row.enabled !== false);
  const pkgCards = pkgs.map((p) => {
    const active = p.id === buyState.pkg;
    return `<div data-buy-pkg="${p.id}" style="border:2px solid ${active ? "var(--brand)" : "var(--border)"};background:${active ? "var(--brand-soft)" : "var(--surface)"};border-radius:13px;padding:16px 18px;cursor:pointer;position:relative;">${p.bonus ? `<span style="position:absolute;top:11px;right:11px;font-size:10px;font-weight:700;color:var(--ok-text);background:var(--ok-soft);border:1px solid var(--ok-border);border-radius:999px;padding:2px 7px;">${escapeHtml(p.bonus)}</span>` : ""}<div style="font-size:22px;font-weight:700;color:var(--brand);">${escapeHtml(p.credit)}</div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:9px;">credit</div><div style="font-size:15px;font-weight:700;color:var(--text);">${escapeHtml(p.price)}</div></div>`;
  }).join("");
  const payRows = payments.map((pm) => {
    const active = pm.id === buyState.pay;
    return `<div data-buy-pay="${pm.id}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;border:2px solid ${active ? "var(--brand)" : "var(--border)"};background:${active ? "var(--brand-soft)" : "var(--surface)"};border-radius:12px;cursor:pointer;"><div><div style="font-size:13.5px;font-weight:600;color:var(--text);">${escapeHtml(pm.name)}</div><div style="font-size:12px;color:var(--text-3);">${escapeHtml(pm.desc)}</div></div><div style="width:20px;height:20px;border-radius:50%;border:2px solid ${active ? "var(--brand)" : "var(--field-border)"};display:flex;align-items:center;justify-content:center;flex-shrink:0;"><div style="width:10px;height:10px;border-radius:50%;background:${active ? "var(--brand)" : "transparent"};"></div></div></div>`;
  }).join("");
  const promoChips = promotions.length
    ? promotions.map((pr) => `<div data-buy-promo="${escapeHtml(pr.code || pr.id)}" style="font-size:11px;font-weight:600;padding:5px 10px;border-radius:999px;cursor:pointer;border:1px dashed var(--brand-border);color:var(--brand);background:var(--surface);"><b style="font-family:ui-monospace,Consolas,monospace;">${escapeHtml(pr.code || pr.id)}</b> - ${escapeHtml(pr.deal || pr.description || pr.name || "")}</div>`).join("")
    : `<div class="portal-empty" style="padding:8px 10px;">Chua co khuyen mai tu Server.</div>`;
  const activePromo = promotions.find((pr) => (pr.code || pr.id) === buyState.promo);
  return `<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:18px;align-items:start;">
    <div>
      <div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px;">Chọn gói credit</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">${pkgCards}</div>
      <div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin:20px 0 12px;">Phương thức thanh toán</div>
      <div style="display:flex;flex-direction:column;gap:10px;">${payRows}</div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:15px;box-shadow:0 1px 3px var(--shadow);padding:22px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:16px;">Tóm tắt đơn</div>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-2);margin-bottom:9px;"><span>Gói credit</span><b style="color:var(--text);">${escapeHtml(sel.credit)} credit</b></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-2);margin-bottom:9px;"><span>Phương thức</span><b style="color:var(--text);">${escapeHtml(pay.name)}</b></div>
      <div style="padding-bottom:13px;border-bottom:1px solid var(--border-soft);">
        <div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;">Mã khuyến mãi</div>
        ${activePromo ? `<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--ok-soft);border:1px solid var(--ok-border);border-radius:9px;margin-bottom:10px;"><span style="font-family:ui-monospace,Consolas,monospace;font-size:12px;font-weight:700;color:var(--ok-text);">${escapeHtml(activePromo.code || activePromo.id)}</span><span style="font-size:12px;color:var(--text-2);flex:1;">${escapeHtml(activePromo.desc || activePromo.description || activePromo.name || "")}</span><span data-buy-promo="" style="font-size:13px;color:var(--text-3);cursor:pointer;font-weight:700;">x</span></div>` : ""}
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${promoChips}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin:13px 0 16px;"><span style="font-size:14px;font-weight:600;color:var(--text);">Tổng cộng</span><span style="font-size:20px;font-weight:700;color:var(--brand);">${escapeHtml(sel.price)}</span></div>
      ${pay.qr ? `<div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:12px;margin-bottom:14px;"><div style="width:112px;height:112px;border-radius:10px;background:repeating-linear-gradient(45deg,var(--text-3) 0 4px,transparent 4px 8px);opacity:.45;"></div><div style="font-size:11.5px;color:var(--text-3);">Quét mã VietQR để thanh toán</div></div>` : ""}
      <button data-topup-package="${escapeHtml(sel.id)}" style="width:100%;font-size:14.5px;font-weight:700;color:#fff;background:var(--brand);border:none;border-radius:11px;padding:13px;cursor:pointer;box-shadow:0 6px 16px var(--brand-shadow);">Thanh toán ${escapeHtml(sel.price)}</button>
    </div>
  </div>`;
}

function renderPortalPlans() {
  const plans = portalRows("plans").map((plan, index) => ({
    name: plan.name || plan.id || "Plan",
    price: formatMoney(plan.price, plan.currency || "VND"),
    cycle: plan.interval ? `/${plan.interval}` : "/tháng",
    credits: plan.credits ? `${formatCredit(plan.credits)} credit/tháng` : "Theo cấu hình Server",
    features: Array.isArray(plan.features) && plan.features.length ? plan.features : ["Quản lý credit", "Mở dịch vụ theo quyền", "Hỗ trợ qua App Server"],
    btn: index === 0 ? "Đang hiển thị" : "Chọn gói",
    current: index === 0,
    perNote: plan.description || ""
  }));
  if (!plans.length) return `<div class="portal-empty">Chua co goi cuoc nao tu Server.</div>`;
  return `<div style="display:flex;align-items:center;gap:10px;padding:12px 16px;margin-bottom:16px;background:var(--surface);border:1px solid var(--border);border-radius:12px;">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path></svg>
    <div style="font-size:12.5px;color:var(--text-2);">Gói cước thanh toán <b style="color:var(--text);">bằng tiền</b> theo kỳ · mỗi gói <b style="color:var(--text);">tự cấp credit mỗi tháng</b> và mở quyền dùng model — không trừ vào credit hiện có.</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;">
    ${plans.map((p) => `<div style="border:1.5px solid ${p.current ? "var(--brand)" : "var(--border)"};background:${p.current ? "var(--brand-soft)" : "var(--surface)"};border-radius:16px;padding:22px;display:flex;flex-direction:column;"><div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(p.name)}</span>${p.current ? `<span style="font-size:10px;font-weight:700;color:#fff;background:var(--brand);border-radius:999px;padding:3px 9px;">Đang dùng</span>` : ""}</div><div style="margin:13px 0 4px;"><span style="font-size:30px;font-weight:700;color:${p.current ? "var(--brand)" : "var(--text)"};letter-spacing:-.02em;">${escapeHtml(p.price)}</span><span style="font-size:13px;color:var(--text-3);"> ${escapeHtml(p.cycle)}</span></div><div style="font-size:13px;font-weight:600;color:var(--brand);margin-bottom:16px;">${escapeHtml(p.credits)}</div>${p.perNote ? `<div style="font-size:11.5px;color:var(--ok-text);background:var(--ok-soft);border:1px solid var(--ok-border);border-radius:8px;padding:6px 10px;margin:-8px 0 14px;">${escapeHtml(p.perNote)}</div>` : ""}<div style="display:flex;flex-direction:column;gap:9px;flex:1;">${p.features.map((f) => `<div style="display:flex;align-items:flex-start;gap:9px;font-size:13px;color:var(--text-2);"><span style="color:var(--brand);font-weight:700;flex-shrink:0;">✓</span>${escapeHtml(f)}</div>`).join("")}</div><button style="margin-top:18px;width:100%;font-size:13.5px;font-weight:600;color:${p.current ? "var(--text-3)" : "#fff"};background:${p.current ? "var(--surface-2)" : "var(--brand)"};border:1px solid ${p.current ? "var(--border)" : "var(--brand)"};border-radius:10px;padding:12px;cursor:pointer;">${escapeHtml(p.btn)}</button></div>`).join("")}
  </div>`;
}

function renderPortalInvoices() {
  const inv = portalRows("invoices").map((row) => ({
    id: row.id || row.invoiceId || "invoice",
    desc: row.description || row.title || row.item || row.packageId || "Invoice",
    date: row.date || String(row.createdAt || "").slice(0, 10),
    rawAmount: Number(row.amount || 0),
    amount: formatMoney(row.amount, row.currency || "VND"),
    vat: row.vatStatus || row.vat || row.status || "pending"
  }));
  if (!inv.length) return `<div class="portal-empty">Chua co hoa don nao tu Server.</div>`;
  const vatCount = inv.filter((i) => i.vat === "done").length;
  const totalSpend = inv.reduce((sum, row) => sum + Number(row.rawAmount || 0), 0);
  const v = portalVatInfo();
  const fld = (label, value, ro) => `<div${label === "Họ tên / Tên công ty" || label === "Địa chỉ" ? ` style="grid-column:1 / -1;"` : ""}><div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">${label}</div><input value="${escapeHtml(value)}" ${ro ? "readonly" : ""} style="width:100%;font-size:13.5px;color:${ro ? "var(--text-2)" : "var(--text)"};background:${ro ? "var(--surface-2)" : "var(--field-bg)"};border:1px solid var(--field-border);border-radius:10px;padding:11px 13px;" /></div>`;
  const rows = inv.map((iv) => {
    const done = iv.vat === "done";
    const vc = done ? "var(--ok-text)" : "#d97706";
    const vbg = done ? "var(--ok-soft)" : "rgba(217,119,6,.1)";
    const vbd = done ? "var(--ok-border)" : "rgba(217,119,6,.3)";
    const act = done
      ? `<button title="Tải PDF" style="width:28px;height:28px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text-2);cursor:pointer;display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11M8 11l4 4 4-4M5 21h14"></path></svg></button>`
      : `<button style="font-size:11.5px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:8px;padding:6px 11px;cursor:pointer;white-space:nowrap;">Xuất VAT</button>`;
    return `<div style="display:grid;grid-template-columns:148px 1fr 96px 104px 118px 116px;gap:10px;padding:13px 20px;border-bottom:1px solid var(--border-soft);align-items:center;"><span style="font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-weight:600;color:var(--text);">${escapeHtml(iv.id)}</span><span style="font-size:13px;color:var(--text);">${escapeHtml(iv.desc)}</span><span style="font-size:12px;color:var(--text-2);">${escapeHtml(iv.date)}</span><span style="text-align:right;font-size:13px;font-weight:700;color:var(--text);">${escapeHtml(iv.amount)}</span><span><span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:${vc};background:${vbg};border:1px solid ${vbd};border-radius:999px;padding:3px 9px;white-space:nowrap;"><span style="width:5px;height:5px;border-radius:50%;background:currentColor;"></span>${done ? "Đã xuất VAT" : "Chưa xuất"}</span></span><div style="display:flex;gap:5px;justify-content:flex-end;align-items:center;">${act}</div></div>`;
  }).join("");
  return `<div style="display:flex;flex-direction:column;gap:16px;">
    <div><div style="font-size:18px;font-weight:700;color:var(--text);letter-spacing:-.01em;">Hóa đơn &amp; xuất VAT</div><div style="font-size:12.5px;color:var(--text-3);margin-top:3px;">Quản lý hóa đơn điện tử và thông tin xuất VAT của bạn</div></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
      <div style="background:linear-gradient(135deg,var(--brand),var(--brand-strong));border-radius:14px;padding:16px 18px;"><div style="font-size:10.5px;font-weight:700;color:rgba(255,255,255,.85);letter-spacing:.07em;text-transform:uppercase;">Tổng chi tiêu</div><div style="font-size:20px;font-weight:700;color:#fff;margin:6px 0 2px;letter-spacing:-.02em;">${escapeHtml(formatMoney(totalSpend))}</div><div style="font-size:11.5px;color:rgba(255,255,255,.9);">${inv.length} hóa đơn đã thanh toán</div></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;"><div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.07em;text-transform:uppercase;">Số hóa đơn</div><div style="font-size:20px;font-weight:700;color:var(--text);margin:6px 0 2px;letter-spacing:-.02em;">${inv.length}</div><div style="font-size:11.5px;color:var(--text-3);">trong 12 tháng gần nhất</div></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;"><div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.07em;text-transform:uppercase;">Đã xuất VAT</div><div style="font-size:20px;font-weight:700;color:var(--ok-text);margin:6px 0 2px;letter-spacing:-.02em;">${vatCount}<span style="font-size:14px;color:var(--text-3);font-weight:600;"> / ${inv.length}</span></div><div style="font-size:11.5px;color:var(--text-3);">hóa đơn GTGT đã phát hành</div></div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);padding:20px 22px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px;">Thông tin người nhận hóa đơn</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:13px 16px;">
        ${fld("Họ tên / Tên công ty", v.name)}
        ${fld("Mã số thuế", v.mst)}
        ${fld("Email nhận hóa đơn", v.email)}
        ${fld("Địa chỉ", v.addr)}
      </div>
      <div style="display:flex;gap:9px;margin-top:16px;flex-wrap:wrap;"><button style="font-size:13px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:9px;padding:10px 18px;cursor:pointer;">Lưu thông tin</button></div>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
      <div style="padding:16px 20px 14px;font-size:15px;font-weight:700;color:var(--text);">Hóa đơn của tôi</div>
      <div style="display:grid;grid-template-columns:148px 1fr 96px 104px 118px 116px;gap:10px;padding:11px 20px;border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.05em;text-transform:uppercase;background:var(--surface-2);"><span>Mã HĐ</span><span>Nội dung</span><span>Ngày</span><span style="text-align:right;">Số tiền</span><span>VAT</span><span style="text-align:right;">Thao tác</span></div>
      ${rows}
    </div>
  </div>`;
}

function renderPortalDevices() {
  const deviceRows = portalRows("devices");
  const rows = deviceRows.length
    ? deviceRows.map((d) => {
        const current = String(d.deviceId || "") === String(state.deviceId || "");
        const lastSeen = d.lastSeenAt ? relativeTime(Date.parse(d.lastSeenAt) || Date.now()) : "";
        return `<div style="display:grid;grid-template-columns:1fr 150px 140px 120px;gap:12px;padding:14px 4px;border-bottom:1px solid var(--border-soft);align-items:center;"><span style="font-size:13.5px;font-weight:600;color:var(--text);">${escapeHtml(d.deviceId || d.id || "device")}</span><span style="font-size:12.5px;color:var(--text-2);">${escapeHtml(d.profileId || "-")}</span><span style="font-size:12.5px;color:var(--text-3);">${escapeHtml(lastSeen)}</span><div style="display:flex;justify-content:flex-end;">${current ? `<span style="font-size:11px;font-weight:700;color:var(--ok-text);background:var(--ok-soft);border:1px solid var(--ok-border);border-radius:999px;padding:3px 10px;">Thiết bị này</span>` : `<span style="font-size:11px;font-weight:700;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:3px 10px;">Đang đăng nhập</span>`}</div></div>`;
      }).join("")
    : `<div class="portal-empty">Chua co session thiet bi nao tu Server.</div>`;
  return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);padding:20px 22px;">
    <div style="font-size:15px;font-weight:700;color:var(--text);">Thiết bị đăng nhập</div>
    <div style="font-size:12.5px;color:var(--text-3);margin-bottom:16px;">Các thiết bị đang dùng tài khoản này. Đăng xuất thiết bị lạ để bảo mật.</div>
    <div style="display:grid;grid-template-columns:1fr 150px 140px 120px;gap:12px;padding:0 4px 11px;border-bottom:1px solid var(--border-soft);font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;"><span>Thiết bị</span><span>Vị trí</span><span>Hoạt động</span><span style="text-align:right;">Trạng thái</span></div>
    ${rows}
  </div>`;
}

function renderPortalAccount() {
  const user = portalState?.user || {};
  const email = state.email || user.email || "";
  const userName = user.name || state.email || "";
  const phone = user.phone || user.phoneNumber || "";
  const fld = (label, value, opts = {}) => `<div${opts.full ? ` style="grid-column:1 / -1;"` : ""}><div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">${label}</div><input ${opts.type ? `type="${opts.type}"` : ""} value="${escapeHtml(value || "")}" ${opts.ph ? `placeholder="${escapeHtml(opts.ph)}"` : ""} ${opts.ro ? "readonly" : ""} style="width:100%;font-size:13.5px;color:${opts.ro ? "var(--text-2)" : "var(--text)"};background:${opts.ro ? "var(--surface-2)" : "var(--field-bg)"};border:1px solid var(--field-border);border-radius:10px;padding:10px 13px;" /></div>`;
  return `<div style="display:grid;grid-template-columns:1.2fr 1fr;gap:18px;align-items:start;">
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);padding:22px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:16px;">Thông tin cá nhân</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        ${fld("Họ và tên", userName)}
        ${fld("Số điện thoại", phone)}
        ${fld("Email", email, { full: true, ro: true })}
        ${fld("Ngôn ngữ", "Tiếng Việt", { full: true })}
      </div>
      <button style="margin-top:16px;font-size:13.5px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:11px 20px;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Lưu thay đổi</button>
    </div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);padding:22px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:16px;">Đổi mật khẩu</div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        ${fld("Mật khẩu hiện tại", "", { type: "password" })}
        ${fld("Mật khẩu mới", "", { type: "password", ph: "Tối thiểu 8 ký tự" })}
        ${fld("Nhập lại mật khẩu mới", "", { type: "password" })}
        <button style="margin-top:4px;font-size:13.5px;font-weight:600;color:var(--text);background:var(--surface);border:1px solid var(--field-border);border-radius:10px;padding:11px;cursor:pointer;">Cập nhật mật khẩu</button>
      </div>
    </div>
  </div>`;
}

function renderPortalSupport() {
  const faqs = portalArraySetting(["faqs", "supportFaqs", "support-faqs"]);
  const faqRows = faqs.length
    ? faqs.map((fq) => `<div><div style="font-size:13.5px;font-weight:600;color:var(--text);margin-bottom:4px;">${escapeHtml(fq.q || fq.question || fq.title || "")}</div><div style="font-size:12.5px;color:var(--text-2);line-height:1.5;">${escapeHtml(fq.a || fq.answer || fq.description || "")}</div></div>`).join("")
    : `<div class="portal-empty">Chua co FAQ tu Server.</div>`;
  const ticketRows = portalRows("tickets").slice().reverse().slice(0, 5).map((ticket) => (
    `<div style="border:1px solid var(--border-soft);border-radius:10px;padding:10px 12px;background:var(--surface-2);"><div style="font-size:12.5px;font-weight:700;color:var(--text);">${escapeHtml(ticket.subject || ticket.title || ticket.id)}</div><div style="font-size:11.5px;color:var(--text-3);margin-top:2px;">${escapeHtml(ticket.status || "open")} - ${escapeHtml(relativeTime(Date.parse(ticket.createdAt) || Date.now()))}</div></div>`
  )).join("");
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start;">
    <form id="supportTicketForm" style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);padding:20px 22px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px;">Gửi yêu cầu hỗ trợ</div>
      <div style="font-size:12.5px;color:var(--text-3);margin-bottom:16px;">Đội ngũ CentriX thường phản hồi trong vài giờ.</div>
      <div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Tiêu đề</div>
      <input id="supportSubjectInput" placeholder="Ví dụ: Không trừ đúng credit" style="width:100%;font-size:13.5px;color:var(--text);background:var(--field-bg);border:1px solid var(--field-border);border-radius:10px;padding:11px 13px;margin-bottom:12px;" />
      <div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Nội dung</div>
      <textarea id="supportMessageInput" placeholder="Mô tả vấn đề bạn gặp phải…" style="width:100%;height:96px;resize:vertical;font-size:13.5px;color:var(--text);background:var(--field-bg);border:1px solid var(--field-border);border-radius:10px;padding:11px 13px;margin-bottom:14px;"></textarea>
      <button type="submit" style="width:100%;font-size:14px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:12px;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Gửi yêu cầu</button>
    </form>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);padding:20px 22px;">
      <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px;">Câu hỏi thường gặp</div>
      <div style="display:flex;flex-direction:column;gap:14px;">${faqRows}</div>
      <div style="font-size:15px;font-weight:700;color:var(--text);margin:18px 0 10px;">Ticket gần đây</div>
      <div style="display:flex;flex-direction:column;gap:8px;">${ticketRows || `<div class="portal-empty">Chua co ticket nao tu Server.</div>`}</div>
    </div>
  </div>`;
}

const PORTAL_RENDERERS = {
  overview: renderPortalOverview,
  history: renderPortalHistory,
  buy: renderPortalBuy,
  plans: renderPortalPlans,
  invoices: renderPortalInvoices,
  devices: renderPortalDevices,
  account: renderPortalAccount,
  support: renderPortalSupport
};

function renderPortal() {
  if (!els.portalPanel || !state.connected) return;
  if (!PORTAL_RENDERERS[portalView]) portalView = "overview";
  for (const button of els.portalTabs || []) {
    button.classList.toggle("is-active", button.dataset.userView === portalView);
  }
  els.portalPanel.innerHTML = (PORTAL_RENDERERS[portalView] || renderPortalOverview)();
  bindPortalPanelActions();
}

async function refreshPortal() {
  if (!state.connected || !api.portal?.summary) return;
  const result = await api.portal.summary().catch(() => null);
  if (!result || result.ok === false) return;
  portalState = result.portal || null;
  lastPortalRefreshAt = Date.now();
  renderPortal();
}

async function refreshPortalIfStale() {
  if (!state.connected || !api.portal?.summary) return;
  if (portalState && Date.now() - lastPortalRefreshAt < PORTAL_REFRESH_INTERVAL_MS) return;
  await refreshPortal();
}

function bindPortalPanelActions() {
  for (const el of els.portalPanel.querySelectorAll("[data-open-service]")) {
    el.addEventListener("click", () => openService(el.dataset.openService));
  }
  for (const el of els.portalPanel.querySelectorAll("[data-go-view]")) {
    el.addEventListener("click", () => setPortalView(el.dataset.goView));
  }
  for (const el of els.portalPanel.querySelectorAll("[data-buy-pkg]")) {
    el.addEventListener("click", () => { buyState.pkg = el.dataset.buyPkg; renderPortal(); });
  }
  for (const el of els.portalPanel.querySelectorAll("[data-buy-pay]")) {
    el.addEventListener("click", () => { buyState.pay = el.dataset.buyPay; renderPortal(); });
  }
  for (const el of els.portalPanel.querySelectorAll("[data-buy-promo]")) {
    el.addEventListener("click", () => { buyState.promo = el.dataset.buyPromo; renderPortal(); });
  }
  for (const button of els.portalPanel.querySelectorAll("[data-topup-package]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await api.portal.topupRequest({ packageId: button.dataset.topupPackage });
        portalState = result.portal || portalState;
        setLoginStatus("Đã gửi yêu cầu nạp credit. Admin duyệt thì ví sẽ cập nhật.", "ok");
        renderPortal();
      } catch (error) {
        setLoginStatus(error.message || "Không gửi được yêu cầu nạp.", "error");
      } finally {
        button.disabled = false;
      }
    });
  }

  const form = els.portalPanel.querySelector("#supportTicketForm");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const subject = els.portalPanel.querySelector("#supportSubjectInput")?.value || "";
    const message = els.portalPanel.querySelector("#supportMessageInput")?.value || "";
    try {
      const result = await api.portal.supportTicket({ subject, message });
      portalState = result.portal || portalState;
      setLoginStatus("Đã gửi ticket hỗ trợ.", "ok");
      renderPortal();
    } catch (error) {
      setLoginStatus(error.message || "Không gửi được ticket.", "error");
    }
  });
}

async function refreshMe() {
  if (!state.connected || !api.account?.me) return;
  const me = await api.account.me().catch(() => null);
  if (!me || me.ok === false) return;
  meData = me;
  const balance = Number(me.balance || 0);
  lastCreditMax = Math.max(lastCreditMax, balance, Number(me.lifetimeAdded || 0) || 0) || balance || 1;
  if (els.creditMeter) els.creditMeter.classList.remove("hidden");
  if (els.creditBalance) els.creditBalance.textContent = balance.toLocaleString("vi-VN");
  if (els.creditBar) {
    const pct = lastCreditMax > 0 ? Math.max(2, Math.min(100, Math.round((balance / lastCreditMax) * 100))) : 0;
    els.creditBar.style.width = `${pct}%`;
    els.creditBar.classList.toggle("low", balance <= 5);
  }
}

function updateCreditMeterFromBalance(balanceValue) {
  const balance = Number(balanceValue || 0);
  lastCreditMax = Math.max(lastCreditMax, balance) || balance || 1;
  if (els.creditMeter) els.creditMeter.classList.remove("hidden");
  if (els.creditBalance) els.creditBalance.textContent = balance.toLocaleString("vi-VN");
  if (els.creditBar) {
    const pct = lastCreditMax > 0 ? Math.max(2, Math.min(100, Math.round((balance / lastCreditMax) * 100))) : 0;
    els.creditBar.style.width = `${pct}%`;
    els.creditBar.classList.toggle("low", balance <= 5);
  }
}

function scheduleCreditRefresh(payload = {}) {
  if (!state.connected) return;

  if (Number.isFinite(Number(payload.balance))) {
    meData = {
      ...(meData || {}),
      balance: Number(payload.balance)
    };
    updateCreditMeterFromBalance(payload.balance);
    if (currentMainView === "home") renderPortal();
  }

  clearTimeout(creditRefreshTimer);
  creditRefreshTimer = setTimeout(() => {
    refreshMe().catch(() => {});
    refreshPortal().catch(() => {});
  }, 650);
  try {
    window.dispatchEvent(new CustomEvent("centrix:credit-usage", { detail: payload }));
  } catch {
    // Bridge refresh is best-effort; the credit meter has already been updated.
  }

  if (payload.allowed === false) {
    setLoginStatus(payload.message || "Request bi chan theo credit/policy.", "error");
  }
}

function measureBrowserViewport() {
  const rect = els.browserViewport?.getBoundingClientRect?.() || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const left = Math.max(0, Math.round(rect.left ?? rect.x ?? 0));
  const top = Math.max(0, Math.round(rect.top ?? rect.y ?? 0));
  const right = Math.min(window.innerWidth, Math.round(rect.right ?? (left + rect.width)));
  const bottom = Math.min(window.innerHeight, Math.round(rect.bottom ?? (top + rect.height)));
  return {
    x: left,
    y: top,
    width: Math.max(360, right - left),
    height: Math.max(320, bottom - top)
  };
}

let boundsFrame = 0;
let lastSentBrowserBounds = null;

function sameBounds(a, b, tolerance = 0) {
  return Boolean(
    a &&
    b &&
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

function pushBrowserBounds() {
  if (!state.connected) return;
  if (currentMainView !== "browser" && currentMainView !== "opening") return;
  const bounds = measureBrowserViewport();
  if (!sameBounds(bounds, lastSentBrowserBounds, 4)) {
    lastSentBrowserBounds = bounds;
    api.browser.setBounds(bounds).catch(() => {});
  }
  return bounds;
}

function syncBrowserBoundsSoon() {
  if (!state.connected) return;
  if (currentMainView !== "browser" && currentMainView !== "opening") return;
  cancelAnimationFrame(boundsFrame);
  boundsFrame = requestAnimationFrame(() => pushBrowserBounds());
}

async function syncBrowserBoundsNow() {
  cancelAnimationFrame(boundsFrame);
  const bounds = measureBrowserViewport();
  if (!sameBounds(bounds, lastSentBrowserBounds, 4)) {
    lastSentBrowserBounds = bounds;
    await api.browser.setBounds(bounds).catch(() => null);
  }
  return bounds;
}

function syncBrowserBoundsBurst() {
  if (!state.connected) return;
  if (currentMainView !== "browser" && currentMainView !== "opening") return;
  cancelAnimationFrame(boundsFrame);
  pushBrowserBounds();
  queueMicrotask(() => pushBrowserBounds());
  requestAnimationFrame(() => {
    pushBrowserBounds();
    requestAnimationFrame(() => pushBrowserBounds());
  });
}

function clampSidebarWidth(value) {
  return Math.max(240, Math.min(440, Math.round(Number(value) || 288)));
}

function applySidebarWidth(value) {
  const width = clampSidebarWidth(value);
  els.appShell.style.setProperty("--sidebar-width", `${width}px`);
  return width;
}

function setSidebarCollapsed(collapsed) {
  els.appShell.classList.toggle("sidebar-collapsed", collapsed);
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  els.sidebarToggle?.setAttribute("aria-expanded", collapsed ? "false" : "true");
  els.sidebarToggle?.setAttribute("title", collapsed ? "Hiện sidebar" : "Ẩn sidebar");
  syncBrowserBoundsBurst();
  for (const delay of [32, 96]) {
    setTimeout(() => pushBrowserBounds(), delay);
  }
}

function loadSavedLayout() {
  const savedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (savedWidth) applySidebarWidth(savedWidth);
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
}

function startSidebarResize(event) {
  if (els.appShell.classList.contains("sidebar-collapsed")) return;
  event.preventDefault();
  document.body.classList.add("is-resizing-sidebar");

  const onMove = (moveEvent) => {
    const shellRect = els.appShell.getBoundingClientRect();
    const shellStyle = getComputedStyle(els.appShell);
    const leftPadding = parseFloat(shellStyle.paddingLeft) || 0;
    const width = applySidebarWidth(moveEvent.clientX - shellRect.left - leftPadding);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    pushBrowserBounds();
  };

  const onUp = () => {
    document.body.classList.remove("is-resizing-sidebar");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    syncBrowserBoundsSoon();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp, { once: true });
}

async function applyBrowserState(browserState) {
  if (!browserState) return;
  if (browserState.activeServiceId) {
    state.activeServiceId = browserState.activeServiceId;
  }
  if (Array.isArray(browserState.openServiceIds)) {
    state.openServiceIds = new Set(browserState.openServiceIds);
  }
  if (Array.isArray(browserState.loadedServiceIds)) {
    state.loadedServiceIds = new Set(browserState.loadedServiceIds);
  }
  if (Array.isArray(browserState.preparingServiceIds)) {
    state.preparingServiceIds = new Set(browserState.preparingServiceIds);
  }
  if (els.navBackButton) els.navBackButton.disabled = !browserState.canGoBack;
  if (els.navForwardButton) els.navForwardButton.disabled = !browserState.canGoForward;
  renderServices();
}

async function connect() {
  const draft = loginDraftFromInputs();
  state.email = draft.email;
  saveLoginDraft();

  if (!draft.email || !draft.password) {
    setLoginStatus("Nhập email và password để đăng nhập.", "error");
    return;
  }

  try {
    els.loginButton.disabled = true;
    state.profileSync = {
      status: "login",
      message: "Đang xác thực tài khoản...",
      initialReady: false,
      storageReady: false,
      error: ""
    };
    setLoginStatus("Đang đăng nhập và lấy cấu hình từ Server...");
    const result = await api.connection.login(draft);

    state.serverUrl = result.connection?.serverUrl || state.serverUrl;
    state.token = result.connection?.token || state.token;
    state.deviceId = result.connection?.deviceId || result.connection?.userId || state.deviceId;
    state.profileId = result.connection?.profileId || state.profileId;
    state.email = result.account?.email || draft.email;
    state.profileSync = {
      status: result.profileSync?.initialReady ? "profile-ready" : "profile-loading",
      message: result.profileSync?.initialReady ? "Profile đã sẵn sàng." : "Đang tải profile từ Server...",
      initialReady: result.profileSync?.initialReady === true,
      storageReady: result.profileSync?.storageReady === true,
      error: ""
    };

    applyServicesConfig(result.config, { forceRender: true });

    state.connected = true;
    saveLogin();
    startServicesPolling();
    els.appShell.classList.remove("locked");
    setAccountIdentity();
    renderServices();
    renderUrlLog();
    refreshMe().catch(() => {});
    refreshPortal().catch(() => {});
    clearInterval(meTimer);
    meTimer = setInterval(() => {
      refreshMe().catch(() => {});
      refreshPortalIfStale().catch(() => {});
    }, ACCOUNT_REFRESH_INTERVAL_MS);
    showLoggedInWelcome();
    setLoginStatus(
      services.length
        ? `Đã kết nối ${state.email} - đã tải ${services.length} dịch vụ từ Server.`
        : `Đã kết nối ${state.email}, nhưng Server chưa cấp dịch vụ nào.`,
      services.length ? "ok" : "error"
    );
  } catch (error) {
    state.connected = false;
    setLoginStatus(friendlyConnectError(error), "error");
  } finally {
    els.loginButton.disabled = false;
  }
}

async function openService(serviceId, targetUrl = "") {
  if (!state.connected) return;
  const service = services.find((item) => item.id === serviceId);
  if (!service) return;
  const requestSerial = ++openServiceSerial;

  const previousServiceId = state.activeServiceId;
  const requestedUrl = cleanUrl(targetUrl);
  const sameActiveService = previousServiceId === service.id;
  const targetAlreadyLoaded = state.loadedServiceIds.has(service.id);
  const hadVisibleBrowser = currentMainView === "browser" && Boolean(previousServiceId);
  const keepCurrentBrowser = hadVisibleBrowser && sameActiveService && targetAlreadyLoaded && !requestedUrl;
  let loadingNoticeStartedAt = 0;

  if (keepCurrentBrowser) {
    state.activeServiceId = service.id;
    renderServices();
    syncBrowserBoundsBurst();
  } else {
    loadingNoticeStartedAt = performance.now();
    state.activeServiceId = service.id;
    renderServices();
    setOpening(service.name, HIDDEN_LOAD_MESSAGE, HIDDEN_LOAD_MESSAGE, false);
    setMainView("opening");
  }

  try {
    if (!keepCurrentBrowser) {
      if (hadVisibleBrowser) {
        await api.browser.home().catch(() => null);
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await waitForLoadingNotice(loadingNoticeStartedAt);
    }
    const bounds = await syncBrowserBoundsNow();
    const browserState = await api.browser.openService({
      serviceId: service.id,
      bounds,
      url: requestedUrl || service.url
    });
    if (requestSerial !== openServiceSerial) return;
    await applyBrowserState(browserState);
    setMainView("browser");
    recordUrlVisit(service.id, browserState?.url || targetUrl || service.url);
    refreshMe().catch(() => {});
  } catch (error) {
    if (requestSerial !== openServiceSerial) return;
    if (keepCurrentBrowser) {
      state.activeServiceId = previousServiceId;
      renderServices();
      setMainView("browser");
    } else {
      setOpening(service.name, error.message || "Không mở được dịch vụ.", "Mở dịch vụ lỗi", true);
    }
    setLoginStatus(error.message || "Không mở được dịch vụ.", "error");
  }
}

async function closeActiveService() {
  try {
    await api.browser.home();
  } catch {
    // best-effort: still return to dashboard
  }
  state.activeServiceId = "";
  setMainView("home");
  renderServices();
  renderPortal();
}

function focusSearchInput() {
  const target = els.urlSearch || els.serviceSearch || document.querySelector("input[type='search'],input");
  target?.focus?.();
  target?.select?.();
}

function toggleThemeFromMenu() {
  const current = els.appShell?.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
}

function openNewChatFromMenu() {
  const current = state.activeServiceId && services.find((service) => service.id === state.activeServiceId);
  const chatService = current || services.find((service) => /chatgpt/i.test(service.name || "")) || services[0];
  if (chatService?.id) openService(chatService.id);
}

function registerNativeMenuHandlers() {
  if (!api?.on) return;
  const listen = (channel, handler) => {
    try {
      api.on(channel, handler);
    } catch {
      // Older preloads do not expose every menu event.
    }
  };
  listen("menu:new-chat", openNewChatFromMenu);
  listen("menu:open-settings", () => setPortalView("account"));
  listen("menu:find-chat", focusSearchInput);
  listen("menu:delete-chat", closeActiveService);
  listen("menu:toggle-sidebar", () => setSidebarCollapsed(!els.appShell.classList.contains("sidebar-collapsed")));
  listen("menu:toggle-theme", toggleThemeFromMenu);
  listen("menu:show-shortcuts", () => setLoginStatus("Phím tắt: Ctrl+N, Ctrl+F, Ctrl+B, Ctrl+T, Ctrl+S, F11.", "ok"));
  listen("menu:check-updates", () => setLoginStatus("CentriX AI Desktop v3.6.0 đang là bản hiện tại.", "ok"));
  listen("menu:contact-support", () => setPortalView("support"));
  listen("menu:new-window", () => setLoginStatus("Cửa sổ App User mới đang được xử lý trong main process.", "ok"));
}

async function syncProfile() {
  if (!state.connected) return;
  try {
    setLoginStatus("Đang đồng bộ profile lên Server...");
    await api.profile.push();
    setLoginStatus("Đã đồng bộ profile lên Server.", "ok");
  } catch (error) {
    setLoginStatus(error.message || "Không đồng bộ được profile.", "error");
  }
}

function startServicesPolling() {
  clearInterval(servicesRefreshTimer);
  servicesRefreshTimer = setInterval(async () => {
    if (!state.connected) return;

    try {
      const result = await api.services.refresh();
      const changed = applyServicesConfig(result.config);
      servicePollingFailed = false;
      if (changed) {
        setLoginStatus(`Đã cập nhật dịch vụ từ Server: ${services.length} dịch vụ.`, "ok");
        if (state.activeServiceId && state.openServiceIds.size > 0) {
          renderServices();
          syncBrowserBoundsBurst();
        } else {
          showLoggedInWelcome();
        }
      }
    } catch (error) {
      if (!servicePollingFailed) {
        servicePollingFailed = true;
        setLoginStatus(error.message || "Không cập nhật được dịch vụ từ Server.", "error");
      }
    }
  }, SERVICES_REFRESH_INTERVAL_MS);
}

function stopServicesPolling() {
  clearInterval(servicesRefreshTimer);
  servicesRefreshTimer = 0;
  clearTimeout(creditRefreshTimer);
  creditRefreshTimer = 0;
  clearTimeout(servicesRenderTimer);
  servicesRenderTimer = 0;
  servicePollingFailed = false;
}

async function disconnect() {
  if (!state.connected) return;
  stopServicesPolling();
  clearInterval(meTimer);
  clearTimeout(creditRefreshTimer);
  els.creditMeter?.classList.add("hidden");
  try {
    setLoginStatus("Đang đẩy profile lên Server...");
    await api.connection.disconnect();
  } catch {
    // Disconnect should still reset the local UI even if the server is unreachable.
  }

  state.connected = false;
  openServiceSerial += 1;
  state.openServiceIds = new Set();
  state.loadedServiceIds = new Set();
  state.preparingServiceIds = new Set();
  portalState = null;
  lastPortalRefreshAt = 0;
  state.profileSync = {
    status: "idle",
    message: "",
    initialReady: false,
    storageReady: false,
    error: ""
  };
  els.appShell.classList.add("locked");
  setMainView("home");
  setAccountMenuOpen(false);
  setAccountIdentity();
  setLoginStatus("Đã đồng bộ và ngắt kết nối.", "");
  renderServices();
}

for (const input of [els.emailInput, els.passwordInput]) {
  input.addEventListener("input", saveLoginDraft);
  input.addEventListener("change", saveLoginDraft);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connect();
  });
}

els.loginButton.addEventListener("click", connect);
els.googleLoginButton?.addEventListener("click", () => {
  setLoginStatus("Google OAuth chưa cấu hình trên Server. MVP hiện dùng email/password.", "error");
});
for (const button of els.portalTabs || []) {
  button.addEventListener("click", () => setPortalView(button.dataset.userView));
}
els.sidebarToggle?.addEventListener("click", () => setSidebarCollapsed(true));
els.miniLogoButton?.addEventListener("click", () => setSidebarCollapsed(false));
els.sidebarResizer?.addEventListener("pointerdown", startSidebarResize);
els.reloadButton.addEventListener("click", async () => {
  if (!state.connected) return;
  try {
    await applyBrowserState(await api.browser.reload());
  } catch (error) {
    setLoginStatus(error.message, "error");
  }
});
els.navBackButton?.addEventListener("click", async () => {
  if (!state.connected) return;
  try { await applyBrowserState(await api.browser.back()); } catch { /* ignore */ }
});
els.navForwardButton?.addEventListener("click", async () => {
  if (!state.connected) return;
  try { await applyBrowserState(await api.browser.forward()); } catch { /* ignore */ }
});
els.closeServiceButton?.addEventListener("click", () => closeActiveService());
els.syncButton.addEventListener("click", () => { setAccountMenuOpen(false); syncProfile(); });
els.logoutButton.addEventListener("click", () => { setAccountMenuOpen(false); disconnect(); });

for (const btn of els.themeOpts) {
  btn.addEventListener("click", () => applyTheme(btn.dataset.themeSet));
}
registerNativeMenuHandlers();

for (const btn of document.querySelectorAll("[data-win]")) {
  btn.addEventListener("click", () => {
    const action = btn.dataset.win;
    if (action === "minimize") api.win?.minimize?.();
    else if (action === "maximize") api.win?.maximize?.();
    else if (action === "close") api.win?.close?.();
  });
}

els.accountCard?.addEventListener("click", (event) => {
  event.stopPropagation();
  setAccountMenuOpen(els.acctMenu?.classList.contains("hidden"));
});
document.addEventListener("click", (event) => {
  if (els.acctMenu && !els.acctMenu.classList.contains("hidden") &&
      !els.acctMenu.contains(event.target) && !els.accountCard?.contains(event.target)) {
    setAccountMenuOpen(false);
  }
});

els.serviceSearch.addEventListener("input", () => {
  state.filter = els.serviceSearch.value;
  renderServices();
});

els.urlSearch?.addEventListener("input", () => {
  urlFilter = els.urlSearch.value;
  renderUrlLog();
});

window.addEventListener("resize", () => {
  syncBrowserBoundsSoon();
});

if (window.ResizeObserver && els.browserViewport) {
  const browserBoundsObserver = new ResizeObserver(() => pushBrowserBounds());
  browserBoundsObserver.observe(els.browserViewport);
  if (els.browserCard) browserBoundsObserver.observe(els.browserCard);
  if (els.appShell) browserBoundsObserver.observe(els.appShell);
}

api.on("browser:loading", () => {});

api.on("browser:navigation", applyBrowserState);
api.on("browser:error", (error) => {
  const message = error?.errorDescription || "Browser gặp lỗi tải trang";
  if (currentMainView === "opening") {
    setOpening("", message, "Lỗi tải trang", true);
  } else if (currentMainView === "browser") {
    setLoginStatus(message, "error");
  }
});

api.on("browser:prepare", (payload) => {
  if (!payload) return;
  if (payload.serviceId && state.activeServiceId && payload.serviceId !== state.activeServiceId) return;
  if (currentMainView !== "opening") return;
  setOpening(
    payload.serviceName || "Dịch vụ",
    HIDDEN_LOAD_MESSAGE,
    servicePrepareLabel(payload.status),
    false
  );
});

api.on("credit:usage", (payload) => {
  scheduleCreditRefresh(payload || {});
});

api.on("profile:sync-state", (result) => {
  state.profileSync = {
    status: result?.status || state.profileSync.status,
    message: result?.message || result?.error || state.profileSync.message,
    initialReady: result?.initialReady === true,
    storageReady: result?.storageReady === true,
    error: result?.error || ""
  };

  renderServices();

  if (!state.connected) return;

  if (currentMainView === "home") {
    renderPortal();
  }

  if (result?.ok === false && result?.status === "profile-error") {
    setLoginStatus(result.error || result.message || "Không tải được profile từ Server.", "error");
    return;
  }

  if (result?.status === "profile-ready") {
    setLoginStatus("Profile đã sẵn sàng. Bấm dịch vụ để sử dụng.", "ok");
    return;
  }

  if (result?.status === "storage-ready") {
    setLoginStatus(result.message || "Đã đồng bộ storage nền.", "ok");
    return;
  }

  if (result?.status === "storage-error") {
    setLoginStatus(result.message || result.error || "Storage nền chưa đồng bộ xong.", "error");
  }
});

api.on("profile:background-sync", (result) => {
  if (result?.ok) {
    const storageCount = result.profile?.imported?.storageCount || 0;
    const reloadedTabs = result.reloadedTabs || 0;
    setLoginStatus(
      storageCount
        ? `Đã đồng bộ storage nền (${storageCount} mục) và tự reload ${reloadedTabs} tab.`
        : "Đã kiểm tra storage nền.",
      "ok"
    );
    return;
  }

  setLoginStatus(result?.error || "Đồng bộ storage nền chưa xong.", "error");
});

api.on("connection:expired", () => {
  stopServicesPolling();
  clearInterval(meTimer);
  clearTimeout(creditRefreshTimer);
  els.creditMeter?.classList.add("hidden");
  state.connected = false;
  openServiceSerial += 1;
  state.openServiceIds = new Set();
  state.loadedServiceIds = new Set();
  state.preparingServiceIds = new Set();
  portalState = null;
  lastPortalRefreshAt = 0;
  state.profileSync = { status: "idle", message: "", initialReady: false, storageReady: false, error: "" };
  els.appShell.classList.add("locked");
  setMainView("home");
  setAccountMenuOpen(false);
  setAccountIdentity();
  setLoginStatus("Phiên hết hạn, cần đăng nhập lại.", "error");
  renderServices();
});

loadSavedTheme();
loadFavorites();
loadUrlHistory();
loadSavedLogin();
loadSavedLayout();
setAccountIdentity();
renderServices();
renderUrlLog();
