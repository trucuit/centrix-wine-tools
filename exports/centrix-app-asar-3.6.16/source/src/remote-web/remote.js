const els = {
  statusLabel: document.querySelector("#statusLabel"),
  navForm: document.querySelector("#navForm"),
  urlInput: document.querySelector("#urlInput"),
  backButton: document.querySelector("#backButton"),
  forwardButton: document.querySelector("#forwardButton"),
  reloadButton: document.querySelector("#reloadButton"),
  browserFrame: document.querySelector("#browserFrame"),
  frameHint: document.querySelector("#frameHint"),
  accountInput: document.querySelector("#accountInput"),
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
  accountLabel: document.querySelector("#accountLabel"),
  titleLabel: document.querySelector("#titleLabel"),
  sizeLabel: document.querySelector("#sizeLabel"),
  errorLabel: document.querySelector("#errorLabel")
};

let frameDelay = 420;
let frameTimer = null;
let stateTimer = null;
let lastMoveAt = 0;
let fitMode = localStorage.getItem("centrixRemoteFitMode") || "actual";

async function api(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error || "Request failed");
  if (result.state) renderState(result.state);
  return result;
}

async function getState() {
  const response = await fetch("/api/state", { cache: "no-store" });
  const result = await response.json();
  if (result.ok) renderState(result.state);
}

function renderState(state) {
  if (!state) return;
  els.statusLabel.textContent = state.loading ? "loading" : state.url || "ready";
  els.urlInput.value = state.url || els.urlInput.value;
  els.accountLabel.textContent = state.accountId || "default";
  els.titleLabel.textContent = state.title || "-";
  els.sizeLabel.textContent = `${state.width || "-"} x ${state.height || "-"}`;
  els.errorLabel.textContent = state.lastError || "-";
  els.widthInput.value = state.width || els.widthInput.value;
  els.heightInput.value = state.height || els.heightInput.value;
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
  localStorage.setItem("centrixRemoteFitMode", fitMode);
  renderFitMode();
}

function setError(error) {
  els.statusLabel.textContent = error.message || String(error);
  els.errorLabel.textContent = error.message || String(error);
}

function refreshFrame() {
  clearTimeout(frameTimer);
  els.browserFrame.src = `/api/frame?t=${Date.now()}`;
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
  api("/api/open", {
    accountId: els.accountInput.value,
    proxyRules: els.proxyInput.value,
    url: els.urlInput.value
  }).catch(setError);
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

renderFitMode();
refreshFrame();
getState().catch(setError);
stateTimer = setInterval(() => getState().catch(setError), 1200);

window.addEventListener("beforeunload", () => {
  clearTimeout(frameTimer);
  clearInterval(stateTimer);
});
