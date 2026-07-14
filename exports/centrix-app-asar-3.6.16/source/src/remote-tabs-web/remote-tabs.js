const query = new URLSearchParams(window.location.search);
const initialTabId = query.get("tabId") || query.get("tab") || "tab-a";
const initialToken = query.get("token") || localStorage.getItem("centrixSharedTabsToken") || "";

if (initialToken) {
  localStorage.setItem("centrixSharedTabsToken", initialToken);
}

const els = {
  statusLabel: document.querySelector("#statusLabel"),
  navForm: document.querySelector("#navForm"),
  urlInput: document.querySelector("#urlInput"),
  backButton: document.querySelector("#backButton"),
  forwardButton: document.querySelector("#forwardButton"),
  reloadButton: document.querySelector("#reloadButton"),
  browserFrame: document.querySelector("#browserFrame"),
  frameHint: document.querySelector("#frameHint"),
  tabInput: document.querySelector("#tabInput"),
  profileInput: document.querySelector("#profileInput"),
  proxyInput: document.querySelector("#proxyInput"),
  openButton: document.querySelector("#openButton"),
  typeInput: document.querySelector("#typeInput"),
  typeButton: document.querySelector("#typeButton"),
  enterButton: document.querySelector("#enterButton"),
  widthInput: document.querySelector("#widthInput"),
  heightInput: document.querySelector("#heightInput"),
  resizeButton: document.querySelector("#resizeButton"),
  actualSizeButton: document.querySelector("#actualSizeButton"),
  fitWidthButton: document.querySelector("#fitWidthButton"),
  showButton: document.querySelector("#showButton"),
  hideButton: document.querySelector("#hideButton"),
  devtoolsButton: document.querySelector("#devtoolsButton"),
  closeButton: document.querySelector("#closeButton"),
  tabALink: document.querySelector("#tabALink"),
  tabBLink: document.querySelector("#tabBLink"),
  localUrlLabel: document.querySelector("#localUrlLabel"),
  lanUrlLabel: document.querySelector("#lanUrlLabel"),
  tokenLabel: document.querySelector("#tokenLabel"),
  serverServiceList: document.querySelector("#serverServiceList"),
  serviceNameInput: document.querySelector("#serviceNameInput"),
  serviceUrlInput: document.querySelector("#serviceUrlInput"),
  serviceIconInput: document.querySelector("#serviceIconInput"),
  serviceEnabledInput: document.querySelector("#serviceEnabledInput"),
  serviceNewButton: document.querySelector("#serviceNewButton"),
  serviceSaveButton: document.querySelector("#serviceSaveButton"),
  serviceDeleteButton: document.querySelector("#serviceDeleteButton"),
  serviceResetButton: document.querySelector("#serviceResetButton"),
  serviceStatus: document.querySelector("#serviceStatus"),
  tabLabel: document.querySelector("#tabLabel"),
  profileLabel: document.querySelector("#profileLabel"),
  partitionLabel: document.querySelector("#partitionLabel"),
  titleLabel: document.querySelector("#titleLabel"),
  sizeLabel: document.querySelector("#sizeLabel"),
  errorLabel: document.querySelector("#errorLabel")
};

let frameDelay = 420;
let frameTimer = null;
let stateTimer = null;
let lastMoveAt = 0;
let fitMode = localStorage.getItem("centrixSharedTabsFitMode") || "actual";
let activeTabId = initialTabId;
let servicesConfig = { services: [] };
let selectedServiceId = "";

els.tabInput.value = activeTabId;
els.tabALink.href = `/?tabId=tab-a${initialToken ? `&token=${encodeURIComponent(initialToken)}` : ""}`;
els.tabBLink.href = `/?tabId=tab-b${initialToken ? `&token=${encodeURIComponent(initialToken)}` : ""}`;

function currentTabId() {
  activeTabId = (els.tabInput.value || activeTabId || "tab-a").trim() || "tab-a";
  return activeTabId;
}

function apiPath(path) {
  return `${path}?tabId=${encodeURIComponent(currentTabId())}`;
}

function authHeaders(extra = {}) {
  return initialToken
    ? { ...extra, Authorization: `Bearer ${initialToken}` }
    : extra;
}

function tokenQuery() {
  return initialToken ? `&token=${encodeURIComponent(initialToken)}` : "";
}

async function api(path, payload = {}) {
  const response = await fetch(apiPath(path), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ...payload, tabId: currentTabId() })
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "Request failed");
  if (result.state) renderState(result.state);
  return result;
}

async function getState() {
  const response = await fetch(apiPath("/api/state"), {
    cache: "no-store",
    headers: authHeaders()
  });
  const result = await response.json();
  if (result.ok) renderState(result.state);
}

