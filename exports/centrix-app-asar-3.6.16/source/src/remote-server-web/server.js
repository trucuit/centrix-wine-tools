const query = new URLSearchParams(window.location.search);
const token = query.get("token") || localStorage.getItem("centrixServerToken") || "";

if (token) {
  localStorage.setItem("centrixServerToken", token);
}

const els = {
  statusLabel: document.querySelector("#statusLabel"),
  topbarTitle: document.querySelector("#topbarTitle"),
  refreshButton: document.querySelector("#refreshButton"),
  localUrlInput: document.querySelector("#localUrlInput"),
  lanUrlInput: document.querySelector("#lanUrlInput"),
  tokenInput: document.querySelector("#tokenInput"),
  networkStatusInput: document.querySelector("#networkStatusInput"),
  firewallStatusInput: document.querySelector("#firewallStatusInput"),
  publicUrlInput: document.querySelector("#publicUrlInput"),
  apiDomainInput: document.querySelector("#apiDomainInput"),
  tunnelTokenInput: document.querySelector("#tunnelTokenInput"),
  tunnelStatusInput: document.querySelector("#tunnelStatusInput"),
  saveTunnelConfigButton: document.querySelector("#saveTunnelConfigButton"),
  startTunnelButton: document.querySelector("#startTunnelButton"),
  stopTunnelButton: document.querySelector("#stopTunnelButton"),
  copyTunnelButton: document.querySelector("#copyTunnelButton"),
  dashboardRefreshButton: document.querySelector("#dashboardRefreshButton"),
  dashboardCards: document.querySelector("#dashboardCards"),
  loaderServiceSelect: document.querySelector("#loaderServiceSelect"),
  loaderProfileInput: document.querySelector("#loaderProfileInput"),
  loaderTabInput: document.querySelector("#loaderTabInput"),
  loaderUrlInput: document.querySelector("#loaderUrlInput"),
  loaderOpenButton: document.querySelector("#loaderOpenButton"),
  loaderShowButton: document.querySelector("#loaderShowButton"),
  loaderBackButton: document.querySelector("#loaderBackButton"),
  loaderForwardButton: document.querySelector("#loaderForwardButton"),
  loaderReloadButton: document.querySelector("#loaderReloadButton"),
  loaderCloseButton: document.querySelector("#loaderCloseButton"),
  loaderStatus: document.querySelector("#loaderStatus"),
  loaderTitleLabel: document.querySelector("#loaderTitleLabel"),
  loaderUrlLabel: document.querySelector("#loaderUrlLabel"),
  loaderNativeState: document.querySelector("#loaderNativeState"),
  userSelect: document.querySelector("#userSelect"),
  userIdInput: document.querySelector("#userIdInput"),
  userNameInput: document.querySelector("#userNameInput"),
  userProfileInput: document.querySelector("#userProfileInput"),
  userEnabledInput: document.querySelector("#userEnabledInput"),
  creditBalanceLabel: document.querySelector("#creditBalanceLabel"),
  creditSpentLabel: document.querySelector("#creditSpentLabel"),
  creditAdjustInput: document.querySelector("#creditAdjustInput"),
  creditReasonInput: document.querySelector("#creditReasonInput"),
  adjustCreditButton: document.querySelector("#adjustCreditButton"),
  kickUserButton: document.querySelector("#kickUserButton"),
  kickUserStatus: document.querySelector("#kickUserStatus"),
  creditLedgerMini: document.querySelector("#creditLedgerMini"),
  saveUserButton: document.querySelector("#saveUserButton"),
  resetLocalDbButton: document.querySelector("#resetLocalDbButton"),
  localDbStatus: document.querySelector("#localDbStatus"),
  userServiceAccessList: document.querySelector("#userServiceAccessList"),
  userRuleServiceSelect: document.querySelector("#userRuleServiceSelect"),
  userHideSelectorsInput: document.querySelector("#userHideSelectorsInput"),
  selectHideAreaButton: document.querySelector("#selectHideAreaButton"),
  selectReplaceAreaButton: document.querySelector("#selectReplaceAreaButton"),
  visualReplaceTextInput: document.querySelector("#visualReplaceTextInput"),
  addReplaceRuleButton: document.querySelector("#addReplaceRuleButton"),
  replaceRulesList: document.querySelector("#replaceRulesList"),
  userUiCacheList: document.querySelector("#userUiCacheList"),
  userRuleEnabledInput: document.querySelector("#userRuleEnabledInput"),
  previewUserRulesButton: document.querySelector("#previewUserRulesButton"),
  saveUserRulesButton: document.querySelector("#saveUserRulesButton"),
  modelPolicyServiceSelect: document.querySelector("#modelPolicyServiceSelect"),
  modelPriceServiceSelect: document.querySelector("#modelPriceServiceSelect"),
  modelAllowedModelsInput: document.querySelector("#modelAllowedModelsInput"),
  modelCreditCostsInput: document.querySelector("#modelCreditCostsInput"),
  modelPriceList: document.querySelector("#modelPriceList"),
  addModelPriceButton: document.querySelector("#addModelPriceButton"),
  saveModelPricesButton: document.querySelector("#saveModelPricesButton"),
  modelObservedList: document.querySelector("#modelObservedList"),
  modelDefaultInput: document.querySelector("#modelDefaultInput"),
  modelDailyLimitInput: document.querySelector("#modelDailyLimitInput"),
  modelDefaultCreditInput: document.querySelector("#modelDefaultCreditInput"),
  modelPolicyEnabledInput: document.querySelector("#modelPolicyEnabledInput"),
  modelBlockUnknownInput: document.querySelector("#modelBlockUnknownInput"),
  testModelPolicyButton: document.querySelector("#testModelPolicyButton"),
  saveModelPolicyButton: document.querySelector("#saveModelPolicyButton"),
  activityUserSelect: document.querySelector("#activityUserSelect"),
  activityRefreshButton: document.querySelector("#activityRefreshButton"),
  activityList: document.querySelector("#activityList"),
  ledgerRefreshButton: document.querySelector("#ledgerRefreshButton"),
  creditLedgerList: document.querySelector("#creditLedgerList"),
  organizationList: document.querySelector("#organizationList"),
  departmentList: document.querySelector("#departmentList"),
  memberList: document.querySelector("#memberList"),
  orgTransactionList: document.querySelector("#orgTransactionList"),
  analyticsCards: document.querySelector("#analyticsCards"),
  planList: document.querySelector("#planList"),
  creditPackageList: document.querySelector("#creditPackageList"),
  topupOrderList: document.querySelector("#topupOrderList"),
  invoiceList: document.querySelector("#invoiceList"),
  promotionList: document.querySelector("#promotionList"),
  manualInterventionList: document.querySelector("#manualInterventionList"),
  interventionLogList: document.querySelector("#interventionLogList"),
  supportTicketList: document.querySelector("#supportTicketList"),
  notificationList: document.querySelector("#notificationList"),
  rolePermissionList: document.querySelector("#rolePermissionList"),
  appSettingsList: document.querySelector("#appSettingsList"),
  aiIntegrationList: document.querySelector("#aiIntegrationList"),
  assistantOpsList: document.querySelector("#assistantOpsList"),
  assistantRefreshButton: document.querySelector("#assistantRefreshButton"),
  portalAddButtons: Array.from(document.querySelectorAll("[data-portal-add]")),
  serviceList: document.querySelector("#serviceList"),
  serviceForm: document.querySelector("#serviceForm"),
  serviceNameInput: document.querySelector("#serviceNameInput"),
  serviceUrlInput: document.querySelector("#serviceUrlInput"),
  serviceLoginUrlInput: document.querySelector("#serviceLoginUrlInput"),
  serviceIconInput: document.querySelector("#serviceIconInput"),
  serviceEnabledInput: document.querySelector("#serviceEnabledInput"),
  servicePricingEnabledInput: document.querySelector("#servicePricingEnabledInput"),
  serviceDefaultModelInput: document.querySelector("#serviceDefaultModelInput"),
  serviceDefaultCreditInput: document.querySelector("#serviceDefaultCreditInput"),
  newServiceButton: document.querySelector("#newServiceButton"),
  saveServiceButton: document.querySelector("#saveServiceButton"),
  deleteServiceButton: document.querySelector("#deleteServiceButton"),
  resetServicesButton: document.querySelector("#resetServicesButton"),
  serviceStatus: document.querySelector("#serviceStatus"),
  tabList: document.querySelector("#tabList"),
  adminNavButtons: Array.from(document.querySelectorAll("[data-admin-view]")),
  adminPanels: Array.from(document.querySelectorAll("[data-admin-panel]"))
};

const THEME_STORAGE_KEY = "centrixServerTheme";

let servicesConfig = { services: [] };
let localDbState = {
  users: [],
  accounts: [],
  serviceVisibility: [],
  uiRules: [],
  modelPolicies: [],
  modelPrices: [],
  modelUsage: [],
  modelObservations: [],
  creditWallets: [],
  creditTransactions: [],
  localStoreCount: 0,
  uiCacheItems: [],
  uiCacheCount: 0,
  activity: [],
  portal: {}
};
let portalState = {};
let selectedServiceId = "";
let selectedUserId = "local-user";
let selectedActivityUserId = localStorage.getItem("centrixServerActivityUser") || "__all";
let loaderRunning = false;
let activeTabsState = [];
let modelPriceDraft = [];
let modelPriceDraftDirty = false;
let modelPriceServiceTouched = false;
let replaceRulesDraft = [];
const ADMIN_VIEW_KEY = "centrixServerAdminView";
const ADMIN_VIEW_LABELS = {
  dashboard: "Dashboard",
  connection: "Kết nối",
  loader: "Nạp data",
  users: "Users & Credit",
  pricing: "Model Pricing",
  access: "Access & UI Rules",
  safety: "Safety",
  organizations: "B2B / Tổ chức",
  "org-transactions": "Giao dịch tổ chức",
  analytics: "Phân tích",
  plans: "Gói cước",
  "credit-packages": "Gói nạp credit",
  billing: "Thanh toán & hóa đơn",
  promotions: "Khuyến mãi",
  manual: "Can thiệp thủ công",
  "intervention-log": "Nhật ký can thiệp",
  support: "Hỗ trợ / Ticket",
  notifications: "Thông báo",
  roles: "Nhóm & phân quyền",
  settings: "Cài đặt",
  "ai-integrations": "Tích hợp AI",
  assistant: "Trợ lý vận hành",
  ledger: "Usage Ledger",
  activity: "Activity/Audit",
  services: "Dịch vụ",
  tabs: "Tab đang chạy"
};

els.loaderProfileInput.value = localStorage.getItem("centrixServerLoaderProfile") || "default";
els.loaderTabInput.value = localStorage.getItem("centrixServerLoaderTab") || "profile-loader";
els.loaderUrlInput.value = "";

function setAdminView(view) {
  const available = els.adminPanels.map((panel) => panel.dataset.adminPanel);
  const nextView = available.includes(view) ? view : "connection";
  localStorage.setItem(ADMIN_VIEW_KEY, nextView);
  if (els.topbarTitle) {
    els.topbarTitle.textContent = ADMIN_VIEW_LABELS[nextView] || nextView;
  }

  for (const panel of els.adminPanels) {
    panel.hidden = panel.dataset.adminPanel !== nextView;
  }

  for (const button of els.adminNavButtons) {
    button.classList.toggle("is-active", button.dataset.adminView === nextView);
  }
}

function applyServerTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", nextTheme);
  document.body.setAttribute("data-theme", nextTheme);
  for (const button of document.querySelectorAll("[data-server-theme]")) {
    button.classList.toggle("is-active", button.dataset.serverTheme === nextTheme);
  }
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
}

