const api = window.centrixDesktop;

const els = {
  browserViewport: document.querySelector("#browserViewport"),
  browserStatus: document.querySelector("#browserStatus"),
  serviceList: document.querySelector("#serviceList"),
  serviceSearch: document.querySelector("#serviceSearch"),
  reloadButton: document.querySelector("#reloadButton"),
  addServiceButton: document.querySelector("#addServiceButton"),
  manageButton: document.querySelector("#manageButton"),
  logoutButton: document.querySelector("#logoutButton")
};

const state = {
  services: [],
  activeServiceId: "",
  openServiceIds: new Set(),
  filter: ""
};

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
  if (!service.iconUrl) {
    return `<span>${label}</span>`;
  }

  return `<img src="${service.iconUrl}" alt="" onerror="this.replaceWith(document.createTextNode('${label}'))" />`;
}

function filteredServices() {
  const query = state.filter.trim().toLowerCase();
  return state.services.filter((service) => {
    if (service.enabled === false) return false;
    if (!query) return true;
    return `${service.name} ${service.url}`.toLowerCase().includes(query);
  });
}

function renderServices() {
  const services = filteredServices();
  els.serviceList.innerHTML = "";

  for (const service of services) {
    const isActive = service.id === state.activeServiceId;
    const isOpen = state.openServiceIds.has(service.id);
    const statusLabel = isActive ? "\u0110ang ch\u1ea1y" : isOpen ? "\u0110\u00e3 m\u1edf" : "Ch\u01b0a ch\u1ea1y";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `service-row${isActive ? " active" : isOpen ? " open" : ""}`;
    row.dataset.serviceId = service.id;
    row.innerHTML = `
      <span class="service-icon">${serviceIcon(service)}</span>
      <span class="service-name">${service.name}</span>
      <span class="status-badge">${service.id === state.activeServiceId ? "Đang chạy" : "Chưa chạy"}</span>
      <span class="more-button" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 5v.01M12 12v.01M12 19v.01" /></svg>
      </span>
    `;
    row.querySelector(".status-badge").textContent = statusLabel;
    row.addEventListener("click", () => openService(service.id));
    els.serviceList.append(row);
  }

  if (!services.length) {
    els.serviceList.innerHTML = `<div class="empty-browser"><strong>Không có dịch vụ</strong><span>Thử từ khóa khác</span></div>`;
  }
}

function measureBrowserViewport() {
  const rect = els.browserViewport.getBoundingClientRect();
  api.browser.setBounds({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  });
}

async function openService(serviceId) {
  const service = state.services.find((item) => item.id === serviceId);
  if (!service) return;

  state.activeServiceId = service.id;
  els.browserStatus.textContent = `Đang mở ${service.name}...`;
  renderServices();
  measureBrowserViewport();

  try {
    const nextState = await api.browser.openService({
      serviceId: service.id,
      accountId: "default"
    });
    applyBrowserState(nextState);
  } catch (error) {
    els.browserStatus.textContent = error.message || "Không mở được dịch vụ";
  }
}

function applyBrowserState(browserState) {
  if (!browserState) return;
  if (browserState.activeServiceId) {
    state.activeServiceId = browserState.activeServiceId;
  }
  if (Array.isArray(browserState.openServiceIds)) {
    state.openServiceIds = new Set(browserState.openServiceIds);
  }
  const active = state.services.find((service) => service.id === state.activeServiceId);
  els.browserStatus.textContent = browserState.isLoading
    ? `Đang tải ${active?.name || "dịch vụ"}...`
    : `${active?.name || "Dịch vụ"} đã sẵn sàng`;
  renderServices();
}

async function loadServices({ preserveActive = false } = {}) {
  const config = await api.services.list();
  state.services = config.services || [];
  const enabled = state.services.filter((service) => service.enabled !== false);

  if (!preserveActive || !enabled.some((service) => service.id === state.activeServiceId)) {
    state.activeServiceId = enabled[0]?.id || "";
  }

  renderServices();
  measureBrowserViewport();

  if (state.activeServiceId && !preserveActive) {
    await openService(state.activeServiceId);
  }
}

const resizeObserver = new ResizeObserver(() => measureBrowserViewport());
resizeObserver.observe(els.browserViewport);
window.addEventListener("resize", measureBrowserViewport);

els.serviceSearch.addEventListener("input", () => {
  state.filter = els.serviceSearch.value;
  renderServices();
});

els.reloadButton.addEventListener("click", async () => {
  measureBrowserViewport();
  const browserState = await api.browser.reload();
  applyBrowserState(browserState);
});

els.addServiceButton.addEventListener("click", () => {
  els.browserStatus.textContent = "Mở bản Admin để thêm hoặc sửa URL dịch vụ.";
});

els.manageButton.addEventListener("click", async () => {
  await loadServices({ preserveActive: true });
  els.browserStatus.textContent = "Danh sách dịch vụ đã được cập nhật.";
});

els.logoutButton.addEventListener("click", () => {
  els.browserStatus.textContent = "Phiên hiện tại vẫn được giữ trong browser profile.";
});

api.on("browser:loading", ({ loading }) => {
  const active = state.services.find((service) => service.id === state.activeServiceId);
  els.browserStatus.textContent = loading
    ? `Đang tải ${active?.name || "dịch vụ"}...`
    : `${active?.name || "Dịch vụ"} đã sẵn sàng`;
});

api.on("browser:navigation", applyBrowserState);
api.on("browser:error", (error) => {
  els.browserStatus.textContent = error?.errorDescription || "Browser gặp lỗi tải trang";
});

loadServices().catch((error) => {
  els.browserStatus.textContent = error.message || "Không tải được danh sách dịch vụ";
});
