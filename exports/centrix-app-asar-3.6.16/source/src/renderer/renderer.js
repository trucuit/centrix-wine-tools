const api = window.centrixBrowser;
let browserChromeVisible = false;

const els = {
  urlForm: document.querySelector("#urlForm"),
  urlInput: document.querySelector("#urlInput"),
  accountInput: document.querySelector("#accountInput"),
  proxyInput: document.querySelector("#proxyInput"),
  openAccountButton: document.querySelector("#openAccountButton"),
  backButton: document.querySelector("#backButton"),
  forwardButton: document.querySelector("#forwardButton"),
  reloadButton: document.querySelector("#reloadButton"),
  screenshotButton: document.querySelector("#screenshotButton"),
  devtoolsButton: document.querySelector("#devtoolsButton"),
  clearLogButton: document.querySelector("#clearLogButton"),
  networkLog: document.querySelector("#networkLog"),
  viewType: document.querySelector("#viewType"),
  accountLabel: document.querySelector("#accountLabel"),
  titleLabel: document.querySelector("#titleLabel"),
  loadingLabel: document.querySelector("#loadingLabel")
};

function applyBrowserChromeState(state = {}) {
  browserChromeVisible = Boolean(state.browserChromeVisible);
  document.body.classList.toggle("chromeless", !browserChromeVisible);
}

function renderState(state) {
  if (!state) return;
  applyBrowserChromeState(state);
  els.urlInput.value = state.url || els.urlInput.value;
  els.viewType.textContent = state.viewType || "-";
  els.accountLabel.textContent = state.accountId || "default";
  els.titleLabel.textContent = state.title || "-";
  els.loadingLabel.textContent = state.isLoading ? "yes" : "no";
  els.backButton.disabled = !state.canGoBack;
  els.forwardButton.disabled = !state.canGoForward;
}

function entryText(entry) {
  try {
    const url = new URL(entry.url);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return entry.url || "";
  }
}

function appendNetworkEntry(entry) {
  const item = document.createElement("li");
  const phaseClass = entry.phase === "response" ? "response" : entry.phase === "error" ? "error" : "";

  // textContent for every interpolated field: the network-log rows echo server-controlled request metadata
  // (method/url/error), so building them as inert text prevents markup in a URL/error from executing in a
  // page that also exposes browser-control IPC.
  const line = document.createElement("div");
  line.className = "entry-line";
  const methodEl = document.createElement("span");
  methodEl.className = "method";
  methodEl.textContent = entry.method || "-";
  const phaseEl = document.createElement("span");
  phaseEl.className = `phase ${phaseClass}`.trim();
  phaseEl.textContent = entry.phase || "-";
  line.append(methodEl, phaseEl);
  if (entry.statusCode) {
    const statusEl = document.createElement("span");
    statusEl.className = "status-code";
    statusEl.textContent = entry.statusCode;
    line.append(statusEl);
  }
  const urlEl = document.createElement("span");
  urlEl.className = "url";
  urlEl.title = entry.url || "";
  urlEl.textContent = entryText(entry);
  line.append(urlEl);

  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = `${entry.resourceType || "unknown"}${entry.error ? ` - ${entry.error}` : ""}`;

  item.append(line, metaEl);

  els.networkLog.prepend(item);
  while (els.networkLog.children.length > 80) {
    els.networkLog.lastElementChild.remove();
  }
}

async function refreshState() {
  renderState(await api.state());
}

els.urlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  renderState(await api.navigate(els.urlInput.value));
});

els.openAccountButton.addEventListener("click", async () => {
  els.networkLog.innerHTML = "";
  renderState(
    await api.open({
      accountId: els.accountInput.value,
      url: els.urlInput.value,
      proxyRules: els.proxyInput.value
    })
  );
});

els.backButton.addEventListener("click", async () => renderState(await api.back()));
els.forwardButton.addEventListener("click", async () => renderState(await api.forward()));
els.reloadButton.addEventListener("click", async () => renderState(await api.reload()));
els.clearLogButton.addEventListener("click", () => {
  els.networkLog.innerHTML = "";
});

els.screenshotButton.addEventListener("click", async () => {
  const result = await api.screenshot();
  const item = document.createElement("li");
  const line = document.createElement("div");
  line.className = "entry-line";
  const phaseEl = document.createElement("span");
  phaseEl.className = "phase response";
  phaseEl.textContent = "screenshot";
  const urlEl = document.createElement("span");
  urlEl.className = "url";
  urlEl.textContent = result.filePath; // textContent: a crafted file path can't inject markup here
  line.append(phaseEl, urlEl);
  item.append(line);
  els.networkLog.prepend(item);
});

els.devtoolsButton.addEventListener("click", async () => renderState(await api.devtools()));

api.on("browser:chrome-visibility", applyBrowserChromeState);

api.on("browser:title", ({ title }) => {
  els.titleLabel.textContent = title || "-";
});

api.on("browser:loading", ({ loading }) => {
  els.loadingLabel.textContent = loading ? "yes" : "no";
});

api.on("browser:navigation", (state) => {
  renderState(state);
});

api.on("browser:network", appendNetworkEntry);

api.on("browser:console", (entry) => {
  if (entry.level >= 2) {
    appendNetworkEntry({
      phase: "console",
      method: "JS",
      url: entry.sourceId || "console",
      resourceType: entry.message,
      timestamp: Date.now()
    });
  }
});

api.on("browser:error", (message) => {
  appendNetworkEntry({
    phase: "error",
    method: "APP",
    url: message,
    resourceType: "main-process",
    timestamp: Date.now()
  });
});

refreshState().catch((error) => {
  appendNetworkEntry({
    phase: "error",
    method: "APP",
    url: error.message,
    resourceType: "renderer",
    timestamp: Date.now()
  });
});