function headers(extra = {}) {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

function loaderTabId() {
  const value = String(els.loaderTabInput.value || "profile-loader").trim() || "profile-loader";
  localStorage.setItem("centrixServerLoaderTab", value);
  return value;
}

function loaderProfileId() {
  const value = String(els.loaderProfileInput.value || "default").trim() || "default";
  localStorage.setItem("centrixServerLoaderProfile", value);
  return value;
}

function loaderApiPath(path) {
  return `${path}?tabId=${encodeURIComponent(loaderTabId())}`;
}

async function getJson(path) {
  const response = await fetch(path, {
    headers: headers(),
    cache: "no-store"
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function postJson(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function postLoader(path, payload = {}) {
  const tabId = loaderTabId();
  const response = await fetch(loaderApiPath(path), {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ...payload, tabId })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  if (result.state) renderLoaderState(result.state);
  return result;
}

function setStatus(message, type = "") {
  els.statusLabel.innerHTML = `<i></i>${escapeHtml(message)}`;
  els.statusLabel.classList.toggle("is-error", type === "error");
}

function setLoaderStatus(message, type = "") {
  els.loaderStatus.textContent = message;
  els.loaderStatus.style.color = type === "error" ? "#d92d20" : "";
}

function requireLoaderRunning() {
  if (loaderRunning) return true;
  setLoaderStatus("Chưa mở browser nạp data. Bấm Mở browser nạp trước.", "error");
  return false;
}

function showError(error) {
  setStatus(error.message || String(error), "error");
}

function setLocalDbStatus(message, type = "") {
  els.localDbStatus.textContent = message;
  els.localDbStatus.style.color = type === "error" ? "#d92d20" : "";
}

function selectedUser() {
  return (localDbState.users || []).find((user) => user.id === selectedUserId) || (localDbState.users || [])[0] || null;
}

function selectedWallet() {
  const userId = selectedUser()?.id || selectedUserId || "local-user";
  return (localDbState.creditWallets || []).find((wallet) => wallet.userId === userId) || {
    userId,
    balance: 0,
    reserved: 0,
    lifetimeAdded: 0,
    lifetimeSpent: 0
  };
}

function formatCredit(value) {
  return Math.round(Number(value || 0)).toLocaleString("vi-VN");
}

function formatMoney(value, currency = "VND") {
  const amount = Math.round(Number(value || 0));
  if (currency === "VND") return `${amount.toLocaleString("vi-VN")} đ`;
  return `${amount.toLocaleString("vi-VN")} ${currency || ""}`.trim();
}

function portalRows(section) {
  const rows = portalState?.[section];
  return Array.isArray(rows) ? rows : [];
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function rowStatusClass(status) {
  const clean = String(status || "active").toLowerCase();
  if (/open|pending|todo|draft/.test(clean)) return "warn";
  if (/closed|disabled|failed|cancel/.test(clean)) return "danger";
  return "ok";
}

function renderEmpty(container, message) {
  if (!container) return;
  container.innerHTML = `<div class="portal-empty">${escapeHtml(message)}</div>`;
}

function portalMeta(parts) {
  return parts.filter(Boolean).map((part) => `<span>${escapeHtml(part)}</span>`).join("");
}

function renderPortalList(container, rows, options = {}) {
  if (!container) return;
  container.innerHTML = "";
  if (!rows.length) {
    renderEmpty(container, options.empty || "Chưa có dữ liệu.");
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "portal-row";
    const title = options.title ? options.title(row) : (row.name || row.title || row.subject || row.id);
    const meta = options.meta ? options.meta(row) : [row.email, row.status, row.updatedAt].filter(Boolean);
    const badge = options.badge ? options.badge(row) : (row.status || (row.enabled === false ? "off" : "active"));
    item.innerHTML = `
      <div class="portal-row-main">
        <strong>${escapeHtml(title)}</strong>
        <div class="portal-row-meta">${portalMeta(meta)}</div>
      </div>
      <span class="portal-badge ${rowStatusClass(badge)}">${escapeHtml(badge)}</span>
    `;
    if (options.actions) {
      const actions = document.createElement("div");
      actions.className = "portal-row-actions";
      options.actions(row, actions);
      item.append(actions);
    }
    container.append(item);
  }
}

function renderPortalCards(container, rows, options = {}) {
  if (!container) return;
  container.innerHTML = "";
  if (!rows.length) {
    renderEmpty(container, options.empty || "Chưa có dữ liệu.");
    return;
  }
  for (const row of rows) {
    const card = document.createElement("article");
    card.className = "portal-card-item";
    const title = options.title ? options.title(row) : (row.name || row.title || row.id);
    const value = options.value ? options.value(row) : (row.credits ? `${formatCredit(row.credits)} credit` : row.status || "");
    const meta = options.meta ? options.meta(row) : [row.price ? formatMoney(row.price, row.currency) : "", row.enabled === false ? "disabled" : "enabled"].filter(Boolean);
    card.innerHTML = `
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(value)}</span>
      </div>
      <div class="portal-row-meta">${portalMeta(meta)}</div>
    `;
    if (options.actions) {
      const actions = document.createElement("div");
      actions.className = "portal-row-actions";
      options.actions(row, actions);
      card.append(actions);
    }
    container.append(card);
  }
}

function portalDraftForSection(section) {
  const stamp = new Date().toISOString();
  const id = `${section}-${Date.now().toString(36)}`;
  const defaults = {
    organizations: { id, name: "New Organization", email: "", taxCode: "", status: "active", totalCredit: 0, usedCredit: 0 },
    plans: { id, name: "New Plan", monthlyCredits: 100, price: 0, currency: "VND", enabled: true, features: ["Custom"] },
    creditPackages: { id, name: "New Credit Package", credits: 100, bonusCredits: 0, price: 0, currency: "VND", enabled: true, highlight: false },
    promotions: { id, code: `PROMO${Date.now().toString(36).slice(-4).toUpperCase()}`, name: "New Promotion", type: "credit-bonus", value: 5, enabled: true },
    manualInterventions: { id, userId: selectedUserId || "local-user", serviceId: "chatgpt", title: "New manual task", status: "todo", assignee: "Server Admin" },
    notifications: { id, title: "Thông báo mới", message: "Thông báo mới", target: "all", enabled: true }
  };
  return { ...(defaults[section] || { id, name: `New ${section}` }), createdAt: stamp, updatedAt: stamp };
}

async function addPortalRecord(section) {
  const record = portalDraftForSection(section);
  const result = await postJson("/api/admin/portal", { section, record });
  portalState = result.portal || result.db?.portal || portalState;
  renderPortalModules();
  setLocalDbStatus(`Đã thêm ${section}.`);
}

async function deletePortalRecord(section, id) {
  const result = await postJson("/api/admin/portal", { section, action: "delete", id });
  portalState = result.portal || result.db?.portal || portalState;
  renderPortalModules();
  setLocalDbStatus(`Đã xóa ${id}.`);
}

async function approveTopupOrder(orderId) {
  const result = await postJson("/api/admin/billing/approve", { orderId, actor: "admin" });
  portalState = result.portal || result.db?.portal || portalState;
  if (result.db) {
    localDbState = { ...localDbState, ...(result.db || {}) };
  }
  renderPortalModules();
  renderCreditWallet();
  renderCreditLedger();
  renderDashboard();
  setLocalDbStatus(`Đã duyệt order ${orderId} và cộng credit.`);
}

function actionButton(label, onClick, variant = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini-action ${variant}`.trim();
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderPortalModules() {
  renderPortalList(els.organizationList, portalRows("organizations"), {
    title: (row) => row.name,
    meta: (row) => [row.email, row.taxCode ? `MST ${row.taxCode}` : "", `${formatCredit(row.totalCredit)} credit`],
    actions: (row, actions) => actions.append(actionButton("Xóa", () => deletePortalRecord("organizations", row.id).catch(showError), "danger"))
  });
  renderPortalList(els.departmentList, portalRows("departments"), {
    title: (row) => row.name,
    meta: (row) => [row.orgId, row.parentId, `Limit ${formatCredit(row.creditLimit)}`]
  });
  renderPortalList(els.memberList, portalRows("members"), {
    title: (row) => row.name || row.email,
    meta: (row) => [row.email, row.role, row.departmentId, `Limit ${formatCredit(row.creditLimit)}`]
  });
  renderPortalList(els.orgTransactionList, portalRows("orgTransactions"), {
    title: (row) => `${row.type || "transaction"} - ${row.orgId || ""}`,
    meta: (row) => [row.userId, `${formatCredit(row.amountDelta)} credit`, row.reason, row.createdAt]
  });

  const summaryCards = [
    ["Tổ chức", portalRows("organizations").length, "B2B account đang quản lý"],
    ["Đơn pending", portalRows("topupOrders").filter((row) => row.status === "pending").length, "Chờ admin duyệt credit"],
    ["Ticket mở", portalRows("supportTickets").filter((row) => row.status !== "closed").length, "Cần CSKH xử lý"],
    ["Credit package", portalRows("creditPackages").filter((row) => row.enabled !== false).length, "Gói đang bán"]
  ];
  if (els.analyticsCards) {
    els.analyticsCards.innerHTML = "";
    for (const [label, value, note] of summaryCards) {
      const card = document.createElement("article");
      card.className = "dashboard-card";
      card.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small>`;
      els.analyticsCards.append(card);
    }
  }

  renderPortalCards(els.planList, portalRows("plans"), {
    value: (row) => `${formatCredit(row.monthlyCredits)} credit / tháng`,
    meta: (row) => [formatMoney(row.price, row.currency), row.enabled === false ? "disabled" : "enabled"],
    actions: (row, actions) => actions.append(actionButton("Xóa", () => deletePortalRecord("plans", row.id).catch(showError), "danger"))
  });
  renderPortalCards(els.creditPackageList, portalRows("creditPackages"), {
    value: (row) => `${formatCredit(Number(row.credits || 0) + Number(row.bonusCredits || 0))} credit`,
    meta: (row) => [formatMoney(row.price, row.currency), row.highlight ? "highlight" : "", row.enabled === false ? "disabled" : "enabled"],
    actions: (row, actions) => actions.append(actionButton("Xóa", () => deletePortalRecord("creditPackages", row.id).catch(showError), "danger"))
  });
  renderPortalList(els.topupOrderList, portalRows("topupOrders"), {
    title: (row) => `${row.userId || "user"} - ${formatCredit(row.credits)} credit`,
    meta: (row) => [
      formatMoney(row.amount, row.currency),
      row.creditedAt ? `đã cộng · ${row.status || "paid"}` : (row.status || "pending"),
      (row.paymentMethod || "").toUpperCase(),
      row.payCode ? `mã: ${row.payCode}` : "",
      row.createdAt
    ].filter(Boolean),
    actions: (row, actions) => {
      if (row.status === "pending" && !row.creditedAt) actions.append(actionButton("Duyệt", () => approveTopupOrder(row.id).catch(showError), "primary"));
      actions.append(actionButton("Xóa", () => deletePortalRecord("topupOrders", row.id).catch(showError), "danger"));
    }
  });
  renderPortalList(els.invoiceList, portalRows("invoices"), {
    title: (row) => row.invoiceNo || row.id,
    meta: (row) => [row.userId, formatMoney(row.amount, row.currency), row.status, row.issuedAt]
  });
  renderPortalList(els.promotionList, portalRows("promotions"), {
    title: (row) => `${row.code || row.id} - ${row.name || ""}`,
    meta: (row) => [row.type, `${row.value || 0}%`, row.enabled === false ? "disabled" : "enabled"],
    actions: (row, actions) => actions.append(actionButton("Xóa", () => deletePortalRecord("promotions", row.id).catch(showError), "danger"))
  });
  renderPortalList(els.manualInterventionList, portalRows("manualInterventions"), {
    title: (row) => row.title,
    meta: (row) => [row.userId, row.serviceId, row.assignee, row.updatedAt],
    actions: (row, actions) => actions.append(actionButton("Xóa", () => deletePortalRecord("manualInterventions", row.id).catch(showError), "danger"))
  });
  renderPortalList(els.interventionLogList, portalRows("interventionLogs"), {
    title: (row) => `${row.action || "event"} - ${row.interventionId || ""}`,
    meta: (row) => [row.actor, row.details, row.createdAt]
  });
  renderPortalList(els.supportTicketList, portalRows("supportTickets"), {
    title: (row) => row.subject,
    meta: (row) => [row.userId, row.priority, row.message, row.createdAt]
  });
  renderPortalList(els.notificationList, portalRows("notifications"), {
    title: (row) => row.title,
    meta: (row) => [row.target, row.message, row.enabled === false ? "disabled" : "enabled"],
    actions: (row, actions) => actions.append(actionButton("Xóa", () => deletePortalRecord("notifications", row.id).catch(showError), "danger"))
  });
  renderPortalList(els.rolePermissionList, portalRows("rolePermissions"), {
    title: (row) => row.name,
    meta: (row) => [row.scope, Array.isArray(row.permissions) ? row.permissions.join(", ") : ""]
  });
  renderPortalList(els.appSettingsList, portalRows("appSettings"), {
    title: (row) => row.key,
    meta: (row) => [row.group, row.value, row.enabled === false ? "disabled" : "enabled"]
  });
  renderPortalList(els.aiIntegrationList, portalRows("aiIntegrations"), {
    title: (row) => row.name,
    meta: (row) => [row.provider, row.endpoint, row.status, row.enabled === false ? "disabled" : "enabled"]
  });
  renderPortalCards(els.assistantOpsList, [
    { id: "assist-credit", name: "Credit risk", value: `${portalRows("topupOrders").filter((row) => row.status === "pending").length} order pending`, note: "Duyệt order để user có credit tiếp." },
    { id: "assist-ticket", name: "Support queue", value: `${portalRows("supportTickets").filter((row) => row.status !== "closed").length} ticket mở`, note: "Ưu tiên ticket high/urgent." },
    { id: "assist-model", name: "Model pricing", value: `${(localDbState.modelPrices || []).length} model`, note: "Kiểm tra model log mới trước khi user dùng." }
  ], {
    value: (row) => row.value,
    meta: (row) => [row.note]
  });
}

function transactionTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function transactionLabel(type) {
  const labels = {
    topup: "Nạp credit",
    debit: "Trừ credit",
    refund: "Hoàn credit",
    adjust: "Điều chỉnh",
    blocked: "Bị chặn"
  };
  return labels[type] || type || "Giao dịch";
}

function selectedModelPriceServiceId() {
  return els.modelPriceServiceSelect?.value || selectedModelPolicyServiceId();
}

function selectedRuleServiceId() {
  return els.userRuleServiceSelect.value || selectedServiceId || (servicesConfig.services || [])[0]?.id || "";
}

function selectedModelPolicyServiceId() {
  return els.modelPolicyServiceSelect.value || selectedRuleServiceId();
}

function serviceById(serviceId) {
  return (servicesConfig.services || []).find((service) => service.id === serviceId) || null;
}

function modelPricesForService(serviceId) {
  return (localDbState.modelPrices || [])
    .filter((price) => price.serviceId === serviceId)
    .slice()
    .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true) || String(a.modelId || "").localeCompare(String(b.modelId || "")));
}

function modelPriceCostMap(serviceId) {
  const map = {};
  for (const price of modelPricesForService(serviceId)) {
    if (price.modelId && price.enabled !== false) {
      map[price.modelId] = Math.max(1, Math.round(Number(price.creditCost || 1)));
    }
  }
  return map;
}

function currentLoaderTabIdValue() {
  return String(els.loaderTabInput?.value || localStorage.getItem("centrixServerLoaderTab") || "profile-loader").trim() || "profile-loader";
}

function modelPriceServiceExists(serviceId) {
  return Boolean(serviceId && serviceById(serviceId));
}

function activeModelTabServiceId() {
  const loaderTabIdValue = currentLoaderTabIdValue();
  const tabs = Array.isArray(activeTabsState) ? activeTabsState : [];
  const candidates = [
    tabs.find((tab) => tab.tabId === loaderTabIdValue),
    tabs.find((tab) => tab.visible && tab.serviceId && !tab.localUser),
    tabs.find((tab) => tab.serviceId && !tab.localUser)
  ];
  return candidates.find((tab) => modelPriceServiceExists(tab?.serviceId))?.serviceId || "";
}

function latestObservedModelServiceId() {
  return (localDbState.modelObservations || [])
    .filter((item) => modelPriceServiceExists(item.serviceId))
    .slice()
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")) || Number(b.count || 0) - Number(a.count || 0))
    [0]?.serviceId || "";
}

function preferredModelPriceServiceId(previous = selectedModelPriceServiceId()) {
  const services = servicesConfig.services || [];
  if (!services.length) return "";
  if ((modelPriceDraftDirty || modelPriceServiceTouched) && modelPriceServiceExists(previous)) return previous;

  const preferred = [
    activeModelTabServiceId(),
    latestObservedModelServiceId(),
    previous,
    services[0]?.id
  ].find((serviceId) => modelPriceServiceExists(serviceId));

  return preferred || services[0]?.id || "";
}

function syncModelPriceServiceSelection() {
  if (!els.modelPriceServiceSelect) return false;
  const previous = selectedModelPriceServiceId();
  const next = preferredModelPriceServiceId(previous);
  if (!next || next === previous) return false;
  els.modelPriceServiceSelect.value = next;
  return els.modelPriceServiceSelect.value === next;
}

function markModelPriceDraftDirty() {
  modelPriceDraftDirty = true;
}

function defaultVisibleForSelectedUser() {
  const user = selectedUser();
  return user?.role === "loader" || user?.id === "local-user";
}

function userServiceVisible(userId, serviceId) {
  const row = (localDbState.serviceVisibility || []).find((item) => item.userId === userId && item.serviceId === serviceId);
  if (row) return row.visible !== false;
  return defaultVisibleForSelectedUser();
}

function selectedUiRule() {
  const serviceId = selectedRuleServiceId();
  return (localDbState.uiRules || []).find((rule) => rule.userId === selectedUserId && rule.serviceId === serviceId) || null;
}

function sanitizeReplaceRuleDraft(rule = {}) {
  const selector = String(rule.selector || "").trim();
  if (!selectorLooksUsable(selector)) return null;
  return {
    selector,
    text: String(rule.text ?? rule.replacement ?? "").slice(0, 1200),
    matchText: String(rule.matchText || "").slice(0, 400),
    enabled: rule.enabled !== false
  };
}

function normalizeReplaceRules(rules = replaceRulesDraft) {
  const rows = [];
  const seen = new Set();
  for (const raw of rules || []) {
    const rule = sanitizeReplaceRuleDraft(raw);
    if (!rule) continue;
    const key = `${rule.selector}\n${rule.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(rule);
  }
  return rows.slice(0, 40);
}

function selectedModelPolicy() {
  const serviceId = selectedModelPolicyServiceId();
  return (localDbState.modelPolicies || []).find((policy) => policy.userId === selectedUserId && policy.serviceId === serviceId) || null;
}

function selectedModelObservations() {
  const serviceId = selectedModelPriceServiceId();
  return (localDbState.modelObservations || [])
    .filter((item) => item.serviceId === serviceId)
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
}

function selectorLooksUsable(selector) {
  const clean = String(selector || "").trim();
  if (!clean || clean.length > 500) return false;
  if (/[{};]/.test(clean) || /!important/i.test(clean)) return false;
  if (/^\/\*/.test(clean) || clean.startsWith("* /") || clean.startsWith("@")) return false;
  if (/^[a-z-]+\s*:/i.test(clean)) return false;
  return true;
}

function extractHideSelectors(input) {
  const raw = String(input || "");
  const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, "\n");
  const selectors = [];
  let inBlock = false;

  for (const rawLine of withoutComments.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.includes("{")) {
      const selector = line.slice(0, line.indexOf("{")).trim().replace(/,$/, "");
      if (selectorLooksUsable(selector)) selectors.push(selector);
      inBlock = !line.includes("}");
      continue;
    }

    if (inBlock) {
      if (line.includes("}")) inBlock = false;
      continue;
    }

    const selector = line.replace(/,$/, "");
    if (selectorLooksUsable(selector)) selectors.push(selector);
  }

  return Array.from(new Set(selectors)).slice(0, 80);
}

function renderUserOptions() {
  const previous = selectedUserId || els.userSelect.value || "local-user";
  els.userSelect.innerHTML = "";

  for (const user of localDbState.users || []) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = `${user.name || user.id} (${user.id})`;
    els.userSelect.append(option);
  }

  if ((localDbState.users || []).some((user) => user.id === previous)) {
    selectedUserId = previous;
  } else {
    selectedUserId = (localDbState.users || [])[0]?.id || "local-user";
  }

  els.userSelect.value = selectedUserId;
}

function userNameById(userId) {
  const user = (localDbState.users || []).find((item) => item.id === userId);
  return user?.name || userId || "User";
}

function serviceNameById(serviceId) {
  if (serviceId === "client") return "App User";
  if (serviceId === "profile-sync") return "Profile";
  const service = (servicesConfig.services || []).find((item) => item.id === serviceId);
  return service?.name || serviceId || "Service";
}

function activityActionLabel(action) {
  const labels = {
    "connect": "Kết nối",
    "disconnect": "Đăng xuất",
    "app-quit": "Tắt app",
    "open-service": "Mở dịch vụ",
    "close-service": "Đóng dịch vụ",
    "navigate": "Chuyển trang",
    "navigate-in-page": "Chuyển trong trang",
    "page-loaded": "Tải xong trang",
    "load-error": "Lỗi tải trang",
    "local-store-download": "Nạp localStorage",
    "local-store-upload": "Lưu localStorage",
    "ui-cache-sync": "Đồng bộ UI cache",
    "profile-download": "Tải profile",
    "profile-storage-download": "Tải storage profile",
    "profile-upload": "Lưu profile",
    "model-usage": "Dùng model",
    "model-blocked": "Chặn model"
  };
  return labels[action] || action || "event";
}

function renderActivityUserOptions() {
  if (!els.activityUserSelect) return;
  const previous = selectedActivityUserId || "__all";
  els.activityUserSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "__all";
  allOption.textContent = "Tất cả user";
  els.activityUserSelect.append(allOption);

  for (const user of localDbState.users || []) {
    const option = document.createElement("option");
    option.value = user.id;
    option.textContent = `${user.name || user.id} (${user.id})`;
    els.activityUserSelect.append(option);
  }

  selectedActivityUserId = previous === "__all" || (localDbState.users || []).some((user) => user.id === previous)
    ? previous
    : "__all";
  els.activityUserSelect.value = selectedActivityUserId;
}

function renderActivityList() {
  if (!els.activityList) return;
  els.activityList.innerHTML = "";

  const rows = (localDbState.activity || [])
    .filter((item) => selectedActivityUserId === "__all" || item.userId === selectedActivityUserId)
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 160);

  if (!rows.length) {
    els.activityList.innerHTML = `<div class="tab-row"><div class="tab-meta"><strong>Chưa có lịch sử</strong><span>App User sẽ đẩy log về Server sau khi user kết nối và thao tác.</span></div></div>`;
    return;
  }

  for (const item of rows) {
    const row = document.createElement("div");
    row.className = `activity-row action-${String(item.action || "event").replace(/[^a-z0-9_-]/gi, "-")}`;

    const meta = document.createElement("div");
    meta.className = "activity-meta";

    const title = document.createElement("strong");
    title.textContent = `${activityActionLabel(item.action)} - ${serviceNameById(item.serviceId)}`;

    const subtitle = document.createElement("span");
    const time = item.createdAt ? new Date(item.createdAt).toLocaleString() : "";
    subtitle.textContent = `${time} - ${userNameById(item.userId)} - profile ${item.profileId || "default"} - device ${item.deviceId || ""}`;

    const url = document.createElement("span");
    url.className = "activity-url";
    url.textContent = item.title || item.url || "";

    const details = document.createElement("code");
    details.textContent = item.details || "";

    meta.append(title, subtitle);
    if (url.textContent) meta.append(url);
    if (details.textContent) meta.append(details);

    row.append(meta);
    els.activityList.append(row);
  }
}

function renderActivity() {
  renderActivityUserOptions();
  renderActivityList();
}

function renderDashboard() {
  if (!els.dashboardCards) return;
  els.dashboardCards.innerHTML = "";

  const today = todayKey();
  const transactions = localDbState.creditTransactions || [];
  const todayDebits = transactions.filter((tx) => tx.type === "debit" && String(tx.createdAt || "").slice(0, 10) === today);
  const todayBlocked = transactions.filter((tx) => tx.type === "blocked" && String(tx.createdAt || "").slice(0, 10) === today);
  const totalCredit = (localDbState.creditWallets || []).reduce((sum, wallet) => sum + Number(wallet.balance || 0), 0);
  const spentToday = todayDebits.reduce((sum, tx) => sum + Math.abs(Number(tx.amountDelta || 0)), 0);
  const lowCreditUsers = (localDbState.creditWallets || []).filter((wallet) => Number(wallet.balance || 0) > 0 && Number(wallet.balance || 0) <= 5).length;

  const cards = [
    ["Users", `${(localDbState.users || []).filter((user) => user.enabled !== false).length}/${(localDbState.users || []).length}`, "enabled / total"],
    ["Credit đang giữ", formatCredit(totalCredit), "tổng số dư ví user"],
    ["Usage hôm nay", formatCredit(spentToday), `${todayDebits.length} request đã trừ credit`],
    ["Blocked hôm nay", formatCredit(todayBlocked.length), "hết credit, safety cap hoặc policy"],
    ["Bảng giá model", formatCredit((localDbState.modelPrices || []).length), "model có giá"],
    ["Tổ chức", formatCredit(portalRows("organizations").length), "B2B / company workspace"],
    ["Đơn nạp pending", formatCredit(portalRows("topupOrders").filter((row) => row.status === "pending").length), "chờ admin duyệt"],
    ["Ticket mở", formatCredit(portalRows("supportTickets").filter((row) => row.status !== "closed").length), "cần hỗ trợ"],
    ["Cần theo dõi", formatCredit(lowCreditUsers), "user còn <= 5 credit"]
  ];

  for (const [label, value, note] of cards) {
    const card = document.createElement("article");
    card.className = "metric-card";
    const title = document.createElement("span");
    title.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    const small = document.createElement("em");
    small.textContent = note;
    card.append(title, strong, small);
    els.dashboardCards.append(card);
  }
}

function renderCreditRows(container, rows, emptyText = "Chưa có giao dịch credit.") {
  if (!container) return;
  container.innerHTML = "";
  if (!rows.length) {
    container.innerHTML = `<div class="tab-row"><div class="tab-meta"><strong>${emptyText}</strong><span>Ledger se hien sau khi admin nap credit hoac user dung model.</span></div></div>`;
    return;
  }

  for (const tx of rows) {
    const row = document.createElement("div");
    row.className = `credit-row tx-${String(tx.type || "tx").replace(/[^a-z0-9_-]/gi, "-")}`;

    const meta = document.createElement("div");
    meta.className = "activity-meta";
    const title = document.createElement("strong");
    const delta = Number(tx.amountDelta || 0);
    title.textContent = `${transactionLabel(tx.type)} ${delta > 0 ? "+" : ""}${formatCredit(delta)} - ${serviceNameById(tx.serviceId)}`;

    const subtitle = document.createElement("span");
    subtitle.textContent = `${transactionTime(tx.createdAt)} - ${userNameById(tx.userId)} - model ${tx.modelId || "-"} - balance ${formatCredit(tx.balanceAfter)}`;

    const reason = document.createElement("span");
    reason.textContent = tx.reason || "";

    const details = document.createElement("code");
    details.textContent = tx.details || "";

    meta.append(title, subtitle);
    if (reason.textContent) meta.append(reason);
    if (details.textContent) meta.append(details);
    row.append(meta);
    container.append(row);
  }
}

function renderCreditWallet() {
  const wallet = selectedWallet();
  if (els.creditBalanceLabel) els.creditBalanceLabel.textContent = formatCredit(wallet.balance);
  if (els.creditSpentLabel) els.creditSpentLabel.textContent = formatCredit(wallet.lifetimeSpent);

  const rows = (localDbState.creditTransactions || [])
    .filter((tx) => tx.userId === wallet.userId)
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 8);
  renderCreditRows(els.creditLedgerMini, rows, "User nay chua co giao dich credit.");
}

function renderCreditLedger() {
  const rows = (localDbState.creditTransactions || [])
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 250);
  renderCreditRows(els.creditLedgerList, rows);
}

function renderUserFields() {
  const user = selectedUser();
  els.userIdInput.value = user?.id || selectedUserId || "local-user";
  els.userNameInput.value = user?.name || "";
  els.userProfileInput.value = user?.defaultProfileId || "default";
  els.userEnabledInput.checked = user?.enabled !== false;
}

function renderUserServiceAccess() {
  els.userServiceAccessList.innerHTML = "";
  const services = servicesConfig.services || [];

  if (!services.length) {
    els.userServiceAccessList.innerHTML = `<div class="tab-row"><div class="tab-meta"><strong>Chưa có dịch vụ</strong><span>Tạo service trước để gán user.</span></div></div>`;
    return;
  }

  for (const service of services) {
    const row = document.createElement("label");
    row.className = "access-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = userServiceVisible(selectedUserId, service.id);
    checkbox.addEventListener("change", () => {
      setUserServiceAccess(service.id, checkbox.checked).catch((error) => {
        checkbox.checked = !checkbox.checked;
        showError(error);
        setLocalDbStatus(error.message || String(error), "error");
      });
    });

    const meta = document.createElement("div");
    meta.className = "tab-meta";
    const title = document.createElement("strong");
    title.textContent = service.name || service.id;
    const subtitle = document.createElement("span");
    subtitle.textContent = service.url || "";
    meta.append(title, subtitle);

    const badge = document.createElement("span");
    badge.textContent = checkbox.checked ? "Hiện" : "Ẩn";

    row.append(checkbox, meta, badge);
    els.userServiceAccessList.append(row);
  }
}

function renderUserRuleServiceOptions() {
  const previous = selectedRuleServiceId();
  els.userRuleServiceSelect.innerHTML = "";

  for (const service of servicesConfig.services || []) {
    const option = document.createElement("option");
    option.value = service.id;
    option.textContent = service.name || service.id;
    els.userRuleServiceSelect.append(option);
  }

  if ((servicesConfig.services || []).some((service) => service.id === previous)) {
    els.userRuleServiceSelect.value = previous;
  } else if (servicesConfig.services?.[0]) {
    els.userRuleServiceSelect.value = servicesConfig.services[0].id;
  }
}

function renderUserRuleEditor() {
  renderUserRuleServiceOptions();
  const rule = selectedUiRule();
  els.userRuleEnabledInput.checked = rule?.enabled === true;
  els.userHideSelectorsInput.value = (rule?.hideSelectors || []).join("\n");
  replaceRulesDraft = normalizeReplaceRules(rule?.replaceRules || []);
  renderReplaceRulesList();
  renderUserUiCacheList();
}

function renderReplaceRulesList() {
  if (!els.replaceRulesList) return;
  replaceRulesDraft = normalizeReplaceRules(replaceRulesDraft);
  els.replaceRulesList.innerHTML = "";

  if (!replaceRulesDraft.length) {
    els.replaceRulesList.innerHTML = `<div class="replace-rule-empty">Chưa có rule đổi text. Bấm Chọn vùng đổi text hoặc Add text rule.</div>`;
    return;
  }

  for (const [index, rule] of replaceRulesDraft.entries()) {
    const row = document.createElement("div");
    row.className = `replace-rule-row${rule.enabled === false ? " disabled" : ""}`;

    const selectorInput = document.createElement("input");
    selectorInput.value = rule.selector;
    selectorInput.placeholder = "selector";
    selectorInput.addEventListener("input", () => {
      replaceRulesDraft[index] = { ...replaceRulesDraft[index], selector: selectorInput.value };
    });

    const textInput = document.createElement("input");
    textInput.value = rule.text;
    textInput.placeholder = "text mới";
    textInput.addEventListener("input", () => {
      replaceRulesDraft[index] = { ...replaceRulesDraft[index], text: textInput.value };
    });

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "price-check-field";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = rule.enabled !== false;
    enabledInput.addEventListener("change", () => {
      replaceRulesDraft[index] = { ...replaceRulesDraft[index], enabled: enabledInput.checked };
      row.classList.toggle("disabled", !enabledInput.checked);
    });
    enabledLabel.append(enabledInput, document.createTextNode("On"));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "price-delete-button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      replaceRulesDraft.splice(index, 1);
      renderReplaceRulesList();
      setLocalDbStatus("Đã xóa rule đổi text khỏi danh sách tạm. Bấm Save UI rules để lưu DB.");
    });

    row.append(selectorInput, textInput, enabledLabel, deleteButton);
    els.replaceRulesList.append(row);
  }
}

function renderUserUiCacheList() {
  if (!els.userUiCacheList) return;
  const serviceId = selectedRuleServiceId();
  const rows = (localDbState.uiCacheItems || [])
    .filter((item) => item.userId === selectedUserId && item.serviceId === serviceId && item.hidden !== true)
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
    .slice(0, 40);

  els.userUiCacheList.innerHTML = "";
  if (!rows.length) {
    els.userUiCacheList.innerHTML = `<div class="replace-rule-empty">Chưa có UI cache. Mở service trên App User hoặc browser nạp để hệ thống đọc DOM và đồng bộ.</div>`;
    return;
  }

  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "ui-cache-row";

    const meta = document.createElement("div");
    meta.className = "tab-meta";
    const title = document.createElement("strong");
    title.textContent = item.title || item.chatId || item.href || "Untitled";
    const href = document.createElement("span");
    href.textContent = item.href || item.chatId || "";
    meta.append(title, href);

    const time = document.createElement("span");
    time.textContent = item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : "-";

    row.append(meta, time);
    els.userUiCacheList.append(row);
  }
}

function renderModelPolicyServiceOptions() {
  const previous = selectedModelPolicyServiceId();
  els.modelPolicyServiceSelect.innerHTML = "";

  for (const service of servicesConfig.services || []) {
    const option = document.createElement("option");
    option.value = service.id;
    option.textContent = service.name || service.id;
    els.modelPolicyServiceSelect.append(option);
  }

  if ((servicesConfig.services || []).some((service) => service.id === previous)) {
    els.modelPolicyServiceSelect.value = previous;
  } else if (servicesConfig.services?.[0]) {
    els.modelPolicyServiceSelect.value = servicesConfig.services[0].id;
  }
}

function renderModelPriceServiceOptions() {
  if (!els.modelPriceServiceSelect) return;
  const previous = selectedModelPriceServiceId();
  els.modelPriceServiceSelect.innerHTML = "";

  for (const service of servicesConfig.services || []) {
    const option = document.createElement("option");
    option.value = service.id;
    option.textContent = service.name || service.id;
    els.modelPriceServiceSelect.append(option);
  }

  const next = preferredModelPriceServiceId(previous);
  if (next) {
    els.modelPriceServiceSelect.value = next;
  } else if (servicesConfig.services?.[0]) {
    els.modelPriceServiceSelect.value = servicesConfig.services[0].id;
  }
}

function modelPricesToInput(prices = []) {
  return (prices || [])
    .filter((price) => price.modelId)
    .map((price) => `${price.modelId}=${Math.max(1, Math.round(Number(price.creditCost || 1)))}`)
    .join("\n");
}

function sanitizeModelPriceDraft(serviceId, price = {}) {
  const cleanModelId = String(price.modelId || "").trim();
  if (!cleanModelId) return null;
  return {
    serviceId,
    modelId: cleanModelId,
    displayName: String(price.displayName || cleanModelId).trim() || cleanModelId,
    creditCost: Math.max(1, Math.round(Number(price.creditCost || 1) || 1)),
    enabled: price.enabled !== false,
    isDefault: price.isDefault === true,
    observedFromLoader: price.observedFromLoader === true,
    source: price.source || "admin"
  };
}

function normalizeModelPriceDraft(serviceId, prices = modelPriceDraft) {
  const rows = [];
  const seen = new Set();
  let hasDefault = false;

  for (const raw of prices || []) {
    const price = sanitizeModelPriceDraft(serviceId, raw);
    if (!price || seen.has(price.modelId)) continue;
    seen.add(price.modelId);
    if (price.isDefault && !hasDefault) {
      hasDefault = true;
    } else {
      price.isDefault = false;
    }
    rows.push(price);
  }

  return rows.slice(0, 120);
}

function setModelPriceDraft(prices = []) {
  const serviceId = selectedModelPriceServiceId();
  modelPriceDraft = normalizeModelPriceDraft(serviceId, prices);
  if (els.modelCreditCostsInput) {
    els.modelCreditCostsInput.value = modelPricesToInput(modelPriceDraft);
  }
  renderModelPriceList(modelPriceDraft);
}

function modelPricesFromInput(serviceId, value) {
  const service = serviceById(serviceId) || {};
  const previous = new Map(modelPricesForService(serviceId).map((price) => [price.modelId, price]));
  const observed = new Set((localDbState.modelObservations || [])
    .filter((item) => item.serviceId === serviceId)
    .map((item) => item.modelId));
  const prices = [];
  const seen = new Set();

  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleanLine = line.replace(/\s+#.*$/, "");
    const [rawModel, rawCost = "1"] = cleanLine.includes("=") ? cleanLine.split("=") : cleanLine.split(/[\s,]+/);
    const modelId = String(rawModel || "").trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const oldPrice = previous.get(modelId) || {};
    prices.push({
      serviceId,
      modelId,
      displayName: oldPrice.displayName || modelId,
      creditCost: Math.max(1, Math.round(Number(String(rawCost || "1").trim()) || Number(service.defaultCreditCost || 1) || 1)),
      enabled: oldPrice.enabled !== false,
      isDefault: service.defaultModel === modelId || oldPrice.isDefault === true,
      observedFromLoader: oldPrice.observedFromLoader === true || observed.has(modelId),
      source: oldPrice.source || "admin"
    });
  }

  return prices.slice(0, 120);
}

function renderModelPriceList(prices = modelPricesFromInput(selectedModelPriceServiceId(), els.modelCreditCostsInput?.value || "")) {
  if (!els.modelPriceList) return;
  els.modelPriceList.innerHTML = "";
  if (!prices.length) {
    els.modelPriceList.innerHTML = `<div class="inline-status">Chưa có bảng giá. Bấm Add model hoặc Add từ model đã log rồi Save.</div>`;
    return;
  }

  for (const [index, price] of prices.entries()) {
    const row = document.createElement("div");
    row.className = `price-row price-edit-row${price.enabled === false ? " disabled" : ""}`;

    const meta = document.createElement("div");
    meta.className = "tab-meta";

    const title = document.createElement("input");
    title.className = "price-model-input";
    title.value = price.modelId || "";
    title.placeholder = "model-id";
    title.addEventListener("input", () => {
      markModelPriceDraftDirty();
      modelPriceDraft[index] = {
        ...modelPriceDraft[index],
        modelId: title.value,
        displayName: title.value || modelPriceDraft[index]?.displayName || ""
      };
      if (els.modelCreditCostsInput) {
        els.modelCreditCostsInput.value = modelPricesToInput(normalizeModelPriceDraft(selectedModelPriceServiceId()));
      }
    });

    const subtitle = document.createElement("span");
    const flags = [
      price.isDefault ? "default" : "",
      price.observedFromLoader ? "loader log" : "",
      price.enabled === false ? "disabled" : "enabled"
    ].filter(Boolean).join(" - ");
    subtitle.textContent = flags || "admin";
    meta.append(title, subtitle);

    const creditLabel = document.createElement("label");
    creditLabel.className = "price-inline-field";
    const creditText = document.createElement("span");
    creditText.textContent = "Credit";
    const creditInput = document.createElement("input");
    creditInput.type = "number";
    creditInput.min = "1";
    creditInput.step = "1";
    creditInput.value = String(Math.max(1, Math.round(Number(price.creditCost || 1))));
    creditInput.addEventListener("input", () => {
      markModelPriceDraftDirty();
      modelPriceDraft[index] = {
        ...modelPriceDraft[index],
        creditCost: Math.max(1, Math.round(Number(creditInput.value || 1) || 1))
      };
      if (els.modelCreditCostsInput) {
        els.modelCreditCostsInput.value = modelPricesToInput(normalizeModelPriceDraft(selectedModelPriceServiceId()));
      }
    });
    creditLabel.append(creditText, creditInput);

    const defaultLabel = document.createElement("label");
    defaultLabel.className = "price-check-field";
    const defaultInput = document.createElement("input");
    defaultInput.type = "radio";
    defaultInput.name = "modelDefaultPrice";
    defaultInput.checked = price.isDefault === true;
    defaultInput.addEventListener("change", () => {
      markModelPriceDraftDirty();
      modelPriceDraft = modelPriceDraft.map((item, itemIndex) => ({
        ...item,
        isDefault: itemIndex === index
      }));
      setModelPriceDraft(modelPriceDraft);
    });
    defaultLabel.append(defaultInput, document.createTextNode("Default"));

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "price-check-field";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = price.enabled !== false;
    enabledInput.addEventListener("change", () => {
      markModelPriceDraftDirty();
      modelPriceDraft[index] = {
        ...modelPriceDraft[index],
        enabled: enabledInput.checked
      };
      row.classList.toggle("disabled", !enabledInput.checked);
    });
    enabledLabel.append(enabledInput, document.createTextNode("On"));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "price-delete-button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      markModelPriceDraftDirty();
      modelPriceDraft.splice(index, 1);
      setModelPriceDraft(modelPriceDraft);
      setLocalDbStatus("Đã xóa dòng model khỏi bảng giá tạm. Bấm Save model prices để lưu DB.");
    });

    row.append(meta, creditLabel, defaultLabel, enabledLabel, deleteButton);
    els.modelPriceList.append(row);
  }
}

function renderModelPricing() {
  renderModelPriceServiceOptions();
  const serviceId = selectedModelPriceServiceId();
  const prices = modelPricesForService(serviceId);
  modelPriceDraft = normalizeModelPriceDraft(serviceId, prices);
  modelPriceDraftDirty = false;
  if (els.modelCreditCostsInput) {
    els.modelCreditCostsInput.value = modelPricesToInput(modelPriceDraft);
  }
  renderModelObservedList();
  renderModelPriceList(modelPriceDraft);
}

function addBlankModelPrice() {
  const serviceId = selectedModelPriceServiceId();
  const service = serviceById(serviceId) || {};
  const rows = normalizeModelPriceDraft(serviceId, modelPriceDraft);
  let index = rows.length + 1;
  let modelId = `new-model-${index}`;
  const existing = new Set(rows.map((price) => price.modelId));
  while (existing.has(modelId)) {
    index += 1;
    modelId = `new-model-${index}`;
  }
  rows.push({
    serviceId,
    modelId,
    displayName: modelId,
    creditCost: Math.max(1, Math.round(Number(service.defaultCreditCost || 1) || 1)),
    enabled: true,
    isDefault: rows.length === 0,
    observedFromLoader: false,
    source: "admin"
  });
  markModelPriceDraftDirty();
  setModelPriceDraft(rows);
  setLocalDbStatus("Đã thêm dòng model mới. Sửa modelId/credit rồi bấm Save model prices.");
}

function renderModelPolicyEditor() {
  renderModelPolicyServiceOptions();
  const policy = selectedModelPolicy();
  els.modelPolicyEnabledInput.checked = policy?.enabled === true;
  els.modelBlockUnknownInput.checked = policy?.blockUnknown === true;
  els.modelAllowedModelsInput.value = (policy?.allowedModels || []).join("\n");
  els.modelDefaultInput.value = policy?.defaultModel || "";
  els.modelDailyLimitInput.value = String(policy?.dailyLimit || 0);
  els.modelDefaultCreditInput.value = String(policy?.defaultCreditCost || 1);
}

function renderUserDb() {
  portalState = localDbState.portal || portalState || {};
  renderUserOptions();
  renderUserFields();
  renderCreditWallet();
  renderUserServiceAccess();
  renderUserRuleEditor();
  renderModelPricing();
  renderModelPolicyEditor();
  renderCreditLedger();
  renderDashboard();
  renderActivity();
  renderPortalModules();
  const source = localDbState.source === "docker-sqlite" ? "Docker Desktop" : "JSON fallback";
  setLocalDbStatus(`${source}: ${(localDbState.users || []).length} users, ${(localDbState.accounts || []).length} accounts, ${(localDbState.creditWallets || []).length} wallets, ${(localDbState.modelPrices || []).length} model prices, ${localDbState.localStoreCount || 0} localStorage rows, ${localDbState.uiCacheCount || (localDbState.uiCacheItems || []).length || 0} UI cache items.`);
}

function userDraft() {
  return {
    id: els.userIdInput.value,
    name: els.userNameInput.value,
    role: selectedUser()?.role || "user",
    enabled: els.userEnabledInput.checked,
    defaultProfileId: els.userProfileInput.value || "default"
  };
}

async function loadUsersDb() {
  const result = await getJson("/api/users");
  localDbState = {
    ...(result.db || {}),
    users: result.users || result.db?.users || [],
    accounts: result.accounts || result.db?.accounts || [],
    serviceVisibility: result.serviceVisibility || result.db?.serviceVisibility || [],
    uiRules: result.uiRules || result.db?.uiRules || [],
    modelPolicies: result.modelPolicies || result.db?.modelPolicies || [],
    modelPrices: result.modelPrices || result.db?.modelPrices || [],
    modelUsage: result.modelUsage || result.db?.modelUsage || [],
    modelObservations: result.modelObservations || result.db?.modelObservations || [],
    creditWallets: result.creditWallets || result.db?.creditWallets || [],
    creditTransactions: result.creditTransactions || result.db?.creditTransactions || [],
    localStoreCount: result.localStoreCount || result.db?.localStore?.length || 0,
    uiCacheItems: result.uiCacheItems || result.db?.uiCacheItems || [],
    uiCacheCount: result.uiCacheCount || result.db?.uiCacheItems?.length || 0,
    activity: result.activity || result.db?.activity || [],
    portal: result.portal || result.db?.portal || {}
  };
  portalState = localDbState.portal || {};
  renderUserDb();
  return localDbState;
}

async function saveUser() {
  const result = await postJson("/api/users/save", { user: userDraft() });
  localDbState = result.db || localDbState;
  selectedUserId = userDraft().id || selectedUserId;
  renderUserDb();
  setLocalDbStatus("Da luu user DB local.");
}

async function setUserServiceAccess(serviceId, visible) {
  const result = await postJson("/api/users/service", {
    userId: selectedUserId,
    serviceId,
    visible
  });
  localDbState = result.db || localDbState;
  renderUserDb();
  setLocalDbStatus("Da cap nhat quyen dich vu cho user.");
}

function addAllowedModel(modelId) {
  const serviceId = selectedModelPriceServiceId();
  const service = serviceById(serviceId) || {};
  const prices = normalizeModelPriceDraft(serviceId, modelPriceDraft);
  if (!prices.some((price) => price.modelId === modelId)) {
    prices.push({
      serviceId,
      modelId,
      displayName: modelId,
      creditCost: Math.max(1, Math.round(Number(service.defaultCreditCost || els.modelDefaultCreditInput.value || 1))),
      enabled: true,
      isDefault: !prices.length && !service.defaultModel,
      observedFromLoader: true,
      source: "loader"
    });
  }
  markModelPriceDraftDirty();
  setModelPriceDraft(prices);

  if (selectedModelPolicyServiceId() === serviceId) {
    const models = modelListFromInput(els.modelAllowedModelsInput.value);
    if (!models.includes(modelId)) {
      models.push(modelId);
      els.modelAllowedModelsInput.value = models.join("\n");
    }
    if (!els.modelDefaultInput.value) {
      els.modelDefaultInput.value = modelId;
    }
  }
}

function renderModelObservedList() {
  if (!els.modelObservedList) return;
  const observations = selectedModelObservations();
  els.modelObservedList.innerHTML = "";

  if (!observations.length) {
    els.modelObservedList.innerHTML = `<div class="inline-status">Chưa log model nào. Mở browser nạp và gửi thử một request để hệ thống bắt model.</div>`;
    return;
  }

  for (const observation of observations) {
    const row = document.createElement("div");
    row.className = "model-observed-row";

    const meta = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = observation.modelId;
    const subtitle = document.createElement("span");
    subtitle.textContent = `${observation.count || 0} lan - ${observation.lastSeenAt || ""}`;
    meta.append(title, subtitle);

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.textContent = "Add";
    addButton.addEventListener("click", () => {
      addAllowedModel(observation.modelId);
      setLocalDbStatus(`Đã thêm model ${observation.modelId} vào bảng giá. Bấm Save model prices để lưu.`);
    });

    const testButton = document.createElement("button");
    testButton.type = "button";
    testButton.textContent = "Test";
    testButton.addEventListener("click", () => testModelPolicy(observation.modelId).catch((error) => {
      setLocalDbStatus(error.message || String(error), "error");
      showError(error);
    }));

    row.append(meta, addButton, testButton);
    els.modelObservedList.append(row);
  }
}

function modelListFromInput(value) {
  return Array.from(new Set(String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean))).slice(0, 80);
}

function modelCreditCostsFromInput(value) {
  const costs = {};
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [rawModel, rawCost = "1"] = line.includes("=") ? line.split("=") : line.split(/[\s,]+/);
    const modelId = String(rawModel || "").trim();
    const credit = Math.max(1, Math.round(Number(String(rawCost || "1").trim()) || 1));
    if (modelId) costs[modelId] = credit;
  }
  return costs;
}

function modelCreditCostsToInput(costs = {}) {
  return Object.entries(costs || {})
    .map(([modelId, credit]) => `${modelId}=${Math.max(1, Math.round(Number(credit || 1)))}`)
    .join("\n");
}

function creditCostForModel(policy, modelId) {
  const costs = policy?.modelCreditCosts || {};
  const fallback = Math.max(1, Math.round(Number(policy?.defaultCreditCost || 1)));
  return Math.max(1, Math.round(Number(costs[modelId] || fallback)));
}

function modelPolicyDraft() {
  const serviceId = selectedModelPolicyServiceId();
  const activePriceCosts = selectedModelPriceServiceId() === serviceId
    ? Object.fromEntries(normalizeModelPriceDraft(serviceId).filter((price) => price.enabled !== false).map((price) => [price.modelId, price.creditCost]))
    : modelPriceCostMap(serviceId);
  return {
    userId: selectedUserId,
    serviceId,
    enabled: els.modelPolicyEnabledInput.checked,
    allowedModels: modelListFromInput(els.modelAllowedModelsInput.value),
    dailyLimit: Math.max(0, Math.round(Number(els.modelDailyLimitInput.value || 0))),
    modelCreditCosts: activePriceCosts,
    defaultCreditCost: Math.max(1, Math.round(Number(els.modelDefaultCreditInput.value || 1))),
    blockUnknown: els.modelBlockUnknownInput.checked,
    defaultModel: String(els.modelDefaultInput.value || "").trim()
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function saveModelPolicy() {
  const draft = modelPolicyDraft();
  const result = await postJson("/api/users/model-policy", draft);
  localDbState = result.db || localDbState;
  renderUserDb();
  setLocalDbStatus(`Đã lưu safety policy ${draft.serviceId}: ${draft.allowedModels.length} model, cap ${draft.dailyLimit || "tắt"}.`);
}

async function saveModelPrices() {
  const serviceId = selectedModelPriceServiceId();
  const prices = normalizeModelPriceDraft(serviceId);
  const result = await postJson("/api/admin/model-prices", {
    serviceId,
    prices
  });
  localDbState = result.db || localDbState;
  modelPriceDraftDirty = false;
  renderUserDb();
  setLocalDbStatus(`Da luu ${prices.length} model price cho ${serviceNameById(serviceId)}.`);
}

async function adjustCredit() {
  const amountDelta = Math.round(Number(els.creditAdjustInput.value || 0));
  if (!amountDelta) throw new Error("Nhap so credit can nap/tru khac 0.");
  const result = await postJson("/api/admin/credits/adjust", {
    userId: selectedUserId,
    amountDelta,
    reason: els.creditReasonInput.value || (amountDelta > 0 ? "manual-topup" : "manual-adjust"),
    actor: "admin"
  });
  localDbState = result.db || localDbState;
  renderUserDb();
  setLocalDbStatus(`Da ${amountDelta > 0 ? "nap" : "tru"} ${formatCredit(Math.abs(amountDelta))} credit cho ${userNameById(selectedUserId)}.`);
}

async function kickUser() {
  const userId = selectedUserId;
  const result = await postJson("/api/auth/revoke", { userId });
  // Best-effort: also release any profile lock the kicked device held.
  await postJson("/api/profile/release", { profileId: selectedUser()?.defaultProfileId || "default", deviceId: "" }).catch(() => {});
  const revoked = Number(result?.revoked || 0);
  if (els.kickUserStatus) els.kickUserStatus.textContent = `Da thu hoi ${revoked} phien cua ${userNameById(userId)}.`;
  setLocalDbStatus(`Da kick ${userNameById(userId)} (thu hoi ${revoked} phien).`);
}

async function testModelPolicy(modelId = "") {
  const latest = await getJson("/api/users").catch(() => null);
  if (latest) {
    localDbState.modelUsage = latest.modelUsage || latest.db?.modelUsage || localDbState.modelUsage || [];
    localDbState.creditWallets = latest.creditWallets || latest.db?.creditWallets || localDbState.creditWallets || [];
  }

  const draft = modelPolicyDraft();
  const targetModel = String(modelId || draft.defaultModel || draft.allowedModels[0] || "").trim();
  if (draft.enabled !== true) {
    setLocalDbStatus("Test OK: policy đang tắt, user sẽ không bị giới hạn model.", "ok");
    return { allowed: true, reason: "policy-disabled" };
  }

  if (!targetModel) {
    if (draft.blockUnknown === true) {
      setLocalDbStatus("Test bi chan: request khong doc duoc model se bi chan.", "error");
      return { allowed: false, reason: "unknown-model-blocked" };
    }
    setLocalDbStatus("Test OK: request khong doc duoc model van duoc phep.", "ok");
    return { allowed: true, reason: "unknown-model-allowed" };
  }

  if (draft.allowedModels.length > 0 && !draft.allowedModels.includes(targetModel)) {
    setLocalDbStatus(`Test bị chặn: ${targetModel} không nằm trong allowed models hiện tại.`, "error");
    return { allowed: false, reason: "model-not-allowed", modelId: targetModel };
  }

  const usage = (localDbState.modelUsage || []).find((row) => (
    row.userId === draft.userId &&
    row.serviceId === draft.serviceId &&
    row.modelId === targetModel &&
    row.day === todayKey()
  ));
  const used = Number(usage?.credits ?? usage?.count ?? 0);
  const creditCost = creditCostForModel(draft, targetModel);
  const wallet = selectedWallet();
  const user = selectedUser();
  if (user?.role !== "loader" && Number(wallet.balance || 0) < creditCost) {
    setLocalDbStatus(`Test bi chan: vi ${userNameById(draft.userId)} chi con ${formatCredit(wallet.balance)} credit, model ton ${formatCredit(creditCost)}.`, "error");
    return { allowed: false, reason: "insufficient-credit", modelId: targetModel };
  }
  if (draft.dailyLimit > 0 && used + creditCost > draft.dailyLimit) {
    setLocalDbStatus(`Test bị chặn: ${targetModel} vượt safety daily cap, còn ${Math.max(0, draft.dailyLimit - used)}/${draft.dailyLimit}.`, "error");
    return { allowed: false, reason: "safety-daily-cap-reached", modelId: targetModel };
  }

  const capRemain = draft.dailyLimit > 0 ? Math.max(0, draft.dailyLimit - used - creditCost) : "tat";
  const balanceAfter = user?.role !== "loader" ? Math.max(0, Number(wallet.balance || 0) - creditCost) : Number(wallet.balance || 0);
  setLocalDbStatus(`Test OK: ${targetModel} tốn ${formatCredit(creditCost)} credit, ví sau request còn ${formatCredit(balanceAfter)}, safety cap còn ${capRemain}.`, "ok");
  return {
    allowed: true,
    reason: "allowed",
    modelId: targetModel,
    creditCost,
    remaining: balanceAfter
  };
}

async function checkSavedModelPolicy(modelId = "") {
  const draft = modelPolicyDraft();
  const targetModel = String(modelId || draft.defaultModel || draft.allowedModels[0] || "").trim();
  const result = await postJson("/api/users/model-usage/check", {
    userId: draft.userId,
    serviceId: draft.serviceId,
    modelId: targetModel,
    consume: false
  });
  if (result.allowed === false) {
    setLocalDbStatus(`Saved policy bị chặn: ${result.reason} (${targetModel || "unknown"}).`, "error");
  } else {
    const remain = result.remaining === null || result.remaining === undefined ? "khong gioi han" : result.remaining;
    setLocalDbStatus(`Saved policy OK: ${targetModel || "unknown"} tốn ${result.creditCost || 1} credit, còn ${remain}.`, "ok");
  }
  return result;
}

async function refreshModelObservations() {
  const result = await getJson("/api/users");
  localDbState.modelPrices = result.modelPrices || result.db?.modelPrices || localDbState.modelPrices || [];
  localDbState.modelPolicies = result.modelPolicies || result.db?.modelPolicies || localDbState.modelPolicies || [];
  localDbState.modelUsage = result.modelUsage || result.db?.modelUsage || localDbState.modelUsage || [];
  localDbState.modelObservations = result.modelObservations || result.db?.modelObservations || [];
  const changedService = syncModelPriceServiceSelection();
  if (changedService || !modelPriceDraftDirty) {
    renderModelPricing();
  } else {
    renderModelObservedList();
  }
}

async function saveUserRules() {
  const hideSelectors = extractHideSelectors(els.userHideSelectorsInput.value);
  const replaceRules = normalizeReplaceRules();
  const serviceId = selectedRuleServiceId();
  const result = await postJson("/api/users/ui-rules", {
    userId: selectedUserId,
    serviceId,
    enabled: els.userRuleEnabledInput.checked,
    hideSelectors,
    replaceRules
  });
  localDbState = result.db || localDbState;
  renderUserDb();
  setLocalDbStatus(`Da luu ${hideSelectors.length} selector an UI va ${replaceRules.length} rule doi text cho user.`);
  if (loaderRunning) {
    await previewUserRulesOnLoader({ serviceId, hideSelectors, replaceRules, keepLoaderService: true }).catch((error) => {
      setLoaderStatus(error.message || String(error), "error");
    });
  }
}

async function previewUserRulesOnLoader(options = {}) {
  const serviceId = options.serviceId || selectedRuleServiceId();
  const hideSelectors = options.hideSelectors || extractHideSelectors(els.userHideSelectorsInput.value);
  const replaceRules = options.replaceRules || normalizeReplaceRules();

  if (!options.keepLoaderService && els.loaderServiceSelect.value !== serviceId) {
    els.loaderServiceSelect.value = serviceId;
    syncLoaderUrlFromService();
  }

  if (!loaderRunning) {
    await openLoader();
  } else if (!options.keepLoaderService && selectedLoaderService()?.id === serviceId) {
    await postLoader("/api/navigate", { url: selectedLoaderService()?.url || els.loaderUrlInput.value });
  }

  const result = await postLoader("/api/users/ui-rules/preview", {
    userId: selectedUserId,
    serviceId,
    enabled: els.userRuleEnabledInput.checked,
    hideSelectors,
    replaceRules
  });
  const applied = result.preview?.applied || 0;
  const replaced = result.preview?.replaced || 0;
  const skipped = result.preview?.skipped || 0;
  const suffix = skipped ? `, bo qua ${skipped}` : "";
  setLoaderStatus(`Da test an ${applied} selector, doi text ${replaced} vung tren browser nap${suffix}.`);
  setLocalDbStatus(`Browser nạp đang dùng rule ${serviceId} cho user ${selectedUserId}.`);
  return result;
}

function addHideSelector(selector) {
  const clean = String(selector || "").trim();
  if (!selectorLooksUsable(clean)) return false;
  const selectors = extractHideSelectors(els.userHideSelectorsInput.value);
  if (!selectors.includes(clean)) selectors.push(clean);
  els.userHideSelectorsInput.value = selectors.join("\n");
  return true;
}

function addReplaceRule(rule = {}) {
  const clean = sanitizeReplaceRuleDraft(rule);
  if (!clean) return false;
  replaceRulesDraft = normalizeReplaceRules([...replaceRulesDraft, clean]);
  renderReplaceRulesList();
  return true;
}

async function selectAreaForUiRule(action = "hide") {
  if (!loaderRunning) {
    await openLoader();
  }

  setLoaderStatus(action === "replace"
    ? "Đang chờ bạn click vùng cần đổi nội dung trên browser nạp..."
    : "Đang chờ bạn click vùng cần ẩn trên browser nạp...");

  const result = await postLoader("/api/users/ui-rules/select", {
    action,
    timeoutMs: 45000
  });
  const selection = result.selection || {};
  if (!selection.ok || !selection.selector) {
    setLoaderStatus(selection.reason === "timeout" ? "Het thoi gian chon vung." : "Da huy chon vung.", "error");
    return;
  }

  if (action === "replace") {
    const text = String(els.visualReplaceTextInput?.value || "").trim() || selection.text || "";
    addReplaceRule({
      selector: selection.selector,
      text,
      matchText: selection.text || "",
      enabled: true
    });
    setLoaderStatus(`Da chon vung doi text: ${selection.selector}`);
    setLocalDbStatus("Đã thêm rule đổi text tạm. Bấm Test trên browser nạp hoặc Save UI rules.");
  } else {
    addHideSelector(selection.selector);
    setLoaderStatus(`Da chon vung an: ${selection.selector}`);
    setLocalDbStatus("Đã thêm selector ẩn UI tạm. Bấm Test trên browser nạp hoặc Save UI rules.");
  }

  await previewUserRulesOnLoader({ keepLoaderService: true }).catch((error) => {
    setLoaderStatus(error.message || String(error), "error");
  });
}

async function resetLocalDb() {
  const result = await postJson("/api/local-db/reset");
  localDbState = result.db || localDbState;
  selectedUserId = "local-user";
  renderUserDb();
  setLocalDbStatus("Da reset DB local ve du lieu test.");
}

function renderTunnel(tunnel = {}) {
  els.publicUrlInput.value = tunnel.displayUrl || tunnel.publicUrl || tunnel.candidateUrl || "";
  els.tunnelStatusInput.value = tunnel.message || "Cloudflare Tunnel chua bat.";
  els.startTunnelButton.disabled = tunnel.running && tunnel.status !== "error";
  els.stopTunnelButton.disabled = !tunnel.running;
  els.copyTunnelButton.disabled = tunnel.status !== "ready" || !tunnel.publicUrl;
  if (tunnel.config?.hostname) {
    els.apiDomainInput.value = tunnel.config.hostname;
  }
}

function renderTunnelConfig(config = {}) {
  els.apiDomainInput.value = config.hostname || "api-centrixapp.centrix.asia";
  els.publicUrlInput.value = config.publicUrl || "";
  els.tunnelTokenInput.value = "";
  els.tunnelTokenInput.placeholder = config.hasToken
    ? "Da luu token. Nhap token moi neu can thay doi."
    : "Token cua named tunnel trong Cloudflare Zero Trust";
}

function selectedLoaderService() {
  return (servicesConfig.services || []).find((service) => service.id === els.loaderServiceSelect.value);
}

function serviceOrigin(service) {
  try {
    return new URL(service?.url || "").origin;
  } catch {
    return "";
  }
}

function serviceIdFromUrl(url) {
  let origin = "";
  try {
    origin = new URL(url || "").origin;
  } catch {
    return "";
  }

  return (servicesConfig.services || []).find((service) => serviceOrigin(service) === origin)?.id || "";
}

function syncLoaderUrlFromService() {
  const service = selectedLoaderService();
  const url = service?.loginUrl || service?.url || "";
  if (url) {
    els.loaderUrlInput.value = url;
    localStorage.setItem("centrixServerLoaderUrl", url);
  }
}

function renderLoaderServices() {
  const services = servicesConfig.services || [];
  const saved = localStorage.getItem("centrixServerLoaderServiceId");
  const previous = els.loaderServiceSelect.value || saved || selectedServiceId || services[0]?.id || "";

  els.loaderServiceSelect.innerHTML = "";

  if (!services.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Chưa có dịch vụ";
    els.loaderServiceSelect.append(option);
    return;
  }

  for (const service of services) {
    const option = document.createElement("option");
    option.value = service.id;
    option.textContent = `${service.name || service.id}${service.enabled === false ? " (off)" : ""}`;
    els.loaderServiceSelect.append(option);
  }

  els.loaderServiceSelect.value = services.some((service) => service.id === previous) ? previous : services[0].id;
  syncLoaderUrlFromService();
}

function selectService(serviceId) {
  selectedServiceId = serviceId || "";
  const service = servicesConfig.services.find((item) => item.id === selectedServiceId);
  els.serviceNameInput.value = service?.name || "";
  els.serviceUrlInput.value = service?.url || "";
  els.serviceLoginUrlInput.value = service?.loginUrl || service?.url || "";
  els.serviceIconInput.value = service?.iconUrl || "";
  els.serviceEnabledInput.checked = service?.enabled !== false;
  els.servicePricingEnabledInput.checked = service?.modelPricingEnabled !== false;
  els.serviceDefaultModelInput.value = service?.defaultModel || "";
  els.serviceDefaultCreditInput.value = String(service?.defaultCreditCost || 1);
  renderServices();
}

function renderServices() {
  els.serviceList.innerHTML = "";

  for (const service of servicesConfig.services || []) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `service-row${service.id === selectedServiceId ? " active" : ""}${service.enabled === false ? " disabled" : ""}`;
    row.innerHTML = `
      <strong>${escapeHtml(service.name || service.id)}</strong>
      <span>${escapeHtml(service.url || "")}${service.modelPricingEnabled === false ? " - pricing off" : ""}</span>
    `;
    row.addEventListener("click", () => selectService(service.id));
    els.serviceList.append(row);
  }
}

function draftService() {
  return {
    id: selectedServiceId,
    name: els.serviceNameInput.value,
    url: els.serviceUrlInput.value,
    loginUrl: els.serviceLoginUrlInput.value || els.serviceUrlInput.value,
    iconUrl: els.serviceIconInput.value,
    enabled: els.serviceEnabledInput.checked,
    modelPricingEnabled: els.servicePricingEnabledInput.checked,
    defaultModel: els.serviceDefaultModelInput.value,
    defaultCreditCost: Math.max(1, Math.round(Number(els.serviceDefaultCreditInput.value || 1)))
  };
}

async function loadHealth() {
  const result = await getJson("/api/health");
  const lanUrls = result.lanUrls || [];
  els.localUrlInput.value = result.localUrl || "";
  els.lanUrlInput.value = lanUrls.find((url) => /^http:\/\/100\./.test(url)) || lanUrls[0] || "";
  els.tokenInput.value = token || "";
  els.networkStatusInput.value = result.host === "0.0.0.0"
    ? `Đang nghe tất cả IP trên port ${result.port || 19778}`
    : `Đang nghe ${result.host || "localhost"}:${result.port || 19778}`;
  els.firewallStatusInput.value = result.firewall?.message || "Chưa có thông tin firewall.";
  renderTunnel(result.tunnel || {});
}

async function loadTunnel() {
  const result = await getJson("/api/tunnel");
  renderTunnel(result.tunnel || {});
  return result.tunnel;
}

async function loadTunnelConfig() {
  const result = await getJson("/api/tunnel/config");
  renderTunnelConfig(result.config || {});
  return result.config;
}

function tunnelConfigDraft() {
  return {
    hostname: els.apiDomainInput.value,
    token: els.tunnelTokenInput.value
  };
}

async function saveTunnelConfig() {
  const result = await postJson("/api/tunnel/config", tunnelConfigDraft());
  renderTunnelConfig(result.config || {});
  setStatus("Da luu cau hinh Tunnel");
  return result.config;
}

async function startTunnel() {
  renderTunnel({ running: true, status: "starting", message: "Đang bật Cloudflare Tunnel..." });
  const result = await postJson("/api/tunnel/start", tunnelConfigDraft());
  renderTunnel(result.tunnel || {});
  setStatus("Tunnel starting");
  return result.tunnel;
}

async function stopTunnel() {
  renderTunnel({ running: true, status: "stopping", message: "Đang tắt Cloudflare Tunnel..." });
  const result = await postJson("/api/tunnel/stop");
  renderTunnel(result.tunnel || {});
  setStatus("Tunnel stopped");
}

async function copyTunnelUrl() {
  const url = String(els.publicUrlInput.value || "").trim();
  if (!url) return;
  await navigator.clipboard.writeText(url);
  setStatus("Da copy Public URL");
}

async function loadServices() {
  const result = await getJson("/api/services");
  servicesConfig = result.config || { services: [] };
  if (selectedServiceId && !servicesConfig.services?.some((service) => service.id === selectedServiceId)) {
    selectedServiceId = "";
  }
  if (!selectedServiceId && servicesConfig.services?.length) {
    selectedServiceId = servicesConfig.services[0].id;
  }
  selectService(selectedServiceId);
  renderLoaderServices();
  if (localDbState.users?.length) renderUserDb();
  els.serviceStatus.textContent = `API: ${result.serviceCount ?? servicesConfig.services?.length ?? 0} services`;
}

async function saveService() {
  const draft = draftService();
  const nextServices = [...(servicesConfig.services || [])];
  const index = selectedServiceId ? nextServices.findIndex((service) => service.id === selectedServiceId) : -1;

  if (index >= 0) {
    nextServices[index] = draft;
  } else {
    nextServices.push({ ...draft, id: "" });
  }

  const result = await postJson("/api/services/save", { services: nextServices });
  servicesConfig = result.config;
  selectedServiceId = servicesConfig.services.find((service) => service.name === draft.name && service.url === draft.url)?.id || selectedServiceId;
  selectService(selectedServiceId);
  renderLoaderServices();
  if (localDbState.users?.length) renderUserDb();
  els.serviceStatus.textContent = `Saved - ${servicesConfig.services?.length || 0} services`;
}

async function deleteService() {
  if (!selectedServiceId) return;
  const nextServices = (servicesConfig.services || []).filter((service) => service.id !== selectedServiceId);
  const result = await postJson("/api/services/save", { services: nextServices });
  servicesConfig = result.config;
  selectedServiceId = servicesConfig.services[0]?.id || "";
  selectService(selectedServiceId);
  renderLoaderServices();
  if (localDbState.users?.length) renderUserDb();
  els.serviceStatus.textContent = `Deleted - ${servicesConfig.services?.length || 0} services`;
}

async function resetServices() {
  const result = await postJson("/api/services/reset");
  servicesConfig = result.config;
  selectedServiceId = servicesConfig.services[0]?.id || "";
  selectService(selectedServiceId);
  renderLoaderServices();
  if (localDbState.users?.length) renderUserDb();
  els.serviceStatus.textContent = `Reset - ${servicesConfig.services?.length || 0} services`;
}

function resetLoaderSession(message = "Chưa mở browser nạp data.") {
  loaderRunning = false;
  els.loaderTitleLabel.textContent = "Profile loader";
  els.loaderUrlLabel.textContent = "Bấm Mở browser nạp để bắt đầu.";
  els.loaderNativeState.classList.add("is-empty");
  setLoaderStatus(message);
}

function renderLoaderState(state) {
  if (!state) return;
  const wasRunning = loaderRunning;
  loaderRunning = true;
  els.loaderNativeState.classList.remove("is-empty");

  if (!wasRunning) {
    const runningServiceId = state.serviceId || serviceIdFromUrl(state.url);
    if (runningServiceId && (servicesConfig.services || []).some((service) => service.id === runningServiceId)) {
      els.loaderServiceSelect.value = runningServiceId;
      localStorage.setItem("centrixServerLoaderServiceId", runningServiceId);
      syncLoaderUrlFromService();
    }
  }

  els.loaderTitleLabel.textContent = state.title || state.serviceName || state.tabId || "Profile loader";
  els.loaderUrlLabel.textContent = state.url || "-";
  els.loaderProfileInput.value = state.profileId || els.loaderProfileInput.value || "default";
  els.loaderBackButton.disabled = !state.canGoBack;
  els.loaderForwardButton.disabled = !state.canGoForward;
  setLoaderStatus(`${state.loading ? "Đang tải" : "Sẵn sàng"} - browser đang mở trực tiếp - profile ${state.profileId || "default"}`);
}

function renderTabs(tabs) {
  activeTabsState = Array.isArray(tabs) ? tabs : [];
  const changedModelService = syncModelPriceServiceSelection();
  if (changedModelService && !modelPriceDraftDirty) {
    renderModelPricing();
  } else if (changedModelService) {
    renderModelObservedList();
  }

  els.tabList.innerHTML = "";

  const loaderTab = tabs.find((tab) => tab.tabId === loaderTabId());
  if (loaderTab) {
    renderLoaderState(loaderTab);
  } else if (loaderRunning) {
    resetLoaderSession("Browser nap data da dong.");
  }

  if (!tabs.length) {
    els.tabList.innerHTML = `<div class="tab-row"><div class="tab-meta"><strong>Chưa có tab đang chạy</strong><span>User app hoặc nút Nạp data sẽ tạo tab sau khi login.</span></div></div>`;
    return;
  }

  for (const tab of tabs) {
    const row = document.createElement("div");
    row.className = `tab-row${tab.localUser ? " local-user" : ""}`;

    if (tab.localUser) {
      row.innerHTML = `
        <div class="tab-meta">
          <strong>${escapeHtml(tab.serviceName || tab.tabId)}</strong>
          <span>Local User - ${escapeHtml(tab.userId || tab.deviceId || "user")} - ${escapeHtml(tab.profileId || "default")} - ${escapeHtml(tab.title || tab.url || "-")}</span>
        </div>
        <div class="tab-badge">Local</div>
      `;
    } else {
      row.innerHTML = `
        <div class="tab-meta">
          <strong>${escapeHtml(tab.serviceName || tab.tabId)}</strong>
          <span>${escapeHtml(tab.profileId || "default")} - ${escapeHtml(tab.title || tab.url || "-")}</span>
        </div>
        <button type="button" data-action="focus">Focus</button>
        <button type="button" data-action="close">Close</button>
      `;
      row.querySelector('[data-action="focus"]').addEventListener("click", () => postJson("/api/show", { tabId: tab.tabId }).then(refresh).catch(showError));
      row.querySelector('[data-action="close"]').addEventListener("click", () => {
        if (tab.tabId === loaderTabId()) resetLoaderSession("Browser nap data da dong.");
        postJson("/api/close", { tabId: tab.tabId }).then(refresh).catch(showError);
      });
    }
    els.tabList.append(row);
  }
}

async function loadTabs() {
  const result = await getJson("/api/tabs");
  renderTabs(result.tabs || []);
}

async function openLoader() {
  const service = selectedLoaderService();
  syncLoaderUrlFromService();
  const url = String(service?.loginUrl || service?.url || els.loaderUrlInput.value || "").trim();
  if (!url) {
    throw new Error("Chưa có URL login để nạp data.");
  }

  localStorage.setItem("centrixServerLoaderServiceId", els.loaderServiceSelect.value || "");
  localStorage.setItem("centrixServerLoaderUrl", url);
  localStorage.setItem("centrixServerLoaderProfile", loaderProfileId());
  localStorage.setItem("centrixServerLoaderTab", loaderTabId());

  const result = await postLoader("/api/open", {
    profileId: loaderProfileId(),
    serviceId: service?.id || "",
    serviceName: service?.name || "",
    url,
    width: 1280,
    height: 820,
    show: true,
    focus: true
  });
  renderLoaderState(result.state);
  await postLoader("/api/show").catch(() => {});
  await loadTabs();
}

async function closeLoader() {
  if (!requireLoaderRunning()) return;
  const tabId = loaderTabId();
  resetLoaderSession("Da dong browser nap data.");
  await postJson("/api/close", { tabId });
  await loadTabs();
}

async function refresh() {
  try {
    await loadTunnelConfig();
    await loadHealth();
    await loadServices();
    await loadUsersDb();
    await loadTabs();
    setStatus("Ready");
  } catch (error) {
    showError(error);
  }
}

els.refreshButton.addEventListener("click", refresh);
els.saveTunnelConfigButton.addEventListener("click", () => saveTunnelConfig().catch(showError));
els.startTunnelButton.addEventListener("click", () => startTunnel().catch(showError));
els.stopTunnelButton.addEventListener("click", () => stopTunnel().catch(showError));
els.copyTunnelButton.addEventListener("click", () => copyTunnelUrl().catch(showError));
els.dashboardRefreshButton?.addEventListener("click", () => loadUsersDb().catch(showError));
els.userSelect.addEventListener("change", () => {
  selectedUserId = els.userSelect.value || "local-user";
  renderUserDb();
});
els.activityUserSelect?.addEventListener("change", () => {
  selectedActivityUserId = els.activityUserSelect.value || "__all";
  localStorage.setItem("centrixServerActivityUser", selectedActivityUserId);
  renderActivityList();
});
els.activityRefreshButton?.addEventListener("click", () => loadUsersDb().catch(showError));
els.saveUserButton.addEventListener("click", () => saveUser().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  showError(error);
}));
els.resetLocalDbButton.addEventListener("click", () => resetLocalDb().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  showError(error);
}));
els.adjustCreditButton?.addEventListener("click", () => adjustCredit().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  showError(error);
}));
els.kickUserButton?.addEventListener("click", () => kickUser().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  showError(error);
}));
els.userRuleServiceSelect.addEventListener("change", renderUserRuleEditor);
els.selectHideAreaButton?.addEventListener("click", () => selectAreaForUiRule("hide").catch((error) => {
  setLoaderStatus(error.message || String(error), "error");
  showError(error);
}));
els.selectReplaceAreaButton?.addEventListener("click", () => selectAreaForUiRule("replace").catch((error) => {
  setLoaderStatus(error.message || String(error), "error");
  showError(error);
}));
els.addReplaceRuleButton?.addEventListener("click", () => {
  const selector = extractHideSelectors(els.userHideSelectorsInput.value).slice(-1)[0] || "[data-testid='target']";
  const added = addReplaceRule({
    selector,
    text: els.visualReplaceTextInput?.value || "",
    enabled: true
  });
  if (added) {
    setLocalDbStatus("Đã thêm rule đổi text mới. Sửa selector/text rồi bấm Save UI rules.");
  } else {
    setLocalDbStatus("Chưa thêm được rule đổi text. Hãy chọn vùng trên browser nạp trước.", "error");
  }
});
els.modelPriceServiceSelect?.addEventListener("change", () => {
  modelPriceServiceTouched = true;
  modelPriceDraftDirty = false;
  renderModelPricing();
});
els.addModelPriceButton?.addEventListener("click", addBlankModelPrice);
els.modelCreditCostsInput?.addEventListener("input", () => {
  markModelPriceDraftDirty();
  modelPriceDraft = modelPricesFromInput(selectedModelPriceServiceId(), els.modelCreditCostsInput?.value || "");
  renderModelPriceList(modelPriceDraft);
});
els.saveModelPricesButton?.addEventListener("click", () => saveModelPrices().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  showError(error);
}));
els.modelPolicyServiceSelect?.addEventListener("change", renderModelPolicyEditor);
els.saveUserRulesButton.addEventListener("click", () => saveUserRules().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  showError(error);
}));
els.previewUserRulesButton?.addEventListener("click", () => previewUserRulesOnLoader().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  setLoaderStatus(error.message || String(error), "error");
  showError(error);
}));
els.saveModelPolicyButton?.addEventListener("click", () => saveModelPolicy().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  showError(error);
}));
els.testModelPolicyButton?.addEventListener("click", () => testModelPolicy().catch((error) => {
  setLocalDbStatus(error.message || String(error), "error");
  showError(error);
}));
els.ledgerRefreshButton?.addEventListener("click", () => loadUsersDb().catch(showError));
for (const button of els.portalAddButtons || []) {
  button.addEventListener("click", () => addPortalRecord(button.dataset.portalAdd).catch(showError));
}
els.assistantRefreshButton?.addEventListener("click", () => {
  renderPortalModules();
  setLocalDbStatus("Da tao goi y van hanh tu du lieu hien tai.");
});
els.newServiceButton.addEventListener("click", () => selectService(""));
els.serviceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveService().catch(showError);
});
els.deleteServiceButton.addEventListener("click", () => deleteService().catch(showError));
els.resetServicesButton.addEventListener("click", () => resetServices().catch(showError));
for (const button of els.adminNavButtons) {
  button.addEventListener("click", () => setAdminView(button.dataset.adminView));
}
for (const button of document.querySelectorAll("[data-server-theme]")) {
  button.addEventListener("click", () => applyServerTheme(button.dataset.serverTheme));
}

els.loaderServiceSelect.addEventListener("change", () => {
  localStorage.setItem("centrixServerLoaderServiceId", els.loaderServiceSelect.value || "");
  syncLoaderUrlFromService();
  const service = selectedLoaderService();
  if (loaderRunning && service?.name) {
    setLoaderStatus(`Đã chọn ${service.name}. Bấm Mở browser nạp để chuyển browser.`, "");
  }
});
els.loaderOpenButton.addEventListener("click", () => openLoader().catch((error) => {
  setLoaderStatus(error.message || String(error), "error");
  showError(error);
}));
els.loaderShowButton.addEventListener("click", () => {
  if (requireLoaderRunning()) postLoader("/api/show").then(loadTabs).catch(showError);
});
els.loaderBackButton.addEventListener("click", () => {
  if (requireLoaderRunning()) postLoader("/api/back").catch(showError);
});
els.loaderForwardButton.addEventListener("click", () => {
  if (requireLoaderRunning()) postLoader("/api/forward").catch(showError);
});
els.loaderReloadButton.addEventListener("click", () => {
  if (requireLoaderRunning()) postLoader("/api/reload").catch(showError);
});
els.loaderCloseButton.addEventListener("click", () => closeLoader().catch(showError));
els.loaderTabInput.addEventListener("change", () => {
  localStorage.setItem("centrixServerLoaderTab", loaderTabId());
  resetLoaderSession("Đã đổi tab nạp data. Bấm Mở browser nạp để chạy tab mới.");
  loadTabs().catch(showError);
});
els.loaderProfileInput.addEventListener("change", () => {
  localStorage.setItem("centrixServerLoaderProfile", loaderProfileId());
});

resetLoaderSession();
applyServerTheme(localStorage.getItem(THEME_STORAGE_KEY) || "light");
setAdminView(localStorage.getItem(ADMIN_VIEW_KEY) || "dashboard");
refresh();
setInterval(() => loadTabs().catch(showError), 1600);
setInterval(() => loadTunnel().catch(() => {}), 2400);
setInterval(() => refreshModelObservations().catch(() => {}), 5000);
setInterval(() => {
  if (localStorage.getItem(ADMIN_VIEW_KEY) === "activity") {
    loadUsersDb().catch(() => {});
  }
}, 5000);
