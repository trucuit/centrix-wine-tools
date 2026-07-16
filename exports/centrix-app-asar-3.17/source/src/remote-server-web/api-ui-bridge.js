(function () {
  // Harden the DOM against "Failed to execute 'insertBefore'/'removeChild': ... not a child of this node"
  // crashes thrown by the generated React design's reconciler when our bridge DOM-patches (innerHTML
  // replaces / row injections) mutate nodes React still has references to. We fall back gracefully
  // (append / no-op) instead of throwing, so a concurrent re-render can never white-screen the app.
  // Only the error path changes behaviour; valid insertBefore/removeChild keep their exact semantics.
  (function hardenReactDomOps() {
    if (window.__centrixDomHardened) return;
    window.__centrixDomHardened = true;
    const proto = Node.prototype;
    const origInsertBefore = proto.insertBefore;
    proto.insertBefore = function (newNode, referenceNode) {
      // Fast path (no try/catch): the parentNode check already prevents the "not a child" throw, so a
      // valid insert runs at native speed. Only the rare mismatch path falls back to appendChild.
      if (referenceNode != null && referenceNode.parentNode !== this) {
        try { return this.appendChild(newNode); } catch { return newNode; }
      }
      return origInsertBefore.call(this, newNode, referenceNode);
    };
    const origRemoveChild = proto.removeChild;
    proto.removeChild = function (child) {
      if (child != null && child.parentNode !== this) return child;
      return origRemoveChild.call(this, child);
    };
  })();

  const query = new URLSearchParams(window.location.search);
  const token = query.get("token") || "";
  const SERVICE_UI_RULE_USER_ID = "service-rule";
  const THEME_STORAGE_KEY = "centrixServerTheme";
  const CENTRIX_LOGO = "/centrix-logo.png"; // logo CentriX (phục vụ cùng gốc từ /opt/centrix/web) — favicon + login + loading
  // ── App Server staff RBAC (admin-console login). staffRbac comes from /api/health: off|log|on. ──
  let staffRbac = "off";
  let staffToken = "";              // legacy Bearer (desktop only); the WEBSITE auths via the httpOnly cxsid cookie
  let staffLoggedIn = false;        // cookie session present? decided by /api/auth/staff-whoami on boot/refresh
  let appReady = false;             // first real refresh + patches done? gates the loading veil (kills demo flash)
  let staffSessionKey = "";
  let useMasterOverride = false; // operator chose "vào bằng master (chủ sở hữu)" instead of staff login
  let __lastStaffGateKey = "";
  function staffActive() { return staffRbac !== "off"; }
  function needStaffLogin() { return staffActive() && !staffLoggedIn && !useMasterOverride; }
  function staffPerms() { return (state.staff && state.staff.permissions) || []; }
  function staffHas(view) { const p = staffPerms(); return p.includes("*") || p.includes(view); }
  const state = {
    ok: false,
    updatedAt: "",
    users: [],
    accounts: [],
    services: [],
    tabs: [],
    serviceVisibility: [],
    uiRules: [],
    uiRuleReports: [],
    uiCacheItems: [],
    modelPolicies: [],
    modelPrices: [],
    modelUsage: [],
    modelObservations: [],
    creditWallets: [],
    creditTransactions: [],
    moneyTransactions: [],
    activity: [],
    portal: {},
    summary: {},
    health: null,
    tunnel: null,
    tunnelConfig: null,
    serviceUi: {
      selectedId: "",
      creating: false,
      filter: ""
    },
    serviceBrowser: {
      tab: localStorage.getItem("centrixServerServiceBrowserTab") || "login",
      selectedServiceId: localStorage.getItem("centrixServerLoaderServiceId") || "",
      selectedUserId: localStorage.getItem("centrixServerSelectedUser") || "local-user",
      selectedRuleServiceId: localStorage.getItem("centrixServerRuleServiceId") || "",
      profileId: localStorage.getItem("centrixServerLoaderProfile") || "default",
      loaderTabId: localStorage.getItem("centrixServerLoaderTab") || "profile-loader",
      url: localStorage.getItem("centrixServerLoaderUrl") || "",
      visualReplaceText: "",
      loginStatus: {}
    },
    modelUi: {
      serviceId: localStorage.getItem("centrixServerModelServiceId") || "",
      userId: localStorage.getItem("centrixServerModelUserId") || "local-user",
      testModelId: "",
      lastTest: null
    },
    activityUi: {
      userId: localStorage.getItem("centrixServerActivityUserId") || "__all",
      query: ""
    },
    ledgerUi: {
      userId: localStorage.getItem("centrixServerLedgerUserId") || "__all",
      query: ""
    },
    actions: {
      pending: "",
      last: null,
      error: ""
    }
  };
  let menuEventsRegistered = false;
  let accountPopupOpen = false;
  const uiRuleDrafts = new Map();
  let applyingTheme = false;
  let themeObserverInstalled = false;
  let themeObserver = null;
  let themeObserverBody = null;
  let themeReapplyTimer = 0;
  let themeControlsObserver = null;
  let themeControlsWireTimer = 0;
  let modelDataRefreshRunning = false;
  let activityDataRefreshRunning = false;
  let modelServiceTouchedThisSession = false;

  function authed(path) {
    const url = new URL(path, window.location.origin);
    // With a staff session active, authenticate via the Authorization header (NOT ?token=) so the
    // request is gated by the staff role instead of the master token.
    if (staffActive() && staffToken) return url.toString();
    if (token && !url.searchParams.get("token")) url.searchParams.set("token", token);
    return url.toString();
  }
  function authHeaders(extra) {
    // X-CentriX-App-Key = the PUBLIC Cloudflare "Skip WAF" key (same value every App User ships). Without
    // it, admin API calls (fetch/XHR) hit Cloudflare's managed challenge and get 403 "Just a moment" — so
    // EVERY manual admin action (nạp credit, gói cước, cài đặt…) failed in the browser. Send it like the App User.
    const h = { "X-CentriX-App-Key": "cxk_28db7719b795d4eaa5a4e00fcb057029a11130eea00ec39a8bbd1467ca2ae5f7", ...(extra || {}) };
    if (staffActive() && staffToken) {
      h["Authorization"] = `Bearer ${staffToken}`;
      if (staffSessionKey) h["X-CentriX-Session"] = staffSessionKey;
    }
    return h;
  }

  async function getJson(path) {
    const response = await fetch(authed(path), { cache: "no-store", headers: authHeaders() });
    if (response.status === 401 && staffActive() && staffLoggedIn) onStaffAuthLost();
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    return result;
  }

  async function postJson(path, body = {}) {
    const response = await fetch(authed(path), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      cache: "no-store",
      body: JSON.stringify(body)
    });
    if (response.status === 401 && staffActive() && staffLoggedIn && path !== "/api/auth/staff-login") onStaffAuthLost();
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    return result;
  }

  // Upload the App User installer (.exe) as a RAW binary body to /api/admin/upload-installer. XHR (not fetch)
  // so we get upload progress. Reuses authed()/authHeaders() — master via ?token=, staff via Bearer, plus the
  // CF Skip-WAF app key. The filename rides the X-CentriX-Filename header (the server writes it into the
  // release dir). Resolves { filename, size, sha256 }.
  function uploadInstallerFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", authed("/api/admin/upload-installer"), true);
      const h = authHeaders({ "X-CentriX-Filename": file.name, "Content-Type": "application/octet-stream" });
      for (const k in h) { try { xhr.setRequestHeader(k, h[k]); } catch { /* forbidden header — skip */ } }
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
      xhr.onload = () => {
        let r = {}; try { r = JSON.parse(xhr.responseText || "{}"); } catch { r = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && r.ok !== false) resolve(r);
        else {
          if (xhr.status === 401 && staffActive() && staffLoggedIn) onStaffAuthLost();
          reject(new Error(r.error || `HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new Error("Lỗi mạng khi tải lên (Cloudflare giới hạn ~100MB)"));
      xhr.send(file);
    });
  }

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\u0111/g, "d")
      .replace(/\u0110/g, "D")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 2 &&
      rect.height > 2 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  // ── Shared, rAF-coalesced body observer ──────────────────────────────────────────────────────────
  // PERF: previously ~11 panel mounts + the window-control wiring each installed their OWN MutationObserver
  // on document.body {subtree:true}. Every DOM mutation fired ALL of them, and each mount's innerHTML write
  // was itself a mutation → a cross-observer feedback storm (N×N full-DOM scans). Here a SINGLE observer
  // schedules ONE rAF per frame that runs every registered tick (each panel mount + window controls). The
  // mounts keep their own cache-key skips, so the innerHTML feedback self-damps within ≤1 extra frame.
  const __bodyTicks = [];
  let __tickPending = false;
  let __inTick = false;
  let __bodyObserver = null;
  let __screenMemo = null;
  function registerBodyTick(fn) {
    if (typeof fn === "function" && !__bodyTicks.includes(fn)) __bodyTicks.push(fn);
    scheduleBodyTick();
  }
  function scheduleBodyTick() {
    if (__tickPending) return;
    __tickPending = true;
    requestAnimationFrame(runBodyTicks);
  }
  function runBodyTicks() {
    __tickPending = false;
    __inTick = true;
    __screenMemo = null;
    try {
      for (const fn of __bodyTicks) { try { fn(); } catch (e) { /* one panel must not break the rest */ } }
    } finally {
      __inTick = false;
      __screenMemo = null;
    }
  }
  function installSharedBodyObserver() {
    if (__bodyObserver || !document.body) return;
    __bodyObserver = new MutationObserver(scheduleBodyTick);
    __bodyObserver.observe(document.body, { childList: true, subtree: true });
  }
  // Within a single dispatch tick, all findXScreen() share ONE [data-screen-label] scan + visible() pass
  // (memoized), so the 10 inactive panels bail O(1) instead of each scanning the whole DOM. Outside a tick
  // (the polls/refresh) it scans fresh — identical behaviour to before.
  function visibleScreens() {
    if (__inTick && __screenMemo) return __screenMemo;
    const list = Array.from(document.querySelectorAll("[data-screen-label]")).filter(visible);
    if (__inTick) __screenMemo = list;
    return list;
  }

  function publishState() {
    window.centrixApiUi = { ...state };
  }

  function themeRootCandidates() {
    return Array.from(new Set([
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("[data-theme]"))
    ])).filter((element) => element instanceof HTMLElement);
  }

  function isThemeToggleCandidate(element) {
    if (!element || !(element instanceof HTMLElement) || !visible(element)) return false;
    const text = fold(element.textContent || "");
    if (text !== "sang" && text !== "toi") return false;
    const rect = element.getBoundingClientRect();
    if (rect.top < -4 || rect.top > 96) return false;
    if (rect.left < window.innerWidth * 0.45) return false;
    return rect.width >= 18 && rect.width <= 96 && rect.height >= 18 && rect.height <= 46;
  }

  function updateThemeSegmentVisuals(theme) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    const candidates = Array.from(document.querySelectorAll("button,div,span"))
      .filter((element) => {
        return isThemeToggleCandidate(element);
      });

    for (const element of candidates) {
      const text = fold(element.textContent || "");
      const active = (text === "sang" && nextTheme === "light") || (text === "toi" && nextTheme === "dark");
      element.dataset.centrixThemeButton = text === "sang" ? "light" : "dark";
      element.dataset.centrixThemeActive = active ? "1" : "0";
      element.style.background = active ? (nextTheme === "light" ? "#ffffff" : "rgba(255,255,255,.18)") : "transparent";
      element.style.color = active ? (nextTheme === "light" ? "#1b212d" : "#ffffff") : "#9aa6b6";
      element.style.borderRadius = element.style.borderRadius || "6px";
      element.style.cursor = "pointer";
      element.style.setProperty("-webkit-app-region", "no-drag", "important");
      element.style.setProperty("app-region", "no-drag", "important");
      const segment = element.parentElement;
      if (segment instanceof HTMLElement) {
        segment.dataset.centrixThemeSegment = "1";
        segment.style.setProperty("-webkit-app-region", "no-drag", "important");
        segment.style.setProperty("app-region", "no-drag", "important");
      }
    }
  }

  function wireThemeControls(theme) {
    const nextTheme = theme === "dark" ? "dark" : (localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light");
    const candidates = Array.from(document.querySelectorAll("button,div,span")).filter(isThemeToggleCandidate);
    for (const element of candidates) {
      const text = fold(element.textContent || "");
      const controlTheme = text === "toi" ? "dark" : "light";
      element.dataset.centrixThemeButton = controlTheme;
      element.setAttribute("role", "button");
      element.setAttribute("tabindex", "0");
      element.setAttribute("title", controlTheme === "dark" ? "Chuyen sang giao dien toi" : "Chuyen sang giao dien sang");
      markNoDrag(element);
      if (element.parentElement instanceof HTMLElement) {
        element.parentElement.dataset.centrixThemeSegment = "1";
        markNoDrag(element.parentElement);
      }
      if (element.dataset.centrixThemeWired === "1") continue;
      element.dataset.centrixThemeWired = "1";
      const run = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        applyServerTheme(controlTheme);
        showActionToast(controlTheme === "dark" ? "Da chuyen sang giao dien toi" : "Da chuyen sang giao dien sang");
      };
      element.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      }, true);
      element.addEventListener("click", run, true);
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") run(event);
      }, true);
    }
    updateThemeSegmentVisuals(nextTheme);
  }

  function scheduleThemeControlsWiring(theme) {
    clearTimeout(themeControlsWireTimer);
    themeControlsWireTimer = setTimeout(() => wireThemeControls(theme), 30);
  }

  function installThemeControlsObserver() {
    if (!document.body || themeControlsObserver) return;
    themeControlsObserver = new MutationObserver(() => {
      scheduleThemeControlsWiring(localStorage.getItem(THEME_STORAGE_KEY) || "light");
    });
    themeControlsObserver.observe(document.body, { childList: true, subtree: true });
  }

  function themeNeedsReapply(theme) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    if (document.documentElement.getAttribute("data-theme") !== nextTheme) return true;
    if (document.body && document.body.getAttribute("data-theme") !== nextTheme) return true;
    for (const root of themeRootCandidates()) {
      if (root.getAttribute("data-theme") !== nextTheme) return true;
    }
    const buttons = Array.from(document.querySelectorAll("[data-centrix-theme-button]"));
    if (!buttons.length) {
      return Array.from(document.querySelectorAll("button,div,span")).some(isThemeToggleCandidate);
    }
    return buttons.some((button) => {
      const expected = button.dataset.centrixThemeButton === nextTheme ? "1" : "0";
      return button.dataset.centrixThemeActive !== expected;
    });
  }

  function scheduleThemeReapply(theme, options = {}) {
    clearTimeout(themeReapplyTimer);
    themeReapplyTimer = setTimeout(() => {
      if (themeNeedsReapply(theme)) {
        applyServerTheme(theme, { syncLogic: false, ...options });
      }
    }, 40);
  }

  function applyServerTheme(theme, options = {}) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    installTypographySystem();
    installServerThemeRuntimeStyles();
    installServerThemeObserver();
    installThemeControlsObserver();
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
    document.body?.setAttribute("data-theme", nextTheme);
    for (const root of themeRootCandidates()) {
      root.setAttribute("data-theme", nextTheme);
    }
    updateThemeSegmentVisuals(nextTheme);
    scheduleThemeControlsWiring(nextTheme);

    if (options.syncLogic !== false && !applyingTheme) {
      const logic = currentLogic();
      if (logic?.setState && logic.state?.theme !== nextTheme) {
        applyingTheme = true;
        try {
          logic.setState({ theme: nextTheme });
          setTimeout(() => applyServerTheme(nextTheme, { syncLogic: false }), 0);
          setTimeout(() => applyServerTheme(nextTheme, { syncLogic: false }), 80);
          setTimeout(() => applyServerTheme(nextTheme, { syncLogic: false }), 220);
        } catch {
          // The generated design runtime may not be ready yet.
        } finally {
          setTimeout(() => {
            applyingTheme = false;
          }, 260);
        }
      }
    }

    return nextTheme;
  }

  function toggleServerTheme() {
    const current = localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
    return applyServerTheme(current === "dark" ? "light" : "dark");
  }

  function applyStoredServerTheme(options = {}) {
    return applyServerTheme(localStorage.getItem(THEME_STORAGE_KEY) || "light", options);
  }

  function themeChoiceFromTarget(target) {
    const node = target?.closest?.("button,div,span");
    if (!isThemeToggleCandidate(node)) return "";
    const label = fold(node.textContent || "");
    if (label === "sang") return "light";
    if (label === "toi") return "dark";
    return node.dataset?.centrixThemeButton || "";
  }

  function installServerThemeObserver() {
    if (!document.body) return;
    if (themeObserverInstalled && themeObserverBody === document.body) return;
    themeObserver?.disconnect?.();
    themeObserverInstalled = true;
    themeObserverBody = document.body;
    const observer = new MutationObserver(() => {
      if (applyingTheme) return;
      scheduleThemeReapply(localStorage.getItem(THEME_STORAGE_KEY) || "light");
    });
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["data-theme", "style", "class"]
    });
    themeObserver = observer;
  }

  function installServerThemeRuntimeStyles() {
    if (document.getElementById("centrix-server-theme-runtime")) return;
    const style = document.createElement("style");
    style.id = "centrix-server-theme-runtime";
    style.textContent = `
      html[data-theme="light"],
      html[data-theme="light"] body {
        color-scheme: light;
        background: #eef1f5 !important;
        color: #0f172a !important;
      }

      html[data-theme="dark"],
      html[data-theme="dark"] body {
        color-scheme: dark;
        background: #0e131b !important;
        color: #e8edf5 !important;
      }

      [data-centrix-theme-segment],
      [data-centrix-theme-button],
      [data-centrix-theme-button] * {
        -webkit-app-region: no-drag !important;
        app-region: no-drag !important;
        pointer-events: auto !important;
        user-select: none !important;
      }

      [data-centrix-theme-button] {
        transition: background .15s ease, color .15s ease, box-shadow .15s ease !important;
      }

      [data-centrix-theme-button="light"][data-centrix-theme-active="1"] {
        background: #ffffff !important;
        color: #1b212d !important;
        box-shadow: 0 1px 2px rgba(15,23,42,.12) !important;
      }

      [data-centrix-theme-button="dark"][data-centrix-theme-active="1"] {
        background: rgba(255,255,255,.18) !important;
        color: #ffffff !important;
        box-shadow: none !important;
      }

      [data-centrix-theme-button][data-centrix-theme-active="0"] {
        background: transparent !important;
        color: #9aa6b6 !important;
        box-shadow: none !important;
      }
    `;
    document.head?.appendChild(style);
  }

  function installTypographySystem() {
    if (document.getElementById("centrix-server-typography-system")) return;
    const style = document.createElement("style");
    style.id = "centrix-server-typography-system";
    style.textContent = `
      :root {
        --cx-font-sans: "Segoe UI Variable","Segoe UI",Inter,system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;
        --cx-font-mono: "Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono",ui-monospace,monospace;
        --cx-text-xs: 11px;
        --cx-text-sm: 12px;
        --cx-text-md: 13px;
        --cx-text-base: 14px;
        --cx-text-lg: 15px;
        --cx-text-xl: 16px;
        --cx-text-2xl: 18px;
        --cx-text-3xl: 20px;
        --cx-text-display: 24px;
        --cx-lh-tight: 1.16;
        --cx-lh-ui: 1.28;
        --cx-lh-body: 1.45;
      }
      html,
      body,
      body :where(button,input,select,textarea) {
        font-family: var(--cx-font-sans) !important;
        letter-spacing: 0 !important;
        -webkit-font-smoothing: antialiased;
        text-rendering: geometricPrecision;
      }
      body {
        font-size: var(--cx-text-base) !important;
        line-height: var(--cx-lh-body) !important;
      }
      body * {
        letter-spacing: 0 !important;
      }
      body :where(button,input,select,textarea) {
        font-size: var(--cx-text-base) !important;
        line-height: var(--cx-lh-ui) !important;
      }
      body :where(code,pre,kbd,samp,textarea[spellcheck="false"]) {
        font-family: var(--cx-font-mono) !important;
        font-size: var(--cx-text-sm) !important;
        line-height: 1.48 !important;
      }
      body [style*="font-size:30px"],
      body [style*="font-size:28px"],
      body [style*="font-size:26px"] {
        font-size: var(--cx-text-display) !important;
        line-height: var(--cx-lh-tight) !important;
        font-weight: 800 !important;
      }
      body [style*="font-size:22px"],
      body [style*="font-size:21px"],
      body [style*="font-size:20px"] {
        font-size: var(--cx-text-3xl) !important;
        line-height: var(--cx-lh-tight) !important;
        font-weight: 800 !important;
      }
      body [style*="font-size:18px"] {
        font-size: var(--cx-text-2xl) !important;
        line-height: var(--cx-lh-tight) !important;
      }
      body [style*="font-size:16px"] {
        font-size: var(--cx-text-xl) !important;
        line-height: var(--cx-lh-ui) !important;
      }
      body [style*="font-size:15px"],
      body [style*="font-size:15.5px"] {
        font-size: var(--cx-text-lg) !important;
        line-height: var(--cx-lh-ui) !important;
      }
      body [style*="font-size:14px"],
      body [style*="font-size:14.5px"],
      body [style*="font-size:13.5px"] {
        font-size: var(--cx-text-base) !important;
        line-height: var(--cx-lh-ui) !important;
      }
      body [style*="font-size:13px"],
      body [style*="font-size:12.5px"],
      body [style*="font-size:12px"] {
        font-size: var(--cx-text-sm) !important;
        line-height: var(--cx-lh-body) !important;
      }
      body [style*="font-size:11.5px"],
      body [style*="font-size:11px"],
      body [style*="font-size:10.5px"],
      body [style*="font-size:10px"],
      body [style*="font-size:9.5px"],
      body [style*="font-size:9px"],
      body [style*="font-size:8.5px"] {
        font-size: var(--cx-text-xs) !important;
        line-height: var(--cx-lh-ui) !important;
      }
      body [data-centrix-service-browser-root] :where(button) {
        font-weight: 600 !important;
      }
      body [data-centrix-service-browser-root] :where(input,select) {
        font-weight: 500 !important;
      }
      body [data-centrix-service-browser-root] :where(label > span, em) {
        font-weight: 600 !important;
      }
      body [data-centrix-service-browser-root] :where(strong) {
        font-weight: 650 !important;
      }
      body [data-centrix-service-browser-root] [data-cx-service-browser-title] {
        font-weight: 700 !important;
      }
      body [data-centrix-service-browser-root] [data-cx-service-browser-section-title] {
        font-weight: 650 !important;
      }
      body [data-centrix-service-browser-root] [data-cx-service-browser-icon] {
        font-weight: 600 !important;
      }
    `;
    document.head.appendChild(style);
  }

  function showActionToast(message, kind = "ok") {
    let toast = document.getElementById("centrix-server-api-action-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "centrix-server-api-action-toast";
      toast.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:52px",
        "z-index:2147483647",
        "transform:translateX(-50%)",
        "min-height:34px",
        "max-width:min(560px,calc(100vw - 28px))",
        "padding:8px 12px",
        "border-radius:9px",
        "font:700 12px/1.35 Segoe UI,system-ui,sans-serif",
        "box-shadow:0 10px 28px rgba(15,23,42,.22)",
        "pointer-events:none"
      ].join(";");
      document.body.appendChild(toast);
    }
    const ok = kind !== "error";
    toast.style.background = ok ? "rgba(22,101,52,.94)" : "rgba(185,28,28,.94)";
    toast.style.color = "#fff";
    toast.textContent = message;
    clearTimeout(showActionToast.timer);
    showActionToast.timer = setTimeout(() => toast.remove(), 4200);
  }

  function currentLogic() {
    const candidates = [];
    const add = (item) => {
      if (item && typeof item === "object") candidates.push(item, item.logic);
    };
    try {
      if (typeof window.getDC === "function") add(window.getDC());
    } catch {
      // The generated design runtime may expose getDC before the component is ready.
    }

    for (const element of Array.from(document.querySelectorAll("*"))) {
      const fiberKey = Object.getOwnPropertyNames(element)
        .find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
      let fiber = fiberKey ? element[fiberKey] : null;
      let depth = 0;
      while (fiber && depth < 160) {
        add(fiber.stateNode);
        fiber = fiber.return;
        depth += 1;
      }
    }

    return candidates.find((item) => item?.state && typeof item.setState === "function" && "page" in item.state) || null;
  }

  function setServerPage(page) {
    const logic = currentLogic();
    if (!logic || !page) return false;
    try {
      logic.setState({ page });
      return true;
    } catch {
      return false;
    }
  }

  // ── Real user list ───────────────────────────────────────────────────────────────────
  // The design's "Người dùng & Credit" page renders from a 12,000-row generated demo pool
  // (DCLogic.buildPool). The template's pool() was patched to prefer window.__cxRealUsers
  // when set, so we map the real DB users (state.users + accounts emails + creditWallets)
  // into the same row shape and publish them here. Re-render is nudged via a state bump so
  // the page repaints from the real pool immediately (and naturally on any navigation too).
  function realUserPool() {
    const emailByUser = new Map();
    for (const account of state.accounts || []) {
      if (account && account.userId && account.email && !emailByUser.has(account.userId)) {
        emailByUser.set(account.userId, account.email);
      }
    }
    const walletByUser = new Map();
    for (const wallet of state.creditWallets || []) {
      if (wallet && wallet.userId) walletByUser.set(wallet.userId, wallet);
    }
    // REAL per-user month-to-date spend + last-activity (replaces the old hardcoded usedMonth:0 / updatedAt-only
    // lastMins). "Đã dùng (tháng)" = sum of THIS UTC month's model-usage debits (same definition as /api/me
    // spentThisMonth). "Hoạt động" = most-recent real event (open-service/login from state.activity + any credit
    // transaction), falling back to updatedAt when a low-activity user has aged out of the capped windows.
    const monthKey = new Date().toISOString().slice(0, 7);
    const spentMonthByUser = new Map();
    const lastTsByUser = new Map();
    const bumpLast = (uid, ts) => { const t = Date.parse(ts || "") || 0; if (t > (lastTsByUser.get(uid) || 0)) lastTsByUser.set(uid, t); };
    for (const tx of state.creditTransactions || []) {
      const uid = String(tx.userId || "");
      if (String(tx.type || "") === "debit" && String(tx.createdAt || "").slice(0, 7) === monthKey) {
        spentMonthByUser.set(uid, (spentMonthByUser.get(uid) || 0) + Math.abs(Number(tx.amountDelta || 0)));
      }
      bumpLast(uid, tx.createdAt);
    }
    for (const a of state.activity || []) bumpLast(String(a.userId || ""), a.createdAt);
    const now = Date.now();
    return (state.users || [])
      .filter((user) => user.id !== SERVICE_UI_RULE_USER_ID)
      .map((user, index) => {
      const email = emailByUser.get(user.id) || "";
      const wallet = walletByUser.get(user.id) || {};
      const created = Date.parse(user.createdAt || "") || now;
      const updated = Date.parse(user.updatedAt || "") || created;
      const lastEvent = Math.max(lastTsByUser.get(user.id) || 0, updated);
      return {
        id: user.id,
        idx: index,
        name: user.name || email || user.id,
        email,
        code: `cx-${user.id}`,
        plan: user.planName || "Free", // REAL current plan (server.py joins user_subscriptions); was hardcoded "Free"
        planCode: user.plan || "FREE",
        planExpiresAt: user.planExpiresAt || "",
        planDaysLeft: (typeof user.planDaysLeft === "number" ? user.planDaysLeft : null),
        planMonthlyCredit: Number(user.planMonthlyCredit || 0),
        planNextResetAt: user.planNextResetAt || "",
        status: user.enabled === false ? "locked" : "active",
        credit: Number(wallet.balance || 0),
        usedTotal: Number(wallet.lifetimeSpent || 0),
        usedMonth: Number(spentMonthByUser.get(user.id) || 0),
        devices: 1,
        lastMins: Math.max(0, Math.round((now - lastEvent) / 60000)),
        joinTs: created
      };
    });
  }

  // The design's planStyle() only labels 'Pro'/'Business' → every other REAL plan (Free/Max/Unlimited/…) renders
  // as the "Free" badge. Wrap it on the logic instance to echo the true plan NAME as the label (keeps the design's
  // colour), so the "Gói" column + the drawer plan badge show the real plan. Idempotent; re-applied each sync.
  function patchDesignPlanLabels(logic) {
    if (!logic || logic.__cxPlanLabelPatched || typeof logic.planStyle !== "function") return;
    const orig = logic.planStyle.bind(logic);
    logic.planStyle = function (p) {
      const base = orig(p) || {};
      const name = String(p == null ? "" : p).trim();
      if (name && typeof base.label === "string" && base.label.toLowerCase() !== name.toLowerCase()) {
        return Object.assign({}, base, { label: name });
      }
      return base;
    };
    logic.__cxPlanLabelPatched = true;
  }

  let legacyFilterOn = false; // "Người dùng CentriX" tab → table shows only PRO_LEGACY (per-customer) customers
  function applyRealUserPool() {
    try {
      const pool = realUserPool();
      // Only override the demo pool once we actually have real users; otherwise leave the
      // design's own data so an empty/failed load doesn't blank the table.
      if (!pool.length) return;
      // "Người dùng CentriX" filter → show only per-customer (any *_LEGACY tier) customers (failed-load guard stays).
      window.__cxRealUsers = legacyFilterOn ? pool.filter((r) => String(r.planCode || "").toUpperCase().endsWith("_LEGACY")) : pool;
      // Nudge a re-render so the page repaints from the real pool right away.
      const logic = currentLogic();
      patchDesignPlanLabels(logic); // echo real plan names in the Gói column + drawer badge
      if (logic && typeof logic.setState === "function") {
        logic.setState({ _cxUserSync: ((logic.state && logic.state._cxUserSync) || 0) + 1 });
      }
    } catch {
      // best-effort; the next refresh/navigation will repaint.
    }
  }

  // The user detail-drawer ships a static "Khóa tài khoản" button. Resolve the drawer's SINGLE cx-<userId>
  // by walking up from the button (an ancestor with >1 distinct code = the table → ambiguous → bail so we
  // can NEVER lock the wrong user), validate it against state.users, stamp it on the button + relabel
  // Khóa<->Mở by user.enabled. The click-delegator reads the stamped id (never re-parses at click time).
  function lockBtnDrawerUserId(btn) {
    let node = btn.parentElement;
    for (let i = 0; i < 9 && node; i += 1) {
      const codes = Array.from(new Set(
        Array.from(node.querySelectorAll("*"))
          .filter((el) => el.childElementCount === 0)
          .map((el) => ((el.textContent || "").trim().match(/^cx-([a-z0-9-]+)$/i) || [])[1])
          .filter(Boolean)
      ));
      if (codes.length === 1) return codes[0];
      if (codes.length > 1) return ""; // multi-user scope (the table) → never guess
      node = node.parentElement;
    }
    return "";
  }
  // Hiện SỐ DƯ VNĐ NGAY DƯỚI số dư credit, TRONG CÙNG panel design (không tách thẻ, không chia cột → không phá
  // layout). Dùng CHÍNH XÁC typography của credit (label 10.5px + số 38px) cho đồng đều, có divider mảnh phân
  // tách + nút "Nạp tiền". Chèn ngay sau ô số credit; re-apply mỗi tick như các injection khác. Bail nếu drawer
  // chưa mở (không thấy label "Số dư credit").
  function ensureUserVndBesideCredit(userId) {
    if (!userId) return;
    const label = Array.from(document.querySelectorAll("div"))
      .find((el) => el.childElementCount === 0 && el.offsetParent !== null && (el.textContent || "").trim() === "Số dư credit");
    if (!label) return;
    const numDiv = label.nextElementSibling; // ô số credit (38px) — anchor để chèn VNĐ ngay bên dưới
    const anchor = numDiv || label;
    const bal = moneyBalanceById(userId);
    let vnd = anchor.nextElementSibling;
    if (!vnd || vnd.dataset.cxVndCard !== "1") {
      vnd = document.createElement("div");
      vnd.dataset.cxVndCard = "1";
      anchor.insertAdjacentElement("afterend", vnd);
    }
    vnd.dataset.cxVndUser = userId;
    vnd.style.cssText = "margin-top:16px;padding-top:16px;border-top:1px solid var(--border-soft,#eef2f7);";
    vnd.innerHTML = `<div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;">Số dư VNĐ</div>
      <div style="font-size:38px;font-weight:700;color:var(--brand,#2563eb);margin-top:4px;letter-spacing:-.02em;line-height:1;">${bal.toLocaleString("vi-VN")} đ</div>`;
  }
  function ensureAccountLockButton() {
    for (const btn of document.querySelectorAll("button,[role='button']")) {
      const f = fold(btn.textContent || "").trim();
      if (f !== "khoa tai khoan" && f !== "mo tai khoan") continue;
      let userId = lockBtnDrawerUserId(btn);
      if (!userId) {
        // Fallback: the open drawer's user is normally the single ticked row.
        try { const sel = ((currentLogic()?.bulkTargets?.() || currentLogic()?.selIds?.() || []) || []).filter(Boolean); if (sel.length === 1) userId = sel[0]; } catch (e) { /* ignore */ }
      }
      const user = userId ? (state.users || []).find((u) => u.id === userId) : null;
      if (!user) { delete btn.dataset.cxLockUserId; continue; } // ambiguous/unknown → leave inert
      btn.dataset.cxLockUserId = userId;
      const want = user.enabled === false ? "Mở tài khoản" : "Khóa tài khoản";
      // Relabel the text leaf only (preserve any icon child); the click delegator works regardless of label.
      const labelEl = btn.childElementCount === 0 ? btn
        : (Array.from(btn.querySelectorAll("*")).find((el) => el.childElementCount === 0 && /^(khoa|mo)\s+tai\s+khoan$/.test(fold(el.textContent || "").trim())) || null);
      if (labelEl && (labelEl.textContent || "").trim() !== want) labelEl.textContent = want;
      // Uniform styling: Khóa + Xóa become an even pill row matching Nạp credit/Trừ credit/Nạp gói above.
      if (btn.parentElement) { btn.parentElement.style.display = "flex"; btn.parentElement.style.flexWrap = "wrap"; btn.parentElement.style.gap = "8px"; }
      styleActionBtn(btn, "lock");
      // Inject a "Xóa tài khoản" button right after the lock button (once per drawer render), stamped with the
      // SAME resolved userId. Idempotent: if one already exists in this container just keep its stamp fresh.
      const existingDel = btn.parentElement ? btn.parentElement.querySelector("[data-cx-delete-user-id]") : null;
      if (existingDel) {
        existingDel.dataset.cxDeleteUserId = userId;
        styleActionBtn(existingDel, "del");
      } else if (btn.parentElement) {
        const del = document.createElement("button");
        del.type = "button";
        del.dataset.centrixServerAction = "delete-user";
        del.dataset.cxDeleteUserId = userId;
        del.textContent = "Xóa tài khoản";
        styleActionBtn(del, "del");
        btn.insertAdjacentElement("afterend", del);
      }
      // Nút "Nạp tiền" (ví VND) đặt CHUNG hàng nút hành động (cạnh Nạp credit / Trừ credit / Khóa / Xóa). Idempotent.
      if (btn.parentElement) {
        let mbtn = btn.parentElement.querySelector("[data-cx-money-user]");
        if (!mbtn) {
          mbtn = document.createElement("button");
          mbtn.type = "button";
          mbtn.dataset.centrixServerAction = "money-topup";
          btn.parentElement.appendChild(mbtn);
        }
        mbtn.dataset.cxMoneyUser = userId;
        mbtn.textContent = "💵 Nạp tiền";
        styleActionBtn(mbtn, "plan");
      }
      // Số dư ví VND: đặt CÙNG HÀNG với thẻ "Số dư credit" ở đầu drawer, đồng bộ cỡ chữ/font (xem hàm dưới).
      ensureUserVndBesideCredit(userId);
      // "Đang dùng profile": slot user này đang chiếm theo dịch vụ — reuse the SAME safely-resolved drawer userId.
      ensureUserDrawerSlots(btn, userId);
    }
  }

  // Chèn dòng "Đang dùng profile" vào drawer chi tiết user: chip <dịch vụ> #<slot> · <nhàn rỗi> từ cxPool.assignments
  // (đã lọc theo userId). Idempotent qua #cx-user-drawer-slots + chữ ký; tự kick 1 lần nạp pool nếu dữ liệu cũ.
  function ensureUserDrawerSlots(anchorBtn, userId) {
    const row = anchorBtn.parentElement;
    if (!row || !userId) return;
    if (Date.now() - (cxPool.at || 0) > 6000) Promise.resolve().then(refreshPoolIfVisible); // đảm bảo có dữ liệu (đã throttle)
    const mine = (cxPool.assignments || []).filter((a) => a.userId === userId)
      .sort((a, b) => poolServiceLabel(a.serviceId).localeCompare(poolServiceLabel(b.serviceId)));
    const sig = userId + "|" + mine.map((a) => a.serviceId + ":" + a.slot + ":" + Math.round((a.idleSec || 0) / 30)).join(",");
    let box = document.getElementById("cx-user-drawer-slots");
    if (box && box.__anchor !== row) { box.remove(); box = null; } // drawer khác → bỏ box cũ
    if (!box) {
      box = document.createElement("div");
      box.id = "cx-user-drawer-slots";
      box.__anchor = row;
      box.style.cssText = "margin:12px 0;padding:12px 13px;border:1px solid var(--border-soft,#e2e8f0);border-radius:11px;background:var(--surface-2,#f8fafc);";
      row.insertAdjacentElement("beforebegin", box);
    }
    if (box.dataset.cxSig === sig) return;
    box.dataset.cxSig = sig;
    const chips = mine.length
      ? mine.map((a) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--brand,#2563eb);background:var(--brand-soft,#eff6ff);border:1px solid var(--brand-border,#bfdbfe);border-radius:999px;padding:4px 11px;">${escapeHtml(poolServiceLabel(a.serviceId))} <b style="font-weight:800;">#${escapeHtml(String(a.slot != null ? a.slot : "?"))}</b> <span style="color:var(--text-3,#94a3b8);font-weight:500;">${escapeHtml(poolIdle(a.idleSec))}</span></span>`).join("")
      : `<span style="font-size:12.5px;color:var(--text-3,#94a3b8);">Chưa dùng profile nào (trong 30 phút gần đây).</span>`;
    box.innerHTML = `<div style="font:800 11px 'Segoe UI',system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--label,#64748b);margin-bottom:9px;">Đang dùng profile</div><div style="display:flex;flex-wrap:wrap;gap:7px;">${chips}</div>`;
  }

  // The "+ Nạp N credit" buttons (bulk bar + user drawer) now open a CUSTOM-amount modal, so the fixed "N" in
  // the label is misleading — relabel them to "Nạp credit" and stamp the default amount on the button.
  function ensureTopupButton() {
    for (const btn of document.querySelectorAll("button,[role='button']")) {
      if (btn.dataset.centrixServerAction || btn.dataset.centrixModelAction) continue;
      const m = fold(btn.textContent || "").trim().match(/^(\+?)\s*nap\s+(\d+)\s+credit$/);
      if (!m) continue;
      btn.dataset.cxNapDefault = m[2];
      const want = (m[1] ? "+ " : "") + "Nạp credit";
      const labelEl = btn.childElementCount === 0 ? btn
        : (Array.from(btn.querySelectorAll("*")).find((el) => el.childElementCount === 0 && /nap\s+\d+\s+credit/.test(fold(el.textContent || ""))) || null);
      if (labelEl && (labelEl.textContent || "").trim() !== want) labelEl.textContent = want;
    }
  }

  // Map the design's demo org list (b2bOrgsData → o1/o2…) to the REAL organisations from the portal
  // (state.portal.organizations) + member count + departments, in the same row shape the template uses.
  function realOrgRows() {
    const orgs = (state.portal && state.portal.organizations) || [];
    const members = (state.portal && state.portal.members) || [];
    const departments = (state.portal && state.portal.departments) || [];
    return orgs.map((org, index) => {
      const orgMembers = members.filter((member) => member.orgId === org.id);
      const orgDepts = departments.filter((dept) => dept.orgId === org.id);
      return {
        id: org.id,
        name: org.name || org.id,
        mst: org.mst || "",
        pool: Number(org.pool || 0),
        used: Number(org.used || 0),
        members: orgMembers.length,
        plan: org.plan || "Doanh nghiệp",
        status: org.status || "active",
        primary: index === 0,
        depts: orgDepts.map((dept) => ({ name: dept.name || "Phòng ban", used: Number(dept.used || 0), alloc: Number(dept.alloc || 0) }))
      };
    });
  }

  function applyRealOrgs() {
    try {
      // Override only once the portal has actually loaded (organizations is a real array) so the org list
      // shows the TRUE organisations (replacing the demo o1/o2…). Empty array = no orgs yet (correct).
      if (!state.portal || !Array.isArray(state.portal.organizations)) return;
      window.__cxRealOrgs = realOrgRows();
      const logic = currentLogic();
      if (logic && typeof logic.setState === "function") {
        logic.setState({ _cxOrgSync: ((logic.state && logic.state._cxOrgSync) || 0) + 1 });
      }
    } catch {
      // best-effort; the next refresh/navigation will repaint.
    }
  }

  function ensureBadge() {
    document.getElementById("centrix-api-ui-badge")?.remove();
  }

  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
  }

  function accountCardCandidates() {
    return Array.from(document.body?.querySelectorAll("div") || [])
      .filter((element) => {
        if (!visible(element) || element.closest("#centrix-server-api-action-panel")) return false;
        const rect = element.getBoundingClientRect();
        const text = fold(element.textContent || "");
        return (
          rect.left >= 0 &&
          rect.left < 380 &&
          rect.bottom > window.innerHeight - 150 &&
          rect.width >= 160 &&
          rect.width <= 340 &&
          rect.height >= 42 &&
          rect.height <= 112 &&
          (
            text.includes("server") ||
            text.includes("admin") ||
            text.includes("quan tri") ||
            text.includes("ket noi") ||
            text.includes("doanh nghiep")
          )
        );
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.bottom - ar.bottom) || ((br.width * br.height) - (ar.width * ar.height));
      });
  }

  function markAccountCard() {
    const card = accountCardCandidates()[0] || null;
    if (!card) return null;
    card.dataset.centrixServerAccountTrigger = "1";
    card.style.cursor = "pointer";
    markNoDrag(card);
    return card;
  }

  function isAccountTrigger(target) {
    if (!target) return false;
    if (target.closest?.("[data-centrix-server-account-trigger='1']")) return true;
    const candidate = target.closest?.("div");
    return Boolean(candidate && accountCardCandidates().includes(candidate));
  }

  function closeAccountPopup() {
    accountPopupOpen = false;
    document.getElementById("centrix-server-api-action-panel")?.remove();
  }

  function toggleAccountPopup() {
    accountPopupOpen = !accountPopupOpen;
    ensureActionPanel();
  }

  function popupStatusHtml() {
    const dot = state.ok ? "#22c55e" : "#f59e0b";
    const text = `${state.ok ? "API live" : "API pending"} - ${state.users.length || 0} users - ${state.services.length || 0} services`;
    const pending = state.actions.pending ? `<div style="margin-top:4px;color:#b45309;">Đang xử lý: ${state.actions.pending}</div>` : "";
    return `<div style="display:flex;align-items:flex-start;gap:10px;padding:11px 12px;border:1px solid ${state.ok ? "rgba(187,247,208,.95)" : "rgba(253,230,138,.95)"};background:${state.ok ? "rgba(240,253,244,.96)" : "rgba(255,251,235,.96)"};border-radius:12px;color:${state.ok ? "#15803d" : "#b45309"};"><span style="width:8px;height:8px;border-radius:50%;background:${dot};display:inline-block;flex-shrink:0;margin-top:5px;"></span><span style="font:800 12px/1.35 Segoe UI,system-ui,sans-serif;">${text}${pending}</span></div>`;
  }

  function ensureActionPanel() {
    const card = markAccountCard();
    let panel = document.getElementById("centrix-server-api-action-panel");
    if (!accountPopupOpen) {
      panel?.remove();
      return;
    }

    if (!panel) {
      panel = document.createElement("div");
      panel.id = "centrix-server-api-action-panel";
      panel.style.cssText = [
        "position:fixed",
        "left:12px",
        "bottom:82px",
        "z-index:2147483647",
        "display:flex",
        "flex-direction:column",
        "align-items:stretch",
        "gap:4px",
        "width:244px",
        "padding:0",
        "border-radius:0",
        "background:transparent",
        "border:0",
        "box-shadow:none",
        "font:700 12px/1.2 Segoe UI,system-ui,sans-serif"
      ].join(";");
      document.body.appendChild(panel);
    }

    const disabled = state.actions.pending ? "disabled" : "";
    const rect = card?.getBoundingClientRect();
    const width = 278;
    const left = clampNumber(rect ? rect.left : 16, 10, Math.max(10, window.innerWidth - width - 10));
    const bottom = clampNumber(rect ? (window.innerHeight - rect.top + 8) : 86, 12, Math.max(12, window.innerHeight - 12));
    panel.style.cssText = [
      "position:fixed",
      `left:${left}px`,
      `bottom:${bottom}px`,
      "z-index:2147483647",
      "display:flex",
      "flex-direction:column",
      "align-items:stretch",
      "gap:8px",
      `width:${width}px`,
      "padding:10px",
      "border-radius:14px",
      "background:rgba(255,255,255,.98)",
      "border:1px solid rgba(203,213,225,.9)",
      "box-shadow:0 18px 46px rgba(15,23,42,.22)",
      "font:700 12px/1.2 Segoe UI,system-ui,sans-serif",
      "backdrop-filter:blur(12px)"
    ].join(";");
    panel.innerHTML = [
      popupStatusHtml(),
      `<button type="button" data-centrix-server-action="create-user" ${disabled}><span>+</span><strong>Thêm người dùng</strong></button>`,
      `<button type="button" data-centrix-server-action="create-org" ${disabled}><span>🏢</span><strong>Tạo tổ chức</strong></button>`,
      `<button type="button" data-centrix-server-action="approve-topup" ${disabled}><span>✓</span><strong>Duyệt nạp</strong></button>`,
      `<button type="button" data-centrix-server-action="close-ticket" ${disabled}><span>×</span><strong>Đóng ticket</strong></button>`,
      `<button type="button" data-centrix-server-action="my-account"><span>👤</span><strong>Tài khoản của tôi</strong></button>`,
      `<button type="button" data-centrix-server-action="staff-logout" data-centrix-logout-btn="1"><span>⎋</span><strong>Đăng xuất</strong></button>`
    ].join("");

    panel.querySelectorAll("button").forEach((button) => {
      button.style.cssText = [
        "height:38px",
        "width:100%",
        "padding:0 11px",
        "border-radius:10px",
        "border:1px solid rgba(148,163,184,.36)",
        "background:rgba(255,255,255,.92)",
        "color:#334155",
        "font:700 13px/1 Segoe UI,system-ui,sans-serif",
        "cursor:pointer",
        "white-space:nowrap",
        "display:flex",
        "align-items:center",
        "gap:10px",
        "text-align:left",
        "box-shadow:0 1px 2px rgba(15,23,42,.04)"
      ].join(";");
      const icon = button.querySelector("span");
      if (icon) {
        icon.style.cssText = [
          "width:18px",
          "height:18px",
          "border-radius:6px",
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "background:rgba(30,147,245,.11)",
          "color:#0b7bdd",
          "font:800 13px/1 Segoe UI,system-ui,sans-serif",
          "flex-shrink:0"
        ].join(";");
      }
      button.onmouseenter = () => {
        if (!button.disabled) {
          button.style.background = "rgba(234,245,254,.98)";
          button.style.borderColor = "rgba(30,147,245,.42)";
          button.style.color = "#0f172a";
        }
      };
      button.onmouseleave = () => {
        button.style.background = "rgba(255,255,255,.92)";
        button.style.borderColor = "rgba(148,163,184,.36)";
        button.style.color = "#334155";
      };
      if (button.disabled) {
        button.style.opacity = ".58";
        button.style.cursor = "wait";
      }
    });

    // The "Đăng xuất" button is danger-styled (red) + always enabled, set apart from the quick actions.
    const logoutBtn = panel.querySelector("[data-centrix-logout-btn]");
    if (logoutBtn) {
      logoutBtn.disabled = false;
      logoutBtn.style.cursor = "pointer";
      logoutBtn.style.opacity = "1";
      logoutBtn.style.marginTop = "3px";
      logoutBtn.style.borderColor = "rgba(248,113,113,.5)";
      logoutBtn.style.color = "#dc2626";
      const lic = logoutBtn.querySelector("span");
      if (lic) { lic.style.background = "rgba(220,38,38,.12)"; lic.style.color = "#dc2626"; }
      logoutBtn.onmouseenter = () => { logoutBtn.style.background = "rgba(254,242,242,.98)"; logoutBtn.style.borderColor = "rgba(248,113,113,.75)"; logoutBtn.style.color = "#b91c1c"; };
      logoutBtn.onmouseleave = () => { logoutBtn.style.background = "rgba(255,255,255,.92)"; logoutBtn.style.borderColor = "rgba(248,113,113,.5)"; logoutBtn.style.color = "#dc2626"; };
    }
  }

  function markNoDrag(element) {
    if (!element) return;
    element.style.setProperty("app-region", "no-drag");
    element.style.setProperty("-webkit-app-region", "no-drag");
  }

  function findServerAppBar() {
    const bars = Array.from(document.body?.querySelectorAll("div") || []);
    return bars.find((bar) => {
      const rect = bar.getBoundingClientRect();
      if (rect.top > 6 || rect.height < 42 || rect.height > 58 || rect.width < window.innerWidth * 0.72) {
        return false;
      }
      const text = fold(bar.textContent || "");
      return text.includes("file") && text.includes("edit") && text.includes("window") && text.includes("app user");
    }) || null;
  }

  function findWindowControlButtons(bar) {
    const barRect = bar.getBoundingClientRect();
    return Array.from(bar.querySelectorAll("div"))
      .filter((element) => {
        if (!element.querySelector("svg")) return false;
        if (fold(element.textContent || "")) return false;
        const rect = element.getBoundingClientRect();
        return rect.width >= 24 &&
          rect.width <= 42 &&
          rect.height >= 24 &&
          rect.height <= 38 &&
          rect.left > barRect.left + barRect.width * 0.68 &&
          rect.top >= barRect.top &&
          rect.bottom <= barRect.bottom + 2;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .slice(-3);
  }

  function runWindowAction(action) {
    const win = window.centrixAppServer?.win;
    if (!win) return false;
    if (action === "minimize") win.minimize?.();
    else if (action === "maximize") win.maximize?.();
    else if (action === "close") win.close?.();
    else return false;
    return true;
  }

  function wireWindowControls() {
    const win = window.centrixAppServer?.win;
    if (!win || !document.body) return false;
    // O(1) early-out once the 3 title-bar buttons are wired — skips the per-mutation div-scan + rect sorts
    // (findServerAppBar / findWindowControlButtons both reflow per element). Self-healing: a re-rendered bar
    // loses the dataset → re-wires.
    if (document.querySelector('[data-centrix-win-action="close"]')) return true;
    const bar = findServerAppBar();
    if (!bar) return false;

    bar.style.setProperty("app-region", "drag");
    bar.style.setProperty("-webkit-app-region", "drag");
    bar.querySelectorAll("a,button,input,select,textarea,[onclick]").forEach(markNoDrag);

    const buttons = findWindowControlButtons(bar);
    if (buttons.length !== 3) return false;

    ["minimize", "maximize", "close"].forEach((action, index) => {
      const button = buttons[index];
      if (button.dataset.centrixWinAction === action) return;
      button.dataset.centrixWinAction = action;
      button.setAttribute("role", "button");
      button.setAttribute("title", action === "minimize" ? "Minimize" : action === "maximize" ? "Maximize" : "Close");
      button.style.cursor = "pointer";
      markNoDrag(button);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        runWindowAction(action);
      }, true);
    });
    return true;
  }

  function scheduleWindowControlWiring() {
    wireWindowControls();
    for (const delayMs of [200, 700, 1400, 2600, 4200]) {
      setTimeout(wireWindowControls, delayMs);
    }
    registerBodyTick(wireWindowControls); // shared rAF tick instead of a dedicated synchronous observer
  }

  function setDataset() {
    document.documentElement.dataset.centrixApiLive = state.ok ? "1" : "0";
    document.documentElement.dataset.centrixApiUsers = String(state.users.length || 0);
    document.documentElement.dataset.centrixApiServices = String(state.services.length || 0);
    applyStoredServerTheme({ syncLogic: false });
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  function copyText(value) {
    const text = String(value || "").trim();
    if (!text) {
      showActionToast("Chưa có URL để sao chép", "error");
      return false;
    }
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text)
        .then(() => {
          showActionToast("Đã sao chép URL kết nối");
          return true;
        })
        .catch(() => copyTextFallback(text));
    }
    return copyTextFallback(text);
  }

  function copyTextFallback(text) {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "true");
    input.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
    document.body.appendChild(input);
    input.focus();
    input.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    input.remove();
    showActionToast(copied ? "Đã sao chép URL kết nối" : "Không sao chép được URL", copied ? "ok" : "error");
    return copied;
  }

  function serviceIconHtml(service) {
    const label = escapeHtml(String(service?.name || "C").slice(0, 1).toUpperCase());
    const iconUrl = String(service?.iconUrl || "").trim();
    const fallback = `<span style="font-size:15px;font-weight:800;color:var(--brand);">${label}</span>`;
    if (!iconUrl) return fallback;
    return `${fallback}<img src="${escapeHtml(iconUrl)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:7px;background:#fff;">`;
  }

  function selectedApiService() {
    // "Tạo mới" mode: return NULL (no fallback to the first service). Without this, apiServiceDraft's call to
    // selectedApiService() re-set an empty selectedId to services[0] (=ChatGPT) and the new-service save
    // OVERWROTE ChatGPT. Only auto-select the first service when NOT creating.
    if (state.serviceUi.creating) return null;
    if (!state.serviceUi.selectedId && state.services.length) {
      state.serviceUi.selectedId = state.services[0].id || "";
    }
    return state.services.find((service) => service.id === state.serviceUi.selectedId) || null;
  }

  function findConnectScreen() {
    return visibleScreens().find((screen) => fold(screen.getAttribute("data-screen-label")).includes("ket noi")) || null;
  }

  // ── Version-gate policy ("Phiên bản App User & cập nhật") — stored as portal.appVersion[0].configJson =
  // JSON of {latestVersion, minVersion, blocked[], forceLatest, notes, installerFile}. Rendered + saved on the
  // "Kết nối" screen (below the tunnel card); the App User (UA CentriXAppUser/<ver>) is 426'd + forced to update.
  function versionConfig() {
    const p = state.portal || {};
    const arr = (Array.isArray(p.appVersion) ? p.appVersion : (p.portal && Array.isArray(p.portal.appVersion) ? p.portal.appVersion : [])) || [];
    const rec = arr.find((r) => r && r.id === "app-version-config") || arr[0] || {};
    let cfg = {};
    try { if (rec.configJson) cfg = JSON.parse(rec.configJson); } catch { cfg = {}; }
    return {
      latestVersion: String(cfg.latestVersion || ""),
      minVersion: String(cfg.minVersion || ""),
      blocked: Array.isArray(cfg.blocked) ? cfg.blocked.map(String) : [],
      forceLatest: cfg.forceLatest === true,
      notes: String(cfg.notes || ""),
      installerFile: String(cfg.installerFile || ""),
    };
  }
  function versionConfigSig() {
    const c = versionConfig();
    return [c.latestVersion, c.minVersion, c.blocked.join(","), c.forceLatest ? "1" : "0", c.notes, c.installerFile].join("~");
  }
  let __versionActionsWired = false;
  function wireVersionActions() {
    if (__versionActionsWired) return;
    __versionActionsWired = true;
    document.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-cx-vaction]") : null;
      if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      const act = btn.getAttribute("data-cx-vaction");
      if (act === "upload") { const fi = document.getElementById("cxv-file"); if (fi) fi.click(); return; }
      const g = (id) => (document.getElementById(id)?.value || "").trim();
      const latest = g("cxv-latest");
      let min = g("cxv-min");
      if (act === "forceold") { min = latest; const mi = document.getElementById("cxv-min"); if (mi) mi.value = latest; } // "Đóng tất cả bản cũ" = min := latest
      const cfg = {
        latestVersion: latest, minVersion: min,
        blocked: g("cxv-blocked").split(",").map((s) => s.trim()).filter(Boolean),
        forceLatest: !!(document.getElementById("cxv-force") && document.getElementById("cxv-force").checked),
        notes: g("cxv-notes"), installerFile: g("cxv-installer"),
      };
      postJson("/api/admin/portal", { section: "appVersion", record: { id: "app-version-config", configJson: JSON.stringify(cfg) } })
        .then((r) => {
          if (r && r.ok !== false) {
            if (r.portal) state.portal = r.portal;
            showActionToast(act === "forceold" ? "Đã đóng tất cả bản cũ — ép cập nhật." : "Đã lưu chính sách phiên bản.", "ok");
            mountConnectPanel({ force: true });
          } else showActionToast((r && r.error) || "Lưu thất bại", "error");
        })
        .catch((err) => showActionToast((err && err.message) || "Lỗi lưu", "error"));
    }, true);
    // File picked → stream it up with a progress bar, then auto-fill the "installerFile" field.
    document.addEventListener("change", (e) => {
      const inp = e.target;
      if (!inp || inp.id !== "cxv-file" || !inp.files || !inp.files[0]) return;
      const file = inp.files[0];
      const msg = document.getElementById("cxv-upmsg");
      const barWrap = document.getElementById("cxv-upbarwrap");
      const bar = document.getElementById("cxv-upbar");
      const upBtn = document.querySelector('[data-cx-vaction="upload"]');
      const MB = (n) => (n / 1048576).toFixed(1);
      if (!/\.exe$/i.test(file.name)) { showActionToast("Chỉ chấp nhận file .exe", "error"); inp.value = ""; return; }
      if (msg) { msg.textContent = `Đang tải ${file.name} (${MB(file.size)}MB)…`; msg.style.color = "var(--text-2)"; }
      if (barWrap) barWrap.style.display = "block";
      if (bar) bar.style.width = "0%";
      if (upBtn) upBtn.disabled = true;
      uploadInstallerFile(file, (loaded, total) => {
        const pct = total ? Math.round((loaded / total) * 100) : 0;
        if (bar) bar.style.width = `${pct}%`;
        if (msg) msg.textContent = `Đang tải ${MB(loaded)}/${MB(total)}MB (${pct}%)…`;
      }).then((r) => {
        if (bar) bar.style.width = "100%";
        if (msg) { msg.textContent = `✓ Đã lên server: ${r.filename} · ${MB(r.size)}MB · sha256 ${String(r.sha256 || "").slice(0, 12)}…`; msg.style.color = "var(--ok-text, #16a34a)"; }
        const inst = document.getElementById("cxv-installer");
        if (inst) inst.value = r.filename; // auto-fill so the owner just sets version + Lưu
        showActionToast(`Đã tải ${r.filename} lên server. Giờ điền "Phiên bản mới nhất" rồi bấm Lưu.`, "ok");
      }).catch((err) => {
        if (msg) { msg.textContent = `✗ ${(err && err.message) || "Tải lên thất bại"}`; msg.style.color = "var(--danger, #dc2626)"; }
        showActionToast((err && err.message) || "Tải lên thất bại", "error");
      }).finally(() => {
        if (upBtn) upBtn.disabled = false;
        inp.value = ""; // allow re-selecting the same file
        setTimeout(() => { if (barWrap) barWrap.style.display = "none"; }, 2000);
      });
    }, true);
  }

  function findServicesScreen() {
    // Exact match: the "Dịch vụ" screen folds to exactly "dich vu". Do NOT use includes() —
    // "Trình duyệt dịch vụ" folds to "trinh duyet dich vu" (also contains "dich vu") and sits EARLIER
    // in the DOM, so includes() grabbed the wrong screen and the real "Dịch vụ" screen kept its mock.
    return visibleScreens().find((screen) => fold(screen.getAttribute("data-screen-label")) === "dich vu") || null;
  }

  function activeTunnel() {
    return state.tunnel || state.health?.tunnel || {};
  }

  function activeTunnelConfig() {
    return state.tunnelConfig || activeTunnel().config || {};
  }

  function firstLanUrl() {
    return Array.isArray(state.health?.lanUrls) ? (state.health.lanUrls[0] || "") : "";
  }

  function connectionPublicUrl() {
    const tunnel = activeTunnel();
    const config = activeTunnelConfig();
    return String(tunnel.displayUrl || tunnel.publicUrl || config.publicUrl || "").trim();
  }

  function hostFromUrl(value) {
    try {
      return new URL(value).hostname;
    } catch {
      return String(value || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    }
  }

  function connectionApiDomain() {
    const config = activeTunnelConfig();
    return String(config.hostname || hostFromUrl(config.publicUrl || connectionPublicUrl()) || "api-centrixapp.centrix.asia").trim();
  }

  function connectionCopyUrl() {
    return connectionPublicUrl() || firstLanUrl() || state.health?.localUrl || "";
  }

  function networkStatusText() {
    const health = state.health || {};
    if (!health.ok && health.error) return `Không đọc được /api/health: ${health.error}`;
    if (!health.localUrl && !health.port) return "Đang lấy dữ liệu kết nối...";
    const host = health.host || "127.0.0.1";
    const listenHost = host === "0.0.0.0" ? "mọi IP" : host;
    const lanCount = Array.isArray(health.lanUrls) ? health.lanUrls.length : 0;
    return `Đang nghe ${listenHost} trên cổng ${health.port || 19778} - ${lanCount} LAN URL`;
  }

  function firewallStatusText() {
    const firewall = state.health?.firewall || {};
    if (firewall.message) return firewall.message;
    if (!state.health?.ok) return "Đang kiểm tra Windows Firewall...";
    return firewall.ok ? `Windows Firewall đã sẵn sàng TCP ${state.health.port || 19778}` : `Cần mở Windows Firewall TCP ${state.health.port || 19778}`;
  }

  function tunnelStatusText() {
    const tunnel = activeTunnel();
    const status = tunnel.status || (tunnel.running ? "running" : "stopped");
    const message = tunnel.message || "";
    if (!status && !message) return "Đang lấy trạng thái Cloudflare Tunnel...";
    return message ? `${status} - ${message}` : status;
  }

  function connectFieldHtml(label, id, value, options = {}) {
    const span = options.span || "";
    const mono = options.mono ? "font-family:var(--cx-font-mono,Consolas,ui-monospace,monospace);font-size:13px;" : "font-size:14px;";
    const readonly = options.readonly ? "readonly" : "";
    const bg = options.readonly ? "var(--surface-2)" : "var(--field-bg)";
    const color = options.muted ? "var(--text-2)" : "var(--text)";
    return `
      <label style="${span};display:flex;flex-direction:column;gap:7px;min-width:0;">
        <span style="font-size:11px;font-weight:800;color:var(--label);letter-spacing:.06em;text-transform:uppercase;">${escapeHtml(label)}</span>
        <input id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(options.placeholder || "")}" ${readonly} style="width:100%;height:42px;border:1px solid var(--field-border);border-radius:10px;background:${bg};color:${color};${mono}font-weight:600;padding:0 13px;min-width:0;">
      </label>`;
  }

  function mountConnectPanel(options = {}) {
    const screen = findConnectScreen();
    if (!screen) return false;

    const health = state.health || {};
    const tunnel = activeTunnel();
    const config = activeTunnelConfig();
    const lanUrls = Array.isArray(health.lanUrls) ? health.lanUrls : [];
    const localUrl = health.localUrl || "";
    const lanValue = lanUrls.join("  ");
    const publicUrl = connectionPublicUrl();
    const apiDomain = connectionApiDomain();
    const accessToken = token || "";
    const tunnelHasToken = Boolean(config.hasToken);
    const healthReady = Boolean(health.ok && (localUrl || health.port));
    const key = [
      state.updatedAt,
      localUrl,
      lanValue,
      health.firewall?.status || "",
      tunnel.status || "",
      tunnel.running ? "1" : "0",
      publicUrl,
      apiDomain,
      tunnelHasToken ? "1" : "0",
      accessToken ? "1" : "0",
      versionConfigSig()
    ].join("|");

    if (!options.force && screen.dataset.centrixConnectMount === key) return true;
    screen.dataset.centrixConnectMount = key;
    const vc = versionConfig();
    const vfield = (label, id, val, ph, span) => connectFieldHtml(label, id, val, { placeholder: ph, span: span || "" });
    const versionCard = `
      <div style="margin-top:18px;background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="padding:20px 26px;border-bottom:1px solid var(--border-soft);">
          <div style="font-size:19px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Phiên bản App User &amp; cập nhật</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:5px;">Ép khách cập nhật hoặc khoá khẩn cấp phiên bản App User. Để trống tất cả = không chặn ai. Bản cũ sẽ bị chặn dùng + hiện nút tải bản mới.</div>
        </div>
        <div style="padding:22px 26px 24px;display:grid;grid-template-columns:1fr 1fr;gap:16px 20px;">
          ${vfield("Phiên bản mới nhất", "cxv-latest", vc.latestVersion, "vd: 3.7.0")}
          ${vfield("Chặn dưới phiên bản (min)", "cxv-min", vc.minVersion, "bản thấp hơn buộc cập nhật")}
          ${vfield("Khoá phiên bản cụ thể (cách nhau dấu phẩy)", "cxv-blocked", vc.blocked.join(", "), "vd: 3.6.0, 3.6.1", "grid-column:1 / -1")}
          ${vfield("File cài trong thư mục release", "cxv-installer", vc.installerFile, "để trống = file .exe mới nhất", "grid-column:1 / -1")}
          <div style="grid-column:1 / -1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:-6px;">
            <input type="file" id="cxv-file" accept=".exe,application/x-msdownload,application/vnd.microsoft.portable-executable" style="display:none;">
            <button type="button" data-cx-vaction="upload" style="font-size:13px;font-weight:800;color:var(--text);background:var(--surface);border:1px dashed var(--field-border);border-radius:10px;padding:10px 14px;cursor:pointer;">⬆ Tải file cài (.exe) lên server</button>
            <span id="cxv-upmsg" style="font-size:12px;color:var(--text-2);min-width:0;flex:1;">Chọn file Setup.exe trên máy → tải thẳng vào thư mục release (không cần SSH).</span>
          </div>
          <div id="cxv-upbarwrap" style="grid-column:1 / -1;display:none;height:8px;border-radius:999px;background:var(--surface-2);overflow:hidden;margin-top:-8px;">
            <div id="cxv-upbar" style="height:100%;width:0%;background:var(--brand);transition:width .15s ease;"></div>
          </div>
          ${vfield("Ghi chú hiện trong hộp thoại cập nhật", "cxv-notes", vc.notes, "vd: Bản cũ đã ngừng hỗ trợ, vui lòng cập nhật.", "grid-column:1 / -1")}
          <label style="grid-column:1 / -1;display:flex;align-items:center;gap:10px;font-size:13.5px;color:var(--text);cursor:pointer;user-select:none;">
            <input type="checkbox" id="cxv-force" ${vc.forceLatest ? "checked" : ""} style="width:18px;height:18px;cursor:pointer;">
            Ép TẤT CẢ khách lên phiên bản mới nhất (mọi bản dưới "mới nhất" đều bị chặn)
          </label>
          <div style="grid-column:1 / -1;display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px;">
            <button type="button" data-cx-vaction="forceold" style="font-size:14px;font-weight:900;color:var(--text);background:var(--surface);border:1px solid var(--field-border);border-radius:10px;padding:12px;cursor:pointer;">Đóng tất cả bản cũ (min := mới nhất)</button>
            <button type="button" data-cx-vaction="save" style="font-size:14px;font-weight:900;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:12px;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Lưu chính sách phiên bản</button>
          </div>
        </div>
      </div>`;
    screen.innerHTML = `
      <div data-centrix-connect-root style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="padding:24px 26px;border-bottom:1px solid var(--border-soft);display:flex;align-items:flex-start;justify-content:space-between;gap:18px;">
          <div style="min-width:0;">
            <div style="font-size:21px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Kết nối tới người dùng</div>
            <div style="font-size:13.5px;color:var(--text-2);margin-top:5px;">Địa chỉ và token để app người dùng kết nối tới Server này.</div>
          </div>
          <span style="display:inline-flex;align-items:center;gap:7px;border:1px solid ${healthReady ? "var(--ok-border)" : "var(--warn-border)"};background:${healthReady ? "var(--ok-soft)" : "var(--warn-soft)"};color:${healthReady ? "var(--ok-text)" : "var(--warn-text)"};border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;white-space:nowrap;">
            <span style="width:7px;height:7px;border-radius:50%;background:${healthReady ? "var(--ok)" : "var(--warn)"};"></span>${healthReady ? "API live" : "Đang kiểm tra"}
          </span>
        </div>
        <div style="padding:22px 26px 24px;display:grid;grid-template-columns:1fr 1fr;gap:16px 20px;">
          ${connectFieldHtml("Địa chỉ nội bộ", "centrix-connect-local-url", localUrl, { readonly: true, placeholder: "Đang lấy /api/health..." })}
          ${connectFieldHtml("Địa chỉ mạng LAN", "centrix-connect-lan-url", lanValue, { readonly: true, placeholder: lanUrls.length ? "" : "Không tìm thấy IP LAN" })}
          ${connectFieldHtml("Token truy cập", "centrix-connect-access-token", accessToken, { span: "grid-column:1 / -1", mono: true, readonly: true, placeholder: "Không thấy token trên URL control" })}
          ${connectFieldHtml("Mạng", "centrix-connect-network", networkStatusText(), { readonly: true, muted: true })}
          ${connectFieldHtml("Tường lửa", "centrix-connect-firewall", firewallStatusText(), { readonly: true, muted: true })}
          ${connectFieldHtml("Địa chỉ công khai (Cloudflare Tunnel)", "centrix-connect-public-url", publicUrl, { span: "grid-column:1 / -1", readonly: true, placeholder: "Bấm Bật Tunnel để tạo URL dùng được ở bất kỳ IP nào" })}
          ${connectFieldHtml("Tên miền API", "centrix-connect-api-domain", apiDomain, { placeholder: "api-centrixapp.centrix.asia" })}
          ${connectFieldHtml("Token Cloudflare Tunnel", "centrix-connect-tunnel-token", "", { mono: true, placeholder: tunnelHasToken ? "Đã lưu token. Nhập token mới nếu cần thay đổi." : "Dán token Cloudflare Tunnel" })}
          ${connectFieldHtml("Trạng thái Tunnel", "centrix-connect-tunnel-status", tunnelStatusText(), { span: "grid-column:1 / -1", readonly: true, muted: true })}
          <div style="grid-column:1 / -1;display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px;">
            <button type="button" data-centrix-connect-action="save" style="font-size:14px;font-weight:900;color:var(--text);background:var(--surface);border:1px solid var(--field-border);border-radius:10px;padding:12px;cursor:pointer;">Lưu Tunnel</button>
            <button type="button" data-centrix-connect-action="start" style="font-size:14px;font-weight:900;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:12px;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Bật Tunnel</button>
            <button type="button" data-centrix-connect-action="stop" style="font-size:14px;font-weight:900;color:var(--text);background:var(--surface);border:1px solid var(--field-border);border-radius:10px;padding:12px;cursor:pointer;">Tắt Tunnel</button>
            <button type="button" data-centrix-connect-action="copy" style="font-size:14px;font-weight:900;color:var(--text);background:var(--surface);border:1px solid var(--field-border);border-radius:10px;padding:12px;cursor:pointer;">Sao chép URL</button>
          </div>
        </div>
      </div>
      ${versionCard}`;
    return true;
  }

  function scheduleConnectPanel() {
    registerBodyTick(mountConnectPanel);
    wireVersionActions();
    for (const delayMs of [300, 900, 1800, 3200]) setTimeout(mountConnectPanel, delayMs);
  }

  function tunnelDraftFromDom() {
    return {
      hostname: document.getElementById("centrix-connect-api-domain")?.value || connectionApiDomain(),
      token: document.getElementById("centrix-connect-tunnel-token")?.value || ""
    };
  }

  async function saveTunnelFromUi() {
    return runAction("save tunnel", async () => {
      const result = await postJson("/api/tunnel/config", tunnelDraftFromDom());
      state.tunnelConfig = result.config || state.tunnelConfig;
      mountConnectPanel({ force: true });
      return { type: "save-tunnel", hostname: state.tunnelConfig?.hostname || "" };
    });
  }

  async function startTunnelFromUi() {
    return runAction("start tunnel", async () => {
      const result = await postJson("/api/tunnel/start", tunnelDraftFromDom());
      state.tunnel = result.tunnel || state.tunnel;
      state.tunnelConfig = state.tunnel?.config || state.tunnelConfig;
      mountConnectPanel({ force: true });
      return { type: "start-tunnel", status: state.tunnel?.status || "" };
    });
  }

  async function stopTunnelFromUi() {
    return runAction("stop tunnel", async () => {
      const result = await postJson("/api/tunnel/stop");
      state.tunnel = result.tunnel || state.tunnel;
      state.tunnelConfig = state.tunnel?.config || state.tunnelConfig;
      mountConnectPanel({ force: true });
      return { type: "stop-tunnel", status: state.tunnel?.status || "" };
    });
  }

  function apiServiceDraft() {
    const current = selectedApiService();
    const valueOf = (id) => document.getElementById(id)?.value || "";
    return {
      ...(current || {}),
      id: current?.id || "",
      name: valueOf("centrix-service-api-name"),
      url: valueOf("centrix-service-api-url"),
      loginUrl: valueOf("centrix-service-api-login-url") || valueOf("centrix-service-api-url"),
      iconUrl: valueOf("centrix-service-api-icon-url"),
      defaultModel: valueOf("centrix-service-api-default-model"),
      defaultCreditCost: Math.max(1, Math.round(Number(valueOf("centrix-service-api-default-credit") || 1))),
      enabled: document.getElementById("centrix-service-api-enabled")?.checked !== false,
      modelPricingEnabled: document.getElementById("centrix-service-api-pricing-enabled")?.checked !== false,
      // Only override cookieDomains when the textarea is actually mounted; otherwise keep the value
      // carried over by ...(current || {}) above so a draft built off-panel never wipes it.
      ...(document.getElementById("centrix-service-api-cookie-domains")
        ? { cookieDomains: (document.getElementById("centrix-service-api-cookie-domains").value || "")
            .split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) }
        : {})
    };
  }

  function updateServicesFromConfig(config) {
    state.services = Array.isArray(config?.services) ? config.services : [];
    if (state.serviceUi.selectedId && !state.services.some((service) => service.id === state.serviceUi.selectedId)) {
      state.serviceUi.selectedId = state.services[0]?.id || "";
    }
    if (!state.serviceUi.creating && !state.serviceUi.selectedId && state.services.length) {
      state.serviceUi.selectedId = state.services[0].id || "";
    }
    if (state.serviceBrowser.selectedServiceId && !state.services.some((service) => service.id === state.serviceBrowser.selectedServiceId)) {
      state.serviceBrowser.selectedServiceId = state.services[0]?.id || "";
    }
    if (!state.serviceBrowser.selectedServiceId && state.services.length) {
      state.serviceBrowser.selectedServiceId = state.services[0].id || "";
    }
    if (state.serviceBrowser.selectedRuleServiceId && !state.services.some((service) => service.id === state.serviceBrowser.selectedRuleServiceId)) {
      state.serviceBrowser.selectedRuleServiceId = state.serviceBrowser.selectedServiceId || state.services[0]?.id || "";
    }
    if (!state.serviceBrowser.selectedRuleServiceId && state.services.length) {
      state.serviceBrowser.selectedRuleServiceId = state.serviceBrowser.selectedServiceId || state.services[0].id || "";
    }
    syncModelServiceSelection();
    if (state.modelUi.serviceId) {
      localStorage.setItem("centrixServerModelServiceId", state.modelUi.serviceId);
    }
  }

  async function saveApiService() {
    return runAction("save service", async () => {
      const draft = apiServiceDraft();
      if (!String(draft.name || "").trim()) throw new Error("Thiếu tên dịch vụ");
      if (!String(draft.url || "").trim()) throw new Error("Thiếu URL dịch vụ");
      // URL VALIDATION: reject a bare word like "test4" → the app would load https://test4/ which does not
      // resolve → BLANK white tab in App User. Require a real http(s) address with a dotted hostname.
      const urlError = (u) => {
        const v = String(u || "").trim();
        if (!v) return "";
        let parsed; try { parsed = new URL(v); } catch { return "không đúng định dạng (thiếu http:// hoặc gõ sai)"; }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "phải bắt đầu bằng http:// hoặc https://";
        if (!parsed.hostname.includes(".") || parsed.hostname.startsWith(".") || parsed.hostname.endsWith(".")) return "thiếu tên miền hợp lệ (ví dụ https://chatgpt.com/)";
        return "";
      };
      const uErr = urlError(draft.url);
      if (uErr) throw new Error(`URL dịch vụ ${uErr}`);
      const lErr = urlError(draft.loginUrl);
      if (lErr) throw new Error(`URL đăng nhập ${lErr}`);

      // DATA-SAFETY: /api/services/save REPLACES the whole array. Building it off a possibly-stale state.services
      // (a failed/partial refresh) would DROP other services or wipe their fields. Re-fetch the authoritative
      // list and merge this one draft in; if the fetch fails, ABORT rather than overwrite with less.
      const fresh = await getJson("/api/services").catch(() => null);
      const base = Array.isArray(fresh && fresh.config && fresh.config.services) ? fresh.config.services : null;
      if (!base) throw new Error("Không tải được danh sách dịch vụ hiện tại — CHƯA lưu (tránh mất dữ liệu). Bấm Làm mới rồi thử lại.");
      const nextServices = [...base];
      const index = draft.id ? nextServices.findIndex((service) => service.id === draft.id) : -1;
      if (index >= 0) nextServices[index] = draft;
      else nextServices.push({ ...draft, id: "" });

      const result = await postJson("/api/services/save", { services: nextServices, _bridge: "cf2", _creating: !!state.serviceUi.creating, _draftId: draft.id || "NEW" });
      updateServicesFromConfig(result.config);
      const saved = state.services.find((service) => service.name === draft.name && service.url === draft.url) || state.services[0];
      state.serviceUi.creating = false; // saved → exit "Tạo mới" mode, select the just-saved service
      state.serviceUi.selectedId = saved?.id || "";
      mountServicesApiPanel();
      return { type: "save-service", count: state.services.length, serviceId: state.serviceUi.selectedId };
    });
  }

  async function deleteApiService() {
    return runAction("delete service", async () => {
      const current = selectedApiService();
      if (!current?.id) throw new Error("No selected service");
      // DATA-SAFETY (same as save): delete off the FRESH list, not a possibly-stale state.services.
      const fresh = await getJson("/api/services").catch(() => null);
      const base = Array.isArray(fresh && fresh.config && fresh.config.services) ? fresh.config.services : null;
      if (!base) throw new Error("Không tải được danh sách dịch vụ hiện tại — CHƯA xoá (tránh mất dữ liệu). Bấm Làm mới rồi thử lại.");
      const result = await postJson("/api/services/save", {
        services: base.filter((service) => service.id !== current.id)
      });
      updateServicesFromConfig(result.config);
      mountServicesApiPanel();
      return { type: "delete-service", count: state.services.length, serviceId: current.id };
    });
  }

  async function resetApiServices() {
    return runAction("reset services", async () => {
      const result = await postJson("/api/services/reset");
      updateServicesFromConfig(result.config);
      mountServicesApiPanel();
      return { type: "reset-services", count: state.services.length };
    });
  }

  function newApiService() {
    state.serviceUi.creating = true;   // blank/new mode — selectedApiService returns null → draft.id stays ""
    state.serviceUi.selectedId = "";
    mountServicesApiPanel({ blank: true });
    showActionToast("Nhập thông tin dịch vụ mới rồi bấm Lưu dịch vụ");
  }

  function fieldHtml(label, id, value, span = "") {
    return `
      <label style="${span};display:flex;flex-direction:column;gap:7px;">
        <span style="font-size:11px;font-weight:800;color:var(--label);letter-spacing:.04em;text-transform:uppercase;">${label}</span>
        <input id="${id}" value="${escapeHtml(value)}" style="width:100%;height:40px;border:1px solid var(--field-border);border-radius:9px;background:var(--field-bg);color:var(--text);font:600 13px/1 Segoe UI,system-ui,sans-serif;padding:0 12px;">
      </label>`;
  }

  function textareaFieldHtml(label, id, value, placeholder = "", span = "grid-column:1 / -1") {
    return `
      <label style="${span};display:flex;flex-direction:column;gap:7px;">
        <span style="font-size:11px;font-weight:800;color:var(--label);letter-spacing:.04em;text-transform:uppercase;">${label}</span>
        <textarea id="${id}" rows="3" placeholder="${escapeHtml(placeholder)}" style="width:100%;min-height:74px;resize:vertical;border:1px solid var(--field-border);border-radius:9px;background:var(--field-bg);color:var(--text);font:600 12.5px/1.5 Segoe UI,system-ui,sans-serif;padding:9px 12px;">${escapeHtml(value)}</textarea>
      </label>`;
  }

  function checkboxHtml(label, id, checked) {
    return `
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;font-weight:700;color:var(--text);cursor:pointer;">
        <input id="${id}" type="checkbox" ${checked ? "checked" : ""} style="width:17px;height:17px;cursor:pointer;">${label}
      </label>`;
  }

  function mountServicesApiPanel(options = {}) {
    // URL deep-link /dich-vu/<id>: once the services list has loaded, select the service named in the path.
    // Clear the pending once the list is known (found → select it; not found → give up) so it stops retrying.
    if (__pendingServiceId && Array.isArray(state.services) && state.services.length) {
      const svc = state.services.find((s) => s.id === __pendingServiceId);
      if (svc) { state.serviceUi.creating = false; state.serviceUi.selectedId = svc.id; options = { ...options, force: true }; }
      __pendingServiceId = "";
    }
    const screen = findServicesScreen();
    if (!screen) return false;
    // PRESERVE INPUT: a background poll bumps state.updatedAt every few seconds; without this guard the panel
    // re-renders its innerHTML mid-type and WIPES whatever the user was entering (they had to start over).
    // Skip auto re-renders (anything not an explicit force/blank) while the user is creating a new service OR
    // while focus is inside a field of this panel. A real save/select passes force/blank and still re-renders.
    if (!options.force && !options.blank) {
      const ae = document.activeElement;
      const typingInPanel = ae && screen.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || "");
      if (state.serviceUi.creating || typingInPanel) return true;
    }
    if (screen.dataset.centrixServicesApiMount === state.updatedAt && screen.dataset.centrixServicesApiSelected === state.serviceUi.selectedId && !options.force && !options.blank) {
      return true;
    }

    const current = options.blank ? null : selectedApiService();
    const q = fold(state.serviceUi.filter);
    const rows = state.services
      .filter((service) => !q || fold(`${service.name} ${service.url}`).includes(q))
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const blankNote = state.ok ? "" : `<div style="margin-top:8px;font-size:12px;color:var(--danger);">API chưa sẵn sàng: ${escapeHtml(state.error || "đang kết nối")}</div>`;
    const rowHtml = rows.length
      ? rows.map((service) => {
        const active = service.id === state.serviceUi.selectedId && !options.blank;
        return `
          <button type="button" data-centrix-service-id="${escapeHtml(service.id)}" style="width:100%;text-align:left;display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:11px;cursor:pointer;border:1px solid ${active ? "var(--brand-border)" : "var(--border-soft)"};background:${active ? "var(--brand-soft)" : "var(--surface-2)"};color:var(--text);">
            <span style="position:relative;width:32px;height:32px;border-radius:8px;background:var(--brand-soft);border:1px solid var(--border-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;">${serviceIconHtml(service)}</span>
            <span style="min-width:0;display:flex;flex-direction:column;gap:3px;">
              <strong style="font-size:14px;font-weight:800;color:var(--text);">${escapeHtml(service.name || service.id)}</strong>
              <span style="font-size:12px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(service.url || "")}</span>
            </span>
            <em style="margin-left:auto;font-size:11px;font-style:normal;font-weight:800;color:${service.enabled === false ? "var(--danger)" : "var(--ok-text)"};">${service.enabled === false ? "Off" : "On"}</em>
          </button>`;
      }).join("")
      : `<div style="text-align:center;padding:28px 12px;color:var(--text-3);font-size:12.5px;font-weight:700;">Không có dịch vụ phù hợp</div>`;

    const title = current?.name || "Dịch vụ mới";
    screen.dataset.centrixServicesApiMount = state.updatedAt;
    screen.dataset.centrixServicesApiSelected = state.serviceUi.selectedId || "";
    screen.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="padding:24px 26px;border-bottom:1px solid var(--border-soft);display:flex;align-items:flex-start;justify-content:space-between;gap:20px;">
          <div>
            <div style="font-size:21px;font-weight:800;color:var(--text);letter-spacing:-.01em;">Dịch vụ cho app người dùng</div>
            <div style="font-size:13.5px;color:var(--text-2);margin-top:5px;">Đang lấy trực tiếp từ API /api/services. App User sẽ cập nhật sau khi đăng nhập hoặc refresh 5 giây.</div>
            ${blankNote}
          </div>
          <div style="display:flex;gap:10px;flex-shrink:0;">
            <button type="button" data-centrix-service-action="new" style="font-size:13.5px;font-weight:800;color:#fff;background:var(--brand);border:none;border-radius:9px;padding:10px 18px;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Tạo mới</button>
            <button type="button" data-centrix-service-action="reset" style="font-size:13.5px;font-weight:800;color:var(--text-2);background:var(--surface);border:1px solid var(--field-border);border-radius:9px;padding:10px 16px;cursor:pointer;">Khôi phục</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:minmax(260px,320px) 1fr;min-height:560px;">
          <div style="padding:22px 22px 22px 26px;border-right:1px solid var(--border-soft);display:flex;flex-direction:column;gap:10px;min-width:0;">
            <input id="centrix-service-api-search" value="${escapeHtml(state.serviceUi.filter)}" placeholder="Tìm dịch vụ..." style="width:100%;height:38px;font-size:13px;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:9px;padding:0 12px;">
            <div class="cx-scroll" style="display:flex;flex-direction:column;gap:10px;max-height:470px;overflow:auto;padding-right:2px;">${rowHtml}</div>
          </div>
          <div style="padding:24px 26px;display:grid;grid-template-columns:1fr 1fr;gap:16px 20px;align-content:start;min-width:0;">
            <div style="grid-column:1 / -1;display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:12px;">
              <span style="position:relative;width:48px;height:48px;border-radius:11px;background:#fff;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;">${serviceIconHtml(current || { name: title })}</span>
              <span style="min-width:0;flex:1;"><strong style="display:block;font-size:15px;font-weight:900;color:var(--text);">${escapeHtml(title)}</strong><span style="font-size:12.5px;color:var(--text-3);">API service catalog - ${state.services.length} services</span></span>
              ${current?.url ? `<a href="${escapeHtml(current.url)}" target="_blank" style="font-size:12.5px;font-weight:800;color:var(--brand);text-decoration:none;">Mở trang -></a>` : ""}
            </div>
            ${fieldHtml("Tên dịch vụ", "centrix-service-api-name", current?.name || "")}
            ${fieldHtml("URL", "centrix-service-api-url", current?.url || "")}
            ${fieldHtml("URL đăng nhập", "centrix-service-api-login-url", current?.loginUrl || current?.url || "")}
            ${fieldHtml("URL icon", "centrix-service-api-icon-url", current?.iconUrl || "")}
            ${fieldHtml("Model mặc định", "centrix-service-api-default-model", current?.defaultModel || "")}
            ${fieldHtml("Credit mặc định", "centrix-service-api-default-credit", current?.defaultCreditCost || 1)}
            ${textareaFieldHtml("Tên miền cookie (mỗi dòng 1)", "centrix-service-api-cookie-domains", (current?.cookieDomains || []).join("\n"), "vd: nhập mỗi dòng 1 tên miền — để trống nếu không cần")}
            <div style="grid-column:1 / -1;display:flex;flex-direction:column;gap:13px;margin-top:2px;">
              ${checkboxHtml("Hiển thị trong app người dùng", "centrix-service-api-enabled", current?.enabled !== false)}
              ${checkboxHtml("Bật bảng giá model", "centrix-service-api-pricing-enabled", current?.modelPricingEnabled !== false)}
            </div>
            <div style="grid-column:1 / -1;display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px;">
              <button type="button" data-centrix-service-action="save" style="font-size:14px;font-weight:900;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:12px;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Lưu dịch vụ</button>
              <button type="button" data-centrix-service-action="delete" ${current?.id ? "" : "disabled"} style="font-size:14px;font-weight:900;color:var(--danger);background:var(--surface);border:1px solid var(--field-border);border-radius:10px;padding:12px;cursor:${current?.id ? "pointer" : "not-allowed"};opacity:${current?.id ? "1" : ".5"};">Xóa</button>
            </div>
          </div>
        </div>
      </div>`;
    return true;
  }

  function scheduleServicesApiPanel() {
    registerBodyTick(mountServicesApiPanel);
    for (const delayMs of [300, 900, 1800, 3200]) setTimeout(mountServicesApiPanel, delayMs);
  }

  function modelServiceId() {
    if (state.modelUi.serviceId && state.services.some((service) => service.id === state.modelUi.serviceId)) {
      return state.modelUi.serviceId;
    }
    state.modelUi.serviceId = state.services[0]?.id || "";
    if (state.modelUi.serviceId) localStorage.setItem("centrixServerModelServiceId", state.modelUi.serviceId);
    return state.modelUi.serviceId;
  }

  function selectedModelService() {
    const id = modelServiceId();
    return state.services.find((service) => service.id === id) || state.services[0] || null;
  }

  function modelUserId() {
    if (state.modelUi.userId && state.users.some((user) => user.id === state.modelUi.userId)) {
      return state.modelUi.userId;
    }
    state.modelUi.userId = state.users[0]?.id || "local-user";
    localStorage.setItem("centrixServerModelUserId", state.modelUi.userId);
    return state.modelUi.userId;
  }

  function selectedModelUser() {
    const id = modelUserId();
    return state.users.find((user) => user.id === id) || { id, name: id };
  }

  function modelPricesForUi(serviceId = modelServiceId()) {
    return (state.modelPrices || [])
      .filter((price) => price.serviceId === serviceId)
      .sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true) || String(a.modelId || "").localeCompare(String(b.modelId || "")));
  }

  function selectedModelPolicy() {
    const userId = modelUserId();
    const serviceId = modelServiceId();
    return (state.modelPolicies || []).find((policy) => policy.userId === userId && policy.serviceId === serviceId) || null;
  }

  function modelPricesToLines(prices = []) {
    return prices
      .filter((price) => price.modelId)
      .map((price) => `${price.modelId}=${Math.max(1, Math.round(Number(price.creditCost || 1)))}`)
      .join("\n");
  }

  function modelListFromText(value) {
    return Array.from(new Set(String(value || "")
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean)))
      .slice(0, 80);
  }

  function parseModelPriceLines(serviceId, value, defaultModel = "") {
    const previous = new Map(modelPricesForUi(serviceId).map((price) => [price.modelId, price]));
    const observed = new Set((state.modelObservations || [])
      .filter((item) => item.serviceId === serviceId)
      .map((item) => item.modelId));
    const rows = [];
    const seen = new Set();
    for (const rawLine of String(value || "").split(/\r?\n/)) {
      const line = rawLine.replace(/#.*/, "").trim();
      if (!line) continue;
      const parts = line.includes("=") ? line.split("=") : line.split(/[\s,;:]+/);
      const modelId = String(parts.shift() || "").trim();
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      const oldPrice = previous.get(modelId) || {};
      const creditCost = Math.max(1, Math.round(Number(parts.join("=").trim() || oldPrice.creditCost || 1) || 1));
      rows.push({
        serviceId,
        modelId,
        displayName: oldPrice.displayName || modelId,
        creditCost,
        enabled: oldPrice.enabled !== false,
        isDefault: false,
        observedFromLoader: oldPrice.observedFromLoader === true || observed.has(modelId),
        source: "admin"
      });
    }
    const cleanDefault = String(defaultModel || rows[0]?.modelId || "").trim();
    rows.forEach((price, index) => {
      price.isDefault = cleanDefault ? price.modelId === cleanDefault : index === 0;
    });
    if (rows.length && !rows.some((price) => price.isDefault)) rows[0].isDefault = true;
    return rows;
  }

  function modelPriceCostMap(serviceId, prices = null) {
    const source = Array.isArray(prices) ? prices : modelPricesForUi(serviceId);
    const costs = {};
    for (const price of source) {
      if (price.modelId && price.enabled !== false) {
        costs[price.modelId] = Math.max(1, Math.round(Number(price.creditCost || 1)));
      }
    }
    return costs;
  }

  function modelPolicyDraftFromDom() {
    const serviceId = document.getElementById("centrix-model-service-select")?.value || modelServiceId();
    const userId = document.getElementById("centrix-model-user-select")?.value || modelUserId();
    const priceText = document.getElementById("centrix-model-price-lines")?.value || "";
    const defaultModel = String(document.getElementById("centrix-model-default-model")?.value || "").trim();
    const prices = parseModelPriceLines(serviceId, priceText, defaultModel);
    const allowedText = document.getElementById("centrix-model-allowed-models")?.value || "";
    return {
      userId,
      serviceId,
      enabled: document.getElementById("centrix-model-policy-enabled")?.checked === true,
      allowedModels: modelListFromText(allowedText),
      dailyLimit: Math.max(0, Math.round(Number(document.getElementById("centrix-model-daily-limit")?.value || 0))),
      modelCreditCosts: modelPriceCostMap(serviceId, prices),
      defaultCreditCost: Math.max(1, Math.round(Number(document.getElementById("centrix-model-default-credit")?.value || 1) || 1)),
      blockUnknown: document.getElementById("centrix-model-block-unknown")?.checked === true,
      defaultModel
    };
  }

  // --- Model price table draft (mockup "Định giá Model") -------------------------------------------
  // A per-service working copy of the price rows that the table controls (toggle / stepper / default /
  // remove / add) mutate in place. "Lưu bảng giá" persists it via POST /api/admin/model-prices. Kept
  // separate from state.modelPrices so a background /api/users refresh never clobbers in-progress edits.
  function getModelPriceDraft(serviceId = modelServiceId()) {
    if (!state.modelUi.priceDraft || state.modelUi.priceDraft.serviceId !== serviceId) {
      const rows = modelPricesForUi(serviceId).map((price) => ({
        serviceId,
        modelId: price.modelId,
        displayName: price.displayName || price.modelId,
        creditCost: Math.max(1, Math.round(Number(price.creditCost || 1))),
        creditPerKTok: Math.max(0, Number(price.creditPerKTok || 0)),
        enabled: price.enabled !== false,
        isDefault: price.isDefault === true,
        observedFromLoader: price.observedFromLoader === true,
        source: price.source || "admin"
      }));
      if (rows.length && !rows.some((row) => row.isDefault)) rows[0].isDefault = true;
      state.modelUi.priceDraft = { serviceId, rows };
    }
    return state.modelUi.priceDraft.rows;
  }

  function findModelDraftRow(modelId) {
    return getModelPriceDraft().find((row) => row.modelId === modelId) || null;
  }

  // Pull any in-flight credit <input> values into the draft before a re-render so typed-but-not-blurred
  // numbers are never lost when the user clicks a toggle/stepper.
  function syncCreditInputsToDraft() {
    const rows = state.modelUi.priceDraft?.rows;
    if (!rows) return;
    document.querySelectorAll("[data-centrix-model-credit-id]").forEach((input) => {
      const row = rows.find((item) => item.modelId === input.getAttribute("data-centrix-model-credit-id"));
      if (row) row.creditCost = Math.max(1, Math.round(Number(input.value) || row.creditCost || 1));
    });
    document.querySelectorAll("[data-centrix-model-ktok-id]").forEach((input) => {
      const row = rows.find((item) => item.modelId === input.getAttribute("data-centrix-model-ktok-id"));
      if (row) { const v = Number(input.value); row.creditPerKTok = Number.isFinite(v) && v >= 0 ? v : 0; }
    });
  }

  function ensureOneDefault(rows) {
    if (rows.length && !rows.some((row) => row.isDefault)) rows[0].isDefault = true;
  }

  function toggleModelDraftEnabled(modelId) {
    syncCreditInputsToDraft();
    const row = findModelDraftRow(modelId);
    if (!row) return;
    row.enabled = !row.enabled;
    mountModelApiPanel({ force: true });
  }

  function stepModelDraftCredit(modelId, delta) {
    syncCreditInputsToDraft();
    const row = findModelDraftRow(modelId);
    if (!row) return;
    row.creditCost = Math.max(1, Math.round(Number(row.creditCost || 1) + Number(delta || 0)));
    mountModelApiPanel({ force: true });
  }

  function setModelDraftCredit(modelId, value) {
    const row = findModelDraftRow(modelId);
    if (row) row.creditCost = Math.max(1, Math.round(Number(value) || 1));
  }

  function setModelDraftDefault(modelId) {
    syncCreditInputsToDraft();
    const rows = getModelPriceDraft();
    rows.forEach((row) => { row.isDefault = row.modelId === modelId; });
    mountModelApiPanel({ force: true });
  }

  function removeModelDraftRow(modelId) {
    syncCreditInputsToDraft();
    const draft = state.modelUi.priceDraft;
    if (!draft) return;
    draft.rows = draft.rows.filter((row) => row.modelId !== modelId);
    ensureOneDefault(draft.rows);
    mountModelApiPanel({ force: true });
  }

  function addModelDraftRow(modelId) {
    syncCreditInputsToDraft();
    const serviceId = modelServiceId();
    const clean = String(modelId || "").trim();
    if (!clean) return;
    const rows = getModelPriceDraft(serviceId);
    if (rows.some((row) => row.modelId === clean)) {
      showActionToast(`Model ${clean} đã có trong bảng giá`);
      return;
    }
    rows.push({
      serviceId,
      modelId: clean,
      displayName: clean,
      creditCost: 1,
      enabled: true,
      isDefault: rows.length === 0,
      observedFromLoader: true,
      source: "admin"
    });
    ensureOneDefault(rows);
    mountModelApiPanel({ force: true });
  }

  async function checkModelFromUi(modelId) {
    return runAction("check model", async () => {
      const serviceId = modelServiceId();
      const userId = modelUserId();
      const clean = String(modelId || "").trim();
      if (!clean) throw new Error("Thiếu model");
      const result = await postJson("/api/users/model-usage/check", {
        userId,
        serviceId,
        modelId: clean,
        consume: false
      });
      const allowed = result.allowed !== false;
      const cost = result.creditCost;
      showActionToast(
        `${clean}: ${allowed ? "OK" : "Bị chặn"}${cost != null ? ` · ${cost} credit/request` : ""}${result.reason ? ` · ${result.reason}` : ""}`,
        allowed ? "ok" : "error"
      );
      return { type: "check-model", serviceId, modelId: clean, allowed, creditCost: cost };
    });
  }

  function formatObservationTime(value) {
    const date = new Date(value || 0);
    if (Number.isNaN(date.getTime()) || !value) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function saveModelPricesFromUi() {
    return runAction("save model prices", async () => {
      const serviceId = modelServiceId();
      syncCreditInputsToDraft();
      const rows = getModelPriceDraft(serviceId);
      if (!rows.length) throw new Error("Chưa có model nào trong bảng giá");
      ensureOneDefault(rows);
      const prices = rows.map((row) => ({
        serviceId,
        modelId: row.modelId,
        displayName: row.displayName || row.modelId,
        creditCost: Math.max(1, Math.round(Number(row.creditCost || 1))),
        creditPerKTok: Math.max(0, Number(row.creditPerKTok || 0)),
        enabled: row.enabled !== false,
        isDefault: row.isDefault === true,
        observedFromLoader: row.observedFromLoader === true,
        source: "admin"
      }));
      const result = await postJson("/api/admin/model-prices", { serviceId, prices });
      state.modelPrices = result.db?.modelPrices || state.modelPrices;
      state.modelUi.priceDraft = null; // re-init from the freshly saved data
      mountModelApiPanel({ force: true });
      showActionToast(`Đã lưu ${prices.length} model cho ${selectedModelService()?.name || serviceId}`);
      return { type: "save-model-prices", serviceId, prices: prices.length };
    });
  }

  async function saveModelPolicyFromUi() {
    return runAction("save model policy", async () => {
      const draft = modelPolicyDraftFromDom();
      if (!draft.serviceId) throw new Error("Missing service");
      if (!draft.userId) throw new Error("Missing user");
      const result = await postJson("/api/users/model-policy", draft);
      state.modelPolicies = result.db?.modelPolicies || state.modelPolicies;
      mountModelApiPanel({ force: true });
      return { type: "save-model-policy", userId: draft.userId, serviceId: draft.serviceId, enabled: draft.enabled };
    });
  }

  async function testModelPolicyFromUi() {
    return runAction("test model policy", async () => {
      const draft = modelPolicyDraftFromDom();
      const modelId = String(document.getElementById("centrix-model-test-id")?.value || draft.defaultModel || "").trim();
      if (!modelId) throw new Error("Missing test model");
      const result = await postJson("/api/users/model-usage/check", {
        userId: draft.userId,
        serviceId: draft.serviceId,
        modelId,
        consume: false
      });
      state.modelUi.lastTest = {
        userId: draft.userId,
        serviceId: draft.serviceId,
        modelId,
        allowed: result.allowed !== false,
        reason: result.reason || "",
        creditCost: result.creditCost,
        balance: result.balance ?? result.wallet?.balance,
        checkedAt: new Date().toISOString()
      };
      mountModelApiPanel({ force: true });
      return { type: "test-model-policy", serviceId: draft.serviceId, modelId, allowed: result.allowed !== false, creditCost: result.creditCost };
    });
  }

  async function topupCreditFromUi() {
    return runAction("topup credit", async () => {
      const userId = document.getElementById("centrix-model-user-select")?.value || modelUserId();
      if (!userId) throw new Error("Thiếu user");
      const amount = Math.round(Number(document.getElementById("centrix-credit-topup-amount")?.value || 0));
      if (!Number.isFinite(amount) || amount === 0) throw new Error("Nhập số credit khác 0 (âm để trừ)");
      const reason = String(document.getElementById("centrix-credit-topup-reason")?.value || "").trim()
        || "App Server UI nạp credit theo user";
      // Atomic wallet mutation + credit_transactions("adjust") on the server, keyed by userId.
      const result = await postJson("/api/admin/credits/adjust", {
        userId,
        amountDelta: amount,
        reason,
        actor: currentActor()
      });
      state.creditWallets = result.db?.creditWallets || state.creditWallets;
      const wallet = (result.db?.creditWallets || []).find((row) => row.userId === userId);
      const balance = wallet?.balance ?? null;
      mountModelApiPanel({ force: true });
      if (balance != null) showActionToast(`Đã ${amount >= 0 ? "nạp" : "trừ"} ${Math.abs(amount)} cr · số dư ${Number(balance).toLocaleString("vi-VN")} cr`);
      return { type: "topup-credit", userId, amountDelta: amount, balance };
    });
  }

  // Wire the "Người dùng & Credit" page bulk "+ Nạp N credit" button (the static design's uBulk.topup is
  // a demo no-op). Targets = the users currently selected (ticked) in that page — read from the live
  // logic (bulkTargets()/selIds(); real userIds because the pool is window.__cxRealUsers) — and each is
  // adjusted through the REAL /api/admin/credits/adjust (atomic wallet + credit_transactions).
  // Read the users currently ticked in the "Người dùng & Credit" table via the design's selection API.
  function tickedUserIds() {
    const logic = currentLogic();
    try {
      const ids = (typeof logic?.bulkTargets === "function" ? logic.bulkTargets()
        : typeof logic?.selIds === "function" ? logic.selIds() : []) || [];
      return Array.from(new Set(ids.filter(Boolean)));
    } catch { return []; }
  }

  // Credit `amount` (negative = trừ) to each userId via the REAL /api/admin/credits/adjust (atomic wallet +
  // credit_transactions). SELF-CONTAINED: callers pass explicit ids, so it never depends on the design's
  // checkboxes/selection methods rendering — the reliable manual top-up path.
  async function topupUsers(ids, amount) {
    ids = Array.from(new Set((ids || []).filter(Boolean)));
    if (!ids.length) { showActionToast("Chưa chọn người dùng để nạp", "error"); return null; }
    if (!Number.isFinite(amount) || amount === 0) { showActionToast("Nhập số credit khác 0", "error"); return null; }
    return runAction("nạp credit", async () => {
      let ok = 0, lastBalance = null;
      for (const userId of ids) {
        try {
          const result = await postJson("/api/admin/credits/adjust", {
            userId, amountDelta: amount, reason: "App Server UI nạp credit thủ công", actor: currentActor()
          });
          if (result?.db?.creditWallets) state.creditWallets = result.db.creditWallets;
          lastBalance = (result?.db?.creditWallets || []).find((w) => w.userId === userId)?.balance ?? lastBalance;
          ok += 1;
        } catch { /* keep going for the remaining users */ }
      }
      applyRealUserPool();
      setServerPage("users");
      const verb = amount < 0 ? "trừ" : "nạp";
      const absAmt = Math.abs(amount).toLocaleString("vi-VN");
      showActionToast(ids.length === 1
        ? (ok ? `Đã ${verb} ${absAmt} credit — số dư mới: ${Number(lastBalance ?? 0).toLocaleString("vi-VN")} cr` : `${verb === "trừ" ? "Trừ" : "Nạp"} credit thất bại`)
        : `Đã ${verb} ${absAmt} credit cho ${ok}/${ids.length} user`, ok ? "ok" : "error");
      return { type: "topup-users", users: ids.length, ok, amount, balance: lastBalance };
    });
  }

  // Bulk top-up entry (kept for any direct callers): credit the ticked users.
  async function bulkTopupCredit(amount = 50) {
    if (!Number.isFinite(amount) || amount === 0) amount = 50;
    return topupUsers(tickedUserIds(), amount);
  }

  // App Server "Khóa / Mở tài khoản" (user detail-drawer). Calls the master-token admin route which flips
  // BOTH enabled flags + revokes sessions in the Docker DB → enforcement is immediate (the App User is 401'd
  // on its next request; next login is rejected). Updates state.users locally so the table/label flip at once.
  async function toggleUserLocked(userId, lock) {
    return runAction(lock ? "khóa tài khoản" : "mở tài khoản", async () => {
      const user = (state.users || []).find((u) => u.id === userId);
      if (!user) throw new Error(`Không tìm thấy user ${userId}`);
      await postJson("/api/admin/accounts/set-locked", { userId, locked: !!lock });
      const idx = (state.users || []).findIndex((u) => u.id === userId);
      if (idx >= 0) state.users[idx] = { ...state.users[idx], enabled: !lock };
      applyRealUserPool();
      showActionToast(`Đã ${lock ? "khóa" : "mở"} tài khoản ${escapeHtml(user.name || userId)}`);
      return { type: lock ? "lock-user" : "unlock-user", userId, locked: !!lock };
    });
  }

  // Bulk "Khóa" / "Mở khóa" (action bar) — lock/unlock every checkbox-selected user via the same admin route.
  async function bulkSetLocked(ids, lock) {
    return runAction(lock ? "khóa tài khoản" : "mở khóa tài khoản", async () => {
      let ok = 0;
      for (const userId of ids) {
        try {
          await postJson("/api/admin/accounts/set-locked", { userId, locked: !!lock });
          const idx = (state.users || []).findIndex((u) => u.id === userId);
          if (idx >= 0) state.users[idx] = { ...state.users[idx], enabled: !lock };
          ok += 1;
        } catch (e) { /* keep going for the remaining users */ }
      }
      applyRealUserPool();
      showActionToast(`Đã ${lock ? "khóa" : "mở khóa"} ${ok}/${ids.length} tài khoản`);
      return { type: lock ? "bulk-lock" : "bulk-unlock", users: ids.length, ok };
    });
  }

  // Custom-amount top-up: the design's "+ Nạp N credit" buttons (user drawer + bulk bar) credit a FIXED N.
  // This modal lets the admin enter ANY amount (prefilled with that N; negative = trừ) before crediting the
  // selected user(s) via bulkTopupCredit.
  function closeBulkTopupModal() { document.getElementById("cx-bulk-topup-modal")?.remove(); }

  // ── VÍ TIỀN VND (web admin): nạp tiền VND thủ công + hiện số dư. TIỀN → POST /api/admin/money/topup (dbapi nguyên tử). ──
  function moneyBalanceById(uid) { const w = (state.creditWallets || []).find((x) => x.userId === uid); return w ? Number(w.moneyBalance || 0) : 0; }
  function closeMoneyModal() { document.getElementById("cx-money-modal")?.remove(); }
  function openMoneyTopupModal(userId) {
    const uid = String(userId || "").trim();
    if (!uid) { showActionToast("Thiếu người dùng"); return; }
    const cur = moneyBalanceById(uid);
    const fc = "width:100%;height:46px;border:1px solid var(--field-border,#cbd5e1);border-radius:11px;background:var(--field-bg,var(--surface));color:var(--text);padding:0 13px;box-sizing:border-box;font:800 16px 'Segoe UI',system-ui,sans-serif;";
    const body = `<label style="display:block;font:800 10.5px 'Segoe UI',system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;letter-spacing:.04em;">Số tiền nạp (VND)</label>
      <input id="cx-money-amount" type="number" step="10000" min="0" placeholder="vd 100000" style="${fc}margin-top:6px;">
      <div style="margin-top:10px;font-size:12.5px;color:var(--text-3);">Ví VND hiện tại: <strong style="color:var(--brand);">${cur.toLocaleString("vi-VN")} đ</strong></div>`;
    const footer = cxModalFooter({ cancelAttrs: 'id="cx-money-cancel"', confirmLabel: "Nạp vào ví VND", confirmTone: "brand", confirmAttrs: 'id="cx-money-ok"' });
    const overlay = cxModalOverlay("cx-money-modal");
    overlay.innerHTML = cxModalCard({ tone: "brand", icon: "credit", title: "Nạp tiền VND", subtitle: "Cho: " + escapeHtml(userNameById(uid)), body, footer });
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeMoneyModal(); });
    document.getElementById("cx-money-cancel")?.addEventListener("click", closeMoneyModal);
    document.getElementById("cx-money-ok")?.addEventListener("click", () => submitMoneyTopup(uid));
    setTimeout(() => document.getElementById("cx-money-amount")?.focus(), 30);
  }
  async function submitMoneyTopup(uid) {
    const amount = Math.round(Number(document.getElementById("cx-money-amount")?.value || 0));
    if (!(amount > 0)) { showActionToast("Nhập số tiền > 0"); return; }
    return runAction("money topup", async () => {
      const result = await postJson("/api/admin/money/topup", { userId: uid, amountVnd: amount });
      if (result && result.db && result.db.creditWallets) state.creditWallets = result.db.creditWallets;
      closeMoneyModal();
      showActionToast(`Đã nạp ${amount.toLocaleString("vi-VN")}đ · Ví VND: ${moneyBalanceById(uid).toLocaleString("vi-VN")}đ`);
      setTimeout(() => refresh(), 0);
      return { type: "money-topup", userId: uid, amountVnd: amount };
    });
  }

  // ── Shared modal shell for the "Người dùng & Credit" action popups (Nạp/Trừ credit, Nạp gói, Khóa, Xóa) ──
  // One consistent look: centered blurred overlay → rounded card → tone-coloured icon + title + subtitle header
  // → body → footer (Hủy + tone-coloured confirm). tone = brand(xanh, nạp/gói) / warn(cam, trừ/khóa) / danger(đỏ, xóa).
  const CX_MTONE = {
    brand:  { soft: "var(--brand-soft,#eff6ff)",  fg: "var(--brand,#2563eb)",   solid: "var(--brand,#2563eb)",   sh: "rgba(37,99,235,.32)" },
    warn:   { soft: "#fff7ed",                     fg: "#ea580c",                solid: "#ea580c",                sh: "rgba(234,88,12,.30)" },
    danger: { soft: "var(--danger-soft,#fee2e2)",  fg: "var(--danger,#ef4444)",  solid: "var(--danger,#ef4444)",  sh: "rgba(239,68,68,.32)" },
  };
  const CX_MSVG = (inner) => `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const CX_MICON = {
    credit: CX_MSVG('<circle cx="12" cy="12" r="9"></circle><path d="M12 8v8M8 12h8"></path>'),
    minus:  CX_MSVG('<circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path>'),
    plan:   CX_MSVG('<path d="M20 7 12 3.5 4 7l8 4 8-4z"></path><path d="M4 7v10l8 4 8-4V7"></path><path d="M12 11v9.5"></path>'),
    lock:   CX_MSVG('<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path>'),
    trash:  CX_MSVG('<path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line>'),
  };
  function cxModalOverlay(id) {
    document.getElementById(id)?.remove();
    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.5);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);padding:20px;box-sizing:border-box;";
    return overlay;
  }
  function cxModalCard({ tone = "brand", icon = "", title = "", subtitle = "", width = 420, body = "", footer = "" }) {
    const t = CX_MTONE[tone] || CX_MTONE.brand;
    return `<div role="dialog" aria-modal="true" style="width:${width}px;max-width:100%;max-height:calc(100vh - 40px);overflow:auto;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:18px;box-shadow:0 26px 70px rgba(15,23,42,.34);padding:22px 24px;box-sizing:border-box;">`
      + `<div style="display:flex;align-items:flex-start;gap:13px;">`
      + `<div style="width:44px;height:44px;border-radius:13px;background:${t.soft};color:${t.fg};display:flex;align-items:center;justify-content:center;flex-shrink:0;">${CX_MICON[icon] || ""}</div>`
      + `<div style="min-width:0;flex:1;padding-top:1px;"><div style="font:900 17px 'Segoe UI',system-ui,sans-serif;color:var(--text,#0f172a);line-height:1.25;">${title}</div>`
      + (subtitle ? `<div style="font:600 12.5px 'Segoe UI',system-ui,sans-serif;color:var(--text-2,#64748b);margin-top:3px;line-height:1.5;overflow-wrap:anywhere;">${subtitle}</div>` : "")
      + `</div></div>`
      + (body ? `<div style="margin-top:17px;">${body}</div>` : "")
      + (footer || "")
      + `</div>`;
  }
  function cxModalFooter({ cancelLabel = "Hủy", cancelAttrs = "", confirmLabel = "OK", confirmTone = "brand", confirmAttrs = "" }) {
    const t = CX_MTONE[confirmTone] || CX_MTONE.brand;
    return `<div style="display:flex;gap:11px;margin-top:20px;">`
      + `<button type="button" ${cancelAttrs} style="flex:1;height:44px;border:1px solid var(--field-border,#cbd5e1);border-radius:11px;background:var(--surface,#fff);color:var(--text-2,#475569);font:800 13px 'Segoe UI',system-ui,sans-serif;cursor:pointer;">${cancelLabel}</button>`
      + `<button type="button" ${confirmAttrs} style="flex:1.4;height:44px;border:0;border-radius:11px;background:${t.solid};color:#fff;font:900 13px 'Segoe UI',system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 16px ${t.sh};">${confirmLabel}</button>`
      + `</div>`;
  }
  function cxModalNoteBox(html, tone) {
    const t = CX_MTONE[tone] || null;
    return `<div style="font:500 13px/1.55 'Segoe UI',system-ui,sans-serif;color:var(--text-2,#475569);background:${t ? t.soft : "var(--surface-2,#f8fafc)"};border:1px solid var(--border-soft,#eef2f7);border-radius:12px;padding:13px 15px;">${html}</div>`;
  }
  // Generic confirm popup (used by Khóa + Xóa): shell + note box + Hủy/confirm. onConfirm runs then closes.
  function openConfirmModal({ id, tone = "danger", icon = "trash", title, subtitle = "", noteHtml = "", confirmLabel = "Xác nhận", onConfirm }) {
    const overlay = cxModalOverlay(id);
    const footer = cxModalFooter({ cancelAttrs: "data-cx-mc-cancel", confirmLabel, confirmTone: tone, confirmAttrs: "data-cx-mc-ok" });
    overlay.innerHTML = cxModalCard({ tone, icon, title, subtitle, width: 430, body: noteHtml ? cxModalNoteBox(noteHtml, tone) : "", footer });
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("[data-cx-mc-cancel]")?.addEventListener("click", close);
    overlay.querySelector("[data-cx-mc-ok]")?.addEventListener("click", () => { close(); try { onConfirm && onConfirm(); } catch (e) { /* ignore */ } });
    return overlay;
  }

  function openBulkTopupModal(defaultAmount = 100, presetUserId = "", mode = "add") {
    closeBulkTopupModal();
    const deduct = mode === "deduct";
    const fc = "width:100%;height:46px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:800 18px Segoe UI;padding:0 14px;box-sizing:border-box;";
    // Self-contained target picker: the admin ALWAYS picks the user here, so top-up works even if the
    // design's row-checkbox selection API isn't available. If users are already ticked, offer that as the
    // default; if the modal was opened from a specific user's drawer, preselect that user.
    const ticked = tickedUserIds();
    const users = realUserPool().slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const preset = presetUserId && users.some((u) => u.id === presetUserId) ? presetUserId : "";
    // Opened from a SPECIFIC user (clicked row / drawer) → LOCK the target to that user (no picker; just amount).
    // Opened from the bulk bar → show the user picker (ticked users / choose one).
    const singleTarget = preset ? users.find((u) => u.id === preset) : null;
    const userOptions = users.map((u) =>
      `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}${u.email ? " · " + escapeHtml(u.email) : ""} · ${Number(u.credit || 0).toLocaleString("vi-VN")} cr${u.status === "locked" ? " (đã khóa)" : ""}</option>`).join("");
    const tickedOpt = ticked.length ? `<option value="__ticked__" selected>👥 Tất cả user đã tick (${ticked.length})</option>` : "";
    const placeholder = ticked.length ? "" : `<option value="" selected disabled>— Chọn người dùng —</option>`;
    const targetHtml = singleTarget
      ? `<div style="display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid var(--brand-border,#bfdbfe);border-radius:11px;background:var(--brand-soft,#eff6ff);margin-top:6px;">`
        + `<div style="width:34px;height:34px;border-radius:10px;background:var(--brand,#2563eb);color:#fff;display:flex;align-items:center;justify-content:center;font:900 14px 'Segoe UI',system-ui,sans-serif;flex-shrink:0;">${escapeHtml((String(singleTarget.name || "?").trim().charAt(0) || "?").toUpperCase())}</div>`
        + `<div style="min-width:0;"><div style="font:800 13.5px 'Segoe UI',system-ui,sans-serif;color:var(--text,#0f172a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(singleTarget.name || singleTarget.id)}</div>`
        + `<div style="font:600 11.5px 'Segoe UI',system-ui,sans-serif;color:var(--text-2,#64748b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${singleTarget.email ? escapeHtml(singleTarget.email) + " · " : ""}Số dư ${Number(singleTarget.credit || 0).toLocaleString("vi-VN")} cr</div></div>`
        + `</div>`
      : `<select id="cx-bulk-topup-user" style="${fc}font:700 14px 'Segoe UI',system-ui,sans-serif;margin-top:6px;">${tickedOpt}${placeholder}${userOptions}</select>`;
    const body = `<label style="display:block;font:800 10.5px 'Segoe UI',system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;letter-spacing:.04em;">${singleTarget ? (deduct ? "Trừ credit cho" : "Nạp credit cho") : "Người dùng"}</label>
      ${targetHtml}
      <label style="display:block;margin-top:14px;font:800 10.5px 'Segoe UI',system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;letter-spacing:.04em;">Số credit</label>
      <input id="cx-bulk-topup-amount" type="number" step="1" value="${Number(defaultAmount) || 100}" style="${fc}margin-top:6px;">
      <div style="display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;">
        ${[50, 100, 200, 500, 1000].map((n) => `<button type="button" data-cx-topup-quick="${n}" style="border:1px solid var(--field-border,#cbd5e1);background:var(--surface-2,#f8fafc);color:var(--text-2,#475569);font:700 12px 'Segoe UI',system-ui,sans-serif;border-radius:8px;padding:7px 12px;cursor:pointer;">${n}</button>`).join("")}
      </div>`;
    const footer = cxModalFooter({ cancelAttrs: 'id="cx-bulk-topup-cancel"', confirmLabel: deduct ? "Trừ credit" : "Nạp credit", confirmTone: deduct ? "warn" : "brand", confirmAttrs: 'id="cx-bulk-topup-ok"' });
    const overlay = cxModalOverlay("cx-bulk-topup-modal");
    overlay.innerHTML = cxModalCard({
      tone: deduct ? "warn" : "brand",
      icon: deduct ? "minus" : "credit",
      title: deduct ? "Trừ credit thủ công" : "Nạp credit thủ công",
      subtitle: singleTarget
        ? `Nhập số credit muốn ${deduct ? "TRỪ (không xuống dưới 0)" : "nạp"} cho người dùng này.`
        : `Chọn người dùng và nhập số credit muốn ${deduct ? "TRỪ (không xuống dưới 0)" : "nạp"}.`,
      width: 420, body, footer
    });
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeBulkTopupModal(); });
    const input = document.getElementById("cx-bulk-topup-amount");
    overlay.querySelectorAll("[data-cx-topup-quick]").forEach((b) => b.addEventListener("click", () => { if (input) { input.value = b.getAttribute("data-cx-topup-quick"); input.focus(); } }));
    document.getElementById("cx-bulk-topup-cancel")?.addEventListener("click", closeBulkTopupModal);
    const submit = () => {
      let amount = Math.round(Number(input?.value || 0));
      if (!Number.isFinite(amount) || amount === 0) { showActionToast("Nhập số credit khác 0", "error"); return; }
      if (deduct) amount = -Math.abs(amount); // deduct mode → always subtract
      let ids;
      if (singleTarget) ids = [singleTarget.id];
      else {
        const sel = document.getElementById("cx-bulk-topup-user");
        const val = sel ? String(sel.value || "") : "";
        if (val === "__ticked__") ids = ticked;
        else if (val) ids = [val];
        else { showActionToast("Hãy chọn người dùng cần " + (deduct ? "trừ" : "nạp"), "error"); return; }
      }
      closeBulkTopupModal();
      topupUsers(ids, amount);
    };
    document.getElementById("cx-bulk-topup-ok")?.addEventListener("click", submit);
    input?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    setTimeout(() => { input?.focus(); input?.select(); }, 50);
  }

  function addObservedModelToInputs(modelId) {
    const clean = String(modelId || "").trim();
    if (!clean) return;
    const priceInput = document.getElementById("centrix-model-price-lines");
    const defaultInput = document.getElementById("centrix-model-default-model");
    const defaultCredit = Math.max(1, Math.round(Number(document.getElementById("centrix-model-default-credit")?.value || selectedModelService()?.defaultCreditCost || 1)));
    const lines = String(priceInput?.value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.some((line) => line.split(/[=\s,;:]+/)[0] === clean)) {
      lines.push(`${clean}=${defaultCredit}`);
      if (priceInput) priceInput.value = lines.join("\n");
    }
    if (defaultInput && !defaultInput.value) defaultInput.value = clean;
    const allowedInput = document.getElementById("centrix-model-allowed-models");
    const allowed = modelListFromText(allowedInput?.value || "");
    if (allowedInput && !allowed.includes(clean)) {
      allowed.push(clean);
      allowedInput.value = allowed.join("\n");
    }
    showActionToast(`Added model ${clean} to draft`);
  }

  function findModelScreen() {
    return visibleScreens()
      .find((screen) => {
        const label = fold(screen.getAttribute("data-screen-label"));
        return (
          label.includes("model pricing") ||
          label.includes("bang gia model") ||
          label.includes("dinh gia model") ||
          label.includes("pricing") ||
          label === "safety" ||
          label.includes("safety")
        );
      }) || null;
  }

  function updateModelStateFromUsersResult(result = {}) {
    state.modelPolicies = result.modelPolicies || result.db?.modelPolicies || state.modelPolicies || [];
    state.modelPrices = result.modelPrices || result.db?.modelPrices || state.modelPrices || [];
    state.modelUsage = result.modelUsage || result.db?.modelUsage || state.modelUsage || [];
    state.modelObservations = result.modelObservations || result.db?.modelObservations || state.modelObservations || [];
    state.creditWallets = result.creditWallets || result.db?.creditWallets || state.creditWallets || [];
    state.creditTransactions = result.creditTransactions || result.db?.creditTransactions || state.creditTransactions || [];
    state.moneyTransactions = result.moneyTransactions || result.db?.moneyTransactions || state.moneyTransactions || [];
    state.activity = result.activity || result.db?.activity || state.activity || [];
    syncModelServiceSelection();
    if (Array.isArray(result.users || result.db?.users)) {
      state.users = result.users || result.db?.users || state.users || [];
    }
  }

  async function refreshModelDataIfVisible() {
    if (document.hidden || modelDataRefreshRunning || !findModelScreen()) return;
    modelDataRefreshRunning = true;
    try {
      const result = await getJson("/api/users");
      updateModelStateFromUsersResult(result);
      publishState();
      mountModelApiPanel({ force: true });
    } catch {
      // Keep the current model panel data if a periodic refresh fails.
    } finally {
      modelDataRefreshRunning = false;
    }
  }

  function findActivityScreen() {
    return visibleScreens()
      .find((screen) => {
        const label = fold(screen.getAttribute("data-screen-label"));
        // "Sổ giao dịch" (credit ledger) is handled by mountLedgerApiPanel — NOT here. Mapping it to
        // the activity panel overwrote the ledger with the activity list (credit +/- never showed).
        return (
          label.includes("hoat dong") ||
          label.includes("activity") ||
          label.includes("audit")
        );
      }) || null;
  }

  function serviceNameById(serviceId) {
    const service = state.services.find((item) => item.id === serviceId);
    if (service?.name) return service.name;
    if (!serviceId) return "Hệ thống";
    return String(serviceId)
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function userNameById(userId) {
    const user = state.users.find((item) => item.id === userId);
    return user?.name || user?.email || userId || "Local User";
  }

  function walletForUser(userId) {
    return (state.creditWallets || []).find((wallet) => wallet.userId === userId) || null;
  }

  function formatActivityTime(value) {
    const date = value ? new Date(value) : new Date();
    if (!Number.isFinite(date.getTime())) return "";
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diffDays = Math.max(0, Math.floor((startToday - startThatDay) / 86400000));
    const time = date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    if (diffDays === 0) return `Hôm nay ${time}`;
    if (diffDays === 1) return `Hôm qua ${time}`;
    return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()} ${time}`;
  }

  function detailsObject(details) {
    if (!details) return {};
    if (typeof details === "object") return details;
    try {
      return JSON.parse(String(details));
    } catch {
      return { text: String(details || "") };
    }
  }

  function activityActionLabel(action) {
    const labels = {
      "model-usage": "Dùng model",
      "model-blocked": "Chặn model",
      "open-service": "Mở dịch vụ",
      "page-loaded": "Tải xong trang",
      navigate: "Chuyển trang",
      "local-store-upload": "Đồng bộ localStorage",
      "local-store-download": "Nạp localStorage",
      "profile-pull": "Tải hồ sơ",
      "profile-push": "Đẩy hồ sơ",
      "profile-upload": "Đẩy hồ sơ",
      "profile-download": "Tải hồ sơ",
      "ui-cache-sync": "Cache giao diện",
      login: "Đăng nhập",
      "login-new-device": "Đăng nhập thiết bị mới",
      "tab-open": "Mở tab",
      "tab-close": "Đóng tab"
    };
    if (labels[action]) return labels[action];
    return String(action || "Sự kiện")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function activityTone(action) {
    if (action === "model-blocked") {
      return { border: "var(--danger-border)", bg: "var(--danger-soft)", color: "var(--danger)" };
    }
    if (action === "model-usage" || action === "profile-pull" || action === "profile-push") {
      return { border: "var(--ok-border)", bg: "var(--ok-soft)", color: "var(--ok-text)" };
    }
    return { border: "var(--brand-border)", bg: "var(--brand-soft)", color: "var(--brand)" };
  }

  function activitySearchText(row) {
    const details = detailsObject(row.details);
    return [
      row.action,
      row.serviceId,
      serviceNameById(row.serviceId),
      row.userId,
      userNameById(row.userId),
      row.profileId,
      row.title,
      row.url,
      details.modelId,
      details.detectedModelId,
      details.requestedModelId,
      details.reason,
      details.text,
      row.details
    ].join(" ");
  }

  function activityRowsForUi() {
    const q = fold(state.activityUi.query || "");
    const selectedUser = state.activityUi.userId || "__all";
    return [...(state.activity || [])]
      .filter((row) => selectedUser === "__all" || String(row.userId || "") === selectedUser)
      .filter((row) => !q || fold(activitySearchText(row)).includes(q))
      .sort((a, b) => {
        const atB = Date.parse(b.createdAt || b.updatedAt || b.at || "") || 0;
        const atA = Date.parse(a.createdAt || a.updatedAt || a.at || "") || 0;
        return atB - atA;
      })
      .slice(0, 120);
  }

  function activityUsersForSelect() {
    const seen = new Set();
    const rows = [{ id: "__all", name: "Tất cả người dùng" }];
    for (const user of state.users || []) {
      const id = String(user?.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({ id, name: user.name || user.email || id });
    }
    for (const row of state.activity || []) {
      const id = String(row?.userId || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({ id, name: userNameById(id) });
    }
    return rows;
  }

  function activityDetailsHtml(row) {
    const details = detailsObject(row.details);
    const modelId = details.modelId || row.title || "";
    const cost = details.creditCost ?? details.credits ?? "";
    const balance = details.balance ?? "";
    const bits = [
      modelId ? `model: ${modelId}` : "",
      cost !== "" && cost !== null ? `credit: ${cost}` : "",
      balance !== "" && balance !== null ? `số dư: ${balance}` : "",
      details.reason ? `lý do: ${details.reason}` : ""
    ].filter(Boolean);
    const summary = bits.length ? bits.join(" · ") : (row.title || row.url || "");
    const raw = Object.keys(details).length
      ? JSON.stringify(details)
      : String(row.details || "");
    return `
      ${summary ? `<div style="font-size:12.5px;font-weight:700;color:var(--brand);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(summary)}</div>` : ""}
      ${row.url ? `<div style="font-size:12px;color:var(--text-3);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(row.url)}</div>` : ""}
      ${raw ? `<code style="display:block;margin-top:9px;padding:9px 10px;border:1px solid var(--border-soft);border-radius:8px;background:var(--surface);font:12px/1.45 Consolas,ui-monospace,monospace;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(raw.slice(0, 1200))}</code>` : ""}
    `;
  }

  async function refreshActivityDataIfVisible() {
    if (document.hidden || activityDataRefreshRunning || !findActivityScreen()) return;
    activityDataRefreshRunning = true;
    try {
      const result = await getJson("/api/users");
      updateModelStateFromUsersResult(result);
      publishState();
      mountActivityApiPanel({ force: true });
    } catch {
      // Keep the current activity rows if the periodic refresh fails.
    } finally {
      activityDataRefreshRunning = false;
    }
  }

  // Pager footer shared by the ledger + activity panels — same 10/page look as "Nhật ký can thiệp"
  // (pageBtn + ±2 window + "Đang xem X–Y trong Z"); `action` is the data-centrix-server-action name.
  function listPagerHtml(action, total, page, pages, start, shown) {
    const pageBtn = (label, p, disabled, active) => `<button type="button"${disabled ? "" : ` data-centrix-server-action="${action}" data-page="${p}"`}${disabled ? " disabled" : ""} style="min-width:32px;height:32px;border:1px solid ${active ? "var(--brand,#2563eb)" : "var(--border,#e2e8f0)"};border-radius:8px;background:${active ? "var(--brand,#2563eb)" : "var(--surface,#fff)"};color:${active ? "#fff" : "var(--text-2,#64748b)"};font-size:12.5px;font-weight:700;cursor:${disabled ? "default" : "pointer"};opacity:${disabled ? ".4" : "1"};padding:0 9px;">${label}</button>`;
    let lo = Math.max(1, page - 2), hi = Math.min(pages, page + 2);
    if (page <= 3) hi = Math.min(pages, 5);
    if (page >= pages - 2) lo = Math.max(1, pages - 4);
    const nums = []; for (let p = lo; p <= hi; p++) nums.push(pageBtn(String(p), p, false, p === page));
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding-top:4px;border-top:1px solid var(--border-soft,#eef2f7);">`
      + `<div style="font-size:12.5px;color:var(--text-3,#94a3b8);">Đang xem <b style="color:var(--text-2,#64748b);">${total ? start + 1 : 0}–${start + shown}</b> trong <b style="color:var(--text-2,#64748b);">${(Number(total) || 0).toLocaleString("vi-VN")}</b> bản ghi</div>`
      + `<div style="display:flex;align-items:center;gap:6px;">${pageBtn("‹", page - 1, page <= 1, false)}${nums.join("")}${pageBtn("›", page + 1, page >= pages, false)}</div>`
      + `</div>`;
  }

  let activityPage = 1;
  const ACTIVITY_PAGE_SIZE = 10;
  function mountActivityApiPanel(options = {}) {
    const screen = findActivityScreen();
    if (!screen) return false;
    const all = activityRowsForUi();
    const selectedUser = state.activityUi.userId || "__all";
    const users = activityUsersForSelect();
    if (selectedUser !== "__all" && !users.some((user) => user.id === selectedUser)) {
      state.activityUi.userId = "__all";
    }
    const pages = Math.max(1, Math.ceil(all.length / ACTIVITY_PAGE_SIZE));
    const page = Math.min(Math.max(1, activityPage || 1), pages); activityPage = page;
    const start = (page - 1) * ACTIVITY_PAGE_SIZE;
    const rows = all.slice(start, start + ACTIVITY_PAGE_SIZE);
    const key = [
      state.updatedAt,
      state.activity.length,
      page,
      rows[0]?.id || rows[0]?.createdAt || "",
      state.activityUi.userId,
      state.activityUi.query
    ].join("|");
    if (!options.force && screen.dataset.centrixActivityMount === key) return true;
    screen.dataset.centrixActivityMount = key;

    const walletsTotal = (state.creditWallets || []).reduce((sum, wallet) => sum + Number(wallet.balance || 0), 0);
    const userOptions = optionHtml(users, state.activityUi.userId || "__all", (row) => row.name || row.id);
    const rowHtml = rows.length
      ? rows.map((row) => {
        const details = detailsObject(row.details);
        const serviceName = serviceNameById(row.serviceId || details.serviceId);
        const userLabel = userNameById(row.userId);
        const wallet = walletForUser(row.userId);
        const tone = activityTone(row.action);
        return `
          <div style="border:1px solid ${tone.border};background:${tone.bg};border-radius:13px;padding:14px 16px;display:flex;flex-direction:column;gap:3px;min-width:0;">
            <div style="display:flex;align-items:flex-start;gap:12px;min-width:0;">
              <div style="width:34px;height:34px;border-radius:10px;background:var(--surface);border:1px solid ${tone.border};display:flex;align-items:center;justify-content:center;color:${tone.color};font-size:14px;font-weight:900;flex-shrink:0;">${escapeHtml(serviceName.slice(0, 1).toUpperCase())}</div>
              <div style="min-width:0;flex:1;">
                <div style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap;">
                  <strong style="font-size:14px;font-weight:900;color:var(--text);">${escapeHtml(`${activityActionLabel(row.action)} - ${serviceName}`)}</strong>
                  <span style="font-size:12px;color:var(--text-3);">${escapeHtml(formatActivityTime(row.createdAt || row.updatedAt || row.at))}</span>
                  <span style="font-size:12px;color:var(--text-3);">${escapeHtml(userLabel)} · hồ sơ ${escapeHtml(row.profileId || "default")}</span>
                  ${wallet ? `<span style="font-size:12px;font-weight:800;color:var(--ok-text);">số dư ${Number(wallet.balance || 0).toLocaleString("vi-VN")} cr</span>` : ""}
                </div>
                ${activityDetailsHtml(row)}
              </div>
            </div>
          </div>`;
      }).join("")
      : `<div style="text-align:center;padding:34px 18px;border:1px dashed var(--border);border-radius:12px;color:var(--text-3);font-size:13px;font-weight:700;background:var(--surface-2);">Chưa có hoạt động phù hợp với bộ lọc hiện tại.</div>`;

    screen.innerHTML = `
      <div data-centrix-activity-root="1" style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="padding:24px 26px;border-bottom:1px solid var(--border-soft);display:flex;align-items:flex-start;justify-content:space-between;gap:18px;">
          <div style="min-width:0;">
            <div style="font-size:21px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Lịch sử hoạt động từ API</div>
            <div style="font-size:13.5px;color:var(--text-2);margin-top:5px;">Đọc trực tiếp từ /api/users: model/credit, mở dịch vụ, chuyển trang, đồng bộ hồ sơ và localStorage.</div>
          </div>
          <button type="button" data-centrix-activity-action="refresh" style="height:38px;border:1px solid var(--field-border);border-radius:9px;background:var(--surface);color:var(--text);font-weight:800;padding:0 14px;cursor:pointer;white-space:nowrap;">Làm mới API</button>
        </div>
        <div style="padding:20px 26px 22px;display:flex;flex-direction:column;gap:16px;">
          <div style="display:grid;grid-template-columns:minmax(190px,260px) 1fr auto auto;gap:12px;align-items:end;">
            <label style="display:flex;flex-direction:column;gap:7px;min-width:0;"><span style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;">Người dùng</span><select id="centrix-activity-user-select" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font-weight:600;padding:0 12px;">${userOptions}</select></label>
            <label style="display:flex;flex-direction:column;gap:7px;min-width:0;"><span style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;">Tìm kiếm</span><input id="centrix-activity-search" value="${escapeHtml(state.activityUi.query)}" placeholder="Tìm sự kiện, model, service, URL..." style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font-weight:600;padding:0 13px;min-width:0;"></label>
            <div style="min-width:110px;padding:10px 12px;border:1px solid var(--border-soft);border-radius:10px;background:var(--surface-2);"><div style="font-size:11px;color:var(--label);font-weight:800;text-transform:uppercase;">Hiển thị</div><strong style="display:block;margin-top:2px;font-size:15px;color:var(--text);">${all.length}/${state.activity.length}</strong></div>
            <div style="min-width:130px;padding:10px 12px;border:1px solid var(--border-soft);border-radius:10px;background:var(--surface-2);"><div style="font-size:11px;color:var(--label);font-weight:800;text-transform:uppercase;">Tổng số dư</div><strong style="display:block;margin-top:2px;font-size:15px;color:var(--ok-text);">${walletsTotal.toLocaleString("vi-VN")} cr</strong></div>
          </div>
          <div class="cx-scroll" style="display:flex;flex-direction:column;gap:12px;max-height:calc(100vh - 310px);overflow:auto;padding-right:4px;">${rowHtml}</div>
          ${listPagerHtml("activity-page", all.length, page, pages, start, rows.length)}
        </div>
      </div>`;
    return true;
  }

  // ── Sổ giao dịch (credit ledger) ─────────────────────────────────────────────────────
  // The design's ledger screen shipped a generated demo (txPool/buildTx). Render the REAL credit
  // transactions (state.creditTransactions: debit when a model is used, topup, adjust...) so App
  // User credit usage shows up as +/- entries, same data the gate writes.
  function findLedgerScreen() {
    return visibleScreens().find((screen) => fold(screen.getAttribute("data-screen-label")).includes("so giao dich")) || null;
  }

  function ledgerTxLabel(tx) {
    const details = detailsObject(tx.details);
    const model = tx.modelId || details.modelId || "";
    const service = serviceNameById(tx.serviceId || details.serviceId);
    const type = String(tx.type || "");
    if (type === "debit") return `Dùng ${model || "model"}${service ? " · " + service : ""}`;
    if (type === "topup") return "Nạp credit";
    if (type === "blocked") return `Chặn ${model || "model"}${service ? " · " + service : ""}`;
    if (type === "adjust") return Number(tx.amountDelta) >= 0 ? "Cộng credit (điều chỉnh)" : "Trừ credit (điều chỉnh)";
    return tx.reason || "Giao dịch";
  }

  function ledgerRowsForUi() {
    const q = fold(state.ledgerUi.query || "");
    const selectedUser = state.ledgerUi.userId || "__all";
    return [...(state.creditTransactions || [])]
      .filter((row) => selectedUser === "__all" || String(row.userId || "") === selectedUser)
      .filter((row) => !q || fold(`${ledgerTxLabel(row)} ${row.userId || ""} ${row.modelId || ""} ${row.serviceId || ""} ${row.reason || ""}`).includes(q))
      .sort((a, b) => (Date.parse(b.createdAt || b.at || "") || 0) - (Date.parse(a.createdAt || a.at || "") || 0));
  }

  let ledgerPage = 1;
  const LEDGER_PAGE_SIZE = 10;
  function mountLedgerApiPanel(options = {}) {
    const screen = findLedgerScreen();
    if (!screen) return false;
    const all = ledgerRowsForUi();
    const users = activityUsersForSelect();
    if (state.ledgerUi.userId !== "__all" && !users.some((user) => user.id === state.ledgerUi.userId)) {
      state.ledgerUi.userId = "__all";
    }
    const pages = Math.max(1, Math.ceil(all.length / LEDGER_PAGE_SIZE));
    const page = Math.min(Math.max(1, ledgerPage || 1), pages); ledgerPage = page;
    const start = (page - 1) * LEDGER_PAGE_SIZE;
    const rows = all.slice(start, start + LEDGER_PAGE_SIZE);
    const key = [
      state.updatedAt,
      (state.creditTransactions || []).length,
      page,
      rows[0]?.id || rows[0]?.txId || "",
      state.ledgerUi.userId,
      state.ledgerUi.query
    ].join("|");
    if (!options.force && screen.dataset.centrixLedgerMount === key) return true;
    screen.dataset.centrixLedgerMount = key;

    const userOptions = optionHtml(users, state.ledgerUi.userId || "__all", (row) => row.name || row.id);
    const totalIn = all.reduce((sum, tx) => sum + Math.max(0, Number(tx.amountDelta || 0)), 0);
    const totalOut = all.reduce((sum, tx) => sum + Math.max(0, -Number(tx.amountDelta || 0)), 0);
    const rowHtml = rows.length
      ? rows.map((tx) => {
        const amt = Number(tx.amountDelta || 0);
        const positive = amt >= 0;
        const color = positive ? "var(--ok-text)" : "var(--brand)";
        const sign = positive ? "+" : "−";
        const userLabel = userNameById(tx.userId);
        const details = detailsObject(tx.details);
        const bal = tx.balanceAfter ?? details.balance;
        const balText = (bal !== undefined && bal !== null && bal !== "") ? ` · số dư ${Number(bal).toLocaleString("vi-VN")} cr` : "";
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid var(--border-soft);border-left:4px solid ${color};border-radius:12px;background:var(--surface-2);padding:13px 16px;min-width:0;">
            <div style="min-width:0;">
              <div style="font-size:14px;font-weight:800;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(ledgerTxLabel(tx))}</div>
              <div style="font-size:12px;color:var(--text-3);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(userLabel)} · ${escapeHtml(formatActivityTime(tx.createdAt || tx.at))}${escapeHtml(balText)}</div>
            </div>
            <strong style="font-size:15px;font-weight:900;color:${color};white-space:nowrap;flex-shrink:0;">${sign}${Math.abs(amt).toLocaleString("vi-VN")} cr</strong>
          </div>`;
      }).join("")
      : `<div style="text-align:center;padding:34px 18px;border:1px dashed var(--border);border-radius:12px;color:var(--text-3);font-size:13px;font-weight:700;background:var(--surface-2);">Chưa có giao dịch credit nào khớp bộ lọc.</div>`;

    screen.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="padding:24px 26px;border-bottom:1px solid var(--border-soft);">
          <div style="font-size:21px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Sổ giao dịch credit</div>
          <div style="font-size:13.5px;color:var(--text-2);margin-top:5px;">Cộng/trừ credit thật của App User — đọc trực tiếp từ /api/users (trừ khi dùng model, nạp, điều chỉnh).</div>
        </div>
        <div style="padding:20px 26px 22px;display:flex;flex-direction:column;gap:16px;">
          <div style="display:grid;grid-template-columns:minmax(190px,260px) 1fr auto auto;gap:12px;align-items:end;">
            <label style="display:flex;flex-direction:column;gap:7px;min-width:0;"><span style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;">Người dùng</span><select id="centrix-ledger-user-select" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font-weight:600;padding:0 12px;">${userOptions}</select></label>
            <label style="display:flex;flex-direction:column;gap:7px;min-width:0;"><span style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;">Tìm kiếm</span><input id="centrix-ledger-search" value="${escapeHtml(state.ledgerUi.query)}" placeholder="Tìm model, service, user, lý do..." style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font-weight:600;padding:0 13px;min-width:0;"></label>
            <div style="min-width:110px;padding:10px 12px;border:1px solid var(--border-soft);border-radius:10px;background:var(--surface-2);"><div style="font-size:11px;color:var(--label);font-weight:800;text-transform:uppercase;">Hiển thị</div><strong style="display:block;margin-top:2px;font-size:15px;color:var(--text);">${all.length}/${(state.creditTransactions || []).length}</strong></div>
            <div style="min-width:150px;padding:10px 12px;border:1px solid var(--border-soft);border-radius:10px;background:var(--surface-2);"><div style="font-size:11px;color:var(--label);font-weight:800;text-transform:uppercase;">Nạp / Dùng</div><strong style="display:block;margin-top:2px;font-size:14px;"><span style="color:var(--ok-text);">+${totalIn.toLocaleString("vi-VN")}</span> / <span style="color:var(--brand);">−${totalOut.toLocaleString("vi-VN")}</span></strong></div>
          </div>
          <div class="cx-scroll" style="display:flex;flex-direction:column;gap:10px;max-height:calc(100vh - 310px);overflow:auto;padding-right:4px;">${rowHtml}</div>
          ${listPagerHtml("ledger-page", all.length, page, pages, start, rows.length)}
        </div>
      </div>`;
    return true;
  }

  function scheduleActivityApiPanel() {
    registerBodyTick(mountActivityApiPanel);
    registerBodyTick(mountLedgerApiPanel);
    registerBodyTick(maintainPoolUi);
    for (const delayMs of [300, 900, 1800, 3200]) { setTimeout(mountActivityApiPanel, delayMs); setTimeout(mountLedgerApiPanel, delayMs); setTimeout(maintainPoolUi, delayMs); }
    setTimeout(refreshPoolIfVisible, 600);
    if (!scheduleActivityApiPanel._poolTimer) {
      scheduleActivityApiPanel._poolTimer = setInterval(refreshPoolIfVisible, 8000);
      window.addEventListener("resize", () => { if (poolScreenActive) { const ov = document.getElementById("cx-pool-screen"); if (ov) positionPoolOverlay(ov); } });
    }
  }

  // ── "PHÂN BỔ PROFILE" — ai đang dùng profile(slot) nào của dịch vụ nào (mục riêng + overlay body-level) ──
  // GET /api/admin/pool → { pool:{svc:[{profileId,activeUsers,capacity}]}, assignments:[{serviceId,userId,profileId,slot,assignedAt,idleSec}] }.
  // "Đang dùng" = có gán trong TTL 30' (làm mới mỗi khi App User kéo profile) — KHÔNG phải tab-đang-mở real-time.
  let poolTab = "services"; // "services" | "users" | "profiles"
  let poolWindowMin = 30; // khoảng "đang dùng" (phút): 30 | 60 | 360 | 1440 — chọn được trên màn
  // BỘ LỌC: date (YYYY-MM-DD, đè lên khoảng-thời-gian → xem đúng 1 ngày) + name (tên/email user) + svc (1 dịch vụ)
  const poolFilter = { date: "", name: "", svc: "" };
  function poolDateRange() {
    if (!poolFilter.date) return null;
    const start = new Date(poolFilter.date + "T00:00:00").getTime();
    return Number.isFinite(start) ? [start, start + 86400000] : null;
  }
  function poolUserMatch(uid) {
    const q = fold(poolFilter.name || "");
    if (!q) return true;
    const u = (state.users || []).find((x) => x.id === uid) || {};
    return fold((u.name || "") + " " + (u.email || "") + " " + uid).includes(q);
  }
  const poolExpanded = new Set(); // service ids đang mở "xem chi tiết"
  const cxPool = { pool: {}, assignments: [], recentAssignments: [], profiles: [], at: 0 };
  // "Phân bổ profile" = MỘT MỤC RIÊNG (không mượn màn có sẵn — màn "Phân tích" là loại "overview" KHÔNG có
  // data-screen-label để bám, đã xác minh qua DevTools: visibleLabels=[]). Ta CHÈN nav row riêng vào sidebar +
  // 1 overlay riêng phủ vùng nội dung, GẮN VÀO document.body → nằm NGOÀI cây React của SPA nên không bị vẽ đè.
  // Bấm nav của ta → hiện overlay; bấm bất kỳ nav SPA (data-cx-view) khác → ẩn overlay để SPA hiện màn của nó.
  let poolScreenActive = false;
  let _poolCloseWired = false;
  // Cột sidebar = tổ tiên của nav row mà CHA của nó rộng > nửa màn hình (hàng app). Dùng để lấy geometry vùng nội dung.
  function poolSidebarEl() {
    const nav = document.querySelector("[data-cx-view]");
    if (!nav) return null;
    let el = nav;
    for (let i = 0; i < 10 && el.parentElement; i += 1) {
      if (el.parentElement.getBoundingClientRect().width > window.innerWidth * 0.5) return el;
      el = el.parentElement;
    }
    return el;
  }
  function positionPoolOverlay(ov) {
    const side = poolSidebarEl();
    let left = 248, top = 0;
    if (side) { const r = side.getBoundingClientRect(); left = Math.round(r.right); top = Math.round(Math.max(0, r.top)); }
    ov.style.left = left + "px"; ov.style.top = top + "px";
    ov.style.width = Math.max(0, window.innerWidth - left) + "px";
    ov.style.height = Math.max(0, window.innerHeight - top) + "px";
    const bg = getComputedStyle(document.body).backgroundColor; // khớp nền theo theme sáng/tối
    ov.style.background = (bg && bg !== "rgba(0, 0, 0, 0)") ? bg : "var(--surface,#0f172a)";
  }
  function ensurePoolOverlay() {
    let ov = document.getElementById("cx-pool-screen");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "cx-pool-screen";
      ov.style.cssText = "position:fixed;z-index:90;overflow:auto;display:none;padding:26px 30px 44px;box-sizing:border-box;";
      (document.body || document.documentElement).appendChild(ov);
    }
    return ov;
  }
  // Nút "Phân bổ profile" = row THẬT trong sidebar, nhóm QUẢN LÝ (sau "An toàn") — cuộn theo menu, không đè nút
  // khác. React có thể dời/xoá node lạ trong cây nó quản → chống bằng 2 lớp: (1) click qua DELEGATION toàn cục
  // (data-centrix-server-action="pool-nav", KHÔNG listener trên node — node bị thay vẫn bấm được), (2) bodyTick
  // (maintainPoolUi) tự đặt lại đúng vị trí/ tạo lại nếu bị dời/xoá. KHÔNG position:fixed nữa (bản cũ đè menu).
  function ensurePoolNav() {
    // anchor = nav row cuối nhóm QUẢN LÝ, ưu tiên key ASCII ổn định do SPA stamp
    const anchor = document.querySelector('[data-cx-view="safety"]') || document.querySelector('[data-cx-view="services"]')
      || document.querySelector('[data-cx-view="pricing"]') || document.querySelector('[data-cx-view="users"]');
    let row = document.getElementById("cx-pool-nav");
    if (!anchor || !anchor.parentElement) { if (row) row.style.display = "none"; return; }
    if (!row || !row.isConnected) {
      if (row) row.remove();
      row = document.createElement("div");
      row.id = "cx-pool-nav";
      row.setAttribute("data-centrix-server-action", "pool-nav"); // click xử lý ở delegator toàn cục
      // icon = ô vuông viền bo giống các mục menu khác (không dùng emoji cho đồng bộ)
      row.innerHTML = '<span data-cx-pool-ico style="flex-shrink:0;width:16px;height:16px;border:2px solid currentColor;border-radius:5px;opacity:.85;box-sizing:border-box;"></span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Phân bổ profile</span>';
    }
    // đúng chỗ = ngay sau anchor; React dời đi đâu thì kéo về (insertBefore với node đã gắn = move, không nhân bản)
    if (row.previousElementSibling !== anchor || row.parentElement !== anchor.parentElement) {
      anchor.parentElement.insertBefore(row, anchor.nextSibling);
    }
    const active = poolScreenActive;
    row.setAttribute("data-active", active ? "1" : "0");
    row.style.cssText = "display:flex;align-items:center;gap:12px;padding:9px 13px;margin:2px 0;border-radius:10px;cursor:pointer;user-select:none;box-sizing:border-box;"
      + "font:600 14px 'Segoe UI',system-ui,sans-serif;transition:background .12s;"
      + "color:" + (active ? "#fff" : "var(--text-2,#cbd5e1)") + ";"
      + "background:" + (active ? "var(--brand,#2563eb)" : "transparent") + ";";
    if (!document.getElementById("cx-pool-nav-style")) {
      const st = document.createElement("style");
      st.id = "cx-pool-nav-style";
      st.textContent = '#cx-pool-nav[data-active="0"]:hover{background:var(--surface-2,rgba(148,163,184,.14)) !important;}';
      document.head.appendChild(st);
    }
  }
  // Khi màn Phân bổ đang mở, nav SPA vẫn giữ pill active của trang dưới (vd "An toàn") → 2 nút cùng sáng.
  // DIM: tắt nền pill active của mọi [data-cx-view] (chỉ phần tử BẢN RỘNG cỡ row — không đụng ô icon nhỏ),
  // nhớ trạng thái bằng attribute để KHÔI PHỤC nguyên trạng khi đóng. Chạy lại mỗi tick (React re-render).
  function dimSpaActiveNav() {
    // CSS chốt chặn: áp NGAY khi React vẽ lại (trước cả tick JS) — pill active thường là chính row [data-cx-view]
    if (!document.getElementById("cx-pool-dim-style")) {
      const st = document.createElement("style");
      st.id = "cx-pool-dim-style";
      st.textContent = 'body[data-cx-pool-open="1"] [data-cx-view]{background:transparent !important;box-shadow:none !important;background-image:none !important;}';
      document.head.appendChild(st);
    }
    if (document.body) document.body.setAttribute("data-cx-pool-open", "1");
    // JS quét sâu: pill có thể là descendant BẤT KỲ cấp + nền có thể là GRADIENT (background-image, không phải
    // backgroundColor — đây là chỗ bản trước bỏ lọt). Chỉ dim phần tử BẢN RỘNG cỡ row (bỏ icon/badge nhỏ).
    for (const navRow of document.querySelectorAll("[data-cx-view]")) {
      const w = navRow.getBoundingClientRect().width || 0;
      if (!w) continue;
      for (const el of [navRow, ...navRow.querySelectorAll("*")]) {
        if ((el.getBoundingClientRect().width || 0) < w * 0.6) continue;
        const cs = getComputedStyle(el);
        const hasBg = (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent")
          || (cs.backgroundImage && cs.backgroundImage !== "none");
        if (!hasBg) continue;
        if (!el.hasAttribute("data-cx-pool-dimmed")) el.setAttribute("data-cx-pool-dimmed", "1");
        el.style.setProperty("background", "transparent", "important"); // shorthand → xoá cả gradient
        el.style.setProperty("box-shadow", "none", "important");
      }
    }
  }
  function undimSpaActiveNav() {
    if (document.body) document.body.removeAttribute("data-cx-pool-open"); // gỡ CSS chốt chặn
    for (const el of document.querySelectorAll("[data-cx-pool-dimmed]")) {
      el.style.removeProperty("background");
      el.style.removeProperty("box-shadow");
      el.removeAttribute("data-cx-pool-dimmed");
    }
  }
  function wirePoolClose() {
    if (_poolCloseWired) return; _poolCloseWired = true;
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("#cx-pool-nav") || t.closest("#cx-pool-screen")) return; // nav/panel của ta → giữ mở
      if (poolScreenActive && t.closest("[data-cx-view]")) setPoolScreenActive(false); // bấm nav SPA khác → đóng
    }, true);
  }
  function setPoolScreenActive(on) {
    poolScreenActive = !!on;
    const ov = ensurePoolOverlay();
    if (poolScreenActive) { positionPoolOverlay(ov); ov.style.display = "block"; renderPoolOverlay(true); refreshPoolIfVisible({ force: true }); dimSpaActiveNav(); }
    else { ov.style.display = "none"; undimSpaActiveNav(); }
    ensurePoolNav();
  }
  // Chạy mỗi bodyTick: giữ nav được chèn + (nếu đang mở) giữ overlay đúng vị trí + vẽ lại theo dữ liệu mới.
  function maintainPoolUi() {
    wirePoolClose();
    ensurePoolNav();
    if (poolScreenActive) {
      const ov = ensurePoolOverlay();
      positionPoolOverlay(ov);
      ov.style.display = "block";
      dimSpaActiveNav(); // React re-render có thể vẽ lại pill active → dập lại mỗi tick khi màn đang mở
      if (Date.now() - (cxPool.at || 0) > 6000) Promise.resolve().then(() => refreshPoolIfVisible());
      renderPoolOverlay(false);
    }
  }
  function poolIdle(sec) { sec = Number(sec) || 0; if (sec < 60) return sec + "s"; if (sec < 3600) return Math.round(sec / 60) + " phút"; return Math.round(sec / 3600) + " giờ"; }
  function poolHm(iso) { try { return new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function poolHmMs(ms) { try { return new Date(ms).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
  function poolDate(iso) { if (!iso) return ""; try { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso).slice(0, 10) : d.toLocaleDateString("vi-VN"); } catch (e) { return String(iso).slice(0, 10); } }
  function poolServiceLabel(svc) { return serviceNameById(svc) || svc; }
  function poolActiveWindowMs() { return Math.max(1, Number(poolWindowMin) || 30) * 60 * 1000; } // theo lựa chọn trên màn
  function poolWindowLabel() { return poolWindowMin < 60 ? poolWindowMin + " phút" : (poolWindowMin / 60) + " giờ"; }
  // AI ĐANG DÙNG DỊCH VỤ NÀO — GỘP 3 nguồn thật: (1) debit (khớp "Sổ giao dịch"), (2) gán pool còn sống,
  // (3) gán pool ĐÃ hết TTL trong 24h (recentAssignments — phiên dài: tab GPT Pro mở nhiều giờ nhưng chỉ pull
  // 1 lần đầu). Debit của dịch vụ CHUNG DOMAIN bị ghi nhầm (tab GPT-5.5 Pro debit ra serviceId="chatgpt" vì
  // model-detection theo domain chatgpt.com) → QUY LẠI: nếu user có gán pool (sống/recent) cho đúng 1 dịch vụ
  // khác chung domain và KHÔNG có gán cho dịch vụ gốc → debit thuộc dịch vụ pool đó.
  function poolUserAssignIndex() { // userId → Map(serviceId → {slot, at, expired})
    const idx = new Map();
    const add = (a, expired) => {
      const at = Date.parse(a.assignedAt || "") || 0;
      let m = idx.get(a.userId); if (!m) { m = new Map(); idx.set(a.userId, m); }
      const cur = m.get(a.serviceId);
      if (!cur || (cur.expired && !expired) || (cur.expired === expired && at > cur.at)) m.set(a.serviceId, { slot: a.slot, at, expired });
    };
    for (const a of (cxPool.recentAssignments || [])) add(a, true);
    for (const a of (cxPool.assignments || [])) add(a, false); // live thắng recent
    return idx;
  }
  function poolSharedDomainMap() { // serviceId → [serviceId khác chung registrable cookieDomain]
    const doms = (s) => (s.cookieDomains || []).map((d) => String(d).toLowerCase().split(".").slice(-2).join("."));
    const list = (state.services || []).filter((s) => (s.cookieDomains || []).length);
    const out = new Map();
    for (const s of list) {
      const mine = new Set(doms(s));
      out.set(s.id, list.filter((t) => t.id !== s.id && doms(t).some((d) => mine.has(d))).map((t) => t.id));
    }
    return out;
  }
  function poolActivityByService() {
    const now = Date.now();
    const map = new Map();
    const range = poolDateRange(); // lọc theo NGÀY cụ thể → đè lên khoảng-thời-gian
    const inTime = (at) => range ? (at >= range[0] && at < range[1]) : (now - at < poolActiveWindowMs());
    const put = (svc, uid, at) => {
      if (!svc || !uid || !at) return;
      let um = map.get(svc); if (!um) { um = new Map(); map.set(svc, um); }
      if (at > (um.get(uid) || 0)) um.set(uid, at);
    };
    const poolKeys = cxPool.pool ? new Set(Object.keys(cxPool.pool)) : null;
    const assignIdx = poolUserAssignIndex();
    const shared = poolSharedDomainMap();
    for (const t of (state.creditTransactions || [])) {
      if (t.type !== "debit") continue; // chỉ lần DÙNG model (bỏ topup/adjust/plan)
      let svc = t.serviceId || (t.details && t.details.serviceId);
      if (!svc || svc === "admin" || svc === "plan") continue;
      if (poolKeys && poolKeys.size && !poolKeys.has(svc)) continue; // chỉ dịch vụ thật (có trong pool config)
      const at = Date.parse(t.createdAt || t.at || t.ts || "") || 0;
      if (!at || !inTime(at)) continue;
      const ua = assignIdx.get(t.userId);
      if (ua && !ua.has(svc)) { // user KHÔNG gán pool cho svc gốc → xem có đúng 1 dịch vụ chung domain đã gán?
        const cands = (shared.get(svc) || []).filter((sid) => ua.has(sid));
        if (cands.length === 1) svc = cands[0]; // quy debit về dịch vụ pool thật (vd chatgpt → notebooklm)
      }
      put(svc, t.userId, at);
    }
    // Gán pool sống = "đang dùng" (khi lọc theo ngày thì chỉ tính nếu gán rơi vào ngày đó); recent theo cùng luật.
    for (const a of (cxPool.assignments || [])) {
      const at = Date.parse(a.assignedAt || "") || (now - (Number(a.idleSec) || 0) * 1000);
      if (range ? inTime(at) : true) put(a.serviceId, a.userId, at);
    }
    for (const a of (cxPool.recentAssignments || [])) {
      const at = Date.parse(a.assignedAt || "") || 0;
      if (at && inTime(at)) put(a.serviceId, a.userId, at);
    }
    return map;
  }
  function poolAssignSlotMap() { // "svc|userId" → slot (user từng đi qua pool — live hoặc lịch sử 24h)
    const m = new Map();
    for (const a of (cxPool.recentAssignments || [])) m.set(a.serviceId + "|" + a.userId, a.slot);
    for (const a of (cxPool.assignments || [])) m.set(a.serviceId + "|" + a.userId, a.slot); // live đè recent
    return m;
  }
  // Bảng chi tiết người ĐANG DÙNG 1 dịch vụ: ai · slot(qua pool)/login riêng · tổng credit · ngày hết hạn · dùng lúc.
  function renderServiceUserDetail(svc, usersMap, assignSlot) {
    const list = Array.from(usersMap.entries()).map(([uid, lastAt]) => ({ uid, lastAt })).sort((a, b) => b.lastAt - a.lastAt);
    if (!list.length) return `<div style="padding:14px 16px;color:var(--text-3);font-size:12.5px;">Chưa có ai dùng dịch vụ này trong ${escapeHtml(poolWindowLabel())} gần đây.</div>`;
    const cols = "1.5fr 96px 1fr 1fr 78px";
    const head = `<div style="display:grid;grid-template-columns:${cols};gap:10px;padding:11px 16px 8px;font:700 10.5px 'Segoe UI',system-ui,sans-serif;letter-spacing:.03em;text-transform:uppercase;color:var(--label);border-bottom:1px solid var(--border-soft);"><span>Người dùng</span><span>Slot</span><span>Tổng credit</span><span>Ngày hết hạn</span><span>Dùng lúc</span></div>`;
    const rows = list.map(({ uid, lastAt }) => {
      const u = (state.users || []).find((x) => x.id === uid) || {};
      const w = walletForUser(uid);
      const credit = (w && w.balance != null) ? Number(w.balance) : (u.credit != null ? Number(u.credit) : null);
      const exp = u.planExpiresAt || u.expiresAt || "";
      const slot = assignSlot.get(svc + "|" + uid);
      const slotHtml = slot != null
        ? `<span style="font-size:12px;font-weight:800;color:var(--brand);">Slot #${escapeHtml(String(slot))}</span>`
        : `<span style="font-size:11px;font-weight:600;color:var(--text-3);">login riêng</span>`;
      return `<div style="display:grid;grid-template-columns:${cols};gap:10px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border-soft);">
        <span style="font-size:12.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(userNameById(uid) || uid)}</span>
        ${slotHtml}
        <span style="font-size:12.5px;font-weight:700;color:var(--ok-text,#16a34a);">${credit != null ? escapeHtml(credit.toLocaleString("vi-VN")) + " cr" : "—"}</span>
        <span style="font-size:12px;color:var(--text-2);">${exp ? escapeHtml(poolDate(exp)) : "—"}</span>
        <span style="font-size:12px;color:var(--text-3);">${escapeHtml(poolHmMs(lastAt))}</span></div>`;
    }).join("");
    return `<div style="background:var(--surface-2);border-top:1px solid var(--border);">${head}${rows}</div>`;
  }
  let _poolFetching = false, _poolLastFetch = 0;
  async function refreshPoolIfVisible(opts) {
    // Nạp dữ liệu pool khi ĐANG MỞ màn "Phân bổ profile" HOẶC ở màn "Người dùng" (drawer hiện slot của user).
    if (document.hidden || _poolFetching || !(poolScreenActive || findUsersScreen())) return;
    if (!(opts && opts.force) && Date.now() - _poolLastFetch < 5000) return; // throttle: gọi được từ mọi nơi
    _poolFetching = true;
    try {
      const r = await getJson("/api/admin/pool");
      if (r && r.ok) {
        cxPool.pool = r.pool || {}; cxPool.assignments = r.assignments || []; cxPool.recentAssignments = r.recentAssignments || []; cxPool.profiles = r.profiles || []; cxPool.at = Date.now();
        renderPoolOverlay(true);
        // Ở màn Người dùng, vẽ lại drawer để "Đang dùng profile" không kẹt empty-state khi cxPool vừa cold lúc mở.
        if (findUsersScreen()) { try { ensureAccountLockButton(); } catch (e) { /* best-effort */ } }
      }
    } catch (e) { /* im lặng */ } finally { _poolFetching = false; _poolLastFetch = Date.now(); }
  }
  function renderPoolByService() {
    const activity = poolActivityByService();
    const poolMap = cxPool.pool || {};
    const assignSlot = poolAssignSlotMap();
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nameFilterOn = !!fold(poolFilter.name || "");
    const allSvc = Array.from(new Set([...Object.keys(poolMap), ...activity.keys()]))
      .filter((svc) => !poolFilter.svc || svc === poolFilter.svc) // lọc theo dịch vụ
      .sort((a, b) => ((activity.get(b) || new Map()).size - (activity.get(a) || new Map()).size) || a.localeCompare(b));
    const cards = allSvc.map((svc) => {
      // lọc theo tên user (nếu có)
      const users = new Map(Array.from((activity.get(svc) || new Map()).entries()).filter(([uid]) => poolUserMatch(uid)));
      if (nameFilterOn && !users.size) return ""; // đang tìm tên → ẩn dịch vụ không có ai khớp
      const profiles = poolMap[svc] || [];
      const slotRe = new RegExp("^" + esc(svc) + "-(\\d+)$");
      const slotCount = profiles.filter((p) => slotRe.test(String(p.profileId || ""))).length;
      const n = users.size;
      if (!n && !slotCount) return ""; // ẩn dịch vụ không có ai dùng + không có slot pool
      const pooledNow = Array.from(users.keys()).filter((uid) => assignSlot.has(svc + "|" + uid)).length;
      const expanded = poolExpanded.has(svc);
      const detail = expanded ? renderServiceUserDetail(svc, users, assignSlot) : "";
      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:12px;">
        <div data-centrix-server-action="pool-detail" data-svc="${escapeHtml(svc)}" title="Bấm để xem/ẩn danh sách người đang dùng" style="display:flex;align-items:center;gap:11px;padding:13px 15px;background:var(--surface-2);cursor:pointer;user-select:none;">
          <span style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--brand),var(--brand-strong));color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0;">${escapeHtml((poolServiceLabel(svc)[0] || "?").toUpperCase())}</span>
          <span style="font-size:14.5px;font-weight:800;color:var(--text);">${escapeHtml(poolServiceLabel(svc))}</span>
          <span style="margin-left:auto;display:flex;align-items:center;gap:14px;white-space:nowrap;">
            <span style="font-size:13px;color:var(--text-2);"><strong style="color:${n ? "var(--brand)" : "var(--text-3)"};font-size:15px;">${n}</strong> người đang dùng</span>
            <span style="font-size:11px;color:var(--text-3);">${slotCount} slot pool · ${pooledNow} qua pool</span>
            <span style="font-size:11.5px;font-weight:700;color:var(--brand);">${expanded ? "Ẩn ▴" : "Chi tiết ▾"}</span></span></div>${detail}</div>`;
    }).filter(Boolean).join("");
    return cards || `<div style="text-align:center;padding:44px;color:var(--text-3);">Chưa có ai dùng dịch vụ nào trong ${escapeHtml(poolWindowLabel())} gần đây.</div>`;
  }
  function renderPoolByUser() {
    const activity = poolActivityByService();
    const assignSlot = poolAssignSlotMap();
    const rows = [];
    for (const [svc, um] of activity) {
      if (poolFilter.svc && svc !== poolFilter.svc) continue; // lọc dịch vụ
      for (const [uid, lastAt] of um) { if (poolUserMatch(uid)) rows.push({ svc, uid, lastAt }); } // lọc tên
    }
    rows.sort((a, b) => b.lastAt - a.lastAt);
    if (!rows.length) return `<div style="text-align:center;padding:44px;color:var(--text-3);">Chưa có ai dùng dịch vụ nào trong ${escapeHtml(poolWindowLabel())} gần đây.</div>`;
    const cols = "1.4fr 1fr 92px 1fr 1fr 74px";
    const head = `<div style="display:grid;grid-template-columns:${cols};gap:10px;padding:0 14px 10px;border-bottom:1px solid var(--border-soft);font:700 10.5px 'Segoe UI',system-ui,sans-serif;letter-spacing:.03em;color:var(--label);text-transform:uppercase;"><span>Người dùng</span><span>Dịch vụ</span><span>Slot</span><span>Tổng credit</span><span>Ngày hết hạn</span><span>Dùng lúc</span></div>`;
    const body = rows.map(({ svc, uid, lastAt }) => {
      const u = (state.users || []).find((x) => x.id === uid) || {};
      const w = walletForUser(uid);
      const credit = (w && w.balance != null) ? Number(w.balance) : (u.credit != null ? Number(u.credit) : null);
      const exp = u.planExpiresAt || u.expiresAt || "";
      const slot = assignSlot.get(svc + "|" + uid);
      return `<div style="display:grid;grid-template-columns:${cols};gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border-soft);">
        <span style="font-size:12.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(userNameById(uid) || uid)}</span>
        <span style="font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(poolServiceLabel(svc))}</span>
        <span style="font-size:12px;font-weight:${slot != null ? "800" : "600"};color:${slot != null ? "var(--brand)" : "var(--text-3)"};">${slot != null ? "#" + escapeHtml(String(slot)) : "login riêng"}</span>
        <span style="font-size:12px;font-weight:700;color:var(--ok-text,#16a34a);">${credit != null ? escapeHtml(credit.toLocaleString("vi-VN")) + " cr" : "—"}</span>
        <span style="font-size:12px;color:var(--text-2);">${exp ? escapeHtml(poolDate(exp)) : "—"}</span>
        <span style="font-size:12px;color:var(--text-3);">${escapeHtml(poolHmMs(lastAt))}</span></div>`;
    }).join("");
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 12px 6px;">${head}${body}</div>`;
  }
  // Tab "Profile đã đẩy": mọi profile App Manager đã push vào pool — đẩy lúc nào, bao nhiêu lần, phục vụ dịch
  // vụ nào, bao nhiêu user đang được gán vào. Dữ liệu cxPool.profiles (backend poolProfiles, không giải mã blob).
  function poolSize(bytes) { bytes = Number(bytes) || 0; if (bytes < 1024) return bytes + " B"; if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB"; return (bytes / 1048576).toFixed(1) + " MB"; }
  function poolDateTime(iso) { if (!iso) return "—"; try { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso).slice(0, 16) : d.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch (e) { return String(iso).slice(0, 16); } }
  // Kiểu App Manager: DANH SÁCH DỊCH VỤ → bấm vào 1 dịch vụ mở ra các profile/slot đã đẩy của dịch vụ đó.
  const poolProfExpanded = new Set(); // service ids đang mở trong tab "Profile đã đẩy"
  const poolCapEditing = new Set(); // profileId đang ở chế độ SỬA sức chứa (bật ô nhập + nút −/+)
  const poolCapDraft = new Map(); // profileId → giá trị đang gõ (giữ qua re-render tới khi Lưu/Hủy)
  const poolGrantExpanded = new Set(); // SERVICE ids đang mở trong tab "Quyền"
  // Tab "Quyền": DANH SÁCH DỊCH VỤ → bấm 1 dịch vụ mở ra USER được cấp quyền (service_visibility visible=1)
  // → mỗi user kèm PROFILE/SLOT đang liên kết (assignments live + recent 24h). UIUX card hiện đại.
  function poolVisibleGranted(v) { return !(v === false || v === 0 || v === "0" || v == null); }
  function renderPoolGrants() {
    // THỐNG KÊ theo dịch vụ (KHÔNG liệt kê toàn bộ người dùng). Mỗi dịch vụ = 1 dòng số liệu: số người dùng
    // được cấp quyền, số profile phục vụ, số đang liên kết. Kèm 1 thanh tổng ở đầu.
    const byService = new Map(); // serviceId → Set(userId) được cấp quyền tường minh
    for (const r of (state.serviceVisibility || [])) {
      if (!r || r.userId === SERVICE_UI_RULE_USER_ID || !poolVisibleGranted(r.visible)) continue;
      if (poolFilter.svc && r.serviceId !== poolFilter.svc) continue;
      if (!byService.has(r.serviceId)) byService.set(r.serviceId, new Set());
      byService.get(r.serviceId).add(r.userId);
    }
    const linkedByUser = new Set(); // "svc|user" đang/gần đây có gán profile
    for (const a of (cxPool.recentAssignments || [])) linkedByUser.add(a.serviceId + "|" + a.userId);
    for (const a of (cxPool.assignments || [])) linkedByUser.add(a.serviceId + "|" + a.userId);
    const profBySvc = new Map(); // serviceId → số profile phục vụ (từ pool)
    for (const p of (cxPool.profiles || [])) for (const s of (p.services || [])) profBySvc.set(s, (profBySvc.get(s) || 0) + 1);
    let svcIds = Array.from(byService.keys());
    svcIds.sort((a, b) => byService.get(b).size - byService.get(a).size || poolServiceLabel(a).localeCompare(poolServiceLabel(b)));
    if (!svcIds.length) return `<div style="text-align:center;padding:56px 20px;color:var(--text-3);"><div style="font-size:34px;margin-bottom:10px;">🗂️</div>Chưa có dịch vụ nào được cấp quyền cho user (service_visibility visible=1)${poolFilter.svc ? " khớp bộ lọc" : ""}.<br>Cấp quyền qua import / gán gói per-customer.</div>`;
    const pill = (txt, c, bg, bd) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;color:${c};background:${bg};border:1px solid ${bd};border-radius:999px;padding:3px 11px;white-space:nowrap;">${txt}</span>`;
    // Tổng hợp
    const perSvc = svcIds.map((svc) => {
      const users = byService.get(svc);
      let linked = 0; for (const u of users) if (linkedByUser.has(svc + "|" + u)) linked += 1;
      return { svc, userCount: users.size, profCount: profBySvc.get(svc) || 0, linked };
    });
    const totGrants = perSvc.reduce((s, x) => s + x.userCount, 0);
    const totLinked = perSvc.reduce((s, x) => s + x.linked, 0);
    const totProfiles = (cxPool.profiles || []).length;
    const stat = (label, value, c) => `<div style="flex:1;min-width:120px;background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:14px 16px;"><div style="font:800 24px 'Segoe UI',system-ui,sans-serif;color:${c};line-height:1;">${value}</div><div style="font-size:11.5px;color:var(--text-3);margin-top:5px;">${label}</div></div>`;
    const summary = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
      ${stat("Dịch vụ được cấp quyền", svcIds.length, "var(--text)")}
      ${stat("Lượt cấp quyền (user·dịch vụ)", totGrants, "var(--brand)")}
      ${stat("Profile trong pool", totProfiles, "var(--text)")}
      ${stat("Đang liên kết profile", totLinked, "var(--ok-text,#16a34a)")}
    </div>`;
    const HCOLS = "grid-template-columns:1fr 130px 120px 130px;gap:12px;";
    const rows = perSvc.map((x) => {
      const initial = escapeHtml((poolServiceLabel(x.svc)[0] || "?").toUpperCase());
      return `<div style="display:grid;${HCOLS}align-items:center;padding:13px 18px;border-top:1px solid var(--border-soft);">
        <span style="display:flex;align-items:center;gap:12px;min-width:0;">
          <span style="width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--brand),var(--brand-strong));color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;flex-shrink:0;">${initial}</span>
          <span style="min-width:0;"><span style="display:block;font-size:14px;font-weight:800;color:var(--text);line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(poolServiceLabel(x.svc))}</span><span style="display:block;font-size:11px;color:var(--text-3);margin-top:1px;">${escapeHtml(x.svc)}</span></span>
        </span>
        <span>${pill(`<strong style="font-size:13px;">${x.userCount}</strong>&nbsp;người dùng`, "var(--brand)", "var(--brand-soft,#eff6ff)", "var(--brand-border,#bfdbfe)")}</span>
        <span>${pill(`${x.profCount} profile`, "var(--text-2)", "var(--surface-2)", "var(--border)")}</span>
        <span style="text-align:right;">${x.linked ? pill(`${x.linked} liên kết`, "var(--ok-text,#16a34a)", "var(--ok-soft,#f0fdf4)", "var(--ok-border,#bbf7d0)") : `<span style="font-size:11px;color:var(--text-3);">—</span>`}</span>
      </div>`;
    }).join("");
    const table = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:0 1px 3px var(--shadow,rgba(15,23,42,.06));">
      <div style="display:grid;${HCOLS}padding:13px 18px;font:700 10px 'Segoe UI',system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--label);background:var(--surface-2,#f7f9fc);"><span>Dịch vụ</span><span>Người dùng</span><span>Profile</span><span style="text-align:right;">Liên kết</span></div>
      ${rows}
    </div>`;
    return summary + table;
  }
  function renderPoolProfiles() {
    const profiles = cxPool.profiles || [];
    if (!profiles.length) return `<div style="text-align:center;padding:44px;color:var(--text-3);">Chưa có profile nào được đẩy lên pool. Mở App Manager → đăng nhập dịch vụ → "Đẩy lên pool".</div>`;
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assignsByPid = new Map();
    for (const a of (cxPool.assignments || [])) assignsByPid.set(a.profileId, (assignsByPid.get(a.profileId) || 0) + 1);
    // gom theo dịch vụ (1 profile có thể phục vụ nhiều dịch vụ → xuất hiện ở mỗi dịch vụ nó phục vụ)
    const bySvc = new Map();
    for (const p of profiles) for (const s of (p.services || [])) { if (!bySvc.has(s)) bySvc.set(s, []); bySvc.get(s).push(p); }
    const svcIds = Array.from(bySvc.keys())
      .filter((s) => !poolFilter.svc || s === poolFilter.svc) // lọc theo dịch vụ
      .sort((a, b) => bySvc.get(b).length - bySvc.get(a).length || a.localeCompare(b));
    const cards = svcIds.map((svc) => {
      const list = bySvc.get(svc);
      const slotRe = new RegExp("^" + esc(svc) + "-(\\d+)$");
      const slotOf = (pid) => { const m = slotRe.exec(String(pid || "")); return m ? Number(m[1]) : null; };
      list.sort((a, b) => ((slotOf(a.profileId) ?? 9999) - (slotOf(b.profileId) ?? 9999)) || String(a.profileId).localeCompare(String(b.profileId)));
      const lastPush = list.reduce((mx, p) => Math.max(mx, Date.parse(p.updatedAt || 0) || 0), 0);
      const expanded = poolProfExpanded.has(svc);
      const COLP = "grid-template-columns:104px 1fr 116px 56px 72px 58px 134px 178px;gap:9px;";
      const rows = !expanded ? "" : `
        <div style="background:var(--surface-2);border-top:1px solid var(--border);">
          <div style="display:grid;${COLP}padding:11px 16px 8px;border-bottom:1px solid var(--border-soft);font:700 10.5px 'Segoe UI',system-ui,sans-serif;letter-spacing:.03em;text-transform:uppercase;color:var(--label);"><span>Slot</span><span>Profile</span><span>Đẩy lần cuối</span><span>Số lần</span><span>Kích thước</span><span>Đang gán</span><span title="Số user tối đa gán vào slot này">Sức chứa</span><span style="text-align:right;">Thao tác</span></div>
          ${list.map((p) => {
            const sn = slotOf(p.profileId);
            const nAssign = assignsByPid.get(p.profileId) || 0;
            const editing = poolCapEditing.has(p.profileId);
            const capVal = Number(p.capacity) || 1;
            const shownCap = (editing && poolCapDraft.has(p.profileId)) ? poolCapDraft.get(p.profileId) : capVal; // giữ số đang gõ qua re-render
            const stepBtn = (delta, sym) => `<button type="button" data-centrix-server-action="pool-cap-step" data-pid="${escapeHtml(p.profileId)}" data-delta="${delta}" tabindex="-1" title="${delta < 0 ? "Giảm" : "Tăng"}" style="width:26px;height:30px;border:1px solid var(--field-border);border-radius:7px;background:var(--surface);color:var(--text);font-size:16px;font-weight:800;cursor:pointer;line-height:1;flex-shrink:0;">${sym}</button>`;
            const capInput = `<input type="number" min="1" data-cx-pool-cap="${escapeHtml(p.profileId)}" value="${escapeHtml(String(shownCap))}" ${editing ? "" : "readonly"} title="${p.capacityCustom ? "Đang đặt riêng" : "Mặc định"}${editing ? " — nhập số user tối đa cho slot" : ""}" style="width:46px;height:30px;text-align:center;border:1px solid ${editing || p.capacityCustom ? "var(--brand)" : "var(--field-border)"};border-radius:7px;background:${editing ? "var(--field-bg)" : "var(--surface-2)"};color:var(--text);font:800 12px 'Segoe UI';${editing ? "" : "cursor:default;"}">`;
            const capCell = `<span style="display:inline-flex;align-items:center;gap:4px;">${editing ? stepBtn(-1, "−") : ""}${capInput}${editing ? stepBtn(1, "+") : ""}<span style="font-size:10.5px;color:var(--text-3);">user</span></span>`;
            const actBtn = (act, label, extra, title) => `<button type="button" data-centrix-server-action="${act}" data-pid="${escapeHtml(p.profileId)}"${title ? ` title="${title}"` : ""} style="height:30px;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer;line-height:1;padding:0 9px;${extra}">${label}</button>`;
            const actCell = `<span style="display:inline-flex;align-items:center;gap:5px;justify-content:flex-end;">
              ${actBtn("pool-cap-edit", editing ? "Đang sửa" : "Sửa", `border:1px solid ${editing ? "var(--brand)" : "var(--border)"};background:${editing ? "var(--brand-soft)" : "var(--surface)"};color:${editing ? "var(--brand)" : "var(--text-2)"};`, "Bật/tắt chỉnh sức chứa")}
              ${actBtn("pool-cap-save", "Lưu", `border:1px solid var(--brand);background:var(--brand);color:#fff;${editing ? "" : "opacity:.45;"}`, "Lưu sức chứa")}
              ${actBtn("pool-del-profile", "🗑", `border:1px solid var(--danger-border,#fecaca);background:var(--danger-soft,#fef2f2);color:var(--danger-text,#dc2626);font-size:14px;width:34px;padding:0;`, "Xóa profile đã đẩy")}
            </span>`;
            return `<div style="display:grid;${COLP}align-items:center;padding:10px 16px;border-bottom:1px solid var(--border-soft);${p.stored ? "" : "opacity:.55;"}">
              <span>${sn != null
                ? `<span style="display:inline-block;font-size:12px;font-weight:800;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:8px;padding:4px 11px;">Slot #${sn}</span>`
                : `<span style="font-size:11px;font-weight:600;color:var(--text-3);">dùng chung</span>`}</span>
              <span style="font-size:12px;color:var(--text-2);font-family:Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.profileId)}${p.stored ? "" : ` <span style=\"font-size:10px;color:var(--danger-text,#dc2626);font-family:'Segoe UI';\">(mất snapshot)</span>`}</span>
              <span style="font-size:12px;color:var(--text-2);">${escapeHtml(poolDateTime(p.updatedAt))}</span>
              <span style="font-size:12px;font-weight:700;color:var(--text-2);">${Number(p.revision || 0).toLocaleString("vi-VN")}</span>
              <span style="font-size:12px;color:var(--text-3);">${escapeHtml(poolSize(p.sizeBytes))}</span>
              <span style="font-size:12px;font-weight:${nAssign ? "800" : "600"};color:${nAssign ? "var(--brand)" : "var(--text-3)"};">${nAssign ? nAssign + " user" : "—"}</span>
              ${capCell}
              ${actCell}</div>`;
          }).join("")}
        </div>`;
      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:12px;">
        <div data-centrix-server-action="pool-prof-detail" data-svc="${escapeHtml(svc)}" title="Bấm để xem/ẩn profile đã đẩy" style="display:flex;align-items:center;gap:11px;padding:13px 15px;background:var(--surface-2);cursor:pointer;user-select:none;">
          <span style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--brand),var(--brand-strong));color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0;">${escapeHtml((poolServiceLabel(svc)[0] || "?").toUpperCase())}</span>
          <span style="font-size:14.5px;font-weight:800;color:var(--text);">${escapeHtml(poolServiceLabel(svc))}</span>
          <span style="margin-left:auto;display:flex;align-items:center;gap:14px;white-space:nowrap;">
            <span style="font-size:13px;color:var(--text-2);"><strong style="color:var(--brand);font-size:15px;">${list.length}</strong> profile</span>
            <span style="font-size:11px;color:var(--text-3);">đẩy gần nhất: ${lastPush ? escapeHtml(poolDateTime(new Date(lastPush).toISOString())) : "—"}</span>
            <span style="font-size:11.5px;font-weight:700;color:var(--brand);">${poolProfExpanded.has(svc) ? "Ẩn ▴" : "Xem ▾"}</span></span></div>${rows}</div>`;
    }).join("");
    return cards;
  }
  // Xóa 1 profile đã đẩy (có xác nhận) → POST /api/admin/pool/delete-profile → refresh.
  async function deletePoolProfile(pid) {
    if (!pid) return;
    if (!window.confirm(`Xóa profile đã đẩy "${pid}"?\n\nSẽ gỡ khỏi pool + hủy các gán đang chiếm slot + XÓA snapshot trên đĩa. KHÔNG khôi phục được (Manager phải đẩy lại).`)) return;
    const r = await postJson("/api/admin/pool/delete-profile", { profileId: pid }).catch(() => null);
    if (r && r.ok) { showActionToast(`Đã xóa profile ${pid}`); await refreshPoolIfVisible({ force: true }); renderPoolOverlay(true); }
    else showActionToast((r && r.error) || "Xóa profile thất bại", "error");
  }
  // Tìm ô nhập sức chứa của 1 profile (escape an toàn cho attribute selector).
  function poolCapInput(pid) {
    const sel = (window.CSS && CSS.escape) ? CSS.escape(pid) : String(pid).replace(/["\\]/g, "\\$&");
    return document.querySelector(`[data-cx-pool-cap="${sel}"]`);
  }
  // Nút −/+ : chỉnh giá trị ô nhập + BẢN NHÁP tại chỗ (không gọi API, không vẽ lại) — chỉ lưu khi bấm "Lưu".
  function stepPoolCapacity(pid, delta) {
    const inp = poolCapInput(pid);
    if (!inp || inp.hasAttribute("readonly")) return;
    const val = Math.max(1, (Math.floor(Number(inp.value) || 1)) + delta);
    inp.value = String(val);
    poolCapDraft.set(pid, val);
  }
  // Ghi bản nháp khi user gõ trực tiếp vào ô (giữ qua re-render). Wire 1 lần trên document.
  if (!window.__cxPoolCapDraftWired) {
    window.__cxPoolCapDraftWired = true;
    document.addEventListener("input", (e) => {
      const inp = e.target && e.target.closest ? e.target.closest("[data-cx-pool-cap]") : null;
      if (!inp || inp.hasAttribute("readonly")) return;
      poolCapDraft.set(inp.getAttribute("data-cx-pool-cap"), inp.value);
    });
  }
  // Nút "Lưu" → POST /api/admin/pool/capacity {scope:"profile"} rồi thoát chế độ sửa + refresh.
  async function savePoolCapacity(pid) {
    if (!pid) return;
    const raw = poolCapDraft.has(pid) ? poolCapDraft.get(pid) : (poolCapInput(pid) || {}).value;
    const val = Math.max(1, Math.floor(Number(raw) || 1));
    const r = await postJson("/api/admin/pool/capacity", { scope: "profile", key: pid, value: val }).catch(() => null);
    if (r && r.ok) { showActionToast(`Sức chứa ${pid} = ${val} user`); poolCapEditing.delete(pid); poolCapDraft.delete(pid); await refreshPoolIfVisible({ force: true }); renderPoolOverlay(true); }
    else showActionToast((r && r.error) || "Đặt sức chứa thất bại", "error");
  }
  // ── VAULT: tài khoản auto-login (serviceId+slot ↔ user/pass/TOTP) — quản lý tập trung, worker VPS đọc. ──
  let cxVaultAccounts = { list: [], hasKey: true, loaded: false };
  const poolVaultForm = { serviceId: "", slot: "1", loginType: "password", label: "", username: "", password: "", totpSecret: "", loginUrl: "", enabled: true };
  let poolVaultEditing = ""; // id đang sửa; "" = thêm mới
  function resetVaultForm() { Object.assign(poolVaultForm, { serviceId: "", slot: "1", loginType: "password", label: "", username: "", password: "", totpSecret: "", loginUrl: "", enabled: true }); poolVaultEditing = ""; }
  // Slot TRỐNG kế tiếp cho 1 dịch vụ = max slot đang có + 1 (else 1). Dùng để tự điền khi chọn dịch vụ → thêm
  // nhiều slot không bị ghi đè slot 1 (đây là lý do "không thêm được nhiều slot": form luôn reset slot về 1).
  function vaultNextSlot(serviceId) {
    const sid = String(serviceId || "").toLowerCase().trim();
    if (!sid) return "1";
    const slots = (cxVaultAccounts.list || []).filter((a) => String(a.serviceId).toLowerCase() === sid).map((a) => Number(a.slot) || 0);
    return String((slots.length ? Math.max(...slots) : 0) + 1);
  }
  async function refreshVaultAccounts() {
    const r = await getJson("/api/admin/service-accounts").catch(() => null);
    if (r && r.ok) { cxVaultAccounts = { list: r.accounts || [], hasKey: r.hasKey !== false, loaded: true }; renderPoolOverlay(true); }
  }
  if (!window.__cxVaultWired) {
    window.__cxVaultWired = true;
    document.addEventListener("input", (e) => {
      const el = e.target && e.target.closest ? e.target.closest("[data-cx-vault]") : null;
      if (!el) return;
      const f = el.getAttribute("data-cx-vault");
      poolVaultForm[f] = el.type === "checkbox" ? el.checked : el.value;
      if (f === "serviceId" && !poolVaultEditing) { poolVaultForm.slot = vaultNextSlot(el.value); renderPoolOverlay(true); } // tự nhảy slot trống kế tiếp
      if (f === "loginType") renderPoolOverlay(true); // đổi kiểu → hiện/ẩn ô mật khẩu/TOTP/ghi chú Google
    });
  }
  async function saveVaultAccount() {
    const svc = String(poolVaultForm.serviceId || "").trim().toLowerCase();
    if (!svc) { showActionToast("Chọn dịch vụ", "error"); return; }
    const body = { serviceId: svc, slot: Math.max(1, Number(poolVaultForm.slot) || 1), loginType: poolVaultForm.loginType || "password", label: poolVaultForm.label, username: poolVaultForm.username, loginUrl: poolVaultForm.loginUrl, enabled: poolVaultForm.enabled !== false };
    if (String(poolVaultForm.password || "")) body.password = poolVaultForm.password;       // để trống = giữ mật khẩu cũ
    if (String(poolVaultForm.totpSecret || "")) body.totpSecret = poolVaultForm.totpSecret;  // để trống = giữ TOTP cũ
    const r = await postJson("/api/admin/service-accounts/save", body).catch(() => null);
    if (r && r.ok) { showActionToast("Đã lưu " + svc + " slot " + body.slot); resetVaultForm(); await refreshVaultAccounts(); }
    else showActionToast((r && r.error) || "Lưu thất bại", "error");
  }
  async function deleteVaultAccount(id) {
    if (!id || !window.confirm(`Xoá tài khoản auto-login "${id}"?\nWorker sẽ không còn tự đăng nhập slot này.`)) return;
    const r = await postJson("/api/admin/service-accounts/delete", { id }).catch(() => null);
    if (r && r.ok) { showActionToast("Đã xoá " + id); await refreshVaultAccounts(); }
    else showActionToast("Xoá thất bại", "error");
  }
  async function reseedVaultNow(serviceId, slot) {
    const r = await postJson("/api/admin/pool/reseed-now", { service: serviceId, slot: Number(slot) || 1, force: true }).catch(() => null);
    if (r && r.ok) { showActionToast("Đã yêu cầu worker seed lại " + serviceId + " slot " + (slot || 1) + " — trạng thái cập nhật sau vài giây"); setTimeout(() => refreshVaultAccounts(), 6000); }
    else showActionToast((r && r.error) || "Yêu cầu seed lại thất bại (worker chưa chạy?)", "error");
  }
  function editVaultAccount(id) {
    const a = (cxVaultAccounts.list || []).find((x) => x.id === id);
    if (!a) return;
    Object.assign(poolVaultForm, { serviceId: a.serviceId, slot: String(a.slot), loginType: a.loginType || "password", label: a.label || "", username: a.username || "", password: "", totpSecret: "", loginUrl: a.loginUrl || "", enabled: a.enabled !== false });
    poolVaultEditing = id;
    renderPoolOverlay(true);
  }
  function renderPoolVault() {
    if (!cxVaultAccounts.loaded) refreshVaultAccounts();
    if (cxVaultAccounts.hasKey === false) return `<div style="text-align:center;padding:44px;color:var(--danger-text,#dc2626);">Backend chưa đặt <b>CENTRIX_VAULT_KEY</b> (base64 32B) để mã hoá vault. Đặt env rồi restart backend.</div>`;
    const fieldCss = "height:34px;border:1px solid var(--field-border,#cbd5e1);border-radius:8px;background:var(--field-bg,var(--surface));color:var(--text);font:600 12.5px 'Segoe UI',system-ui;padding:0 10px;box-sizing:border-box;width:100%;";
    const lbl = (t) => `<span style="font-size:10.5px;font-weight:800;color:var(--label);text-transform:uppercase;letter-spacing:.03em;">${t}</span>`;
    const svcIds = Array.from(new Set([...(cxPool && cxPool.pool ? Object.keys(cxPool.pool) : []), ...((state.services || []).map((s) => s.id))])).sort();
    const svcOpts = ['<option value="">— chọn dịch vụ —</option>'].concat(svcIds.map((s) => `<option value="${escapeHtml(s)}"${poolVaultForm.serviceId === s ? " selected" : ""}>${escapeHtml(poolServiceLabel(s))}</option>`)).join("");
    const editing = !!poolVaultEditing;
    const lt = poolVaultForm.loginType || "password";
    const ltOpts = [["password", "Tài khoản + Mật khẩu"], ["totp", "Tài khoản + Mật khẩu + 2FA (mã TOTP)"], ["google", "Đăng nhập bằng Google (dùng cookie)"]].map(([v, t]) => `<option value="${v}"${lt === v ? " selected" : ""}>${t}</option>`).join("");
    const pwField = `<label style="display:flex;flex-direction:column;gap:4px;">${lbl("Mật khẩu" + (editing ? " (trống = giữ nguyên)" : ""))}<input id="cx-vault-password" data-cx-vault="password" type="password" value="${escapeHtml(poolVaultForm.password)}" placeholder="${editing ? "••••• (giữ nguyên)" : ""}" style="${fieldCss}"></label>`;
    const totpField = `<label style="display:flex;flex-direction:column;gap:4px;">${lbl("Mã 2FA — TOTP secret" + (editing ? " (trống=giữ)" : ""))}<input id="cx-vault-totpSecret" data-cx-vault="totpSecret" value="${escapeHtml(poolVaultForm.totpSecret)}" placeholder="${editing ? "••••• (giữ nguyên)" : "VD: JBSWY3DPEHPK3PXP"}" style="${fieldCss}"></label>`;
    const credBlock = lt === "google"
      ? `<div style="grid-column:1/-1;background:var(--warn-soft,#fffbeb);border:1px solid var(--warn-border,#fde68a);border-radius:8px;padding:11px 13px;font-size:12px;color:var(--text-2);line-height:1.55;">
           <b>⚠ Đăng nhập bằng Google:</b> worker KHÔNG tự điền mật khẩu (Google chặn bot + xác minh thiết bị). Admin <b>đăng nhập Google 1 lần THỦ CÔNG</b> trong Manager → đẩy cookie. Worker chỉ <b>dùng lại cookie</b> (phiên Google sống rất lâu). Nếu phiên chết → đăng nhập tay lại (worker báo 🔴, không hammer).
         </div>`
      : (lt === "totp" ? `${pwField}${totpField}` : `${pwField}`);
    const credCols = lt === "google" ? "1fr" : (lt === "totp" ? "1fr 1fr" : "1fr");
    const form = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:16px;">
        <div style="font-size:14px;font-weight:800;color:var(--text);margin-bottom:12px;">${editing ? "✏️ Sửa tài khoản: " + escapeHtml(poolVaultEditing) : "➕ Thêm tài khoản auto-login"}</div>
        <div style="display:grid;grid-template-columns:2fr 90px 1.4fr;gap:10px;margin-bottom:10px;">
          <label style="display:flex;flex-direction:column;gap:4px;">${lbl("Dịch vụ")}<select id="cx-vault-serviceId" data-cx-vault="serviceId" style="${fieldCss}"${editing ? " disabled" : ""}>${svcOpts}</select></label>
          <label style="display:flex;flex-direction:column;gap:4px;">${lbl("Slot")}<input id="cx-vault-slot" data-cx-vault="slot" type="number" min="1" value="${escapeHtml(String(poolVaultForm.slot))}" style="${fieldCss}"${editing ? " readonly" : ""}></label>
          <label style="display:flex;flex-direction:column;gap:4px;">${lbl("Nhãn (tuỳ chọn)")}<input id="cx-vault-label" data-cx-vault="label" value="${escapeHtml(poolVaultForm.label)}" placeholder="vd: Acc chính" style="${fieldCss}"></label>
        </div>
        <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:10px;margin-bottom:10px;">
          <label style="display:flex;flex-direction:column;gap:4px;">${lbl("Kiểu đăng nhập")}<select id="cx-vault-loginType" data-cx-vault="loginType" style="${fieldCss}">${ltOpts}</select></label>
          <label style="display:flex;flex-direction:column;gap:4px;">${lbl(lt === "google" ? "Email Google (ghi chú)" : "Username / Email")}<input id="cx-vault-username" data-cx-vault="username" value="${escapeHtml(poolVaultForm.username)}" style="${fieldCss}"></label>
        </div>
        <div style="display:grid;grid-template-columns:${credCols};gap:10px;margin-bottom:10px;">${credBlock}</div>
        <div style="margin-bottom:12px;">
          <label style="display:flex;flex-direction:column;gap:4px;">${lbl("Login URL (trang login trực tiếp — worker ép form login ở đây)")}<input id="cx-vault-loginUrl" data-cx-vault="loginUrl" value="${escapeHtml(poolVaultForm.loginUrl)}" placeholder="https://…/login" style="${fieldCss}"></label>
        </div>
        <div style="display:flex;align-items:center;gap:14px;">
          <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text-2);cursor:pointer;"><input id="cx-vault-enabled" data-cx-vault="enabled" type="checkbox"${poolVaultForm.enabled !== false ? " checked" : ""}> Bật auto-login cho slot này</label>
          <span style="margin-left:auto;display:flex;gap:8px;">
            ${editing ? `<button type="button" data-centrix-server-action="vault-cancel" style="height:34px;padding:0 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-2);font-weight:700;font-size:12.5px;cursor:pointer;">Huỷ</button>` : ""}
            <button type="button" data-centrix-server-action="vault-save" style="height:34px;padding:0 18px;border:1px solid var(--brand);border-radius:8px;background:var(--brand);color:#fff;font-weight:800;font-size:12.5px;cursor:pointer;">💾 Lưu</button>
          </span>
        </div>
      </div>`;
    const rows = (cxVaultAccounts.list || []).slice().sort((a, b) => (a.serviceId + a.slot).localeCompare(b.serviceId + b.slot)).map((a) => {
      const stColor = a.status === "alive" ? "var(--ok-text,#16a34a)" : a.status === "dead" ? "var(--danger-text,#dc2626)" : "var(--text-3)";
      const stTxt = a.status === "alive" ? "🟢 sống" : a.status === "dead" ? "🔴 chết" : "— chưa rõ";
      return `<div style="display:grid;grid-template-columns:1.4fr 70px 1.6fr 90px 1fr 120px;gap:10px;align-items:center;padding:11px 14px;border-bottom:1px solid var(--border-soft);${a.enabled === false ? "opacity:.5;" : ""}">
        <span style="font-size:13px;font-weight:700;color:var(--text);">${escapeHtml(poolServiceLabel(a.serviceId))}${a.label ? ` <span style="font-weight:400;color:var(--text-3);font-size:11px;">${escapeHtml(a.label)}</span>` : ""}</span>
        <span style="font-size:12px;font-weight:800;color:var(--brand);">Slot #${escapeHtml(String(a.slot))}</span>
        <span style="font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.username || "—")} ${a.loginType === "google" ? "<span style='font-size:10px;color:#4285f4;font-weight:700;'>🔵 Google</span>" : (a.hasPassword ? "" : "<span style='color:var(--danger-text,#dc2626);font-size:10px;'>(chưa có mật khẩu)</span>")}${a.hasTotp ? " <span style='font-size:10px;color:var(--text-3);'>🔐2FA</span>" : ""}</span>
        <span style="font-size:11.5px;font-weight:700;color:${stColor};">${stTxt}</span>
        <span style="font-size:11px;color:var(--text-3);">${a.lastSeededAt ? escapeHtml(poolDateTime(a.lastSeededAt)) : "—"}</span>
        <span style="display:flex;gap:6px;justify-content:flex-end;">
          <button type="button" data-centrix-server-action="vault-reseed" data-svc="${escapeHtml(a.serviceId)}" data-slot="${escapeHtml(String(a.slot))}" title="Ép worker đăng nhập lại account này ngay (làm mới trạng thái)" style="height:30px;padding:0 10px;border:1px solid var(--brand-border,#bfdbfe);border-radius:7px;background:var(--brand-soft,#eff6ff);color:var(--brand);font-size:12px;font-weight:700;cursor:pointer;">🔄 Seed lại</button>
          <button type="button" data-centrix-server-action="vault-edit" data-id="${escapeHtml(a.id)}" style="height:30px;padding:0 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text-2);font-size:12px;font-weight:700;cursor:pointer;">Sửa</button>
          <button type="button" data-centrix-server-action="vault-del" data-id="${escapeHtml(a.id)}" title="Xoá" style="height:30px;width:34px;border:1px solid var(--danger-border,#fecaca);border-radius:7px;background:var(--danger-soft,#fef2f2);color:var(--danger-text,#dc2626);font-size:14px;cursor:pointer;">🗑</button>
        </span></div>`;
    }).join("");
    const list = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;">
      <div style="display:grid;grid-template-columns:1.4fr 70px 1.6fr 90px 1fr 120px;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);font:700 10.5px 'Segoe UI';letter-spacing:.03em;text-transform:uppercase;color:var(--label);background:var(--surface-2);"><span>Dịch vụ</span><span>Slot</span><span>Tài khoản</span><span>Trạng thái</span><span>Seed lần cuối</span><span></span></div>
      ${rows || `<div style="padding:28px;text-align:center;color:var(--text-3);font-size:13px;">Chưa có tài khoản auto-login nào. Thêm ở form phía trên.</div>`}</div>`;
    return `<div style="font-size:12px;color:var(--text-3);margin-bottom:12px;">Mỗi <b>dịch vụ + slot</b> gắn 1 tài khoản. Worker (máy/VPS) đọc đây để tự đăng nhập lại đúng account khi slot bị đá. Sửa ở đây, KHÔNG cần đụng máy chạy worker.</div>${form}${list}`;
  }
  function renderPoolOverlay(force) {
    const ov = document.getElementById("cx-pool-screen");
    if (!ov) return false;
    const activity = poolActivityByService();
    // tổng "người đang dùng" TÔN TRỌNG bộ lọc (dịch vụ + tên) để khớp những gì đang hiển thị
    const activeUsers = new Set(); const actParts = [];
    for (const [svc, um] of activity) {
      if (poolFilter.svc && svc !== poolFilter.svc) continue;
      let n = 0;
      for (const uid of um.keys()) { if (poolUserMatch(uid)) { activeUsers.add(uid); n++; } }
      actParts.push(svc + ":" + n);
    }
    const activeTotal = activeUsers.size;
    const timeLabel = poolFilter.date ? ("ngày " + poolFilter.date.split("-").reverse().join("/")) : (poolWindowLabel() + " gần nhất");
    const profSig = (cxPool.profiles || []).map((p) => p.profileId + ":" + p.revision + ":" + (p.updatedAt || "") + ":" + (p.capacity || "") + (p.capacityCustom ? "c" : "")).join(",");
    const sig = poolTab + "|" + poolWindowMin + "|" + JSON.stringify(poolFilter) + "|" + actParts.sort().join(",") + "|" + (cxPool.assignments || []).length + ":" + (cxPool.recentAssignments || []).length + "|" + Object.keys(cxPool.pool || {}).join(",") + "|" + Array.from(poolExpanded).sort().join(",") + ";" + Array.from(poolProfExpanded).sort().join(",") + ";" + Array.from(poolGrantExpanded).sort().join(",") + ";" + Array.from(poolCapEditing).sort().join(",") + "|" + profSig + "|" + (state.serviceVisibility || []).length + ":" + (state.accounts || []).length;
    const rootAlive = !!ov.querySelector("[data-centrix-pool-root]");
    if (!force && rootAlive && ov.dataset.centrixPoolMount === sig) return true;
    ov.dataset.centrixPoolMount = sig;
    const tabBtn = (k, label) => `<button type="button" data-centrix-server-action="pool-tab" data-tab="${k}" style="border:0;border-radius:9px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;color:${poolTab === k ? "#fff" : "var(--text-2)"};background:${poolTab === k ? "var(--brand)" : "var(--surface-2)"};">${label}</button>`;
    const body = poolTab === "services" ? renderPoolByService() : poolTab === "profiles" ? renderPoolProfiles() : poolTab === "grants" ? renderPoolGrants() : poolTab === "vault" ? renderPoolVault() : renderPoolByUser();
    // giữ focus + con trỏ của ô lọc qua re-render (poll 8s / gõ phím đều vẽ lại toàn overlay)
    const focusId = (document.activeElement && ov.contains(document.activeElement)) ? document.activeElement.id : "";
    const caret = focusId && document.activeElement.selectionStart != null ? document.activeElement.selectionStart : null;
    const fieldCss = "height:34px;border:1px solid var(--field-border,#cbd5e1);border-radius:8px;background:var(--field-bg,var(--surface));color:var(--text);font:600 12.5px 'Segoe UI',system-ui,sans-serif;padding:0 10px;box-sizing:border-box;";
    const svcOptions = ['<option value="">Tất cả dịch vụ</option>']
      .concat(Array.from(new Set([...Object.keys(cxPool.pool || {}), ...(state.services || []).map((s) => s.id)])).sort()
        .map((sid) => `<option value="${escapeHtml(sid)}"${poolFilter.svc === sid ? " selected" : ""}>${escapeHtml(poolServiceLabel(sid))}</option>`)).join("");
    const filterBar = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;letter-spacing:.03em;">Bộ lọc:</span>
        <input id="cx-pool-f-date" type="date" value="${escapeHtml(poolFilter.date)}" title="Lọc theo ngày (đè lên khoảng thời gian)" style="${fieldCss}width:150px;">
        <input id="cx-pool-f-name" type="text" value="${escapeHtml(poolFilter.name)}" placeholder="Tìm tên / email user..." style="${fieldCss}width:210px;">
        <select id="cx-pool-f-svc" style="${fieldCss}width:190px;">${svcOptions}</select>
        ${(poolFilter.date || poolFilter.name || poolFilter.svc) ? `<button type="button" id="cx-pool-f-clear" style="height:34px;border:1px solid var(--border-soft);border-radius:8px;background:var(--surface-2);color:var(--text-2);font:700 12px 'Segoe UI',system-ui,sans-serif;padding:0 12px;cursor:pointer;">✕ Xoá lọc</button>` : ""}
      </div>`;
    ov.innerHTML = `
      <div data-centrix-pool-root="1" style="display:flex;flex-direction:column;gap:16px;max-width:1180px;margin:0 auto;">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div><div style="font-size:22px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Phân bổ profile</div>
            <div style="font-size:13px;color:var(--text-2);margin-top:4px;">Ai đang dùng dịch vụ nào · <strong style="color:var(--brand);">${activeTotal}</strong> người đang dùng (${escapeHtml(timeLabel)}).</div></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">${tabBtn("services", "Theo dịch vụ")}${tabBtn("users", "Theo người dùng")}${tabBtn("profiles", "Profile đã đẩy (" + (cxPool.profiles || []).length + ")")}${tabBtn("grants", "Quyền (Dịch vụ → User → Profile)")}${tabBtn("vault", "🔑 Tài khoản auto-login")}</div></div>
        ${filterBar}
        ${poolTab === "profiles" ? `<div style="font-size:11.5px;color:var(--text-3);background:var(--surface-2);border:1px solid var(--border-soft);border-radius:9px;padding:8px 11px;">ℹ️ Danh sách profile App Manager đã <strong>đẩy lên pool</strong> — đẩy lần cuối lúc nào, bao nhiêu lần, phục vụ dịch vụ nào, bao nhiêu user đang được gán. Tự cập nhật mỗi ~8 giây.</div>` : poolTab === "grants" ? `<div style="font-size:11.5px;color:var(--text-3);background:var(--surface-2);border:1px solid var(--border-soft);border-radius:9px;padding:8px 11px;">ℹ️ Mỗi dịch vụ → <strong>user được cấp quyền</strong> (service_visibility visible=1) và <strong>profile/slot</strong> họ đang được gán (đang/gần đây 24h). Bấm dịch vụ để mở. Tự cập nhật mỗi ~8 giây.</div>` : `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;${poolFilter.date ? "opacity:.45;pointer-events:none;" : ""}" title="${poolFilter.date ? "Đang lọc theo ngày — xoá ngày để dùng khoảng thời gian" : ""}">
          <span style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;letter-spacing:.03em;">Khoảng thời gian:</span>
          ${[[30, "30 phút"], [60, "1 giờ"], [360, "6 giờ"], [1440, "24 giờ"]].map(([m, lb]) => `<button type="button" data-centrix-server-action="pool-window" data-win="${m}" style="border:1px solid ${poolWindowMin === m ? "var(--brand)" : "var(--border-soft)"};border-radius:999px;padding:5px 13px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;color:${poolWindowMin === m ? "#fff" : "var(--text-2)"};background:${poolWindowMin === m ? "var(--brand)" : "var(--surface-2)"};">${lb}</button>`).join("")}</div>
        <div style="font-size:11.5px;color:var(--text-3);background:var(--surface-2);border:1px solid var(--border-soft);border-radius:9px;padding:8px 11px;">ℹ️ "Đang dùng" = có <strong>giao dịch credit (dùng model)</strong> trong ${escapeHtml(timeLabel)} — khớp với "Sổ giao dịch". Cột <strong>Slot</strong> chỉ hiện nếu user đi qua profile-pool; còn lại là "login riêng". Tự cập nhật mỗi ~8 giây.</div>`}
        <div>${body}</div></div>`;
    // wire bộ lọc (innerHTML vừa thay → node mới) + khôi phục focus/caret cho ô đang gõ
    const fDate = ov.querySelector("#cx-pool-f-date");
    const fName = ov.querySelector("#cx-pool-f-name");
    const fSvc = ov.querySelector("#cx-pool-f-svc");
    const fClear = ov.querySelector("#cx-pool-f-clear");
    if (fDate) fDate.addEventListener("change", () => { poolFilter.date = fDate.value || ""; renderPoolOverlay(true); });
    if (fName) fName.addEventListener("input", () => { poolFilter.name = fName.value || ""; renderPoolOverlay(true); });
    if (fSvc) fSvc.addEventListener("change", () => { poolFilter.svc = fSvc.value || ""; renderPoolOverlay(true); });
    if (fClear) fClear.addEventListener("click", () => { poolFilter.date = ""; poolFilter.name = ""; poolFilter.svc = ""; renderPoolOverlay(true); });
    if (focusId) {
      const el = ov.querySelector("#" + focusId);
      if (el) { el.focus(); if (caret != null && el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch (e) { /* input type=date không hỗ trợ */ } } }
    }
    return true;
  }

  function mountModelApiPanel(options = {}) {
    const screen = findModelScreen();
    if (!screen) return false;
    const service = selectedModelService();
    const serviceId = service?.id || modelServiceId();
    const draftRows = getModelPriceDraft(serviceId).slice().sort((a, b) =>
      Number(b.isDefault === true) - Number(a.isDefault === true) ||
      String(a.modelId || "").localeCompare(String(b.modelId || "")));
    const defaultRow = draftRows.find((row) => row.isDefault) || draftRows[0] || null;
    const defaultModelId = defaultRow?.modelId || "";
    const pricedCount = draftRows.length;

    const observations = (state.modelObservations || [])
      .filter((item) => item.serviceId === serviceId)
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
      .slice(0, 24);

    // Key on saved state only (NOT the live draft). All draft mutations re-render via {force:true}; keeping the
    // draft out of the key means a periodic non-forced mount can't repaint mid-typing. DÙNG CHỮ KÝ DỮ LIỆU THẬT
    // (observations + giá đã lưu) thay `state.updatedAt` — updatedAt đổi mỗi poll 8s dù model panel không đổi →
    // re-render vô ích → nhảy cuộn. Giờ chỉ re-render khi observations/giá thật sự đổi.
    const obsSig = observations.map((o) => o.modelId + ":" + (o.count || 0)).join(",");
    const priceSig = (state.modelPrices || []).filter((p) => p.serviceId === serviceId)
      .map((p) => p.modelId + ":" + p.creditCost + ":" + (p.enabled !== false ? 1 : 0) + ":" + (p.isDefault ? 1 : 0)).join(",");
    const key = serviceId + "|" + obsSig + "|" + priceSig;
    if (!options.force && screen.dataset.centrixModelMount === key) return true;
    screen.dataset.centrixModelMount = key;

    const serviceOptions = optionHtml(state.services, serviceId, (row) => row.name || row.id);
    const draftSet = new Set(draftRows.map((row) => row.modelId));
    const COLS = "1fr 150px 186px 150px 76px";

    const observedHtml = observations.length
      ? observations.map((item) => {
          const inTable = draftSet.has(item.modelId);
          const meta = `${Number(item.count || 0)} lần${item.lastSeenAt ? ` · ${escapeHtml(formatObservationTime(item.lastSeenAt))}` : ""}`;
          return `
        <div data-centrix-observation-row="${escapeHtml(fold(item.modelId))}" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px;border:1px solid var(--border-soft);border-radius:11px;background:var(--surface-2);">
          <span style="min-width:0;"><code style="display:block;font-size:12.5px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.modelId)}</code><em style="display:block;font-style:normal;font-size:11px;color:var(--text-3);margin-top:2px;">${meta}</em></span>
          <span style="display:inline-flex;gap:7px;flex-shrink:0;">
            <button type="button" data-centrix-model-action="add-observed" data-model-id="${escapeHtml(item.modelId)}" ${inTable ? "disabled" : ""} style="height:30px;border:1px solid var(--brand-border);border-radius:8px;background:${inTable ? "var(--surface)" : "var(--brand-soft)"};color:${inTable ? "var(--text-3)" : "var(--brand)"};font-weight:800;font-size:12px;cursor:${inTable ? "default" : "pointer"};padding:0 11px;">${inTable ? "Đã thêm" : "+ Thêm"}</button>
            <button type="button" data-centrix-model-action="check-observed" data-model-id="${escapeHtml(item.modelId)}" style="height:30px;border:1px solid var(--field-border);border-radius:8px;background:var(--surface);color:var(--text);font-weight:700;font-size:12px;cursor:pointer;padding:0 11px;">Kiểm tra</button>
          </span>
        </div>`;
        }).join("")
      : `<div style="font-size:12px;color:var(--text-3);padding:13px;border:1px dashed var(--border-soft);border-radius:11px;">Chưa ghi nhận model nào. Mở trình duyệt dịch vụ và gửi một request để thu thập tên model.</div>`;

    const tableRowsHtml = draftRows.length
      ? draftRows.map((row) => {
          const on = row.enabled !== false;
          return `
        <div style="display:grid;grid-template-columns:${COLS};gap:14px;align-items:center;padding:15px 6px;border-bottom:1px solid var(--border-soft);">
          <div style="min-width:0;display:flex;align-items:center;gap:9px;">
            <code style="font-size:13.5px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(row.modelId)}</code>
            ${row.isDefault ? `<span style="flex-shrink:0;font-size:10.5px;font-weight:800;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:999px;padding:2px 8px;">mặc định</span>` : ""}
          </div>
          <button type="button" data-centrix-model-action="toggle-enabled" data-model-id="${escapeHtml(row.modelId)}" style="display:inline-flex;align-items:center;gap:9px;border:0;background:transparent;cursor:pointer;padding:0;">
            <span style="position:relative;width:38px;height:22px;border-radius:999px;background:${on ? "var(--brand)" : "var(--border)"};transition:background .15s;flex-shrink:0;"><span style="position:absolute;top:2px;left:${on ? "18px" : "2px"};width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.3);transition:left .15s;"></span></span>
            <span style="font-size:12.5px;font-weight:700;color:${on ? "var(--text)" : "var(--text-3)"};white-space:nowrap;">${on ? "Đang bật" : "Tắt"}</span>
          </button>
          <div style="display:inline-flex;align-items:center;gap:8px;">
            <button type="button" data-centrix-model-action="step-credit" data-model-id="${escapeHtml(row.modelId)}" data-delta="-1" style="width:30px;height:32px;border:1px solid var(--field-border);border-radius:8px;background:var(--surface);color:var(--text);font-weight:900;font-size:16px;cursor:pointer;line-height:1;">−</button>
            <input data-centrix-model-credit-id="${escapeHtml(row.modelId)}" type="number" min="1" value="${escapeHtml(Math.max(1, Math.round(Number(row.creditCost || 1))))}" style="width:52px;height:32px;text-align:center;border:1px solid var(--field-border);border-radius:8px;background:var(--field-bg);color:var(--text);font-weight:800;font-size:13px;">
            <button type="button" data-centrix-model-action="step-credit" data-model-id="${escapeHtml(row.modelId)}" data-delta="1" style="width:30px;height:32px;border:1px solid var(--field-border);border-radius:8px;background:var(--surface);color:var(--text);font-weight:900;font-size:16px;cursor:pointer;line-height:1;">+</button>
            <span style="font-size:12px;color:var(--text-3);">credit</span>
          </div>
          <div style="display:inline-flex;align-items:center;gap:7px;" title="Giá theo token: credit trên 1.000 token. Để 0 = dùng giá cố định bên trái.">
            <input data-centrix-model-ktok-id="${escapeHtml(row.modelId)}" type="number" min="0" step="0.1" value="${escapeHtml(Number(row.creditPerKTok || 0))}" style="width:64px;height:32px;text-align:center;border:1px solid var(--field-border);border-radius:8px;background:var(--field-bg);color:var(--text);font-weight:800;font-size:13px;">
            <span style="font-size:11.5px;color:var(--text-3);white-space:nowrap;">/1K token</span>
          </div>
          <div style="display:inline-flex;align-items:center;gap:5px;justify-content:flex-end;">
            <button type="button" data-centrix-model-action="set-default" data-model-id="${escapeHtml(row.modelId)}" title="Đặt làm mặc định" style="width:32px;height:32px;border:1px solid ${row.isDefault ? "var(--brand-border)" : "var(--field-border)"};border-radius:8px;background:${row.isDefault ? "var(--brand-soft)" : "var(--surface)"};color:${row.isDefault ? "var(--brand)" : "var(--text-3)"};font-size:15px;cursor:pointer;line-height:1;">${row.isDefault ? "★" : "☆"}</button>
            <button type="button" data-centrix-model-action="remove-model" data-model-id="${escapeHtml(row.modelId)}" title="Xóa model" style="width:32px;height:32px;border:1px solid var(--field-border);border-radius:8px;background:var(--surface);color:var(--text-3);font-size:16px;cursor:pointer;line-height:1;">×</button>
          </div>
        </div>`;
        }).join("")
      : `<div style="padding:34px 6px;text-align:center;font-size:13px;color:var(--text-3);">Chưa có model nào trong bảng giá. Bấm "+ Thêm" ở danh sách model bên trái để thêm.</div>`;

    // GIỮ VỊ TRÍ CUỘN + focus/caret qua re-render (poll 8s hoặc bấm "+ Thêm" đều thay innerHTML → nếu không
    // khôi phục thì danh sách tự nhảy về đầu, mất chỗ đang kéo). Chụp trước, khôi phục sau khi vẽ lại.
    const scrollBefore = {};
    for (const id of ["centrix-model-observation-list", "centrix-model-price-table"]) {
      const el = screen.querySelector("#" + id); if (el) scrollBefore[id] = el.scrollTop;
    }
    const ae = document.activeElement;
    const focusId = (ae && screen.contains(ae) && ae.id) ? ae.id : "";
    const caret = (focusId && ae.selectionStart != null) ? ae.selectionStart : null;

    screen.innerHTML = `
      <div data-centrix-model-root="1" style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="padding:24px 26px;border-bottom:1px solid var(--border-soft);display:flex;align-items:flex-start;justify-content:space-between;gap:18px;">
          <div style="min-width:0;">
            <div style="font-size:21px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Định giá Model</div>
            <div style="font-size:13.5px;color:var(--text-2);margin-top:5px;max-width:560px;">Bảng giá dùng để trừ credit theo từng request của người dùng. Mỗi model gắn một số credit cố định cho mỗi lần gọi.</div>
          </div>
          <button type="button" data-centrix-model-action="save-prices" style="height:40px;border:1px solid var(--brand-border);border-radius:10px;background:var(--brand-soft);color:var(--brand);font-weight:900;cursor:pointer;padding:0 18px;white-space:nowrap;">✓ Lưu bảng giá</button>
        </div>
        <div style="display:grid;grid-template-columns:minmax(300px,360px) 1fr;min-height:520px;">
          <div style="padding:22px 24px 24px 26px;border-right:1px solid var(--border-soft);display:flex;flex-direction:column;gap:13px;min-width:0;">
            <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;">Dịch vụ</span><select id="centrix-model-service-select" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font-weight:600;padding:0 12px;">${serviceOptions}</select></label>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:2px;">
              <span style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;">Model ghi nhận từ trình duyệt</span>
              <span style="font-size:11px;font-weight:800;color:var(--brand);background:var(--brand-soft);border-radius:999px;padding:2px 9px;">${observations.length}</span>
            </div>
            <input id="centrix-model-observation-search" type="search" placeholder="Tìm model…" autocomplete="off" style="height:38px;border:1px solid var(--field-border);border-radius:9px;background:var(--field-bg);color:var(--text);font-size:13px;padding:0 12px;">
            <div class="cx-scroll" id="centrix-model-observation-list" style="display:flex;flex-direction:column;gap:9px;max-height:460px;overflow:auto;padding-right:2px;">${observedHtml}</div>
          </div>
          <div style="padding:22px 26px 22px;display:flex;flex-direction:column;min-width:0;">
            <div style="font-size:11px;font-weight:800;color:var(--label);text-transform:uppercase;letter-spacing:.02em;margin-bottom:6px;">Bảng giá — credit cố định / request, HOẶC đặt "Giá theo token" (credit/1K token) &gt; 0 để tính theo token</div>
            <div style="display:grid;grid-template-columns:${COLS};gap:14px;padding:10px 6px;border-bottom:1px solid var(--border);font-size:10.5px;font-weight:800;color:var(--text-3);text-transform:uppercase;letter-spacing:.03em;">
              <span>Model</span><span>Trạng thái</span><span>Credit / Request</span><span>Giá theo token</span><span style="text-align:right;">Mặc định</span>
            </div>
            <div class="cx-scroll" id="centrix-model-price-table" style="overflow:auto;max-height:420px;">${tableRowsHtml}</div>
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:16px;margin-top:auto;border-top:1px solid var(--border-soft);">
              <div style="font-size:12.5px;color:var(--text-2);"><strong style="color:var(--text);">${pricedCount}</strong> model có giá · Mặc định: <code style="color:var(--brand);font-weight:700;">${escapeHtml(defaultModelId || "—")}</code></div>
              <div style="font-size:11.5px;color:var(--text-3);max-width:300px;text-align:right;">Model mặc định được dùng khi request không chỉ định tên model.</div>
            </div>
          </div>
        </div>
      </div>`;
    // khôi phục vị trí cuộn + focus/caret (chống nhảy về đầu khi re-render)
    for (const id in scrollBefore) { const el = screen.querySelector("#" + id); if (el) el.scrollTop = scrollBefore[id]; }
    if (focusId) {
      const el = screen.querySelector("#" + (window.CSS && CSS.escape ? CSS.escape(focusId) : focusId));
      if (el) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } if (caret != null && el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch (e) { /* input type khác */ } } }
    }
    return true;
  }

  function scheduleModelApiPanel() {
    registerBodyTick(mountModelApiPanel);
    for (const delayMs of [300, 900, 1800, 3200]) setTimeout(mountModelApiPanel, delayMs);
  }

  // ── Support ("Hỗ trợ") admin panel ───────────────────────────────────────────────────────────────
  // The static support screen (data-screen-label="Hỗ trợ") ships a fake 4-row ticket list + a 100%-mock
  // detail/reply pane. Replace it (like mountModelApiPanel) with the REAL tickets from
  // state.portal.supportTickets (the admin portal snapshot, GET /api/admin/portal) and a working
  // per-ticket reply/close. Reply/close persist via the existing /api/admin/portal upsert (merges any
  // fields — reply/repliedBy/repliedAt/status) so NO new backend endpoint is needed.
  let selectedSupportTicketId = "";
  let supportFilter = "all";
  let supportTab = "chat";          // "chat" (Chat trực tiếp) | "ticket"
  let selectedChatUserId = "";

  function findSupportScreen() {
    return visibleScreens().find((screen) => fold(screen.getAttribute("data-screen-label")).includes("ho tro")) || null;
  }
  function supportTicketsAll() {
    const p = state.portal || {};
    const list = Array.isArray(p.supportTickets) ? p.supportTickets
      : (p.portal && Array.isArray(p.portal.supportTickets)) ? p.portal.supportTickets : [];
    return list.slice().sort((a, b) =>
      (Date.parse(b.updatedAt || b.createdAt || "") || 0) - (Date.parse(a.updatedAt || a.createdAt || "") || 0));
  }
  function supportUserLabel(userId) {
    if (!userId) return "Khách";
    const acc = (state.accounts || []).find((a) => a && a.userId === userId);
    if (acc && acc.email) return acc.email;
    const u = (state.users || []).find((x) => x && x.id === userId);
    return (u && (u.name || u.id)) || userId;
  }
  function supportRelTime(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const d = Date.now() - t;
    if (d < 60000) return "vừa xong";
    if (d < 3600000) return Math.round(d / 60000) + " phút trước";
    if (d < 86400000) return Math.round(d / 3600000) + " giờ trước";
    if (d < 7 * 86400000) return Math.round(d / 86400000) + " ngày trước";
    const dt = new Date(t); const p = (n) => String(n).padStart(2, "0");
    return p(dt.getDate()) + "/" + p(dt.getMonth() + 1) + "/" + dt.getFullYear();
  }
  // Clock time (HH:MM) of a message in Vietnam time (UTC+7), like the mockup ("Nguyễn Văn A · 17:18").
  // Forced to Asia/Ho_Chi_Minh so it's correct regardless of the machine timezone (the stored `at` is UTC).
  function supportClock(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    try {
      return new Date(t).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });
    } catch {
      const dt = new Date(t); const p = (n) => String(n).padStart(2, "0");
      return p(dt.getHours()) + ":" + p(dt.getMinutes());
    }
  }
  function supportStatusStyle(status) {
    const s = fold(String(status || ""));
    if (/answered|replied|tra loi/.test(s)) return { key: "answered", label: "Đã trả lời", color: "var(--ok-text)", bg: "var(--ok-soft)", border: "var(--ok-border)" };
    if (/closed|close|resolved|done|dong|giai quyet/.test(s)) return { key: "closed", label: "Đã đóng", color: "var(--text-3)", bg: "var(--surface-3)", border: "var(--border)" };
    if (/pending|wait|cho/.test(s)) return { key: "pending", label: "Chờ", color: "#b45309", bg: "#fff7ed", border: "#fed7aa" };
    return { key: "open", label: "Đang mở", color: "var(--brand)", bg: "var(--brand-soft)", border: "var(--brand-border)" };
  }
  function supportPrioLabel(prio) {
    const p = fold(String(prio || ""));
    if (/high|cao|urgent|gap/.test(p)) return "Cao";
    if (/low|thap/.test(p)) return "Thấp";
    return "Trung bình";
  }

  // Live-chat conversations (App Server "Chat trực tiếp" tab) = supportTickets with channel="livechat",
  // each a messages[] thread. The agent replies append to the thread via the atomic /api/admin/livechat.
  function supportChatBodyHtml(chats) {
    const selected = chats.find((c) => c.userId === selectedChatUserId) || chats[0] || null;
    const listHtml = chats.length ? chats.map((c) => {
      const sel = selected && c.userId === selected.userId;
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const last = msgs[msgs.length - 1];
      const waiting = c.lastFrom === "user";
      const preview = last ? (last.from === "agent" ? "Bạn: " : "") + String(last.text || "").slice(0, 46) : "(chưa có tin)";
      return `<div data-centrix-server-action="select-chat" data-chat-user="${escapeHtml(c.userId)}" style="padding:13px 14px;border:1px solid ${sel ? "var(--brand-border)" : "var(--border-soft)"};border-radius:12px;background:${sel ? "var(--brand-soft)" : "var(--surface-2)"};cursor:pointer;">`
        + `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><span style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(supportUserLabel(c.userId))}</span>${waiting ? `<span title="Chờ trả lời" style="flex-shrink:0;width:9px;height:9px;border-radius:50%;background:#ef4444;"></span>` : `<span style="flex-shrink:0;font-size:11px;color:var(--text-3);">${escapeHtml(supportRelTime(c.updatedAt))}</span>`}</div>`
        + `<div style="font-size:12px;color:var(--text-3);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(preview)}</div></div>`;
    }).join("") : `<div style="padding:34px 6px;text-align:center;font-size:13px;color:var(--text-3);">Chưa có cuộc chat nào.</div>`;

    let thread;
    if (!selected) {
      thread = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:340px;font-size:13px;color:var(--text-3);">Chọn một cuộc chat để trả lời.</div>`;
    } else {
      const msgs = Array.isArray(selected.messages) ? selected.messages : [];
      const chatUserName = supportUserLabel(selected.userId);
      // Each message shows a "Tên · HH:MM" header above the bubble (matching the support thread mockup).
      const bubbles = msgs.length ? msgs.map((m) => {
        const agent = m.from === "agent";
        const who = agent ? "Hỗ trợ" : chatUserName;
        const clock = supportClock(m.at);
        return `<div style="display:flex;flex-direction:column;gap:4px;align-items:${agent ? "flex-end" : "flex-start"};max-width:80%;align-self:${agent ? "flex-end" : "flex-start"};">`
          + `<div style="font-size:11px;color:var(--text-3);padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${escapeHtml(who)}${clock ? " · " + escapeHtml(clock) : ""}</div>`
          + `<div style="background:${agent ? "var(--brand)" : "var(--surface-2)"};color:${agent ? "#fff" : "var(--text)"};border:${agent ? "none" : "1px solid var(--border-soft)"};border-radius:${agent ? "12px 12px 4px 12px" : "12px 12px 12px 4px"};padding:9px 12px;font-size:13px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(String(m.text || ""))}</div>`
          + `</div>`;
      }).join("") : `<div style="text-align:center;color:var(--text-3);font-size:12.5px;padding:20px;">Khách chưa gửi tin nhắn nào.</div>`;
      thread = `<div style="display:flex;flex-direction:column;gap:12px;height:100%;">`
        + `<div style="border-bottom:1px solid var(--border-soft);padding-bottom:12px;"><div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(supportUserLabel(selected.userId))}</div><div style="font-size:12px;color:var(--text-3);margin-top:2px;">Chat trực tiếp · ${msgs.length} tin nhắn</div></div>`
        + `<div id="centrix-chat-scroll" class="cx-scroll" style="display:flex;flex-direction:column;gap:9px;flex:1;overflow:auto;min-height:0;">${bubbles}</div>`
        + `<div style="display:flex;gap:9px;align-items:center;border-top:1px solid var(--border-soft);padding-top:12px;"><input id="centrix-chat-reply" type="text" placeholder="Nhập tin nhắn trả lời khách…" style="flex:1;height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font-size:13.5px;padding:0 13px;"><button type="button" data-centrix-server-action="send-chat-msg" data-chat-user="${escapeHtml(selected.userId)}" style="height:42px;border:0;border-radius:10px;background:var(--brand);color:#fff;font-weight:800;font-size:13.5px;cursor:pointer;padding:0 18px;">Gửi</button></div>`
        + `</div>`;
    }
    const CHAT_H = "height:min(620px, calc(100vh - 250px));min-height:380px;box-sizing:border-box;";
    return `<div style="display:grid;grid-template-columns:340px 1fr;gap:18px;align-items:stretch;">`
      + `<div style="${CHAT_H}background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);padding:18px;display:flex;flex-direction:column;gap:11px;"><div style="font-size:15px;font-weight:800;color:var(--text);flex-shrink:0;">Cuộc trò chuyện</div><div class="cx-scroll" style="display:flex;flex-direction:column;gap:9px;flex:1;min-height:0;overflow:auto;">${listHtml}</div></div>`
      + `<div style="${CHAT_H}background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);padding:20px 22px;">${thread}</div>`
      + `</div>`;
  }

  function supportTicketBodyHtml(all) {
    const filtered = supportFilter === "all" ? all : all.filter((t) => supportStatusStyle(t.status).key === supportFilter);
    const selected = filtered.find((t) => t.id === selectedSupportTicketId)
      || all.find((t) => t.id === selectedSupportTicketId) || filtered[0] || null;
    const segs = [["all", "Tất cả"], ["open", "Đang mở"], ["pending", "Chờ"], ["answered", "Đã trả lời"], ["closed", "Đã đóng"]];
    const segHtml = segs.map(([k, label]) => {
      const on = supportFilter === k;
      return `<button type="button" data-centrix-server-action="filter-tickets" data-filter="${k}" style="border:0;border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;color:${on ? "var(--brand)" : "var(--text-3)"};background:${on ? "var(--brand-soft)" : "transparent"};">${label}</button>`;
    }).join("");
    const listHtml = filtered.length ? filtered.map((t) => {
      const st = supportStatusStyle(t.status);
      const sel = selected && t.id === selected.id;
      return `<div data-centrix-server-action="select-ticket" data-ticket-id="${escapeHtml(t.id)}" style="padding:13px 14px;border:1px solid ${sel ? "var(--brand-border)" : "var(--border-soft)"};border-radius:12px;background:${sel ? "var(--brand-soft)" : "var(--surface-2)"};cursor:pointer;">`
        + `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><span style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.subject || "Yêu cầu hỗ trợ")}</span><span style="flex-shrink:0;font-size:11px;font-weight:700;color:${st.color};background:${st.bg};border:1px solid ${st.border};border-radius:999px;padding:2px 9px;">${st.label}</span></div>`
        + `<div style="font-size:12px;color:var(--text-3);margin-top:5px;">${escapeHtml(supportUserLabel(t.userId))} · ${supportPrioLabel(t.priority)} · ${escapeHtml(supportRelTime(t.updatedAt || t.createdAt))}</div></div>`;
    }).join("") : `<div style="padding:34px 6px;text-align:center;font-size:13px;color:var(--text-3);">Chưa có ticket hỗ trợ nào${supportFilter !== "all" ? " khớp bộ lọc" : ""}.</div>`;
    let detailHtml;
    if (!selected) {
      detailHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:300px;font-size:13px;color:var(--text-3);">Chọn một ticket để xem chi tiết.</div>`;
    } else {
      const st = supportStatusStyle(selected.status);
      const replyHtml = selected.reply
        ? `<div style="align-self:flex-end;max-width:80%;background:var(--brand);color:#fff;border-radius:12px 12px 4px 12px;padding:10px 13px;font-size:13px;line-height:1.5;">${escapeHtml(selected.reply)}<div style="font-size:10.5px;opacity:.85;margin-top:4px;">CentriX${selected.repliedAt ? " · " + escapeHtml(supportRelTime(selected.repliedAt)) : ""}</div></div>`
        : "";
      detailHtml = `<div style="display:flex;flex-direction:column;gap:14px;height:100%;">`
        + `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border-soft);padding-bottom:14px;"><div style="min-width:0;"><div style="font-size:17px;font-weight:700;color:var(--text);">${escapeHtml(selected.subject || "Yêu cầu hỗ trợ")}</div><div style="font-size:12.5px;color:var(--text-3);margin-top:3px;">${escapeHtml(supportUserLabel(selected.userId))} · ${supportPrioLabel(selected.priority)} · ${escapeHtml(supportRelTime(selected.createdAt))}</div></div><span style="flex-shrink:0;font-size:11px;font-weight:700;color:${st.color};background:${st.bg};border:1px solid ${st.border};border-radius:999px;padding:3px 10px;">${st.label}</span></div>`
        + `<div style="display:flex;flex-direction:column;gap:10px;flex:1;overflow:auto;"><div style="align-self:flex-start;max-width:80%;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:12px 12px 12px 4px;padding:10px 13px;font-size:13px;color:var(--text);line-height:1.5;white-space:pre-wrap;">${escapeHtml(selected.message || "(không có nội dung)")}</div>${replyHtml}</div>`
        + `<div style="display:flex;gap:9px;align-items:center;border-top:1px solid var(--border-soft);padding-top:13px;"><input id="centrix-support-reply" type="text" placeholder="Nhập trả lời gửi cho khách…" style="flex:1;height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font-size:13.5px;padding:0 13px;"><button type="button" data-centrix-server-action="reply-ticket" data-ticket-id="${escapeHtml(selected.id)}" style="height:42px;border:0;border-radius:10px;background:var(--brand);color:#fff;font-weight:800;font-size:13.5px;cursor:pointer;padding:0 18px;white-space:nowrap;">Gửi</button>`
        + (st.key !== "closed" ? `<button type="button" data-centrix-server-action="close-ticket-row" data-ticket-id="${escapeHtml(selected.id)}" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text-2);font-weight:700;font-size:13px;cursor:pointer;padding:0 14px;white-space:nowrap;">Đóng</button>` : "")
        + `</div></div>`;
    }
    return `<div style="display:grid;grid-template-columns:380px 1fr;gap:18px;align-items:start;">`
      + `<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);padding:20px 20px;display:flex;flex-direction:column;gap:13px;"><div style="font-size:16px;font-weight:800;color:var(--text);">Ticket hỗ trợ</div><div style="display:flex;gap:6px;flex-wrap:wrap;">${segHtml}</div><div class="cx-scroll" style="display:flex;flex-direction:column;gap:9px;max-height:520px;overflow:auto;padding-right:2px;">${listHtml}</div></div>`
      + `<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);padding:22px 24px;min-height:420px;">${detailHtml}</div>`
      + `</div>`;
  }

  function mountSupportPanel(options = {}) {
    const screen = findSupportScreen();
    if (!screen) return false;
    const all = supportTicketsAll();
    const formTickets = all.filter((t) => t.channel !== "livechat");
    const chats = all.filter((t) => t.channel === "livechat")
      .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || "") || 0) - (Date.parse(a.updatedAt || a.createdAt || "") || 0));
    const waitingChats = chats.filter((c) => c.lastFrom === "user").length;
    const chatHash = chats.map((c) => c.id + ":" + ((c.messages || []).length) + ":" + (c.updatedAt || "")).join(",");
    const key = `${supportTab}|${state.updatedAt}|${supportFilter}|${selectedSupportTicketId}|${selectedChatUserId}|${formTickets.length}|${chatHash}`;
    if (!options.force && screen.dataset.centrixSupportMount === key) return true;
    screen.dataset.centrixSupportMount = key;

    // Preserve the chat reading position across re-renders: snap to newest on a new message / send / open,
    // but DON'T yank the agent down if they've scrolled up to read older messages.
    const prevScroll = screen.querySelector("#centrix-chat-scroll");
    const hadScroll = !!prevScroll;
    const prevAtBottom = prevScroll ? (prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 80) : true;
    const prevTop = prevScroll ? prevScroll.scrollTop : 0;

    const tabBtn = (k, label, count) => `<button type="button" data-centrix-server-action="switch-support-tab" data-tab="${k}" style="border:0;border-radius:9px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;color:${supportTab === k ? "#fff" : "var(--text-2)"};background:${supportTab === k ? "var(--brand)" : "var(--surface-2)"};">${label}${count ? ` <span style="opacity:.85;">(${count})</span>` : ""}</button>`;
    const tabs = `<div style="display:flex;gap:8px;">${tabBtn("chat", "Chat trực tiếp", waitingChats || "")}${tabBtn("ticket", "Ticket", formTickets.length || "")}</div>`;
    const sub = supportTab === "chat"
      ? `<div style="font-size:13px;color:var(--text-2);margin-top:4px;">${chats.length} cuộc chat · <strong style="color:var(--brand);">${waitingChats}</strong> đang chờ trả lời</div>`
      : `<div style="font-size:13px;color:var(--text-2);margin-top:4px;">${formTickets.length} ticket</div>`;
    const body = supportTab === "chat" ? supportChatBodyHtml(chats) : supportTicketBodyHtml(formTickets);
    screen.innerHTML = `
      <div data-centrix-support-root="1" style="display:flex;flex-direction:column;gap:16px;">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div><div style="font-size:21px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Hỗ trợ</div>${sub}</div>
          ${tabs}
        </div>
        ${body}
      </div>`;
    if (supportTab === "chat") {
      const sc = screen.querySelector("#centrix-chat-scroll");
      if (sc) sc.scrollTop = (!hadScroll || prevAtBottom || options.force) ? sc.scrollHeight : prevTop;
    }
    return true;
  }

  function _mountSupportPanel_legacy_unused(options = {}) {
    const screen = findSupportScreen();
    if (!screen) return false;
    const all = supportTicketsAll();
    const filtered = supportFilter === "all" ? all : all.filter((t) => supportStatusStyle(t.status).key === supportFilter);
    const selected = filtered.find((t) => t.id === selectedSupportTicketId)
      || all.find((t) => t.id === selectedSupportTicketId) || filtered[0] || null;
    const key = `${state.updatedAt}|${supportFilter}|${selected ? selected.id : ""}|${all.length}`;
    if (!options.force && screen.dataset.centrixSupportMount === key) return true;
    screen.dataset.centrixSupportMount = key;

    const openCount = all.filter((t) => supportStatusStyle(t.status).key !== "closed").length;
    const segs = [["all", "Tất cả"], ["open", "Đang mở"], ["pending", "Chờ"], ["answered", "Đã trả lời"], ["closed", "Đã đóng"]];
    const segHtml = segs.map(([k, label]) => {
      const on = supportFilter === k;
      return `<button type="button" data-centrix-server-action="filter-tickets" data-filter="${k}" style="border:0;border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;color:${on ? "var(--brand)" : "var(--text-3)"};background:${on ? "var(--brand-soft)" : "transparent"};">${label}</button>`;
    }).join("");

    const listHtml = filtered.length ? filtered.map((t) => {
      const st = supportStatusStyle(t.status);
      const sel = selected && t.id === selected.id;
      return `<div data-centrix-server-action="select-ticket" data-ticket-id="${escapeHtml(t.id)}" style="padding:13px 14px;border:1px solid ${sel ? "var(--brand-border)" : "var(--border-soft)"};border-radius:12px;background:${sel ? "var(--brand-soft)" : "var(--surface-2)"};cursor:pointer;">`
        + `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><span style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t.subject || "Yêu cầu hỗ trợ")}</span><span style="flex-shrink:0;font-size:11px;font-weight:700;color:${st.color};background:${st.bg};border:1px solid ${st.border};border-radius:999px;padding:2px 9px;">${st.label}</span></div>`
        + `<div style="font-size:12px;color:var(--text-3);margin-top:5px;">${escapeHtml(supportUserLabel(t.userId))} · ${supportPrioLabel(t.priority)} · ${escapeHtml(supportRelTime(t.updatedAt || t.createdAt))}</div></div>`;
    }).join("") : `<div style="padding:34px 6px;text-align:center;font-size:13px;color:var(--text-3);">Chưa có ticket hỗ trợ nào${supportFilter !== "all" ? " khớp bộ lọc" : ""}.</div>`;

    let detailHtml;
    if (!selected) {
      detailHtml = `<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:300px;font-size:13px;color:var(--text-3);">Chọn một ticket để xem chi tiết.</div>`;
    } else {
      const st = supportStatusStyle(selected.status);
      const replyHtml = selected.reply
        ? `<div style="align-self:flex-end;max-width:80%;background:var(--brand);color:#fff;border-radius:12px 12px 4px 12px;padding:10px 13px;font-size:13px;line-height:1.5;">${escapeHtml(selected.reply)}<div style="font-size:10.5px;opacity:.85;margin-top:4px;">CentriX${selected.repliedAt ? " · " + escapeHtml(supportRelTime(selected.repliedAt)) : ""}</div></div>`
        : "";
      detailHtml = `<div style="display:flex;flex-direction:column;gap:14px;height:100%;">`
        + `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border-soft);padding-bottom:14px;"><div style="min-width:0;"><div style="font-size:17px;font-weight:700;color:var(--text);">${escapeHtml(selected.subject || "Yêu cầu hỗ trợ")}</div><div style="font-size:12.5px;color:var(--text-3);margin-top:3px;">${escapeHtml(supportUserLabel(selected.userId))} · ${supportPrioLabel(selected.priority)} · ${escapeHtml(supportRelTime(selected.createdAt))}</div></div><span style="flex-shrink:0;font-size:11px;font-weight:700;color:${st.color};background:${st.bg};border:1px solid ${st.border};border-radius:999px;padding:3px 10px;">${st.label}</span></div>`
        + `<div style="display:flex;flex-direction:column;gap:10px;flex:1;overflow:auto;"><div style="align-self:flex-start;max-width:80%;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:12px 12px 12px 4px;padding:10px 13px;font-size:13px;color:var(--text);line-height:1.5;white-space:pre-wrap;">${escapeHtml(selected.message || "(không có nội dung)")}</div>${replyHtml}</div>`
        + `<div style="display:flex;gap:9px;align-items:center;border-top:1px solid var(--border-soft);padding-top:13px;"><input id="centrix-support-reply" type="text" placeholder="Nhập trả lời gửi cho khách…" style="flex:1;height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font-size:13.5px;padding:0 13px;"><button type="button" data-centrix-server-action="reply-ticket" data-ticket-id="${escapeHtml(selected.id)}" style="height:42px;border:0;border-radius:10px;background:var(--brand);color:#fff;font-weight:800;font-size:13.5px;cursor:pointer;padding:0 18px;white-space:nowrap;">Gửi</button>`
        + (st.key !== "closed" ? `<button type="button" data-centrix-server-action="close-ticket-row" data-ticket-id="${escapeHtml(selected.id)}" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text-2);font-weight:700;font-size:13px;cursor:pointer;padding:0 14px;white-space:nowrap;">Đóng</button>` : "")
        + `</div></div>`;
    }

    screen.innerHTML = `
      <div data-centrix-support-root="1" style="display:flex;flex-direction:column;gap:16px;">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div><div style="font-size:21px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Hỗ trợ — Ticket</div><div style="font-size:13px;color:var(--text-2);margin-top:4px;">${all.length} ticket · <strong style="color:var(--brand);">${openCount}</strong> đang mở</div></div>
        </div>
        <div style="display:grid;grid-template-columns:380px 1fr;gap:18px;align-items:start;">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);padding:20px 20px;display:flex;flex-direction:column;gap:13px;">
            <div style="font-size:16px;font-weight:800;color:var(--text);">Ticket hỗ trợ</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">${segHtml}</div>
            <div class="cx-scroll" style="display:flex;flex-direction:column;gap:9px;max-height:520px;overflow:auto;padding-right:2px;">${listHtml}</div>
          </div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);padding:22px 24px;min-height:420px;">${detailHtml}</div>
        </div>
      </div>`;
    return true;
  }

  function scheduleSupportPanel() {
    registerBodyTick(mountSupportPanel);
    for (const delayMs of [300, 900, 1800, 3200]) setTimeout(mountSupportPanel, delayMs);
  }

  // ── "Tổ chức B2B" admin panel ─────────────────────────────────────────────────────────────────────
  // The static org screen (data-screen-label="Tổ chức B2B") ships a DEMO org list (o1/o2…) + a fake
  // expandable detail. Replace it (like mountSupportPanel) with the REAL orgs from
  // state.portal.organizations + members/departments + real fund/wallet balances from
  // state.creditWallets (orgfund-<orgId>, orgdept-<orgId>-<deptId>, member userId). Create stays via the
  // existing openCreateOrgModal/createOrgFromUi (3 POSTs to /api/admin/portal, owner gets orgRole:"owner").
  let selectedOrgId = "";
  let orgSearchQ = "";
  let orgStatusFilter = "all";
  const ORG_AVATAR_PALETTE = ["#ea7a3c", "#4f5bd5", "#12a594", "#e0457b", "#7c3aed", "#1f9d6b", "#3b82f6", "#d6356f", "#0ea5e9", "#c2410c"];

  function findOrgScreen() {
    // Match the org-list screen ONLY ("to chuc b2b") — NOT "Giao dịch theo tổ chức" (folds to a different string).
    return visibleScreens().find((screen) => fold(screen.getAttribute("data-screen-label")).includes("to chuc b2b")) || null;
  }
  function orgWallet(userId) { return (state.creditWallets || []).find((row) => row.userId === userId) || null; }
  function orgWalletBal(userId) { const w = orgWallet(userId); return w ? Number(w.balance || 0) : 0; }
  function orgWalletAdded(userId) { const w = orgWallet(userId); return w ? Number(w.lifetimeAdded || 0) : 0; }
  function orgWalletSpent(userId) { const w = orgWallet(userId); return w ? Number(w.lifetimeSpent || 0) : 0; }
  function orgFmtCr(n) { return (Number(n) || 0).toLocaleString("vi-VN"); }
  function orgInitials(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    return ((parts[0] && parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
  }
  function orgAvatarColor(seed) {
    let h = 0; const s = String(seed || "");
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return ORG_AVATAR_PALETTE[h % ORG_AVATAR_PALETTE.length];
  }
  function orgShortDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso); if (isNaN(d.getTime())) return "—";
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return p(d.getDate()) + "/" + p(d.getMonth() + 1);
  }
  function orgB2bStatusStyle(status) {
    const s = fold(String(status || "active"));
    if (/(suspend|tam ngung|disabled|inactive|khoa)/.test(s)) return { key: "suspend", label: "Tạm ngưng", color: "var(--danger-text,#b91c1c)", bg: "var(--danger-soft,#fee2e2)", border: "var(--danger-border,#fecaca)", dot: "var(--danger,#ef4444)" };
    if (/(pending|cho duyet|^cho$)/.test(s)) return { key: "pending", label: "Chờ duyệt", color: "#b45309", bg: "#fff7ed", border: "#fed7aa", dot: "#f59e0b" };
    return { key: "active", label: "Đang hoạt động", color: "var(--ok-text,#15803d)", bg: "var(--ok-soft,#dcfce7)", border: "var(--ok-border,#bbf7d0)", dot: "var(--ok,#22c55e)" };
  }
  function orgRoleBadge(orgRole) {
    const r = String(orgRole || "").toLowerCase();
    if (r === "owner") return { label: "Chủ sở hữu", color: "var(--brand)", bg: "var(--brand-soft)", border: "var(--brand-border)" };
    if (r === "admin") return { label: "Quản trị", color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" };
    return { label: "Thành viên", color: "var(--text-2)", bg: "var(--surface-3,#f1f5f9)", border: "var(--border)" };
  }
  // Real fund stats from the org's wallets: pool = total funded (lifetimeAdded), consumed = sum of members'
  // real spend (lifetimeSpent), rem = pool - consumed. Falls back to current balance when never funded.
  function orgFundStats(orgId, orgMembers) {
    const added = orgWalletAdded("orgfund-" + orgId);
    const fundBal = orgWalletBal("orgfund-" + orgId);
    const pool = added > 0 ? added : fundBal;
    const consumed = orgMembers.reduce((sum, m) => sum + orgWalletSpent(m.userId), 0);
    return { pool, consumed, rem: Math.max(0, pool - consumed), fundBal };
  }

  // Live search filter (no re-mount → the search box keeps focus): toggle row display by data-org-search.
  function applyOrgSearchFilter(screen) {
    const q = fold(orgSearchQ.trim());
    let shown = 0;
    screen.querySelectorAll("[data-org-row]").forEach((row) => {
      const match = !q || (row.getAttribute("data-org-search") || "").includes(q);
      row.style.display = match ? "" : "none";
      if (match) shown += 1;
    });
    const empty = screen.querySelector("[data-org-empty]");
    if (empty) empty.style.display = shown ? "none" : "";
  }
  function onOrgSearchInput(e) { orgSearchQ = e.target.value || ""; applyOrgSearchFilter(findOrgScreen() || document); }

  function mountOrgPanel(options = {}) {
    const screen = findOrgScreen();
    if (!screen) return false;
    const allOrgs = (state.portal && Array.isArray(state.portal.organizations)) ? state.portal.organizations : null;
    if (!allOrgs) return false; // portal not loaded yet — leave the design's rows until real data lands
    const members = (state.portal && state.portal.members) || [];
    const departments = (state.portal && state.portal.departments) || [];
    if (selectedOrgId && !allOrgs.some((o) => o.id === selectedOrgId)) selectedOrgId = "";
    const orgs = orgStatusFilter === "all" ? allOrgs : allOrgs.filter((o) => orgB2bStatusStyle(o.status).key === orgStatusFilter);
    const key = `${state.updatedAt}|${allOrgs.length}|${members.length}|${departments.length}|${(state.creditWallets || []).length}|${selectedOrgId}|${orgStatusFilter}`;
    if (!options.force && screen.dataset.centrixOrgMount === key) { applyOrgSearchFilter(screen); return true; }
    screen.dataset.centrixOrgMount = key;

    const HCOLS = "grid-template-columns:30px minmax(220px,1fr) 150px 50px 132px;";
    const chips = [["all", "Tất cả"], ["active", "Đang hoạt động"], ["suspend", "Tạm ngưng"], ["pending", "Chờ duyệt"]]
      .map(([k, label]) => {
        const on = orgStatusFilter === k;
        return `<div data-centrix-server-action="filter-org" data-org-status="${k}" style="font-size:12.5px;font-weight:600;padding:7px 13px;border-radius:8px;cursor:pointer;color:${on ? "var(--brand)" : "var(--text-3)"};background:${on ? "var(--brand-soft)" : "var(--surface-2)"};border:1px solid ${on ? "var(--brand-border)" : "var(--border)"};">${label}</div>`;
      }).join("");

    const rowsHtml = orgs.map((org) => {
      const orgMembers = members.filter((m) => m.orgId === org.id);
      const fs = orgFundStats(org.id, orgMembers);
      const st = orgB2bStatusStyle(org.status);
      const open = org.id === selectedOrgId;
      const searchText = fold(`${org.name || ""} ${org.mst || ""} ${org.plan || ""} ${org.id}`);
      const head = `<div data-centrix-server-action="select-org" data-org-id="${escapeHtml(org.id)}" style="display:grid;${HCOLS}gap:14px;align-items:center;padding:14px 12px;cursor:pointer;background:${open ? "var(--surface-2)" : "transparent"};">`
        + `<div style="color:var(--text-3);font-size:16px;">${open ? "▾" : "▸"}</div>`
        + `<div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(org.name || org.id)}</div><div style="display:flex;align-items:center;gap:8px;margin-top:3px;">${org.mst ? `<span style="font-family:ui-monospace,Consolas,monospace;font-size:11px;font-weight:600;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:5px;padding:1px 7px;">${escapeHtml(org.mst)}</span>` : ""}<span style="font-size:11.5px;color:var(--text-3);">${escapeHtml(org.plan || "Doanh nghiệp")}</span></div></div>`
        + `<div><div style="font-size:13.5px;font-weight:700;color:var(--text);">${orgFmtCr(fs.pool)} <span style="font-size:11px;color:var(--text-3);font-weight:400;">cr</span></div><div style="font-size:11.5px;color:var(--text-3);">còn ${orgFmtCr(fs.rem)}</div></div>`
        + `<div style="text-align:center;font-size:13px;color:var(--text-2);font-weight:600;">${orgMembers.length}</div>`
        + `<div><span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:${st.color};background:${st.bg};border:1px solid ${st.border};border-radius:999px;padding:4px 11px;white-space:nowrap;"><span style="width:6px;height:6px;border-radius:50%;background:${st.dot};"></span>${st.label}</span></div>`
        + `</div>`;
      const detail = open ? orgDetailHtml(org, orgMembers, departments.filter((d) => d.orgId === org.id), fs, st) : "";
      return `<div data-org-row data-org-search="${escapeHtml(searchText)}" style="border-bottom:1px solid var(--border-soft);">${head}${detail}</div>`;
    }).join("");
    const emptyHtml = `<div data-org-empty style="display:${orgs.length ? "none" : ""};padding:40px 6px;text-align:center;font-size:13px;color:var(--text-3);">${allOrgs.length ? "Không có tổ chức nào khớp bộ lọc." : "Chưa có tổ chức nào. Bấm “Tạo tổ chức” để tạo tổ chức đầu tiên."}</div>`;

    screen.innerHTML = `
      <div data-centrix-org-root="1" style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="padding:24px 26px;border-bottom:1px solid var(--border-soft);display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
          <div><div style="font-size:21px;font-weight:700;color:var(--text);">Tổ chức (B2B)</div><div style="font-size:13.5px;color:var(--text-2);margin-top:5px;"><b style="color:var(--text);">${allOrgs.length}</b> tổ chức · quỹ chung, thành viên &amp; can thiệp thủ công (Manual Override)</div></div>
          <button type="button" data-centrix-server-action="create-org" style="display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:9px;padding:10px 17px;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);flex-shrink:0;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>Tạo tổ chức</button>
        </div>
        <div style="padding:16px 26px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--border-soft);">
          <div style="position:relative;flex:1;min-width:220px;"><span style="position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--text-3);font-size:14px;pointer-events:none;">&#9906;</span><input id="cx-org-search" value="${escapeHtml(orgSearchQ)}" placeholder="Tìm tên tổ chức, mã số thuế, gói…" style="width:100%;font-size:13.5px;color:var(--text);background:var(--surface-2);border:1px solid var(--border);border-radius:9px;padding:10px 13px 10px 36px;box-sizing:border-box;" /></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">${chips}</div>
        </div>
        <div style="padding:0 26px;"><div style="display:grid;${HCOLS}gap:14px;align-items:center;padding:12px;border-bottom:1px solid var(--border);background:var(--surface-2);border-radius:8px 8px 0 0;font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;"><span></span><span>Tổ chức</span><span>Quỹ chung</span><span style="text-align:center;">NV</span><span>Trạng thái</span></div></div>
        <div class="cx-scroll" style="padding:0 26px 8px;max-height:62vh;overflow:auto;">${rowsHtml}${emptyHtml}</div>
      </div>`;
    const si = screen.querySelector("#cx-org-search");
    if (si) { si.addEventListener("input", onOrgSearchInput); }
    applyOrgSearchFilter(screen);
    return true;
  }

  // Expanded detail for one org (matches the design's inline expand): Manual Override status + 4 stat cards
  // (Quỹ chung / Đã tiêu thụ / Còn lại / Thành viên) + department budget bars + the member table.
  function orgDetailHtml(org, orgMembers, orgDepts, fs, st) {
    const statusActions = [["active", "Kích hoạt"], ["suspend", "Tạm ngưng"], ["pending", "Chờ duyệt"]]
      .filter(([k]) => k !== st.key)
      .map(([k, label]) => `<button type="button" data-centrix-server-action="set-org-status" data-org-id="${escapeHtml(org.id)}" data-org-status="${k}" style="font-size:12.5px;font-weight:700;color:var(--danger);background:transparent;border:1px dashed var(--danger-border);border-radius:9px;padding:8px 14px;cursor:pointer;white-space:nowrap;">${label}</button>`).join("");
    const deleteBtn = `<button type="button" data-centrix-server-action="delete-org" data-org-id="${escapeHtml(org.id)}" style="font-size:12.5px;font-weight:700;color:#fff;background:var(--danger,#ef4444);border:none;border-radius:9px;padding:8px 14px;cursor:pointer;white-space:nowrap;">Xóa tổ chức</button>`;
    const card = (label, value, color) => `<div style="background:var(--surface);border:1px solid var(--border-soft);border-radius:11px;padding:13px 15px;"><div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;">${label}</div><div style="font-size:19px;font-weight:700;color:${color};margin-top:5px;">${value}</div></div>`;
    const cards = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">`
      + card("Quỹ chung", orgFmtCr(fs.pool), "var(--text)")
      + card("Đã tiêu thụ", orgFmtCr(fs.consumed), "var(--warn-text,#b45309)")
      + card("Còn lại", orgFmtCr(fs.rem), "var(--ok-text,#15803d)")
      + card("Thành viên", String(orgMembers.length), "var(--text)")
      + `</div>`;
    const deptHtml = orgDepts.length ? orgDepts.map((d) => {
      const alloc = orgWalletAdded("orgdept-" + org.id + "-" + d.id);
      const used = orgWalletSpent("orgdept-" + org.id + "-" + d.id);
      const deptMembers = orgMembers.filter((m) => m.departmentId === d.id);
      const mgr = orgMembers.find((m) => m.userId === d.managerUserId) || deptMembers.find((m) => ["owner", "admin"].includes(String(m.orgRole || "").toLowerCase()));
      const w = alloc > 0 ? Math.min(100, Math.round((used / alloc) * 100)) : 0;
      return `<div style="display:flex;align-items:center;gap:14px;background:var(--surface);border:1px solid var(--border-soft);border-radius:11px;padding:11px 14px;"><div style="width:180px;flex-shrink:0;min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(d.name || "Phòng ban")}</div><div style="font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">QL: ${escapeHtml(mgr ? (mgr.name || mgr.userId) : "—")} · ${deptMembers.length} NV</div></div><div style="flex:1;height:8px;border-radius:5px;background:var(--surface-3,#f1f5f9);overflow:hidden;"><div style="height:100%;width:${w}%;background:var(--brand);border-radius:5px;"></div></div><div style="font-size:12.5px;color:var(--text-2);width:150px;text-align:right;flex-shrink:0;">${orgFmtCr(used)} / ${orgFmtCr(alloc)} cr</div></div>`;
    }).join("") : `<div style="font-size:12.5px;color:var(--text-3);padding:4px 2px;">Chưa có phòng ban.</div>`;
    const peopleHtml = orgMembers.length ? orgMembers.map((m) => {
      const dept = orgDepts.find((d) => d.id === m.departmentId);
      const rb = orgRoleBadge(m.orgRole);
      const w = orgWallet(m.userId);
      return `<div style="display:grid;grid-template-columns:minmax(150px,1.4fr) 1.4fr 120px 104px 88px 78px;gap:12px;padding:11px 14px;border-bottom:1px solid var(--border-soft);align-items:center;">`
        + `<div style="display:flex;align-items:center;gap:9px;min-width:0;"><div style="width:28px;height:28px;border-radius:50%;background:${orgAvatarColor(m.userId || m.name)};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:11px;flex-shrink:0;">${escapeHtml(orgInitials(m.name || m.email))}</div><div style="min-width:0;"><div style="font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.name || m.userId)}</div><div style="font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.role || rb.label)}</div></div></div>`
        + `<div style="min-width:0;font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.email || m.userId)}</div>`
        + `<span style="font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(dept ? dept.name : "—")}</span>`
        + `<span><span style="font-size:10.5px;font-weight:700;color:${rb.color};background:${rb.bg};border:1px solid ${rb.border};border-radius:6px;padding:2px 8px;">${rb.label}</span></span>`
        + `<span style="text-align:right;font-size:12.5px;font-weight:600;color:var(--text);">${orgFmtCr(orgWalletSpent(m.userId))}</span>`
        + `<span style="text-align:right;font-size:11.5px;color:var(--text-3);">${orgShortDate(w ? w.updatedAt : "")}</span>`
        + `</div>`;
    }).join("") : `<div style="padding:16px 14px;text-align:center;font-size:12.5px;color:var(--text-3);">Chưa có thành viên — thêm thành viên ở App User (chủ tổ chức) hoặc tạo tổ chức gắn user.</div>`;
    return `<div style="padding:18px 14px 22px;background:var(--surface-2);">`
      + `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;"><div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--text);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>Manual Override · đặt trạng thái</div><div style="display:flex;gap:8px;flex-wrap:wrap;">${statusActions}${deleteBtn}</div></div>`
      + cards
      + `<div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;margin-bottom:11px;">Phòng ban &amp; nhân sự</div>`
      + `<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px;">${deptHtml}</div>`
      + `<div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;margin-bottom:11px;">Người dùng · ${orgMembers.length} thành viên</div>`
      + `<div style="background:var(--surface);border:1px solid var(--border-soft);border-radius:11px;overflow:hidden;margin-bottom:14px;">`
      + `<div style="display:grid;grid-template-columns:minmax(150px,1.4fr) 1.4fr 120px 104px 88px 78px;gap:12px;padding:10px 14px;background:var(--surface-2);border-bottom:1px solid var(--border-soft);font-size:10px;font-weight:700;color:var(--label);letter-spacing:.05em;text-transform:uppercase;"><span>Nhân sự</span><span>Email</span><span>Phòng ban</span><span>Vai trò</span><span style="text-align:right;">Đã dùng</span><span style="text-align:right;">Gần nhất</span></div>`
      + peopleHtml
      + `</div>`
      + `<div style="display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--text-3);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>Số liệu quỹ &amp; tiêu thụ đọc trực tiếp từ ví credit (orgfund/orgdept/thành viên) — dữ liệu thật.</div>`
      + `</div>`;
  }

  async function setOrgStatus(orgId, status) {
    return runAction("set org status", async () => {
      const org = ((state.portal && state.portal.organizations) || []).find((o) => o.id === orgId);
      if (!org) throw new Error("Không tìm thấy tổ chức");
      await postJson("/api/admin/portal", { section: "organizations", record: { ...org, status } });
      return { type: "set-org-status", orgId, status };
    });
  }

  // Styled delete-confirm modal (replaces the ugly native window.confirm) — danger icon + impact summary.
  function closeDeleteOrgModal() { const el = document.getElementById("centrix-delete-org-modal"); if (el) el.remove(); }
  function openDeleteOrgModal(orgId) {
    if (!orgId || document.getElementById("centrix-delete-org-modal")) return;
    const org = ((state.portal && state.portal.organizations) || []).find((o) => o.id === orgId);
    if (!org) return;
    const mem = ((state.portal && state.portal.members) || []).filter((m) => m.orgId === orgId).length;
    const dep = ((state.portal && state.portal.departments) || []).filter((d) => d.orgId === orgId).length;
    const overlay = document.createElement("div");
    overlay.id = "centrix-delete-org-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);";
    overlay.innerHTML = `<div role="dialog" style="width:420px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:24px;">`
      + `<div style="display:flex;align-items:center;gap:13px;"><div style="width:42px;height:42px;border-radius:50%;background:var(--danger-soft,#fee2e2);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--danger,#ef4444)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></div><div style="min-width:0;"><div style="font:900 17px 'Segoe UI',system-ui,sans-serif;color:var(--text,#0f172a);">Xóa tổ chức?</div><div style="font:600 13px 'Segoe UI',system-ui,sans-serif;color:var(--text-2,#64748b);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(org.name || orgId)}</div></div></div>`
      + `<div style="font:500 13px/1.55 'Segoe UI',system-ui,sans-serif;color:var(--text-2,#475569);margin-top:16px;background:var(--surface-2,#f8fafc);border:1px solid var(--border-soft,#eef2f7);border-radius:11px;padding:13px 15px;">Sẽ gỡ <b style="color:var(--text,#0f172a);">${mem} thành viên</b> + <b style="color:var(--text,#0f172a);">${dep} phòng ban</b> của tổ chức. Ví quỹ (orgfund/orgdept) giữ nguyên. <b style="color:var(--danger,#ef4444);">Không thể hoàn tác.</b></div>`
      + `<div style="display:flex;gap:10px;margin-top:20px;"><button type="button" data-centrix-server-action="delete-org-cancel" style="flex:1;height:42px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px 'Segoe UI',system-ui,sans-serif;cursor:pointer;">Hủy</button><button type="button" data-centrix-server-action="delete-org-confirm" data-org-id="${escapeHtml(orgId)}" style="flex:1.2;height:42px;border:0;border-radius:10px;background:var(--danger,#ef4444);color:#fff;font:900 13px 'Segoe UI',system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(239,68,68,.3);">Xóa tổ chức</button></div>`
      + `</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeDeleteOrgModal(); });
  }

  // Delete an org + its members + departments (no ghost org-admin / orphan rows). Credit wallets stay
  // (harmless orphans). Confirmation is the custom modal above; the list updates INSTANTLY from the portal
  // the delete POST returns + a forced mount, then runAction's refresh() reconciles in the background.
  async function deleteOrgById(orgId) {
    const org = ((state.portal && state.portal.organizations) || []).find((o) => o.id === orgId);
    if (!org) return null;
    const mem = ((state.portal && state.portal.members) || []).filter((m) => m.orgId === orgId);
    const dep = ((state.portal && state.portal.departments) || []).filter((d) => d.orgId === orgId);
    return runAction("delete org", async () => {
      for (const m of mem) { if (m.id) await postJson("/api/admin/portal", { section: "members", action: "delete", id: m.id }); }
      for (const d of dep) { if (d.id) await postJson("/api/admin/portal", { section: "departments", action: "delete", id: d.id }); }
      const result = await postJson("/api/admin/portal", { section: "organizations", action: "delete", id: orgId });
      if (result && result.portal) state.portal = result.portal; // freshest portal → list drops the org at once
      if (selectedOrgId === orgId) selectedOrgId = "";
      mountOrgPanel({ force: true });
      showActionToast(`Đã xóa tổ chức "${org.name || orgId}" (gỡ ${mem.length} thành viên, ${dep.length} phòng ban)`);
      return { type: "delete-org", orgId };
    });
  }

  // ── Admin "Xóa tài khoản" — HARD delete a user + ALL data. Same danger-modal styling as the org delete.
  function closeDeleteUserModal() { const el = document.getElementById("centrix-delete-user-modal"); if (el) el.remove(); }
  function openDeleteUserModal(userId) {
    if (!userId || document.getElementById("centrix-delete-user-modal")) return;
    const user = (state.users || []).find((u) => u.id === userId);
    const name = (user && (user.name || user.email || user.id)) || userId;
    const email = (user && user.email) || "";
    const overlay = cxModalOverlay("centrix-delete-user-modal");
    const body = cxModalNoteBox(`Xóa vĩnh viễn tài khoản này + <b style="color:var(--text,#0f172a);">toàn bộ dữ liệu</b> (ví/credit, giao dịch, đơn hàng, hóa đơn, phiên, lịch sử…). <b style="color:var(--danger,#ef4444);">Không thể hoàn tác.</b>`, "danger");
    const footer = cxModalFooter({
      cancelAttrs: 'data-centrix-server-action="delete-user-cancel"',
      confirmLabel: "Xóa tài khoản", confirmTone: "danger",
      confirmAttrs: `data-centrix-server-action="delete-user-confirm" data-cx-delete-user-id="${escapeHtml(userId)}"`
    });
    overlay.innerHTML = cxModalCard({ tone: "danger", icon: "trash", title: "Xóa tài khoản?", subtitle: `${escapeHtml(name)}${email ? " · " + escapeHtml(email) : ""}`, width: 430, body, footer });
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeDeleteUserModal(); });
  }

  async function deleteUserById(userId) {
    const user = (state.users || []).find((u) => u.id === userId);
    const label = (user && (user.name || user.email || user.id)) || userId;
    return runAction("xóa tài khoản", async () => {
      try {
        await postJson("/api/admin/accounts/delete", { userId });
      } catch (e) {
        const msg = String((e && e.message) || "");
        // The backend refuses org owners (409 → postJson throws its error string). Show a friendly hint.
        if (/chu\s*to\s*chuc|org.?owner/i.test(msg)) throw new Error(`Không thể xóa "${label}": tài khoản đang là chủ tổ chức — hãy giải tán/chuyển quyền tổ chức trước.`);
        throw e;
      }
      // Drop from the local pool immediately so the list updates at once; runAction's refresh() reconciles.
      state.users = (state.users || []).filter((u) => u.id !== userId);
      applyRealUserPool();
      showActionToast(`Đã xóa tài khoản "${escapeHtml(label)}" và toàn bộ dữ liệu`);
      return { type: "delete-user", userId };
    });
  }

  function scheduleOrgPanel() {
    registerBodyTick(mountOrgPanel);
    for (const delayMs of [300, 900, 1800, 3200]) setTimeout(mountOrgPanel, delayMs);
  }

  // ── "Gói nạp credit" (credit top-up packages) — App Server admin CRUD; App User syncs via portal ─────
  // Packages live in the shared portal store (portal.creditPackages); create/update/delete go through the
  // existing /api/admin/portal upsert (same path orgs/depts use). App User's portal summary exposes the
  // ENABLED ones to its "Mua credit" screen, so an edit here appears there on its next refresh. No Docker
  // rebuild (it's JSON portal data). We replace the static "Gói nạp credit" screen with a live CRUD panel.
  function findCreditPackageScreen() {
    return visibleScreens().find((screen) => fold(screen.getAttribute("data-screen-label")).includes("goi nap credit")) || null;
  }
  function creditPackagesAll() {
    const p = state.portal || {};
    const list = Array.isArray(p.creditPackages) ? p.creditPackages
      : (p.portal && Array.isArray(p.portal.creditPackages)) ? p.portal.creditPackages : [];
    return list.slice().sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
  }
  function pkgMoney(v, cur) {
    return (Number(v) || 0).toLocaleString("vi-VN") + " " + (cur || "VND");
  }
  function mountCreditPackagePanel(options = {}) {
    const screen = findCreditPackageScreen();
    if (!screen) return false;
    const pkgs = creditPackagesAll();
    const key = `${state.updatedAt}|${pkgs.map((p) => p.id + ":" + (p.updatedAt || "") + ":" + (p.enabled !== false ? 1 : 0) + ":" + (p.highlight ? 1 : 0)).join(",")}`;
    if (!options.force && screen.dataset.centrixPkgMount === key) return true;
    screen.dataset.centrixPkgMount = key;
    const cards = pkgs.length ? pkgs.map((p) => {
      const total = (Number(p.credits) || 0) + (Number(p.bonusCredits) || 0);
      const off = p.enabled === false;
      return `<div style="border:1px solid ${p.highlight ? "var(--brand-border)" : "var(--border-soft)"};border-radius:14px;padding:16px 18px;background:${p.highlight ? "var(--brand-soft)" : "var(--surface-2)"};opacity:${off ? ".55" : "1"};display:flex;flex-direction:column;gap:8px;">`
        + `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><div style="font-size:15px;font-weight:800;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.name || "Gói credit")}</div><div style="display:flex;gap:5px;flex-shrink:0;">${p.highlight ? `<span style="font-size:10.5px;font-weight:700;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:999px;padding:2px 8px;">Nổi bật</span>` : ""}${off ? `<span style="font-size:10.5px;font-weight:700;color:var(--text-3);background:var(--surface-3);border:1px solid var(--border);border-radius:999px;padding:2px 8px;">Tắt</span>` : ""}</div></div>`
        + `<div style="font-size:22px;font-weight:900;color:var(--text);letter-spacing:-.01em;">${Number(total).toLocaleString("vi-VN")} <span style="font-size:13px;font-weight:700;color:var(--text-3);">credit</span></div>`
        + `<div style="font-size:13px;color:var(--text-2);">${escapeHtml(pkgMoney(p.price, p.currency))}${Number(p.bonusCredits) > 0 ? ` · <span style="color:#16a34a;font-weight:700;">+${Number(p.bonusCredits).toLocaleString("vi-VN")} bonus</span>` : ""}</div>`
        + `<div style="display:flex;gap:8px;margin-top:6px;"><button type="button" data-centrix-server-action="package-edit" data-pkg-id="${escapeHtml(p.id)}" style="flex:1;height:36px;border:1px solid var(--field-border);border-radius:9px;background:var(--surface);color:var(--text);font-weight:700;font-size:12.5px;cursor:pointer;">Sửa</button><button type="button" data-centrix-server-action="package-delete" data-pkg-id="${escapeHtml(p.id)}" style="height:36px;border:1px solid #fecaca;border-radius:9px;background:var(--surface);color:#dc2626;font-weight:700;font-size:12.5px;cursor:pointer;padding:0 14px;">Xóa</button></div>`
        + `</div>`;
    }).join("") : `<div style="grid-column:1/-1;padding:44px;text-align:center;color:var(--text-3);font-size:13.5px;">Chưa có gói nạp credit nào. Bấm "+ Tạo gói" để thêm.</div>`;
    screen.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px;">
        <div><div style="font-size:21px;font-weight:700;color:var(--text);">Gói nạp credit</div><div style="font-size:13.5px;color:var(--text-2);margin-top:5px;">Các gói credit khách mua lẻ. Tạo/sửa ở đây → App User cập nhật theo (chỉ gói đang bật).</div></div>
        <button type="button" data-centrix-server-action="package-create" style="font-size:13.5px;font-weight:700;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:10px 18px;cursor:pointer;white-space:nowrap;">+ Tạo gói</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;align-items:start;">${cards}</div>`;
    return true;
  }
  function scheduleCreditPackagePanel() {
    registerBodyTick(mountCreditPackagePanel);
    for (const delayMs of [300, 900, 1800, 3200]) setTimeout(mountCreditPackagePanel, delayMs);
  }
  function closePackageModal() { document.getElementById("centrix-package-modal")?.remove(); }
  function openPackageModal(record = null) {
    closePackageModal();
    const r = record || {};
    const fieldCss = "width:100%;height:40px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:600 13px Segoe UI,system-ui,sans-serif;padding:0 12px;box-sizing:border-box;";
    const labelCss = "display:flex;flex-direction:column;gap:6px;margin-top:13px;font:800 11px Segoe UI,system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;";
    const overlay = document.createElement("div");
    overlay.id = "centrix-package-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.dataset.pkgId = r.id || "";
    overlay.innerHTML = `
      <div role="dialog" style="width:440px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;max-height:calc(100vh - 60px);overflow:auto;box-sizing:border-box;">
        <div style="font:900 18px Segoe UI,system-ui,sans-serif;color:var(--text,#0f172a);">${r.id ? "Sửa gói nạp credit" : "Tạo gói nạp credit"}</div>
        <label style="${labelCss}">Tên gói <input id="cx-pkg-name" value="${escapeHtml(r.name || "")}" placeholder="vd: Gói 500 credit" style="${fieldCss}"></label>
        <div style="display:flex;gap:12px;"><label style="${labelCss}flex:1;">Credit <input id="cx-pkg-credits" type="number" min="0" value="${Number(r.credits) || 0}" style="${fieldCss}"></label><label style="${labelCss}flex:1;">Bonus credit <input id="cx-pkg-bonus" type="number" min="0" value="${Number(r.bonusCredits) || 0}" style="${fieldCss}"></label></div>
        <div style="display:flex;gap:12px;"><label style="${labelCss}flex:1.5;">Giá <input id="cx-pkg-price" type="number" min="0" value="${Number(r.price) || 0}" style="${fieldCss}"></label><label style="${labelCss}flex:1;">Tiền tệ <select id="cx-pkg-currency" style="${fieldCss}"><option value="VND"${(r.currency || "VND") === "VND" ? " selected" : ""}>VND</option><option value="USD"${r.currency === "USD" ? " selected" : ""}>USD</option></select></label></div>
        <div style="display:flex;gap:18px;margin-top:16px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:8px;font:700 13px Segoe UI,system-ui,sans-serif;color:var(--text-2);cursor:pointer;"><input id="cx-pkg-enabled" type="checkbox"${r.enabled !== false ? " checked" : ""}> Đang bật (hiện cho khách)</label>
          <label style="display:flex;align-items:center;gap:8px;font:700 13px Segoe UI,system-ui,sans-serif;color:var(--text-2);cursor:pointer;"><input id="cx-pkg-highlight" type="checkbox"${r.highlight ? " checked" : ""}> Nổi bật</label>
        </div>
        <label style="${labelCss}">Phân hạng gói <select id="cx-pkg-tier" style="${fieldCss}"><option value="personal"${String(r.tier || "personal") !== "org" ? " selected" : ""}>Cá nhân — hiện ở "Mua credit"</option><option value="org"${String(r.tier || "") === "org" ? " selected" : ""}>Tổ chức — hiện ở "Gói quỹ tổ chức" (B2B)</option></select></label>
        <div style="display:flex;gap:10px;margin-top:22px;">
          <button type="button" data-centrix-server-action="package-cancel" style="flex:1;height:42px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI,system-ui,sans-serif;cursor:pointer;">Hủy</button>
          <button type="button" data-centrix-server-action="package-submit" style="flex:1.4;height:42px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:900 13px Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));">${r.id ? "Lưu thay đổi" : "Tạo gói"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) closePackageModal(); });
    setTimeout(() => document.getElementById("cx-pkg-name")?.focus(), 50);
  }
  async function savePackageFromUi() {
    const overlay = document.getElementById("centrix-package-modal");
    const existingId = overlay?.dataset?.pkgId || "";
    return runAction("save package", async () => {
      const name = String(document.getElementById("cx-pkg-name")?.value || "").trim();
      if (!name) throw new Error("Cần nhập tên gói");
      const credits = Math.max(0, Math.round(Number(document.getElementById("cx-pkg-credits")?.value || 0)));
      const bonusCredits = Math.max(0, Math.round(Number(document.getElementById("cx-pkg-bonus")?.value || 0)));
      const price = Math.max(0, Math.round(Number(document.getElementById("cx-pkg-price")?.value || 0)));
      const currency = String(document.getElementById("cx-pkg-currency")?.value || "VND");
      const enabled = !!document.getElementById("cx-pkg-enabled")?.checked;
      const highlight = !!document.getElementById("cx-pkg-highlight")?.checked;
      const tier = String(document.getElementById("cx-pkg-tier")?.value || "personal") === "org" ? "org" : "personal";
      if (credits <= 0) throw new Error("Credit của gói phải lớn hơn 0");
      const id = existingId || `creditPackages-${Date.now().toString(36)}`;
      const result = await postJson("/api/admin/portal", {
        section: "creditPackages",
        record: { id, name, credits, bonusCredits, price, currency, enabled, highlight, tier }
      });
      if (result.portal) state.portal = result.portal;
      closePackageModal();
      mountCreditPackagePanel({ force: true });
      showActionToast(`Đã ${existingId ? "lưu" : "tạo"} gói "${name}" · App User sẽ cập nhật`);
      return { type: "save-package", id, name };
    });
  }
  async function deletePackageById(id) {
    if (!id) return null;
    return runAction("delete package", async () => {
      const result = await postJson("/api/admin/portal", { section: "creditPackages", action: "delete", id });
      if (result.portal) state.portal = result.portal;
      mountCreditPackagePanel({ force: true });
      showActionToast("Đã xóa gói nạp");
      return { type: "delete-package", id };
    });
  }

  // ── "Khuyến mãi" (promo / discount codes) — App Server admin CRUD; App User applies at checkout ───────
  // Promo codes live in the shared portal store (portal.promotions); create/update/delete go through the
  // same /api/admin/portal upsert. App User's portal summary exposes the ENABLED ones; its "Mua credit"
  // screen validates a typed code against them client-side + discounts the total. No Docker rebuild.
  function findPromoScreen() {
    return visibleScreens().find((screen) => fold(screen.getAttribute("data-screen-label")).includes("khuyen mai")) || null;
  }
  function promotionsAll() {
    const p = state.portal || {};
    const list = Array.isArray(p.promotions) ? p.promotions
      : (p.portal && Array.isArray(p.portal.promotions)) ? p.portal.promotions : [];
    return list.slice().sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
  }
  // Unified promo schema = { discountPercent, bonusCredit, discountAmount } — the SAME fields the App User
  // reads at checkout, so a code created/edited here maps 1:1. Legacy { type, value } kept as a fallback.
  function promoBenefitLabel(p) {
    const pct = Number(p.discountPercent) || 0;
    const amt = Number(p.discountAmount) || 0;
    const bonus = Number(p.bonusCredit) || 0;
    if (pct > 0) return "Giảm " + pct + "%";
    if (amt > 0) return "Giảm " + amt.toLocaleString("vi-VN") + "đ";
    if (bonus > 0) return "+" + bonus.toLocaleString("vi-VN") + " credit";
    const v = Number(p.value) || 0; // legacy
    if (p.type === "percent" && v) return "Giảm " + v + "%";
    if (p.type === "bonus" && v) return "+" + v.toLocaleString("vi-VN") + " credit";
    return v ? "Giảm " + v.toLocaleString("vi-VN") + "đ" : "—";
  }
  // Derive the modal's {type,value} from whichever benefit field a promo actually uses.
  function promoTypeValue(p) {
    if (Number(p.discountPercent) > 0) return { type: "percent", value: Number(p.discountPercent) };
    if (Number(p.discountAmount) > 0) return { type: "fixed", value: Number(p.discountAmount) };
    if (Number(p.bonusCredit) > 0) return { type: "bonus", value: Number(p.bonusCredit) };
    return { type: p.type || "percent", value: Number(p.value) || 0 };
  }
  function mountPromoPanel(options = {}) {
    const screen = findPromoScreen();
    if (!screen) return false;
    const promos = promotionsAll();
    const key = `${state.updatedAt}|${promos.map((p) => p.id + ":" + (p.updatedAt || "") + ":" + (p.enabled !== false ? 1 : 0)).join(",")}`;
    if (!options.force && screen.dataset.centrixPromoMount === key) return true;
    screen.dataset.centrixPromoMount = key;
    const cards = promos.length ? promos.map((p) => {
      const off = p.enabled === false;
      const expired = p.expiry && Number.isFinite(Date.parse(p.expiry)) && Date.parse(p.expiry) < Date.now();
      return `<div style="border:1px solid var(--border-soft);border-radius:14px;padding:16px 18px;background:var(--surface-2);opacity:${off || expired ? ".55" : "1"};display:flex;flex-direction:column;gap:8px;height:100%;box-sizing:border-box;">`
        + `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><span style="font-family:ui-monospace,Consolas,monospace;font-size:15px;font-weight:800;color:var(--brand);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.code || "—")}</span><div style="display:flex;gap:5px;flex-shrink:0;">${off ? `<span style="font-size:10.5px;font-weight:700;color:var(--text-3);background:var(--surface-3);border:1px solid var(--border);border-radius:999px;padding:2px 8px;">Tắt</span>` : ""}${expired ? `<span style="font-size:10.5px;font-weight:700;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:999px;padding:2px 8px;">Hết hạn</span>` : ""}</div></div>`
        + `<div style="font-size:18px;font-weight:900;color:var(--text);">${escapeHtml(promoBenefitLabel(p))}</div>`
        + (p.description ? `<div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(p.description)}</div>` : "")
        + (p.expiry ? `<div style="font-size:11.5px;color:var(--text-3);">HSD: ${escapeHtml(String(p.expiry).slice(0, 10))}</div>` : "")
        + `<div style="display:flex;gap:8px;margin-top:auto;padding-top:6px;"><button type="button" data-centrix-server-action="promo-edit" data-promo-id="${escapeHtml(p.id)}" style="flex:1;height:36px;border:1px solid var(--field-border);border-radius:9px;background:var(--surface);color:var(--text);font-weight:700;font-size:12.5px;cursor:pointer;">Sửa</button><button type="button" data-centrix-server-action="promo-delete" data-promo-id="${escapeHtml(p.id)}" style="height:36px;border:1px solid #fecaca;border-radius:9px;background:var(--surface);color:#dc2626;font-weight:700;font-size:12.5px;cursor:pointer;padding:0 14px;">Xóa</button></div>`
        + `</div>`;
    }).join("") : `<div style="grid-column:1/-1;padding:44px;text-align:center;color:var(--text-3);font-size:13.5px;">Chưa có mã giảm giá nào. Bấm "+ Tạo mã" để thêm.</div>`;
    screen.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px;">
        <div><div style="font-size:21px;font-weight:700;color:var(--text);">Khuyến mãi</div><div style="font-size:13.5px;color:var(--text-2);margin-top:5px;">Mã giảm giá cho khách. Tạo/sửa ở đây → App User áp dụng được (mã đang bật, chưa hết hạn).</div></div>
        <button type="button" data-centrix-server-action="promo-create" style="font-size:13.5px;font-weight:700;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:10px 18px;cursor:pointer;white-space:nowrap;">+ Tạo mã</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;align-items:stretch;">${cards}</div>`;
    return true;
  }
  function schedulePromoPanel() {
    registerBodyTick(mountPromoPanel);
    for (const delayMs of [300, 900, 1800, 3200]) setTimeout(mountPromoPanel, delayMs);
  }
  function closePromoModal() { document.getElementById("centrix-promo-modal")?.remove(); }
  function openPromoModal(record = null) {
    closePromoModal();
    const r = record || {};
    const fieldCss = "width:100%;height:40px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:600 13px Segoe UI,system-ui,sans-serif;padding:0 12px;box-sizing:border-box;";
    const labelCss = "display:flex;flex-direction:column;gap:6px;margin-top:13px;font:800 11px Segoe UI,system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;";
    const tv = promoTypeValue(r);
    const type = tv.type;
    const overlay = document.createElement("div");
    overlay.id = "centrix-promo-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.dataset.promoId = r.id || "";
    overlay.innerHTML = `
      <div role="dialog" style="width:440px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;max-height:calc(100vh - 60px);overflow:auto;box-sizing:border-box;">
        <div style="font:900 18px Segoe UI,system-ui,sans-serif;color:var(--text,#0f172a);">${r.id ? "Sửa mã giảm giá" : "Tạo mã giảm giá"}</div>
        <label style="${labelCss}">Mã code <input id="cx-promo-code" value="${escapeHtml(r.code || "")}" placeholder="vd: WELCOME50" style="${fieldCss}text-transform:uppercase;"></label>
        <div style="display:flex;gap:12px;"><label style="${labelCss}flex:1.3;">Loại <select id="cx-promo-type" style="${fieldCss}"><option value="percent"${type === "percent" ? " selected" : ""}>Giảm %</option><option value="fixed"${type === "fixed" ? " selected" : ""}>Giảm tiền (đ)</option><option value="bonus"${type === "bonus" ? " selected" : ""}>Tặng thêm credit</option></select></label><label style="${labelCss}flex:1;">Giá trị <input id="cx-promo-value" type="number" min="0" value="${tv.value}" style="${fieldCss}"></label></div>
        <label style="${labelCss}">Mô tả (tuỳ chọn) <input id="cx-promo-desc" value="${escapeHtml(r.description || "")}" placeholder="vd: Giảm 50% cho khách mới" style="${fieldCss}"></label>
        <label style="${labelCss}">Hết hạn (tuỳ chọn) <input id="cx-promo-expiry" type="date" value="${escapeHtml(String(r.expiry || "").slice(0, 10))}" style="${fieldCss}"></label>
        <div style="display:flex;gap:18px;margin-top:16px;">
          <label style="display:flex;align-items:center;gap:8px;font:700 13px Segoe UI,system-ui,sans-serif;color:var(--text-2);cursor:pointer;"><input id="cx-promo-enabled" type="checkbox"${r.enabled !== false ? " checked" : ""}> Đang bật (khách dùng được)</label>
        </div>
        <div style="display:flex;gap:10px;margin-top:22px;">
          <button type="button" data-centrix-server-action="promo-cancel" style="flex:1;height:42px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI,system-ui,sans-serif;cursor:pointer;">Hủy</button>
          <button type="button" data-centrix-server-action="promo-submit" style="flex:1.4;height:42px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:900 13px Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));">${r.id ? "Lưu thay đổi" : "Tạo mã"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) closePromoModal(); });
    setTimeout(() => document.getElementById("cx-promo-code")?.focus(), 50);
  }
  async function savePromoFromUi() {
    const overlay = document.getElementById("centrix-promo-modal");
    const existingId = overlay?.dataset?.promoId || "";
    return runAction("save promo", async () => {
      const code = String(document.getElementById("cx-promo-code")?.value || "").trim().toUpperCase();
      if (!code) throw new Error("Cần nhập mã code");
      const type = String(document.getElementById("cx-promo-type")?.value || "percent");
      const value = Math.max(0, Math.round(Number(document.getElementById("cx-promo-value")?.value || 0)));
      if (value <= 0) throw new Error("Giá trị phải lớn hơn 0");
      if (type === "percent" && value > 100) throw new Error("Giảm % không vượt quá 100");
      const description = String(document.getElementById("cx-promo-desc")?.value || "").trim();
      const expiryRaw = String(document.getElementById("cx-promo-expiry")?.value || "").trim();
      const expiry = expiryRaw ? expiryRaw + "T23:59:59Z" : "";
      const enabled = !!document.getElementById("cx-promo-enabled")?.checked;
      const id = existingId || `promotions-${Date.now().toString(36)}`;
      // Write the UNIFIED benefit fields the App User reads at checkout (discountPercent / discountAmount /
      // bonusCredit), zeroing the unused ones so a merge can't leave a stale benefit (the old FRIEND bug).
      const benefit = type === "percent" ? { discountPercent: value, discountAmount: 0, bonusCredit: 0 }
        : type === "fixed" ? { discountPercent: 0, discountAmount: value, bonusCredit: 0 }
        : { discountPercent: 0, discountAmount: 0, bonusCredit: value };
      const result = await postJson("/api/admin/portal", {
        section: "promotions",
        record: { id, code, type, value, ...benefit, title: promoBenefitLabel(benefit), description, expiry, enabled }
      });
      if (result.portal) state.portal = result.portal;
      closePromoModal();
      mountPromoPanel({ force: true });
      showActionToast(`Đã ${existingId ? "lưu" : "tạo"} mã "${code}" · App User áp dụng được`);
      return { type: "save-promo", id, code };
    });
  }
  async function deletePromoById(id) {
    if (!id) return null;
    return runAction("delete promo", async () => {
      const result = await postJson("/api/admin/portal", { section: "promotions", action: "delete", id });
      if (result.portal) state.portal = result.portal;
      mountPromoPanel({ force: true });
      showActionToast("Đã xóa mã giảm giá");
      return { type: "delete-promo", id };
    });
  }

  async function replyToTicket(id) {
    const input = document.getElementById("centrix-support-reply");
    const text = String((input && input.value) || "").trim();
    if (!text) { showActionToast("Nhập nội dung trả lời trước", "error"); return null; }
    return runAction("reply ticket", async () => {
      const latest = await getJson("/api/admin/portal");
      const ticket = (latest.portal?.supportTickets || []).find((r) => r.id === id);
      if (!ticket) throw new Error("Ticket không tồn tại");
      const result = await postJson("/api/admin/portal", {
        section: "supportTickets",
        record: { ...ticket, reply: text, repliedBy: currentActor(), repliedAt: new Date().toISOString(), status: "answered" }
      });
      selectedSupportTicketId = id;
      return { type: "reply-ticket", id, status: "answered", tickets: (result.portal?.supportTickets || []).length };
    });
  }

  async function closeTicketById(id) {
    return runAction("close ticket", async () => {
      const latest = await getJson("/api/admin/portal");
      const ticket = (latest.portal?.supportTickets || []).find((r) => r.id === id);
      if (!ticket) throw new Error("Ticket không tồn tại");
      const result = await postJson("/api/admin/portal", {
        section: "supportTickets",
        record: { ...ticket, status: "closed", closedBy: currentActor() }
      });
      selectedSupportTicketId = id;
      return { type: "close-ticket", id, status: "closed", tickets: (result.portal?.supportTickets || []).length };
    });
  }

  // Live chat: append an AGENT message to a user's thread via the atomic /api/admin/livechat (no race).
  async function sendAgentChatMessage(userId) {
    const input = document.getElementById("centrix-chat-reply");
    const text = String((input && input.value) || "").trim();
    if (!userId || !text) { showActionToast("Nhập tin nhắn trước", "error"); return null; }
    return runAction("chat reply", async () => {
      const result = await postJson("/api/admin/livechat", { userId, text });
      selectedChatUserId = userId;
      supportTab = "chat";
      if (result.portal) state.portal = result.portal;
      mountSupportPanel({ force: true });
      return { type: "chat-reply", userId };
    });
  }

  // Faster poll for the live chat while the Chat tab is open (the 30s refresh is too slow for chat).
  // In-flight guard: never let a slow portal read pile up — overlapping reads starve the Docker write
  // (the single-threaded DB serializes them) and make the agent's send abort. One poll at a time.
  let supportPollBusy = false;
  async function refreshSupportChatIfVisible() {
    if (document.hidden || supportPollBusy || supportTab !== "chat" || !findSupportScreen()) return;
    supportPollBusy = true;
    try {
      // LEAN poll: fetch ONLY the livechat threads (~KB) instead of the full 12MB portal → near-instant.
      const result = await getJson("/api/admin/livechat");
      if (result && Array.isArray(result.threads)) {
        const portal = state.portal || (state.portal = {});
        const others = (portal.supportTickets || []).filter((t) => !t || t.channel !== "livechat");
        portal.supportTickets = [...result.threads, ...others];
        mountSupportPanel();
      }
    } catch { /* keep polling */ } finally { supportPollBusy = false; }
  }

  // ── Thông báo góc phải-dưới: "Có N tin nhắn khách cần phản hồi" ─────────────────────────────────────
  // Đếm từ dữ liệu THẬT: chat livechat có lastFrom==="user" (khách gửi tin cuối, chưa ai trả lời) +
  // ticket đang mở/chờ (status open|pending). Poll nhẹ /api/admin/livechat (~KB) mỗi 15s để phát hiện tin
  // mới kể cả khi KHÔNG mở màn Hỗ trợ. Bấm toast → nhảy tới màn Hỗ trợ; nút × ẩn đến khi có tin MỚI.
  let supportNotifyDismissedSig = "";
  function supportNotifyItems() {
    const all = supportTicketsAll();
    const chats = all.filter((t) => t && t.channel === "livechat" && t.lastFrom === "user");
    const tickets = all.filter((t) => t && t.channel !== "livechat" && ["open", "pending"].includes(supportStatusStyle(t.status).key));
    return { chats, tickets, total: chats.length + tickets.length };
  }
  function supportNotifySignature(items) {
    const c = items.chats.map((t) => "c" + t.userId + ":" + (t.updatedAt || t.createdAt || "")).sort();
    const k = items.tickets.map((t) => "t" + t.id + ":" + (t.updatedAt || t.createdAt || "")).sort();
    return c.concat(k).join("|");
  }
  function ensureSupportNotifyStyles() {
    if (document.getElementById("centrix-support-notify-style")) return;
    const s = document.createElement("style");
    s.id = "centrix-support-notify-style";
    s.textContent = [
      '#centrix-support-notify{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:11px;max-width:340px;padding:12px 13px;background:var(--surface,#fff);border:1px solid var(--brand-border,#bfe0fc);border-left:4px solid #ef4444;border-radius:13px;box-shadow:0 14px 34px var(--shadow,rgba(15,23,42,.18));font-family:"Segoe UI",system-ui,sans-serif;color:var(--text,#0f172a);cursor:pointer;animation:cxSnIn .24s ease-out;}',
      '#centrix-support-notify:hover{border-color:var(--brand,#2563eb);}',
      '#centrix-support-notify .cx-sn-dot{width:11px;height:11px;border-radius:50%;background:#ef4444;flex-shrink:0;animation:cxSnPulse 1.6s ease-in-out infinite;}',
      '#centrix-support-notify .cx-sn-body{min-width:0;flex:1;line-height:1.35;}',
      '#centrix-support-notify .cx-sn-title{font-size:13px;font-weight:800;}',
      '#centrix-support-notify .cx-sn-sub{font-size:11.5px;font-weight:500;color:var(--text-2,#5b6677);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#centrix-support-notify .cx-sn-x{flex-shrink:0;align-self:flex-start;border:0;background:transparent;color:var(--text-3,#94a3b8);font-size:15px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px;}',
      '#centrix-support-notify .cx-sn-x:hover{background:var(--surface-2,#f1f5f9);color:var(--text,#0f172a);}',
      '@keyframes cxSnIn{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:none;}}',
      '@keyframes cxSnPulse{0%,100%{box-shadow:0 0 0 3px rgba(239,68,68,.18);}50%{box-shadow:0 0 0 7px rgba(239,68,68,.02);}}'
    ].join("");
    (document.head || document.documentElement).appendChild(s);
  }
  function removeSupportNotify() { const el = document.getElementById("centrix-support-notify"); if (el) el.remove(); }
  function openSupportFromNotify() {
    removeSupportNotify();
    const items = supportNotifyItems();
    supportTab = items.chats.length ? "chat" : "ticket";
    const row = navRowFor("support");
    if (row) clickNavRow(row);
    setTimeout(() => { try { mountSupportPanel({ force: true }); } catch (e) { /* ignore */ } }, 140);
  }
  function updateSupportNotify() {
    if (!document.body) return;
    if (document.getElementById("centrix-loading-veil")) { removeSupportNotify(); return; } // app chưa lộ diện
    if (staffActive() && !useMasterOverride && !staffLoggedIn) { removeSupportNotify(); return; } // chưa đăng nhập staff
    const items = supportNotifyItems();
    const onChatView = supportTab === "chat" && !!findSupportScreen(); // đang xem chat → không nhắc
    if (items.total <= 0 || onChatView) {
      removeSupportNotify();
      if (items.total <= 0) supportNotifyDismissedSig = "";
      return;
    }
    const sig = supportNotifySignature(items);
    if (sig && sig === supportNotifyDismissedSig) { removeSupportNotify(); return; } // đã ẩn tập này, chưa có tin mới
    ensureSupportNotifyStyles();
    let el = document.getElementById("centrix-support-notify");
    if (!el) {
      el = document.createElement("div");
      el.id = "centrix-support-notify";
      el.setAttribute("role", "alert");
      el.title = "Bấm để mở màn Hỗ trợ";
      el.addEventListener("click", openSupportFromNotify);
      document.body.appendChild(el);
    }
    const parts = [];
    if (items.chats.length) parts.push(items.chats.length + " chat");
    if (items.tickets.length) parts.push(items.tickets.length + " ticket");
    el.innerHTML =
      '<span class="cx-sn-dot"></span>'
      + '<div class="cx-sn-body"><div class="cx-sn-title">Có ' + items.total + ' tin nhắn khách cần phản hồi</div>'
      + '<div class="cx-sn-sub">' + escapeHtml(parts.join(" · ")) + ' — bấm để mở</div></div>'
      + '<button type="button" class="cx-sn-x" title="Ẩn nhắc (đến khi có tin mới)">×</button>';
    const x = el.querySelector(".cx-sn-x");
    if (x) x.addEventListener("click", (e) => { e.stopPropagation(); supportNotifyDismissedSig = sig; removeSupportNotify(); });
  }
  // Poll nhẹ (dùng chung guard supportPollBusy với chat-tab poll) để phát hiện tin khách mới ở MỌI màn.
  async function pollSupportNotify() {
    if (document.hidden) return;
    if (!supportPollBusy) {
      supportPollBusy = true;
      try {
        const result = await getJson("/api/admin/livechat");
        if (result && Array.isArray(result.threads)) {
          const portal = state.portal || (state.portal = {});
          const others = (portal.supportTickets || []).filter((t) => !t || t.channel !== "livechat");
          portal.supportTickets = [...result.threads, ...others];
        }
      } catch (e) { /* im lặng, thử lại lần sau */ } finally { supportPollBusy = false; }
    }
    updateSupportNotify();
  }

  function selectedLoaderService() {
    return state.services.find((service) => service.id === state.serviceBrowser.selectedServiceId) || state.services[0] || null;
  }

  function serviceExists(serviceId) {
    return Boolean(serviceId && state.services.some((service) => service.id === serviceId));
  }

  function activeModelTabServiceId() {
    const loaderId = loaderTabId();
    const candidates = [
      state.tabs.find((tab) => tab.tabId === loaderId),
      state.tabs.find((tab) => tab.visible && tab.serviceId && !tab.localUser),
      state.tabs.find((tab) => tab.serviceId && !tab.localUser)
    ];
    return candidates.find((tab) => serviceExists(tab?.serviceId))?.serviceId || "";
  }

  function latestObservedModelServiceId() {
    return (state.modelObservations || [])
      .filter((item) => serviceExists(item.serviceId))
      .slice()
      .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")) || Number(b.count || 0) - Number(a.count || 0))
      [0]?.serviceId || "";
  }

  function syncModelServiceSelection() {
    if (!state.services.length) {
      state.modelUi.serviceId = "";
      return false;
    }

    if (modelServiceTouchedThisSession && serviceExists(state.modelUi.serviceId)) {
      return false;
    }

    const next = [
      activeModelTabServiceId(),
      latestObservedModelServiceId(),
      state.modelUi.serviceId,
      state.services[0]?.id
    ].find(serviceExists) || state.services[0]?.id || "";

    if (!next || next === state.modelUi.serviceId) return false;
    state.modelUi.serviceId = next;
    localStorage.setItem("centrixServerModelServiceId", next);
    return true;
  }

  function selectedRuleService() {
    return state.services.find((service) => service.id === state.serviceBrowser.selectedRuleServiceId) || selectedLoaderService();
  }

  function selectedBrowserUser() {
    return state.users.find((user) => user.id === state.serviceBrowser.selectedUserId) || state.users[0] || null;
  }

  // The service whose browser the current sub-tab is working with: the rules tab edits the rule
  // service, the login tab the login service.
  function activeBrowserService() {
    return state.serviceBrowser.tab === "rules" ? selectedRuleService() : selectedLoaderService();
  }

  function anyLoaderTabOpen() {
    return (state.tabs || []).some((tab) => String(tab.tabId || "").startsWith("loader-"));
  }

  function loaderTabId() {
    // Per-service loader tab: each service gets its OWN admin browser ("loader-<serviceId>") instead of
    // a single shared "profile-loader". Previously all 12 services reused one tab, so opening ChatGPT
    // first made every other service's rule editor land on the ChatGPT browser. The id follows whichever
    // sub-tab (login/rules) is active so preview/select always target the right service.
    const service = activeBrowserService();
    const serviceId = service?.id
      || (state.serviceBrowser.tab === "rules" ? state.serviceBrowser.selectedRuleServiceId : state.serviceBrowser.selectedServiceId)
      || state.serviceBrowser.selectedServiceId
      || "default";
    const tabId = `loader-${serviceId}`;
    if (state.serviceBrowser.loaderTabId !== tabId) {
      state.serviceBrowser.loaderTabId = tabId;
      localStorage.setItem("centrixServerLoaderTab", tabId);
    }
    return tabId;
  }

  function loaderProfileId() {
    const clean = String(state.serviceBrowser.profileId || "default").trim() || "default";
    state.serviceBrowser.profileId = clean;
    localStorage.setItem("centrixServerLoaderProfile", clean);
    return clean;
  }

  function loaderApiPath(path) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("tabId", loaderTabId());
    if (token && !url.searchParams.get("token")) url.searchParams.set("token", token);
    return url.toString();
  }

  async function postLoader(path, payload = {}) {
    const tabId = loaderTabId();
    const response = await fetch(loaderApiPath(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CentriX-App-Key": "cxk_28db7719b795d4eaa5a4e00fcb057029a11130eea00ec39a8bbd1467ca2ae5f7" },
      cache: "no-store",
      body: JSON.stringify({ ...payload, tabId })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    if (result.state) {
      state.tabs = [
        ...state.tabs.filter((tab) => tab.tabId !== result.state.tabId),
        result.state
      ];
    }
    return result;
  }

  function currentLoaderState() {
    return state.tabs.find((tab) => tab.tabId === loaderTabId()) || null;
  }

  function setServiceBrowserTab(tab) {
    state.serviceBrowser.tab = tab === "rules" ? "rules" : "login";
    localStorage.setItem("centrixServerServiceBrowserTab", state.serviceBrowser.tab);
    mountServiceBrowserPanel({ force: true });
  }

  function syncLoaderUrlFromService() {
    const service = selectedLoaderService();
    const nextUrl = service?.loginUrl || service?.url || "";
    if (nextUrl) {
      state.serviceBrowser.url = nextUrl;
      localStorage.setItem("centrixServerLoaderUrl", nextUrl);
    }
  }

  async function ensureServiceBrowserData() {
    if (!state.services.length || !state.users.length) {
      await refresh();
    }

    if (!state.serviceBrowser.selectedServiceId && state.services.length) {
      state.serviceBrowser.selectedServiceId = state.services[0].id || "";
      localStorage.setItem("centrixServerLoaderServiceId", state.serviceBrowser.selectedServiceId);
    }
    if (!state.serviceBrowser.selectedRuleServiceId && state.services.length) {
      state.serviceBrowser.selectedRuleServiceId = state.serviceBrowser.selectedServiceId || state.services[0].id || "";
      localStorage.setItem("centrixServerRuleServiceId", state.serviceBrowser.selectedRuleServiceId);
    }
    if (!state.serviceBrowser.selectedUserId && state.users.length) {
      state.serviceBrowser.selectedUserId = state.users[0].id || "local-user";
      localStorage.setItem("centrixServerSelectedUser", state.serviceBrowser.selectedUserId);
    }
    if (!state.serviceBrowser.url) {
      syncLoaderUrlFromService();
    }
  }

  function userServiceVisible(userId, serviceId) {
    const user = state.users.find((item) => item.id === userId);
    const row = state.serviceVisibility.find((item) => item.userId === userId && item.serviceId === serviceId);
    if (row) return row.visible !== false;
    return user?.role === "loader" || user?.id === "local-user";
  }

  // Global service access (applies to ALL users). Uses the shared SERVICE_UI_RULE_USER_ID
  // record when present; otherwise defaults to "shown" for enabled services so the admin can
  // manage them from one place.
  function globalServiceVisible(serviceId) {
    const row = state.serviceVisibility.find((item) => item.userId === SERVICE_UI_RULE_USER_ID && item.serviceId === serviceId);
    if (row) return row.visible !== false;
    const service = state.services.find((item) => item.id === serviceId);
    return service ? service.enabled !== false : true;
  }

  function selectedUiRule() {
    const userId = selectedBrowserUser()?.id || state.serviceBrowser.selectedUserId || "local-user";
    const serviceId = selectedRuleService()?.id || state.serviceBrowser.selectedRuleServiceId || selectedLoaderService()?.id || "";
    const draft = uiRuleDrafts.get(uiRuleKey({ userId: SERVICE_UI_RULE_USER_ID, serviceId }));
    if (draft) return draft;
    return state.uiRules.find((rule) => rule.userId === SERVICE_UI_RULE_USER_ID && rule.serviceId === serviceId)
      || state.uiRules.find((rule) => rule.userId === userId && rule.serviceId === serviceId)
      || null;
  }

  function uiRuleKey(rule) {
    return `${rule?.userId || SERVICE_UI_RULE_USER_ID}:${rule?.serviceId || ""}`;
  }

  function upsertLocalUiRuleDraft(draft) {
    if (!draft?.serviceId) return null;
    if (!Array.isArray(state.uiRules)) state.uiRules = [];
    const key = uiRuleKey({ userId: SERVICE_UI_RULE_USER_ID, serviceId: draft.serviceId });
    const index = state.uiRules.findIndex((rule) => uiRuleKey(rule) === key);
    const existing = index >= 0 ? state.uiRules[index] : uiRuleDrafts.get(key);
    const normalized = {
      ...(existing || {}),
      schemaVersion: 1,
      userId: SERVICE_UI_RULE_USER_ID,
      serviceId: draft.serviceId,
      enabled: draft.enabled === true,
      hideSelectors: Array.isArray(draft.hideSelectors) ? draft.hideSelectors : [],
      hideRules: Array.isArray(draft.hideRules) ? draft.hideRules : [],
      replaceRules: Array.isArray(draft.replaceRules) ? draft.replaceRules : [],
      userScript: String(draft.userScript || "").replace(/\u0000/g, "").slice(0, 30000),
      updatedAt: new Date().toISOString()
    };
    if (index >= 0) {
      state.uiRules[index] = normalized;
    } else {
      state.uiRules.push(normalized);
    }
    uiRuleDrafts.set(key, normalized);
    return normalized;
  }

  function mergeLocalUiRuleDraftsIntoState() {
    if (!Array.isArray(state.uiRules)) state.uiRules = [];
    for (const draft of uiRuleDrafts.values()) {
      const key = uiRuleKey(draft);
      const index = state.uiRules.findIndex((rule) => uiRuleKey(rule) === key);
      if (index >= 0) {
        state.uiRules[index] = { ...state.uiRules[index], ...draft };
      } else {
        state.uiRules.push(draft);
      }
    }
  }

  function sanitizeSelectorLines(value) {
    return String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function normalizeReplaceRules(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((rule) => ({
            selector: String(rule.selector || "").trim(),
            text: String(rule.text || ""),
            matchText: String(rule.matchText || ""),
            enabled: rule.enabled !== false
          }))
          .filter((rule) => rule.selector);
      }
    } catch {
      // Fall through to line parser below.
    }
    return raw.split(/\r?\n/)
      .map((line) => {
        const [selector, ...textParts] = line.split("=>");
        return {
          selector: String(selector || "").trim(),
          text: textParts.join("=>").trim(),
          enabled: true
        };
      })
      .filter((rule) => rule.selector);
  }

  function replaceRulesText(rule) {
    const rules = Array.isArray(rule?.replaceRules) ? rule.replaceRules : [];
    return rules.length ? JSON.stringify(rules, null, 2) : "";
  }

  function userScriptText(rule) {
    return String(rule?.userScript || "");
  }

  function hideRulesText(rule) {
    const rules = Array.isArray(rule?.hideRules) ? rule.hideRules : [];
    return rules.length ? JSON.stringify(rules, null, 2) : "";
  }

  function normalizeHideRules(value) {
    const raw = String(value || "").trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed
          .filter((rule) => rule && typeof rule === "object" && (rule.primarySelector || rule.selector))
          .map((rule) => ({
            ...rule,
            primarySelector: String(rule.primarySelector || rule.selector || "").trim(),
            anchorSelector: String(rule.anchorSelector || "").trim(),
            enabled: rule.enabled !== false
          }))
        : [];
    } catch {
      return [];
    }
  }

  function ruleDraftFromDom() {
    return {
      userId: SERVICE_UI_RULE_USER_ID,
      serviceId: document.getElementById("centrix-browser-rule-service-select")?.value || selectedRuleService()?.id || selectedLoaderService()?.id || "",
      enabled: document.getElementById("centrix-browser-rule-enabled")?.checked === true,
      hideSelectors: sanitizeSelectorLines(document.getElementById("centrix-browser-hide-selectors")?.value || ""),
      hideRules: normalizeHideRules(document.getElementById("centrix-browser-hide-rules")?.value || ""),
      replaceRules: normalizeReplaceRules(document.getElementById("centrix-browser-replace-rules")?.value || ""),
      customCss: document.getElementById("centrix-browser-custom-css")?.value || "",
      userScript: document.getElementById("centrix-browser-user-script")?.value || ""
    };
  }

  async function openLoaderBrowserDirect() {
    await ensureServiceBrowserData();
    const onRules = state.serviceBrowser.tab === "rules";
    const service = activeBrowserService();
    // On the rules tab always open the SELECTED service's own url — never the editable login-url field
    // (that belongs to the login tab and may still hold ChatGPT). On the login tab honor the field.
    const url = String(
      (!onRules ? document.getElementById("centrix-loader-url")?.value : "")
      || service?.loginUrl || service?.url || ""
    ).trim();
    if (!url) throw new Error(`Thiếu URL cho dịch vụ ${service?.name || service?.id || ""}`.trim());
    if (!onRules) {
      state.serviceBrowser.url = url;
      localStorage.setItem("centrixServerLoaderUrl", url);
    }
    state.serviceBrowser.profileId = document.getElementById("centrix-loader-profile")?.value || loaderProfileId();

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
    await refreshTabsOnly();
    mountServiceBrowserPanel({ force: true });
    return { type: "open-loader", tabId: result.state?.tabId || loaderTabId(), serviceId: service?.id || "" };
  }

  async function openLoaderBrowser() {
    return runAction("open loader browser", openLoaderBrowserDirect);
  }

  async function loaderCommand(action) {
    const paths = {
      show: "/api/show",
      back: "/api/back",
      forward: "/api/forward",
      reload: "/api/reload",
      close: "/api/close"
    };
    return runAction(`loader ${action}`, async () => {
      await ensureServiceBrowserData();
      await refreshTabsOnly().catch(() => []);
      if (!currentLoaderState()) {
        if (action === "show") {
          return openLoaderBrowserDirect();
        }
        if (action === "close") {
          return { type: "loader-close", skipped: true, reason: "no-loader-tab" };
        }
        throw new Error("Chưa mở browser nạp. Bấm Mở browser nạp trước.");
      }
      const result = await postLoader(paths[action] || "/api/show");
      if (action === "close") {
        state.tabs = state.tabs.filter((tab) => tab.tabId !== loaderTabId());
      }
      await refreshTabsOnly();
      mountServiceBrowserPanel({ force: true });
      return { type: `loader-${action}`, state: result.state || null };
    });
  }

  async function refreshTabsOnly() {
    const result = await getJson("/api/tabs");
    state.tabs = result.tabs || [];
    syncModelServiceSelection();
    setDataset();
    return state.tabs;
  }

  async function setUserServiceAccess(serviceId, visibleValue) {
    // Service access is global: a service shown/hidden here applies to ALL users (and future
    // ones), saved under the shared SERVICE_UI_RULE_USER_ID scope — the consumer
    // (serviceVisibleForUser) gives this global record precedence over any per-user record.
    const userId = SERVICE_UI_RULE_USER_ID;
    return runAction("set service access", async () => {
      const result = await postJson("/api/users/service", { userId, serviceId, visible: visibleValue !== false });
      state.serviceVisibility = result.db?.serviceVisibility || state.serviceVisibility;
      mountServiceBrowserPanel({ force: true });
      return { type: "service-access", userId, serviceId, visible: visibleValue !== false };
    });
  }

  // Manual blocked links — textarea format, one rule per line: "matchType | pattern | serviceId | message".
  // A line whose first field is not a known matchType is taken as a bare pattern (prefix match, all services).
  const BLOCKED_LINK_MATCH_TYPES = new Set(["exact", "prefix", "origin", "glob"]);
  function parseBlockedLinksText(text) {
    const out = [];
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("|").map((s) => s.trim());
      let matchType, pattern, serviceId = "", message = "";
      if (BLOCKED_LINK_MATCH_TYPES.has((parts[0] || "").toLowerCase())) {
        matchType = parts[0].toLowerCase();
        pattern = parts[1] || "";
        serviceId = parts[2] || "";
        message = parts.slice(3).join(" | ").trim();
      } else {
        matchType = "prefix";
        pattern = line;
      }
      if (!pattern) continue;
      out.push({ matchType, serviceId, pattern, message, enabled: true });
    }
    return out;
  }
  function blockedLinksText() {
    const rows = (state.blockedLinks || []).filter((r) => (r.userId || SERVICE_UI_RULE_USER_ID) === SERVICE_UI_RULE_USER_ID);
    return rows.map((r) => {
      const bits = [r.matchType || "prefix", r.pattern || ""];
      if (r.serviceId || r.message) bits.push(r.serviceId || "");
      if (r.message) bits.push(r.message);
      return bits.join(" | ");
    }).join("\n");
  }
  async function saveBlockedLinks() {
    return runAction("save blocked links", async () => {
      const textarea = document.getElementById("centrix-blocked-links");
      const links = parseBlockedLinksText(textarea ? textarea.value : "");
      const result = await postJson("/api/users/blocked-links", { userId: SERVICE_UI_RULE_USER_ID, links });
      state.blockedLinks = result.db?.blockedLinks || state.blockedLinks;
      mountServiceBrowserPanel({ force: true });
      return { type: "save-blocked-links", count: links.length };
    });
  }

  async function saveUiRules() {
    return runAction("save ui rules", async () => {
      const draft = ruleDraftFromDom();
      upsertLocalUiRuleDraft(draft);
      const result = await postJson("/api/users/ui-rules", draft);
      state.uiRules = result.db?.uiRules || state.uiRules;
      state.uiRuleReports = result.db?.uiRuleReports || state.uiRuleReports;
      state.uiCacheItems = result.db?.uiCacheItems || state.uiCacheItems;
      upsertLocalUiRuleDraft(draft);
      mountServiceBrowserPanel({ force: true });
      return { type: "save-ui-rules", userId: draft.userId, serviceId: draft.serviceId, hideSelectors: draft.hideSelectors.length, hideRules: draft.hideRules.length, replaceRules: draft.replaceRules.length, userScript: draft.userScript.trim() ? 1 : 0 };
    });
  }

  async function previewUiRules() {
    return runAction("preview ui rules", async () => {
      await ensureServiceBrowserData();
      const draft = ruleDraftFromDom();
      upsertLocalUiRuleDraft(draft);
      await refreshTabsOnly().catch(() => []);
      if (!currentLoaderState()) await openLoaderBrowserDirect();
      const result = await postLoader("/api/users/ui-rules/preview", draft);
      state.uiRules = result.db?.uiRules || state.uiRules;
      state.uiRuleReports = result.db?.uiRuleReports || state.uiRuleReports;
      upsertLocalUiRuleDraft(draft);
      mountServiceBrowserPanel({ force: true });
      return { type: "preview-ui-rules", preview: result.preview || {} };
    });
  }

  async function selectUiArea(action = "hide") {
    return runAction(`select ${action} area`, async () => {
      await ensureServiceBrowserData();
      await refreshTabsOnly().catch(() => []);
      if (!currentLoaderState()) await openLoaderBrowserDirect();
      const result = await postLoader("/api/users/ui-rules/select", { action, timeoutMs: 45000 });
      const selection = result.selection || {};
      if (!selection.ok || !selection.selector) throw new Error(selection.reason === "timeout" ? "Timeout selecting area" : "No selector selected");
      const enabledInput = document.getElementById("centrix-browser-rule-enabled");
      if (enabledInput) enabledInput.checked = true;
      if (action === "replace") {
        const input = document.getElementById("centrix-browser-replace-rules");
        const current = normalizeReplaceRules(input?.value || "");
        const text = String(document.getElementById("centrix-browser-visual-text")?.value || selection.text || "").trim();
        const next = [...current, { selector: selection.selector, text, matchText: selection.text || "", enabled: true }];
        if (input) input.value = JSON.stringify(next, null, 2);
      } else {
        const input = document.getElementById("centrix-browser-hide-selectors");
        const next = sanitizeSelectorLines(input?.value || "");
        if (!next.includes(selection.selector)) next.push(selection.selector);
        if (input) input.value = next.join("\n");
        const ruleInput = document.getElementById("centrix-browser-hide-rules");
        const rules = normalizeHideRules(ruleInput?.value || "");
        const draftRule = selection.ruleDraft || {
          primarySelector: selection.primarySelector || selection.selector,
          anchorSelector: selection.anchorSelector || "",
          fingerprint: selection.fingerprint || {},
          expectation: selection.expectation || { minMatches: 1 },
          action: "hide",
          failMode: "open",
          enabled: true
        };
        if (!rules.some((rule) => rule.primarySelector === draftRule.primarySelector)) rules.push(draftRule);
        if (ruleInput) ruleInput.value = JSON.stringify(rules, null, 2);
      }
      upsertLocalUiRuleDraft(ruleDraftFromDom());
      await previewUiRules();
      mountServiceBrowserPanel({ force: true });
      return { type: "select-ui-area", action, selector: selection.selector };
    });
  }

  function optionHtml(rows, selectedValue, labelFn) {
    return rows.map((row) => {
      const value = row.id || row.value || "";
      const label = labelFn ? labelFn(row) : (row.name || row.label || value);
      return `<option value="${escapeHtml(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
  }

  function findServiceBrowserScreen() {
    return visibleScreens().find((screen) => fold(screen.getAttribute("data-screen-label")).includes("trinh duyet dich vu")) || null;
  }

  // Per-service login status (Tier 1, cookie-based). Honest labels: cookie-presence => "chưa xác minh".
  function serviceLoginStyle(st) {
    const s = st && st.state;
    if (s === "in") {
      const verified = st.confidence === "verified";
      return { dot: "var(--ok)", color: "var(--ok-text)", bg: "rgba(16,185,129,.10)",
        label: verified ? ("Đã đăng nhập — " + (st.account || "")) : "Đã đăng nhập (cookie · chưa xác minh)" };
    }
    if (s === "out") return { dot: "var(--danger)", color: "var(--danger)", bg: "rgba(239,68,68,.07)", label: "Chưa đăng nhập" };
    return { dot: "var(--text-3)", color: "var(--text-3)", bg: "var(--surface-2)", label: "Chưa rõ — đang kiểm tra…" };
  }
  function renderServiceLoginStatusHtml() {
    const map = (state.serviceBrowser && state.serviceBrowser.loginStatus) || {};
    const services = (state.services || []).filter((s) => s && s.enabled !== false);
    if (!services.length) return "";
    const rows = services.map((svc) => {
      const d = serviceLoginStyle(map[svc.id]);
      return `<div style="display:grid;grid-template-columns:11px 1fr auto;gap:10px;align-items:center;padding:9px 11px;border:1px solid var(--border-soft);border-radius:10px;background:${d.bg};">`
        + `<span style="width:9px;height:9px;border-radius:50%;background:${d.dot};"></span>`
        + `<span style="min-width:0;"><strong style="display:block;font-size:12.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(svc.name || svc.id)}</strong><span style="display:block;font-size:11px;color:${d.color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(d.label)}</span></span>`
        + `<button type="button" data-centrix-loader-action="login" data-service-id="${escapeHtml(svc.id)}" style="font-size:11.5px;font-weight:700;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:8px;padding:6px 10px;cursor:pointer;white-space:nowrap;">Đăng nhập</button>`
        + `</div>`;
    }).join("");
    return `<div style="display:flex;flex-direction:column;gap:9px;min-width:0;">`
      + `<div data-cx-service-browser-section-title style="font-size:15px;font-weight:650;color:var(--text);">Trạng thái đăng nhập dịch vụ</div>`
      + `<div style="font-size:11.5px;color:var(--text-3);">Dò theo cookie trên hồ sơ dùng chung. "Đã đăng nhập" = có cookie phiên (chưa xác minh sâu).</div>`
      + `<div class="cx-scroll" style="display:flex;flex-direction:column;gap:8px;max-height:330px;overflow:auto;padding-right:2px;">${rows}</div>`
      + `</div>`;
  }
  let loginStatusRefreshRunning = false;
  async function refreshLoginStatusIfVisible() {
    if (document.hidden || loginStatusRefreshRunning || !findServiceBrowserScreen()) return;
    if (state.serviceBrowser.tab !== "login") return; // status list only lives on the login tab
    loginStatusRefreshRunning = true;
    try {
      const result = await postJson("/api/service/login-status", { profileId: loaderProfileId() });
      if (result && Array.isArray(result.results)) {
        const map = {};
        for (const r of result.results) if (r && r.serviceId) map[r.serviceId] = r;
        state.serviceBrowser.loginStatus = map;
        mountServiceBrowserPanel({ force: true });
      }
    } catch {
      // keep current statuses on a failed poll
    } finally {
      loginStatusRefreshRunning = false;
    }
  }

  function renderLoaderLoginHtml() {
    const service = selectedLoaderService();
    if (!state.serviceBrowser.url) syncLoaderUrlFromService();
    const loader = currentLoaderState();
    const statusText = loader
      ? `${loader.loading ? "Đang tải" : "Sẵn sàng"} - profile ${loader.profileId || state.serviceBrowser.profileId || "default"}`
      : "Chưa mở browser nạp data.";
    return `
      <div style="padding:24px 26px;display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:20px;">
        <div style="display:flex;flex-direction:column;gap:14px;">
          <div style="display:flex;align-items:center;gap:13px;padding:14px 16px;background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:12px;">
            <span data-cx-service-browser-icon style="width:34px;height:34px;border-radius:10px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;">↗</span>
            <span><strong style="display:block;font-size:13.5px;color:var(--text);">Browser nạp mở riêng</strong><span style="font-size:12.5px;color:var(--text-2);">Đăng nhập trực tiếp, Server giữ cookie/profile cho User app.</span></span>
          </div>
          <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">Dịch vụ cần nạp</span><select id="centrix-loader-service-select" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:500 13px Segoe UI;padding:0 12px;">${optionHtml(state.services, state.serviceBrowser.selectedServiceId, (row) => `${row.name || row.id}${row.enabled === false ? " (off)" : ""}`)}</select></label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">Hồ sơ dùng chung</span><input id="centrix-loader-profile" value="${escapeHtml(state.serviceBrowser.profileId)}" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:500 13px Segoe UI;padding:0 12px;"></label>
            <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">Tab nạp data (tự động theo dịch vụ)</span><input id="centrix-loader-tab" value="${escapeHtml(loaderTabId())}" readonly title="Mỗi dịch vụ dùng một browser riêng" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface-2);color:var(--text-2);font:500 13px Segoe UI;padding:0 12px;cursor:default;"></label>
          </div>
          <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">URL đăng nhập</span><input id="centrix-loader-url" value="${escapeHtml(state.serviceBrowser.url || service?.loginUrl || service?.url || "")}" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:500 13px Segoe UI;padding:0 12px;"></label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <button type="button" data-centrix-loader-action="open" style="height:42px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:600 13px Segoe UI;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Mở browser nạp</button>
            <button type="button" data-centrix-loader-action="show" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text);font:600 13px Segoe UI;cursor:pointer;">Đưa lên trước</button>
            <button type="button" data-centrix-loader-action="back" style="height:38px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text);font:600 13px Segoe UI;cursor:pointer;">Back</button>
            <button type="button" data-centrix-loader-action="forward" style="height:38px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text);font:600 13px Segoe UI;cursor:pointer;">Forward</button>
            <button type="button" data-centrix-loader-action="reload" style="height:38px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text);font:600 13px Segoe UI;cursor:pointer;">Reload</button>
            <button type="button" data-centrix-loader-action="close" style="height:38px;border:1px solid var(--danger-border);border-radius:10px;background:var(--surface);color:var(--danger);font:600 13px Segoe UI;cursor:pointer;">Đóng tab nạp</button>
          </div>
        </div>
        <div style="border:1px solid var(--border-soft);background:var(--surface-2);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:14px;min-width:0;">
          <div><div data-cx-service-browser-section-title style="font-size:15px;font-weight:650;color:var(--text);">Trạng thái browser nạp</div><div style="margin-top:4px;font-size:12.5px;color:${loader ? "var(--ok-text)" : "var(--text-3)"};">${escapeHtml(statusText)}</div></div>
          <div style="display:grid;grid-template-columns:120px 1fr;gap:9px 12px;font-size:12.5px;color:var(--text-2);">
            <strong>Service</strong><span>${escapeHtml(loader?.serviceName || service?.name || "-")}</span>
            <strong>Title</strong><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(loader?.title || "-")}</span>
            <strong>URL</strong><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(loader?.url || state.serviceBrowser.url || "-")}</span>
            <strong>Tab ID</strong><span>${escapeHtml(loader?.tabId || loaderTabId())}</span>
          </div>
          ${renderServiceLoginStatusHtml()}
          <div style="margin-top:auto;border-top:1px solid var(--border-soft);padding-top:14px;font-size:12.5px;color:var(--text-3);">Sau khi đăng nhập xong, profile/cookie sẽ nằm trên Server và App User lấy profile này theo quyền user.</div>
        </div>
      </div>`;
  }

  function renderAccessRulesHtml() {
    const user = selectedBrowserUser();
    const service = selectedRuleService();
    const rule = selectedUiRule();
    const accessRows = state.services.map((svc) => {
      const visibleForUser = globalServiceVisible(svc.id);
      return `
        <label style="display:flex;align-items:center;gap:12px;padding:13px 14px;border:1px solid var(--border-soft);border-radius:12px;background:var(--surface-2);cursor:pointer;">
          <input type="checkbox" data-centrix-access-service="${escapeHtml(svc.id)}" ${visibleForUser ? "checked" : ""} style="width:17px;height:17px;cursor:pointer;">
          <span style="min-width:0;flex:1;"><strong style="display:block;font-size:13.5px;color:var(--text);">${escapeHtml(svc.name || svc.id)}</strong><span style="display:block;font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(svc.url || "")}</span></span>
          <em style="font-style:normal;font-size:11px;font-weight:600;color:${visibleForUser ? "var(--ok-text)" : "var(--danger)"};">${visibleForUser ? "Hiện" : "Ẩn"}</em>
        </label>`;
    }).join("");


    const hideRuleRows = Array.isArray(rule?.hideRules) ? rule.hideRules : [];
    const healthRows = hideRuleRows.map((hideRule) => {
      const latest = (state.uiRuleReports || [])
        .filter((report) => report.userId === SERVICE_UI_RULE_USER_ID && report.serviceId === (service?.id || "") && (report.ruleId === hideRule.id || report.selector === hideRule.primarySelector))
        .slice(-1)[0];
      const healthState = latest?.state || hideRule.health?.state || "unknown";
      const color = healthState === "green" ? "var(--ok-text)" : (healthState === "red" ? "var(--danger)" : (healthState === "yellow" ? "#b7791f" : "var(--text-3)"));
      const bg = healthState === "green" ? "rgba(16,185,129,.10)" : (healthState === "red" ? "rgba(239,68,68,.10)" : (healthState === "yellow" ? "rgba(245,158,11,.12)" : "var(--surface-2)"));
      return `<div style="display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--border-soft);border-radius:10px;background:${bg};">
        <strong style="font-size:11px;text-transform:uppercase;color:${color};">${escapeHtml(healthState)}</strong>
        <span style="min-width:0;font:12px/1.35 Consolas,ui-monospace,monospace;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(hideRule.primarySelector || "")}</span>
        <span style="font-size:11.5px;color:var(--text-3);">${latest ? `${Number(latest.matchCount || 0)} match` : "chua test"}</span>
        <span style="grid-column:2 / -1;font-size:11.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(latest?.message || hideRule.note || "")}</span>
      </div>`;
    }).join("");
    const healthHtml = healthRows || `<div style="font-size:12.5px;color:var(--text-3);padding:12px;border:1px dashed var(--border-soft);border-radius:10px;">Chua co HideRule metadata. Chon vung an hoac luu lai selector de tao rule.</div>`;

    return `
      <div style="display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:0;min-height:560px;">
        <div style="padding:24px 24px 24px 26px;border-right:1px solid var(--border-soft);display:flex;flex-direction:column;gap:14px;min-width:0;">
          <div style="padding:10px 12px;border:1px solid var(--brand-border);border-radius:10px;background:var(--brand-soft);color:var(--brand);font-size:12.5px;font-weight:600;">Áp dụng cho <u>tất cả user</u> (gồm user tạo sau). Không cần chọn riêng từng user.</div>
          <div><div data-cx-service-browser-section-title style="font-size:15px;font-weight:650;color:var(--text);margin-bottom:12px;">Dịch vụ hiện với mọi user</div><div style="display:flex;flex-direction:column;gap:10px;max-height:300px;overflow:auto;padding-right:2px;" class="cx-scroll">${accessRows || `<div style="font-size:12.5px;color:var(--text-3);">Chưa có dịch vụ.</div>`}</div></div>
          <div style="border-top:1px solid var(--border-soft);padding-top:14px;display:flex;flex-direction:column;gap:10px;">
            <div data-cx-service-browser-section-title style="font-size:15px;font-weight:650;color:var(--text);">Chặn link cụ thể</div>
            <div style="font-size:11.5px;color:var(--text-3);line-height:1.55;">Mỗi dòng 1 luật: <code>kiểu | link | serviceId | thông báo</code>. Kiểu: <b>prefix</b> (mặc định — chặn path trở xuống), <b>origin</b> (cả domain), <b>exact</b> (đúng 1 URL), <b>glob</b> (dùng <code>*</code>). Bỏ trống serviceId = mọi dịch vụ. Chặn cả tab đang mở + điều hướng trong trang.</div>
            <textarea id="centrix-blocked-links" spellcheck="false" placeholder="prefix | https://grok.com/settings | grok | Khu vực bị chặn&#10;origin | https://poe.com&#10;glob | */admin/*" style="min-height:132px;resize:vertical;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:12px/1.45 Consolas,ui-monospace,monospace;padding:12px;">${escapeHtml(blockedLinksText())}</textarea>
            <button type="button" data-centrix-rules-action="save-blocked" style="height:42px;border:0;border-radius:10px;background:var(--danger);color:#fff;font:600 13px Segoe UI;cursor:pointer;">Lưu link chặn</button>
          </div>
        </div>
        <div style="padding:24px 26px;display:flex;flex-direction:column;gap:14px;min-width:0;">
          <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end;">
            <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">Ẩn UI trên dịch vụ</span><select id="centrix-browser-rule-service-select" style="height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:500 13px Segoe UI;padding:0 12px;">${optionHtml(state.services, service?.id || "", (row) => row.name || row.id)}</select></label>
            <label style="display:flex;align-items:center;gap:8px;height:42px;font-size:13px;font-weight:600;color:var(--text);"><input id="centrix-browser-rule-enabled" type="checkbox" ${rule?.enabled === true ? "checked" : ""} style="width:17px;height:17px;">Bật rule</label>
          </div>
          <div style="padding:10px 12px;border:1px solid var(--brand-border);border-radius:10px;background:var(--brand-soft);color:var(--brand);font-size:12.5px;font-weight:600;">Rule giao diện áp dụng cho toàn bộ user/profile của dịch vụ đang chọn.</div>
          <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">CSS selectors cần ẩn, mỗi dòng một selector</span><textarea id="centrix-browser-hide-selectors" spellcheck="false" style="min-height:122px;resize:vertical;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:12px/1.45 Consolas,ui-monospace,monospace;padding:12px;">${escapeHtml((rule?.hideSelectors || []).join("\n"))}</textarea></label>
          <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">HideRule JSON (selector + anchor + fingerprint)</span><textarea id="centrix-browser-hide-rules" spellcheck="false" style="min-height:112px;resize:vertical;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:12px/1.45 Consolas,ui-monospace,monospace;padding:12px;">${escapeHtml(hideRulesText(rule))}</textarea></label>
          <div style="display:flex;flex-direction:column;gap:8px;"><div data-cx-service-browser-section-title style="font-size:12px;font-weight:650;color:var(--text);">Live health-check</div>${healthHtml}</div>
          <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">Đổi nội dung UI (JSON array hoặc selector =&gt; text)</span><textarea id="centrix-browser-replace-rules" spellcheck="false" style="min-height:112px;resize:vertical;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:12px/1.45 Consolas,ui-monospace,monospace;padding:12px;">${escapeHtml(replaceRulesText(rule))}</textarea></label>
          <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">CSS tùy chỉnh — dán CSS thô, áp y nguyên (KHÔNG cắt/sanitize)</span><textarea id="centrix-browser-custom-css" spellcheck="false" placeholder=".header-ad{display:none!important}&#10;.sidebar{opacity:0}" style="min-height:122px;resize:vertical;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:12px/1.45 Consolas,ui-monospace,monospace;padding:12px;">${escapeHtml(rule?.customCss || "")}</textarea></label>
          <label style="display:flex;flex-direction:column;gap:7px;"><span style="font-size:11px;font-weight:600;color:var(--label);text-transform:uppercase;">UserScript JS (admin, chạy trong browser dịch vụ)</span><textarea id="centrix-browser-user-script" spellcheck="false" placeholder="// Ví dụ: document.querySelector('#history')?.remove();" style="min-height:132px;resize:vertical;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:12px/1.45 Consolas,ui-monospace,monospace;padding:12px;">${escapeHtml(userScriptText(rule))}</textarea></label>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
            <input id="centrix-browser-visual-text" value="${escapeHtml(state.serviceBrowser.visualReplaceText)}" placeholder="Text mới khi chọn vùng đổi nội dung" style="grid-column:1 / -1;height:38px;border:1px solid var(--field-border);border-radius:10px;background:var(--field-bg);color:var(--text);font:500 13px Segoe UI;padding:0 12px;">
            <button type="button" data-centrix-rules-action="select-hide" style="height:40px;border:1px solid var(--brand-border);border-radius:10px;background:var(--brand-soft);color:var(--brand);font:600 13px Segoe UI;cursor:pointer;">Chọn vùng ẩn</button>
            <button type="button" data-centrix-rules-action="select-replace" style="height:40px;border:1px solid var(--brand-border);border-radius:10px;background:var(--brand-soft);color:var(--brand);font:600 13px Segoe UI;cursor:pointer;">Chọn vùng đổi text</button>
            <button type="button" data-centrix-rules-action="preview" style="height:40px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text);font:600 13px Segoe UI;cursor:pointer;">Test trên browser nạp</button>
            <button type="button" data-centrix-rules-action="save" style="grid-column:1 / -1;height:42px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:600 13px Segoe UI;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Lưu UI rules</button>
          </div>
        </div>
      </div>`;
  }

  function mountServiceBrowserPanel(options = {}) {
    const screen = findServiceBrowserScreen();
    if (!screen) return false;
    const lsSig = Object.entries((state.serviceBrowser.loginStatus) || {}).map(([k, v]) => k + (v && v.state || "") + (v && v.confidence || "")).join(",");
    const key = `${state.updatedAt}|${state.serviceBrowser.tab}|${state.serviceBrowser.selectedServiceId}|${state.serviceBrowser.selectedUserId}|${state.serviceBrowser.selectedRuleServiceId}|${state.tabs.length}|${lsSig}`;
    if (!options.force && screen.dataset.centrixServiceBrowserMount === key) return true;
    screen.dataset.centrixServiceBrowserMount = key;
    // Màn "Trình duyệt dịch vụ" có 2 tab: Đăng nhập/Nạp hồ sơ và Quy tắc Ẩn & Đổi text (điền selector/replace/
    // userScript thủ công rồi Lưu -> POST /api/users/ui-rules, áp cho MỌI user). Nút "Chọn vùng" (visual picker)
    // cần Chromium loader nên chỉ hoạt động khi có browser nạp; nhập tay + Lưu thì luôn dùng được.
    const onRules = state.serviceBrowser.tab === "rules";
    const tabBtn = (id, label, active) => `<button type="button" data-centrix-service-browser-tab="${id}" style="font-size:13px;font-weight:600;border-radius:9px;padding:9px 15px;cursor:pointer;border:1px solid ${active ? "var(--brand)" : "var(--field-border)"};background:${active ? "var(--brand)" : "var(--surface)"};color:${active ? "#fff" : "var(--text-2)"};">${label}</button>`;
    screen.innerHTML = `
      <div data-centrix-service-browser-root="1" style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="padding:24px 26px;border-bottom:1px solid var(--border-soft);display:flex;align-items:flex-start;justify-content:space-between;gap:20px;">
          <div>
            <div data-cx-service-browser-title style="font-size:21px;font-weight:700;color:var(--text);letter-spacing:-.01em;">Trình duyệt dịch vụ</div>
            <div style="font-size:13.5px;color:var(--text-2);margin-top:5px;">Đăng nhập &amp; nạp hồ sơ dịch vụ, và đặt Quy tắc Ẩn / Đổi text (áp cho mọi user).</div>
            <div style="display:flex;gap:8px;margin-top:13px;">${tabBtn("login", "Đăng nhập / Nạp hồ sơ", !onRules)}${tabBtn("rules", "Quy tắc Ẩn & Đổi text", onRules)}</div>
          </div>
          <div style="display:flex;gap:10px;flex-shrink:0;">
            <button type="button" data-centrix-loader-action="open" style="font-size:13.5px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:9px;padding:10px 16px;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow);">Mở browser nạp</button>
            <button type="button" data-centrix-loader-action="show" style="font-size:13.5px;font-weight:600;color:var(--text);background:var(--surface);border:1px solid var(--field-border);border-radius:9px;padding:10px 16px;cursor:pointer;">Đưa lên trước</button>
          </div>
        </div>
        ${onRules ? renderAccessRulesHtml() : renderLoaderLoginHtml()}
      </div>`;
    return true;
  }

  function scheduleServiceBrowserPanel() {
    registerBodyTick(mountServiceBrowserPanel);
    for (const delayMs of [300, 900, 1800, 3200]) setTimeout(mountServiceBrowserPanel, delayMs);
  }

  async function refresh() {
    const healthResult = await getJson("/api/health").catch((error) => ({
      ok: false,
      error: error.message || String(error)
    }));
    state.health = healthResult?.ok ? healthResult : { ok: false, error: healthResult?.error || "Cannot load /api/health" };
    state.tunnel = healthResult?.tunnel || state.tunnel;
    state.tunnelConfig = healthResult?.tunnel?.config || state.tunnelConfig;
    staffRbac = (state.health && state.health.staffRbac) || "off";
    // WEBSITE cookie auth: decide login from the httpOnly cookie via /api/auth/staff-whoami (the SPA can't
    // read the cookie). Master-override (desktop ?token=) skips this.
    if (staffActive() && !useMasterOverride) {
      const who = await checkStaffSession();
      if (who) { state.staff = who; staffLoggedIn = true; removeStaffLoginOverlay(); }
      else { state.staff = null; staffLoggedIn = false; mountStaffLoginOverlay(); removeLoadingVeil(); return; }
    } else {
      removeStaffLoginOverlay();
    }

    try {
      const [tunnelResult, tunnelConfigResult, usersResult, servicesResult, portalResult, summaryResult, tabsResult] = await Promise.all([
        getJson("/api/tunnel").catch(() => null),
        getJson("/api/tunnel/config").catch(() => null),
        getJson("/api/users").catch(() => null),
        getJson("/api/services").catch(() => null),
        getJson("/api/admin/portal"),
        getJson("/api/admin/summary"),
        getJson("/api/tabs")
      ]);
      state.ok = true;
      state.updatedAt = new Date().toISOString();
      // /api/users and /api/services are .catch(()=>null) above so a single failing call no longer rejects
      // the whole Promise.all (which used to blank the entire admin). On null, keep the previous state.
      state.users = usersResult?.users || usersResult?.db?.users || (usersResult ? [] : state.users) || [];
      state.serviceVisibility = usersResult?.serviceVisibility || usersResult?.db?.serviceVisibility || (usersResult ? [] : state.serviceVisibility) || [];
      state.uiRules = usersResult?.uiRules || usersResult?.db?.uiRules || (usersResult ? [] : state.uiRules) || [];
      state.blockedLinks = usersResult?.blockedLinks || usersResult?.db?.blockedLinks || (usersResult ? [] : state.blockedLinks) || [];
      mergeLocalUiRuleDraftsIntoState();
      state.uiRuleReports = usersResult?.uiRuleReports || usersResult?.db?.uiRuleReports || (usersResult ? [] : state.uiRuleReports) || [];
      state.uiCacheItems = usersResult?.uiCacheItems || usersResult?.db?.uiCacheItems || (usersResult ? [] : state.uiCacheItems) || [];
      state.accounts = usersResult?.accounts || usersResult?.db?.accounts || state.accounts || [];
      if (usersResult) updateModelStateFromUsersResult(usersResult);
      state.tunnel = tunnelResult?.tunnel || state.tunnel || state.health?.tunnel || null;
      state.tunnelConfig = tunnelConfigResult?.config || state.tunnel?.config || state.tunnelConfig || null;
      if (servicesResult) updateServicesFromConfig(servicesResult.config || { services: servicesResult.services || [] });
      refreshLoginStatusIfVisible();
      state.tabs = tabsResult.tabs || [];
      syncModelServiceSelection();
      if (state.serviceBrowser.selectedUserId && !state.users.some((user) => user.id === state.serviceBrowser.selectedUserId)) {
        state.serviceBrowser.selectedUserId = state.users[0]?.id || "local-user";
      }
      if (!state.serviceBrowser.selectedUserId && state.users.length) {
        state.serviceBrowser.selectedUserId = state.users[0].id || "local-user";
      }
      if (state.modelUi.userId && !state.users.some((user) => user.id === state.modelUi.userId)) {
        state.modelUi.userId = state.users[0]?.id || "local-user";
      }
      if (!state.modelUi.userId && state.users.length) {
        state.modelUi.userId = state.users[0].id || "local-user";
      }
      localStorage.setItem("centrixServerModelUserId", state.modelUi.userId || "local-user");
      state.portal = portalResult.portal || {};
      state.summary = summaryResult.summary || {};
      state.error = "";
      publishState();
    } catch (error) {
      state.ok = false;
      state.error = error.message;
      publishState();
    }
    setDataset();
    applyRealUserPool();
    applyRealOrgs();
    if (document.body) {
      ensureBadge();
      ensureActionPanel();
      mountConnectPanel();
      mountServicesApiPanel();
      mountModelApiPanel();
      mountActivityApiPanel();
      mountLedgerApiPanel();
      mountServiceBrowserPanel();
      mountOrgPanel();
      mountRolesPanel();
      applyStaffVisibility();
      mountDashboardStats();
      mountAnalyticsStats();
      mountPaymentsPanel();
      mountInterventionPanel();
      mountInterventionLogPanel();
      mountOrgTxPanel();
      mountMyAccountPanel(); // "Tài khoản của tôi" (màn Cài đặt) — render với state.staff mới nhất
      updateSupportNotify(); // toast góc phải: "Có N tin nhắn khách cần phản hồi"
    }
    revealApp(); // real data fetched + patches applied → reveal (removes the loading veil)
  }

  async function runAction(label, task) {
    state.actions = { ...state.actions, pending: label, error: "" };
    publishState();
    ensureBadge();
    ensureActionPanel();
    try {
      const result = await task();
      state.actions = { pending: "", error: "", last: result };
      publishState();
      showActionToast(`API ${label} OK`);
      await refresh();
      return result;
    } catch (error) {
      state.actions = {
        pending: "",
        last: state.actions.last,
        error: error.message || String(error)
      };
      publishState();
      ensureBadge();
      ensureActionPanel();
      showActionToast(`API ${label} failed - ${state.actions.error}`, "error");
      return null;
    }
  }

  function closeCreateUserModal() {
    document.getElementById("centrix-create-user-modal")?.remove();
  }

  // Add-user form: collects a Gmail (no password — the system uses Google Sign-In only). Creating the user
  // makes an app_accounts row keyed by that email; when the customer later logs into App User with Google
  // using the SAME email, the server matches this row and shows the plan/credit/expiry you pre-set here.
  function openCreateUserModal() {
    if (document.getElementById("centrix-create-user-modal")) return;
    const fieldCss = "width:100%;height:40px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:600 13px Segoe UI,system-ui,sans-serif;padding:0 12px;box-sizing:border-box;";
    const labelCss = "display:flex;flex-direction:column;gap:6px;margin-top:13px;font:800 11px Segoe UI,system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;";
    const overlay = document.createElement("div");
    overlay.id = "centrix-create-user-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.innerHTML = `
      <div role="dialog" style="width:400px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;">
        <div style="font:900 18px Segoe UI,system-ui,sans-serif;color:var(--text,#0f172a);">Thêm người dùng</div>
        <div style="font:500 12.5px/1.45 Segoe UI,system-ui,sans-serif;color:var(--text-2,#64748b);margin-top:4px;">Nhập Gmail của khách. Khách đăng nhập App User bằng <b>Google với đúng email này</b> sẽ thấy gói / credit / hạn bạn set sẵn. Không cần mật khẩu.</div>
        <label style="${labelCss}">Gmail <input id="cx-newuser-email" type="email" autocomplete="off" placeholder="vd: khach@gmail.com" style="${fieldCss}"></label>
        <label style="${labelCss}">Tên hiển thị (tuỳ chọn) <input id="cx-newuser-name" placeholder="vd: Nguyễn Văn A" style="${fieldCss}"></label>
        <label style="${labelCss}">Credit khởi tạo <input id="cx-newuser-credit" type="number" min="0" value="0" style="${fieldCss}"></label>
        <div style="display:flex;gap:10px;margin-top:20px;">
          <button type="button" data-centrix-server-action="create-user-cancel" style="flex:1;height:42px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI,system-ui,sans-serif;cursor:pointer;">Hủy</button>
          <button type="button" data-centrix-server-action="create-user-submit" style="flex:1.4;height:42px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:900 13px Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));">Tạo người dùng</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) closeCreateUserModal(); });
    setTimeout(() => document.getElementById("cx-newuser-email")?.focus(), 50);
  }

  async function createUserFromUi() {
    return runAction("create user", async () => {
      const email = String(document.getElementById("cx-newuser-email")?.value || "").trim().toLowerCase();
      if (!email || !email.includes("@")) throw new Error("Email không hợp lệ");
      const nameInput = String(document.getElementById("cx-newuser-name")?.value || "").trim();
      const creditAmount = Math.max(0, Math.round(Number(document.getElementById("cx-newuser-credit")?.value || 0)));
      const id = `guser-${Date.now().toString(36)}`;
      const name = nameInput || email;
      // email only (no password) -> server save_user creates the app_accounts row keyed by email. When the
      // customer signs in via Google with this email, /auth/google-login matches this row -> shows the plan/
      // credit/expiry you pre-set for this user. (Password login is disabled system-wide.)
      await postJson("/api/users/save", {
        user: {
          id,
          name,
          role: "user",
          enabled: true,
          defaultProfileId: "default",
          profileId: "default",
          email,
          accountEnabled: true
        }
      });
      let balance = 0;
      if (creditAmount > 0) {
        const credit = await postJson("/api/admin/credits/adjust", {
          userId: id,
          amountDelta: creditAmount,
          reason: "App Server UI create user",
          actor: currentActor()
        });
        balance = (credit.db?.creditWallets || []).find((wallet) => wallet.userId === id)?.balance ?? creditAmount;
      }
      closeCreateUserModal();
      setServerPage("users");
      showActionToast(`Đã thêm ${email} · giờ set gói / credit / hạn cho khách này, họ đăng nhập Google là thấy`);
      return { type: "create-user", id, email, name, balance };
    });
  }

  function closeCreateOrgModal() {
    document.getElementById("centrix-create-org-modal")?.remove();
  }

  function openCreateOrgModal() {
    if (document.getElementById("centrix-create-org-modal")) return;
    const fieldCss = "width:100%;height:40px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:600 13px Segoe UI,system-ui,sans-serif;padding:0 12px;box-sizing:border-box;";
    const labelCss = "display:flex;flex-direction:column;gap:6px;margin-top:13px;font:800 11px Segoe UI,system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;";
    const userRows = (state.users || []).filter((user) => user.id !== SERVICE_UI_RULE_USER_ID);
    const ownerOptions = userRows.map((user) => {
      const email = (state.accounts || []).find((account) => account.userId === user.id)?.email || "";
      return `<option value="${escapeHtml(user.id)}">${escapeHtml(`${user.name || user.id}${email ? " · " + email : ""} · [${user.id}]`)}</option>`;
    }).join("");
    const overlay = document.createElement("div");
    overlay.id = "centrix-create-org-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.innerHTML = `
      <div role="dialog" style="width:420px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;">
        <div style="font:900 18px Segoe UI,system-ui,sans-serif;color:var(--text,#0f172a);">Tạo tổ chức</div>
        <div style="font:500 12.5px/1.45 Segoe UI,system-ui,sans-serif;color:var(--text-2,#64748b);margin-top:4px;">Gắn tổ chức với một user. User được chọn sẽ thấy giao diện tổ chức bên App User.</div>
        <label style="${labelCss}">Tên tổ chức <input id="cx-neworg-name" placeholder="vd: CENTRIX MEDIA" style="${fieldCss}"></label>
        <label style="${labelCss}">Người quản trị tổ chức (theo userId) <select id="cx-neworg-owner" style="${fieldCss}">${ownerOptions || '<option value="">— chưa có user —</option>'}</select></label>
        <label style="${labelCss}">Phòng ban (tuỳ chọn) <input id="cx-neworg-dept" placeholder="vd: Phòng Kinh doanh" style="${fieldCss}"></label>
        <label style="${labelCss}">Vai trò <select id="cx-neworg-role" style="${fieldCss}"><option value="Quản trị">Quản trị</option><option value="Quản lý">Quản lý</option><option value="Chủ sở hữu">Chủ sở hữu</option><option value="Thành viên">Thành viên</option></select></label>
        <div style="display:flex;gap:10px;margin-top:20px;">
          <button type="button" data-centrix-server-action="create-org-cancel" style="flex:1;height:42px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI,system-ui,sans-serif;cursor:pointer;">Hủy</button>
          <button type="button" data-centrix-server-action="create-org-submit" style="flex:1.4;height:42px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:900 13px Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));">Tạo tổ chức</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) closeCreateOrgModal(); });
    setTimeout(() => document.getElementById("cx-neworg-name")?.focus(), 50);
  }

  async function createOrgFromUi() {
    return runAction("create org", async () => {
      const name = String(document.getElementById("cx-neworg-name")?.value || "").trim();
      const ownerUserId = String(document.getElementById("cx-neworg-owner")?.value || "").trim();
      const deptName = String(document.getElementById("cx-neworg-dept")?.value || "").trim();
      const role = String(document.getElementById("cx-neworg-role")?.value || "Quản lý").trim();
      if (!name) throw new Error("Cần nhập tên tổ chức");
      if (!ownerUserId) throw new Error("Cần chọn user làm chủ tổ chức");
      const owner = (state.users || []).find((user) => user.id === ownerUserId);
      const ownerEmail = (state.accounts || []).find((account) => account.userId === ownerUserId)?.email || "";
      const stamp = Date.now().toString(36);
      const orgId = `org-${stamp}`;
      const deptId = deptName ? `dept-${stamp}` : "";
      // 1) organization record
      await postJson("/api/admin/portal", { section: "organizations", record: { id: orgId, name, short: name.slice(0, 18) } });
      // 2) optional department
      if (deptId) {
        await postJson("/api/admin/portal", { section: "departments", record: { id: deptId, orgId, name: deptName } });
      }
      // 3) member linking the chosen user → user_portal_from_db returns this org for that userId, so the
      //    App User of that user gets the organization UI (it stays hidden for users with no membership).
      const result = await postJson("/api/admin/portal", {
        section: "members",
        // orgRole:"owner" is REQUIRED — the org-admin gates (isOrgAdmin / require_org_admin) check orgRole,
        // NOT the free-text `role` label. Without it the creator can't add departments/members in their org.
        record: { id: `mem-${stamp}`, orgId, userId: ownerUserId, email: ownerEmail, name: owner?.name || ownerUserId, role, orgRole: "owner", departmentId: deptId }
      });
      if (result && result.portal) state.portal = result.portal; // freshest portal → the new org appears in the list at once
      selectedOrgId = orgId; // auto-expand the just-created org
      closeCreateOrgModal();
      mountOrgPanel({ force: true });
      showActionToast(`Đã tạo tổ chức "${name}" · chủ: ${owner?.name || ownerUserId}`);
      return { type: "create-org", orgId, name, ownerUserId };
    });
  }

  // ── "Tài khoản của tôi" (staff self-service): xem thông tin + ĐỔI MẬT KHẨU ─────────────────────────
  // Panel gắn vào màn "Cài đặt" (thông tin + nút mở modal) + mục trong account-popup (luôn thấy, không RBAC).
  // Đổi mật khẩu qua POST /api/auth/staff-change-password (backend lấy username từ phiên → chỉ đổi chính mình).
  function findSettingsScreen() {
    return visibleScreens().find((s) => fold(s.getAttribute("data-screen-label")).includes("cai dat")) || null;
  }
  function myAccountRoleText() {
    const s = state.staff || {};
    if (s.isOwner) return "Chủ sở hữu";
    return (typeof roleLabel === "function" && roleLabel(s.role)) || s.role || "Nhân viên";
  }
  function mountMyAccountPanel(options = {}) {
    const screen = findSettingsScreen();
    if (!screen) return false;
    const s = state.staff || {};
    const key = `${s.username}|${s.displayName}|${s.role}|${s.isOwner}|${(s.permissions || []).join(",")}`;
    if (!options.force && screen.dataset.centrixMyAcctMount === key) return true;
    screen.dataset.centrixMyAcctMount = key;
    const perms = s.permissions || [];
    const permHtml = perms.length
      ? perms.map((p) => `<span style="font-size:11px;font-weight:700;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:7px;padding:3px 9px;">${escapeHtml(p)}</span>`).join("")
      : `<span style="font-size:12px;color:var(--text-3);">—</span>`;
    const row = (label, val) => `<div style="display:flex;gap:14px;padding:11px 0;border-bottom:1px solid var(--border-soft);"><span style="width:140px;flex-shrink:0;font-size:12.5px;color:var(--text-3);font-weight:600;">${escapeHtml(label)}</span><span style="font-size:13.5px;color:var(--text);font-weight:600;word-break:break-word;min-width:0;">${val}</span></div>`;
    screen.innerHTML = `
      <div data-centrix-myacct-root="1" style="display:flex;flex-direction:column;gap:18px;max-width:720px;">
        <div><div style="font-size:21px;font-weight:900;color:var(--text);letter-spacing:-.01em;">Tài khoản của tôi</div>
          <div style="font-size:13.5px;color:var(--text-2);margin-top:4px;">Thông tin đăng nhập của bạn và đổi mật khẩu.</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);padding:20px 24px;">
          ${row("Tên hiển thị", escapeHtml(s.displayName || "—"))}
          ${row("Tài khoản (email)", escapeHtml(s.username || "—"))}
          ${row("Vai trò", escapeHtml(myAccountRoleText()) + (s.isOwner ? ` <span style="font-size:10.5px;font-weight:800;color:var(--ok-text);background:var(--ok-soft);border:1px solid var(--ok-border);border-radius:6px;padding:2px 7px;margin-left:6px;">OWNER</span>` : ""))}
          <div style="display:flex;gap:14px;padding:11px 0 0;"><span style="width:140px;flex-shrink:0;font-size:12.5px;color:var(--text-3);font-weight:600;">Quyền</span><span style="display:flex;flex-wrap:wrap;gap:6px;min-width:0;">${permHtml}</span></div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px var(--shadow);padding:20px 24px;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
          <div style="min-width:0;"><div style="font-size:15px;font-weight:800;color:var(--text);">Mật khẩu</div><div style="font-size:12.5px;color:var(--text-2);margin-top:3px;">Đổi mật khẩu đăng nhập của bạn (tối thiểu 8 ký tự).</div></div>
          ${useMasterOverride
            ? `<span style="font-size:12px;color:var(--text-3);max-width:230px;text-align:right;">Tài khoản chủ (master) — đổi qua cấu hình máy chủ.</span>`
            : `<button type="button" data-centrix-server-action="my-account" style="height:42px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:800 13px Segoe UI,system-ui,sans-serif;cursor:pointer;padding:0 18px;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));flex-shrink:0;">Đổi mật khẩu</button>`}
        </div>
      </div>`;
    return true;
  }
  function closeMyAccountModal() { document.getElementById("centrix-myaccount-modal")?.remove(); }
  function changePwError(msg) {
    const el = document.getElementById("cx-pw-err");
    if (el) { el.textContent = msg || ""; el.style.display = msg ? "block" : "none"; }
  }
  function togglePwField(btn) {
    const inp = btn && document.getElementById(btn.getAttribute("data-pw-target") || "");
    if (!inp) return;
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.textContent = show ? "Ẩn" : "Hiện";
  }
  function openMyAccountModal() {
    if (document.getElementById("centrix-myaccount-modal")) return;
    if (useMasterOverride) { showActionToast("Tài khoản chủ (master) — đổi mật khẩu qua cấu hình máy chủ, không đổi tại đây.", "error"); return; }
    const s = state.staff || {};
    const fieldWrapCss = "position:relative;display:block;margin-top:6px;";
    const fieldCss = "width:100%;height:44px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:600 13.5px Segoe UI,system-ui,sans-serif;padding:0 60px 0 13px;box-sizing:border-box;";
    const labelCss = "display:block;margin-top:15px;font:800 11px Segoe UI,system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;letter-spacing:.03em;";
    const eyeCss = "position:absolute;right:8px;top:50%;transform:translateY(-50%);height:30px;border:1px solid var(--field-border,#cbd5e1);border-radius:8px;background:var(--surface-2,#f1f5f9);color:var(--text-2,#64748b);font:700 11.5px Segoe UI,system-ui,sans-serif;cursor:pointer;padding:0 11px;";
    const pwField = (id, label, ac) => `<label style="${labelCss}">${label}</label><span style="${fieldWrapCss}"><input id="${id}" type="password" autocomplete="${ac}" style="${fieldCss}"><button type="button" data-centrix-server-action="change-pw-toggle" data-pw-target="${id}" style="${eyeCss}">Hiện</button></span>`;
    const overlay = document.createElement("div");
    overlay.id = "centrix-myaccount-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.innerHTML = `
      <div role="dialog" style="width:440px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;">
        <div style="font:900 18px Segoe UI,system-ui,sans-serif;color:var(--text,#0f172a);">Đổi mật khẩu</div>
        <div style="font:500 12.5px/1.45 Segoe UI,system-ui,sans-serif;color:var(--text-2,#64748b);margin-top:4px;">Tài khoản <b style="color:var(--text,#0f172a);">${escapeHtml(s.username || "")}</b>. Mật khẩu mới tối thiểu 8 ký tự.</div>
        ${pwField("cx-pw-old", "Mật khẩu hiện tại", "current-password")}
        ${pwField("cx-pw-new", "Mật khẩu mới", "new-password")}
        ${pwField("cx-pw-new2", "Nhập lại mật khẩu mới", "new-password")}
        <div id="cx-pw-err" style="display:none;margin-top:12px;font:700 12.5px Segoe UI,system-ui,sans-serif;color:var(--danger,#dc2626);"></div>
        <div style="display:flex;gap:10px;margin-top:20px;">
          <button type="button" data-centrix-server-action="change-pw-cancel" style="flex:1;height:44px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI,system-ui,sans-serif;cursor:pointer;">Đóng</button>
          <button type="button" data-centrix-server-action="change-pw-submit" style="flex:1.5;height:44px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:900 13px Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));">Đổi mật khẩu</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeMyAccountModal(); });
    setTimeout(() => document.getElementById("cx-pw-old")?.focus(), 50);
  }
  async function changePasswordFromUi() {
    const oldPw = String(document.getElementById("cx-pw-old")?.value || "");
    const newPw = String(document.getElementById("cx-pw-new")?.value || "");
    const newPw2 = String(document.getElementById("cx-pw-new2")?.value || "");
    if (!oldPw || !newPw) return changePwError("Nhập đủ mật khẩu hiện tại và mật khẩu mới");
    if (newPw.length < 8) return changePwError("Mật khẩu mới tối thiểu 8 ký tự");
    if (newPw !== newPw2) return changePwError("Mật khẩu nhập lại không khớp");
    if (newPw === oldPw) return changePwError("Mật khẩu mới phải khác mật khẩu hiện tại");
    const btn = document.querySelector('#centrix-myaccount-modal [data-centrix-server-action="change-pw-submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Đang đổi…"; btn.style.opacity = ".7"; }
    try {
      await postJson("/api/auth/staff-change-password", { oldPassword: oldPw, newPassword: newPw });
      closeMyAccountModal();
      showActionToast("Đã đổi mật khẩu thành công");
    } catch (e) {
      changePwError((e && e.message) || "Đổi mật khẩu thất bại");
      if (btn) { btn.disabled = false; btn.textContent = "Đổi mật khẩu"; btn.style.opacity = "1"; }
    }
  }

  async function approvePendingTopup() {
    return runAction("approve topup", async () => {
      const latest = await getJson("/api/admin/portal");
      const order = (latest.portal?.topupOrders || []).find((row) => row.status === "pending" && !row.creditedAt);
      if (!order) throw new Error("No pending topup order");
      const result = await postJson("/api/admin/billing/approve", {
        orderId: order.id,
        actor: currentActor()
      });
      setServerPage("topup");
      return {
        type: "approve-topup",
        id: result.order?.id || order.id,
        userId: result.order?.userId || order.userId,
        credits: result.order?.credits ?? order.credits,
        status: result.order?.status || "approved"
      };
    });
  }

  async function closeOpenTicket() {
    return runAction("close ticket", async () => {
      const latest = await getJson("/api/admin/portal");
      const ticket = (latest.portal?.supportTickets || []).find((row) => row.status !== "closed");
      if (!ticket) throw new Error("No open support ticket");
      const result = await postJson("/api/admin/portal", {
        section: "supportTickets",
        record: {
          ...ticket,
          status: "closed",
          closedBy: currentActor(),
          message: ticket.message || "Closed from App Server UI"
        }
      });
      setServerPage("support");
      return {
        type: "close-ticket",
        id: ticket.id,
        status: "closed",
        tickets: (result.portal?.supportTickets || []).length
      };
    });
  }

  function focusServerSearch() {
    const input = Array.from(document.querySelectorAll("input"))
      .find((item) => visible(item) && /tim|search|loc/i.test(fold([item.placeholder, item.value].join(" "))))
      || Array.from(document.querySelectorAll("input")).find(visible);
    input?.focus?.();
    input?.select?.();
  }

  function registerServerMenuEvents() {
    if (menuEventsRegistered) return;
    const bridge = window.centrixAppServer;
    if (!bridge?.on) return;
    menuEventsRegistered = true;
    const listen = (channel, handler) => {
      try {
        bridge.on(channel, handler);
      } catch {
        // Older preloads may not include every menu channel.
      }
    };
    listen("menu:new-user", openCreateUserModal);
    listen("menu:open-settings", () => setServerPage("settings"));
    listen("menu:find-chat", focusServerSearch);
    listen("menu:delete-chat", closeOpenTicket);
    listen("menu:toggle-sidebar", () => showActionToast("Sidebar toggle is managed by the current server layout"));
    listen("menu:toggle-theme", toggleServerTheme);
    listen("menu:show-shortcuts", () => showActionToast("Ctrl+N, Ctrl+F, Ctrl+T, Ctrl+S, F11"));
    listen("menu:check-updates", () => showActionToast("CentriX AI Desktop v3.6.0 is up to date"));
    listen("menu:contact-support", () => setServerPage("support"));
    listen("menu:new-window", () => showActionToast("Opened a new App Server control window"));
  }

  document.addEventListener("click", (event) => {
    const themeChoice = themeChoiceFromTarget(event.target);
    if (!themeChoice) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    applyServerTheme(themeChoice);
    showActionToast(themeChoice === "dark" ? "Da chuyen sang giao dien toi" : "Da chuyen sang giao dien sang");
  }, true);

  document.addEventListener("click", (event) => {
    const rawTarget = event.target;
    // Our self-wired modals own their clicks via direct listeners, so this global handler must NOT touch them —
    // otherwise a plain "Đóng"/"Nạp credit" inside them gets caught by a text-matcher below (e.g. "Đóng" → close
    // support ticket → "No open support ticket"; "Nạp credit" → re-open topup). Skip clicks inside them entirely.
    if (rawTarget?.closest?.("#cx-bulk-topup-modal,#cx-assign-plan-modal,#cx-legacy-manage-modal,#cx-lock-user-modal")) return;
    const actionTarget = rawTarget?.closest?.([
      "[data-centrix-win-action]",
      "[data-centrix-server-action]",
      "[data-centrix-connect-action]",
      "[data-centrix-service-action]",
      "[data-centrix-service-browser-tab]",
      "[data-centrix-loader-action]",
      "[data-centrix-rules-action]",
      "[data-centrix-model-action]",
      "[data-centrix-activity-action]",
      "[data-centrix-service-id]"
    ].join(","));
    const nativeFormTarget = rawTarget?.closest?.("select,input,textarea,option,label");
    if (nativeFormTarget && !actionTarget) {
      if (accountPopupOpen && !nativeFormTarget.closest?.("#centrix-server-api-action-panel")) {
        closeAccountPopup();
      }
      return;
    }
    const target = rawTarget?.closest?.("button,div,span,a");
    const themeChoice = themeChoiceFromTarget(rawTarget);
    if (themeChoice) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      applyServerTheme(themeChoice);
      showActionToast(themeChoice === "dark" ? "Da chuyen sang giao dien toi" : "Da chuyen sang giao dien sang");
      return;
    }

    const winAction = target?.closest?.("[data-centrix-win-action]")?.dataset?.centrixWinAction;
    if (winAction && runWindowAction(winAction)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }

    if (isAccountTrigger(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      toggleAccountPopup();
      return;
    }

    if (accountPopupOpen && !target?.closest?.("#centrix-server-api-action-panel")) {
      closeAccountPopup();
    }

    const bridgeAction = target?.closest?.("[data-centrix-server-action]")?.dataset?.centrixServerAction;
    if (bridgeAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeAccountPopup();
      if (bridgeAction === "create-user") openCreateUserModal();
      if (bridgeAction === "create-user-submit") setTimeout(createUserFromUi, 0);
      if (bridgeAction === "create-user-cancel") closeCreateUserModal();
      if (bridgeAction === "staff-login-submit") setTimeout(staffLoginSubmit, 0);
      if (bridgeAction === "staff-login-master") setTimeout(staffUseMaster, 0);
      if (bridgeAction === "staff-logout") setTimeout(staffLogout, 0);
      if (bridgeAction === "my-account") openMyAccountModal();
      if (bridgeAction === "change-pw-submit") setTimeout(changePasswordFromUi, 0);
      if (bridgeAction === "change-pw-cancel") closeMyAccountModal();
      if (bridgeAction === "change-pw-toggle") togglePwField(target?.closest?.("[data-pw-target]"));
      if (bridgeAction === "staff-invite") openStaffModal(null);
      if (bridgeAction === "staff-edit") openStaffModal(staffAdminAccount(target?.closest?.("[data-staff-user]")?.dataset?.staffUser || ""));
      if (bridgeAction === "staff-save") setTimeout(saveStaffFromUi, 0);
      if (bridgeAction === "staff-cancel") closeStaffModal();
      if (bridgeAction === "staff-delete") setTimeout(() => deleteStaffById(target?.closest?.("[data-staff-user]")?.dataset?.staffUser || ""), 0);
      if (bridgeAction === "staff-toggle") setTimeout(() => toggleStaffEnabled(target?.closest?.("[data-staff-user]")?.dataset?.staffUser || ""), 0);
      if (bridgeAction === "role-edit") openRolePermModal(target?.closest?.("[data-role-key]")?.dataset?.roleKey || "");
      if (bridgeAction === "role-perm-save") setTimeout(saveRolePermsFromUi, 0);
      if (bridgeAction === "role-perm-cancel") closeRolePermModal();
      if (bridgeAction === "inter-rerun") { showActionToast("Đang kiểm tra lại các tác vụ…"); setTimeout(() => refresh(), 0); }
      if (bridgeAction === "interlog-page") { const p = parseInt(target?.closest?.("[data-page]")?.dataset?.page || "1", 10); if (!isNaN(p)) interLogPage = p; mountInterventionLogPanel({ force: true }); }
      if (bridgeAction === "orgtx-page") { const p = parseInt(target?.closest?.("[data-page]")?.dataset?.page || "1", 10); if (!isNaN(p)) orgTxPage = p; mountOrgTxPanel({ force: true }); }
      if (bridgeAction === "ledger-page") { const p = parseInt(target?.closest?.("[data-page]")?.dataset?.page || "1", 10); if (!isNaN(p)) ledgerPage = p; mountLedgerApiPanel({ force: true }); }
      if (bridgeAction === "activity-page") { const p = parseInt(target?.closest?.("[data-page]")?.dataset?.page || "1", 10); if (!isNaN(p)) activityPage = p; mountActivityApiPanel({ force: true }); }
      if (bridgeAction === "pool-tab") { const t = target?.closest?.("[data-tab]")?.dataset?.tab; if (t) { poolTab = t; renderPoolOverlay(true); if (t === "vault") refreshVaultAccounts(); } }
      if (bridgeAction === "vault-save") { saveVaultAccount(); }
      if (bridgeAction === "vault-cancel") { resetVaultForm(); renderPoolOverlay(true); }
      if (bridgeAction === "vault-edit") { const id = target?.closest?.("[data-id]")?.dataset?.id; if (id) editVaultAccount(id); }
      if (bridgeAction === "vault-del") { const id = target?.closest?.("[data-id]")?.dataset?.id; if (id) deleteVaultAccount(id); }
      if (bridgeAction === "vault-reseed") { const el = target?.closest?.("[data-svc]"); const svc = el?.dataset?.svc; const slot = el?.dataset?.slot; if (svc) reseedVaultNow(svc, slot); }
      if (bridgeAction === "pool-detail") { const svc = target?.closest?.("[data-svc]")?.dataset?.svc; if (svc) { if (poolExpanded.has(svc)) poolExpanded.delete(svc); else poolExpanded.add(svc); renderPoolOverlay(true); } }
      if (bridgeAction === "pool-window") { const m = parseInt(target?.closest?.("[data-win]")?.dataset?.win || "", 10); if (m > 0) { poolWindowMin = m; renderPoolOverlay(true); } }
      if (bridgeAction === "pool-nav") setPoolScreenActive(!poolScreenActive);
      if (bridgeAction === "pool-prof-detail") { const svc = target?.closest?.("[data-svc]")?.dataset?.svc; if (svc) { if (poolProfExpanded.has(svc)) poolProfExpanded.delete(svc); else poolProfExpanded.add(svc); renderPoolOverlay(true); } }
      if (bridgeAction === "pool-del-profile") { const pid = target?.closest?.("[data-pid]")?.dataset?.pid; if (pid) deletePoolProfile(pid); }
      if (bridgeAction === "pool-cap-step") { const el = target?.closest?.("[data-pid]"); const pid = el?.dataset?.pid; const delta = Number(el?.dataset?.delta) || 0; if (pid) stepPoolCapacity(pid, delta); }
      if (bridgeAction === "pool-cap-edit") { const pid = target?.closest?.("[data-pid]")?.dataset?.pid; if (pid) { if (poolCapEditing.has(pid)) { poolCapEditing.delete(pid); poolCapDraft.delete(pid); } else { poolCapEditing.add(pid); const inp0 = poolCapInput(pid); poolCapDraft.set(pid, inp0 ? (Math.floor(Number(inp0.value) || 1)) : 1); } renderPoolOverlay(true); } }
      if (bridgeAction === "pool-cap-save") { const pid = target?.closest?.("[data-pid]")?.dataset?.pid; if (pid) savePoolCapacity(pid); }
      if (bridgeAction === "pool-grant-detail") { const svc = target?.closest?.("[data-svc]")?.dataset?.svc; if (svc) { if (poolGrantExpanded.has(svc)) poolGrantExpanded.delete(svc); else poolGrantExpanded.add(svc); renderPoolOverlay(true); } }
      if (bridgeAction === "create-org") openCreateOrgModal();
      if (bridgeAction === "create-org-submit") setTimeout(createOrgFromUi, 0);
      if (bridgeAction === "create-org-cancel") closeCreateOrgModal();
      if (bridgeAction === "approve-topup") setTimeout(approvePendingTopup, 0);
      if (bridgeAction === "close-ticket") setTimeout(closeOpenTicket, 0);
      if (bridgeAction === "select-ticket") { selectedSupportTicketId = (target?.closest?.("[data-ticket-id]")?.dataset?.ticketId) || ""; mountSupportPanel({ force: true }); }
      if (bridgeAction === "filter-tickets") { supportFilter = (target?.closest?.("[data-filter]")?.dataset?.filter) || "all"; mountSupportPanel({ force: true }); }
      if (bridgeAction === "reply-ticket") setTimeout(() => replyToTicket((target?.closest?.("[data-ticket-id]")?.dataset?.ticketId) || ""), 0);
      if (bridgeAction === "close-ticket-row") setTimeout(() => closeTicketById((target?.closest?.("[data-ticket-id]")?.dataset?.ticketId) || ""), 0);
      if (bridgeAction === "switch-support-tab") { supportTab = (target?.closest?.("[data-tab]")?.dataset?.tab) || "chat"; mountSupportPanel({ force: true }); }
      if (bridgeAction === "select-chat") { selectedChatUserId = (target?.closest?.("[data-chat-user]")?.dataset?.chatUser) || ""; mountSupportPanel({ force: true }); }
      if (bridgeAction === "send-chat-msg") setTimeout(() => sendAgentChatMessage((target?.closest?.("[data-chat-user]")?.dataset?.chatUser) || ""), 0);
      if (bridgeAction === "select-org") { const oid = (target?.closest?.("[data-org-id]")?.dataset?.orgId) || ""; selectedOrgId = (selectedOrgId === oid ? "" : oid); mountOrgPanel({ force: true }); }
      if (bridgeAction === "filter-org") { orgStatusFilter = (target?.closest?.("[data-org-status]")?.dataset?.orgStatus) || "all"; mountOrgPanel({ force: true }); }
      if (bridgeAction === "set-org-status") { const b = target?.closest?.("[data-org-id]"); const oid = b?.dataset?.orgId || ""; const stt = b?.dataset?.orgStatus || ""; if (oid && stt) setTimeout(() => setOrgStatus(oid, stt), 0); }
      if (bridgeAction === "delete-org") { openDeleteOrgModal((target?.closest?.("[data-org-id]")?.dataset?.orgId) || ""); }
      if (bridgeAction === "delete-org-cancel") closeDeleteOrgModal();
      if (bridgeAction === "delete-org-confirm") { const oid = (target?.closest?.("[data-org-id]")?.dataset?.orgId) || ""; closeDeleteOrgModal(); if (oid) setTimeout(() => deleteOrgById(oid), 0); }
      if (bridgeAction === "money-topup") openMoneyTopupModal((target?.closest?.("[data-cx-money-user]")?.dataset?.cxMoneyUser) || "");
      if (bridgeAction === "delete-user") { openDeleteUserModal((target?.closest?.("[data-cx-delete-user-id]")?.dataset?.cxDeleteUserId) || ""); }
      if (bridgeAction === "delete-user-cancel") closeDeleteUserModal();
      if (bridgeAction === "delete-user-confirm") { const uid = (target?.closest?.("[data-cx-delete-user-id]")?.dataset?.cxDeleteUserId) || ""; closeDeleteUserModal(); if (uid) setTimeout(() => deleteUserById(uid), 0); }
      if (bridgeAction === "package-create") openPackageModal(null);
      if (bridgeAction === "package-edit") openPackageModal(creditPackagesAll().find((p) => p.id === (target?.closest?.("[data-pkg-id]")?.dataset?.pkgId)) || null);
      if (bridgeAction === "package-delete") setTimeout(() => deletePackageById((target?.closest?.("[data-pkg-id]")?.dataset?.pkgId) || ""), 0);
      if (bridgeAction === "package-submit") setTimeout(savePackageFromUi, 0);
      if (bridgeAction === "package-cancel") closePackageModal();
      if (bridgeAction === "subplan-create") openSubPlanModal(null);
      if (bridgeAction === "subplan-edit") openSubPlanModal((subPlansCache || []).find((p) => p.code === (target?.closest?.("[data-plan-code]")?.dataset?.planCode)) || null);
      if (bridgeAction === "subplan-submit") setTimeout(saveSubPlanFromUi, 0);
      if (bridgeAction === "subplan-delete") setTimeout(() => deleteSubPlan(target?.closest?.("[data-plan-code]")?.dataset?.planCode || ""), 0);
      if (bridgeAction === "subplan-cancel") closeSubPlanModal();
      if (bridgeAction === "subrule-save") setTimeout(() => saveSubRuleFromUi(target?.closest?.("[data-plan-code]")?.dataset?.planCode || ""), 0);
      if (bridgeAction === "subrule-del") setTimeout(() => delSubRule(target?.closest?.("[data-plan-code]")?.dataset?.planCode || "", target?.closest?.("[data-svc]")?.dataset?.svc || ""), 0);
      if (bridgeAction === "subplan-assign") setTimeout(() => assignSubPlanUser(target?.closest?.("[data-plan-code]")?.dataset?.planCode || ""), 0);
      if (bridgeAction === "subgate-set") setTimeout(() => setSubGateMode(target?.closest?.("[data-gate]")?.dataset?.gate || "off"), 0);
      if (bridgeAction === "subsvc-toggle") setTimeout(() => toggleSubService(target?.closest?.("[data-plan-code]")?.dataset?.planCode || "", target?.closest?.("[data-svc]")?.dataset?.svc || "", (target?.closest?.("[data-enable]")?.dataset?.enable || "1") === "1"), 0);
      if (bridgeAction === "promo-create") openPromoModal(null);
      if (bridgeAction === "promo-edit") openPromoModal(promotionsAll().find((p) => p.id === (target?.closest?.("[data-promo-id]")?.dataset?.promoId)) || null);
      if (bridgeAction === "promo-delete") setTimeout(() => deletePromoById((target?.closest?.("[data-promo-id]")?.dataset?.promoId) || ""), 0);
      if (bridgeAction === "promo-submit") setTimeout(savePromoFromUi, 0);
      if (bridgeAction === "promo-cancel") closePromoModal();
      return;
    }

    // The design's native "Tạo tổ chức" button (on the Tổ chức B2B screen) has no bridge action and opens
    // a form WITHOUT the org-admin userId field. Route it to OUR modal so the org is always created mapped
    // to a real userId (→ that user gets the org UI in App User).
    const nativeOrgBtn = target?.closest?.("button,[role='button']");
    if (nativeOrgBtn && !nativeOrgBtn.dataset?.centrixServerAction && fold(nativeOrgBtn.textContent || "").trim() === "tao to chuc") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeAccountPopup();
      openCreateOrgModal();
      return;
    }

    // "Người dùng & Credit" "Nạp credit" button (bulk bar + user drawer). The static demo onclick is a no-op;
    // route it to a CUSTOM-amount modal → REAL adjust. Matches the relabeled "Nạp credit" (stamped
    // data-cx-nap-default by ensureTopupButton) AND the original "+ Nạp N credit" (before the relabel runs).
    const napBtn = target?.closest?.("[data-cx-nap-default]") || (() => {
      const b = target?.closest?.("button,[role='button']");
      if (!b || b.dataset?.centrixServerAction || b.dataset?.centrixModelAction) return null;
      return /^\+?\s*nap(\s+\d+)?\s+credit$/.test(fold(b.textContent || "").trim()) ? b : null;
    })();
    if (napBtn) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeAccountPopup();
      const def = Number(napBtn.dataset?.cxNapDefault) || (() => { const m = (napBtn.textContent || "").match(/(\d+)\s*credit/i); return m ? Number(m[1]) : 100; })();
      // If this "Nạp credit" sits inside a single user's detail drawer, preselect that user in the modal
      // (the drawer stamps its lock button with data-cx-lock-user-id — reuse it to identify the user).
      // Resolve the drawer's user the SAME proven way the "Nạp gói" button does — walk up to the single cx-<id>
      // code. The old aside/[role=dialog]/.drawer selector never matched the design's drawer, so preset stayed ""
      // → the modal fell back to the picker even when opened from a specific user.
      let presetUserId = lockBtnDrawerUserId(napBtn)
        || napBtn.closest?.("[data-cx-lock-user-id]")?.dataset?.cxLockUserId
        || napBtn.closest?.("aside,[role='dialog'],[class*='drawer'],[class*='Drawer']")?.querySelector?.("[data-cx-lock-user-id]")?.dataset?.cxLockUserId
        || "";
      setTimeout(() => openBulkTopupModal(def, presetUserId), 0);
      return;
    }

    // The user detail-drawer "Khóa tài khoản" / "Mở tài khoản" button (stamped by ensureAccountLockButton).
    // Read the STAMPED userId (never re-parse the DOM at click time) + re-derive direction from live state.
    const nativeLockBtn = target?.closest?.("[data-cx-lock-user-id]");
    if (nativeLockBtn && /^(khoa|mo)\s+tai\s+khoan$/.test(fold(nativeLockBtn.textContent || "").trim())) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeAccountPopup();
      const uid = nativeLockBtn.dataset.cxLockUserId || "";
      const user = (state.users || []).find((u) => u.id === uid);
      if (!uid || !user) { showActionToast("Không xác định được user để khóa/mở", "error"); return; }
      const isLocking = user.enabled !== false; // lock if currently active, unlock if currently locked
      if (isLocking) {
        const em = (state.accounts || []).find((a) => a && a.userId === uid)?.email || "";
        openConfirmModal({
          id: "cx-lock-user-modal", tone: "warn", icon: "lock", title: "Khóa tài khoản?",
          subtitle: `${escapeHtml(user.name || uid)}${em ? " · " + escapeHtml(em) : ""}`,
          noteHtml: `Phiên đang đăng nhập sẽ bị <b style="color:var(--text,#0f172a);">chặn ngay</b> và không đăng nhập lại được cho tới khi mở khóa.`,
          confirmLabel: "Khóa tài khoản", onConfirm: () => toggleUserLocked(uid, true)
        });
        return;
      }
      setTimeout(() => toggleUserLocked(uid, isLocking), 0);
      return;
    }

    // The bulk action bar "Khóa" / "Mở khóa" buttons (operate on the checkbox-selected users). The static
    // demo onclick is a no-op; route them to the REAL lock/unlock for every ticked user.
    const bulkLockBtn = target?.closest?.("button,[role='button']");
    if (bulkLockBtn && !bulkLockBtn.dataset?.centrixServerAction && !bulkLockBtn.dataset?.centrixModelAction && !bulkLockBtn.dataset?.cxLockUserId) {
      const bf = fold(bulkLockBtn.textContent || "").trim();
      if (bf === "khoa" || bf === "mo khoa") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeAccountPopup();
        const lock = bf === "khoa";
        const logic = currentLogic();
        let ids = [];
        try { ids = (typeof logic?.bulkTargets === "function" ? logic.bulkTargets() : typeof logic?.selIds === "function" ? logic.selIds() : []) || []; } catch (e) { ids = []; }
        ids = Array.from(new Set(ids.filter(Boolean)));
        if (!ids.length) { showActionToast("Hãy chọn (tick) ít nhất 1 user trước", "error"); return; }
        if (lock) {
          openConfirmModal({
            id: "cx-lock-user-modal", tone: "warn", icon: "lock", title: `Khóa ${ids.length} tài khoản đã chọn?`,
            noteHtml: `Phiên đang đăng nhập của các tài khoản này sẽ bị <b style="color:var(--text,#0f172a);">chặn ngay</b> cho tới khi mở khóa.`,
            confirmLabel: `Khóa ${ids.length} tài khoản`, onConfirm: () => bulkSetLocked(ids, lock)
          });
          return;
        }
        setTimeout(() => bulkSetLocked(ids, lock), 0);
        return;
      }
    }

    const connectAction = target?.closest?.("[data-centrix-connect-action]")?.dataset?.centrixConnectAction;
    if (connectAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (connectAction === "save") setTimeout(saveTunnelFromUi, 0);
      if (connectAction === "start") setTimeout(startTunnelFromUi, 0);
      if (connectAction === "stop") setTimeout(stopTunnelFromUi, 0);
      if (connectAction === "copy") setTimeout(() => copyText(connectionCopyUrl()), 0);
      return;
    }

    const serviceAction = target?.closest?.("[data-centrix-service-action]")?.dataset?.centrixServiceAction;
    if (serviceAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (serviceAction === "new") setTimeout(newApiService, 0);
      if (serviceAction === "reset") setTimeout(resetApiServices, 0);
      if (serviceAction === "save") setTimeout(saveApiService, 0);
      if (serviceAction === "delete") setTimeout(deleteApiService, 0);
      return;
    }

    const browserTab = target?.closest?.("[data-centrix-service-browser-tab]")?.dataset?.centrixServiceBrowserTab;
    if (browserTab) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setServiceBrowserTab(browserTab);
      return;
    }

    const loaderAction = target?.closest?.("[data-centrix-loader-action]")?.dataset?.centrixLoaderAction;
    if (loaderAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (loaderAction === "open") setTimeout(openLoaderBrowser, 0);
      else if (loaderAction === "login") {
        // Open the custodian browser at THIS service's login page (point the form at it first).
        const sid = target?.closest?.("[data-service-id]")?.dataset?.serviceId || "";
        if (sid) {
          state.serviceBrowser.selectedServiceId = sid;
          localStorage.setItem("centrixServerLoaderServiceId", sid);
          const svc = (state.services || []).find((s) => s.id === sid);
          const url = (svc && (svc.loginUrl || svc.url)) || "";
          const sel = document.getElementById("centrix-loader-service-select"); if (sel) sel.value = sid;
          const inp = document.getElementById("centrix-loader-url"); if (inp && url) inp.value = url;
          if (url) state.serviceBrowser.url = url;
        }
        setTimeout(openLoaderBrowser, 0);
      }
      else setTimeout(() => loaderCommand(loaderAction), 0);
      return;
    }

    const rulesAction = target?.closest?.("[data-centrix-rules-action]")?.dataset?.centrixRulesAction;
    if (rulesAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (rulesAction === "save") setTimeout(saveUiRules, 0);
      if (rulesAction === "save-blocked") setTimeout(saveBlockedLinks, 0);
      if (rulesAction === "preview") setTimeout(previewUiRules, 0);
      if (rulesAction === "select-hide") setTimeout(() => selectUiArea("hide"), 0);
      if (rulesAction === "select-replace") setTimeout(() => selectUiArea("replace"), 0);
      return;
    }

    const modelActionTarget = target?.closest?.("[data-centrix-model-action]");
    const modelAction = modelActionTarget?.dataset?.centrixModelAction;
    if (modelAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const actionModelId = modelActionTarget.dataset.modelId || "";
      if (modelAction === "save-prices") setTimeout(saveModelPricesFromUi, 0);
      if (modelAction === "add-observed") addModelDraftRow(actionModelId);
      if (modelAction === "check-observed") setTimeout(() => checkModelFromUi(actionModelId), 0);
      if (modelAction === "toggle-enabled") toggleModelDraftEnabled(actionModelId);
      if (modelAction === "step-credit") stepModelDraftCredit(actionModelId, Number(modelActionTarget.dataset.delta || 0));
      if (modelAction === "set-default") setModelDraftDefault(actionModelId);
      if (modelAction === "remove-model") removeModelDraftRow(actionModelId);
      if (modelAction === "refresh") setTimeout(refresh, 0);
      return;
    }

    const activityAction = target?.closest?.("[data-centrix-activity-action]")?.dataset?.centrixActivityAction;
    if (activityAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (activityAction === "refresh") setTimeout(refresh, 0);
      return;
    }

    const serviceRow = target?.closest?.("[data-centrix-service-id]");
    if (serviceRow) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      state.serviceUi.creating = false; // clicking a real service exits "Tạo mới" mode
      state.serviceUi.selectedId = serviceRow.dataset.centrixServiceId || "";
      pushServiceUrl(state.serviceUi.selectedId); // reflect selection in URL: /dich-vu/<id>
      mountServicesApiPanel({ force: true });
      return;
    }

    const label = fold(target?.textContent || "");
    if (!label) return;
    const screenText = fold(document.body?.innerText || "");

    if (screenText.includes("trinh duyet dich vu")) {
      if (label.includes("chon vung doi text")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setTimeout(() => selectUiArea("replace"), 0);
        return;
      }
      if (label.includes("chon vung an")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setTimeout(() => selectUiArea("hide"), 0);
        return;
      }
      if (label.includes("test tren browser nap")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setTimeout(previewUiRules, 0);
        return;
      }
      if (label.includes("dua len truoc")) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setTimeout(() => loaderCommand("show"), 0);
        return;
      }
    }

    if (label.includes("lam moi")) {
      setTimeout(refresh, 0);
      return;
    }

    if (label.includes("them nguoi dung")) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openCreateUserModal();
      return;
    }

    if (label === "duyet" || label.includes("duyet don") || label.includes("duyet order")) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setTimeout(approvePendingTopup, 0);
      return;
    }

    if (
      label.includes("dong ticket") ||
      label.includes("dong yeu cau") ||
      (label === "dong" && screenText.includes("ho tro / ticket"))
    ) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setTimeout(closeOpenTicket, 0);
    }
  }, true);

  document.addEventListener("input", (event) => {
    if (event.target?.id === "centrix-service-api-search") {
      // Re-rendering the panel to filter the list destroys THIS input (innerHTML swap) → focus + caret are lost,
      // so only the first keystroke registered. Capture the caret, re-render, then restore focus + caret so the
      // user can type the whole query continuously.
      const caret = event.target.selectionStart;
      state.serviceUi.filter = event.target.value || "";
      mountServicesApiPanel({ force: true });
      const again = document.getElementById("centrix-service-api-search");
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
      return;
    }
    if (event.target?.id === "centrix-model-test-id") {
      state.modelUi.testModelId = event.target.value || "";
      return;
    }
    if (event.target?.id === "centrix-activity-search") {
      // Re-render thay innerHTML → mất focus+caret của ô này (chỉ keystroke đầu đăng ký). Giữ caret rồi khôi phục.
      const caret = event.target.selectionStart;
      state.activityUi.query = event.target.value || "";
      activityPage = 1;
      mountActivityApiPanel({ force: true });
      const again = document.getElementById("centrix-activity-search");
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
      return;
    }
    if (event.target?.id === "centrix-ledger-search") {
      const caret = event.target.selectionStart;
      state.ledgerUi.query = event.target.value || "";
      ledgerPage = 1;
      mountLedgerApiPanel({ force: true });
      const again = document.getElementById("centrix-ledger-search");
      if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
      return;
    }
    if (event.target?.id === "centrix-loader-profile") {
      state.serviceBrowser.profileId = event.target.value || "default";
      localStorage.setItem("centrixServerLoaderProfile", state.serviceBrowser.profileId);
      return;
    }
    if (event.target?.id === "centrix-loader-tab") {
      state.serviceBrowser.loaderTabId = event.target.value || "profile-loader";
      localStorage.setItem("centrixServerLoaderTab", state.serviceBrowser.loaderTabId);
      return;
    }
    if (event.target?.id === "centrix-loader-url") {
      state.serviceBrowser.url = event.target.value || "";
      localStorage.setItem("centrixServerLoaderUrl", state.serviceBrowser.url);
      return;
    }
    if (event.target?.id === "centrix-browser-visual-text") {
      state.serviceBrowser.visualReplaceText = event.target.value || "";
      return;
    }
    if (
      event.target?.id === "centrix-browser-hide-selectors" ||
      event.target?.id === "centrix-browser-hide-rules" ||
      event.target?.id === "centrix-browser-replace-rules" ||
      event.target?.id === "centrix-browser-user-script"
    ) {
      if (event.target?.id === "centrix-browser-user-script" && String(event.target.value || "").trim()) {
        const enabledInput = document.getElementById("centrix-browser-rule-enabled");
        if (enabledInput) enabledInput.checked = true;
      }
      upsertLocalUiRuleDraft(ruleDraftFromDom());
    }
  }, true);

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target?.id === "centrix-model-service-select") {
      modelServiceTouchedThisSession = true;
      state.modelUi.serviceId = target.value || "";
      state.modelUi.testModelId = "";
      state.modelUi.priceDraft = null; // re-init the price table draft for the newly selected service
      localStorage.setItem("centrixServerModelServiceId", state.modelUi.serviceId);
      mountModelApiPanel({ force: true });
      return;
    }
    if (target?.id === "centrix-model-user-select") {
      state.modelUi.userId = target.value || "local-user";
      localStorage.setItem("centrixServerModelUserId", state.modelUi.userId);
      mountModelApiPanel({ force: true });
      return;
    }
    if (target?.id === "centrix-ledger-user-select") {
      state.ledgerUi.userId = target.value || "__all";
      localStorage.setItem("centrixServerLedgerUserId", state.ledgerUi.userId);
      ledgerPage = 1;
      mountLedgerApiPanel({ force: true });
      return;
    }
    if (target?.id === "centrix-activity-user-select") {
      state.activityUi.userId = target.value || "__all";
      localStorage.setItem("centrixServerActivityUserId", state.activityUi.userId);
      activityPage = 1;
      mountActivityApiPanel({ force: true });
      return;
    }
    if (target?.id === "centrix-loader-service-select") {
      state.serviceBrowser.selectedServiceId = target.value || "";
      localStorage.setItem("centrixServerLoaderServiceId", state.serviceBrowser.selectedServiceId);
      syncLoaderUrlFromService();
      mountServiceBrowserPanel({ force: true });
      // If a loader browser is already open, switch it to the newly selected service (its own tab/url).
      if (anyLoaderTabOpen()) setTimeout(() => openLoaderBrowser().catch(() => {}), 0);
      return;
    }
    if (target?.id === "centrix-browser-user-select") {
      state.serviceBrowser.selectedUserId = target.value || "local-user";
      localStorage.setItem("centrixServerSelectedUser", state.serviceBrowser.selectedUserId);
      mountServiceBrowserPanel({ force: true });
      return;
    }
    if (target?.id === "centrix-browser-rule-service-select") {
      const previousServiceId = state.serviceBrowser.selectedRuleServiceId || selectedRuleService()?.id || selectedLoaderService()?.id || "";
      if (previousServiceId) upsertLocalUiRuleDraft({ ...ruleDraftFromDom(), serviceId: previousServiceId });
      state.serviceBrowser.selectedRuleServiceId = target.value || "";
      localStorage.setItem("centrixServerRuleServiceId", state.serviceBrowser.selectedRuleServiceId);
      mountServiceBrowserPanel({ force: true });
      // If a loader browser is already open, open THIS service's own browser (loader-<serviceId>) so
      // editing rules for it never reuses the ChatGPT browser.
      if (anyLoaderTabOpen()) setTimeout(() => openLoaderBrowser().catch(() => {}), 0);
      return;
    }
    if (target?.id === "centrix-browser-rule-enabled") {
      upsertLocalUiRuleDraft(ruleDraftFromDom());
      return;
    }
    const accessServiceId = target?.dataset?.centrixAccessService;
    if (accessServiceId) {
      setUserServiceAccess(accessServiceId, target.checked).catch((error) => showActionToast(error.message || String(error), "error"));
    }
    if (target?.dataset?.centrixModelCreditId) {
      setModelDraftCredit(target.dataset.centrixModelCreditId, target.value);
    }
  }, true);

  // Live input handling for the model-pricing panel: filter the observed-model list (no re-render so
  // focus is kept) and keep the per-row credit draft synced as the admin types.
  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target?.id === "centrix-model-observation-search") {
      const query = fold(target.value || "");
      document.querySelectorAll("#centrix-model-observation-list [data-centrix-observation-row]").forEach((rowEl) => {
        const match = !query || (rowEl.getAttribute("data-centrix-observation-row") || "").includes(query);
        rowEl.style.display = match ? "" : "none";
      });
      return;
    }
    if (target?.dataset?.centrixModelCreditId) {
      setModelDraftCredit(target.dataset.centrixModelCreditId, target.value);
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && accountPopupOpen) {
      closeAccountPopup();
    }
  }, true);

  window.addEventListener("resize", () => {
    if (accountPopupOpen) ensureActionPanel();
  });

  window.centrixApiUiRefresh = refresh;
  window.centrixApiUiCreateUser = openCreateUserModal;
  window.centrixApiUiCreateOrg = openCreateOrgModal;
  window.centrixApiUiApproveTopup = approvePendingTopup;
  window.centrixApiUiCloseTicket = closeOpenTicket;
  // ── "Gói cước (gating)" — App Server admin tool for the plan-tier gating system (SEPARATE from the marketing
  // portal.plans cards). Self-contained floating button → modal; talks to /api/admin/plans/{list,assign,access}
  // (master-token). Plans/limits live in the Docker DB API, not portal JSON. The CENTRIX_PLAN_GATE mode is an env
  // flag (restart Docker to change); this tool configures plans/access/assignments only.
  function mountPlanGatingTool() {
    if (document.getElementById("cx-plan-gating-btn")) return;
    const btn = document.createElement("button");
    btn.id = "cx-plan-gating-btn";
    btn.type = "button";
    btn.textContent = "⚙ Gói cước";
    btn.title = "Quản lý gói cước (gating): gán user → gói, bật/tắt + giới hạn service theo gói";
    btn.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483000;height:38px;padding:0 15px;border:1px solid var(--brand-border,#bfdbfe);border-radius:999px;background:var(--brand,#2563eb);color:#fff;font:800 12.5px Segoe UI,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(37,99,235,.35);";
    btn.addEventListener("click", () => openPlanGatingModal());
    document.body.appendChild(btn);
  }
  function closePlanGatingModal() { document.getElementById("cx-plan-gating-modal")?.remove(); }
  async function openPlanGatingModal() {
    closePlanGatingModal();
    let data;
    try {
      data = await postJson("/api/admin/plans/list", {});
    } catch (e) {
      showActionToast(e?.message || "Không tải được gói cước", "error");
      return;
    }
    const plans = (data.plans || []).slice().sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
    const access = data.access || [];
    const planById = {};
    plans.forEach((p) => { planById[p.id] = p; });
    const gateMode = String(data.gateMode || "off");
    const modeColor = gateMode === "on" ? "#16a34a" : gateMode === "log" ? "#d97706" : "#64748b";
    const fieldCss = "height:36px;border:1px solid var(--field-border,#cbd5e1);border-radius:8px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:600 13px Segoe UI,system-ui,sans-serif;padding:0 10px;box-sizing:border-box;";
    const labelCss = "font:800 10.5px Segoe UI,system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;letter-spacing:.05em;";
    const planOptions = plans.map((p) => `<option value="${escapeHtml(p.code)}">${escapeHtml(p.code)} (${Number(p.free_grant) || 0} cr)</option>`).join("");
    const planRows = plans.map((p) => `<div style="display:flex;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid var(--border-soft,#eef2f7);flex-wrap:wrap;"><b style="color:var(--text,#0f172a);width:52px;flex-shrink:0;">${escapeHtml(p.code)}</b><input data-cx-pe="name" data-code="${escapeHtml(p.code)}" value="${escapeHtml(p.name || "")}" title="Tên gói" style="${fieldCss}flex:2;min-width:96px;height:32px;"><input data-cx-pe="price" data-code="${escapeHtml(p.code)}" type="number" min="0" value="${Number(p.price) || 0}" title="Giá (VND)" style="${fieldCss}flex:1;min-width:78px;height:32px;"><input data-cx-pe="free" data-code="${escapeHtml(p.code)}" type="number" min="0" value="${Number(p.free_grant) || 0}" title="Credit free / kỳ" style="${fieldCss}width:70px;flex-shrink:0;height:32px;"><input data-cx-pe="prio" data-code="${escapeHtml(p.code)}" type="number" min="1" value="${Number(p.priority) || 1}" title="Thứ tự (1=thấp)" style="${fieldCss}width:46px;flex-shrink:0;height:32px;"><button type="button" data-cx-plan-save="${escapeHtml(p.code)}" style="height:32px;border:0;border-radius:7px;background:var(--brand,#2563eb);color:#fff;font:800 11.5px Segoe UI;cursor:pointer;padding:0 12px;flex-shrink:0;">Lưu</button></div>`).join("");
    const ruleRows = access.length ? access.map((a) => {
      const code = (planById[a.plan_id] && planById[a.plan_id].code) || a.plan_id;
      const off = !a.is_enabled;
      const lim = [];
      if (Number(a.daily_limit) > 0) lim.push("ngày " + a.daily_limit);
      if (Number(a.monthly_limit) > 0) lim.push("tháng " + a.monthly_limit);
      const allow = a.allowed_models ? " · models:" + escapeHtml(a.allowed_models) : "";
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--border-soft,#eef2f7);font-size:12.5px;"><div style="min-width:0;"><b style="color:var(--text,#0f172a);">${escapeHtml(code)}</b> → <span style="color:var(--text-2,#475569);">${escapeHtml(a.service_id)}</span> <span style="color:${off ? "#dc2626" : "#16a34a"};font-weight:700;">${off ? "TẮT" : "BẬT"}</span><span style="color:var(--text-3,#94a3b8);">${lim.length ? " · " + lim.join(" · ") : ""}${allow}</span></div><button type="button" data-cx-rule-del data-plan="${escapeHtml(code)}" data-svc="${escapeHtml(a.service_id)}" style="height:28px;border:1px solid #fecaca;border-radius:7px;background:#fff;color:#dc2626;font-weight:700;font-size:11.5px;cursor:pointer;padding:0 10px;flex-shrink:0;">Xoá</button></div>`;
    }).join("") : `<div style="padding:14px;text-align:center;color:var(--text-3,#94a3b8);font-size:12.5px;">Chưa có rule → mọi gói dùng mọi service (permissive).</div>`;
    const overlay = document.createElement("div");
    overlay.id = "cx-plan-gating-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.innerHTML = `
      <div role="dialog" style="width:580px;max-width:calc(100vw - 36px);max-height:calc(100vh - 50px);overflow:auto;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;box-sizing:border-box;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
          <div><div style="font:900 18px Segoe UI,system-ui,sans-serif;color:var(--text,#0f172a);">Gói cước (gating)</div><div style="font-size:12.5px;color:var(--text-2,#475569);margin-top:3px;">Phân tầng truy cập + giới hạn. Giá vẫn tính per-model. Khác "thẻ marketing".</div></div>
          <div style="text-align:right;flex-shrink:0;"><div style="${labelCss}">Gate</div><div style="font:900 15px Segoe UI;color:${modeColor};">${escapeHtml(gateMode.toUpperCase())}</div></div>
        </div>
        <div style="margin-top:16px;${labelCss}">Các gói</div>
        <div style="margin-top:6px;">${planRows}</div>
        <div style="margin-top:18px;${labelCss}">Gán user → gói</div>
        <div style="display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap;">
          <input id="cx-pg-uid" placeholder="userId" style="${fieldCss}flex:2;min-width:140px;">
          <select id="cx-pg-uplan" style="${fieldCss}flex:1;min-width:90px;">${planOptions}</select>
          <button type="button" id="cx-pg-assign" style="height:36px;border:0;border-radius:8px;background:var(--brand,#2563eb);color:#fff;font:800 12.5px Segoe UI;cursor:pointer;padding:0 16px;">Gán</button>
        </div>
        <div style="margin-top:18px;${labelCss}">Rule theo (gói, service)</div>
        <div style="margin-top:6px;">${ruleRows}</div>
        <div style="margin-top:10px;padding:12px;border:1px dashed var(--border,#e2e8f0);border-radius:10px;display:flex;flex-direction:column;gap:8px;">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <select id="cx-pg-rplan" style="${fieldCss}flex:1;min-width:90px;">${planOptions}</select>
            <input id="cx-pg-rsvc" placeholder="serviceId (vd claude)" style="${fieldCss}flex:1.4;min-width:130px;">
            <label style="display:flex;align-items:center;gap:6px;font:700 12.5px Segoe UI;color:var(--text-2,#475569);cursor:pointer;"><input id="cx-pg-renabled" type="checkbox" checked> Bật</label>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <input id="cx-pg-rdaily" type="number" min="0" placeholder="trần ngày (credit)" style="${fieldCss}flex:1;min-width:115px;">
            <input id="cx-pg-rmonthly" type="number" min="0" placeholder="trần tháng (credit)" style="${fieldCss}flex:1;min-width:115px;">
            <input id="cx-pg-rmodels" placeholder="allowed models (phẩy, trống=tất cả)" style="${fieldCss}flex:2;min-width:150px;">
            <button type="button" id="cx-pg-rsave" style="height:36px;border:0;border-radius:8px;background:var(--brand,#2563eb);color:#fff;font:800 12.5px Segoe UI;cursor:pointer;padding:0 16px;">Lưu rule</button>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:18px;"><button type="button" id="cx-pg-close" style="height:40px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI;cursor:pointer;padding:0 20px;">Đóng</button></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closePlanGatingModal(); });
    document.getElementById("cx-pg-close")?.addEventListener("click", closePlanGatingModal);
    document.getElementById("cx-pg-assign")?.addEventListener("click", async () => {
      const userId = String(document.getElementById("cx-pg-uid")?.value || "").trim();
      const planCode = String(document.getElementById("cx-pg-uplan")?.value || "");
      if (!userId) { showActionToast("Nhập userId", "error"); return; }
      try {
        const r = await postJson("/api/admin/plans/assign", { userId, planCode });
        showActionToast("Đã gán " + userId + " → " + planCode + (r.grantedCredit ? " (+" + r.grantedCredit + " cr)" : ""));
      } catch (e) { showActionToast(e?.message || "Gán thất bại", "error"); }
    });
    document.getElementById("cx-pg-rsave")?.addEventListener("click", async () => {
      const planCode = String(document.getElementById("cx-pg-rplan")?.value || "");
      const serviceId = String(document.getElementById("cx-pg-rsvc")?.value || "").trim();
      if (!serviceId) { showActionToast("Nhập serviceId", "error"); return; }
      const isEnabled = !!document.getElementById("cx-pg-renabled")?.checked;
      const dailyLimit = Math.max(0, Math.round(Number(document.getElementById("cx-pg-rdaily")?.value || 0)));
      const monthlyLimit = Math.max(0, Math.round(Number(document.getElementById("cx-pg-rmonthly")?.value || 0)));
      const allowedModels = String(document.getElementById("cx-pg-rmodels")?.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      try {
        await postJson("/api/admin/plans/access", { planCode, serviceId, isEnabled, dailyLimit, monthlyLimit, allowedModels });
        showActionToast("Đã lưu rule " + planCode + " → " + serviceId);
        openPlanGatingModal();
      } catch (e) { showActionToast(e?.message || "Lưu rule thất bại", "error"); }
    });
    overlay.querySelectorAll("[data-cx-rule-del]").forEach((b) => {
      b.addEventListener("click", async () => {
        const planCode = b.getAttribute("data-plan");
        const serviceId = b.getAttribute("data-svc");
        try {
          await postJson("/api/admin/plans/access", { planCode, serviceId, remove: true });
          showActionToast("Đã xoá rule " + planCode + " → " + serviceId);
          openPlanGatingModal();
        } catch (e) { showActionToast(e?.message || "Xoá thất bại", "error"); }
      });
    });
    overlay.querySelectorAll("[data-cx-plan-save]").forEach((b) => {
      b.addEventListener("click", async () => {
        const code = b.getAttribute("data-cx-plan-save");
        const get = (k) => overlay.querySelector('[data-cx-pe="' + k + '"][data-code="' + code + '"]');
        const name = String(get("name")?.value || "").trim();
        const price = Math.max(0, Math.round(Number(get("price")?.value || 0)));
        const free_grant = Math.max(0, Math.round(Number(get("free")?.value || 0)));
        const priority = Math.max(1, Math.round(Number(get("prio")?.value || 1)));
        try {
          await postJson("/api/admin/plans/save", { code, name, price, free_grant, priority });
          showActionToast("Đã lưu gói " + code);
          openPlanGatingModal();
        } catch (e) { showActionToast(e?.message || "Lưu gói thất bại", "error"); }
      });
    });
  }

  // ── "Gói cước thuê bao" (subscription plans) — App Server admin CRUD wired to the Docker plan tables via
  // /api/admin/plans/* (list/save/access/assign). Replaces the design's demo cards with REAL plans; "Sửa gói"
  // and "+ Tạo gói" are real. ALL plan functions (edit fields + per-plan service rules + assign user) live in
  // the edit modal — mirrors the credit-package CRUD pattern; no floating button.
  let subPlansCache = null;
  let assignPlanDurMonths = 1; // sticky across modal REOPENS (subPlansCache-null → reopen was resetting selDur→1)
  let subAccessCache = [];
  let subGateMode = "off";
  function subPlanPrice(n) { n = Number(n) || 0; return n <= 0 ? "0₫" : (n % 1000 === 0 ? (n / 1000) + "K" : n.toLocaleString("vi-VN") + "₫"); }
  function subPlanFeatures(p) {
    let f = p && p.features;
    if (typeof f === "string") { try { f = JSON.parse(f || "[]"); } catch (e) { f = []; } }
    return Array.isArray(f) ? f.filter((x) => typeof x === "string") : [];
  }
  function findSubscriptionPlanScreen() {
    return visibleScreens().find((s) => fold(s.getAttribute("data-screen-label")).includes("goi cuoc")) || null;
  }
  async function loadSubPlans() {
    try {
      const r = await postJson("/api/admin/plans/list", {});
      subPlansCache = Array.isArray(r.plans) ? r.plans.slice().sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0)) : [];
      subAccessCache = Array.isArray(r.access) ? r.access : [];
      subGateMode = r.gateMode || "off";
      mountSubscriptionPlanPanel({ force: true });
    } catch (e) { /* keep the design demo until data loads */ }
  }
  async function setSubGateMode(mode) {
    try {
      const r = await postJson("/api/admin/plans/gate", { mode });
      subGateMode = r.gateMode || mode;
      showActionToast("Chế độ chặn theo gói: " + String(subGateMode).toUpperCase());
      mountSubscriptionPlanPanel({ force: true });
    } catch (e) { showActionToast(e?.message || "Đổi chế độ thất bại", "error"); }
  }
  function mountSubscriptionPlanPanel(options = {}) {
    const screen = findSubscriptionPlanScreen();
    if (!screen) return false;
    if (subPlansCache === null) { loadSubPlans(); return false; }
    // Hide inactive/legacy plans (is_active=0) — e.g. the frozen per-customer Pro kept for old customers. It still
    // works for its existing subscribers but must not be edited/deleted here (a stray access rule would break them).
    const plans = subPlansCache.filter((p) => Number(p.is_active) !== 0);
    const key = "sp|" + subGateMode + "|" + plans.map((p) => p.code + ":" + p.name + ":" + p.price + ":" + p.free_grant + ":" + p.priority).join(",");
    if (!options.force && screen.dataset.cxSubPlanMount === key) return true;
    screen.dataset.cxSubPlanMount = key;
    const cards = plans.length ? plans.map((p) => {
      const credits = (Number(p.free_grant) || 0).toLocaleString("vi-VN");
      const paid = (Number(p.price) || 0) > 0;
      return `<div style="border:1px solid var(--border);border-radius:14px;padding:18px 20px;background:var(--surface-2);display:flex;flex-direction:column;gap:9px;">`
        + `<div style="font-size:16px;font-weight:800;color:var(--text);">${escapeHtml(p.name || p.code)} <span style="font-size:11px;font-weight:700;color:var(--text-3);background:var(--surface-3);border-radius:999px;padding:2px 8px;">${escapeHtml(p.code)}</span></div>`
        + `<div style="font-size:24px;font-weight:900;color:var(--text);">${escapeHtml(subPlanPrice(p.price))}<span style="font-size:12px;font-weight:600;color:var(--text-3);"> ${paid ? "/ tháng" : "miễn phí"}</span></div>`
        + ((Number(p.price_annual) || 0) > 0 ? `<div style="font-size:12.5px;color:var(--text-3);font-weight:700;margin-top:-4px;">hoặc ${escapeHtml(subPlanPrice(p.price_annual))} / 12 tháng</div>` : "")
        + `<div style="font-size:13px;color:var(--brand);font-weight:700;">${credits} credit / kỳ</div>`
        + `<div style="font-size:12px;color:var(--text-3);">Ưu tiên ${Number(p.priority) || 0} · ${escapeHtml(p.grant_policy || "")}</div>`
        + `<div style="display:flex;gap:8px;margin-top:6px;">`
        + `<button type="button" data-centrix-server-action="subplan-edit" data-plan-code="${escapeHtml(p.code)}" style="flex:1;height:38px;border:1px solid var(--field-border);border-radius:9px;background:var(--surface);color:var(--text);font-weight:700;font-size:13px;cursor:pointer;">Sửa gói</button>`
        + (String(p.code).toUpperCase() !== "FREE" ? `<button type="button" data-centrix-server-action="subplan-delete" data-plan-code="${escapeHtml(p.code)}" style="height:38px;padding:0 14px;border:1px solid #fecaca;border-radius:9px;background:var(--danger-soft,#fef2f2);color:var(--danger,#ef4444);font-weight:800;font-size:13px;cursor:pointer;white-space:nowrap;">Xóa</button>` : "")
        + `</div>`
        + `</div>`;
    }).join("") : `<div style="grid-column:1/-1;padding:44px;text-align:center;color:var(--text-3);font-size:13.5px;">Chưa có gói nào. Bấm "+ Tạo gói" để thêm.</div>`;
    screen.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px;">
        <div><div style="font-size:21px;font-weight:700;color:var(--text);">Gói cước thuê bao</div><div style="font-size:13.5px;color:var(--text-2);margin-top:5px;">Các gói thật — sửa giá/credit/quyền ở đây, App User cập nhật theo. Giá vẫn tính per-model.</div></div>
        <button type="button" data-centrix-server-action="subplan-create" style="font-size:13.5px;font-weight:700;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:10px 18px;cursor:pointer;white-space:nowrap;">+ Tạo gói</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;"><span style="font-size:12px;color:var(--text-3);font-weight:600;">Chế độ chặn dịch vụ theo gói:</span>${["off", "log", "on"].map((m) => { const on = subGateMode === m; const lbl = m === "off" ? "Tắt" : (m === "log" ? "Theo dõi" : "Bật chặn"); return `<button type="button" data-centrix-server-action="subgate-set" data-gate="${m}" style="border:1px solid ${on ? "var(--brand)" : "var(--border)"};background:${on ? "var(--brand-soft)" : "var(--surface)"};color:${on ? "var(--brand)" : "var(--text-2)"};font-weight:700;font-size:12px;border-radius:8px;padding:6px 12px;cursor:pointer;">${lbl}</button>`; }).join("")}<span style="font-size:11px;color:var(--text-3);">(Tắt = không chặn ai)</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;align-items:start;">${cards}</div>`;
    return true;
  }
  function scheduleSubscriptionPlanPanel() {
    registerBodyTick(mountSubscriptionPlanPanel);
    for (const d of [400, 1200, 2400]) setTimeout(mountSubscriptionPlanPanel, d);
  }
  function closeSubPlanModal() { document.getElementById("cx-subplan-modal")?.remove(); }
  function openSubPlanModal(plan) {
    closeSubPlanModal();
    const p = plan || {};
    const isEdit = !!p.code;
    const fc = "width:100%;height:38px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:600 13px Segoe UI;padding:0 12px;box-sizing:border-box;";
    const lc = "display:flex;flex-direction:column;gap:5px;margin-top:11px;font:800 10.5px Segoe UI;color:var(--label,#64748b);text-transform:uppercase;";
    const rules = isEdit ? subAccessCache.filter((a) => { const pl = (subPlansCache || []).find((x) => x.id === a.plan_id); return pl && pl.code === p.code; }) : [];
    const ruleByService = {};
    rules.forEach((a) => { ruleByService[a.service_id] = a; });
    // Show ALL services with an on/off toggle (not a free-text rule). A service is ON when allowed (no rule OR
    // rule.is_enabled=1) and OFF when a rule disables it. Source = state.services; also include any service that
    // already has a rule for this plan but isn't in that list.
    const svcList = (() => {
      const list = (Array.isArray(state.services) ? state.services : []).map((s) => ({ id: s.id, name: s.name || s.id }));
      const known = new Set(list.map((s) => s.id));
      rules.forEach((a) => { if (a.service_id && !known.has(a.service_id)) { known.add(a.service_id); list.push({ id: a.service_id, name: a.service_id }); } });
      return list;
    })();
    const svcRows = svcList.length ? svcList.map((s) => {
      const r = ruleByService[s.id];
      const allowed = !r || !!r.is_enabled;
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-soft);font-size:12.5px;"><span style="color:var(--text);">${escapeHtml(s.name)}</span><button type="button" data-centrix-server-action="subsvc-toggle" data-plan-code="${escapeHtml(p.code)}" data-svc="${escapeHtml(s.id)}" data-enable="${allowed ? "0" : "1"}" style="border:1px solid ${allowed ? "#86efac" : "#fecaca"};background:${allowed ? "#f0fdf4" : "#fff5f5"};color:${allowed ? "#16a34a" : "#dc2626"};font-weight:800;font-size:11.5px;border-radius:999px;padding:4px 16px;cursor:pointer;min-width:52px;">${allowed ? "Bật" : "Tắt"}</button></div>`;
    }).join("") : `<div style="font-size:11.5px;color:var(--text-3);padding:6px 0;">Chưa tải được danh sách dịch vụ (chờ App Server kết nối rồi mở lại).</div>`;
    const overlay = document.createElement("div");
    overlay.id = "cx-subplan-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.innerHTML = `<div role="dialog" style="width:480px;max-width:calc(100vw - 40px);max-height:calc(100vh - 50px);overflow:auto;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:22px 24px;box-sizing:border-box;">
      <div style="font:900 18px Segoe UI;color:var(--text,#0f172a);">${isEdit ? "Sửa gói" : "Tạo gói"}</div>
      <label style="${lc}">Mã gói (CODE) <input id="cx-sp-code" value="${escapeHtml(p.code || "")}" ${isEdit ? "readonly" : ""} placeholder="vd PRO" style="${fc}${isEdit ? "opacity:.6;" : ""}"></label>
      <label style="${lc}">Tên hiển thị <input id="cx-sp-name" value="${escapeHtml(p.name || "")}" placeholder="vd Pro" style="${fc}"></label>
      <div style="display:flex;gap:12px;"><label style="${lc}flex:1;">Giá 1 tháng (VND) <input id="cx-sp-price" type="number" min="0" value="${Number(p.price) || 0}" style="${fc}"></label><label style="${lc}flex:1;">Giá 12 tháng (VND) — 0 = không bán gói năm <input id="cx-sp-price-annual" type="number" min="0" value="${Number(p.price_annual) || 0}" style="${fc}"></label></div>
      <div style="display:flex;gap:12px;"><label style="${lc}flex:1;">Credit/kỳ <input id="cx-sp-free" type="number" min="0" value="${Number(p.free_grant) || 0}" style="${fc}"></label><label style="${lc}width:110px;">Ưu tiên <input id="cx-sp-prio" type="number" min="1" value="${Number(p.priority) || 1}" style="${fc}"></label></div>
      <label style="${lc}">Mô tả / tính năng — mỗi dòng là 1 gạch đầu dòng hiện trên thẻ gói ở App User <textarea id="cx-sp-features" spellcheck="false" placeholder="vd:&#10;Truy cập ChatGPT&#10;1.000 credit / tháng&#10;3 thiết bị&#10;Ưu tiên hỗ trợ" style="${fc}height:auto;min-height:108px;padding:10px 12px;resize:vertical;font:600 13px Segoe UI;line-height:1.5;">${escapeHtml(subPlanFeatures(p).join("\n"))}</textarea></label>
      <div style="display:flex;gap:10px;margin-top:18px;">
        <button type="button" data-centrix-server-action="subplan-cancel" style="flex:1;height:40px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI;cursor:pointer;">Hủy</button>
        <button type="button" data-centrix-server-action="subplan-submit" style="flex:1.4;height:40px;border:0;border-radius:9px;background:var(--brand,#2563eb);color:#fff;font:900 13px Segoe UI;cursor:pointer;">${isEdit ? "Lưu gói" : "Tạo gói"}</button>
      </div>
      ${isEdit ? `<div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px;">
        <div style="font:800 11px Segoe UI;color:var(--label);text-transform:uppercase;">Quyền truy cập dịch vụ — gói ${escapeHtml(p.code)}</div>
        <div style="font-size:11px;color:var(--text-3);margin:4px 0 8px;">Tắt dịch vụ nào → user gói này KHÔNG dùng được dịch vụ đó (cần bật "Chế độ chặn" ở tab Gói cước).</div>
        <div>${svcRows}</div>
        <div style="display:flex;gap:6px;margin-top:16px;align-items:center;">
          <input id="cx-sp-uid" placeholder="gán userId vào gói này" style="${fc}flex:1;height:34px;">
          <button type="button" data-centrix-server-action="subplan-assign" data-plan-code="${escapeHtml(p.code)}" style="height:34px;border:1px solid var(--brand-border,#bfdbfe);border-radius:7px;background:var(--brand-soft);color:var(--brand);font:800 12px Segoe UI;cursor:pointer;padding:0 12px;">Gán</button>
        </div>
      </div>` : ""}
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeSubPlanModal(); });
    setTimeout(() => document.getElementById("cx-sp-name")?.focus(), 50);
  }
  async function saveSubPlanFromUi() {
    const code = String(document.getElementById("cx-sp-code")?.value || "").trim().toUpperCase();
    if (!code) { showActionToast("Cần mã gói (CODE)", "error"); return; }
    const features = String(document.getElementById("cx-sp-features")?.value || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 12);
    try {
      await postJson("/api/admin/plans/save", {
        code,
        name: String(document.getElementById("cx-sp-name")?.value || "").trim() || code,
        price: Math.max(0, Math.round(Number(document.getElementById("cx-sp-price")?.value || 0))),
        price_annual: Math.max(0, Math.round(Number(document.getElementById("cx-sp-price-annual")?.value || 0))),
        free_grant: Math.max(0, Math.round(Number(document.getElementById("cx-sp-free")?.value || 0))),
        priority: Math.max(1, Math.round(Number(document.getElementById("cx-sp-prio")?.value || 1))),
        features,
      });
      showActionToast("Đã lưu gói " + code);
      closeSubPlanModal();
      loadSubPlans();
    } catch (e) { showActionToast(e?.message || "Lưu gói thất bại", "error"); }
  }
  async function deleteSubPlan(code) {
    code = String(code || "").trim().toUpperCase();
    if (!code) return;
    if (code === "FREE") { showActionToast("Không thể xóa gói FREE (gói hệ thống)", "error"); return; }
    const plan = (subPlansCache || []).find((p) => String(p.code).toUpperCase() === code);
    const name = plan ? (plan.name || code) : code;
    if (!window.confirm(`Xóa gói "${name}" (${code})?\nKhông xóa được nếu còn user đang dùng gói này.`)) return;
    try {
      await postJson("/api/admin/plans/delete", { code });
      showActionToast("Đã xóa gói " + code, "ok");
      loadSubPlans();
    } catch (e) { showActionToast(e?.message || "Xóa gói thất bại", "error"); }
  }
  async function saveSubRuleFromUi(planCode) {
    const svc = String(document.getElementById("cx-sp-rsvc")?.value || "").trim();
    if (!svc) { showActionToast("Nhập serviceId", "error"); return; }
    try {
      await postJson("/api/admin/plans/access", { planCode, serviceId: svc, isEnabled: !!document.getElementById("cx-sp-ren")?.checked, dailyLimit: Math.max(0, Math.round(Number(document.getElementById("cx-sp-rday")?.value || 0))) });
      showActionToast("Đã lưu rule " + planCode + " → " + svc);
      await loadSubPlans();
      openSubPlanModal((subPlansCache || []).find((p) => p.code === planCode));
    } catch (e) { showActionToast(e?.message || "Lưu rule thất bại", "error"); }
  }
  async function toggleSubService(planCode, svc, enable) {
    if (!svc) return;
    try {
      await postJson("/api/admin/plans/access", { planCode, serviceId: svc, isEnabled: enable });
      showActionToast((enable ? "Bật" : "Tắt") + " " + svc + " cho gói " + planCode);
      await loadSubPlans();
      openSubPlanModal((subPlansCache || []).find((p) => p.code === planCode));
    } catch (e) { showActionToast(e?.message || "Đổi quyền thất bại", "error"); }
  }
  async function delSubRule(planCode, svc) {
    try {
      await postJson("/api/admin/plans/access", { planCode, serviceId: svc, remove: true });
      showActionToast("Đã xoá rule");
      await loadSubPlans();
      openSubPlanModal((subPlansCache || []).find((p) => p.code === planCode));
    } catch (e) { showActionToast(e?.message || "Lỗi", "error"); }
  }
  async function assignSubPlanUser(planCode) {
    const uid = String(document.getElementById("cx-sp-uid")?.value || "").trim();
    if (!uid) { showActionToast("Nhập userId", "error"); return; }
    try {
      const r = await postJson("/api/admin/plans/assign", { userId: uid, planCode });
      showActionToast("Đã gán " + uid + " → " + planCode + (r.grantedCredit ? " (+" + r.grantedCredit + " cr)" : ""));
    } catch (e) { showActionToast(e?.message || "Gán thất bại", "error"); }
  }

  // ── User-drawer "Nạp gói": assign a plan to the SINGLE drawer user (reuses /api/admin/plans/assign which
  //    grants the plan's free credit, like the Gói cước page). A "Nạp gói" button is injected next to the
  //    drawer's "Nạp credit"; clicking it opens a plan picker. After assign we refresh so the badge updates.
  function closeAssignPlanModal() { document.getElementById("cx-assign-plan-modal")?.remove(); }
  function openAssignPlanModal(userId) {
    const user = (state.users || []).find((u) => u.id === userId);
    if (!user) { showActionToast("Không xác định được user", "error"); return; }
    if (subPlansCache === null) { // plans not loaded (Gói cước never opened) → load THEN open the modal ONCE.
      // (Previously it opened a LOADING modal + reopened when plans arrived — that reopen rebuilt the duration
      //  selector back to "1 tháng", so a 12-tháng pick made during the ~0.5s load was silently lost.)
      loadSubPlans().then(() => openAssignPlanModal(userId));
      return;
    }
    // Only offer ACTIVE plans (is_active !== 0). Hidden/legacy plans (e.g. the per-customer Pro kept for old
    // customers) still resolve for their existing subscribers but must not be assignable to anyone new.
    const plans = (subPlansCache || []).filter((p) => Number(p.is_active) !== 0);
    const cur = String(user.plan || "FREE").toUpperCase();
    closeAssignPlanModal();
    const rows = plans.length ? plans.map((p) => {
      const code = String(p.code || "").toUpperCase();
      const isCur = code === cur;
      const grant = Number(p.free_grant) || 0;
      return `<button type="button" data-cx-assign-pick="${escapeHtml(code)}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;margin-top:8px;padding:12px 14px;border:1px solid ${isCur ? "#86efac" : "var(--field-border,#cbd5e1)"};border-radius:11px;background:${isCur ? "#f0fdf4" : "var(--surface,#fff)"};color:var(--text,#0f172a);cursor:pointer;font:700 13px 'Segoe UI',system-ui,sans-serif;">
        <span><span style="font-weight:900;">${escapeHtml(p.name || code)}</span> <span style="color:var(--text-3);font-weight:600;">· ${escapeHtml(code)}</span>${grant ? `<div style="font-size:11.5px;color:var(--text-3);font-weight:600;margin-top:2px;">+${grant} credit/kỳ</div>` : ""}</span>
        <span style="font:800 12px 'Segoe UI',system-ui,sans-serif;color:${isCur ? "#16a34a" : "var(--brand)"};white-space:nowrap;">${isCur ? "Đang dùng · Gia hạn" : "Nạp gói này"}</span>
      </button>`;
    }).join("") : `<div style="padding:18px 0;text-align:center;color:var(--text-3);font-size:13px;">Đang tải danh sách gói… mở lại sau giây lát.</div>`;
    const body = `<div style="display:flex;gap:8px;align-items:center;">
        <span style="font:700 12.5px 'Segoe UI',system-ui,sans-serif;color:var(--text-2,#475569);white-space:nowrap;">Thời hạn:</span>
        <button type="button" data-cx-dur="1" style="flex:1;height:36px;border-radius:10px;border:1px solid var(--field-border,#cbd5e1);background:var(--surface,#fff);color:var(--text,#0f172a);font:800 12.5px 'Segoe UI',system-ui,sans-serif;cursor:pointer;">1 tháng</button>
        <button type="button" data-cx-dur="12" style="flex:1;height:36px;border-radius:10px;border:1px solid var(--field-border,#cbd5e1);background:var(--surface,#fff);color:var(--text,#0f172a);font:800 12.5px 'Segoe UI',system-ui,sans-serif;cursor:pointer;">12 tháng</button>
      </div>
      <div style="margin-top:2px;">${rows}</div>`;
    const footer = `<div style="margin-top:18px;"><button type="button" data-cx-assign-close="1" style="width:100%;height:44px;border:1px solid var(--field-border,#cbd5e1);border-radius:11px;background:var(--surface,#fff);color:var(--text-2,#475569);font:800 13px 'Segoe UI',system-ui,sans-serif;cursor:pointer;">Đóng</button></div>`;
    const overlay = cxModalOverlay("cx-assign-plan-modal");
    overlay.innerHTML = cxModalCard({
      tone: "brand", icon: "plan",
      title: `Nạp gói cho ${escapeHtml(user.name || userId)}`,
      subtitle: `Gói hiện tại: <b style="color:var(--text,#0f172a);">${escapeHtml(user.planName || user.plan || "Free")}</b>. Chọn thời hạn rồi bấm gói — credit miễn phí của gói cộng vào ví (idempotent). Hết hạn tự về Free.`,
      width: 430, body, footer
    });
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeAssignPlanModal(); });
    overlay.querySelector("[data-cx-assign-close]")?.addEventListener("click", closeAssignPlanModal);
    let selDur = assignPlanDurMonths === 12 ? 12 : 1; // restore the last-picked duration (survives the reopen)
    const durBtns = overlay.querySelectorAll("[data-cx-dur]");
    const paintDur = () => durBtns.forEach((b) => {
      const on = Number(b.getAttribute("data-cx-dur")) === selDur;
      b.style.background = on ? "var(--brand,#2563eb)" : "var(--surface,#fff)";
      b.style.color = on ? "#fff" : "var(--text,#0f172a)";
      b.style.borderColor = on ? "var(--brand,#2563eb)" : "var(--field-border,#cbd5e1)";
    });
    durBtns.forEach((b) => b.addEventListener("click", () => { selDur = Number(b.getAttribute("data-cx-dur")) || 1; assignPlanDurMonths = selDur; paintDur(); }));
    paintDur();
    // All active plans are theo-gói (service set comes from the plan gate) → assign directly on click. Read the
    // duration from the LIVE highlighted button at click time (not just the closure) so it is always current.
    overlay.querySelectorAll("[data-cx-assign-pick]").forEach((b) => {
      b.addEventListener("click", () => {
        const dur = (assignPlanDurMonths === 12 || selDur === 12) ? 12 : 1;
        assignPlanToUser(userId, b.getAttribute("data-cx-assign-pick"), dur);
      });
    });
  }
  async function assignPlanToUser(userId, planCode, durationMonths = 1) {
    try {
      const r = await postJson("/api/admin/plans/assign", { userId, planCode, grant: true, durationMonths });
      const durTxt = String(planCode).toUpperCase() === "FREE" ? "" : (Number(durationMonths) === 12 ? " · 12 tháng" : " · 1 tháng");
      showActionToast("Đã nạp gói " + planCode + durTxt + (r && r.grantedCredit ? " (+" + r.grantedCredit + " credit)" : ""));
      // Optimistic: reflect the new plan (+ granted credit) on the row/badge INSTANTLY (mirrors how lock/topup
      // update state locally). The awaited refresh below — the dbapi now invalidates its read cache on assign so
      // /api/users is FRESH — then confirms and fills exact expiry/reset. This is what makes rapid Max↔Pro smooth.
      const idx = (state.users || []).findIndex((u) => u.id === userId);
      if (idx >= 0) {
        const pl = (subPlansCache || []).find((p) => String(p.code || "").toUpperCase() === String(planCode).toUpperCase());
        state.users[idx] = { ...state.users[idx], plan: String(planCode).toUpperCase(), planName: (pl && pl.name) || String(planCode), planExpiresAt: (r && r.expiresAt) || "" };
      }
      if (r && Number(r.grantedCredit) > 0) {
        const wi = (state.creditWallets || []).findIndex((w) => w.userId === userId);
        if (wi >= 0) state.creditWallets[wi] = { ...state.creditWallets[wi], balance: Number(state.creditWallets[wi].balance || 0) + Number(r.grantedCredit) };
      }
      applyRealUserPool();
      closeAssignPlanModal();
      await refresh();        // authoritative refresh (dbapi cache invalidated on assign → fresh plan/expiry)
      applyRealUserPool();
    } catch (e) { showActionToast(e?.message || "Nạp gói thất bại", "error"); }
  }
  // Drawer "GÓI CƯỚC" card: gói + hết hạn(còn X ngày) + credit gói/tháng + ngày reset credit kế. Data from the
  // per-user fields the dbapi read_db attaches (planExpiresAt / planDaysLeft / planMonthlyCredit / planNextResetAt).
  // EDITABLE "Gói cước" card in EVERY user's drawer (cũ + mới): ngày hết hạn / credit gói-tháng / reset credit kế
  // → "Lưu gói cước" (POST /api/admin/plans/update-subscription, keeps services + no re-grant).
  // dd/mm/yyyy (Ngày/Tháng/Năm) helpers — a native <input type=date> renders in the BROWSER locale (mm/dd on
  // en-US), so we use text inputs + explicit parse to force Ngày/Tháng/Năm everywhere, cross-locale.
  function isoToDMY(iso) { if (!iso) return ""; const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : ""; }
  function dmyToIsoDate(s) { const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (!m) return null; const dd = +m[1], mm = +m[2], yy = +m[3]; if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null; return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`; }
  function planInfoCardHtml(u) {
    const exp = isoToDMY(u.planExpiresAt);
    const nr = isoToDMY(u.planNextResetAt);
    const mc = Number(u.planMonthlyCredit || 0);
    const dl = (typeof u.planDaysLeft === "number") ? u.planDaysLeft : null;
    const nrDays = u.planNextResetAt ? Math.max(0, Math.round((Date.parse(u.planNextResetAt) - Date.now()) / 86400000)) : null;
    const fld = "width:100%;height:34px;border:1px solid var(--field-border,#cbd5e1);border-radius:8px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:700 12.5px 'Segoe UI',system-ui,sans-serif;padding:0 9px;box-sizing:border-box;";
    const rowIn = (label, hint, input) => `<div style="display:grid;grid-template-columns:118px 1fr;gap:10px;align-items:center;padding:4px 0;"><span style="color:var(--text-3,#94a3b8);font:600 12px 'Segoe UI',system-ui,sans-serif;">${label}${hint ? `<div style="font-size:10.5px;color:var(--brand,#2563eb);font-weight:700;">${hint}</div>` : ""}</span>${input}</div>`;
    return `<div style="border:1px solid var(--border,#e2e8f0);border-radius:11px;padding:12px 14px;margin:0 0 10px 0;background:var(--surface-2,#f7f9fc);">
      <div style="font:800 11px 'Segoe UI',system-ui,sans-serif;letter-spacing:.08em;color:var(--text-3,#94a3b8);text-transform:uppercase;margin-bottom:8px;">Gói cước · ${escapeHtml(u.planName || u.plan || "Free")}</div>
      ${rowIn("Ngày hết hạn", (dl != null ? `còn ${dl} ngày` : ""), `<input type="text" inputmode="numeric" placeholder="dd/mm/yyyy" data-cx-pe value="${exp}" style="${fld}">`)}
      ${rowIn("Credit gói / tháng", "", `<input type="number" step="1" min="0" data-cx-mc value="${mc}" style="${fld}">`)}
      ${rowIn("Reset credit kế", (nrDays != null ? `còn ${nrDays} ngày` : ""), `<input type="text" inputmode="numeric" placeholder="dd/mm/yyyy" data-cx-nr value="${nr}" style="${fld}">`)}
      <button type="button" data-cx-plan-save style="width:100%;height:36px;margin-top:9px;border:0;border-radius:9px;background:var(--brand,#2563eb);color:#fff;font:900 12px 'Segoe UI',system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 10px var(--brand-shadow,rgba(37,99,235,.22));">Lưu gói cước</button>
    </div>`;
  }
  async function saveUserPlanFields(userId, card) {
    if (!userId || !card) return;
    const peRaw = String(card.querySelector("[data-cx-pe]")?.value || "").trim();
    const nrRaw = String(card.querySelector("[data-cx-nr]")?.value || "").trim();
    const mc = Math.max(0, Math.round(Number(card.querySelector("[data-cx-mc]")?.value || 0)));
    // dd/mm/yyyy text → ISO date; empty = clear (không hạn); malformed = reject with a clear message.
    const pe = peRaw ? dmyToIsoDate(peRaw) : "";
    const nr = nrRaw ? dmyToIsoDate(nrRaw) : "";
    if (peRaw && !pe) { showActionToast("Ngày hết hạn phải dạng Ngày/Tháng/Năm (dd/mm/yyyy)", "error"); return; }
    if (nrRaw && !nr) { showActionToast("Reset credit kế phải dạng Ngày/Tháng/Năm (dd/mm/yyyy)", "error"); return; }
    const btn = card.querySelector("[data-cx-plan-save]");
    if (btn) { btn.disabled = true; btn.textContent = "Đang lưu…"; }
    try {
      const r = await postJson("/api/admin/plans/update-subscription", {
        userId, expiresAt: pe ? pe + "T00:00:00Z" : "", nextResetAt: nr ? nr + "T00:00:00Z" : "", monthlyCredit: mc
      });
      const idx = (state.users || []).findIndex((x) => x.id === userId);
      if (idx >= 0) state.users[idx] = { ...state.users[idx], planExpiresAt: (r && r.expiresAt) || "", planNextResetAt: (r && r.nextResetAt) || "", planMonthlyCredit: mc };
      applyRealUserPool();
      showActionToast("Đã lưu gói cước");
    } catch (e) { showActionToast((e && e.message) || "Lưu gói cước thất bại", "error"); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "Lưu gói cước"; } }
  }
  // Uniform action-button styling for the user drawer (Nạp credit / Trừ credit / Nạp gói / Khóa / Xóa) — one
  // shape (40px pill), semantic soft colours, equal-width flex so the row looks even and tidy.
  const ACTION_BTN_BASE = "height:40px;border-radius:10px;font:800 12.5px 'Segoe UI',system-ui,sans-serif;cursor:pointer;padding:0 12px;white-space:nowrap;flex:1 1 120px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;";
  const ACTION_BTN_KIND = {
    add: "border:1px solid var(--ok-border,#bbf7d0);background:var(--ok-soft,#f0fdf4);color:var(--ok-text,#15803d);",
    deduct: "border:1px solid #fdba74;background:#fff7ed;color:#c2410c;",
    plan: "border:1px solid var(--brand-border,#bfdbfe);background:var(--brand-soft,#eff6ff);color:var(--brand,#2563eb);",
    lock: "border:1px solid #fcd34d;background:#fffbeb;color:#b45309;",
    del: "border:1px solid #fecaca;background:var(--danger-soft,#fef2f2);color:var(--danger,#ef4444);",
  };
  function styleActionBtn(btn, kind) { btn.style.cssText = ACTION_BTN_BASE + (ACTION_BTN_KIND[kind] || ""); }

  // ── User-drawer "Hoạt động gần đây" ─────────────────────────────────────────────────────
  // The design ships a baked sample list (Dùng model −3 / Nạp credit +50 / Bị chặn request …). Replace it with
  // this user's REAL credit_transactions (state.creditTransactions) — same typed rows the ledger screen reads.
  function activityDrawerRowHtml(tx) {
    const type = String(tx.type || "");
    const details = detailsObject(tx.details);
    const model = tx.modelId || details.modelId || details.model || "";
    const amt = Number(tx.amountDelta || 0);
    let title, borderVar, amtText, amtColor;
    if (type === "topup") { title = "Nạp credit"; borderVar = "--ok"; amtText = "+" + Math.abs(amt); amtColor = "--ok-text"; }
    else if (type === "blocked") { title = "Bị chặn request"; borderVar = "--danger"; amtText = ""; amtColor = "--danger"; }
    else if (type === "adjust") { const pos = amt >= 0; title = pos ? "Cộng credit" : "Trừ credit"; borderVar = pos ? "--ok" : "--danger"; amtText = (pos ? "+" : "−") + Math.abs(amt); amtColor = pos ? "--ok-text" : "--danger"; }
    else { title = "Dùng model"; borderVar = "--brand"; amtText = "−" + Math.abs(amt); amtColor = "--text-2"; }
    const sub = model || serviceNameById(tx.serviceId || details.serviceId) || tx.reason || "";
    const time = formatActivityTime(tx.createdAt || tx.at || tx.updatedAt);
    return `<div style="display:flex;align-items:center;gap:11px;padding:11px 13px;border-left:3px solid var(${borderVar});border-radius:10px;background:var(--surface-2);">
      <div style="min-width:0;flex:1 1 0%;"><div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(title)}</div><div style="font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(sub)}</div></div>
      <div style="text-align:right;flex-shrink:0;"><div style="font-size:13px;font-weight:700;color:var(${amtColor});">${escapeHtml(amtText)}</div><div style="font-size:11px;color:var(--text-3);">${escapeHtml(time)}</div></div>
    </div>`;
  }
  function mountUserRecentActivity() {
    const heads = Array.from(document.querySelectorAll("div,span,strong,h3"))
      .filter((el) => el.childElementCount === 0 && (el.textContent || "").trim() === "Hoạt động gần đây");
    for (const head of heads) {
      const headerRow = head.parentElement;               // the "Hoạt động gần đây … Tham gia dd/mm" row
      const list = headerRow && headerRow.nextElementSibling; // the activity list column below it
      const section = headerRow && headerRow.parentElement;
      if (!list || !section) continue;
      const userId = lockBtnDrawerUserId(section);        // find the drawer's cx-<userId> marker (single-user scope)
      if (!userId) continue;
      const user = (state.users || []).find((u) => u.id === userId);
      if (!user) continue;
      const txs = [...(state.creditTransactions || [])]
        .filter((t) => String(t.userId || "") === userId)
        .sort((a, b) => (Date.parse(b.createdAt || b.at || "") || 0) - (Date.parse(a.createdAt || a.at || "") || 0))
        .slice(0, 6);
      const key = [userId, txs.length, txs[0]?.id || txs[0]?.txId || txs[0]?.createdAt || "", state.updatedAt].join("|");
      if (list.dataset.cxActivityMount === key) continue;  // idempotent per (user, data)
      list.dataset.cxActivityMount = key;
      list.innerHTML = txs.length
        ? txs.map(activityDrawerRowHtml).join("")
        : `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12.5px;border:1px dashed var(--border);border-radius:10px;background:var(--surface-2);">Chưa có hoạt động nào.</div>`;
      // "Tham gia dd/mm/yyyy" → real account creation date
      const joinInterp = headerRow.querySelector(".sc-interp") || headerRow.querySelector("span span");
      const created = user.createdAt || user.created_at;
      if (joinInterp && created) { const d = new Date(created); if (!Number.isNaN(d.getTime())) joinInterp.textContent = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; }
    }
  }

  // Build the single-user drawer's action area: GÓI CƯỚC card + a uniform button row (Nạp credit / Trừ credit /
  // Nạp gói). Anchored on the design "Nạp credit" button (never the multi-user bulk bar). Khóa/Xóa are styled to
  // match in ensureAccountLockButton.
  function ensureAssignPlanButton() {
    for (const btn of document.querySelectorAll("button,[role='button']")) {
      if (!btn.dataset.cxNapDefault) continue;            // anchor = the relabeled "Nạp credit" button
      const host = btn.parentElement;
      if (!host) continue;
      const userId = lockBtnDrawerUserId(btn);            // "" on the bulk bar (multi-user) → skip
      const u = userId ? (state.users || []).find((x) => x.id === userId) : null;
      if (!u) continue;
      host.style.display = "flex"; host.style.flexWrap = "wrap"; host.style.gap = "8px";
      styleActionBtn(btn, "add");                          // restyle the design "Nạp credit" → uniform green pill
      // "− Trừ credit" (once per host)
      let ded = host.querySelector("[data-cx-deduct]");
      if (!ded) {
        ded = document.createElement("button");
        ded.type = "button"; ded.dataset.cxDeduct = userId; ded.textContent = "− Trừ credit";
        ded.addEventListener("click", () => openBulkTopupModal(Number(ded.dataset.cxDefault) || 100, ded.dataset.cxDeduct, "deduct"));
        btn.insertAdjacentElement("afterend", ded);
      }
      ded.dataset.cxDeduct = userId; ded.dataset.cxDefault = btn.dataset.cxNapDefault || "100";
      styleActionBtn(ded, "deduct");
      // "Nạp gói" (once per host)
      let plan = host.querySelector("[data-cx-assign-plan]");
      if (!plan) {
        plan = document.createElement("button");
        plan.type = "button"; plan.dataset.cxAssignPlan = userId; plan.textContent = "Nạp gói";
        plan.addEventListener("click", () => openAssignPlanModal(plan.dataset.cxAssignPlan));
        host.appendChild(plan);
      }
      plan.dataset.cxAssignPlan = userId;
      styleActionBtn(plan, "plan");
      // PRO_LEGACY → "⚙ Quản lý khách cũ"; mọi user khác → "→ Người dùng CentriX" (chuyển thủ công, snapshot dịch vụ).
      let mng = host.querySelector("[data-cx-legacy-manage]");
      let cvt = host.querySelector("[data-cx-legacy-convert]");
      if (isLegacyUser(u)) {
        if (cvt) { cvt.remove(); cvt = null; }
        if (!mng) {
          mng = document.createElement("button");
          mng.type = "button"; mng.dataset.cxLegacyManage = userId; mng.textContent = "⚙ Quản lý khách cũ";
          mng.addEventListener("click", () => openLegacyManageModal(mng.dataset.cxLegacyManage));
          host.appendChild(mng);
        }
        mng.dataset.cxLegacyManage = userId;
        styleActionBtn(mng, "lock");
      } else {
        if (mng) { mng.remove(); mng = null; }
        if (!cvt) {
          cvt = document.createElement("button");
          cvt.type = "button"; cvt.dataset.cxLegacyConvert = userId; cvt.textContent = "→ Người dùng CentriX";
          cvt.addEventListener("click", () => convertUserToCentrix(cvt.dataset.cxLegacyConvert));
          host.appendChild(cvt);
        }
        cvt.dataset.cxLegacyConvert = userId;
        styleActionBtn(cvt, "plan");
      }
      // GÓI CƯỚC info card above the button row (re-create if the drawer switched to another user)
      if (host.parentElement) {
        let card = host.parentElement.querySelector("[data-cx-plan-info]");
        if (card && card.getAttribute("data-cx-plan-info") !== userId) { card.remove(); card = null; }
        if (!card) {
          card = document.createElement("div");
          card.setAttribute("data-cx-plan-info", userId);
          card.innerHTML = planInfoCardHtml(u);
          host.parentElement.insertBefore(card, host);
          card.querySelector("[data-cx-plan-save]")?.addEventListener("click", () => saveUserPlanFields(card.getAttribute("data-cx-plan-info"), card));
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // "Người dùng CentriX" — manage the legacy PRO_LEGACY (per-customer) customers INSIDE the "Người dùng &
  // Credit" page: a filter toggle (table → PRO_LEGACY only) + a per-customer manage modal (dịch vụ /
  // hạn+credit / gán Pro-cũ). Backend: /api/users/service, /api/admin/plans/update-subscription (keeps
  // services), /api/admin/plans/assign {allowInactive}.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  function isLegacyUser(u) { return !!u && String(u.plan || "").toUpperCase().endsWith("_LEGACY"); }
  function legacyCustomers() { return (state.users || []).filter((u) => u && u.id !== SERVICE_UI_RULE_USER_ID && isLegacyUser(u)); }

  // Khớp resolver backend serviceVisibleForUser (2026-07-14): global HIDE = kill-switch; per-user explicit
  // THẮNG global-show (nhờ vậy bỏ tích 1 dịch vụ cho 1 khách = ẩn thật, không bị global-show đè "hiện lại");
  // global-show = mặc định cho user chưa có dòng per-user.
  function customerServiceVisible(userId, serviceId) {
    const rows = state.serviceVisibility || [];
    const g = rows.find((r) => r.userId === SERVICE_UI_RULE_USER_ID && r.serviceId === serviceId);
    if (g && g.visible === false) return false;                                  // global hide = kill-switch
    const u = rows.find((r) => r.userId === userId && r.serviceId === serviceId);
    if (u) return u.visible !== false;                                           // per-user explicit thắng global-show
    if (g) return g.visible !== false;                                           // global show = mặc định
    return true; // default visible (matches the App User)
  }
  async function setCustomerServiceAccess(userId, serviceId, visible) {
    const result = await postJson("/api/users/service", { userId, serviceId, visible: visible !== false });
    if (result && result.db && result.db.serviceVisibility) state.serviceVisibility = result.db.serviceVisibility;
    return result;
  }

  function findUsersScreen() {
    return visibleScreens().find((s) => fold(s.getAttribute("data-screen-label")).includes("nguoi dung")) || null;
  }
  function toggleLegacyFilter(on) {
    legacyFilterOn = !!on;
    applyRealUserPool();
    mountLegacyToggle({ force: true });
  }
  // Inject the "Tất cả | Người dùng CentriX (N)" toggle at the top of the Users&Credit screen (idempotent; the
  // tick re-injects it if a re-render wipes it).
  function mountLegacyToggle(options = {}) {
    const screen = findUsersScreen();
    if (!screen) return false;
    let bar = screen.querySelector("#cx-legacy-toggle");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "cx-legacy-toggle";
      bar.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;";
      screen.insertBefore(bar, screen.firstChild);
    }
    const n = legacyCustomers().length;
    const sig = String(legacyFilterOn) + "|" + n;
    if (!options.force && bar.dataset.cxSig === sig) return true;
    bar.dataset.cxSig = sig;
    const tab = (on, label) => {
      const active = legacyFilterOn === on;
      return `<button type="button" data-cx-legacy-tab="${on ? "1" : "0"}" style="border:1px solid ${active ? "var(--brand,#2563eb)" : "var(--field-border,#cbd5e1)"};background:${active ? "var(--brand-soft,#eff6ff)" : "var(--surface,#fff)"};color:${active ? "var(--brand,#2563eb)" : "var(--text-2,#475569)"};font:800 12.5px 'Segoe UI',system-ui,sans-serif;border-radius:9px;padding:8px 15px;cursor:pointer;">${label}</button>`;
    };
    bar.innerHTML = tab(false, "Tất cả người dùng") + tab(true, `Người dùng CentriX (${n})`);
    bar.querySelectorAll("[data-cx-legacy-tab]").forEach((b) => b.addEventListener("click", () => toggleLegacyFilter(b.getAttribute("data-cx-legacy-tab") === "1")));
    return true;
  }

  // "Chuyển sang Người dùng CentriX": make a user per-customer-managed WITHOUT downgrading — moves them onto their
  // OWN tier's legacy twin (Unlimited stays "Unlimited"), snapshotting current services + keeping credit/expiry.
  function convertUserToCentrix(userId) {
    const u = (state.users || []).find((x) => x.id === userId);
    if (!u) { showActionToast("Không xác định được user", "error"); return; }
    const email = (state.accounts || []).find((a) => a && a.userId === userId)?.email || "";
    const tier = escapeHtml(u.planName || u.plan || "Free");
    openConfirmModal({
      id: "cx-lock-user-modal", tone: "brand", icon: "plan", title: "Chuyển sang Người dùng CentriX?",
      subtitle: `${escapeHtml(u.name || userId)}${email ? " · " + escapeHtml(email) : ""} · đang: ${tier}`,
      noteHtml: `Chuyển sang quản lý <b style="color:var(--text,#0f172a);">per-customer</b> nhưng <b>GIỮ NGUYÊN tên gói ${tier}</b> + dịch vụ đang dùng + credit/tháng (chụp lại dịch vụ gói hiện chặn). Không hạ gói, không thêm/bớt quyền — chỉ mở tuỳ biến dịch vụ theo từng khách.`,
      confirmLabel: "Chuyển sang CentriX",
      onConfirm: async () => {
        try {
          const r = await postJson("/api/admin/plans/convert-legacy", { userId });
          const idx = (state.users || []).findIndex((x) => x.id === userId);
          if (idx >= 0 && r && r.planCode) state.users[idx] = { ...state.users[idx], plan: r.planCode, planName: (r.planName || state.users[idx].planName) };
          applyRealUserPool();
          await refresh(); applyRealUserPool();
          showActionToast(`Đã chuyển sang Người dùng CentriX${(r && r.hiddenServices) ? ` (ẩn ${r.hiddenServices} dịch vụ ngoài gói)` : ""}`);
        } catch (e) { showActionToast((e && e.message) || "Chuyển thất bại", "error"); }
      }
    });
  }
  function closeLegacyManageModal() { document.getElementById("cx-legacy-manage-modal")?.remove(); }
  function openLegacyManageModal(userId) {
    const u = (state.users || []).find((x) => x.id === userId);
    if (!u) { showActionToast("Không xác định được user", "error"); return; }
    const email = (state.accounts || []).find((a) => a && a.userId === userId)?.email || "";
    const services = (state.services || []).filter((s) => s && s.id && s.name && s.enabled !== false)
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const svcRows = services.map((s) => {
      const on = customerServiceVisible(userId, s.id);
      return `<label style="display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid var(--border-soft,#eef1f5);border-radius:9px;background:var(--surface-2,#f8fafc);cursor:pointer;">`
        + `<input type="checkbox" data-cx-lsvc="${escapeHtml(s.id)}" ${on ? "checked" : ""} style="width:16px;height:16px;accent-color:var(--brand,#2563eb);cursor:pointer;flex-shrink:0;">`
        + `<span style="font:600 12.5px 'Segoe UI',system-ui,sans-serif;color:var(--text,#0f172a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.name)}</span></label>`;
    }).join("");
    const fld = "height:42px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:700 13px 'Segoe UI',system-ui,sans-serif;padding:0 12px;box-sizing:border-box;";
    const body = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;"><span style="font:800 10.5px 'Segoe UI',system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;letter-spacing:.04em;">Dịch vụ được dùng (per-customer · ${services.length})</span><span data-cx-lsvc-status style="font:700 10.5px 'Segoe UI',system-ui,sans-serif;color:var(--brand,#2563eb);opacity:0;transition:opacity .2s;">Đã lưu ✓</span></div>`
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:230px;overflow:auto;padding-right:4px;">${svcRows}</div>`
      + `<div style="font:800 10.5px 'Segoe UI',system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 8px;">Gói cước (không đụng dịch vụ)</div>`
      + `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end;">`
      + `<label style="flex:1;min-width:130px;"><span style="display:block;font:600 11.5px 'Segoe UI',system-ui,sans-serif;color:var(--text-2,#475569);margin-bottom:4px;">Gia hạn thêm</span><select id="cx-lm-dur" style="width:100%;${fld}"><option value="1">1 tháng</option><option value="12">12 tháng</option><option value="0">Không hạn</option></select></label>`
      + `<label style="flex:1;min-width:130px;"><span style="display:block;font:600 11.5px 'Segoe UI',system-ui,sans-serif;color:var(--text-2,#475569);margin-bottom:4px;">Credit / tháng</span><input id="cx-lm-credit" type="number" step="1" value="${Number(u.planMonthlyCredit || 0)}" style="width:100%;${fld}"></label>`
      + `<button type="button" id="cx-lm-saveplan" style="height:42px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:900 12.5px 'Segoe UI',system-ui,sans-serif;padding:0 16px;cursor:pointer;white-space:nowrap;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));">Lưu gói</button></div>`
      + `<div style="margin-top:9px;font:500 12px 'Segoe UI',system-ui,sans-serif;color:var(--text-3,#94a3b8);">Hạn hiện tại: <b style="color:var(--text-2,#475569);">${u.planExpiresAt ? isoToDMY(u.planExpiresAt) : "Không hạn"}</b>${(typeof u.planDaysLeft === "number") ? ` (còn ${u.planDaysLeft} ngày)` : ""} · Gói: <b style="color:var(--text-2,#475569);">${escapeHtml(u.planName || u.plan || "")}</b></div>`
      + `<button type="button" id="cx-lm-assign" style="margin-top:14px;width:100%;height:42px;border:1px solid var(--brand-border,#bfdbfe);border-radius:10px;background:var(--brand-soft,#eff6ff);color:var(--brand,#2563eb);font:800 12.5px 'Segoe UI',system-ui,sans-serif;cursor:pointer;">Gán lại gói ${escapeHtml(u.planName || u.plan || "")} (giữ dịch vụ)</button>`;
    const footer = `<div style="margin-top:18px;"><button type="button" data-cx-lm-close style="width:100%;height:44px;border:1px solid var(--field-border,#cbd5e1);border-radius:11px;background:var(--surface,#fff);color:var(--text-2,#475569);font:800 13px 'Segoe UI',system-ui,sans-serif;cursor:pointer;">Đóng</button></div>`;
    const overlay = cxModalOverlay("cx-legacy-manage-modal");
    overlay.innerHTML = cxModalCard({ tone: "brand", icon: "plan", title: `Quản lý khách cũ: ${escapeHtml(u.name || userId)}`, subtitle: `${email ? escapeHtml(email) + " · " : ""}Chỉnh dịch vụ per-customer, hạn gói & credit/tháng.`, width: 560, body, footer });
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeLegacyManageModal(); });
    overlay.querySelector("[data-cx-lm-close]")?.addEventListener("click", closeLegacyManageModal);
    // Smooth ticking: the checkbox toggles INSTANTLY (never disabled, no per-tick network wait). Each change
    // schedules a debounced background save of that service's CURRENT state — rapid toggles collapse to one save
    // of the final value, and only a real failure reverts that box + toasts. A tiny inline status shows progress.
    const lsvcTimers = new Map();     // serviceId -> pending debounce timer
    const lsvcInflight = new Set();   // serviceIds currently being saved
    const statusEl = overlay.querySelector("[data-cx-lsvc-status]");
    const setStatus = (text, show) => { if (!statusEl) return; statusEl.textContent = text; statusEl.style.opacity = show ? "1" : "0"; };
    const flushStatus = () => { if (lsvcTimers.size === 0 && lsvcInflight.size === 0) { setStatus("Đã lưu ✓", true); setTimeout(() => { if (lsvcTimers.size === 0 && lsvcInflight.size === 0) setStatus("Đã lưu ✓", false); }, 1200); } };
    overlay.querySelectorAll("[data-cx-lsvc]").forEach((cb) => cb.addEventListener("change", () => {
      const sid = cb.getAttribute("data-cx-lsvc");
      if (lsvcTimers.has(sid)) clearTimeout(lsvcTimers.get(sid));
      setStatus("Đang lưu…", true);
      lsvcTimers.set(sid, setTimeout(async () => {
        lsvcTimers.delete(sid);
        const want = cb.checked;
        lsvcInflight.add(sid);
        try {
          await setCustomerServiceAccess(userId, sid, want);
        } catch (e) {
          if (cb.checked === want) cb.checked = !want; // revert only if the user hasn't toggled again since
          showActionToast((e && e.message) || `Lỗi lưu dịch vụ ${sid}`, "error");
          setStatus("Lỗi lưu — thử lại", true);
        } finally {
          lsvcInflight.delete(sid);
          flushStatus();
        }
      }, 300));
    }));
    // "Lưu gói": expiry + monthly_credit (keeps services, no re-grant).
    overlay.querySelector("#cx-lm-saveplan")?.addEventListener("click", async () => {
      const dur = overlay.querySelector("#cx-lm-dur")?.value || "1";
      const credit = Math.max(0, Math.round(Number(overlay.querySelector("#cx-lm-credit")?.value || 0)));
      try {
        const r = await postJson("/api/admin/plans/update-subscription", { userId, durationMonths: dur, monthlyCredit: credit });
        const idx = (state.users || []).findIndex((x) => x.id === userId);
        if (idx >= 0) state.users[idx] = { ...state.users[idx], planExpiresAt: (r && r.expiresAt) || "", planMonthlyCredit: credit };
        applyRealUserPool();
        showActionToast("Đã lưu gói cho khách cũ");
      } catch (e) { showActionToast((e && e.message) || "Lưu gói thất bại", "error"); }
    });
    // "Gán lại gói" — re-assign the user's OWN legacy tier (allowInactive → keeps per-customer services, keeps name).
    overlay.querySelector("#cx-lm-assign")?.addEventListener("click", async () => {
      const dur = overlay.querySelector("#cx-lm-dur")?.value || "1";
      const credit = Math.max(0, Math.round(Number(overlay.querySelector("#cx-lm-credit")?.value || 0)));
      const legacyCode = String(u.plan || "PRO_LEGACY").toUpperCase();
      try {
        await postJson("/api/admin/plans/assign", { userId, planCode: legacyCode, allowInactive: true, grant: false, durationMonths: dur, monthlyCredit: credit });
        applyRealUserPool();
        showActionToast(`Đã gán lại gói ${u.planName || legacyCode} (giữ dịch vụ)`);
      } catch (e) { showActionToast((e && e.message) || "Gán thất bại", "error"); }
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // App Server staff RBAC UI — login overlay, "Nhóm & Phân quyền" page (accounts + roles), sidebar gate.
  // The hard security boundary is server-side (routes 403 by role); the sidebar hiding here is best-effort
  // UX. Permission unit = a sidebar "view" key; these labels must match the live sidebar text to be hid.
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  state.staff = state.staff || null;
  state.staffAdmin = { accounts: [], roles: [], loaded: false, loading: false };
  // MUST match the ACTUAL sidebar nav text (design data-screen-label). The gate hides a nav row by exact
  // folded-text match, so a wrong label = that function can't be hidden (per-function RBAC silently broken).
  // Previously several were English/short ("Dashboard","Users & Credit","Model Pricing","Safety","Nạp data",
  // "Hỗ trợ / Ticket","Activity/Audit") and never matched the Vietnamese sidebar → visibility didn't follow role.
  const ADMIN_VIEW_LABELS = {
    dashboard: "Bảng điều khiển", connection: "Kết nối", loader: "Trình duyệt dịch vụ", users: "Người dùng & Credit",
    pricing: "Bảng giá model", access: "Access & UI Rules", safety: "An toàn",
    organizations: "Tổ chức B2B", "org-transactions": "Giao dịch theo tổ chức", analytics: "Phân tích & Doanh thu",
    plans: "Gói cước", "credit-packages": "Gói nạp credit", billing: "Thanh toán & Hóa đơn",
    promotions: "Khuyến mãi", manual: "Can thiệp thủ công", "intervention-log": "Nhật ký can thiệp",
    support: "Hỗ trợ", notifications: "Thông báo", roles: "Nhóm & Phân quyền", settings: "Cài đặt",
    "ai-integrations": "Tích hợp AI", assistant: "Trợ lý vận hành", ledger: "Sổ giao dịch",
    activity: "Hoạt động", services: "Dịch vụ", tabs: "Tab đang chạy"
  };
  const VIEW_GROUPS = [
    ["Kinh doanh", ["plans", "credit-packages", "billing", "promotions"]],
    ["Hệ thống", ["users", "pricing", "access", "services", "notifications", "support", "settings", "ai-integrations"]],
    ["B2B / Tổ chức", ["organizations", "org-transactions"]],
    ["An toàn vận hành", ["connection", "loader", "tabs", "manual", "intervention-log", "safety", "assistant"]],
    ["Nhật ký & phân tích", ["dashboard", "analytics", "ledger", "activity"]],
    ["Quản trị", ["roles"]]
  ];
  const STAFF_FIELD_CSS = "width:100%;height:40px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--field-bg,#fff);color:var(--text,#0f172a);font:600 13px Segoe UI,system-ui,sans-serif;padding:0 12px;box-sizing:border-box;";
  const STAFF_LABEL_CSS = "display:flex;flex-direction:column;gap:6px;margin-top:13px;font:800 11px Segoe UI,system-ui,sans-serif;color:var(--label,#64748b);text-transform:uppercase;";

  // Non-throwing cookie-session probe: returns the staff object if the cxsid cookie is valid, else null.
  async function checkStaffSession() {
    try {
      const r = await fetch(authed("/api/auth/staff-whoami"), { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return (j && j.ok) ? j.staff : null;
    } catch (e) { return null; }
  }

  function onStaffAuthLost() {
    staffLoggedIn = false; state.staff = null;
    if (staffActive()) mountStaffLoginOverlay();
  }

  // ── Login overlay ──────────────────────────────────────────────────────────────────────────────
  function removeStaffLoginOverlay() { document.getElementById("centrix-staff-login")?.remove(); }
  // Loading veil — covers the app from boot until the FIRST real data load + patches finish, so the static
  // React DEMO UI is never shown before real data ("fix triệt để" the demo flash). Theme-aware bg.
  // Nhận diện thương hiệu website: tiêu đề tab + favicon = logo CentriX (thay "Bundled Page" + tab trống).
  function installBrandIdentity() {
    try { if (document.title !== "CentriX App Server") document.title = "CentriX App Server"; } catch (e) { /* bỏ qua */ }
    try {
      let link = document.querySelector('link[rel~="icon"]');
      if (!link) { link = document.createElement("link"); link.rel = "icon"; (document.head || document.documentElement).appendChild(link); }
      if (link.getAttribute("href") !== CENTRIX_LOGO) { link.type = "image/png"; link.href = CENTRIX_LOGO; }
    } catch (e) { /* bỏ qua */ }
  }
  function removeLoadingVeil() { document.getElementById("centrix-loading-veil")?.remove(); }
  function mountLoadingVeil() {
    if (appReady || !document.body || document.getElementById("centrix-loading-veil")) return;
    const dark = localStorage.getItem("centrixServerTheme") === "dark";
    const v = document.createElement("div");
    v.id = "centrix-loading-veil";
    v.style.cssText = `position:fixed;inset:0;z-index:2147483635;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;background:${dark ? "#0b1220" : "#f8fafc"};`;
    v.innerHTML = `<img src="${CENTRIX_LOGO}" alt="CentriX" width="60" height="60" style="border-radius:15px;box-shadow:0 10px 26px rgba(37,99,235,.28);margin-bottom:6px;"><div style="width:40px;height:40px;border:4px solid ${dark ? "rgba(255,255,255,.18)" : "rgba(15,23,42,.12)"};border-top-color:#2563eb;border-radius:50%;animation:cxspin .8s linear infinite;"></div><div style="font:600 13px Segoe UI,system-ui;color:${dark ? "#94a3b8" : "#64748b"};">Đang tải dữ liệu…</div><style>@keyframes cxspin{to{transform:rotate(360deg)}}</style>`;
    document.body.appendChild(v);
    setTimeout(removeLoadingVeil, 8000); // safety: never trap the user behind the veil
  }
  function revealApp() { appReady = true; removeLoadingVeil(); }
  function mountStaffLoginOverlay() {
    if (!document.body || document.getElementById("centrix-staff-login")) return;
    const overlay = document.createElement("div");
    overlay.id = "centrix-staff-login";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483640;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0b1220,#111c33);";
    overlay.innerHTML = `
      <div role="dialog" style="width:382px;max-width:calc(100vw - 36px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.45);padding:26px;">
        <div style="display:flex;align-items:center;gap:11px;"><img src="${CENTRIX_LOGO}" alt="CentriX" width="40" height="40" style="border-radius:10px;box-shadow:0 5px 14px rgba(37,99,235,.28);flex-shrink:0;"><div><div style="font:900 17px Segoe UI;color:var(--text,#0f172a);">CentriX App Server</div><div style="font:600 11.5px Segoe UI;color:var(--text-2,#64748b);">Đăng nhập vận hành</div></div></div>
        <label style="${STAFF_LABEL_CSS}">Email / tài khoản <input id="cx-staff-user" type="text" autocomplete="username" placeholder="vd: support@centrix.asia" style="${STAFF_FIELD_CSS}"></label>
        <label style="${STAFF_LABEL_CSS}">Mật khẩu <input id="cx-staff-pw" type="password" autocomplete="current-password" placeholder="••••••••" style="${STAFF_FIELD_CSS}"></label>
        <div id="cx-staff-err" style="display:none;margin-top:12px;font:600 12.5px Segoe UI;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:9px;padding:9px 11px;"></div>
        <button type="button" data-centrix-server-action="staff-login-submit" style="width:100%;height:44px;margin-top:18px;border:0;border-radius:11px;background:var(--brand,#2563eb);color:#fff;font:900 14px Segoe UI;cursor:pointer;box-shadow:0 6px 16px rgba(37,99,235,.3);">Đăng nhập</button>
        ${token ? `<button type="button" data-centrix-server-action="staff-login-master" style="width:100%;height:38px;margin-top:10px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:transparent;color:var(--text-2,#64748b);font:700 12.5px Segoe UI;cursor:pointer;">Vào bằng quyền chủ sở hữu (master)</button>` : ""}
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#cx-staff-pw")?.addEventListener("keydown", (e) => { if (e.key === "Enter") staffLoginSubmit(); });
    overlay.querySelector("#cx-staff-user")?.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("cx-staff-pw")?.focus(); });
    setTimeout(() => document.getElementById("cx-staff-user")?.focus(), 60);
  }
  function staffLoginError(msg) {
    const el = document.getElementById("cx-staff-err");
    if (el) { el.textContent = msg; el.style.display = "block"; }
  }
  async function staffLoginSubmit() {
    const username = String(document.getElementById("cx-staff-user")?.value || "").trim().toLowerCase();
    const password = String(document.getElementById("cx-staff-pw")?.value || "");
    if (!username || !password) { staffLoginError("Nhập tài khoản và mật khẩu"); return; }
    try {
      const res = await postJson("/api/auth/staff-login", { username, password });
      // Token is now in the httpOnly cxsid cookie (set by the server) — the SPA never sees/stores it.
      state.staff = res.staff || null; staffLoggedIn = true;
      useMasterOverride = false;
      removeStaffLoginOverlay();
      showActionToast(`Xin chào ${state.staff?.displayName || username}`);
      state.staffAdmin.loaded = false;
      await refresh();
      applyStaffVisibility();
    } catch (error) {
      staffLoginError(error.message || "Đăng nhập thất bại");
    }
  }
  function staffUseMaster() {
    useMasterOverride = true; staffLoggedIn = false; state.staff = null;
    removeStaffLoginOverlay();
    refresh();
  }
  async function staffLogout() {
    accountPopupOpen = false; // close the account popup so it never floats over the login overlay
    document.getElementById("centrix-server-api-action-panel")?.remove();
    try { await postJson("/api/auth/staff-logout", {}); } catch (e) {} // server revokes the session + clears the cxsid cookie
    staffToken = ""; staffLoggedIn = false; state.staff = null; useMasterOverride = false;
    if (staffActive()) mountStaffLoginOverlay(); else refresh();
  }

  // ── Sidebar gating (best-effort; server 403 is the real boundary) ────────────────────────────────
  // Sidebar nav rows are stamped with a stable data-cx-view="<pageKey>" in index.html (ASCII page keys, immune
  // to translation/rename/reorder). Map each page key → its RBAC permission key so gating matches by KEY, never
  // by Vietnamese label text and never by walking the DOM. Kills the whole label-mismatch / group-over-hide bug
  // class. Page keys with no dedicated permission fall through to their own name (staffHas then just misses).
  const PAGE_VIEW_TO_PERM = {
    dashboard: "dashboard", analytics: "analytics", connect: "connection",
    load: "loader", tabs: "tabs",
    users: "users", pricing: "pricing", services: "services", safety: "safety",
    plans: "plans", topup: "credit-packages", billing: "billing", coupons: "promotions",
    team: "roles", notifications: "notifications", support: "support", aisettings: "ai-integrations", settings: "settings",
    b2borgs: "organizations", b2btxn: "org-transactions",
    override: "manual", audit: "intervention-log",
    ledger: "ledger", activity: "activity",
  };
  function applyStaffVisibility() {
    if (!document.body) return;
    const enforce = staffRbac === "on" && staffLoggedIn && !!state.staff && !state.staff.isOwner && !staffPerms().includes("*");
    if (!enforce) {
      if (__lastStaffGateKey !== "off") {
        for (const el of document.querySelectorAll("[data-cx-staff-hidden]")) { el.style.display = ""; el.removeAttribute("data-cx-staff-hidden"); }
        __lastStaffGateKey = "off";
      }
      return;
    }
    __lastStaffGateKey = "on:" + staffPerms().slice().sort().join(",");
    for (const el of document.querySelectorAll("[data-cx-view]")) {
      const pageKey = el.getAttribute("data-cx-view");
      if (!pageKey) continue; // group headers render view="" → never gated
      const perm = PAGE_VIEW_TO_PERM[pageKey] || pageKey;
      if (staffHas(perm)) {
        if (el.getAttribute("data-cx-staff-hidden")) { el.style.display = ""; el.removeAttribute("data-cx-staff-hidden"); }
      } else {
        el.style.display = "none";
        el.setAttribute("data-cx-staff-hidden", "1");
      }
    }
  }

  // ── URL routing: give every screen a pretty path (/bang-dieu-khien …) so it's bookmarkable + Back/Forward work.
  // The Node backend already SPA-fallbacks any non-file path to index.html (server.js serveStatic), so a direct
  // hit or refresh on /nguoi-dung loads the app fine; the work here is syncing the URL ↔ the SPA's current page.
  // Navigation is driven through the SAME [data-cx-view] nav rows added for RBAC: a real nav click pushState's the
  // slug; on boot/Back we read the slug and synthetically click the matching row (which fires the app's setState).
  const PAGE_SLUG = {
    dashboard: "bang-dieu-khien", analytics: "phan-tich", connect: "ket-noi",
    load: "trinh-duyet-dich-vu", tabs: "tab-dang-chay",
    users: "nguoi-dung", pricing: "bang-gia", services: "dich-vu", safety: "an-toan",
    plans: "goi-cuoc", topup: "goi-nap-credit", billing: "thanh-toan", coupons: "khuyen-mai",
    team: "nhom-phan-quyen", notifications: "thong-bao", support: "ho-tro", aisettings: "tich-hop-ai", settings: "cai-dat",
    b2borgs: "to-chuc", b2btxn: "giao-dich-to-chuc",
    override: "can-thiep-thu-cong", audit: "nhat-ky-can-thiep",
    ledger: "so-giao-dich", activity: "hoat-dong",
  };
  const SLUG_PAGE = Object.fromEntries(Object.entries(PAGE_SLUG).map(([k, v]) => [v, k]));
  // Path is up to 2 segments: /<page-slug>[/<sub>]. For services the sub = the selected service id
  // (e.g. /dich-vu/chatgpt). currentSlug() = first segment (page); currentSub() = second (sub-selection).
  function pathSegs() { return decodeURIComponent((location.pathname || "/").replace(/^\/+|\/+$/g, "")).split("/").filter(Boolean); }
  function currentSlug() { return pathSegs()[0] || ""; }
  function currentSub() { return pathSegs()[1] || ""; }
  let __pendingServiceId = ""; // service id from a deep-link/Back that must be selected once state.services loads
  function navRowFor(pageKey) { return document.querySelector('[data-cx-view="' + pageKey + '"]'); }
  let __routeSuppress = false; // true while WE click a row programmatically → don't pushState back
  function clickNavRow(row) { __routeSuppress = true; try { row.click(); } finally { __routeSuppress = false; } }
  // Reflect the selected service in the URL: /dich-vu/<id>. Called from the service-row click handler.
  function pushServiceUrl(id) {
    const want = id ? "/" + PAGE_SLUG.services + "/" + id : "/" + PAGE_SLUG.services;
    if (!__routeSuppress && location.pathname !== want) { try { history.pushState({ cxPage: "services", svc: id || "" }, "", want); } catch (e) { /* ignore */ } }
  }
  function routeAllowed(pk) { // deep-links must respect RBAC — don't open a page the staff can't access
    const enforce = staffRbac === "on" && staffLoggedIn && !!state.staff && !state.staff.isOwner && !staffPerms().includes("*");
    if (!enforce) return true;
    return staffHas(PAGE_VIEW_TO_PERM[pk] || pk);
  }
  let __routeInitDone = false;
  function initRouteOnce() {
    if (__routeInitDone) return;
    if (!document.querySelector("[data-cx-view]")) return; // nav not rendered yet (e.g. pre-login) — retry next tick
    __routeInitDone = true;
    const pk = SLUG_PAGE[currentSlug()];
    if (pk && routeAllowed(pk)) {
      if (pk === "services") __pendingServiceId = currentSub(); // /dich-vu/<id> → select that service once loaded
      const row = navRowFor(pk); if (row) clickNavRow(row);
    } // deep-link → open that page
    else { try { history.replaceState({}, "", "/" + PAGE_SLUG.dashboard); } catch (e) { /* ignore */ } } // root / unknown / not-allowed → default landing
  }
  function onNavClickSyncUrl(e) {
    const row = e.target && e.target.closest && e.target.closest("[data-cx-view]");
    if (!row) return;
    const pk = row.getAttribute("data-cx-view");
    const slug = pk && PAGE_SLUG[pk];
    if (!slug) return;
    if (!__routeSuppress && currentSlug() !== slug) { try { history.pushState({ cxPage: pk }, "", "/" + slug); } catch (e2) { /* ignore */ } }
  }
  function onPopStateSyncPage() {
    const pk = SLUG_PAGE[currentSlug()];
    if (!pk || !routeAllowed(pk)) return;
    if (pk === "services") __pendingServiceId = currentSub(); // Back/Forward to /dich-vu/<id> → re-select
    const row = navRowFor(pk);
    if (row) clickNavRow(row);
  }

  // ── "Nhóm & Phân quyền" page (real accounts + roles) ─────────────────────────────────────────────
  function findRolesScreen() {
    return visibleScreens().find((s) => fold(s.getAttribute("data-screen-label")).includes("phan quyen")) || null;
  }
  function staffAdminAccount(username) {
    return (state.staffAdmin.accounts || []).find((a) => a.username === String(username || "").toLowerCase()) || null;
  }
  function roleLabel(roleKey) {
    const r = (state.staffAdmin.roles || []).find((x) => x.roleKey === roleKey);
    return r ? r.name : (roleKey || "");
  }
  function canManageStaff() {
    if (!staffActive() || useMasterOverride) return true; // master operator
    return !!(state.staff && (state.staff.isOwner || staffPerms().includes("*") || staffPerms().includes("roles")));
  }
  async function loadStaffAdmin(force) {
    if (state.staffAdmin.loading) return;
    if (state.staffAdmin.loaded && !force) return;
    // Throttle retries so a persistent error doesn't fetch every animation frame.
    if (!force && state.staffAdmin.lastTry && (Date.now() - state.staffAdmin.lastTry) < 3000) return;
    state.staffAdmin.loading = true;
    state.staffAdmin.lastTry = Date.now();
    try {
      // No per-call .catch: a failure must NOT mark the data "loaded" (that poisoned it — one transient
      // error left the list permanently empty with no retry). Throw → caught below → loaded stays false.
      const [a, r] = await Promise.all([
        getJson("/api/admin/staff"),
        getJson("/api/admin/roles")
      ]);
      state.staffAdmin.accounts = a.accounts || [];
      state.staffAdmin.roles = r.roles || [];
      state.staffAdmin.loaded = true;
      state.staffAdmin.error = "";
    } catch (e) {
      state.staffAdmin.error = (e && e.message) || String(e);
    } finally {
      state.staffAdmin.loading = false;
      mountRolesPanel({ force: true });
    }
  }
  function mountRolesPanel(options = {}) {
    const screen = findRolesScreen();
    if (!screen) return false;
    if (!state.staffAdmin.loaded) loadStaffAdmin();
    const accounts = state.staffAdmin.accounts || [];
    const roles = state.staffAdmin.roles || [];
    const owner = canManageStaff();
    const key = `${owner}|${accounts.map((a) => a.username + a.role + a.enabled + a.isOwner + a.lastLoginAt).join(",")}|${roles.map((r) => r.roleKey + (r.perms || []).length).join(",")}`;
    if (!options.force && screen.dataset.centrixRolesMount === key) return true;
    screen.dataset.centrixRolesMount = key;
    const statusPill = (a) => {
      if (a.enabled === false) return `<span style="font-size:11px;font-weight:700;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:999px;padding:2px 9px;">Đã khóa</span>`;
      if (!a.lastLoginAt) return `<span style="font-size:11px;font-weight:700;color:#b45309;background:#fff7ed;border:1px solid #fed7aa;border-radius:999px;padding:2px 9px;">Đã mời</span>`;
      return `<span style="font-size:11px;font-weight:700;color:var(--ok-text,#15803d);background:var(--ok-soft,#f0fdf4);border:1px solid var(--ok-border,#bbf7d0);border-radius:999px;padding:2px 9px;">Đang hoạt động</span>`;
    };
    const rowsHtml = accounts.length ? accounts.map((a) => {
      const initial = escapeHtml((a.displayName || a.username || "?").trim().charAt(0).toUpperCase());
      const actions = owner ? (
        `<button type="button" data-centrix-server-action="staff-edit" data-staff-user="${escapeHtml(a.username)}" style="font-size:12px;font-weight:700;color:var(--brand,#2563eb);background:var(--brand-soft,#eff6ff);border:1px solid var(--brand-border,#bfdbfe);border-radius:8px;padding:6px 11px;cursor:pointer;">Sửa</button>`
        + `<button type="button" data-centrix-server-action="staff-toggle" data-staff-user="${escapeHtml(a.username)}" style="font-size:12px;font-weight:700;color:var(--text-2,#64748b);background:transparent;border:1px solid var(--field-border,#cbd5e1);border-radius:8px;padding:6px 11px;cursor:pointer;">${a.enabled === false ? "Mở" : "Khóa"}</button>`
        + (a.isOwner ? "" : `<button type="button" data-centrix-server-action="staff-delete" data-staff-user="${escapeHtml(a.username)}" style="font-size:12px;font-weight:700;color:#dc2626;background:transparent;border:1px solid #fecaca;border-radius:8px;padding:6px 11px;cursor:pointer;">Xóa</button>`)
      ) : "";
      return `<div style="display:grid;grid-template-columns:1fr auto auto;gap:14px;align-items:center;padding:13px 4px;border-bottom:1px solid var(--border-soft,#eef2f7);">`
        + `<div style="display:flex;align-items:center;gap:11px;min-width:0;"><span style="width:34px;height:34px;border-radius:50%;background:var(--brand,#2563eb);color:#fff;display:inline-flex;align-items:center;justify-content:center;font:800 14px Segoe UI;flex:0 0 auto;">${initial}</span><div style="min-width:0;"><div style="font:700 14px Segoe UI;color:var(--text,#0f172a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.displayName || a.username)}${a.isOwner ? ` <span style="font-size:10.5px;color:var(--brand,#2563eb);">● Chủ sở hữu</span>` : ""}</div><div style="font-size:12px;color:var(--text-3,#94a3b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.username)}</div></div></div>`
        + `<div style="display:flex;align-items:center;gap:10px;justify-content:flex-end;"><span style="font-size:12.5px;color:var(--text-2,#64748b);">${escapeHtml(roleLabel(a.role) || (a.isOwner ? "Chủ sở hữu" : "—"))}</span>${statusPill(a)}</div>`
        + `<div style="display:flex;gap:7px;justify-content:flex-end;">${actions}</div>`
        + `</div>`;
    }).join("") : `<div style="padding:30px;text-align:center;color:${state.staffAdmin.error ? "#dc2626" : "var(--text-3,#94a3b8)"};font-size:13px;">${state.staffAdmin.error ? ("Lỗi tải dữ liệu: " + escapeHtml(state.staffAdmin.error)) : (state.staffAdmin.loaded ? ("Chưa có nhân viên nào." + (owner ? " Bấm “+ Mời thành viên”." : "")) : "Đang tải…")}</div>`;
    const rolesHtml = roles.map((r) => {
      const count = accounts.filter((a) => (r.roleKey === "owner" ? a.isOwner : a.role === r.roleKey)).length;
      const desc = r.roleKey === "owner" ? "Toàn quyền hệ thống" : `${(r.perms || []).length} chức năng`;
      return `<div style="flex:1;min-width:210px;border:1px solid var(--border,#e2e8f0);border-radius:12px;padding:14px 16px;background:var(--surface,#fff);">`
        + `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><div style="font:800 14px Segoe UI;color:var(--text,#0f172a);">${escapeHtml(r.name)}</div><span style="font-size:11.5px;color:var(--text-3,#94a3b8);white-space:nowrap;">${count} người</span></div>`
        + `<div style="font-size:12px;color:var(--text-2,#64748b);margin-top:7px;line-height:1.5;">${escapeHtml(desc)}</div>`
        + (owner && r.roleKey !== "owner" ? `<button type="button" data-centrix-server-action="role-edit" data-role-key="${escapeHtml(r.roleKey)}" style="margin-top:11px;font-size:12px;font-weight:700;color:var(--brand,#2563eb);background:var(--brand-soft,#eff6ff);border:1px solid var(--brand-border,#bfdbfe);border-radius:8px;padding:6px 12px;cursor:pointer;">Chỉnh quyền</button>` : "")
        + `</div>`;
    }).join("");
    const flagNote = staffActive() ? "" : ` · <strong style="color:#b45309;">RBAC đang TẮT (đặt CENTRIX_STAFF_RBAC=log/on để áp dụng)</strong>`;
    screen.innerHTML = `
      <div data-centrix-roles-root="1" style="display:flex;flex-direction:column;gap:18px;">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div><div style="font:900 21px Segoe UI;color:var(--text,#0f172a);letter-spacing:-.01em;">Nhóm & Phân quyền</div><div style="font-size:13px;color:var(--text-2,#64748b);margin-top:4px;">Quản lý tài khoản vận hành và phân quyền truy cập.${flagNote}</div></div>
          ${owner ? `<button type="button" data-centrix-server-action="staff-invite" style="height:40px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:800 13px Segoe UI;cursor:pointer;padding:0 18px;box-shadow:0 4px 12px rgba(37,99,235,.25);">+ Mời thành viên</button>` : ""}
        </div>
        <div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 1px 3px var(--shadow,rgba(15,23,42,.05));padding:18px 20px;">
          <div style="font:800 15px Segoe UI;color:var(--text,#0f172a);margin-bottom:6px;">Thành viên nhóm</div>${rowsHtml}
        </div>
        <div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 1px 3px var(--shadow,rgba(15,23,42,.05));padding:18px 20px;">
          <div style="font:800 15px Segoe UI;color:var(--text,#0f172a);margin-bottom:12px;">Vai trò & Quyền hạn</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">${rolesHtml}</div>
        </div>
      </div>`;
    return true;
  }

  // ── Staff create/edit modal ──────────────────────────────────────────────────────────────────────
  function closeStaffModal() { document.getElementById("centrix-staff-modal")?.remove(); }
  function openStaffModal(acct) {
    if (document.getElementById("centrix-staff-modal")) return;
    const isEdit = !!acct;
    const roleOpts = (state.staffAdmin.roles || []).filter((r) => r.roleKey !== "owner")
      .map((r) => `<option value="${escapeHtml(r.roleKey)}" ${acct && acct.role === r.roleKey ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("");
    const overlay = document.createElement("div");
    overlay.id = "centrix-staff-modal";
    overlay.dataset.staffUser = isEdit ? acct.username : "";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483630;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.innerHTML = `
      <div role="dialog" style="width:400px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;">
        <div style="font:900 18px Segoe UI;color:var(--text,#0f172a);">${isEdit ? "Sửa nhân viên" : "Mời thành viên"}</div>
        <div style="font:500 12.5px/1.45 Segoe UI;color:var(--text-2,#64748b);margin-top:4px;">${isEdit ? "Đổi tên hiển thị, vai trò hoặc đặt lại mật khẩu." : "Tạo tài khoản vận hành. Họ đăng nhập App Server bằng email + mật khẩu."}</div>
        <label style="${STAFF_LABEL_CSS}">Email / tài khoản <input id="cx-staff-m-user" type="text" autocomplete="off" placeholder="vd: support@centrix.asia" value="${isEdit ? escapeHtml(acct.username) : ""}" ${isEdit ? "disabled" : ""} style="${STAFF_FIELD_CSS}${isEdit ? "opacity:.6;" : ""}"></label>
        <label style="${STAFF_LABEL_CSS}">Tên hiển thị <input id="cx-staff-m-name" autocomplete="off" placeholder="vd: Đội Hỗ trợ" value="${isEdit ? escapeHtml(acct.displayName || "") : ""}" style="${STAFF_FIELD_CSS}"></label>
        <label style="${STAFF_LABEL_CSS}">Vai trò <select id="cx-staff-m-role" style="${STAFF_FIELD_CSS}">${roleOpts || '<option value="">— chưa có vai trò —</option>'}</select></label>
        <label style="${STAFF_LABEL_CSS}">Mật khẩu ${isEdit ? "(để trống nếu không đổi)" : ""} <input id="cx-staff-m-pw" type="text" autocomplete="off" placeholder="${isEdit ? "••••••" : "mật khẩu đăng nhập"}" style="${STAFF_FIELD_CSS}"></label>
        <div id="cx-staff-m-err" style="display:none;margin-top:11px;font:600 12px Segoe UI;color:#dc2626;"></div>
        <div style="display:flex;gap:10px;margin-top:20px;">
          <button type="button" data-centrix-server-action="staff-cancel" style="flex:1;height:42px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI;cursor:pointer;">Hủy</button>
          <button type="button" data-centrix-server-action="staff-save" style="flex:1.4;height:42px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:900 13px Segoe UI;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));">${isEdit ? "Lưu thay đổi" : "Tạo tài khoản"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeStaffModal(); });
    setTimeout(() => document.getElementById(isEdit ? "cx-staff-m-name" : "cx-staff-m-user")?.focus(), 50);
  }
  async function saveStaffFromUi() {
    const modal = document.getElementById("centrix-staff-modal");
    if (!modal) return;
    const isEdit = !!modal.dataset.staffUser;
    const username = isEdit ? modal.dataset.staffUser : String(document.getElementById("cx-staff-m-user")?.value || "").trim().toLowerCase();
    const displayName = String(document.getElementById("cx-staff-m-name")?.value || "").trim();
    const role = String(document.getElementById("cx-staff-m-role")?.value || "").trim();
    const password = String(document.getElementById("cx-staff-m-pw")?.value || "");
    const err = (m) => { const el = document.getElementById("cx-staff-m-err"); if (el) { el.textContent = m; el.style.display = "block"; } };
    if (!username) return err("Cần nhập email/tài khoản");
    if (!role) return err("Cần chọn vai trò");
    if (!isEdit && password.length < 6) return err("Mật khẩu tối thiểu 6 ký tự");
    const body = { username, displayName, role };
    if (password) body.password = password;
    if (!isEdit) body.enabled = true;
    try {
      await postJson("/api/admin/staff/save", body);
      closeStaffModal();
      showActionToast(isEdit ? "Đã cập nhật nhân viên" : `Đã tạo ${username}`);
      await loadStaffAdmin(true);
    } catch (e) { err(e.message || "Lỗi lưu"); }
  }
  async function deleteStaffById(username) {
    if (!username) return;
    if (!window.confirm(`Xóa nhân viên ${username}? Phiên đang đăng nhập của họ sẽ bị thu hồi.`)) return;
    try {
      await postJson("/api/admin/staff/delete", { username });
      showActionToast("Đã xóa nhân viên");
      await loadStaffAdmin(true);
    } catch (e) { showActionToast(e.message || "Lỗi xóa", "error"); }
  }
  async function toggleStaffEnabled(username) {
    const a = staffAdminAccount(username);
    if (!a) return;
    const enable = a.enabled === false; // currently disabled → enable
    try {
      await postJson("/api/admin/staff/save", { username, enabled: enable });
      showActionToast(enable ? "Đã mở khóa" : "Đã khóa nhân viên");
      await loadStaffAdmin(true);
    } catch (e) { showActionToast(e.message || "Lỗi", "error"); }
  }

  // ── Role permission editor (owner only) ──────────────────────────────────────────────────────────
  function closeRolePermModal() { document.getElementById("centrix-role-perm-modal")?.remove(); }
  function openRolePermModal(roleKey) {
    if (document.getElementById("centrix-role-perm-modal")) return;
    const role = (state.staffAdmin.roles || []).find((r) => r.roleKey === roleKey);
    if (!role || role.roleKey === "owner") return;
    const have = new Set(role.perms || []);
    const groupsHtml = VIEW_GROUPS.map(([gName, keys]) => {
      const items = keys.map((k) => `<label style="display:flex;align-items:center;gap:8px;font:600 12.5px Segoe UI;color:var(--text,#0f172a);padding:5px 0;cursor:pointer;"><input type="checkbox" data-cx-perm="${escapeHtml(k)}" ${have.has(k) ? "checked" : ""} style="width:15px;height:15px;cursor:pointer;"> ${escapeHtml(ADMIN_VIEW_LABELS[k] || k)}</label>`).join("");
      return `<div style="flex:1;min-width:190px;"><div style="font:800 10.5px Segoe UI;color:var(--label,#94a3b8);text-transform:uppercase;letter-spacing:.04em;margin:6px 0;">${escapeHtml(gName)}</div>${items}</div>`;
    }).join("");
    const overlay = document.createElement("div");
    overlay.id = "centrix-role-perm-modal";
    overlay.dataset.roleKey = roleKey;
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483630;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
    overlay.innerHTML = `
      <div role="dialog" style="width:640px;max-width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;">
        <div style="font:900 18px Segoe UI;color:var(--text,#0f172a);">Phân quyền: ${escapeHtml(role.name)}</div>
        <div style="font:500 12.5px/1.45 Segoe UI;color:var(--text-2,#64748b);margin-top:4px;">Chọn các chức năng (mục sidebar) mà vai trò này được phép truy cập.</div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:14px;">${groupsHtml}</div>
        <div style="display:flex;gap:10px;margin-top:22px;">
          <button type="button" data-centrix-server-action="role-perm-cancel" style="flex:1;height:42px;border:1px solid var(--field-border,#cbd5e1);border-radius:10px;background:var(--surface,#fff);color:var(--text,#0f172a);font:800 13px Segoe UI;cursor:pointer;">Hủy</button>
          <button type="button" data-centrix-server-action="role-perm-save" style="flex:1.4;height:42px;border:0;border-radius:10px;background:var(--brand,#2563eb);color:#fff;font:900 13px Segoe UI;cursor:pointer;box-shadow:0 4px 12px var(--brand-shadow,rgba(37,99,235,.25));">Lưu quyền</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeRolePermModal(); });
  }
  async function saveRolePermsFromUi() {
    const modal = document.getElementById("centrix-role-perm-modal");
    if (!modal) return;
    const roleKey = modal.dataset.roleKey;
    const role = (state.staffAdmin.roles || []).find((r) => r.roleKey === roleKey);
    const perms = Array.from(modal.querySelectorAll("input[data-cx-perm]:checked")).map((el) => el.getAttribute("data-cx-perm"));
    try {
      await postJson("/api/admin/roles/save", { roleKey, name: role ? role.name : roleKey, perms });
      closeRolePermModal();
      showActionToast("Đã lưu quyền vai trò");
      await loadStaffAdmin(true);
    } catch (e) { showActionToast(e.message || "Lỗi lưu quyền", "error"); }
  }

  // ── Dashboard (Tổng quan) real-data patch ────────────────────────────────────────────────────────
  // The static React dashboard shows DEMO numbers for several cards (total users, MRR, requests today,
  // credit in circulation…). DCLogic has no data hook for those, so we DOM-patch each card's big number
  // with the REAL value from the authoritative /api/admin/summary — the same Docker DB App User feeds.
  function findDashScreen() {
    const byLabel = visibleScreens().find((s) => {
      const l = fold(s.getAttribute("data-screen-label"));
      return l.includes("dashboard") || l.includes("dieu khien") || l.includes("tong quan");
    });
    if (byLabel) return byLabel;
    // Fallback: the visible screen that contains the "Tổng người dùng" card.
    return visibleScreens().find((s) => Array.from(s.querySelectorAll("div,span,p")).some(
      (e) => !e.children.length && fold((e.textContent || "").trim()) === "tong nguoi dung")) || null;
  }
  function dashBigNumberLeaf(card, labelEl) {
    let best = null, bestSize = 0;
    for (const el of card.querySelectorAll("div,span,p,strong,b")) {
      if (el.children.length || el === labelEl) continue;
      if (!/[0-9]/.test((el.textContent || "").trim())) continue; // the value contains digits; labels don't
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (fs > bestSize) { bestSize = fs; best = el; }
    }
    return best;
  }
  function dashFmt(n) { return (Number(n) || 0).toLocaleString("vi-VN"); }
  function mountDashboardStats() {
    const screen = findDashScreen();
    if (!screen) return false;
    const s = state.summary || {};
    if (typeof s.users !== "number") return false; // summary not loaded yet
    // paying/MRR: real subscription revenue. All current users are Free (realUserPool hardcodes Free and
    // the users table has no plan), so this is genuinely 0 today; future paid subs would flow via summary.
    const paying = (state.users || []).filter((u) => { const p = fold(u.plan || ""); return p && !/free|mien phi/.test(p); }).length;
    const targets = {
      "tong nguoi dung": dashFmt(s.users),
      "credit dang luu hanh": dashFmt(s.totalCredit),
      "request hom nay": dashFmt(s.usageToday),
      "sap het credit": dashFmt(s.lowCreditUsers),
      "tai khoan bi khoa": dashFmt(Math.max(0, (s.users || 0) - (s.enabledUsers || 0))),
      "khach tra phi": dashFmt(paying),
      "mrr": paying > 0 ? dashFmt(s.mrr || 0) : "0"
    };
    for (const lab of screen.querySelectorAll("div,span,p,strong,b")) {
      if (lab.children.length) continue;
      const t = fold((lab.textContent || "").trim());
      if (!(t in targets)) continue;
      let card = lab.parentElement, big = null;
      for (let i = 0; i < 4 && card; i += 1) { big = dashBigNumberLeaf(card, lab); if (big) break; card = card.parentElement; }
      if (big && big.textContent.trim() !== targets[t]) big.textContent = targets[t];
    }
    return true;
  }

  // ── Phân tích & Doanh thu (Analytics) real-data patch ────────────────────────────────────────────
  function findAnalyticsScreen() {
    const byLabel = visibleScreens().find((s) => {
      const l = fold(s.getAttribute("data-screen-label"));
      return l.includes("phan tich") || l.includes("doanh thu") || l.includes("analytic");
    });
    if (byLabel) return byLabel;
    return visibleScreens().find((s) => Array.from(s.querySelectorAll("div,span,p")).some(
      (e) => !e.children.length && fold((e.textContent || "").trim()) === "doanh thu thang")) || null;
  }
  function vndShort(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(".", ",") + " tỷ";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + "tr";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(Math.round(n));
  }
  function topupOrdersList() {
    const p = state.portal || {};
    return (p.topupOrders || (p.portal && p.portal.topupOrders) || []);
  }
  function analyticsData() {
    const usage = state.modelUsage || [];
    const users = state.users || [];
    const emailByUser = {}; for (const a of state.accounts || []) if (a && a.userId) emailByUser[a.userId] = a.email;
    const nameByUser = {}; for (const u of users) nameByUser[u.id] = u.name || u.id;
    const paidOrders = topupOrdersList().filter((o) => fold(o.status) === "paid");
    // Nạp ví VNĐ cho khách = TIỀN VÀO → tính vào doanh thu (type "topup", amountDelta > 0). Không gồm buy-credit/
    // buy-plan (chỉ là chuyển ví→credit/gói, không phải tiền mới vào) hay điều chỉnh.
    const moneyTopups = (state.moneyTransactions || []).filter((t) => t && fold(t.type) === "topup" && (Number(t.amountDelta) || 0) > 0);
    const byModel = {}; for (const r of usage) { const m = r.modelId || "?"; (byModel[m] = byModel[m] || { count: 0, credits: 0 }); byModel[m].count += Number(r.count) || 0; byModel[m].credits += Number(r.credits) || 0; }
    const topModels = Object.entries(byModel).map(([modelId, v]) => ({ modelId, count: v.count, credits: v.credits })).sort((a, b) => b.count - a.count).slice(0, 6);
    const byUser = {}; for (const r of usage) { const u = r.userId || "?"; (byUser[u] = byUser[u] || { count: 0 }); byUser[u].count += Number(r.count) || 0; }
    const revByUser = {}; for (const o of paidOrders) revByUser[o.userId] = (revByUser[o.userId] || 0) + (Number(o.amount) || 0);
    for (const t of moneyTopups) revByUser[t.userId] = (revByUser[t.userId] || 0) + (Number(t.amountDelta) || 0);
    const topCustomers = Object.entries(byUser).map(([uid, v]) => ({ uid, name: nameByUser[uid] || emailByUser[uid] || uid, count: v.count, revenue: revByUser[uid] || 0 })).sort((a, b) => b.count - a.count).slice(0, 6);
    const now = new Date();
    const months = []; for (let i = 11; i >= 0; i -= 1) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push({ key: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"), label: "T" + (d.getMonth() + 1) }); }
    const revByMonth = {}; for (const o of paidOrders) { const k = String(o.createdAt || "").slice(0, 7); revByMonth[k] = (revByMonth[k] || 0) + (Number(o.amount) || 0); }
    for (const t of moneyTopups) { const k = String(t.createdAt || "").slice(0, 7); revByMonth[k] = (revByMonth[k] || 0) + (Number(t.amountDelta) || 0); }
    const revSeries = months.map((m) => ({ label: m.label, value: revByMonth[m.key] || 0 }));
    const days = []; for (let i = 13; i >= 0; i -= 1) { const d = new Date(now); d.setDate(d.getDate() - i); days.push(d.toISOString().slice(0, 10)); }
    const cntByDay = {}; for (const r of usage) { const k = String(r.day || r.updatedAt || "").slice(0, 10); cntByDay[k] = (cntByDay[k] || 0) + (Number(r.count) || 0); }
    const usageSeries = days.map((k) => ({ label: k.slice(8) + "/" + k.slice(5, 7), value: cntByDay[k] || 0 }));
    const usersCount = (state.summary && state.summary.users) || users.length || 0;
    const ym = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const monthRev = revByMonth[ym] || 0;
    const creditSold = paidOrders.reduce((a, o) => a + (Number(o.credits) || 0), 0);
    const paying = users.filter((u) => { const p = fold(u.plan || ""); return p && !/free|mien phi/.test(p); }).length;
    const arpu = usersCount ? Math.round(monthRev / usersCount) : 0;
    return { topModels, topCustomers, revSeries, usageSeries, monthRev, creditSold, paying, arpu, usersCount };
  }
  function svgLine(series, w, h) {
    w = w || 640; h = h || 230; const pad = 22; const iw = w - pad * 2; const ih = h - pad * 2;
    const max = Math.max(1, ...series.map((s) => s.value));
    const pts = series.map((s, i) => [pad + iw * i / Math.max(1, series.length - 1), pad + ih - ih * s.value / max]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const area = line + " L " + (pad + iw).toFixed(1) + " " + (pad + ih) + " L " + pad + " " + (pad + ih) + " Z";
    const labels = series.map((s, i) => `<text x="${(pad + iw * i / Math.max(1, series.length - 1)).toFixed(0)}" y="${h - 4}" font-size="9.5" fill="#94a3b8" text-anchor="middle">${escapeHtml(s.label)}</text>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;"><path d="${area}" fill="rgba(37,99,235,.12)"/><path d="${line}" fill="none" stroke="#2563eb" stroke-width="2.5"/>${labels}</svg>`;
  }
  function svgBars(series, w, h) {
    w = w || 640; h = h || 230; const pad = 22; const iw = w - pad * 2; const ih = h - pad * 2;
    const max = Math.max(1, ...series.map((s) => s.value)); const gap = iw / series.length; const bw = gap * 0.6;
    const bars = series.map((s, i) => { const x = pad + gap * i + (gap - bw) / 2; const bh = ih * s.value / max; return `<rect x="${x.toFixed(1)}" y="${(pad + ih - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="3" fill="#2563eb"/>`; }).join("");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;">${bars}</svg>`;
  }
  // Full real-data render of the Phân tích & Doanh thu screen (replaces the demo cards/charts/tables).
  function mountAnalyticsStats() {
    const screen = findAnalyticsScreen();
    if (!screen) return false;
    if (typeof (state.summary || {}).users !== "number" && !(state.users || []).length) return false;
    const d = analyticsData();
    const sig = [d.usersCount, d.monthRev, d.creditSold, d.paying, d.arpu,
      d.topModels.map((m) => m.modelId + m.count + m.credits).join(","),
      d.topCustomers.map((c) => c.uid + c.count + c.revenue).join(","),
      d.usageSeries.map((x) => x.value).join(","), d.revSeries.map((x) => x.value).join(",")].join("|");
    if (screen.dataset.cxAnalyticsSig === sig && screen.querySelector("[data-centrix-analytics-root]")) return true;
    screen.dataset.cxAnalyticsSig = sig;
    const card = (label, value, sub) => `<div style="flex:1;min-width:150px;border:1px solid var(--border-soft,#e2e8f0);border-radius:14px;padding:15px 17px;background:var(--surface,#fff);"><div style="font:800 10.5px Segoe UI;letter-spacing:.04em;color:var(--label,#94a3b8);text-transform:uppercase;">${escapeHtml(label)}</div><div style="font:800 23px/1.1 Segoe UI;color:var(--text,#0f172a);margin-top:8px;">${value}</div><div style="font-size:11.5px;color:var(--text-3,#94a3b8);margin-top:5px;">${escapeHtml(sub || "")}</div></div>`;
    const cards = [
      card("Doanh thu tháng", vndShort(d.monthRev), "tháng này"),
      card("MRR", "0", "doanh thu định kỳ"),
      card("Khách trả phí", dashFmt(d.paying), "đang trả phí"),
      card("ARPU", vndShort(d.arpu), "doanh thu / khách"),
      card("Tỉ lệ huỷ", "0%", "churn 30 ngày"),
      card("Credit đã bán", dashFmt(d.creditSold), "tổng đã bán")
    ].join("");
    const box = (title, sub, body) => `<div style="flex:1;min-width:340px;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:18px 20px;"><div style="font:800 15px Segoe UI;color:var(--text,#0f172a);">${escapeHtml(title)}</div><div style="font-size:12px;color:var(--text-3,#94a3b8);margin:3px 0 12px;">${escapeHtml(sub)}</div>${body}</div>`;
    const head3 = (a, b, c) => `<div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;font:700 10.5px Segoe UI;letter-spacing:.03em;color:var(--label,#94a3b8);text-transform:uppercase;padding:0 2px 4px;"><span>${escapeHtml(a)}</span><span style="text-align:right;">${escapeHtml(b)}</span><span style="text-align:right;">${escapeHtml(c)}</span></div>`;
    const rows3 = (arr) => arr.length ? arr.map((r) => `<div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:9px 2px;border-top:1px solid var(--border-soft,#eef2f7);font-size:13px;color:var(--text,#0f172a);">${r}</div>`).join("") : `<div style="padding:18px;text-align:center;color:var(--text-3,#94a3b8);font-size:12.5px;">Chưa có dữ liệu</div>`;
    const custRows = rows3(d.topCustomers.map((c) => `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(c.name)}</span><span style="text-align:right;color:var(--text-2,#64748b);">${dashFmt(c.count)}</span><span style="text-align:right;font-weight:700;">${vndShort(c.revenue)}</span>`));
    const modelRows = rows3(d.topModels.map((m) => `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;">${escapeHtml(m.modelId)}</span><span style="text-align:right;color:var(--text-2,#64748b);">${dashFmt(m.count)}</span><span style="text-align:right;font-weight:700;">${dashFmt(m.credits)}</span>`));
    screen.innerHTML = `
      <div data-centrix-analytics-root="1" style="display:flex;flex-direction:column;gap:18px;">
        <div><div style="font:900 21px Segoe UI;color:var(--text,#0f172a);">Phân tích & Doanh thu</div><div style="font-size:13px;color:var(--text-2,#64748b);margin-top:3px;">Tổng quan doanh thu, lượt dùng và khách hàng — dữ liệu thật.</div></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">${cards}</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          ${box("Doanh thu theo tháng", "Đơn vị: VND · 12 tháng", svgLine(d.revSeries))}
          ${box("Lượt dùng 14 ngày", "Số request mỗi ngày", svgBars(d.usageSeries))}
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;">
          ${box("Khách hàng dùng nhiều nhất", "Theo lượt gọi model", head3("Khách", "Lượt", "Doanh thu") + custRows)}
          ${box("Model gọi nhiều nhất", "Theo lượt gọi", head3("Model", "Lượt", "Credit") + modelRows)}
        </div>
      </div>`;
    return true;
  }

  // ── Thanh toán & Hóa đơn (Payments) real-data render ─────────────────────────────────────────────
  function findPaymentsScreen() {
    const byLabel = visibleScreens().find((s) => {
      const l = fold(s.getAttribute("data-screen-label"));
      return l.includes("thanh toan") || l.includes("hoa don");
    });
    if (byLabel) return byLabel;
    return visibleScreens().find((s) => Array.from(s.querySelectorAll("div,span,p")).some(
      (e) => !e.children.length && fold((e.textContent || "").trim()) === "da thu thang nay")) || null;
  }
  function payMethod(m) {
    const f = fold(m);
    if (f.includes("vietqr")) return "VietQR";
    if (f.includes("momo")) return "Momo";
    if (f.includes("zalo")) return "ZaloPay";
    if (f.includes("stripe")) return "Stripe";
    if (f.includes("bank") || f.includes("chuyen khoan")) return "Chuyển khoản";
    return m || "—";
  }
  function payBadge(status) {
    const s = fold(status);
    if (s === "paid") return { t: "Đã thanh toán", c: "#15803d", bg: "#f0fdf4", b: "#bbf7d0" };
    if (s === "refunded" || s === "refund") return { t: "Đã hoàn", c: "#64748b", bg: "#f1f5f9", b: "#e2e8f0" };
    if (s === "failed") return { t: "Thất bại", c: "#b91c1c", bg: "#fef2f2", b: "#fecaca" };
    return { t: "Chờ xử lý", c: "#b45309", bg: "#fff7ed", b: "#fed7aa" };
  }
  function paymentsData() {
    const orders = topupOrdersList();
    const users = state.users || [];
    const nameByUser = {}; for (const u of users) nameByUser[u.id] = u.name || u.id;
    const emailByUser = {}; for (const a of state.accounts || []) if (a && a.userId) emailByUser[a.userId] = a.email;
    const now = new Date();
    const ym = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const inMonth = (o) => String(o.createdAt || "").slice(0, 7) === ym;
    const st = (o) => fold(o.status);
    const collected = orders.filter((o) => st(o) === "paid" && inMonth(o)).reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const pending = orders.filter((o) => st(o) === "pending").reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const refunded = orders.filter((o) => (st(o) === "refunded" || st(o) === "refund") && inMonth(o)).reduce((a, o) => a + (Number(o.amount) || 0), 0);
    const invoices = (state.portal && (state.portal.invoices || (state.portal.portal && state.portal.portal.invoices))) || [];
    const issued = invoices.filter((i) => { const s = fold(i.status); return s === "issued" || s === "paid" || s === "exported"; }).length || orders.filter((o) => st(o) === "paid").length;
    const pendingInv = invoices.filter((i) => fold(i.status) === "pending").length || orders.filter((o) => st(o) === "pending").length;
    const rows = orders.slice(0, 14).map((o) => ({ code: o.payCode || o.id, name: nameByUser[o.userId] || emailByUser[o.userId] || o.userId, credits: o.credits, amount: o.amount, method: o.paymentMethod || o.note, status: o.status, createdAt: o.createdAt }));
    return { collected, pending, refunded, issued, pendingInv, rows, total: orders.length };
  }
  function mountPaymentsPanel() {
    const screen = findPaymentsScreen();
    if (!screen) return false;
    if (typeof (state.summary || {}).users !== "number" && !(state.users || []).length) return false;
    const d = paymentsData();
    const sig = [d.collected, d.pending, d.refunded, d.issued, d.pendingInv, d.total, d.rows.map((r) => r.code + r.status + r.amount).join(",")].join("|");
    if (screen.dataset.cxPaySig === sig && screen.querySelector("[data-centrix-pay-root]")) return true;
    screen.dataset.cxPaySig = sig;
    const card = (label, value, sub, color) => `<div style="flex:1;min-width:200px;border:1px solid var(--border-soft,#e2e8f0);border-radius:14px;padding:16px 18px;background:var(--surface,#fff);"><div style="font:800 10.5px Segoe UI;letter-spacing:.04em;color:var(--label,#94a3b8);text-transform:uppercase;">${escapeHtml(label)}</div><div style="font:800 24px/1.1 Segoe UI;color:${color || "var(--text,#0f172a)"};margin-top:8px;">${value}</div><div style="font-size:11.5px;color:var(--text-3,#94a3b8);margin-top:5px;">${escapeHtml(sub || "")}</div></div>`;
    const COLS = "grid-template-columns:150px 1fr 110px 110px 130px 100px;gap:12px;";
    const head = `<div style="display:grid;${COLS}font:700 10.5px Segoe UI;letter-spacing:.03em;color:var(--label,#94a3b8);text-transform:uppercase;padding:0 2px 6px;"><span>Mã HĐ</span><span>Khách hàng</span><span style="text-align:right;">Số tiền</span><span>Phương thức</span><span>Trạng thái</span><span style="text-align:right;">Ngày</span></div>`;
    const trRows = d.rows.length ? d.rows.map((r) => {
      const b = payBadge(r.status);
      return `<div style="display:grid;${COLS}align-items:center;padding:11px 2px;border-top:1px solid var(--border-soft,#eef2f7);font-size:13px;color:var(--text,#0f172a);">`
        + `<span style="font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--brand,#2563eb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.code)}</span>`
        + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.name)}<span style="color:var(--text-3,#94a3b8);"> · ${dashFmt(r.credits)} credit</span></span>`
        + `<span style="font-weight:700;text-align:right;">${vndShort(r.amount)}</span>`
        + `<span style="color:var(--text-2,#64748b);">${escapeHtml(payMethod(r.method))}</span>`
        + `<span><span style="font-size:11px;font-weight:700;color:${b.c};background:${b.bg};border:1px solid ${b.b};border-radius:999px;padding:2px 9px;">${b.t}</span></span>`
        + `<span style="color:var(--text-3,#94a3b8);font-size:12px;text-align:right;">${escapeHtml(String(r.createdAt || "").slice(0, 10))}</span>`
        + `</div>`;
    }).join("") : `<div style="padding:26px;text-align:center;color:var(--text-3,#94a3b8);font-size:13px;">Chưa có giao dịch nào</div>`;
    screen.innerHTML = `
      <div data-centrix-pay-root="1" style="display:flex;flex-direction:column;gap:18px;">
        <div><div style="font:900 21px Segoe UI;color:var(--text,#0f172a);">Thanh toán & Hóa đơn</div><div style="font-size:13px;color:var(--text-2,#64748b);margin-top:3px;">Lịch sử giao dịch nạp credit — dữ liệu thật.</div></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          ${card("Đã thu tháng này", vndShort(d.collected), "đơn đã thanh toán", "#15803d")}
          ${card("Chờ thanh toán", vndShort(d.pending), d.total + " đơn · " + d.pendingInv + " chờ", "#b45309")}
          ${card("Đã hoàn tháng này", vndShort(d.refunded), "đơn hoàn tiền", "#dc2626")}
        </div>
        <div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:18px 20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;"><div style="font:800 15px Segoe UI;color:var(--text,#0f172a);">Giao dịch gần đây</div><div style="font-size:12px;color:var(--text-3,#94a3b8);">Hóa đơn VAT: đã xuất ${d.issued} · chờ xuất ${d.pendingInv}</div></div>
          ${head}${trRows}
        </div>
      </div>`;
    return true;
  }

  // ── Can thiệp thủ công (Manual Intervention) — real automated-task health board ───────────────────
  function findInterventionScreen() {
    const byLabel = visibleScreens().find((s) => {
      const l = fold(s.getAttribute("data-screen-label"));
      if (l.includes("nhat ky")) return false; // "Nhật ký can thiệp" cũng chứa "can thiep" — đừng đè lên trang log
      return l.includes("thu cong") || l.includes("can thiep") || l.includes("intervention");
    });
    if (byLabel) return byLabel;
    return visibleScreens().find((s) => Array.from(s.querySelectorAll("div,span,p")).some(
      (e) => !e.children.length && fold((e.textContent || "").trim()) === "tac vu tu dong")) || null;
  }
  // The audit-log screen ("Nhật ký can thiệp") is a SEPARATE view from the health board above.
  function findInterventionLogScreen() {
    return visibleScreens().find((s) => {
      const l = fold(s.getAttribute("data-screen-label"));
      return l.includes("nhat ky") && (l.includes("can thiep") || l.includes("intervention"));
    }) || null;
  }
  function interReasonOf(t) {
    let r = t && t.reason ? t.reason : "";
    if (!r && t && t.details) { try { r = (JSON.parse(t.details) || {}).reason || ""; } catch (e) { r = ""; } }
    return fold(r);
  }
  function buildInterventionTasks() {
    const O = topupOrdersList(); const f = (x) => fold(x || ""); const now = Date.now();
    const W = state.creditWallets || []; const TX = state.creditTransactions || []; const U = state.users || []; const s = state.summary || {};
    const today = new Date().toISOString().slice(0, 10); const txDay = (t) => String(t.createdAt || t.at || "").slice(0, 10);
    const T = [];
    const pending = O.filter((o) => f(o.status) === "pending"); const stuck = pending.filter((o) => now - (Date.parse(o.createdAt || "") || now) > 864e5); const failed = O.filter((o) => f(o.status) === "failed");
    T.push({ key: "order-pending-settle", group: "Đơn hàng & Thanh toán", title: "Xử lý đơn nạp credit (chờ thanh toán)",
      status: failed.length ? "loi" : stuck.length ? "treo" : "ok", count: failed.length || stuck.length || 0,
      detail: failed.length ? `${dashFmt(failed.length)} đơn nạp thất bại cần kiểm tra` : stuck.length ? `${dashFmt(stuck.length)} đơn treo >24h ở bước xác nhận thanh toán` : `Không có đơn kẹt (${dashFmt(pending.length)} đơn chờ trong hạn)` });
    const errUC = O.filter((o) => o.settledAt && !o.creditedAt && f(o.status) !== "failed" && f(o.status) !== "refunded"); const gapUC = O.filter((o) => f(o.status) === "approved" && !o.creditedAt);
    T.push({ key: "order-approved-uncredited", group: "Đơn hàng & Thanh toán", title: "Cộng ví cho đơn đã duyệt",
      status: errUC.length ? "loi" : gapUC.length ? "treo" : "ok", count: errUC.length || gapUC.length || 0,
      detail: errUC.length ? `${dashFmt(errUC.length)} đơn đã chốt nhưng ví chưa nhận credit` : gapUC.length ? `${dashFmt(gapUC.length)} đơn đã duyệt nhưng chưa cộng ví` : "Mọi đơn đã duyệt đều đã cộng ví" });
    const refNeed = O.filter((o) => (f(o.status) === "refunded" || f(o.status) === "refund") && o.creditedAt);
    T.push({ key: "refund-reverse", group: "Đơn hàng & Thanh toán", title: "Hoàn tiền & đảo ví",
      status: refNeed.length ? "loi" : "ok", count: refNeed.length,
      detail: refNeed.length ? `${dashFmt(refNeed.length)} yêu cầu hoàn tiền chưa đảo ví` : "Không có khoản hoàn cần xử lý" });
    const planBlk = TX.filter((t) => f(t.type) === "blocked" && /plan-(daily|monthly|service)/.test(interReasonOf(t)) && txDay(t) === today);
    T.push({ key: "plan-gate-blocked", group: "Gói dịch vụ", title: "Chặn theo hạn mức gói (Plan gate)",
      status: planBlk.length ? "treo" : "ok", count: planBlk.length,
      detail: planBlk.length ? `${dashFmt(planBlk.length)} lượt bị chặn do trần gói hôm nay` : "Không có chặn theo gói hôm nay" });
    if (typeof s.subPastDue === "number") {
      T.push({ key: "plan-renewal", group: "Gói dịch vụ", title: "Gia hạn & vòng đời gói",
        status: s.subPastDue ? "loi" : s.subGrace ? "treo" : "ok", count: s.subPastDue || s.subGrace || 0,
        detail: s.subPastDue ? `${dashFmt(s.subPastDue)} gói quá hạn cần gia hạn` : s.subGrace ? `${dashFmt(s.subGrace)} gói đang gia hạn tạm` : "Gói hoạt động bình thường" });
    } else {
      T.push({ key: "plan-renewal", group: "Gói dịch vụ", title: "Gia hạn & vòng đời gói", status: "nodata", count: 0, detail: "Chưa có gói trả phí đang hoạt động" });
    }
    // Đối soát ví = số dư ví hiện tại PHẢI khớp balanceAfter của GIAO DỊCH MỚI NHẤT trong sổ.
    // (Không dùng Σ amountDelta vì grant lúc đăng ký không ghi sổ → mọi user có grant đều bị báo lệch giả.)
    const lastBal = {}; const lastTs = {};
    for (const t of TX) { const ts = Date.parse(t.createdAt || t.at || "") || 0; if (!(t.userId in lastTs) || ts >= lastTs[t.userId]) { lastTs[t.userId] = ts; lastBal[t.userId] = Number(t.balanceAfter) || 0; } }
    const drift = W.filter((w) => (w.userId in lastBal) && Math.abs((Number(w.balance) || 0) - lastBal[w.userId]) > 0);
    T.push({ key: "wallet-drift", group: "Credit & Model", title: "Đồng bộ số dư ví (đối soát sổ)",
      status: drift.length ? "treo" : "ok", count: drift.length,
      detail: drift.length ? `Lệch ví ${dashFmt(drift.length)} user (số dư ≠ sổ) · chờ đồng bộ` : "Số dư ví khớp sổ giao dịch" });
    const neg = W.filter((w) => (Number(w.balance) || 0) < 0); const over = W.filter((w) => (Number(w.lifetimeSpent) || 0) > (Number(w.lifetimeAdded) || 0));
    T.push({ key: "wallet-negative", group: "Credit & Model", title: "Ví âm / chi vượt nguồn",
      status: neg.length ? "loi" : over.length ? "treo" : "ok", count: neg.length || over.length || 0,
      detail: neg.length ? `${dashFmt(neg.length)} ví đang ÂM số dư` : over.length ? `${dashFmt(over.length)} ví chi vượt tổng nạp` : "Mọi ví đều hợp lệ" });
    const modelBlk = TX.filter((t) => f(t.type) === "blocked" && /model-not-enabled/.test(interReasonOf(t)) && txDay(t) === today);
    T.push({ key: "model-gate-blocked", group: "Credit & Model", title: "Cổng bật/tắt model",
      status: modelBlk.length ? "treo" : "ok", count: modelBlk.length,
      detail: modelBlk.length ? `${dashFmt(modelBlk.length)} lượt gọi model bị chặn (model chưa bật)` : "Không có model bị chặn hôm nay" });
    const lockedN = Math.max(U.filter((u) => u.enabled === false).length, Math.max(0, (s.users || 0) - (s.enabledUsers || 0)));
    T.push({ key: "account-lock", group: "Phiên & Bảo mật", title: "Khóa / mở tài khoản",
      status: "ok", count: lockedN, detail: lockedN ? `${dashFmt(lockedN)} tài khoản đang khóa (chi tiêu đã chặn)` : "Không có tài khoản bị khóa" });
    return T;
  }
  function interBadge(st) {
    if (st === "loi") return { t: "Lỗi", c: "#b91c1c", bg: "#fef2f2", b: "#fecaca" };
    if (st === "treo") return { t: "Đang treo", c: "#b45309", bg: "#fff7ed", b: "#fed7aa" };
    if (st === "nodata") return { t: "Chưa có dữ liệu", c: "#64748b", bg: "#f1f5f9", b: "#e2e8f0" };
    return { t: "Bình thường", c: "#15803d", bg: "#f0fdf4", b: "#bbf7d0" };
  }
  function mountInterventionPanel() {
    const screen = findInterventionScreen();
    if (!screen) return false;
    if (typeof (state.summary || {}).users !== "number" && !(state.users || []).length) return false;
    const T = buildInterventionTasks();
    const sig = T.map((t) => t.key + t.status + t.count).join("|");
    if (screen.dataset.cxInterSig === sig && screen.querySelector("[data-centrix-inter-root]")) return true;
    screen.dataset.cxInterSig = sig;
    const treo = T.filter((t) => t.status === "treo").length; const loi = T.filter((t) => t.status === "loi").length; const mech = T.filter((t) => t.status !== "nodata").length;
    const card = (label, value, sub, color) => `<div style="flex:1;min-width:170px;border:1px solid var(--border-soft,#e2e8f0);border-radius:14px;padding:15px 17px;background:var(--surface,#fff);"><div style="font:800 10.5px Segoe UI;letter-spacing:.04em;color:var(--label,#94a3b8);text-transform:uppercase;">${escapeHtml(label)}</div><div style="font:800 24px/1.1 Segoe UI;color:${color || "var(--text,#0f172a)"};margin-top:8px;">${value}</div><div style="font-size:11.5px;color:var(--text-3,#94a3b8);margin-top:5px;">${escapeHtml(sub || "")}</div></div>`;
    const cards = card("Tác vụ tự động", dashFmt(T.length), "đang giám sát")
      + card("Đã có cơ chế", dashFmt(mech), "can thiệp được", "#15803d")
      + card("Đang treo", dashFmt(treo), "cần xử lý", "#b45309")
      + card("Lỗi", dashFmt(loi), "cần kiểm tra", "#dc2626");
    const groups = [];
    for (const t of T) { let g = groups.find((x) => x.name === t.group); if (!g) { g = { name: t.group, rows: [] }; groups.push(g); } g.rows.push(t); }
    const rowHtml = (t) => {
      const b = interBadge(t.status);
      const act = (t.status === "treo" || t.status === "loi")
        ? `<button type="button" data-centrix-server-action="inter-rerun" style="font-size:12px;font-weight:700;color:var(--brand,#2563eb);background:var(--brand-soft,#eff6ff);border:1px solid var(--brand-border,#bfdbfe);border-radius:8px;padding:6px 12px;cursor:pointer;white-space:nowrap;">↻ Chạy lại</button>`
        : "";
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 4px;border-top:1px solid var(--border-soft,#eef2f7);">`
        + `<div style="min-width:0;"><div style="font:700 14px Segoe UI;color:var(--text,#0f172a);">${escapeHtml(t.title)}</div><div style="font-size:12.5px;color:var(--text-3,#94a3b8);margin-top:3px;">${escapeHtml(t.detail)}</div></div>`
        + `<div style="display:flex;align-items:center;gap:10px;flex:0 0 auto;"><span style="font-size:11.5px;font-weight:700;color:${b.c};background:${b.bg};border:1px solid ${b.b};border-radius:999px;padding:3px 11px;white-space:nowrap;">● ${b.t}</span>${act}</div>`
        + `</div>`;
    };
    const groupsHtml = groups.map((g) => `<div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:8px 20px 14px;"><div style="font:800 10.5px Segoe UI;letter-spacing:.05em;color:var(--label,#94a3b8);text-transform:uppercase;padding:14px 2px 4px;">${escapeHtml(g.name)}</div>${g.rows.map(rowHtml).join("")}</div>`).join("");
    screen.innerHTML = `
      <div data-centrix-inter-root="1" style="display:flex;flex-direction:column;gap:18px;">
        <div><div style="font:900 21px Segoe UI;color:var(--text,#0f172a);">Can thiệp thủ công</div><div style="font-size:13px;color:var(--text-2,#64748b);margin-top:3px;line-height:1.5;">Giám sát các tác vụ tự động (đơn nạp, hoàn tiền, đồng bộ ví, gói, model) — dữ liệu thật từ DB. Thao tác nhạy cảm (ép trạng thái, đảo ví, hoàn tiền) cần duyệt thủ công ở trang tương ứng.</div></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">${cards}</div>
        ${groupsHtml}
      </div>`;
    return true;
  }

  // ===== Nhật ký can thiệp (audit log) — REAL operator interventions from the credit ledger =====
  // The credit ledger IS the intervention audit trail: every manual top-up / adjustment / org-fund
  // allocation is written with the operator's id in `actor` + balanceBefore/After + reason. We surface
  // those (NOT the automated debit/blocked rows from model usage & gate) plus any explicit
  // portal.interventionLogs entries, matching the demo's "Trước → Sau" audit layout but with live data.
  const INTERLOG_AUTO_ACTORS = { system: 1, sepay: 1, "sepay-test": 1, "sepay-e2e": 1, "sepay-realsim": 1, gate: 1, user: 1, "": 1 };
  const INTERLOG_MANUAL_TYPES = { topup: 1, adjust: 1, "org-allocate": 1, "org-reclaim": 1, "org-dept-allocate": 1, "org-dept-reclaim": 1 };
  function interLogTime(iso) {
    const d = new Date(iso || 0);
    if (!iso || isNaN(d.getTime())) return "—";
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // Người thực hiện thao tác — GHI vào `actor` của giao dịch, hiện ở cột "Người thực hiện".
  // Ưu tiên TÊN nhân viên đang đăng nhập (staff-whoami); vào bằng master = "owner"; chưa rõ = "app-server-ui".
  function currentActor() {
    const s = state.staff;
    if (s) {
      const n = s.displayName || s.name || s.fullName || s.username || s.email || "";
      if (n) return String(n);
    }
    if (useMasterOverride) return "owner";
    return "app-server-ui";
  }
  function interLogActor(actor) {
    const a = fold(actor || "");
    if (!actor || a === "system") return { name: "Hệ thống", role: "Tự động", auth: "Hệ thống", c: "#475569", bg: "#f1f5f9", b: "#e2e8f0" };
    if (a === "app-server-ui") return { name: "App Server", role: "Bảng điều khiển quản trị", auth: "Quản trị", c: "#1d4ed8", bg: "#eff6ff", b: "#bfdbfe" };
    if (a === "owner") return { name: "Chủ hệ thống", role: "Chủ sở hữu", auth: "Chủ sở hữu", c: "#15803d", bg: "#f0fdf4", b: "#bbf7d0" };
    // Khớp NHÂN VIÊN thật (theo tên/username) → hiện đúng tên + vai trò (khi danh sách staff đã tải).
    const st = ((state.staffAdmin && state.staffAdmin.accounts) || []).find((x) => x && (fold(x.name) === a || fold(x.username) === a || fold(x.displayName) === a));
    if (st) {
      const rl = ((typeof roleLabel === "function" && roleLabel(st.roleKey)) || (st.isOwner ? "Chủ sở hữu" : "Nhân viên"));
      return { name: st.name || st.displayName || st.username, role: rl, auth: rl, c: "#15803d", bg: "#f0fdf4", b: "#bbf7d0" };
    }
    if (a === "admin" || a === "codex-admin") return { name: actor, role: "Quản trị viên", auth: "Quản trị", c: "#1d4ed8", bg: "#eff6ff", b: "#bfdbfe" };
    if (a === "seed-static-ui") return { name: "Seed dữ liệu", role: "Khởi tạo mẫu", auth: "Hệ thống", c: "#64748b", bg: "#f1f5f9", b: "#e2e8f0" };
    if (a === "diagnostic") return { name: "Chẩn đoán", role: "Kiểm thử hệ thống", auth: "Hệ thống", c: "#64748b", bg: "#f1f5f9", b: "#e2e8f0" };
    if (a.includes("sepay")) return { name: actor, role: "Cổng thanh toán", auth: "Tự động", c: "#475569", bg: "#f1f5f9", b: "#e2e8f0" };
    if (a.includes("ho tro") || a.includes("support")) return { name: actor, role: "Hỗ trợ", auth: "Hỗ trợ", c: "#7c3aed", bg: "#f5f3ff", b: "#ddd6fe" };
    return { name: actor, role: "Chủ tài khoản / vận hành", auth: "Chủ sở hữu", c: "#15803d", bg: "#f0fdf4", b: "#bbf7d0" };
  }
  function interLogAction(tx) {
    const t = String(tx.type || ""); const amt = Number(tx.amountDelta) || 0;
    if (t === "topup") return "Nạp credit (thủ công)";
    if (t === "adjust") return amt >= 0 ? "Cộng credit (điều chỉnh)" : "Trừ credit (điều chỉnh)";
    if (t === "org-allocate") return "Cấp credit tổ chức";
    if (t === "org-reclaim") return "Thu hồi credit tổ chức";
    if (t === "org-dept-allocate") return "Cấp credit phòng ban";
    if (t === "org-dept-reclaim") return "Thu hồi credit phòng ban";
    return tx.reason || "Can thiệp credit";
  }
  function interLogRows() {
    const out = [];
    for (const t of (state.creditTransactions || [])) {
      if (!INTERLOG_MANUAL_TYPES[String(t.type)]) continue;       // bỏ debit/blocked (dùng model & gate = tự động)
      if (INTERLOG_AUTO_ACTORS[String(t.actor || "")]) continue;  // bỏ actor tự động (sepay webhook, system settle)
      const ip = interLogActor(t.actor); const amt = Number(t.amountDelta) || 0;
      const det = detailsObject(t.details);
      out.push({
        ts: Date.parse(t.createdAt || t.at || "") || 0, day: String(t.createdAt || t.at || "").slice(0, 10),
        time: interLogTime(t.createdAt || t.at), actorName: ip.name, role: ip.role, auth: ip,
        action: interLogAction(t), target: userNameById(t.userId) || t.userId || "—",
        before: Number(t.balanceBefore) || 0, after: Number(t.balanceAfter) || 0, amt,
        reason: t.reason || det.note || "—"
      });
    }
    for (const l of ((state.portal || {}).interventionLogs || [])) {
      const ip = interLogActor(l.actor); const iso = l.createdAt || l.updatedAt || "";
      out.push({
        ts: Date.parse(iso) || 0, day: String(iso).slice(0, 10), time: interLogTime(iso),
        actorName: l.actor || ip.name, role: ip.role, auth: ip,
        action: l.action || "Can thiệp thủ công", target: l.interventionId || l.target || "—",
        before: null, after: null, amt: null, reason: l.detail || l.reason || "—"
      });
    }
    return out.sort((a, b) => b.ts - a.ts);
  }
  let interLogPage = 1;
  const INTERLOG_PAGE_SIZE = 10;
  function mountInterventionLogPanel(options = {}) {
    const screen = findInterventionLogScreen();
    if (!screen) return false;
    if (typeof (state.summary || {}).users !== "number" && !(state.users || []).length && !(state.creditTransactions || []).length) return false;
    const all = interLogRows();
    const today = new Date().toISOString().slice(0, 10);
    const todayN = all.filter((r) => r.day === today).length;
    const totalIn = all.reduce((s, r) => s + Math.max(0, Number(r.amt) || 0), 0);
    const totalOut = all.reduce((s, r) => s + Math.max(0, -(Number(r.amt) || 0)), 0);
    const pages = Math.max(1, Math.ceil(all.length / INTERLOG_PAGE_SIZE));
    const page = Math.min(Math.max(1, interLogPage || 1), pages); interLogPage = page;
    const start = (page - 1) * INTERLOG_PAGE_SIZE;
    const rows = all.slice(start, start + INTERLOG_PAGE_SIZE);
    const sig = `${all.length}|${todayN}|${totalIn}|${totalOut}|${page}|${rows[0] ? rows[0].ts : 0}`;
    if (!options.force && screen.dataset.cxInterLogSig === sig && screen.querySelector("[data-centrix-interlog-root]")) return true;
    screen.dataset.cxInterLogSig = sig;
    const cr = (n) => (Number(n) || 0).toLocaleString("vi-VN");
    const card = (label, value, sub, color) => `<div style="flex:1;min-width:160px;border:1px solid var(--border-soft,#e2e8f0);border-radius:13px;padding:14px 16px;background:var(--surface-2,#f8fafc);"><div style="font:700 10.5px Segoe UI;letter-spacing:.06em;color:var(--label,#94a3b8);text-transform:uppercase;">${escapeHtml(label)}</div><div style="font:700 22px/1.1 Segoe UI;color:${color || "var(--text,#0f172a)"};margin-top:6px;">${value}</div><div style="font-size:11.5px;color:var(--text-3,#94a3b8);margin-top:4px;">${escapeHtml(sub || "")}</div></div>`;
    const cards = card("Tổng can thiệp", cr(all.length), "bản ghi bất biến")
      + card("Hôm nay", cr(todayN), "can thiệp mới")
      + card("Cộng credit", "+" + cr(totalIn) + " cr", "đã cấp / nạp", "#15803d")
      + card("Trừ / thu hồi", "−" + cr(totalOut) + " cr", "đã trừ / thu hồi", "#b45309");
    const head = `<div style="display:grid;grid-template-columns:92px 1.2fr 1.5fr 1.4fr 1.3fr 124px;gap:14px;padding:0 12px 10px;border-bottom:1px solid var(--border-soft,#eef2f7);font:700 11px Segoe UI;letter-spacing:.03em;color:var(--label,#94a3b8);text-transform:uppercase;">`
      + `<span>Thời gian</span><span>Người thực hiện</span><span>Hành động · Đối tượng</span><span>Trước → Sau</span><span>Lý do</span><span>Cấp quyền</span></div>`;
    const fmtBA = (r) => {
      if (r.before === null && r.after === null) return `<span style="color:var(--text-3,#94a3b8);">—</span>`;
      const aColor = (Number(r.amt) || 0) >= 0 ? "#15803d" : "#b45309";
      return `<span style="color:var(--text-3,#94a3b8);">${cr(r.before)}</span> <span style="color:var(--text-3,#94a3b8);">→</span> <span style="color:${aColor};font-weight:700;">${cr(r.after)} cr</span>`;
    };
    const rowHtml = (r) => `<div style="display:grid;grid-template-columns:92px 1.2fr 1.5fr 1.4fr 1.3fr 124px;gap:14px;align-items:center;padding:12px 12px;border-bottom:1px solid var(--border-soft,#eef2f7);">`
      + `<span style="font-size:12px;color:var(--text-3,#94a3b8);white-space:nowrap;">${escapeHtml(r.time)}</span>`
      + `<div style="min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--text,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.actorName)}</div><div style="font-size:11.5px;color:var(--text-3,#94a3b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.role)}</div></div>`
      + `<div style="min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--text,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.action)}</div><div style="font-size:11.5px;color:var(--text-3,#94a3b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.target)}</div></div>`
      + `<div style="min-width:0;font-size:12.5px;">${fmtBA(r)}</div>`
      + `<span style="font-size:12.5px;color:var(--text-2,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.reason)}</span>`
      + `<span><span style="font-size:11px;font-weight:700;color:${r.auth.c};background:${r.auth.bg};border:1px solid ${r.auth.b};border-radius:7px;padding:3px 9px;white-space:nowrap;">${escapeHtml(r.auth.auth)}</span></span></div>`;
    const body = rows.length
      ? rows.map(rowHtml).join("")
      : `<div style="text-align:center;padding:48px 20px;color:var(--text-3,#94a3b8);"><div style="font-size:14px;font-weight:600;color:var(--text-2,#64748b);">Chưa có bản ghi can thiệp</div><div style="font-size:13px;margin-top:4px;">Các thao tác can thiệp thủ công sẽ xuất hiện tại đây.</div></div>`;
    const pageBtn = (label, p, disabled, active) => `<button type="button"${disabled ? "" : ` data-centrix-server-action="interlog-page" data-page="${p}"`}${disabled ? " disabled" : ""} style="min-width:32px;height:32px;border:1px solid ${active ? "var(--brand,#2563eb)" : "var(--border,#e2e8f0)"};border-radius:8px;background:${active ? "var(--brand,#2563eb)" : "var(--surface,#fff)"};color:${active ? "#fff" : "var(--text-2,#64748b)"};font-size:12.5px;font-weight:700;cursor:${disabled ? "default" : "pointer"};opacity:${disabled ? ".4" : "1"};padding:0 9px;">${label}</button>`;
    let lo = Math.max(1, page - 2), hi = Math.min(pages, page + 2);
    if (page <= 3) hi = Math.min(pages, 5);
    if (page >= pages - 2) lo = Math.max(1, pages - 4);
    const nums = []; for (let p = lo; p <= hi; p++) nums.push(pageBtn(String(p), p, false, p === page));
    const footer = `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:14px 14px 8px;border-top:1px solid var(--border-soft,#eef2f7);margin-top:2px;">`
      + `<div style="font-size:12.5px;color:var(--text-3,#94a3b8);">Đang xem <b style="color:var(--text-2,#64748b);">${all.length ? start + 1 : 0}–${start + rows.length}</b> trong <b style="color:var(--text-2,#64748b);">${cr(all.length)}</b> bản ghi</div>`
      + `<div style="display:flex;align-items:center;gap:6px;">${pageBtn("‹", page - 1, page <= 1, false)}${nums.join("")}${pageBtn("›", page + 1, page >= pages, false)}</div>`
      + `</div>`;
    screen.innerHTML = `
      <div data-centrix-interlog-root="1" style="display:flex;flex-direction:column;gap:18px;">
        <div><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><div style="font:900 21px Segoe UI;color:var(--text,#0f172a);">Nhật ký can thiệp</div><span style="font-size:11px;font-weight:700;color:var(--text-3,#94a3b8);background:var(--surface-3,#f1f5f9);border:1px solid var(--border,#e2e8f0);border-radius:999px;padding:3px 10px;">🔒 Bất biến</span></div><div style="font-size:13px;color:var(--text-2,#64748b);margin-top:4px;line-height:1.5;">Bản ghi mọi can thiệp thủ công (nạp/điều chỉnh credit, cấp/thu hồi quỹ tổ chức, ticket) lấy trực tiếp từ sổ giao dịch — ai thực hiện, thay đổi gì, lý do. Dữ liệu thật từ DB, không sửa/xóa.</div></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">${cards}</div>
        <div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:18px 12px 4px;">
          ${head}
          <div style="display:flex;flex-direction:column;">${body}</div>
          ${footer}
        </div>
      </div>`;
    return true;
  }

  // ===== Giao dịch theo tổ chức (org transactions) — REAL data from the org-fund ledger =====
  // Org credit moves are stored as DOUBLE-ENTRY pairs (a debit on one wallet + a matching credit on
  // another at the same instant). We collapse each pair into one logical transaction (quỹ ↔ phòng ban ↔
  // thành viên), plus merge any explicit portal.orgTransactions records — real data, same load pattern.
  function orgTxOrgId(userId) {
    const u = String(userId || "");
    if (u.indexOf("orgfund-") === 0) return u.slice(8);
    if (u.indexOf("orgdept-") === 0) return u.slice(8).replace(/-departments[_-].*$/i, "").replace(/-dept[_-].*$/i, "");
    return "";
  }
  function orgTxName(orgId) {
    if (!orgId) return "—";
    const o = ((state.portal && state.portal.organizations) || []).find((x) => x.id === orgId);
    if (o) return o.name || o.short || orgId;
    return String(orgId).replace(/^org[-_]/i, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim() || orgId;
  }
  function orgTxParty(userId) {
    const u = String(userId || "");
    if (u.indexOf("orgfund-") === 0) return "Quỹ tổ chức";
    if (u.indexOf("orgdept-") === 0) return "Phòng ban";
    if (u.indexOf("member_") === 0 || u.indexOf("member-") === 0) return "Thành viên " + u.replace(/^member[_-]/, "").slice(0, 8);
    return userNameById(userId) || u || "—";
  }
  function orgTxActionLabel(type) {
    const t = String(type || ""); const reclaim = t.indexOf("reclaim") >= 0; const dept = t.indexOf("dept") >= 0;
    if (reclaim) return dept ? "Thu hồi từ phòng ban" : "Thu hồi credit";
    if (t.indexOf("alloc") >= 0) return dept ? "Phân bổ cho phòng ban" : "Phân bổ credit";
    return t;
  }
  function orgTxRows() {
    const src = (state.creditTransactions || []).filter((t) => /^org/.test(String(t.type)))
      .slice().sort((a, b) => (Date.parse(a.createdAt || a.at || "") || 0) - (Date.parse(b.createdAt || b.at || "") || 0));
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[i + 1]; const aAmt = Number(a.amountDelta) || 0;
      const paired = b && a.type === b.type && Math.abs(aAmt) === Math.abs(Number(b.amountDelta) || 0) && Math.sign(aAmt) !== Math.sign(Number(b.amountDelta) || 0);
      if (paired) {
        const neg = aAmt < 0 ? a : b; const pos = aAmt < 0 ? b : a; const type = String(a.type);
        const reclaim = type.indexOf("reclaim") >= 0; const dept = type.indexOf("dept") >= 0;
        const action = reclaim ? (dept ? "Thu hồi từ phòng ban" : "Thu hồi từ thành viên") : (dept ? "Phân bổ cho phòng ban" : "Phân bổ cho thành viên");
        out.push({ txId: String(a.txId || a.id || "").slice(0, 12), orgId: orgTxOrgId(neg.userId) || orgTxOrgId(pos.userId), action,
          counter: reclaim ? orgTxParty(neg.userId) : orgTxParty(pos.userId), amount: Math.abs(aAmt), dir: reclaim ? "in" : "out",
          actor: a.actor || "—", ts: Date.parse(a.createdAt || a.at || "") || 0 });
        i++;
      } else {
        out.push({ txId: String(a.txId || a.id || "").slice(0, 12), orgId: orgTxOrgId(a.userId), action: orgTxActionLabel(a.type),
          counter: orgTxParty(a.userId), amount: Math.abs(aAmt), dir: aAmt < 0 ? "out" : "in", actor: a.actor || "—", ts: Date.parse(a.createdAt || a.at || "") || 0 });
      }
    }
    for (const o of ((state.portal || {}).orgTransactions || [])) {
      const amt = Number(o.amountDelta) || 0;
      out.push({ txId: String(o.id || "").slice(0, 12), orgId: o.orgId || "", action: o.action || "Giao dịch",
        counter: o.target || "—", amount: Math.abs(amt), dir: amt < 0 ? "out" : "in", actor: o.actor || "—", ts: Date.parse(o.createdAt || o.updatedAt || "") || 0 });
    }
    return out.map((r) => ({ ...r, orgName: orgTxName(r.orgId), time: interLogTime(new Date(r.ts).toISOString ? new Date(r.ts).toISOString() : r.ts) })).sort((a, b) => b.ts - a.ts);
  }
  function findOrgTxScreen() {
    return visibleScreens().find((s) => fold(s.getAttribute("data-screen-label")).includes("giao dich theo to chuc")) || null;
  }
  let orgTxPage = 1;
  function mountOrgTxPanel(options = {}) {
    const screen = findOrgTxScreen();
    if (!screen) return false;
    if (typeof (state.summary || {}).users !== "number" && !(state.users || []).length && !(state.creditTransactions || []).length) return false;
    const all = orgTxRows();
    const alloc = all.filter((r) => r.dir === "out").reduce((s, r) => s + r.amount, 0);
    const reclaim = all.filter((r) => r.dir === "in").reduce((s, r) => s + r.amount, 0);
    const orgs = new Set(all.map((r) => r.orgId).filter(Boolean)).size;
    const PAGE = 10;
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    const page = Math.min(Math.max(1, orgTxPage || 1), pages); orgTxPage = page;
    const start = (page - 1) * PAGE; const rows = all.slice(start, start + PAGE);
    const sig = `${all.length}|${alloc}|${reclaim}|${orgs}|${page}|${rows[0] ? rows[0].ts : 0}`;
    if (!options.force && screen.dataset.cxOrgTxSig === sig && screen.querySelector("[data-centrix-orgtx-root]")) return true;
    screen.dataset.cxOrgTxSig = sig;
    const cr = (n) => (Number(n) || 0).toLocaleString("vi-VN");
    const card = (label, value, sub, color) => `<div style="flex:1;min-width:160px;border:1px solid var(--border-soft,#e2e8f0);border-radius:13px;padding:14px 16px;background:var(--surface-2,#f8fafc);"><div style="font:700 10.5px Segoe UI;letter-spacing:.06em;color:var(--label,#94a3b8);text-transform:uppercase;">${escapeHtml(label)}</div><div style="font:700 22px/1.1 Segoe UI;color:${color || "var(--text,#0f172a)"};margin-top:6px;">${value}</div><div style="font-size:11.5px;color:var(--text-3,#94a3b8);margin-top:4px;">${escapeHtml(sub || "")}</div></div>`;
    const cards = card("Tổng giao dịch", cr(all.length), "đã đối soát")
      + card("Đã phân bổ", cr(alloc) + " cr", "quỹ → thành viên / phòng ban", "#b45309")
      + card("Đã thu hồi", cr(reclaim) + " cr", "về quỹ tổ chức", "#15803d")
      + card("Tổ chức", cr(orgs), "có giao dịch");
    const GRID = "grid-template-columns:118px 1.3fr 1.7fr 132px 120px 104px;gap:14px;";
    const head = `<div style="display:grid;${GRID}padding:0 12px 10px;border-bottom:1px solid var(--border-soft,#eef2f7);font:700 11px Segoe UI;letter-spacing:.03em;color:var(--label,#94a3b8);text-transform:uppercase;">`
      + `<span>Giao dịch</span><span>Tổ chức</span><span>Mô tả</span><span>Số credit</span><span>Thời gian</span><span>Trạng thái</span></div>`;
    const rowHtml = (r) => {
      const c = r.dir === "in" ? "#15803d" : "#b45309"; const sign = r.dir === "in" ? "+" : "−";
      return `<div style="display:grid;${GRID}align-items:center;padding:12px;border-bottom:1px solid var(--border-soft,#eef2f7);">`
        + `<span style="font-size:12px;font-weight:600;color:var(--text-2,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.txId || "—")}</span>`
        + `<span style="font-size:13px;font-weight:600;color:var(--text,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.orgName)}</span>`
        + `<div style="min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--text,#0f172a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.action)}</div><div style="font-size:11.5px;color:var(--text-3,#94a3b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.counter)}</div></div>`
        + `<span style="font-size:13.5px;font-weight:800;color:${c};white-space:nowrap;">${sign}${cr(r.amount)} cr</span>`
        + `<span style="font-size:12px;color:var(--text-3,#94a3b8);white-space:nowrap;">${escapeHtml(r.time)}</span>`
        + `<span><span style="font-size:11px;font-weight:700;color:#15803d;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:7px;padding:3px 9px;white-space:nowrap;">Hoàn tất</span></span></div>`;
    };
    const body = rows.length
      ? rows.map(rowHtml).join("")
      : `<div style="text-align:center;padding:48px 20px;color:var(--text-3,#94a3b8);"><div style="font-size:14px;font-weight:600;color:var(--text-2,#64748b);">Chưa có giao dịch tổ chức</div><div style="font-size:13px;margin-top:4px;">Phân bổ / thu hồi credit theo tổ chức sẽ xuất hiện tại đây.</div></div>`;
    const pageBtn = (label, p, disabled, active) => `<button type="button"${disabled ? "" : ` data-centrix-server-action="orgtx-page" data-page="${p}"`}${disabled ? " disabled" : ""} style="min-width:32px;height:32px;border:1px solid ${active ? "var(--brand,#2563eb)" : "var(--border,#e2e8f0)"};border-radius:8px;background:${active ? "var(--brand,#2563eb)" : "var(--surface,#fff)"};color:${active ? "#fff" : "var(--text-2,#64748b)"};font-size:12.5px;font-weight:700;cursor:${disabled ? "default" : "pointer"};opacity:${disabled ? ".4" : "1"};padding:0 9px;">${label}</button>`;
    let lo = Math.max(1, page - 2), hi = Math.min(pages, page + 2);
    if (page <= 3) hi = Math.min(pages, 5);
    if (page >= pages - 2) lo = Math.max(1, pages - 4);
    const nums = []; for (let p = lo; p <= hi; p++) nums.push(pageBtn(String(p), p, false, p === page));
    const footer = `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:14px 14px 8px;border-top:1px solid var(--border-soft,#eef2f7);margin-top:2px;">`
      + `<div style="font-size:12.5px;color:var(--text-3,#94a3b8);">Đang xem <b style="color:var(--text-2,#64748b);">${all.length ? start + 1 : 0}–${start + rows.length}</b> trong <b style="color:var(--text-2,#64748b);">${cr(all.length)}</b> giao dịch</div>`
      + `<div style="display:flex;align-items:center;gap:6px;">${pageBtn("‹", page - 1, page <= 1, false)}${nums.join("")}${pageBtn("›", page + 1, page >= pages, false)}</div>`
      + `</div>`;
    screen.innerHTML = `
      <div data-centrix-orgtx-root="1" style="display:flex;flex-direction:column;gap:18px;">
        <div><div style="font:900 21px Segoe UI;color:var(--text,#0f172a);">Giao dịch theo tổ chức</div><div style="font-size:13px;color:var(--text-2,#64748b);margin-top:4px;line-height:1.5;">Phân bổ &amp; thu hồi credit giữa quỹ tổ chức · phòng ban · thành viên — đối soát trực tiếp từ sổ giao dịch. Dữ liệu thật từ DB.</div></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">${cards}</div>
        <div style="background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:18px 12px 4px;">
          ${head}
          <div style="display:flex;flex-direction:column;">${body}</div>
          ${footer}
        </div>
      </div>`;
    return true;
  }

  // Ẩn nút CHAT NỔI (FAB) mặc định của SPA ở góc phải-dưới (data-dc-tpl="2035" / .scpn) — không cần thiết.
  // Dùng CSS (bền, tự áp lại mọi re-render). KHÔNG đụng toast #centrix-support-notify (khác id/class hoàn toàn).
  function installHideChatFabStyle() {
    if (document.getElementById("centrix-hide-chat-fab")) return;
    const s = document.createElement("style");
    s.id = "centrix-hide-chat-fab";
    s.textContent = '.scpn,[data-dc-tpl="2035"]{display:none !important;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function boot() {
    if (boot.done) return;
    boot.done = true;
    mountLoadingVeil(); // cover the static demo UI at the earliest possible moment
    installTypographySystem();
    installHideChatFabStyle(); // ẩn nút chat nổi (FAB) không cần thiết
    installBrandIdentity(); // tiêu đề tab + favicon = logo CentriX
    applyStoredServerTheme();
    installServerThemeObserver();
    for (const delayMs of [300, 900, 1800]) {
      setTimeout(() => applyStoredServerTheme(), delayMs);
    }
    installSharedBodyObserver(); // ONE rAF-coalesced body observer feeding all panel + window-control ticks
    registerBodyTick(ensureAccountLockButton); // stamp + label the user-drawer "Khóa/Mở tài khoản" button
    registerBodyTick(ensureTopupButton); // relabel "+ Nạp N credit" → "Nạp credit" (custom-amount modal)
    registerBodyTick(ensureAssignPlanButton); // inject the user-drawer "Nạp gói" button (plan picker → assign)
    registerBodyTick(mountLegacyToggle); // "Người dùng CentriX" filter toggle on the Users&Credit page
    registerBodyTick(mountUserRecentActivity); // replace the drawer's baked "Hoạt động gần đây" sample with real tx
    scheduleWindowControlWiring();
    registerServerMenuEvents();
    scheduleConnectPanel();
    scheduleServicesApiPanel();
    scheduleModelApiPanel();
    scheduleActivityApiPanel();
    scheduleServiceBrowserPanel();
    scheduleSupportPanel();
    scheduleOrgPanel();
    scheduleCreditPackagePanel();
    schedulePromoPanel();
    scheduleSubscriptionPlanPanel();
    registerBodyTick(mountRolesPanel);
    registerBodyTick(mountMyAccountPanel); // "Tài khoản của tôi" trên màn Cài đặt
    registerBodyTick(installBrandIdentity); // giữ tiêu đề + favicon CentriX nếu SPA ghi đè
    registerBodyTick(applyStaffVisibility);
    document.addEventListener("click", onNavClickSyncUrl, true); // capture: runs before the row's own onclick(setState)
    window.addEventListener("popstate", onPopStateSyncPage);
    registerBodyTick(initRouteOnce); // once nav rows exist, open the page named in the URL
    registerBodyTick(mountDashboardStats);
    registerBodyTick(mountAnalyticsStats);
    registerBodyTick(mountPaymentsPanel);
    registerBodyTick(mountInterventionPanel);
    registerBodyTick(mountInterventionLogPanel);
    registerBodyTick(mountOrgTxPanel);
    refresh(); // load real data ASAP — no 800ms window where the demo UI is visible
    setInterval(refreshModelDataIfVisible, 5000);
    setInterval(refreshLoginStatusIfVisible, 6000); // per-service login dots while the loader login tab is open
    setInterval(refreshSupportChatIfVisible, 1500); // near-live poll while the Chat tab is open (guarded against overlap)
    setInterval(pollSupportNotify, 15000); // phát hiện tin khách chưa trả lời ở MỌI màn → toast góc phải
    setInterval(refreshActivityDataIfVisible, 5000);
    setInterval(() => { if (!document.hidden) refresh(); }, 30000); // skip the 7-endpoint fetch + mounts while minimized/hidden
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); }); // refresh on return so data is never stale
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