async function getAuthed(path) {
  const response = await fetch(path, {
    cache: "no-store",
    headers: authHeaders()
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function postAuthed(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function getServerInfo() {
  const response = await fetch("/api/health", { cache: "no-store" });
  const result = await response.json();
  if (!result.ok) return;
  els.localUrlLabel.textContent = result.localUrl || "-";
  els.lanUrlLabel.textContent = (result.lanUrls || []).join("  ") || "-";
  els.tokenLabel.textContent = initialToken || "No token required";
}

function setServiceStatus(message) {
  els.serviceStatus.textContent = message || "";
}

function selectService(serviceId) {
  selectedServiceId = serviceId || "";
  const service = servicesConfig.services.find((item) => item.id === selectedServiceId);
  els.serviceNameInput.value = service?.name || "";
  els.serviceUrlInput.value = service?.url || "";
  els.serviceIconInput.value = service?.iconUrl || "";
  els.serviceEnabledInput.checked = service?.enabled !== false;
  renderServerServices();
}

function renderServerServices() {
  els.serverServiceList.innerHTML = "";

  for (const service of servicesConfig.services || []) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `server-service-row${service.id === selectedServiceId ? " active" : ""}${service.enabled === false ? " disabled" : ""}`;
    // textContent (not innerHTML): server-controlled service.name is rendered as inert text, so markup in a
    // service name can never execute in this page — which holds the tab/browser control token. Fail-closed
    // by construction: there is no escape call to forget.
    const nameEl = document.createElement("span");
    nameEl.textContent = service.name || service.id;
    const stateEl = document.createElement("small");
    stateEl.textContent = service.enabled === false ? "Off" : "On";
    row.append(nameEl, stateEl);
    row.addEventListener("click", () => selectService(service.id));
    els.serverServiceList.append(row);
  }
}

async function loadServices() {
  const result = await getAuthed("/api/services");
  servicesConfig = result.config || { services: [] };
  if (!selectedServiceId && servicesConfig.services?.length) {
    selectedServiceId = servicesConfig.services[0].id;
  }
  selectService(selectedServiceId);
  setServiceStatus(`${servicesConfig.services?.length || 0} services`);
}

function draftService() {
  return {
    id: selectedServiceId,
    name: els.serviceNameInput.value,
    url: els.serviceUrlInput.value,
    iconUrl: els.serviceIconInput.value,
    enabled: els.serviceEnabledInput.checked
  };
}

async function saveService() {
  const draft = draftService();
  const nextServices = [...(servicesConfig.services || [])];
  const existingIndex = selectedServiceId ? nextServices.findIndex((item) => item.id === selectedServiceId) : -1;

  if (existingIndex >= 0) {
    nextServices[existingIndex] = draft;
  } else {
    nextServices.push({ ...draft, id: "" });
  }

  const result = await postAuthed("/api/services/save", { services: nextServices });
  servicesConfig = result.config;
  selectedServiceId = servicesConfig.services.find((item) => item.name === draft.name && item.url === draft.url)?.id || selectedServiceId;
  selectService(selectedServiceId);
  setServiceStatus("Saved");
}

async function deleteService() {
  if (!selectedServiceId) return;
  const nextServices = (servicesConfig.services || []).filter((service) => service.id !== selectedServiceId);
  const result = await postAuthed("/api/services/save", { services: nextServices });
  servicesConfig = result.config;
  selectedServiceId = servicesConfig.services[0]?.id || "";
  selectService(selectedServiceId);
  setServiceStatus("Deleted");
}

async function resetServices() {
  const result = await postAuthed("/api/services/reset");
  servicesConfig = result.config;
  selectedServiceId = servicesConfig.services[0]?.id || "";
  selectService(selectedServiceId);
  setServiceStatus("Reset");
}

function renderState(state) {
  if (!state) return;
  activeTabId = state.tabId || currentTabId();
  els.tabInput.value = activeTabId;
  els.statusLabel.textContent = state.loading ? "loading" : state.url || "ready";
  els.urlInput.value = state.url || els.urlInput.value;
  els.profileInput.value = state.profileId || els.profileInput.value || "default";
  els.tabLabel.textContent = state.tabId || "-";
  els.profileLabel.textContent = state.profileId || "default";
  els.partitionLabel.textContent = state.partition || "-";
  els.titleLabel.textContent = state.title || "-";
  els.sizeLabel.textContent = `${state.width || "-"} x ${state.height || "-"}`;
  els.errorLabel.textContent = state.lastError || "-";
  els.widthInput.value = state.width || els.widthInput.value;
  els.heightInput.value = state.height || els.heightInput.value;
  els.backButton.disabled = !state.canGoBack;
  els.forwardButton.disabled = !state.canGoForward;
}

function renderFitMode() {
  const wrap = els.browserFrame.closest(".viewport-wrap");
  const fitWidth = fitMode === "fit-width";
  wrap.classList.toggle("fit-width", fitWidth);
  els.actualSizeButton.classList.toggle("active", !fitWidth);
  els.fitWidthButton.classList.toggle("active", fitWidth);
}

function setFitMode(nextMode) {
  fitMode = nextMode;
  localStorage.setItem("centrixSharedTabsFitMode", fitMode);
  renderFitMode();
}

function setError(error) {
  els.statusLabel.textContent = error.message || String(error);
  els.errorLabel.textContent = error.message || String(error);
}

function refreshFrame() {
  clearTimeout(frameTimer);
  els.browserFrame.src = `/api/frame?tabId=${encodeURIComponent(currentTabId())}${tokenQuery()}&t=${Date.now()}`;
}

function scheduleFrame() {
  frameTimer = setTimeout(refreshFrame, frameDelay);
}

function pointFromEvent(event) {
  const rect = els.browserFrame.getBoundingClientRect();
  const scaleX = els.browserFrame.naturalWidth / rect.width;
  const scaleY = els.browserFrame.naturalHeight / rect.height;
  return {
    x: Math.max(0, Math.round((event.clientX - rect.left) * scaleX)),
    y: Math.max(0, Math.round((event.clientY - rect.top) * scaleY))
  };
}

function supportedControlKey(key) {
  return [
    "Backspace",
    "Delete",
    "Enter",
    "Escape",
    "Tab",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown"
  ].includes(key);
}

els.browserFrame.addEventListener("load", scheduleFrame);
els.browserFrame.addEventListener("error", scheduleFrame);

els.browserFrame.addEventListener("click", async (event) => {
  try {
    els.browserFrame.focus();
    els.frameHint.style.display = "none";
    await api("/api/click", pointFromEvent(event));
  } catch (error) {
    setError(error);
  }
});

els.browserFrame.addEventListener("mousemove", async (event) => {
  const now = Date.now();
  if (now - lastMoveAt < 90) return;
  lastMoveAt = now;
  try {
    await api("/api/move", pointFromEvent(event));
  } catch {
    // Mouse move failures are non-critical while the frame is refreshing.
  }
});

els.browserFrame.addEventListener(
  "wheel",
  async (event) => {
    event.preventDefault();
    try {
      await api("/api/wheel", {
        ...pointFromEvent(event),
        deltaX: event.deltaX,
        deltaY: event.deltaY
      });
    } catch (error) {
      setError(error);
    }
  },
  { passive: false }
);

els.browserFrame.addEventListener("keydown", async (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  try {
    if (event.key.length === 1) {
      event.preventDefault();
      await api("/api/type", { text: event.key });
      return;
    }

    if (supportedControlKey(event.key)) {
      event.preventDefault();
      await api("/api/key", { key: event.key });
    }
  } catch (error) {
    setError(error);
  }
});

els.navForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/navigate", { url: els.urlInput.value });
  } catch (error) {
    setError(error);
  }
});

