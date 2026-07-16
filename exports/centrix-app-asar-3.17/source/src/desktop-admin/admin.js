const api = window.centrixDesktop;

const els = {
  configPath: document.querySelector("#configPath"),
  serviceRows: document.querySelector("#serviceRows"),
  statusBar: document.querySelector("#statusBar"),
  saveButton: document.querySelector("#saveButton"),
  addServiceButton: document.querySelector("#addServiceButton"),
  resetButton: document.querySelector("#resetButton")
};

const state = {
  services: []
};

function setStatus(message, tone = "") {
  els.statusBar.className = `status-bar${tone ? ` ${tone}` : ""}`;
  els.statusBar.textContent = message;
}

function initials(name) {
  return String(name || "C")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function iconMarkup(service) {
  const label = initials(service.name);
  if (!service.iconUrl) return `<span>${label}</span>`;
  return `<img src="${service.iconUrl}" alt="" onerror="this.replaceWith(document.createTextNode('${label}'))" />`;
}

function createRow(service, index) {
  const row = document.createElement("div");
  row.className = "service-row";
  row.dataset.index = String(index);
  row.innerHTML = `
    <div class="service-name-cell">
      <span class="service-icon">${iconMarkup(service)}</span>
      <input class="field" data-field="name" value="${service.name || ""}" aria-label="Tên dịch vụ" />
    </div>
    <input class="field" data-field="url" value="${service.url || ""}" aria-label="URL dịch vụ" />
    <input class="field" data-field="iconUrl" value="${service.iconUrl || ""}" aria-label="Icon URL" />
    <label class="toggle" title="Bật dịch vụ">
      <input data-field="enabled" type="checkbox" ${service.enabled !== false ? "checked" : ""} />
      <span></span>
    </label>
    <button class="danger-button" data-action="delete" type="button">Xóa</button>
  `;

  row.querySelector('[data-action="delete"]').addEventListener("click", () => {
    state.services.splice(index, 1);
    renderRows();
    setStatus("Đã xóa dịch vụ khỏi danh sách. Bấm Lưu thay đổi để áp dụng.");
  });

  for (const input of row.querySelectorAll("[data-field]")) {
    input.addEventListener("input", () => {
      syncStateFromRows();
      setStatus("Có thay đổi chưa lưu.");
    });
  }

  return row;
}

function renderRows() {
  els.serviceRows.innerHTML = "";
  state.services.forEach((service, index) => {
    els.serviceRows.append(createRow(service, index));
  });
}

function syncStateFromRows() {
  state.services = Array.from(els.serviceRows.querySelectorAll(".service-row")).map((row, index) => {
    const get = (field) => row.querySelector(`[data-field="${field}"]`);
    const name = get("name").value.trim() || `Dịch vụ ${index + 1}`;
    return {
      id: state.services[index]?.id || "",
      name,
      url: get("url").value.trim(),
      iconUrl: get("iconUrl")?.value.trim() || "",
      enabled: get("enabled").checked
    };
  });
}

function newService() {
  const next = state.services.length + 1;
  return {
    id: `custom-${Date.now()}`,
    name: `Dịch vụ ${next}`,
    url: "https://example.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    enabled: true
  };
}

async function loadConfig() {
  const config = await api.services.list();
  state.services = config.services || [];
  els.configPath.textContent = config.filePath || "-";
  renderRows();
  setStatus(`Đã tải ${state.services.length} dịch vụ.`);
}

els.addServiceButton.addEventListener("click", () => {
  syncStateFromRows();
  state.services.push(newService());
  renderRows();
  setStatus("Đã thêm dịch vụ mới. Bấm Lưu thay đổi để áp dụng.");
});

els.saveButton.addEventListener("click", async () => {
  syncStateFromRows();
  try {
    const config = await api.services.save(state.services);
    state.services = config.services || [];
    els.configPath.textContent = config.filePath || "-";
    renderRows();
    setStatus(`Đã lưu ${state.services.length} dịch vụ. Mở lại hoặc bấm Quản lý web trên bản user để cập nhật.`, "success");
  } catch (error) {
    setStatus(error.message || "Không lưu được cấu hình.", "error");
  }
});

els.resetButton.addEventListener("click", async () => {
  try {
    const config = await api.services.reset();
    state.services = config.services || [];
    els.configPath.textContent = config.filePath || "-";
    renderRows();
    setStatus("Đã khôi phục danh sách dịch vụ mặc định.", "success");
  } catch (error) {
    setStatus(error.message || "Không khôi phục được cấu hình.", "error");
  }
});

loadConfig().catch((error) => {
  setStatus(error.message || "Không tải được cấu hình.", "error");
});