els.backButton.addEventListener("click", () => api("/api/back").catch(setError));
els.forwardButton.addEventListener("click", () => api("/api/forward").catch(setError));
els.reloadButton.addEventListener("click", () => api("/api/reload").catch(setError));

els.openButton.addEventListener("click", () => {
  currentTabId();
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("tabId", activeTabId);
  if (initialToken) nextUrl.searchParams.set("token", initialToken);
  window.history.replaceState(null, "", nextUrl.toString());
  api("/api/open", {
    profileId: els.profileInput.value,
    proxyRules: els.proxyInput.value,
    url: els.urlInput.value,
    width: els.widthInput.value,
    height: els.heightInput.value
  })
    .then(refreshFrame)
    .catch(setError);
});

els.typeButton.addEventListener("click", async () => {
  try {
    await api("/api/type", { text: els.typeInput.value });
    els.typeInput.value = "";
  } catch (error) {
    setError(error);
  }
});

els.enterButton.addEventListener("click", () => api("/api/key", { key: "Enter" }).catch(setError));

els.resizeButton.addEventListener("click", () => {
  api("/api/resize", {
    width: els.widthInput.value,
    height: els.heightInput.value
  }).catch(setError);
});

els.actualSizeButton.addEventListener("click", () => setFitMode("actual"));
els.fitWidthButton.addEventListener("click", () => setFitMode("fit-width"));
els.showButton.addEventListener("click", () => api("/api/show").catch(setError));
els.hideButton.addEventListener("click", () => api("/api/hide").catch(setError));
els.devtoolsButton.addEventListener("click", () => api("/api/devtools").catch(setError));
els.closeButton.addEventListener("click", () => api("/api/close").catch(setError));
els.serviceNewButton.addEventListener("click", () => selectService(""));
els.serviceSaveButton.addEventListener("click", () => saveService().catch(setError));
els.serviceDeleteButton.addEventListener("click", () => deleteService().catch(setError));
els.serviceResetButton.addEventListener("click", () => resetServices().catch(setError));

els.tabInput.addEventListener("change", () => {
  currentTabId();
  refreshFrame();
  getState().catch(setError);
});

renderFitMode();
getServerInfo().catch(setError);
loadServices().catch(setError);
refreshFrame();
getState().catch(setError);
stateTimer = setInterval(() => getState().catch(setError), 1200);

window.addEventListener("beforeunload", () => {
  clearTimeout(frameTimer);
  clearInterval(stateTimer);
});
