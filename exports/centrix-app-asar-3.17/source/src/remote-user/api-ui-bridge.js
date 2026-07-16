(function () {
  if (window.__centrixUserApiUiBridgeLoaded) return;
  window.__centrixUserApiUiBridgeLoaded = true;

  // Harden the DOM against "Failed to execute 'insertBefore'/'removeChild': ... not a child of this node"
  // crashes thrown by the generated React design's reconciler when our bridge DOM-patches (Orders/Invoices
  // row replaces, Devices/Support card injections) mutate nodes React still references. Fall back
  // gracefully (append / no-op) instead of throwing so a concurrent re-render never white-screens the app.
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

  const SERVICE_CACHE_KEY = "centrixUserLiveServices";
  const URL_HISTORY_KEY = "centrixUserUrlHistory";
  const CREDIT_CACHE_KEY = "centrixUserCreditCache";
  const SAVED_LOGIN_KEY = "centrixUserSavedLogin"; // {email} of the last successful login (when "remember" is on). The password is NEVER stored.
  const REMEMBER_LOGIN_KEY = "centrixUserRememberLogin"; // "1"/"0"
  // Sample credentials the generated design bakes into the login inputs — never treat these as a real
  // account; they are only placeholders to override with the saved/typed login.
  const LOGIN_SAMPLE_VALUES = new Set(["trxuanloc.28@gmail.com", "centrix"]);
  const SERVICE_BACKGROUND_LOADING_TEXT = "\u0110ang chu\u1ea9n b\u1ecb d\u1ecbch v\u1ee5, vui l\u00f2ng \u0111\u1ee3i\u2026";
  const SERVICE_LOADING_MIN_VISIBLE_MS = 280;

  const state = {
    ok: false,
    loginOk: false,
    loggedOut: false, // set true by an explicit logout so refresh() can't flip the screen back to the app
    loginIntent: false, // true ONLY after the user presses the login button this session; gates the flip to the app screen so a still-alive/stale connection can't auto-login
    updatedAt: "",
    services: loadServiceCache(),
    servicesSource: "cache",
    urlHistory: [],
    urlTimeFilter: "", // "" = use the design default; set by the date dropdown (today/7d/30d/90d/12m/all)
    loginDraft: { email: "", password: "" }, // current intended login (saved last-login or what the user is typing)
    portal: null,
    account: loadCreditCache(), // warm balance from last session so the UI shows the real number, not 320, on load
    lastCreditUsage: null,
    usageHistoryPage: 0, // current page (0-indexed) of the "Lịch sử sử dụng" list (5 rows/page)
    actions: {
      pending: "",
      last: null,
      error: ""
    },
    browser: {
      activeServiceId: "",
      activeServiceName: "",
      opening: false,
      error: ""
    }
  };

  let boundsFrame = 0;
  let chromeFrame = 0;
  let windowDrag = null;
  let menuEventsRegistered = false;
  let lastSentBrowserBounds = null;
  // Locked card-body bounds. The native view is anchored to the service card body — the SAME React
  // element for every service. Measuring it once and reusing it for every switch / opening↔running
  // transition keeps the native view at an IDENTICAL rect, which is what removes the tab-switch jank
  // (the view no longer re-measures to a slightly different rect each switch). Invalidated only on
  // window resize / sidebar collapse.
  let stableServiceBounds = null;
  let layoutResizeObserver = null;
  let patchedStaticLogic = null;
  let pendingPredictedBrowserBounds = null;
  let lastStableLayoutMarkAt = 0;
  let openServiceSerial = 0;
  let staticDemoRecovery = { id: "", at: 0 };

  function api() {
    return window.centrixLocalUser || null;
  }

  // ── VERSION-LOCK overlay ─────────────────────────────────────────────────────────────────────────
  // A full-screen, un-dismissable "kill switch" screen shown when the server marks this App User version as
  // blocked / too-old / below-forced-latest. The main process has ALREADY torn down every service tab and
  // blocks opening more + all server traffic, so this overlay is the visible half of a real freeze — not a
  // toast the user can click past. It lifts by itself (main sends "version:unlock") when the admin un-blocks.
  function vlEsc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function vlReasonText(reason) {
    if (reason === "blocked") return "Phiên bản này đã bị quản trị viên khoá do phát hiện lỗi hoặc lý do an toàn.";
    if (reason === "below-min") return "Phiên bản này đã quá cũ và không còn được hỗ trợ.";
    if (reason === "force-latest") return "Đã có bản cập nhật bắt buộc. Vui lòng cài đặt bản mới nhất để tiếp tục.";
    return "Phiên bản này hiện không được phép sử dụng.";
  }
  // Shared keyframes + button hover styles for BOTH the version-lock and account-lock overlays.
  function ensureLockStyle() {
    if (document.getElementById("centrix-version-lock-style")) return;
    const st = document.createElement("style");
    st.id = "centrix-version-lock-style";
    st.textContent = `
      @keyframes cxvlFade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes cxvlPop { from { opacity: 0; transform: translateY(14px) scale(.965) } to { opacity: 1; transform: none } }
      @keyframes cxvlPulse { 0%,100% { opacity: .35; transform: scale(.85) } 50% { opacity: 1; transform: scale(1) } }
      @keyframes cxupdSlide { 0% { transform: translateX(-130%) } 100% { transform: translateX(320%) } }
      #centrix-version-lock .cxvl-btn, #centrix-account-lock .cxvl-btn { transition: filter .15s ease, transform .1s ease, background .15s ease, border-color .15s ease }
      #centrix-version-lock .cxvl-btn:hover, #centrix-account-lock .cxvl-btn:hover { filter: brightness(1.08) }
      #centrix-version-lock .cxvl-btn:active, #centrix-account-lock .cxvl-btn:active { transform: translateY(1px) }
    `;
    (document.head || document.documentElement).appendChild(st);
  }
  function removeVersionLockOverlay() {
    document.getElementById("centrix-version-lock")?.remove();
  }
  function showVersionLockOverlay(payload = {}) {
    ensureLockStyle();
    const reason = vlReasonText(payload.reason);
    const cur = payload.appVersion ? `v${vlEsc(payload.appVersion)}` : "";
    const latest = payload.latestVersion ? vlEsc(payload.latestVersion) : "";
    const notes = payload.notes ? vlEsc(payload.notes) : "";

    const overlay = document.createElement("div");
    overlay.id = "centrix-version-lock";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647",
      "display:flex", "align-items:center", "justify-content:center", "padding:24px",
      "background:radial-gradient(120% 120% at 50% 0%, rgba(30,41,59,.78), rgba(8,12,24,.86))",
      "-webkit-backdrop-filter:blur(9px) saturate(120%)", "backdrop-filter:blur(9px) saturate(120%)",
      "animation:cxvlFade .18s ease both",
      "font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif"
    ].join(";");

    const curChip = cur ? `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);color:#aab2c8;font-size:12.5px;font-weight:600">Đang dùng ${cur}</span>` : "";
    const latestChip = latest ? `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;background:linear-gradient(135deg,rgba(59,130,246,.20),rgba(37,99,235,.20));border:1px solid rgba(59,130,246,.45);color:#93c5fd;font-size:12.5px;font-weight:700">Mới nhất v${latest}</span>` : "";
    const notesBox = notes ? `
      <div style="margin-top:16px;text-align:left;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px 14px">
        <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#7c869e;font-weight:700;margin-bottom:5px">Thông báo từ quản trị viên</div>
        <div style="font-size:13.5px;line-height:1.55;color:#dbe1f0;white-space:pre-wrap">${notes}</div>
      </div>` : "";

    overlay.innerHTML = `
      <div style="width:min(460px,calc(100vw - 40px));background:linear-gradient(165deg,#161d31,#0d1220);border:1px solid rgba(255,255,255,.09);border-radius:24px;box-shadow:0 34px 90px rgba(0,0,0,.6);padding:32px 30px 26px;text-align:center;animation:cxvlPop .28s cubic-bezier(.2,.9,.3,1) both">
        <div style="width:76px;height:76px;margin:0 auto 18px;border-radius:22px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff7a45,#f43f5e);box-shadow:0 14px 34px rgba(244,63,94,.42)">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="10.5" width="16" height="10" rx="2.4"></rect>
            <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>
            <circle cx="12" cy="15.4" r="1.4" fill="#fff" stroke="none"></circle>
          </svg>
        </div>
        <div style="font-size:21px;font-weight:800;color:#fff;letter-spacing:-.01em">Đã tạm khoá phiên bản này</div>
        <div style="margin-top:9px;font-size:14.5px;line-height:1.6;color:#aab2c8">${vlEsc(reason)}</div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${curChip}${latestChip}</div>
        ${notesBox}
        <div style="margin-top:22px;display:flex;gap:10px">
          <button type="button" data-cx-vl="download" class="cxvl-btn" style="flex:1;padding:13px 16px;border:none;border-radius:13px;cursor:pointer;font-size:14.5px;font-weight:700;color:#fff;background:linear-gradient(135deg,#3b82f6,#2563eb);box-shadow:0 10px 24px rgba(37,99,235,.4)">Tải bản mới</button>
          <button type="button" data-cx-vl="quit" class="cxvl-btn" style="padding:13px 20px;border:1px solid rgba(255,255,255,.18);border-radius:13px;cursor:pointer;font-size:14.5px;font-weight:600;color:#cdd4e6;background:transparent">Thoát</button>
        </div>
        <div style="margin-top:16px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:12.5px;color:#7c869e">
          <span style="width:8px;height:8px;border-radius:999px;background:#22c55e;animation:cxvlPulse 1.4s ease-in-out infinite"></span>
          <span>Ứng dụng sẽ tự mở lại ngay khi được cấp phép</span>
        </div>
      </div>`;

    overlay.addEventListener("click", (e) => {
      const act = e.target?.closest?.("[data-cx-vl]")?.getAttribute?.("data-cx-vl");
      if (!act) return;
      const bridge = api();
      if (act === "download") { try { bridge?.version?.download?.(); } catch {} }
      else if (act === "quit") { try { bridge?.version?.quit?.(); } catch {} }
    });
    (document.body || document.documentElement).appendChild(overlay);
  }

  // ── IN-APP UPDATE dialogs (non-forced "update available" + download progress) ─────────────────────
  function removeUpdateModal() { document.getElementById("centrix-update-modal")?.remove(); }
  function updateModalRoot() {
    let el = document.getElementById("centrix-update-modal");
    if (el) return el;
    ensureLockStyle();
    el = document.createElement("div");
    el.id = "centrix-update-modal";
    el.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483646",
      "display:flex", "align-items:center", "justify-content:center", "padding:24px",
      "background:rgba(8,12,24,.55)", "-webkit-backdrop-filter:blur(6px)", "backdrop-filter:blur(6px)",
      "animation:cxvlFade .18s ease both", "font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif"
    ].join(";");
    el.addEventListener("click", (e) => {
      const act = e.target?.closest?.("[data-cx-upd]")?.getAttribute?.("data-cx-upd");
      if (!act) return;
      const bridge = api();
      if (act === "install") { try { bridge?.update?.install?.(); } catch {} showUpdateProgress({ percent: 0, phase: "download" }); }
      else if (act === "skip") { try { bridge?.update?.skip?.(); } catch {} removeUpdateModal(); }
      else if (act === "later" || act === "close") { removeUpdateModal(); }
      else if (act === "cancel") { try { bridge?.update?.cancel?.(); } catch {} removeUpdateModal(); }
    });
    el.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-cx-upd") === "auto") { try { api()?.update?.setAuto?.(!!t.checked); } catch {} }
    });
    (document.body || document.documentElement).appendChild(el);
    return el;
  }
  function updCard(inner) {
    return `<div style="width:min(540px,calc(100vw - 40px));background:linear-gradient(165deg,#161d31,#0d1220);border:1px solid rgba(255,255,255,.09);border-radius:22px;box-shadow:0 34px 90px rgba(0,0,0,.6);padding:26px 26px 22px;animation:cxvlPop .26s cubic-bezier(.2,.9,.3,1) both">${inner}</div>`;
  }
  function updHeader(title) {
    return `<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <div style="width:46px;height:46px;border-radius:13px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#3b82f6,#2563eb);box-shadow:0 10px 24px rgba(37,99,235,.42)">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path></svg>
      </div>
      <div style="font-size:18px;font-weight:800;color:#fff;letter-spacing:-.01em">${vlEsc(title)}</div>
    </div>`;
  }
  function showUpdateAvailableDialog(info = {}) {
    const el = updateModalRoot();
    const cur = vlEsc(info.currentVersion || "");
    const latest = vlEsc(info.version || "");
    const notes = info.notes ? vlEsc(info.notes) : "";
    const notesBox = `<div style="text-align:left;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px 14px;max-height:200px;overflow:auto">
        <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#7c869e;font-weight:700;margin-bottom:6px">Có gì mới</div>
        <div style="font-size:13.5px;line-height:1.55;color:#dbe1f0;white-space:pre-wrap">${notes || "Bản cập nhật mới với cải thiện ổn định và sửa lỗi."}</div>
      </div>`;
    el.innerHTML = updCard(`
      ${updHeader("Cập nhật phần mềm")}
      <div style="font-size:15.5px;font-weight:700;color:#fff;margin-bottom:4px">Đã có phiên bản CentriX mới!</div>
      <div style="font-size:13.5px;color:#aab2c8;margin-bottom:14px">CentriX <b style="color:#93c5fd">${latest}</b> đã sẵn sàng${cur ? ` — bạn đang dùng ${cur}` : ""}. Bạn có muốn cập nhật ngay?</div>
      ${notesBox}
      <label style="display:flex;align-items:center;gap:9px;margin-top:16px;font-size:13px;color:#aab2c8;cursor:pointer;user-select:none">
        <input type="checkbox" data-cx-upd="auto" style="width:16px;height:16px;cursor:pointer">Tự động tải & cài bản cập nhật lần sau
      </label>
      <div style="margin-top:18px;display:flex;gap:10px;justify-content:flex-end">
        <button type="button" data-cx-upd="skip" class="cxvl-btn" style="padding:11px 15px;border:1px solid rgba(255,255,255,.16);border-radius:12px;cursor:pointer;font-size:13.5px;font-weight:600;color:#cdd4e6;background:transparent">Bỏ qua bản này</button>
        <button type="button" data-cx-upd="later" class="cxvl-btn" style="padding:11px 15px;border:1px solid rgba(255,255,255,.16);border-radius:12px;cursor:pointer;font-size:13.5px;font-weight:600;color:#cdd4e6;background:transparent">Để sau</button>
        <button type="button" data-cx-upd="install" class="cxvl-btn" style="padding:11px 20px;border:none;border-radius:12px;cursor:pointer;font-size:14px;font-weight:700;color:#fff;background:linear-gradient(135deg,#3b82f6,#2563eb);box-shadow:0 10px 24px rgba(37,99,235,.4)">Cài đặt ngay</button>
      </div>`);
  }
  function showUpdateProgress(p = {}) {
    const el = updateModalRoot();
    const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
    const mb = (n) => (Number(n) > 0 ? (Number(n) / 1048576).toFixed(1) + " MB" : "");
    const title = p.phase === "verify" ? "Đang kiểm tra…" : p.phase === "launch" ? "Sắp cài đặt…" : "Đang tải bản cập nhật…";
    const sub = p.phase === "verify" ? "Đang kiểm tra bản cập nhật…"
      : p.phase === "launch" ? "Đang mở trình cài đặt…"
      : (p.received ? `${mb(p.received)} / ${mb(p.total)}` : "Đang chuẩn bị…");
    const showCancel = p.phase !== "verify" && p.phase !== "launch";
    // Build the card ONCE; every subsequent tick only patches the bar width + text nodes — NO innerHTML
    // rebuild, so the CSS width transition animates smoothly instead of the whole popup re-laying-out (jitter).
    let bar = el.querySelector("#cxupd-bar");
    if (!bar) {
      el.innerHTML = updCard(`
        ${updHeader("Đang cập nhật CentriX")}
        <div id="cxupd-title" style="font-size:14.5px;font-weight:700;color:#fff;margin-bottom:12px"></div>
        <div style="height:12px;border-radius:999px;background:rgba(255,255,255,.09);overflow:hidden">
          <div id="cxupd-bar" style="height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#3b82f6,#60a5fa);transition:width .3s cubic-bezier(.33,1,.68,1);will-change:width"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:9px;font-size:12.5px;color:#7c869e">
          <span id="cxupd-sub"></span><span id="cxupd-pct" style="font-variant-numeric:tabular-nums"></span>
        </div>
        <div id="cxupd-cancelrow" style="margin-top:18px;display:flex;justify-content:flex-end">
          <button type="button" data-cx-upd="cancel" class="cxvl-btn" style="padding:10px 18px;border:1px solid rgba(255,255,255,.16);border-radius:12px;cursor:pointer;font-size:13.5px;font-weight:600;color:#cdd4e6;background:transparent">Huỷ</button>
        </div>`);
      bar = el.querySelector("#cxupd-bar");
    }
    if (bar) bar.style.width = pct + "%";
    const t = el.querySelector("#cxupd-title"); if (t) t.textContent = title;
    const s = el.querySelector("#cxupd-sub"); if (s) s.textContent = sub;
    const pc = el.querySelector("#cxupd-pct"); if (pc) pc.textContent = pct + "%";
    const cr = el.querySelector("#cxupd-cancelrow"); if (cr) cr.style.display = showCancel ? "flex" : "none";
  }
  function showUpdateLaunched() {
    const el = updateModalRoot();
    el.innerHTML = updCard(`
      ${updHeader("Bản cập nhật đã sẵn sàng")}
      <div style="font-size:14px;line-height:1.6;color:#dbe1f0">Trình cài đặt đã mở. Hãy làm theo hướng dẫn để hoàn tất — ứng dụng sẽ tự đóng và mở lại phiên bản mới.</div>
      <div style="margin-top:18px;display:flex;justify-content:flex-end"><button type="button" data-cx-upd="close" class="cxvl-btn" style="padding:10px 20px;border:none;border-radius:12px;cursor:pointer;font-size:14px;font-weight:700;color:#fff;background:linear-gradient(135deg,#3b82f6,#2563eb)">Đã hiểu</button></div>`);
  }
  // Silent install: the app is about to close itself + relaunch — show a "closing & restarting" notice with an
  // indeterminate bar (no button; the window disappears in ~1.8s and reopens on the new version).
  function showUpdateInstalling(version) {
    const el = updateModalRoot();
    el.innerHTML = updCard(`
      ${updHeader("Đã tải xong bản cập nhật" + (version ? " " + version : ""))}
      <div style="font-size:14.5px;line-height:1.65;color:#dbe1f0;text-align:center;padding:4px 4px 2px">
        Vui lòng <b style="color:#fff">TẮT ứng dụng rồi MỞ LẠI</b> để hoàn tất cập nhật.<br>
        <span style="color:#7c869e;font-size:13px">Đóng app → đợi vài giây → mở lại từ biểu tượng.</span>
      </div>
      <button id="cxupd-quit" type="button" style="margin-top:16px;width:100%;height:42px;border:0;border-radius:10px;background:linear-gradient(90deg,#3b82f6,#60a5fa);color:#fff;font:600 14px Segoe UI;cursor:pointer">Tắt ứng dụng ngay</button>`);
    const btn = document.getElementById("cxupd-quit");
    if (btn) btn.addEventListener("click", () => { try { api()?.version?.quit(); } catch { /* ignore */ } });
  }
  function showUpdateError(reason) {
    const el = updateModalRoot();
    const msg = reason === "verify-failed" ? "Bản tải về không hợp lệ (kiểm tra toàn vẹn thất bại). Vui lòng thử lại."
      : reason === "cancelled" ? "Đã huỷ tải bản cập nhật."
      : "Không tải được bản cập nhật. Kiểm tra kết nối và thử lại.";
    el.innerHTML = updCard(`
      ${updHeader("Cập nhật không thành công")}
      <div style="font-size:14px;line-height:1.6;color:#dbe1f0">${vlEsc(msg)}</div>
      <div style="margin-top:18px;display:flex;gap:10px;justify-content:flex-end">
        <button type="button" data-cx-upd="close" class="cxvl-btn" style="padding:10px 16px;border:1px solid rgba(255,255,255,.16);border-radius:12px;cursor:pointer;font-size:13.5px;font-weight:600;color:#cdd4e6;background:transparent">Đóng</button>
        ${reason !== "cancelled" ? `<button type="button" data-cx-upd="install" class="cxvl-btn" style="padding:10px 18px;border:none;border-radius:12px;cursor:pointer;font-size:14px;font-weight:700;color:#fff;background:linear-gradient(135deg,#3b82f6,#2563eb)">Thử lại</button>` : ""}
      </div>`);
  }

  // ── Dynamic app-version label (the design template bakes a stale "Desktop Version · v3.6.0"; replace it
  // with the REAL APP_VERSION from main so it never shows a wrong number again) ──────────────────────────
  let _realAppVersion = "";
  async function ensureAppVersion() {
    if (_realAppVersion) return _realAppVersion;
    try { const r = await api()?.version?.current?.(); if (r && r.version) _realAppVersion = String(r.version); } catch { /* ignore */ }
    return _realAppVersion;
  }
  function patchDesktopVersion() {
    const v = _realAppVersion;
    if (!v) return;
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length !== 0) continue;
      const t = (el.textContent || "").trim();
      // a standalone version chip, optionally prefixed by "Desktop Version ·" — safe to rewrite (prices are
      // "123.000đ", not "3.6.0", so this never touches money/history).
      const m = t.match(/^(Desktop Version\s*[·|\-–]\s*)?v?(\d+\.\d+\.\d+)$/i);
      if (m && m[2] !== v) el.textContent = (m[1] || "") + "v" + v;
    }
  }
  async function refreshDesktopVersion() {
    await ensureAppVersion();
    patchDesktopVersion();
    for (const d of [400, 1200, 3000]) setTimeout(patchDesktopVersion, d); // catch late-mounting header
  }

  // ── ACCOUNT-LOCK overlay ─────────────────────────────────────────────────────────────────────────
  // Full-screen, un-dismissable freeze shown when an admin locks THIS account. The main process has
  // already torn down every service tab + blocked all traffic; this is the visible half of the freeze.
  // Buttons: "Đăng xuất" (back to the login screen — the session is dead) and "Thoát" (quit the app).
  // It lifts by itself when the admin unlocks (main sends "account:unlock" then routes to the login screen).
  function removeAccountLockOverlay() {
    document.getElementById("centrix-account-lock")?.remove();
  }
  function showAccountLockOverlay(payload = {}) {
    if (document.getElementById("centrix-account-lock")) return; // already up
    if (!document.getElementById("centrix-version-lock-style")) {
      // reuse the version-lock keyframes/button styles if they weren't injected yet
      showVersionLockOverlay.__ensureStyle?.();
    }
    const msg = vlEsc(payload.message || "Tài khoản của bạn đã bị khóa. Vui lòng liên hệ quản trị viên.");
    const overlay = document.createElement("div");
    overlay.id = "centrix-account-lock";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647",
      "display:flex", "align-items:center", "justify-content:center", "padding:24px",
      "background:radial-gradient(120% 120% at 50% 0%, rgba(30,41,59,.78), rgba(8,12,24,.86))",
      "-webkit-backdrop-filter:blur(9px) saturate(120%)", "backdrop-filter:blur(9px) saturate(120%)",
      "animation:cxvlFade .18s ease both",
      "font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif"
    ].join(";");
    overlay.innerHTML = `
      <div style="width:min(460px,calc(100vw - 40px));background:linear-gradient(165deg,#161d31,#0d1220);border:1px solid rgba(255,255,255,.09);border-radius:24px;box-shadow:0 34px 90px rgba(0,0,0,.6);padding:32px 30px 26px;text-align:center;animation:cxvlPop .28s cubic-bezier(.2,.9,.3,1) both">
        <div style="width:76px;height:76px;margin:0 auto 18px;border-radius:22px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#ff7a45,#f43f5e);box-shadow:0 14px 34px rgba(244,63,94,.42)">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="10.5" width="16" height="10" rx="2.4"></rect>
            <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>
            <circle cx="12" cy="15.4" r="1.4" fill="#fff" stroke="none"></circle>
          </svg>
        </div>
        <div style="font-size:21px;font-weight:800;color:#fff;letter-spacing:-.01em">Tài khoản đã bị khoá</div>
        <div style="margin-top:9px;font-size:14.5px;line-height:1.6;color:#aab2c8">${msg}</div>
        <div style="margin-top:22px;display:flex;gap:10px">
          <button type="button" data-cx-al="logout" class="cxvl-btn" style="flex:1;padding:13px 16px;border:none;border-radius:13px;cursor:pointer;font-size:14.5px;font-weight:700;color:#fff;background:linear-gradient(135deg,#3b82f6,#2563eb);box-shadow:0 10px 24px rgba(37,99,235,.4)">Đăng xuất</button>
          <button type="button" data-cx-al="quit" class="cxvl-btn" style="padding:13px 20px;border:1px solid rgba(255,255,255,.18);border-radius:13px;cursor:pointer;font-size:14.5px;font-weight:600;color:#cdd4e6;background:transparent">Thoát</button>
        </div>
        <div style="margin-top:16px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:12.5px;color:#7c869e">
          <span style="width:8px;height:8px;border-radius:999px;background:#22c55e;animation:cxvlPulse 1.4s ease-in-out infinite"></span>
          <span>Sẽ tự trở về màn đăng nhập khi được mở khoá</span>
        </div>
      </div>`;
    overlay.addEventListener("click", (e) => {
      const act = e.target?.closest?.("[data-cx-al]")?.getAttribute?.("data-cx-al");
      if (!act) return;
      const bridge = api();
      // REAL logout (not just closing the popup): flip to the login screen + run the secure disconnect
      // (self-revoke this user's session server-side + wipe the borrowed RAM cookies + close every tab +
      // lift the freeze). No residual access is left behind.
      if (act === "logout") { try { removeAccountLockOverlay(); performLogoutTeardown({ force: true }); } catch {} }
      else if (act === "quit") { try { bridge?.version?.quit?.(); } catch {} }
    });
    (document.body || document.documentElement).appendChild(overlay);
  }

  function fold(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanTemplateValue(value) {
    const text = String(value || "").trim();
    return /\{\{.*\}\}/.test(text) ? "" : text;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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

  function normalizeServiceRows(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map((service) => {
        const id = String(service?.id || "").trim();
        const name = String(service?.name || id || "").trim();
        const url = cleanUrl(service?.url || service?.loginUrl || "");
        if (!id || !name || !url || service?.enabled === false) return null;
        return {
          ...service,
          id,
          name,
          url,
          loginUrl: cleanUrl(service?.loginUrl || url) || url,
          enabled: true
        };
      })
      .filter(Boolean);
  }

  function loadServiceCache() {
    try {
      return normalizeServiceRows(JSON.parse(localStorage.getItem(SERVICE_CACHE_KEY) || "[]"));
    } catch {
      return [];
    }
  }

  function saveServiceCache(rows) {
    const cleanRows = normalizeServiceRows(rows);
    if (!cleanRows.length) return cleanRows;
    try {
      localStorage.setItem(SERVICE_CACHE_KEY, JSON.stringify(cleanRows.slice(0, 80)));
    } catch {
      // Renderer cache is only a UI fallback; the server API stays authoritative.
    }
    return cleanRows;
  }

  // Cache the last real wallet so the UI can paint the true balance the INSTANT it loads, instead of
  // briefly flashing the template seed (320) until /api/me returns. The server stays authoritative —
  // this is just a warm starting value that refresh() overwrites with the live figure moments later.
  // The email of the account currently being shown (the one the user authenticated as). Most reliable
  // source — /api/me carries no email, so this is what gates the per-account caches.
  function activeAccountEmail() {
    const acc = state.account || {};
    return String(acc.email || acc.account?.email || (state.loginDraft && state.loginDraft.email) || "").trim().toLowerCase();
  }
  function loadCreditCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CREDIT_CACHE_KEY) || "null");
      if (!cached || !Number.isFinite(Number(cached.balance))) return null;
      // HARD account gate: never paint a cache that belongs to a DIFFERENT account than the one being
      // shown. Without this, logging into account B falls back to account A's cached wallet/identity on
      // any refresh hiccup (the reported "login user2 → see maskbranket2049" bug).
      const want = activeAccountEmail();
      const have = String(cached.email || "").trim().toLowerCase();
      if (want && have !== want) return null; // active account known, but cache is for a different/untagged account
      const wantUid = String((state.account || {}).userId || "").trim();
      const haveUid = String(cached.userId || "").trim();
      if (wantUid && haveUid && wantUid !== haveUid) return null;
      return { ...cached, ok: true, fromCache: true };
    } catch {
      // ignore corrupt cache
    }
    return null;
  }

  function saveCreditCache(account) {
    if (!account || !Number.isFinite(Number(account.balance))) return;
    try {
      localStorage.setItem(CREDIT_CACHE_KEY, JSON.stringify({
        balance: Number(account.balance),
        spentToday: Number(account.spentToday) || 0,
        spentThisMonth: Number(account.spentThisMonth) || 0,
        lifetimeAdded: Number(account.lifetimeAdded) || 0,
        lifetimeSpent: Number(account.lifetimeSpent) || 0,
        recentTransactions: Array.isArray(account.recentTransactions) ? account.recentTransactions.slice(0, 14) : [],
        recentHistory: Array.isArray(account.recentHistory) ? account.recentHistory.slice(0, 40) : [],
        userId: account.userId || "",
        email: activeAccountEmail(), // tag the cache with its owner so loadCreditCache can reject a mismatch
        at: Date.now()
      }));
    } catch {
      // best-effort
    }
  }

  // The credit/service/url caches in localStorage are GLOBAL (not per-account) and `state` is seeded from
  // them at module load — so without an explicit wipe, switching from account A to account B shows A's
  // cached wallet/services/history (briefly, or persistently if a refresh request hiccups). Clear both the
  // localStorage caches and the in-memory account-scoped state on every login + logout to fully isolate.
  function clearAccountCaches() {
    for (const k of [CREDIT_CACHE_KEY, SERVICE_CACHE_KEY, URL_HISTORY_KEY]) {
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    }
  }
  // Wipe the DEVICE-LOCAL per-email data for a deleted account (the 3 per-email maps clearAccountCaches does
  // NOT touch) so re-logging in with the SAME Google email starts as a truly clean new account — no old name/
  // phone/theme reattaches. Keys: ACCOUNT_EDIT_KEY (name/phone), ACCOUNT_PHONE_KEY (legacy), USER_THEME_KEY.
  function wipeAccountLocalData(email) {
    const key = String(email || "").trim();
    for (const storeKey of [ACCOUNT_EDIT_KEY, ACCOUNT_PHONE_KEY, USER_THEME_KEY]) {
      try {
        const map = JSON.parse(localStorage.getItem(storeKey) || "{}");
        if (map && typeof map === "object" && key && (key in map)) { delete map[key]; localStorage.setItem(storeKey, JSON.stringify(map)); }
      } catch { /* ignore */ }
    }
    try { localStorage.removeItem(SAVED_LOGIN_KEY); } catch { /* ignore */ }
  }
  // Self-service HARD delete (App User account tab). Type-to-confirm (email, else "XÓA"), then call the backend
  // self-delete. On success: wipe device-local per-email data + full logout teardown + reload → the login
  // screen. Re-logging in with the same Google email creates a brand-new empty account (server auto-create).
  function promptDeleteAccount() {
    const id = accountIdentity();
    const email = String(id?.email || "").trim();
    const phrase = email || "XÓA";
    showConfirm(
      "Toàn bộ tài khoản và dữ liệu (credit, lịch sử, đơn hàng, cấu hình…) sẽ bị xóa vĩnh viễn và KHÔNG thể khôi phục. Gõ " + (email ? "email của bạn" : '"XÓA"') + " để xác nhận.",
      () => {
        const bridge = api();
        if (!bridge?.portal?.deleteAccount) { showActionToast("Chưa sẵn sàng xóa tài khoản", "error"); return; }
        showActionToast("Đang xóa tài khoản…", "ok");
        bridge.portal.deleteAccount({})
          .then(async (r) => {
            if (r && r.ok !== false) {
              try { wipeAccountLocalData(email); } catch { /* ignore */ }
              try { await performLogoutTeardown({ force: true }); } catch { /* ignore */ }
              try { location.reload(); } catch { /* ignore */ }
            } else if (r && r.code === "ORG_OWNER") {
              showActionToast("Bạn đang là chủ tổ chức — hãy giải tán hoặc chuyển quyền tổ chức trước khi xóa tài khoản", "error");
            } else {
              showActionToast((r && r.error) || "Xóa tài khoản thất bại", "error");
            }
          })
          .catch((e) => showActionToast(e?.message || "Lỗi xóa tài khoản", "error"));
      },
      { title: "Xóa tài khoản vĩnh viễn", ok: "Xóa vĩnh viễn", cancel: "Hủy", danger: true, requireText: phrase, requirePlaceholder: email ? "Nhập email của bạn" : "Gõ XÓA" }
    );
  }
  function resetAccountScopedState() {
    state.account = null;
    state.portal = null;
    state.portalReady = false; // org UI stays hidden until a FRESH portal fetch confirms it for this account
    state.services = [];
    state.orgStructure = null;
    state.urlHistory = [];
    state.usageHistoryPage = 0; // back to page 1 of usage history for the new account
    state.supportPage = 0; // and page 1 of the "Yêu cầu của tôi" ticket list
    uh2Page = 1; uh2Class = "all"; uh2Search = ""; uh2Time = "all"; uh2MenuOpen = false; // "Lịch sử sử dụng" V2 filters
    clearAccountCaches();
  }

  function setLiveServices(rows, source = "api") {
    const cleanRows = normalizeServiceRows(rows);
    if (cleanRows.length) {
      state.services = cleanRows;
      state.servicesSource = source;
      saveServiceCache(cleanRows);
      return cleanRows;
    }

    if (source === "api") {
      const cached = state.services.length ? normalizeServiceRows(state.services) : loadServiceCache();
      if (cached.length) {
        state.services = cached;
        state.servicesSource = "cache";
        return cached;
      }
      state.services = [];
      state.servicesSource = source;
      return [];
    }

    const cached = state.services.length ? normalizeServiceRows(state.services) : loadServiceCache();
    if (cached.length) {
      state.services = cached;
      state.servicesSource = "cache";
      return cached;
    }

    state.services = [];
    state.servicesSource = source;
    return [];
  }

  function serviceNameForId(serviceId, fallback = "") {
    const service = serviceById(serviceId);
    return String(service?.name || fallback || serviceId || "").trim();
  }

  function applyBrowserStateSnapshot(payload = {}, options = {}) {
    const source = options.source || "browser-state-sync";
    const activeServiceId = String(payload?.activeServiceId || payload?.serviceId || "").trim();
    const openIds = Array.isArray(payload?.openServiceIds)
      ? payload.openServiceIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const hasActiveBrowser = Boolean(activeServiceId);
    const isHomeState = !hasActiveBrowser && (!openIds.length || payload?.blank === true || payload?.url === "about:blank");
    const lastState = {
      ...(state.browser.lastState || {}),
      ...(payload || {}),
      source
    };

    if (
      state.browser.opening === true &&
      state.browser.activeServiceId &&
      (!activeServiceId || activeServiceId !== state.browser.activeServiceId)
    ) {
      state.browser = {
        ...(state.browser || {}),
        lastState,
        error: payload?.lastError || payload?.error || state.browser.error || ""
      };
      publishState();
      ensureBrowserControl();
      return state.browser;
    }

    if (isHomeState) {
      state.browser = {
        activeServiceId: "",
        activeServiceName: "",
        pendingServiceId: "",
        pendingServiceName: "",
        opening: false,
        error: payload?.lastError || payload?.error || "",
        lastState
      };
      publishState();
      ensureBadge();
      ensureBrowserControl();
      return state.browser;
    }

    if (!hasActiveBrowser) {
      state.browser = {
        ...(state.browser || {}),
        lastState,
        error: payload?.lastError || payload?.error || state.browser.error || ""
      };
      publishState();
      ensureBrowserControl();
      return state.browser;
    }

    state.browser = {
      ...(state.browser || {}),
      activeServiceId,
      activeServiceName: serviceNameForId(activeServiceId, payload?.serviceName),
      pendingServiceId: "",
      pendingServiceName: "",
      opening: false,
      error: payload?.lastError || payload?.error || "",
      lastState
    };
    clearStaticRunningPlaceholder();
    publishState();
    ensureBadge();
    ensureBrowserControl();
    markStableServiceLayout(true);
    return state.browser;
  }

  function applyBrowserPrepareSnapshot(payload = {}) {
    const serviceId = String(payload?.serviceId || payload?.activeServiceId || "").trim();
    if (!serviceId) return state.browser;
    const service = serviceById(serviceId) || {
      id: serviceId,
      name: serviceNameForId(serviceId, payload?.serviceName) || "Dich vu",
      url: ""
    };
    state.browser = {
      ...(state.browser || {}),
      activeServiceId: serviceId,
      activeServiceName: service.name || payload?.serviceName || serviceId,
      pendingServiceId: serviceId,
      pendingServiceName: service.name || payload?.serviceName || serviceId,
      opening: true,
      error: "",
      prepare: {
        status: payload?.status || "",
        message: payload?.message || "",
        at: Date.now()
      },
      lastState: {
        ...(state.browser.lastState || {}),
        serviceId,
        serviceName: service.name || payload?.serviceName || serviceId,
        source: "browser-prepare"
      }
    };
    showStaticBrowserService(service, true);
    publishState();
    ensureBadge();
    ensureBrowserControl();
    markStableServiceLayout(true);
    return state.browser;
  }

  async function syncBrowserStateFromMain(bridge = api()) {
    if (!bridge?.browser?.state) return null;
    const snapshot = await bridge.browser.state();
    if (snapshot && typeof snapshot === "object") {
      return applyBrowserStateSnapshot(snapshot, { source: "browser-state-sync" });
    }
    return null;
  }

  function hostFromUrl(value) {
    try {
      return new URL(String(value || "")).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  }

  function serviceInitial(name) {
    const clean = String(name || "").trim();
    return (clean[0] || "?").toUpperCase();
  }

  function cleanIconUrl(value) {
    const raw = cleanTemplateValue(value);
    if (!raw) return "";
    try {
      const parsed = new URL(raw, window.location.href);
      return /^https?:$/i.test(parsed.protocol) ? parsed.toString() : "";
    } catch {
      return "";
    }
  }

  function cssUrl(value) {
    return String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/"/g, "%22")
      .replace(/'/g, "%27")
      .replace(/\n|\r/g, "");
  }

  function iconBackground(iconUrl, fallbackBg) {
    const clean = cleanIconUrl(iconUrl);
    if (!clean) return fallbackBg;
    return `#fff url(${cssUrl(clean)}) center / 72% 72% no-repeat`;
  }

  const SERVICE_BRAND_META = {
    chatgpt: { initial: "G", bg: "#10a37f" },
    claude: { initial: "C", bg: "#d97757" },
    gemini: { initial: "G", bg: "#1a73e8" },
    perplexity: { initial: "P", bg: "#20b8cd" },
    copilot: { initial: "C", bg: "#0a7ed9" },
    grok: { initial: "X", bg: "#111111" },
    deepseek: { initial: "D", bg: "#4d6bfe" },
    mistral: { initial: "M", bg: "#fa520f" },
    midjourney: { initial: "M", bg: "#4b4ef0" },
    poe: { initial: "P", bg: "#5a4ee0" },
    notebooklm: { initial: "N", bg: "#1a73e8" },
    elevenlabs: { initial: "E", bg: "#7c3aed" }
  };

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

  function serviceMeta(service, fallbackName = "") {
    const key = fold(`${service?.id || ""} ${service?.name || fallbackName}`);
    const known = Object.entries(SERVICE_BRAND_META)
      .find(([name]) => key.includes(name))?.[1];
    const fallbackBg = service?.bg || service?.color || service?.brandColor || known?.bg || "#1e93f5";
    const iconUrl = cleanIconUrl(service?.iconUrl || service?.logoUrl || service?.favicon || service?.icon);
    return {
      initial: iconUrl ? "" : (service?.initial || known?.initial || serviceInitial(service?.name || fallbackName)),
      bg: iconBackground(iconUrl, fallbackBg),
      iconUrl
    };
  }

  function serviceHosts(service) {
    const values = [
      service?.url,
      service?.loginUrl,
      service?.homeUrl,
      service?.host,
      service?.domain,
      ...(Array.isArray(service?.domains) ? service.domains : []),
      ...(Array.isArray(service?.cookieDomains) ? service.cookieDomains : [])
    ];
    return Array.from(new Set(values.map(hostFromUrl).filter(Boolean)));
  }

  function hostMatches(recordHost, serviceHost) {
    if (!recordHost || !serviceHost) return false;
    return recordHost === serviceHost || recordHost.endsWith(`.${serviceHost}`) || serviceHost.endsWith(`.${recordHost}`);
  }

  function serviceFromUrl(url, serviceId = "", serviceName = "") {
    const services = servicesByName();
    const cleanId = String(serviceId || "").toLowerCase();
    const cleanName = fold(serviceName);
    const byId = cleanId ? services.find((service) => String(service.id || "").toLowerCase() === cleanId) : null;
    if (byId) return byId;

    const byName = cleanName ? services.find((service) => fold(service.name) === cleanName) : null;
    if (byName) return byName;

    const host = hostFromUrl(url);
    return services.find((service) => serviceHosts(service).some((serviceHost) => hostMatches(host, serviceHost))) || null;
  }

  function displayNameFromHost(host) {
    if (!host) return "Dich vu";
    const known = Object.entries(HOST_SERVICE_NAMES)
      .find(([serviceHost]) => hostMatches(host, serviceHost))?.[1];
    if (known) return known;
    const compact = host.replace(/^chat\./, "").split(".")[0] || host;
    return compact.charAt(0).toUpperCase() + compact.slice(1);
  }

  function detailsObject(details) {
    if (!details || typeof details !== "string") return details && typeof details === "object" ? details : {};
    try {
      return JSON.parse(details);
    } catch {
      return {};
    }
  }

  function formatUrlTime(at) {
    const stamp = Number(at || 0);
    const date = stamp ? new Date(stamp) : new Date();
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const time = date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    const diffDays = Math.max(0, Math.round((startToday - startThatDay) / 86400000));
    if (diffDays === 0) return `Hôm nay ${time}`;
    if (diffDays === 1) return `Hôm qua ${time}`;
    return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")} ${time}`;
  }

  function dayOffsetFromAt(at) {
    const stamp = Number(at || 0);
    if (!stamp) return 99;
    const date = new Date(stamp);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return Math.max(0, Math.floor((startToday - startThatDay) / 86400000));
  }

  // Normalize a URL to origin+path (no query/hash, no trailing slash) for homepage comparison.
  function stripUrlForHomepage(value) {
    try {
      const u = new URL(value);
      return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase();
    } catch {
      return String(value || "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
    }
  }

  // The "Nhật ký sử dụng" should list real sessions (e.g. a ChatGPT conversation), NOT the service's
  // landing/home page. Treat a URL as a homepage when it's the bare site root (no path) or exactly the
  // service's configured home/login URL — those carry no per-chat path and are just the entry screen.
  function isHomepageHistoryUrl(url, service) {
    try {
      const path = new URL(url).pathname.replace(/\/+$/, "");
      if (path === "") return true; // bare root, e.g. https://chatgpt.com/
    } catch {
      // fall through to base-URL comparison
    }
    const norm = stripUrlForHomepage(url);
    for (const base of [service?.url, service?.loginUrl]) {
      if (base && stripUrlForHomepage(base) === norm) return true;
    }
    return false;
  }

  // A usage-history row is only meaningful when its REAL page/chat title was captured. A blank title,
  // or a title that is just the service name (the fallback used when the page title can't be read, e.g.
  // "ChatGPT"), means no per-session title exists — such a row must NOT enter the usage log.
  function isRealHistoryTitle(title, ...serviceNames) {
    const key = fold(String(title || "").trim());
    if (!key) return false;
    return !serviceNames.some((name) => name && fold(String(name)) === key);
  }

  function normalizeUrlHistoryItem(input = {}) {
    const details = detailsObject(input.details);
    const url = cleanUrl(input.url || input.href || details.url || details.href);
    if (!url) return null;
    const at = Date.parse(input.createdAt || input.lastSeenAt || input.updatedAt || input.at || "") || Number(input.at || 0) || Date.now();
    const serviceId = input.serviceId || details.serviceId || "";
    const serviceName = input.serviceName || details.serviceName || "";
    const service = serviceFromUrl(url, serviceId, serviceName);
    if (isHomepageHistoryUrl(url, service)) return null; // skip service home/landing pages
    const host = hostFromUrl(url);
    const displayName = service?.name || serviceName || displayNameFromHost(host);
    // Drop rows without a real captured title (empty, or just the service name). Runs on record AND on
    // load, so untitled rows are never stored/pushed/shown and old service-name-only rows disappear.
    // A real title that arrives later still gets logged via updateHistoryTitleForActiveUrl.
    const rawTitle = String(input.title || details.title || "").trim();
    if (!isRealHistoryTitle(rawTitle, displayName, serviceName, service?.name, service?.id, serviceId)) {
      return null;
    }
    const meta = serviceMeta(service, displayName);
    return {
      id: `${service?.id || serviceId || host}|${url}`,
      serviceId: service?.id || serviceId || "",
      serviceName: displayName,
      title: rawTitle,
      action: input.action || details.action || "",
      url,
      host,
      at,
      time: formatUrlTime(at),
      initial: meta.initial,
      bg: meta.bg
    };
  }

  function saveLocalUrlHistory() {
    try {
      localStorage.setItem(URL_HISTORY_KEY, JSON.stringify((state.urlHistory || []).slice(0, 80)));
    } catch {
      // Ignore storage failures; the DB activity API remains the source of truth.
    }
  }

  function loadLocalUrlHistory() {
    try {
      const rows = JSON.parse(localStorage.getItem(URL_HISTORY_KEY) || "[]");
      state.urlHistory = Array.isArray(rows) ? rows.map(normalizeUrlHistoryItem).filter(Boolean).slice(0, 80) : [];
    } catch {
      state.urlHistory = [];
    }
  }

  function setUrlHistory(rows = [], options = {}) {
    const merged = [...rows, ...(options.merge === false ? [] : state.urlHistory || [])]
      .map(normalizeUrlHistoryItem)
      .filter(Boolean)
      .sort((a, b) => b.at - a.at);
    const seen = new Set();
    state.urlHistory = merged.filter((row) => {
      const key = row.id || row.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 80);
    saveLocalUrlHistory();
    publishState();
  }

  // Push usage history to the DEDICATED per-user server store (survives restart + device changes).
  let urlHistoryPushQueue = [];
  let urlHistoryPushTimer = 0;
  function queueUrlHistoryPush(row) {
    if (!row?.url) return;
    urlHistoryPushQueue.push({
      url: row.url,
      title: row.title || "",
      serviceId: row.serviceId || "",
      serviceName: row.serviceName || "",
      host: row.host || "",
      at: row.at || Date.now()
    });
    clearTimeout(urlHistoryPushTimer);
    urlHistoryPushTimer = setTimeout(flushUrlHistoryPush, 1200);
  }
  function flushUrlHistoryPush() {
    const bridge = api();
    if (!bridge?.urlHistory?.push || !urlHistoryPushQueue.length) return;
    const items = urlHistoryPushQueue.splice(0, urlHistoryPushQueue.length);
    Promise.resolve(bridge.urlHistory.push({ items })).catch(() => {});
  }
  async function loadServerUrlHistory() {
    const bridge = api();
    if (!bridge?.urlHistory?.list) return;
    const result = await bridge.urlHistory.list({ limit: 300 }).catch(() => null);
    const rows = Array.isArray(result?.urlHistory) ? result.urlHistory : [];
    if (!rows.length) return;
    setUrlHistory(rows, { merge: true });
    refreshStaticUrlLogSoon();
  }

  // One-time-per-session backfill: history recorded before the durable server store existed (or while
  // the connection was down) lives only in client localStorage — recordUrlHistory only pushes NEW
  // items as they happen, never the existing set. Upload the whole local set once on connect so it
  // persists per-userId and survives restart / device changes. The server upserts by url (newest at
  // wins, per-user cap 300), so re-sending is idempotent and never duplicates or evicts other users.
  let urlHistoryBackfilled = false;
  async function backfillUrlHistoryToServer() {
    if (urlHistoryBackfilled) return;
    const bridge = api();
    if (!bridge?.urlHistory?.push) return;
    const items = (state.urlHistory || [])
      .slice(0, 100)
      .map((row) => ({
        url: row.url,
        title: row.title || "",
        serviceId: row.serviceId || "",
        serviceName: row.serviceName || "",
        host: row.host || "",
        at: row.at || Date.now()
      }))
      .filter((row) => row.url);
    if (!items.length) {
      urlHistoryBackfilled = true;
      return;
    }
    const result = await bridge.urlHistory.push({ items }).catch(() => null);
    if (result?.ok) urlHistoryBackfilled = true;
  }

  function recordUrlHistory(input = {}) {
    const row = normalizeUrlHistoryItem(input);
    if (!row) return;
    setUrlHistory([row]);
    queueUrlHistoryPush(row);
    refreshStaticUrlLogSoon();
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

  function installTypographySystem() {
    if (document.getElementById("centrix-user-typography-system")) return;
    const style = document.createElement("style");
    style.id = "centrix-user-typography-system";
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
    `;
    document.head.appendChild(style);
  }

  function installStableServiceLayout() {
    if (document.getElementById("centrix-user-stable-service-layout")) return;
    const style = document.createElement("style");
    style.id = "centrix-user-stable-service-layout";
    style.textContent = `
      html,
      body {
        width: 100% !important;
        height: 100% !important;
        margin: 0 !important;
        overflow: hidden !important;
        background: #eef1f5 !important;
      }
      body > div[style*="position:fixed"][style*="inset:0"] {
        width: 100vw !important;
        height: 100vh !important;
        overflow: hidden !important;
      }
      [data-centrix-app-body="1"] {
        display: flex !important;
        flex: 1 1 auto !important;
        width: 100% !important;
        height: calc(100vh - 50px) !important;
        min-width: 0 !important;
        min-height: 0 !important;
        overflow: hidden !important;
        background: #eef1f5 !important;
      }
      [data-centrix-user-sidebar="1"] {
        width: 330px !important;
        min-width: 330px !important;
        max-width: 330px !important;
        flex: 0 0 330px !important;
        height: 100% !important;
        min-height: 0 !important;
        overflow: hidden !important;
        background: #ffffff !important;
        border-right: 1px solid #e6e9ee !important;
      }
      [data-centrix-main-workbench="1"] {
        display: flex !important;
        flex: 1 1 auto !important;
        width: auto !important;
        height: 100% !important;
        min-width: 0 !important;
        min-height: 0 !important;
        padding: 24px !important;
        overflow: hidden !important;
        background: #eef1f5 !important;
      }
      [data-centrix-browser-card="1"],
      [data-centrix-browser-surface="1"] {
        width: 100% !important;
        height: 100% !important;
        flex: 1 1 auto !important;
        min-width: 360px !important;
        min-height: 320px !important;
        max-width: none !important;
        max-height: none !important;
        display: flex !important;
        flex-direction: column !important;
        box-sizing: border-box !important;
        border-radius: 14px !important;
        overflow: hidden !important;
        background: #ffffff !important;
      }
      [data-centrix-browser-viewport="1"] {
        width: 100% !important;
        height: 100% !important;
        flex: 1 1 auto !important;
        min-width: 0 !important;
        min-height: 0 !important;
        overflow: hidden !important;
        border-bottom-left-radius: 14px !important;
        border-bottom-right-radius: 14px !important;
      }
      [data-centrix-user-sidebar="1"] [style*="overflow-y:auto"],
      [data-centrix-user-sidebar="1"] [style*="overflow:auto"],
      [data-centrix-browser-viewport="1"] [style*="overflow-y:auto"],
      [data-centrix-browser-viewport="1"] [style*="overflow:auto"] {
        scrollbar-gutter: stable !important;
        overscroll-behavior: contain !important;
      }
      @media (max-width: 1180px) {
        [data-centrix-user-sidebar="1"] {
          width: 300px !important;
          min-width: 300px !important;
          max-width: 300px !important;
          flex-basis: 300px !important;
        }
        [data-centrix-main-workbench="1"] {
          padding: 16px !important;
        }
      }
      @media (max-width: 860px) {
        [data-centrix-user-sidebar="1"] {
          width: 280px !important;
          min-width: 280px !important;
          max-width: 280px !important;
          flex-basis: 280px !important;
        }
        [data-centrix-main-workbench="1"] {
          padding: 12px !important;
        }
      }
      [data-centrix-service-row="1"] {
        min-height: 64px !important;
        height: 64px !important;
        max-height: 64px !important;
        box-sizing: border-box !important;
        align-items: center !important;
        overflow: hidden !important;
        contain: layout paint !important;
      }
      [data-centrix-service-row="1"] :where(button,[role="button"],a),
      [data-centrix-service-open-button="1"],
      [data-centrix-service-status="1"] {
        width: 92px !important;
        min-width: 92px !important;
        max-width: 92px !important;
        height: 32px !important;
        min-height: 32px !important;
        box-sizing: border-box !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        flex: 0 0 92px !important;
      }
      [data-centrix-service-row="1"] :where(img,svg,[data-centrix-service-icon="1"]) {
        width: 32px !important;
        min-width: 32px !important;
        height: 32px !important;
        min-height: 32px !important;
        flex: 0 0 32px !important;
      }
      [data-centrix-browser-surface="1"] {
        min-width: 360px !important;
        min-height: 320px !important;
        contain: layout paint !important;
        overflow: hidden !important;
      }
    `;
    document.head.appendChild(style);
  }

  function markStableServiceLayout(force = false) {
    if (!state.loginOk || !state.services.length || !document.body) return;
    const now = Date.now();
    if (!force && now - lastStableLayoutMarkAt < 900) return;
    lastStableLayoutMarkAt = now;
    markAppLayoutRegions();
    const services = servicesByName();
    for (const element of Array.from(document.querySelectorAll("button,div,span,a"))) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      const text = fold(element.textContent || "");
      if (!text) continue;

      const matchedService = services.find((service) => text.includes(fold(service.name)));
      if (!matchedService) continue;

      const looksLikeServiceRow =
        rect.width >= 150 &&
        rect.width <= 420 &&
        rect.height >= 44 &&
        rect.height <= 110 &&
        (text.includes("mo") || text.includes("dang mo") || text.includes("dang chay") || text.includes(hostFromUrl(matchedService.url)));

      if (looksLikeServiceRow) {
        element.dataset.centrixServiceRow = "1";
        const openControl = Array.from(element.querySelectorAll("button,[role='button'],a,span,div"))
          .find((child) => {
            const childText = fold(child.textContent || "");
            return childText === "mo" || childText.includes("dang mo") || childText.includes("dang chay") || childText === "open";
          });
        if (openControl) openControl.dataset.centrixServiceOpenButton = "1";
      }
    }

    if (state.browser.activeServiceId) {
      const bounds = measureBrowserBounds();
      const candidates = Array.from(document.querySelectorAll("div,main,section"))
        .map((el) => ({ el, rect: visibleRect(el) }))
        .filter(({ rect }) => rect && Math.abs(rect.left - bounds.x) <= 8 && Math.abs(rect.top - bounds.y) <= 8);
      candidates[0]?.el?.setAttribute("data-centrix-browser-surface", "1");
    }
  }

  function markAppLayoutRegions() {
    const items = allLayoutRects();
    const topChromeBottom = findTopChromeBottom(items);
    const sidebar = findNativeSidebar(items, topChromeBottom);
    if (sidebar?.el) {
      sidebar.el.dataset.centrixUserSidebar = "1";
      const body = Array.from(document.querySelectorAll("div,main,section"))
        .map((el) => ({ el, rect: visibleRect(el) }))
        .filter(({ rect }) => (
          rect &&
          rect.left <= 4 &&
          Math.abs(rect.top - topChromeBottom) <= 8 &&
          rect.width >= window.innerWidth - 12 &&
          rect.height >= window.innerHeight - topChromeBottom - 12
        ))
        .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
      if (body?.el) body.el.dataset.centrixAppBody = "1";
    }

    const sidebarRight = Math.round(sidebar?.rect.right || 330);
    const main = Array.from(document.querySelectorAll("div,main,section"))
      .map((el) => ({ el, rect: visibleRect(el), text: fold(el.textContent || "") }))
      .filter(({ rect, text }) => (
        rect &&
        rect.left >= sidebarRight - 8 &&
        rect.top >= topChromeBottom - 8 &&
        rect.right <= window.innerWidth + 4 &&
        rect.bottom <= window.innerHeight + 4 &&
        rect.width >= Math.max(360, window.innerWidth - sidebarRight - 56) &&
        rect.height >= Math.max(320, window.innerHeight - topChromeBottom - 56) &&
        (text.includes("dang theo doi credit") || text.includes("webview") || text.includes("request") || text.includes("tong quan"))
      ))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
    if (main?.el) main.el.dataset.centrixMainWorkbench = "1";

    const activeName = fold(state.browser.activeServiceName || "");
    const runningCard = Array.from(document.querySelectorAll("div,main,section"))
      .map((el) => {
        const children = Array.from(el.children || []);
        const toolbar = children[0] || null;
        const viewport = children[1] || null;
        return {
          el,
          toolbar,
          viewport,
          rect: visibleRect(el),
          text: fold(el.textContent || ""),
          style: el.getAttribute("style") || "",
          toolbarText: fold(toolbar?.textContent || ""),
          toolbarStyle: toolbar?.getAttribute?.("style") || "",
          viewportText: fold(viewport?.textContent || ""),
          viewportStyle: viewport?.getAttribute?.("style") || ""
        };
      })
      .filter(({ rect, text, style, toolbarText, toolbarStyle, viewportText, viewportStyle }) => (
        rect &&
        rect.left >= sidebarRight - 8 &&
        rect.top >= topChromeBottom + 8 &&
        rect.right <= window.innerWidth + 4 &&
        rect.bottom <= window.innerHeight + 4 &&
        rect.width >= 360 &&
        rect.height >= 320 &&
        style.includes("border-radius:14px") &&
        style.includes("overflow:hidden") &&
        (
          toolbarText.includes("dang theo doi credit") ||
          toolbarText.includes("so du") ||
          toolbarText.includes("lui") ||
          toolbarStyle.includes("justify-content:space-between")
        ) &&
        (
          viewportStyle.includes("repeating-linear-gradient") ||
          viewportStyle.includes("flex:1") ||
          viewportText.includes("webview")
        ) &&
        (
          text.includes("webview") ||
          (activeName && (text.includes(activeName) || viewportText.includes(activeName)))
        )
      ))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];

    const card = runningCard || Array.from(document.querySelectorAll("div,main,section"))
      .map((el) => ({ el, rect: visibleRect(el), text: fold(el.textContent || ""), style: el.getAttribute("style") || "" }))
      .filter(({ rect, text, style }) => (
        rect &&
        rect.left >= sidebarRight - 8 &&
        rect.top >= topChromeBottom + 8 &&
        rect.right <= window.innerWidth + 4 &&
        rect.bottom <= window.innerHeight + 4 &&
        rect.width >= 360 &&
        rect.height >= 320 &&
        style.includes("border-radius:14px") &&
        (
          text.includes("dang theo doi credit") ||
          text.includes("webview") ||
          (activeName && text.includes(activeName))
        )
      ))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
    if (!card?.el) return;
    card.el.dataset.centrixBrowserCard = "1";
    card.el.dataset.centrixBrowserSurface = "1";
    const directChildren = Array.from(card.el.children || []);
    if (directChildren[0]) directChildren[0].dataset.centrixBrowserToolbar = "1";

    const cardRect = card.rect;
    const directViewport = directChildren[1]
      ? {
          el: directChildren[1],
          rect: visibleRect(directChildren[1]),
          style: directChildren[1].getAttribute("style") || ""
        }
      : null;
    const viewport = (
      directViewport?.rect &&
      directViewport.rect.left >= cardRect.left - 2 &&
      directViewport.rect.right <= cardRect.right + 2 &&
      directViewport.rect.top >= cardRect.top - 2 &&
      directViewport.rect.bottom <= cardRect.bottom + 2 &&
      directViewport.rect.width >= cardRect.width - 12 &&
      directViewport.rect.height >= Math.max(280, cardRect.height - 120)
    )
      ? directViewport
      : Array.from(card.el.querySelectorAll("div,main,section"))
      .map((el) => ({ el, rect: visibleRect(el), style: el.getAttribute("style") || "" }))
      .filter(({ rect, style }) => (
        rect &&
        rect.left >= cardRect.left - 2 &&
        rect.right <= cardRect.right + 2 &&
        rect.top >= cardRect.top - 2 &&
        rect.bottom <= cardRect.bottom + 2 &&
        rect.width >= cardRect.width - 12 &&
        rect.height >= Math.max(280, cardRect.height - 120) &&
        (style.includes("repeating-linear-gradient") || style.includes("flex:1"))
      ))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
    if (viewport?.el) viewport.el.dataset.centrixBrowserViewport = "1";
  }

  function ensureWindowChromeStyle() {
    if (document.getElementById("centrix-user-window-chrome-style")) return;
    const style = document.createElement("style");
    style.id = "centrix-user-window-chrome-style";
    style.textContent = `
      [data-centrix-window-drag="1"] {
        app-region: no-drag;
        -webkit-app-region: no-drag;
        user-select: none;
      }
      [data-centrix-window-no-drag="1"],
      [data-centrix-window-action] {
        app-region: no-drag;
        -webkit-app-region: no-drag;
      }
      [data-centrix-window-action] {
        cursor: pointer;
      }
      [data-centrix-browser-nav-action] {
        width: 34px;
        min-width: 34px;
        height: 34px;
        border: 0;
        border-radius: 9px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: #64748b;
        cursor: pointer;
        font: 800 16px/1 "Segoe UI Symbol","Segoe UI",system-ui,sans-serif;
        transition: background .16s ease, color .16s ease, box-shadow .16s ease, opacity .16s ease;
      }
      [data-centrix-browser-nav-group] {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        height: 42px;
        padding: 4px;
        border-radius: 13px;
        background: rgba(255,255,255,.78);
        border: 1px solid rgba(226,232,240,.96);
        box-shadow: 0 8px 18px rgba(15,23,42,.055);
        backdrop-filter: blur(8px);
      }
      [data-centrix-browser-nav-action]:not([aria-disabled="true"]):hover {
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 5px 12px rgba(15,23,42,.08);
      }
      [data-centrix-browser-nav-action][aria-disabled="true"] {
        opacity: .36;
        cursor: default;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
  }

  function topChromeBars() {
    return Array.from(document.querySelectorAll("body div"))
      .filter((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        const text = fold(element.textContent || "");
        return (
          rect.top <= 2 &&
          rect.left <= 2 &&
          rect.height >= 42 &&
          rect.height <= 58 &&
          rect.width >= window.innerWidth * 0.75 &&
          text.includes("file") &&
          text.includes("window") &&
          text.includes("help")
        );
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })
      .slice(0, 1);
  }

  function markNoDrag(element) {
    if (!element) return;
    element.dataset.centrixWindowNoDrag = "1";
    element.style.setProperty("app-region", "no-drag");
    element.style.setProperty("-webkit-app-region", "no-drag");
  }

  function markTopbarInteractiveRegions(bar) {
    const interactive = Array.from(bar.querySelectorAll("button,input,textarea,select,a,label,[onclick]"));
    interactive.forEach(markNoDrag);

    const controls = Array.from(bar.querySelectorAll("div"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          visible(element) &&
          rect.right >= window.innerWidth - 116 &&
          rect.top >= 0 &&
          rect.top <= 10 &&
          rect.width >= 24 &&
          rect.width <= 42 &&
          rect.height >= 24 &&
          rect.height <= 38
        );
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .slice(-3);

    const actions = ["minimize", "maximize", "close"];
    controls.forEach((element, index) => {
      const action = actions[index];
      if (!action) return;
      element.dataset.centrixWindowAction = action;
      element.title = action === "minimize" ? "Minimize" : action === "maximize" ? "Maximize / Restore" : "Close";
      markNoDrag(element);
    });
  }

  function enhanceWindowChrome() {
    ensureWindowChromeStyle();
    for (const bar of topChromeBars()) {
      bar.dataset.centrixWindowDrag = "1";
      bar.style.setProperty("app-region", "no-drag");
      bar.style.setProperty("-webkit-app-region", "no-drag");
      markTopbarInteractiveRegions(bar);
    }
  }

  function enhanceWindowChromeSoon() {
    cancelAnimationFrame(chromeFrame);
    chromeFrame = requestAnimationFrame(enhanceWindowChrome);
  }

  async function runWindowAction(action) {
    const bridge = api();
    if (!bridge?.win) return;
    if (action === "minimize") await bridge.win.minimize();
    if (action === "maximize") {
      await bridge.win.maximize();
      setTimeout(enhanceWindowChromeSoon, 80);
    }
    if (action === "close") await bridge.win.close();
  }

  function isWindowDragTarget(target) {
    return Boolean(
      target?.closest?.("[data-centrix-window-drag='1']") &&
      !target.closest("[data-centrix-window-no-drag='1'],[data-centrix-window-action],button,input,textarea,select,a,label")
    );
  }

  function moveWindowBy(dx, dy) {
    const bridge = api();
    if (!bridge?.win?.moveBy || (!dx && !dy)) return;
    bridge.win.moveBy({ dx, dy }).catch(() => {});
  }

  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || !isWindowDragTarget(event.target)) return;
    windowDrag = {
      screenX: event.screenX,
      screenY: event.screenY,
      moved: false
    };
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener("mousemove", (event) => {
    if (!windowDrag) return;
    const dx = Math.round(event.screenX - windowDrag.screenX);
    const dy = Math.round(event.screenY - windowDrag.screenY);
    if (dx || dy) {
      windowDrag.screenX = event.screenX;
      windowDrag.screenY = event.screenY;
      windowDrag.moved = true;
      moveWindowBy(dx, dy);
    }
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener("mouseup", (event) => {
    if (!windowDrag) return;
    windowDrag = null;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  function bodyLines() {
    return (document.body?.innerText || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function valueAfterLabel(label) {
    const folded = fold(label);
    const lines = bodyLines();
    const index = lines.findIndex((line) => fold(line) === folded);
    return index >= 0 ? lines[index + 1] || "" : "";
  }

  function numberFromText(value) {
    const digits = String(value || "").replace(/[^\d]/g, "");
    return digits ? Number(digits) : 0;
  }

  function firstVisibleInput(match) {
    return Array.from(document.querySelectorAll("input,textarea,select"))
      .find((input) => visible(input) && match(input));
  }

  function showActionToast(message, kind = "ok") {
    let toast = document.getElementById("centrix-user-api-action-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "centrix-user-api-action-toast";
      toast.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:86px",
        "z-index:2147483647",
        "transform:translateX(-50%)",
        "min-height:34px",
        "max-width:min(520px,calc(100vw - 28px))",
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

  // In-app styled confirm dialog (replaces the ugly native window.confirm titled with the Electron app name).
  // onConfirm runs only when the user presses the OK button. Consistent with the app's toast styling.
  function showConfirm(message, onConfirm, opts = {}) {
    document.getElementById("centrix-user-confirm")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "centrix-user-confirm";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);font-family:Segoe UI,system-ui,sans-serif;";
    // opts.requireText: a "type-to-confirm" gate for irreversible actions — OK stays disabled until the typed
    // value matches (trimmed, case-insensitive). No requireText → normal confirm.
    const need = opts.requireText != null ? String(opts.requireText) : "";
    const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();
    const inputHtml = need
      ? '<input data-cx-confirm-input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' + escapeHtml(opts.requirePlaceholder || need) + '" style="width:100%;box-sizing:border-box;margin-top:14px;height:40px;padding:0 12px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--surface,#fff);color:var(--text,#0f172a);font:600 13px Segoe UI;outline:none;" />'
      : "";
    overlay.innerHTML =
      '<div role="dialog" style="width:404px;max-width:calc(100vw - 32px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.38);padding:22px 22px 18px;">'
      + '<div style="font-size:15.5px;font-weight:700;color:var(--text,#0f172a);margin-bottom:9px;">' + escapeHtml(opts.title || "Xác nhận") + '</div>'
      + '<div style="font-size:13px;color:var(--text-2,#475569);line-height:1.6;">' + escapeHtml(message) + '</div>'
      + inputHtml
      + '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;">'
      + '<button type="button" data-cx-confirm="cancel" style="height:38px;padding:0 16px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:var(--surface,#fff);color:var(--text-2,#475569);font:600 13px Segoe UI;cursor:pointer;">' + escapeHtml(opts.cancel || "Hủy") + '</button>'
      + '<button type="button" data-cx-confirm="ok"' + (need ? " disabled" : "") + ' style="height:38px;padding:0 18px;border:0;border-radius:9px;background:' + (opts.danger ? "var(--danger,#dc2626)" : "var(--brand,#2563eb)") + ';color:#fff;font:700 13px Segoe UI;cursor:pointer;' + (need ? "opacity:.5;pointer-events:none;" : "") + '">' + escapeHtml(opts.ok || "Xác nhận") + '</button>'
      + '</div></div>';
    if (need) {
      overlay.addEventListener("input", (e) => {
        const inp = e.target && e.target.closest ? e.target.closest("[data-cx-confirm-input]") : null;
        if (!inp) return;
        const okBtn = overlay.querySelector('[data-cx-confirm="ok"]');
        const match = norm(inp.value) === norm(need);
        if (okBtn) { okBtn.disabled = !match; okBtn.style.opacity = match ? "1" : ".5"; okBtn.style.pointerEvents = match ? "auto" : "none"; }
      });
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) { overlay.remove(); return; } // click backdrop = cancel
      const b = e.target && e.target.closest ? e.target.closest("[data-cx-confirm]") : null;
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const isOk = b.getAttribute("data-cx-confirm") === "ok";
      if (isOk && need) {
        const inp = overlay.querySelector("[data-cx-confirm-input]");
        if (norm(inp && inp.value) !== norm(need)) return; // guard: OK only fires when the phrase matches
      }
      overlay.remove();
      if (isOk) { try { onConfirm && onConfirm(); } catch (_) {} }
    });
    document.body.appendChild(overlay);
    if (need) { const inp = overlay.querySelector("[data-cx-confirm-input]"); if (inp) setTimeout(() => { try { inp.focus(); } catch (_) { /* ignore */ } }, 30); }
  }

  // ── Legal documents (login screen "Chính sách bảo mật" / "Điều khoản dịch vụ") ──────────────────────
  // The login screen shows the two phrases as brand-coloured <span>s inside the "Tôi đồng ý" label. Clicking
  // either opens a polished, scrollable, theme-aware modal with the full document. Styling uses the app's CSS
  // vars (with fallbacks) so it matches the active Sáng/Tối theme; grids collapse on narrow widths; the table
  // scrolls horizontally inside its own box so the page body never overflows.
  const CX_LEGAL_STYLE = `
    #cx-doc-modal{position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);padding:20px;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;}
    #cx-doc-modal .cx-doc-card{display:flex;flex-direction:column;width:min(760px,96vw);max-height:88vh;background:var(--surface,#fff);color:var(--text,#0f172a);border:1px solid var(--border,#e2e8f0);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.45);overflow:hidden;}
    #cx-doc-modal .cx-doc-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 22px;border-bottom:1px solid var(--border-soft,#eef2f7);flex-shrink:0;}
    #cx-doc-modal .cx-doc-title{font-size:17px;font-weight:800;color:var(--text,#0f172a);letter-spacing:-.01em;}
    #cx-doc-modal .cx-doc-close{width:34px;height:34px;flex-shrink:0;border:1px solid var(--field-border,#e2e8f0);border-radius:9px;background:var(--surface-2,#f8fafc);color:var(--text-2,#475569);font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;}
    #cx-doc-modal .cx-doc-close:hover{background:var(--danger-soft,#fee2e2);color:var(--danger,#dc2626);border-color:var(--danger,#dc2626);}
    #cx-doc-modal .cx-doc-body{overflow-y:auto;overflow-x:hidden;padding:22px 26px 28px;}
    #cx-doc-modal .cx-doc-body>article>*:first-child{margin-top:0;}
    #cx-doc-modal .cx-doc-body h2{font-size:15.5px;font-weight:800;color:var(--text,#0f172a);margin:24px 0 10px;}
    #cx-doc-modal .cx-doc-body h4{font-size:13.5px;font-weight:800;color:var(--text,#0f172a);margin:0 0 6px;}
    #cx-doc-modal .cx-doc-body p{font-size:13.5px;line-height:1.7;color:var(--text-2,#475569);margin:0 0 11px;}
    #cx-doc-modal .cx-doc-body a{color:var(--brand,#2563eb);text-decoration:none;font-weight:600;word-break:break-word;}
    #cx-doc-modal .cx-doc-body a:hover{text-decoration:underline;}
    #cx-doc-modal .cx-doc-body ul{margin:0 0 12px;padding-left:20px;}
    #cx-doc-modal .cx-doc-body li{font-size:13.5px;line-height:1.65;color:var(--text-2,#475569);margin:0 0 6px;}
    #cx-doc-modal .cx-doc-body strong{color:var(--text,#0f172a);font-weight:700;}
    #cx-doc-modal .cx-policy-commit,#cx-doc-modal .cx-terms-notice{display:flex;gap:14px;align-items:flex-start;background:var(--brand-soft,#eff6ff);border:1px solid var(--brand-border,#bfdbfe);border-radius:14px;padding:16px 18px;margin:0 0 20px;}
    #cx-doc-modal .cx-policy-commit-icon,#cx-doc-modal .cx-terms-notice>svg{color:var(--brand,#2563eb);flex-shrink:0;}
    #cx-doc-modal .cx-policy-commit ul{margin:8px 0 0;padding-left:18px;}
    #cx-doc-modal .cx-policy-commit li{margin-bottom:4px;}
    #cx-doc-modal .cx-policy-commit strong,#cx-doc-modal .cx-terms-notice strong{display:inline-block;color:var(--text,#0f172a);font-size:14px;margin-bottom:2px;}
    #cx-doc-modal .cx-terms-notice p{margin:4px 0 0;}
    #cx-doc-modal .cx-policy-callout{background:var(--surface-2,#f8fafc);border-left:3px solid var(--brand,#2563eb);border-radius:0 10px 10px 0;padding:12px 15px;margin:0 0 14px;font-size:13px;line-height:1.65;color:var(--text-2,#475569);}
    #cx-doc-modal .cx-policy-callout-warn{border-left-color:var(--danger,#ef4444);background:var(--danger-soft,#fef2f2);}
    #cx-doc-modal .cx-policy-table{overflow-x:auto;margin:0 0 16px;border:1px solid var(--border,#e2e8f0);border-radius:12px;}
    #cx-doc-modal .cx-policy-table table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:460px;}
    #cx-doc-modal .cx-policy-table th{text-align:left;background:var(--surface-2,#f8fafc);color:var(--text,#0f172a);font-weight:700;padding:10px 12px;border-bottom:1px solid var(--border,#e2e8f0);}
    #cx-doc-modal .cx-policy-table td{padding:10px 12px;border-bottom:1px solid var(--border-soft,#eef2f7);color:var(--text-2,#475569);line-height:1.5;vertical-align:top;}
    #cx-doc-modal .cx-policy-table tr:last-child td{border-bottom:0;}
    #cx-doc-modal .cx-policy-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:0 0 16px;}
    #cx-doc-modal .cx-policy-card{border:1px solid var(--border,#e2e8f0);border-radius:12px;padding:14px 15px;background:var(--surface-2,#f8fafc);}
    #cx-doc-modal .cx-policy-card p{margin:0;font-size:12.5px;}
    #cx-doc-modal .cx-policy-checklist{list-style:none;padding-left:0;}
    #cx-doc-modal .cx-policy-checklist li{position:relative;padding-left:26px;margin-bottom:9px;}
    #cx-doc-modal .cx-policy-checklist li::before{content:"";position:absolute;left:0;top:2px;width:16px;height:16px;border-radius:50%;background:var(--ok-soft,#dcfce7);}
    #cx-doc-modal .cx-policy-checklist li::after{content:"";position:absolute;left:5px;top:5px;width:5px;height:9px;border:solid var(--ok-text,#16a34a);border-width:0 2px 2px 0;transform:rotate(45deg);}
    #cx-doc-modal .cx-policy-rights{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:0 0 14px;}
    #cx-doc-modal .cx-right{border:1px solid var(--border,#e2e8f0);border-radius:11px;padding:11px 13px;background:var(--surface-2,#f8fafc);}
    #cx-doc-modal .cx-right strong{display:block;font-size:13px;color:var(--brand,#2563eb);margin-bottom:3px;}
    #cx-doc-modal .cx-right span{font-size:12px;line-height:1.5;color:var(--text-3,#64748b);}
    #cx-doc-modal .cx-policy-dpo{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:0 0 14px;background:var(--surface-2,#f8fafc);border:1px solid var(--border,#e2e8f0);border-radius:12px;padding:16px;}
    #cx-doc-modal .cx-dpo-item{display:flex;flex-direction:column;gap:2px;}
    #cx-doc-modal .cx-dpo-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3,#94a3b8);font-weight:700;}
    #cx-doc-modal .cx-dpo-item strong{font-size:13px;color:var(--text,#0f172a);}
    #cx-doc-modal .cx-policy-final,#cx-doc-modal .cx-terms-sign{margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft,#eef2f7);font-weight:600;color:var(--text-2,#475569);}
    #cx-doc-modal .cx-terms-sign{text-align:right;color:var(--text-3,#94a3b8);font-style:italic;font-weight:600;}
    #cx-doc-modal .cx-defs{margin:0 0 14px;}
    #cx-doc-modal .cx-defs dt{font-weight:800;color:var(--brand,#2563eb);font-size:13px;margin-top:10px;}
    #cx-doc-modal .cx-defs dd{margin:2px 0 0;font-size:13px;line-height:1.6;color:var(--text-2,#475569);}
    @media (max-width:560px){#cx-doc-modal .cx-policy-cards,#cx-doc-modal .cx-policy-rights,#cx-doc-modal .cx-policy-dpo{grid-template-columns:1fr;}}
  `;
  const CX_POLICY_HTML = `<article class="cx-policy-content">
    <div class="cx-policy-commit"><div class="cx-policy-commit-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 12 2 2 4-4"></path></svg></div>
      <div><strong>5 cam kết cốt lõi của CentriX</strong>
        <ul>
          <li><strong>KHÔNG bán</strong> dữ liệu cá nhân của bạn cho bất kỳ bên thứ 3 nào.</li>
          <li>Mã hoá <strong>AES-256</strong> cho dữ liệu nhạy cảm (CCCD, MST, mật khẩu).</li>
          <li>Truyền tải qua <strong>HTTPS/TLS 1.3</strong> — không có kênh plaintext.</li>
          <li>Chỉ thu thập dữ liệu <strong>thực sự cần thiết</strong> cho giao dịch.</li>
          <li>Bạn có toàn quyền <strong>yêu cầu xoá</strong> dữ liệu bất cứ lúc nào.</li>
        </ul>
      </div>
    </div>
    <section class="cx-policy-section"><h2>1. Tổng quan</h2>
      <p>Chính sách này mô tả cách <strong>CentriX Digital</strong> ("CentriX", "chúng tôi") thu thập, lưu trữ, sử dụng và bảo vệ dữ liệu cá nhân của khách hàng ("bạn", "người dùng") khi sử dụng website <a href="https://centrix.digital/">centrix.digital</a> và các dịch vụ liên quan.</p>
      <p>CentriX tuân thủ nghiêm ngặt <strong>Nghị định 13/2023/NĐ-CP</strong> ngày 17/04/2023 của Chính phủ Việt Nam về bảo vệ dữ liệu cá nhân, cũng như các quy định pháp luật khác có liên quan.</p>
      <div class="cx-policy-callout"><strong>Bằng việc sử dụng website</strong>, bạn xác nhận đã đọc, hiểu và đồng ý với các điều khoản trong Chính sách bảo mật này. Nếu không đồng ý, vui lòng ngừng sử dụng dịch vụ.</div>
    </section>
    <section class="cx-policy-section"><h2>2. Dữ liệu chúng tôi thu thập</h2>
      <p>Chúng tôi <em>chỉ</em> thu thập những dữ liệu tối thiểu cần thiết để cung cấp và cải thiện dịch vụ:</p>
      <div class="cx-policy-table"><table><thead><tr><th>Loại dữ liệu</th><th>Dữ liệu cụ thể</th><th>Khi nào thu thập</th></tr></thead><tbody>
        <tr><td><strong>Tài khoản</strong></td><td>Email, mật khẩu (đã hash bcrypt), họ tên</td><td>Khi đăng ký / đăng nhập</td></tr>
        <tr><td><strong>Liên hệ</strong></td><td>Số điện thoại, địa chỉ giao hàng</td><td>Khi đặt đơn hàng</td></tr>
        <tr><td><strong>Hoá đơn VAT</strong></td><td>CCCD/CMND hoặc MST, địa chỉ xuất hoá đơn</td><td>Khi yêu cầu xuất VAT (theo NĐ 70/2025/NĐ-CP)</td></tr>
        <tr><td><strong>Thanh toán</strong></td><td>Mã giao dịch, phương thức (không lưu số thẻ / OTP)</td><td>Khi thanh toán qua cổng</td></tr>
        <tr><td><strong>Kỹ thuật</strong></td><td>Địa chỉ IP, User Agent, cookies, timestamp truy cập</td><td>Mọi lần truy cập (tự động)</td></tr>
        <tr><td><strong>Hỗ trợ</strong></td><td>Nội dung tin nhắn, ảnh/file đính kèm</td><td>Khi gửi form liên hệ / chat Zalo</td></tr>
      </tbody></table></div>
      <div class="cx-policy-callout cx-policy-callout-warn"><strong>Chúng tôi KHÔNG lưu trữ:</strong> số thẻ tín dụng/ghi nợ, mã CVV, mật khẩu OTP ngân hàng, hoặc bất kỳ thông tin thanh toán nhạy cảm nào. Mọi giao dịch đều xử lý qua cổng thanh toán có chứng nhận PCI-DSS.</div>
    </section>
    <section class="cx-policy-section"><h2>3. Mục đích sử dụng dữ liệu</h2>
      <p>Dữ liệu cá nhân được sử dụng cho các mục đích sau:</p>
      <ul class="cx-policy-checklist">
        <li><strong>Xử lý đơn hàng:</strong> tạo đơn, gửi tài khoản/license, xác nhận thanh toán.</li>
        <li><strong>Hỗ trợ khách hàng:</strong> trả lời câu hỏi, xử lý khiếu nại, bảo hành sản phẩm.</li>
        <li><strong>Tuân thủ pháp luật:</strong> xuất hoá đơn VAT điện tử, báo cáo thuế theo yêu cầu cơ quan nhà nước.</li>
        <li><strong>Bảo mật hệ thống:</strong> phát hiện gian lận, ngăn chặn truy cập trái phép.</li>
        <li><strong>Cải thiện dịch vụ:</strong> phân tích hành vi (đã ẩn danh) để tối ưu UX/UI.</li>
        <li><strong>Marketing (chỉ khi có sự đồng ý):</strong> gửi thông báo khuyến mãi, newsletter — bạn có thể huỷ bất cứ lúc nào.</li>
      </ul>
    </section>
    <section class="cx-policy-section"><h2>4. Chia sẻ với bên thứ 3</h2>
      <p>CentriX <strong>không bán</strong> và <strong>không cho thuê</strong> dữ liệu cá nhân của bạn. Chúng tôi chỉ chia sẻ dữ liệu trong các trường hợp giới hạn sau:</p>
      <div class="cx-policy-cards">
        <div class="cx-policy-card"><h4>Đối tác thanh toán</h4><p>VietQR, NAPAS 247, SePay, Binance Pay, Payssion — nhận mã giao dịch và số tiền để xử lý. Không nhận thông tin sản phẩm.</p></div>
        <div class="cx-policy-card"><h4>Hạ tầng đám mây</h4><p>Server đặt tại Việt Nam/Singapore. Nhà cung cấp không có quyền đọc dữ liệu đã mã hoá.</p></div>
        <div class="cx-policy-card"><h4>Cơ quan pháp luật</h4><p>Chỉ cung cấp khi có yêu cầu bằng văn bản chính thức từ cơ quan có thẩm quyền tại Việt Nam.</p></div>
        <div class="cx-policy-card"><h4>Cơ quan thuế</h4><p>Dữ liệu CCCD/MST/địa chỉ được truyền cho Tổng cục Thuế qua hệ thống hoá đơn điện tử — theo quy định NĐ 70/2025.</p></div>
      </div>
    </section>
    <section class="cx-policy-section"><h2>5. Biện pháp bảo mật</h2>
      <p>CentriX áp dụng nhiều lớp bảo vệ kỹ thuật và quản lý:</p>
      <ul class="cx-policy-checklist">
        <li><strong>Mã hoá khi lưu trữ (at-rest):</strong> AES-256 cho dữ liệu nhạy cảm (CCCD, MST).</li>
        <li><strong>Mã hoá khi truyền (in-transit):</strong> HTTPS/TLS 1.3 cho 100% request.</li>
        <li><strong>Hash mật khẩu:</strong> bcrypt với cost factor ≥ 12.</li>
        <li><strong>Kiểm soát truy cập:</strong> chỉ nhân viên được uỷ quyền mới truy cập được dữ liệu, log đầy đủ.</li>
        <li><strong>Sao lưu định kỳ:</strong> backup tự động mỗi 24h, lưu trữ encrypted offsite.</li>
        <li><strong>Giám sát 24/7:</strong> phát hiện bất thường, cảnh báo realtime.</li>
        <li><strong>Kiểm toán bảo mật:</strong> pentest định kỳ hàng năm bởi đơn vị độc lập.</li>
      </ul>
      <div class="cx-policy-callout">Dù áp dụng biện pháp tốt nhất, không hệ thống nào có thể đảm bảo <em>an toàn tuyệt đối</em>. Nếu phát hiện sự cố bảo mật, chúng tôi sẽ thông báo cho bạn và cơ quan chức năng trong <strong>72 giờ</strong> theo quy định NĐ 13/2023.</div>
    </section>
    <section class="cx-policy-section"><h2>6. Cookies &amp; tracking</h2>
      <p>Website sử dụng cookies và công nghệ tương tự cho các mục đích:</p>
      <ul class="cx-policy-checklist">
        <li><strong>Cookies thiết yếu:</strong> duy trì đăng nhập, giỏ hàng — không thể tắt vì nếu tắt website sẽ không chạy.</li>
        <li><strong>Cookies phân tích:</strong> Google Analytics (ẩn danh IP) để hiểu cách khách dùng site.</li>
        <li><strong>Cookies marketing:</strong> Facebook Pixel, Google Ads — chỉ kích hoạt khi bạn đồng ý qua banner cookie.</li>
      </ul>
      <p>Bạn có thể tắt cookies tại trình duyệt hoặc gửi yêu cầu qua email — một số tính năng có thể bị ảnh hưởng.</p>
    </section>
    <section class="cx-policy-section"><h2>7. Quyền của bạn theo Nghị định 13/2023</h2>
      <p>Là chủ thể dữ liệu, bạn có các quyền sau — tất cả đều <strong>miễn phí</strong> và được xử lý trong vòng <strong>72 giờ</strong> làm việc:</p>
      <div class="cx-policy-rights">
        <div class="cx-right"><strong>Quyền biết</strong><span>Biết được dữ liệu nào của bạn đang được xử lý.</span></div>
        <div class="cx-right"><strong>Quyền đồng ý</strong><span>Đồng ý/không đồng ý cho từng mục đích cụ thể.</span></div>
        <div class="cx-right"><strong>Quyền truy cập</strong><span>Yêu cầu bản sao dữ liệu ở định dạng đọc được.</span></div>
        <div class="cx-right"><strong>Quyền rút đồng ý</strong><span>Rút lại sự đồng ý đã cấp trước đó.</span></div>
        <div class="cx-right"><strong>Quyền xoá</strong><span>Yêu cầu xoá toàn bộ dữ liệu cá nhân.</span></div>
        <div class="cx-right"><strong>Quyền hạn chế</strong><span>Yêu cầu tạm ngừng xử lý dữ liệu.</span></div>
        <div class="cx-right"><strong>Quyền cung cấp</strong><span>Nhận dữ liệu để chuyển sang dịch vụ khác.</span></div>
        <div class="cx-right"><strong>Quyền phản đối</strong><span>Phản đối việc xử lý dữ liệu vì lý do chính đáng.</span></div>
        <div class="cx-right"><strong>Quyền khiếu nại</strong><span>Khiếu nại tới Bộ Công an (Cục A05) nếu cần.</span></div>
      </div>
      <p>Để thực hiện các quyền trên, gửi yêu cầu đến <a href="mailto:support@centrix.digital">support@centrix.digital</a> kèm chứng minh danh tính (CCCD/CMND).</p>
    </section>
    <section class="cx-policy-section"><h2>8. Lưu trữ &amp; xoá dữ liệu</h2>
      <p>Dữ liệu được lưu trữ trong các thời hạn sau:</p>
      <ul class="cx-policy-checklist">
        <li><strong>Dữ liệu đơn hàng &amp; hoá đơn:</strong> tối thiểu <strong>10 năm</strong> — theo quy định Luật Kế toán &amp; Luật Thuế.</li>
        <li><strong>Dữ liệu tài khoản:</strong> đến khi bạn yêu cầu xoá hoặc tài khoản không hoạt động &gt; 3 năm.</li>
        <li><strong>Logs kỹ thuật (IP, User Agent):</strong> tối đa <strong>12 tháng</strong>.</li>
        <li><strong>Tin nhắn hỗ trợ:</strong> <strong>24 tháng</strong> kể từ ngày gửi cuối cùng.</li>
      </ul>
      <p>Khi hết thời hạn hoặc bạn yêu cầu, dữ liệu sẽ được xoá vĩnh viễn (secure wipe) trong vòng 30 ngày — trừ dữ liệu pháp lý bắt buộc lưu.</p>
    </section>
    <section class="cx-policy-section"><h2>9. Trẻ em dưới 18 tuổi</h2>
      <p>CentriX không cung cấp dịch vụ cho người dưới 18 tuổi. Nếu phát hiện tài khoản thuộc trẻ vị thành niên, chúng tôi sẽ <strong>xoá ngay lập tức</strong> và thông báo cho phụ huynh/người giám hộ (nếu có thông tin).</p>
      <p>Phụ huynh phát hiện con em sử dụng dịch vụ → liên hệ ngay <a href="mailto:support@centrix.digital">support@centrix.digital</a> để được hỗ trợ.</p>
    </section>
    <section class="cx-policy-section"><h2>10. Thay đổi chính sách</h2>
      <p>CentriX có thể cập nhật Chính sách bảo mật này theo thời gian để phản ánh thay đổi về pháp luật, dịch vụ hoặc thực tiễn vận hành.</p>
      <ul class="cx-policy-checklist">
        <li>Với <strong>thay đổi nhỏ</strong> (chỉnh sửa câu chữ): cập nhật trực tiếp, ghi rõ ngày "Cập nhật gần nhất" ở đầu trang.</li>
        <li>Với <strong>thay đổi lớn</strong> (thêm mục đích mới, bên thứ 3 mới): thông báo qua email tới tất cả người dùng ít nhất <strong>30 ngày</strong> trước khi có hiệu lực.</li>
      </ul>
      <p>Phiên bản cũ được lưu trữ và cung cấp khi có yêu cầu.</p>
    </section>
    <section class="cx-policy-section"><h2>11. Liên hệ Bộ phận Bảo vệ dữ liệu (DPO)</h2>
      <p>Mọi câu hỏi, yêu cầu thực hiện quyền, hoặc khiếu nại liên quan đến bảo mật dữ liệu:</p>
      <div class="cx-policy-dpo">
        <div class="cx-dpo-item"><span class="cx-dpo-label">Tên tổ chức</span><strong>CentriX Digital</strong></div>
        <div class="cx-dpo-item"><span class="cx-dpo-label">Địa chỉ</span><strong>Số 100 Đường N3A, Dự án khu đô thị Sài Gòn Bình An, Phường Bình Trưng, TP Hồ Chí Minh</strong></div>
        <div class="cx-dpo-item"><span class="cx-dpo-label">Email DPO</span><strong><a href="mailto:support@centrix.digital">support@centrix.digital</a></strong></div>
        <div class="cx-dpo-item"><span class="cx-dpo-label">Hotline</span><strong><a href="tel:0342888222">0342.888.222</a></strong></div>
        <div class="cx-dpo-item"><span class="cx-dpo-label">Zalo</span><strong><a href="https://zalo.me/centrixcorp" target="_blank" rel="noopener">Mở Zalo chat</a></strong></div>
        <div class="cx-dpo-item"><span class="cx-dpo-label">Thời gian phản hồi</span><strong>Trong vòng 72 giờ làm việc</strong></div>
      </div>
      <p class="cx-policy-final">Nếu không hài lòng với phản hồi từ CentriX, bạn có quyền khiếu nại trực tiếp tới <strong>Cục An ninh mạng và phòng, chống tội phạm sử dụng công nghệ cao (A05) — Bộ Công an</strong>.</p>
    </section>
  </article>`;
  const CX_TERMS_HTML = `<article class="cx-terms-content">
    <div class="cx-terms-notice"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
      <div><strong>Đọc kỹ trước khi sử dụng dịch vụ</strong><p>Bằng việc truy cập hoặc mua hàng tại CentriX, bạn xác nhận đã đọc, hiểu và đồng ý với toàn bộ nội dung Điều khoản dịch vụ này. Nếu không đồng ý, vui lòng không sử dụng dịch vụ.</p></div>
    </div>
    <section class="cx-terms-section"><h2>1. Chấp nhận điều khoản</h2>
      <p>Tài liệu này cấu thành <strong>thoả thuận pháp lý ràng buộc</strong> giữa bạn ("Người dùng", "Khách hàng") và <strong>CentriX Digital</strong> ("CentriX", "chúng tôi") liên quan đến việc sử dụng website <a href="https://centrix.digital/">centrix.digital</a> và các dịch vụ đi kèm.</p>
      <p>Người dùng phải <strong>đủ 18 tuổi</strong> hoặc có sự đồng ý/giám sát của người giám hộ hợp pháp. Khi sử dụng dịch vụ, bạn cam kết mọi thông tin cung cấp đều chính xác, trung thực.</p>
    </section>
    <section class="cx-terms-section"><h2>2. Định nghĩa</h2>
      <dl class="cx-defs">
        <dt>"Dịch vụ"</dt><dd>là toàn bộ sản phẩm, tài khoản bản quyền phần mềm/AI, dịch vụ hỗ trợ kỹ thuật mà CentriX cung cấp.</dd>
        <dt>"Tài khoản"</dt><dd>là thông tin đăng nhập (email + mật khẩu) khách hàng tạo trên website để mua hàng và quản lý license.</dd>
        <dt>"License"</dt><dd>là quyền sử dụng sản phẩm bản quyền của nhà phát hành thứ 3 mà CentriX cung cấp cho khách hàng.</dd>
        <dt>"Nhà phát hành"</dt><dd>là các công ty sở hữu phần mềm gốc (Anthropic, OpenAI, Microsoft, Adobe, Google, Canva...).</dd>
        <dt>"Giao dịch"</dt><dd>là hành vi đặt hàng, thanh toán và nhận license trên website CentriX.</dd>
      </dl>
    </section>
    <section class="cx-terms-section"><h2>3. Tài khoản người dùng</h2>
      <ul>
        <li>Khách hàng có thể mua hàng <strong>không cần đăng ký</strong> (guest checkout) hoặc tạo tài khoản để theo dõi đơn.</li>
        <li>Khi tạo tài khoản, bạn có <strong>trách nhiệm bảo mật</strong> email + mật khẩu của mình. CentriX không chịu trách nhiệm nếu tài khoản bị xâm nhập do bạn để lộ thông tin.</li>
        <li>Mỗi người chỉ được tạo <strong>một tài khoản</strong>. Hành vi tạo nhiều tài khoản để lợi dụng khuyến mãi sẽ bị khóa vĩnh viễn.</li>
        <li>CentriX có quyền <strong>tạm khoá hoặc xoá</strong> tài khoản nếu phát hiện vi phạm điều khoản.</li>
      </ul>
    </section>
    <section class="cx-terms-section"><h2>4. Quy tắc sử dụng dịch vụ</h2>
      <p>Bạn <strong>đồng ý không</strong>:</p>
      <ul>
        <li>Sử dụng dịch vụ cho mục đích <strong>phi pháp</strong> (lừa đảo, spam, phát tán malware, vi phạm bản quyền...).</li>
        <li><strong>Mua bán lại</strong> license đã mua mà không có sự cho phép bằng văn bản của CentriX.</li>
        <li>Sử dụng bot, scraper, hoặc công cụ tự động để truy cập website gây ảnh hưởng hiệu năng.</li>
        <li>Tấn công, phá hoại, hoặc cố gắng xâm nhập trái phép vào hệ thống CentriX.</li>
        <li>Giả mạo danh tính người khác khi đặt hàng hoặc liên hệ CSKH.</li>
        <li>Chia sẻ tài khoản cá nhân cho <strong>quá số thiết bị/người</strong> được cấp phép trong gói.</li>
      </ul>
      <p>Vi phạm có thể dẫn đến <strong>chấm dứt ngay lập tức</strong> quyền sử dụng dịch vụ và không được hoàn tiền.</p>
    </section>
    <section class="cx-terms-section"><h2>5. Sản phẩm &amp; dịch vụ</h2>
      <ul>
        <li>CentriX là <strong>đại lý phân phối</strong> hợp pháp các sản phẩm bản quyền từ nhà phát hành quốc tế.</li>
        <li>Tất cả license bán ra đều là <strong>hàng chính hãng</strong>, có chứng nhận nguồn gốc rõ ràng.</li>
        <li>Thời hạn, tính năng, số thiết bị... được mô tả chi tiết tại trang sản phẩm — bạn có trách nhiệm đọc kỹ trước khi mua.</li>
        <li>CentriX không chịu trách nhiệm về các <strong>thay đổi chính sách</strong> từ nhà phát hành (vd: Anthropic đổi pricing, OpenAI giới hạn tính năng) — sẽ thông báo và có biện pháp hỗ trợ khách hàng tốt nhất có thể.</li>
      </ul>
    </section>
    <section class="cx-terms-section"><h2>6. Giá &amp; thanh toán</h2>
      <ul>
        <li>Giá sản phẩm được niêm yết <strong>bằng VND</strong>, đã bao gồm VAT (nếu có yêu cầu xuất hoá đơn).</li>
        <li>CentriX có quyền <strong>điều chỉnh giá</strong> bất cứ lúc nào — thay đổi không áp dụng hồi tố với đơn đã thanh toán.</li>
        <li>Thanh toán qua các cổng: VietQR, NAPAS 247, Binance Pay. Chi tiết xem <a href="https://centrix.digital/huong-dan-thanh-toan">Hướng dẫn thanh toán</a>.</li>
        <li>Hoá đơn VAT điện tử xuất trong vòng 24 giờ theo <strong>Nghị định 70/2025/NĐ-CP</strong>.</li>
        <li>Chính sách hoàn tiền: xem <a href="https://centrix.digital/chinh-sach-hoan-tien">Chính sách hoàn tiền</a>.</li>
      </ul>
    </section>
    <section class="cx-terms-section"><h2>7. Sở hữu trí tuệ</h2>
      <p>Toàn bộ nội dung, logo, thương hiệu <strong>CentriX</strong>, thiết kế website, mã nguồn... thuộc sở hữu của CentriX Digital hoặc các đối tác có thoả thuận. Người dùng không được sao chép, phân phối, hoặc sử dụng thương mại mà không có văn bản cho phép.</p>
      <p>License phần mềm bán ra thuộc sở hữu của <strong>Nhà phát hành gốc</strong> (Anthropic, OpenAI, Microsoft...). CentriX chỉ là đơn vị phân phối — người dùng phải tuân thủ Terms of Service của từng nhà phát hành khi sử dụng license.</p>
    </section>
    <section class="cx-terms-section"><h2>8. Miễn trách nhiệm</h2>
      <ul>
        <li>CentriX <strong>không chịu trách nhiệm</strong> với thiệt hại gián tiếp (mất dữ liệu, mất cơ hội kinh doanh...) phát sinh từ việc sử dụng dịch vụ.</li>
        <li>Tổng trách nhiệm bồi thường tối đa của CentriX <strong>không vượt quá</strong> số tiền khách hàng đã thanh toán cho đơn hàng gây tranh chấp.</li>
        <li>Website có thể gặp <strong>gián đoạn tạm thời</strong> do bảo trì, nâng cấp, hoặc sự cố kỹ thuật — CentriX sẽ nỗ lực hết sức để khắc phục trong thời gian ngắn nhất.</li>
        <li>Thông tin trên website được cập nhật định kỳ nhưng không đảm bảo 100% chính xác tại mọi thời điểm. Vui lòng liên hệ CSKH để xác nhận trước khi đưa ra quyết định quan trọng.</li>
      </ul>
    </section>
    <section class="cx-terms-section"><h2>9. Chấm dứt dịch vụ</h2>
      <p>CentriX có quyền <strong>chấm dứt đơn phương</strong> quyền sử dụng dịch vụ của khách hàng trong các trường hợp:</p>
      <ul>
        <li>Vi phạm nghiêm trọng Điều khoản dịch vụ này.</li>
        <li>Có hành vi gian lận, lừa đảo, hoặc gây hại cho CentriX/khách hàng khác.</li>
        <li>Yêu cầu từ cơ quan pháp luật có thẩm quyền.</li>
      </ul>
      <p>Khi chấm dứt, license đang sử dụng có thể bị thu hồi mà không cần bồi thường. Khách hàng có thể <strong>tự nguyện xoá tài khoản</strong> bất cứ lúc nào bằng cách liên hệ <a href="mailto:support@centrix.digital">support@centrix.digital</a>.</p>
    </section>
    <section class="cx-terms-section"><h2>10. Luật áp dụng &amp; giải quyết tranh chấp</h2>
      <p>Điều khoản này được điều chỉnh bởi <strong>pháp luật Việt Nam</strong>, bao gồm:</p>
      <ul>
        <li>Bộ luật Dân sự 2015</li>
        <li>Luật Bảo vệ quyền lợi người tiêu dùng 2023</li>
        <li>Luật Thương mại điện tử (Nghị định 52/2013/NĐ-CP)</li>
        <li>Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân</li>
        <li>Các văn bản pháp luật liên quan khác</li>
      </ul>
      <p>Tranh chấp được <strong>ưu tiên giải quyết qua thương lượng</strong>. Nếu không đạt được thoả thuận, tranh chấp sẽ được đưa ra <strong>Toà án nhân dân có thẩm quyền tại TP. Hồ Chí Minh</strong>.</p>
    </section>
    <section class="cx-terms-section"><h2>11. Thay đổi điều khoản</h2>
      <p>CentriX có quyền <strong>sửa đổi, bổ sung</strong> các điều khoản này bất cứ lúc nào. Thay đổi có hiệu lực từ ngày công bố trên website.</p>
      <p>Với thay đổi quan trọng (ảnh hưởng quyền lợi người dùng), CentriX sẽ thông báo qua <strong>email đăng ký</strong> ít nhất <strong>15 ngày</strong> trước khi có hiệu lực. Việc tiếp tục sử dụng dịch vụ sau ngày thay đổi có hiệu lực được xem như đã chấp nhận điều khoản mới.</p>
    </section>
    <section class="cx-terms-section"><h2>12. Liên hệ</h2>
      <p>Mọi câu hỏi, góp ý, hoặc yêu cầu liên quan đến Điều khoản dịch vụ, vui lòng liên hệ:</p>
      <ul class="cx-terms-contact">
        <li><strong>CentriX Digital</strong></li>
        <li>Email: <a href="mailto:support@centrix.digital">support@centrix.digital</a></li>
        <li>Zalo: <a href="https://zalo.me/centrixcorp" target="_blank" rel="noopener">Mở Zalo chat</a></li>
        <li>Trang liên hệ: <a href="https://centrix.digital/lien-he">https://centrix.digital/lien-he</a></li>
      </ul>
      <p class="cx-terms-sign">— CentriX Digital Team</p>
    </section>
  </article>`;
  function showDocModal(kind) {
    document.getElementById("cx-doc-modal")?.remove();
    if (!document.getElementById("cx-doc-style")) {
      const st = document.createElement("style"); st.id = "cx-doc-style"; st.textContent = CX_LEGAL_STYLE; (document.head || document.documentElement).appendChild(st);
    }
    const isPolicy = kind === "policy";
    const overlay = document.createElement("div");
    overlay.id = "cx-doc-modal";
    overlay.innerHTML =
      '<div class="cx-doc-card" role="dialog" aria-modal="true">'
      + '<div class="cx-doc-head"><div class="cx-doc-title">' + (isPolicy ? "Chính sách bảo mật" : "Điều khoản dịch vụ") + '</div>'
      + '<button type="button" class="cx-doc-close" data-cx-doc-close aria-label="Đóng">✕</button></div>'
      + '<div class="cx-doc-body">' + (isPolicy ? CX_POLICY_HTML : CX_TERMS_HTML) + '</div>'
      + '</div>';
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || (e.target.closest && e.target.closest("[data-cx-doc-close]"))) { e.preventDefault(); e.stopPropagation(); close(); return; }
      const a = e.target.closest && e.target.closest("a[href]");
      if (a) { e.preventDefault(); e.stopPropagation(); try { window.open(a.getAttribute("href"), "_blank"); } catch (_) { /* ignore */ } }
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  }
  // Wire the login-screen "Chính sách bảo mật" / "Điều khoản dịch vụ" spans → open the modal. CAPTURE phase +
  // stopPropagation so the click does NOT toggle the "Tôi đồng ý" checkbox they sit inside, and never reaches
  // the primary-login matcher. Registered once.
  if (typeof window !== "undefined" && !window.__cxDocModalWired) {
    window.__cxDocModalWired = true;
    document.addEventListener("click", (event) => {
      const leaf = event.target;
      if (!leaf || (leaf.children && leaf.children.length)) return; // only the leaf span
      const t = fold((leaf.textContent || "").trim());
      if (t === "chinh sach bao mat") { event.preventDefault(); event.stopPropagation(); showDocModal("policy"); }
      else if (t === "dieu khoan dich vu" || t === "dieu khoan su dung") { event.preventDefault(); event.stopPropagation(); showDocModal("terms"); }
    }, true);
  }

  // Credit-deduction notice shown top-right (near the credit pills) on each charged request, e.g.
  // "Request ChatGPT · −3 credit". Distinct from showActionToast so it reads as a credit event.
  function showCreditToast(message) {
    let toast = document.getElementById("centrix-user-credit-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "centrix-user-credit-toast";
      toast.innerHTML = '<span style="font-size:14px;line-height:1;">⚡</span><span class="cx-credit-toast-msg"></span>';
      document.body.appendChild(toast);
    }
    toast.style.cssText = [
      "position:fixed",
      "top:176px",
      "right:18px",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:9px 14px",
      "border-radius:11px",
      "background:rgba(180,83,9,.96)",
      "color:#fff",
      "font:800 12.5px/1.2 Segoe UI,system-ui,sans-serif",
      "box-shadow:0 12px 30px rgba(15,23,42,.28)",
      "pointer-events:none",
      "transform:translateY(-6px)",
      "opacity:0",
      "transition:opacity .18s ease, transform .18s ease"
    ].join(";");
    const msgEl = toast.querySelector(".cx-credit-toast-msg");
    if (msgEl) msgEl.textContent = message;
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });
    clearTimeout(showCreditToast.timer);
    showCreditToast.timer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-6px)";
      setTimeout(() => toast.remove(), 240);
    }, 3200);
  }

  function hydrateStaticDefaults() {
    for (const input of Array.from(document.querySelectorAll("input"))) {
      // Login email/password are owned by prefillLoginForm (saved/typed login) — never auto-fill the
      // generated design's sample account ("trxuanloc.../centrix") here, or the user can't switch accounts.
      // Skip login creds AND masked sample values like "084xxx939" (phone) — those are placeholder demo
      // data, not real account info; filling them makes the field show a fake number that sticks.
      if (input.type === "password" || input.type === "email" || /@|xxx/i.test(input.getAttribute("defaultvalue") || "")) continue;
      const labelText = fold(input.closest("label")?.textContent || "");
      const shouldCheckTerms = input.type === "checkbox" && labelText.includes("toi dong y");
      if (input.dataset.centrixDefaultHydrated === "1" && !(shouldCheckTerms && !input.checked)) continue;

      const fallbackValue = cleanTemplateValue(input.getAttribute("defaultvalue"));
      if (!input.value && fallbackValue) {
        input.value = fallbackValue;
        input.defaultValue = fallbackValue;
      }

      const defaultChecked = cleanTemplateValue(input.getAttribute("defaultchecked"));
      if (input.type === "checkbox" && ((defaultChecked && defaultChecked !== "false") || shouldCheckTerms)) {
        input.checked = true;
        input.defaultChecked = true;
      }

      input.dataset.centrixDefaultHydrated = "1";
    }
    bindStaticServiceOpenControls();
    markStableServiceLayout();
  }

  function servicesByName() {
    return [...liveServices()]
      .filter((service) => service?.id && service?.name)
      .sort((a, b) => String(b.name).length - String(a.name).length);
  }

  function serviceFromStaticName(value) {
    const text = fold(value || "");
    if (!text) return null;
    return servicesByName().find((service) => {
      const id = fold(service.id || "");
      const name = fold(service.name || "");
      return text === id || text === name || text.includes(name) || text.includes(id);
    }) || null;
  }

  function serviceFromNearbyServiceRow(target) {
    if (!target || !state.loginOk || !state.services.length) return null;
    const targetRect = target.getBoundingClientRect?.();
    if (!targetRect) return null;
    const services = servicesByName();
    const candidates = [];

    for (const element of Array.from(document.querySelectorAll("button,div,span,a"))) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (
        rect.width < 120 ||
        rect.width > 460 ||
        rect.height < 34 ||
        rect.height > 120 ||
        rect.right < targetRect.left - 36 ||
        rect.left > targetRect.right + 36 ||
        rect.bottom < targetRect.top - 22 ||
        rect.top > targetRect.bottom + 22
      ) {
        continue;
      }

      const text = fold(element.textContent || "");
      const matched = services.find((service) => text.includes(fold(service.name)) || text.includes(fold(service.id)));
      if (!matched) continue;

      const distance = Math.abs((rect.top + rect.bottom) / 2 - (targetRect.top + targetRect.bottom) / 2) +
        Math.abs(rect.left - targetRect.left) / 8;
      candidates.push({ service: matched, distance, element });
    }

    candidates.sort((a, b) => a.distance - b.distance);
    if (candidates[0]?.element) candidates[0].element.dataset.centrixServiceRow = "1";
    return candidates[0]?.service || null;
  }

  function ensureBadge() {
    document.getElementById("centrix-user-api-ui-badge")?.remove();
  }

  function publishState() {
    window.centrixUserApiUi = { ...state };
  }

  // Collect every live design-runtime component instance (main shell + child panels). The Nhật ký
  // list and its date dropdown live in a SEPARATE child DCLogic from getDC() (whose state has no
  // urlTime), so anything touching the url log must scan ALL of these, not just the main logic.
  function collectStaticCandidates() {
    const candidates = [];
    const add = (item) => {
      if (item && typeof item === "object") {
        candidates.push(item, item.logic);
      }
    };

    try {
      if (typeof window.getDC === "function") add(window.getDC());
    } catch {
      // The generated design runtime may expose getDC before it is fully ready.
    }

    try {
      for (const item of Object.values(window.__dcRegistry || {})) {
        add(item);
        add(item?.logic);
        add(item?.instance);
        add(item?.component);
        add(item?.stateNode);
        add(item?.current);
        add(item?.ref?.current);
      }
    } catch {
      // Registry shape differs between generated UI runtimes.
    }

    for (const element of Array.from(document.querySelectorAll("*"))) {
      const fiberKey = Object.getOwnPropertyNames(element)
        .find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
      let fiber = fiberKey ? element[fiberKey] : null;
      let depth = 0;
      while (fiber && depth < 200) {
        add(fiber.stateNode);
        fiber = fiber.return;
        depth += 1;
      }
    }

    return candidates.filter((item) => item && typeof item === "object");
  }

  function staticLogic() {
    const candidates = collectStaticCandidates();
    const validCandidates = candidates.filter((item) => (
      item &&
      typeof item.setState === "function" &&
      item.state &&
      (Object.prototype.hasOwnProperty.call(item.state, "screen") || typeof item.login === "function")
    ));
    for (const candidate of validCandidates) {
      patchStaticLogic(candidate);
    }
    // Patch renderVals on EVERY component that HAS one — not just the ones with a `screen` state. The
    // portal sub-widgets (Tổng quan overview cards / Lịch sử / Hoạt động) live in their own child
    // components without `screen`, so they need the live-account override too or they render (and
    // flash) the sample seed on tab open.
    for (const item of candidates) {
      if (item && typeof item === "object" && typeof item.renderVals === "function") {
        patchStaticUrlLog(item);
      }
    }
    return validCandidates[0] || null;
  }

  function patchStaticLogic(logic) {
    if (!logic) return logic;
    patchStaticServiceHandlers(logic);
    patchStaticChatHandlers(logic);
    if (patchedStaticLogic === logic || logic.__centrixBoundsPatched) return logic;
    const originalSetState = logic.setState;
    if (typeof originalSetState !== "function") return logic;
    logic.__centrixBoundsPatched = true;
    patchedStaticLogic = logic;
    logic.setState = function centrixPatchedSetState(update, callback) {
      const previousCollapsed = this.state?.collapsed;
      let nextCollapsed = null;
      if (update && typeof update === "object" && Object.prototype.hasOwnProperty.call(update, "collapsed")) {
        nextCollapsed = update.collapsed === true;
      } else if (typeof update === "function") {
        try {
          const preview = update.call(this, this.state, this.props);
          if (preview && typeof preview === "object" && Object.prototype.hasOwnProperty.call(preview, "collapsed")) {
            nextCollapsed = preview.collapsed === true;
          }
        } catch {
          // React will surface updater errors when the original setState runs.
        }
      }
      const watchesLayout =
        typeof update === "function" ||
        (update && typeof update === "object" && (
          Object.prototype.hasOwnProperty.call(update, "collapsed") ||
          Object.prototype.hasOwnProperty.call(update, "active") ||
          Object.prototype.hasOwnProperty.call(update, "opening") ||
          Object.prototype.hasOwnProperty.call(update, "screen")
        ));
      const collapseChanged = nextCollapsed !== null && nextCollapsed !== previousCollapsed;
      if (collapseChanged) {
        stableServiceBounds = null; // sidebar width changed → re-measure the locked bounds
        disableStaticSidebarTransition();
        syncBrowserBoundsForCollapsed(nextCollapsed, previousCollapsed === true);
      }
      const afterCommit = (...args) => {
        if (typeof callback === "function") callback(...args);
        const collapseCommitted = collapseChanged || previousCollapsed !== this.state?.collapsed;
        if (watchesLayout || collapseCommitted) {
          disableStaticSidebarTransition();
          syncBrowserBoundsBurst(collapseCommitted);
          markStableServiceLayout(true);
          setTimeout(() => recoverStaticDemoServiceState(this), 0);
        }
      };
      const result = originalSetState.call(this, update, afterCommit);
      if (watchesLayout) {
        disableStaticSidebarTransition();
        syncBrowserBoundsBurst(collapseChanged);
        setTimeout(() => recoverStaticDemoServiceState(this), 0);
      }
      return result;
    };
    return logic;
  }

  function patchStaticServiceHandlers(logic) {
    if (!logic || logic.__centrixServiceHandlersPatched) return logic;
    const originalOpenService = typeof logic.openService === "function" ? logic.openService.bind(logic) : null;
    const originalUseService = typeof logic.useService === "function" ? logic.useService.bind(logic) : null;
    logic.__centrixOriginalOpenService = originalOpenService;
    logic.__centrixOriginalUseService = originalUseService;
    if (originalOpenService) {
      logic.openService = function centrixPatchedStaticOpenService(name, ...args) {
        const service = serviceFromStaticName(name);
        if (service?.id && state.loginOk) {
          dispatchStaticServiceOpen(service);
          return;
        }
        return originalOpenService(name, ...args);
      };
    }
    if (originalUseService) {
      logic.useService = function centrixPatchedStaticUseService(name, cost, dot, ...args) {
        const service = serviceFromStaticName(name);
        if (service?.id && state.loginOk) {
          dispatchStaticServiceOpen(service);
          return;
        }
        return originalUseService(name, cost, dot, ...args);
      };
    }
    logic.__centrixServiceHandlersPatched = true;
    return logic;
  }

  function recoverStaticDemoServiceState(logic = staticLogic()) {
    if (!logic?.state || !state.loginOk || !state.services.length) return;
    const service = serviceFromStaticName(logic.state.active);
    if (!service?.id) return;
    const currentBrowser = state.browser || {};
    if (
      currentBrowser.activeServiceId === service.id ||
      currentBrowser.pendingServiceId === service.id ||
      currentBrowser.opening === true
    ) {
      return;
    }

    const now = Date.now();
    if (staticDemoRecovery.id === service.id && now - staticDemoRecovery.at < 1200) return;
    staticDemoRecovery = { id: service.id, at: now };
    dispatchStaticServiceOpen(service);
  }

  function showStaticAppScreen(nextState = null) {
    // Never flip to the app screen unless the user explicitly logged in this session and hasn't logged
    // out. Stops "auto-login on the login screen" + "auto re-login after logout": a still-alive
    // connection reporting loginOk (login screen shown via a flap or an unrecognized logout) no longer
    // flips the UI to the app on its own.
    if (!state.loginIntent || state.loggedOut) return false;
    const logic = staticLogic();
    if (!logic) return false;
    if (logic.state?.screen === "app" && !nextState) return true;
    try {
      if (nextState && typeof logic.setState === "function") {
        logic.setState({ screen: "app", ...nextState });
      } else if (typeof logic.login === "function") {
        logic.login();
      } else {
        logic.setState({ screen: "app", active: null, opening: false });
      }
      setTimeout(() => markStableServiceLayout(true), 0);
      return true;
    } catch {
      return false;
    }
  }

  function staticOpeningStateForService(service) {
    const activeName = String(service?.name || service?.id || state.browser.activeServiceName || state.browser.activeServiceId || "Dich vu");
    return {
      screen: "app",
      active: activeName,
      opening: true,
      showRunning: false,
      showOpening: true,
      showContent: false,
      openingName: activeName,
      openingTitle: SERVICE_BACKGROUND_LOADING_TEXT,
      openingText: SERVICE_BACKGROUND_LOADING_TEXT,
      openingMessage: SERVICE_BACKGROUND_LOADING_TEXT,
      openingStatus: SERVICE_BACKGROUND_LOADING_TEXT,
      loadingText: SERVICE_BACKGROUND_LOADING_TEXT,
      activeStatus: SERVICE_BACKGROUND_LOADING_TEXT
    };
  }

  function showStaticBrowserService(service, opening) {
    const logic = staticLogic();
    if (!logic) return false;
    const activeName = String(service?.name || service?.id || state.browser.activeServiceName || state.browser.activeServiceId || "Dich vu");
    const nextState = opening
      ? staticOpeningStateForService(service)
      : { screen: "app", active: activeName, opening: false };
    try {
      if (logic.state?.screen !== "app") {
        showStaticAppScreen(nextState);
      }
      logic.setState(nextState);
      setTimeout(() => {
        markStableServiceLayout(true);
        normalizeServiceLoadingText();
      }, 0);
      return true;
    } catch {
      return false;
    }
  }

  function clearStaticBrowserService() {
    const logic = staticLogic();
    try {
      if (logic?.closeService) {
        logic.closeService();
      } else if (logic?.setState) {
        logic.setState({ active: null, opening: false });
      }
    } catch {
      // UI fallback only.
    }
  }

  function clearStaticRunningPlaceholder() {
    const logic = staticLogic();
    try {
      if (logic?.setState) {
        logic.setState({ active: null, opening: false });
      }
    } catch {
      // UI fallback only. The real BrowserView state lives in Electron.
    }
  }

  // History row reads like Chrome history: PAGE/HISTORY TITLE (truncated) instead of the service name.
  function historyDisplayTitle(row) {
    let title = String(row?.title || "").trim();
    const svc = String(row?.serviceName || "").trim();
    if (title && svc) {
      for (const sep of [" - ", " | ", " – ", " — ", " · "]) {
        const suffix = (sep + svc).toLowerCase();
        if (title.toLowerCase().endsWith(suffix)) {
          title = title.slice(0, title.length - suffix.length).trim();
          break;
        }
      }
    }
    return (title || svc || row?.host || row?.url || "").slice(0, 90);
  }

  // Keep the displayed title fresh (ChatGPT/Claude set the conversation title AFTER load) + persist it.
  function updateHistoryTitleForActiveUrl(title) {
    const clean = String(title || "").trim();
    if (!clean) return;
    const url = cleanUrl(state.browser.lastState?.url || "");
    if (!url) return;
    let found = false;
    let updated = null;
    for (const row of state.urlHistory || []) {
      if (row.url === url) {
        found = true;
        if (row.title !== clean) {
          row.title = clean;
          updated = row;
        }
        break;
      }
    }
    if (updated) {
      saveLocalUrlHistory();
      refreshStaticUrlLogSoon();
      queueUrlHistoryPush(updated);
      return;
    }
    if (!found) {
      // No anchor row for this URL: its navigation/open record was DROPPED because no real title was
      // available yet. The real conversation title just arrived (browser:title), so record the session
      // now. recordUrlHistory -> normalize keeps it only if `clean` is a real title (a bare service
      // name is still skipped), so this never re-introduces untitled rows.
      recordUrlHistory({
        serviceId: state.browser.activeServiceId,
        serviceName: state.browser.activeServiceName,
        url,
        title: clean,
        action: "navigate",
        at: Date.now()
      });
    }
  }

  function staticUrlRows(staticState = {}) {
    const query = fold(staticState.urlQuery || "");
    // The bridge owns the date filter (state.urlTimeFilter): the design's date dropdown lives on a
    // different component than the one rendering this list, so its urlTime didn't reach here. The
    // bridge's click handler sets state.urlTimeFilter, which always wins.
    const curTime = state.urlTimeFilter || staticState.urlTime || "all";
    const daysMap = { today: 1, "7d": 7, "30d": 30, "90d": 90, "12m": 365, all: Infinity, custom: Infinity };
    const maxDays = daysMap[curTime] || Infinity;
    return [...(state.urlHistory || [])]
      .filter((row) => dayOffsetFromAt(row.at) < maxDays)
      .filter((row) => {
        // Ẩn dòng trỏ tới dịch vụ mà GÓI HIỆN TẠI CHẶN — không mở được nên không hiện (tránh bấm "Mở" ra lỗi
        // "Gói không dùng được dịch vụ này"). Resolve y hệt openHistoryUrl để khớp đúng dịch vụ sẽ mở.
        const svc = serviceFromUrl(row.url, row.serviceId, row.serviceName);
        if (svc?.id && planBlocksService(svc.id)) return false;
        return true;
      })
      .filter((row) => {
        if (!query) return true;
        return fold(`${row.serviceName} ${row.title} ${row.host} ${row.url}`).includes(query);
      })
      .map((row) => ({
        url: row.url,
        time: row.time || formatUrlTime(row.at),
        svc: historyDisplayTitle(row), // page/history title (truncated) instead of the service name
        initial: row.initial,
        bg: row.bg,
        onOpen: () => openHistoryUrl(row)
      }));
  }

  function liveServices() {
    const rows = state.services?.length ? state.services : loadServiceCache();
    if (!state.services?.length && rows.length) {
      state.services = rows;
      state.servicesSource = "cache";
    }
    return normalizeServiceRows(rows)
      .filter((service) => service?.id && service?.name && service.enabled !== false);
  }

  function serviceCreditCost(service) {
    const value = Number(
      service?.defaultCreditCost ??
      service?.creditCost ??
      service?.modelPolicy?.defaultCreditCost ??
      service?.modelPolicy?.creditCost ??
      1
    );
    return Math.max(1, Math.min(100000, Math.round(Number.isFinite(value) ? value : 1)));
  }

  function favoriteState(staticState, service) {
    const fav = staticState?.fav || {};
    return Boolean(fav[service?.id] || fav[service?.name]);
  }

  function toggleStaticFavorite(service) {
    const logic = staticLogic();
    if (!logic?.setState || !service?.id) return;
    const name = service.name || service.id;
    logic.setState((current) => {
      const fav = { ...(current?.fav || {}) };
      if (fav[service.id] || fav[name]) {
        delete fav[service.id];
        delete fav[name];
      } else {
        fav[service.id] = true;
      }
      return { fav };
    });
  }

  function serviceRowForStatic(service, staticState = {}, index = 0) {
    const meta = serviceMeta(service, service?.name);
    const name = String(service?.name || service?.id || "Dich vu");
    const activeId = state.browser.activeServiceId || "";
    const activeName = state.browser.activeServiceName || staticState.active || "";
    const isActive = String(service?.id || "") === activeId || fold(name) === fold(activeName);
    const opening = isActive && (state.browser.opening === true || staticState.opening === true);
    const running = isActive && !opening;
    const cost = serviceCreditCost(service);
    let btnLabel = "M\u1edf";
    let btnColor = "var(--text-2)";
    let btnBg = "var(--surface-3)";
    let btnBorder = "var(--border)";

    if (opening) {
      btnLabel = "\u0110ang n\u1ea1p";
      btnColor = "var(--ok-text)";
      btnBg = "var(--ok-soft)";
      btnBorder = "var(--ok-border)";
    } else if (running) {
      btnLabel = "\u0110ang ch\u1ea1y";
      btnColor = "var(--ok-text)";
      btnBg = "var(--ok-soft)";
      btnBorder = "var(--ok-border)";
    }

    const isFav = favoriteState(staticState, service);
    const open = () => openService(service);
    return {
      id: service.id,
      name,
      host: hostFromUrl(service.url),
      url: service.url,
      initial: meta.initial,
      bg: meta.bg,
      cost,
      costLabel: `\u2212${cost} cr`,
      rowBg: isActive ? "var(--brand-soft)" : "var(--surface)",
      rowBorder: isActive ? "var(--brand-border)" : "var(--border-soft)",
      btnLabel,
      btnColor,
      btnBg,
      btnBorder,
      rowHeight: "64px",
      buttonWidth: "92px",
      isFav,
      favColor: isFav ? "#f59e0b" : "var(--text-3)",
      favFill: isFav ? "#f59e0b" : "none",
      favTitle: isFav ? "B\u1ecf y\u00eau th\u00edch" : "Y\u00eau th\u00edch",
      onToggleFav: () => toggleStaticFavorite(service),
      onOpen: open,
      onUse: open,
      liveIndex: index
    };
  }

  function liveServiceRows(staticState = {}) {
    const query = fold(staticState.query || "");
    const rows = liveServices()
      .filter((service) => !query || fold(`${service.name} ${service.id} ${service.url}`).includes(query))
      .map((service, index) => serviceRowForStatic(service, staticState, index));
    return rows.sort((a, b) => (b.isFav ? 1 : 0) - (a.isFav ? 1 : 0));
  }

  function liveDemoRows(staticState = {}) {
    return liveServices().slice(0, 3).map((service, index) => {
      const row = serviceRowForStatic(service, staticState, index);
      const live = index === 0;
      return {
        name: row.name,
        initial: row.initial,
        bg: row.bg,
        live,
        rowBg: live ? "var(--brand-soft)" : "var(--surface)",
        rowBorder: live ? "var(--brand-border)" : "var(--border-soft)",
        stLabel: live ? "ch\u1ea1y" : "M\u1edf",
        stColor: live ? "var(--ok-text)" : "var(--text-3)",
        stBg: live ? "var(--ok-soft)" : "var(--surface-3)",
        stBorder: live ? "var(--ok-border)" : "var(--border-soft)"
      };
    });
  }

  function finiteNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  function formatCreditValue(value) {
    return Math.max(0, Math.round(finiteNumber(value))).toLocaleString("vi-VN");
  }

  function portalWallet() {
    return state.portal?.wallet || state.portal?.portal?.wallet || {};
  }

  function liveCreditSnapshot() {
    const account = state.account || {};
    const wallet = portalWallet();
    const usage = state.lastCreditUsage || {};
    // Is the balance REAL (came from a loaded source) vs the 0 fallback before /api/me/portal responds?
    // Needed so the low-credit warning never fires on a transient hydration 0 (user with 480 cr saw "còn 0").
    const balanceKnown = [account.balance, wallet.balance, usage.balance, usage.remaining].some((v) => Number.isFinite(Number(v)));
    let balance = finiteNumber(account.balance, wallet.balance, usage.balance, usage.remaining);
    // Anti-revert: after a charge settles, the post-debit balance is the truth. The account.me() poll
    // reads the App Server's JSON read-cache, which lags the Docker debit, so it can briefly report the
    // HIGHER pre-charge balance and visually "un-charge" the pill (the 657→649→657 flicker). While a
    // recent settle exists and the poll is higher, hold the settled value. A new charge refreshes the
    // anchor; once the poll catches up (≤ settled) the clamp is inert; a genuine top-up shows after the
    // TTL. Net: the balance only ever ticks DOWN as you chat, never flickers back up.
    const settle = state._lastSettle;
    if (settle && Number.isFinite(settle.balance) && balance > settle.balance && (Date.now() - settle.at) < 30000) {
      balance = settle.balance;
    }
    const spentToday = finiteNumber(account.spentToday, usage.creditCost);
    const lifetimeSpent = finiteNumber(account.lifetimeSpent, wallet.lifetimeSpent, spentToday);
    const lifetimeAdded = finiteNumber(account.lifetimeAdded, wallet.lifetimeAdded, balance + Math.max(lifetimeSpent, spentToday), balance);
    const quota = Math.max(lifetimeAdded, balance + Math.max(lifetimeSpent, spentToday), balance, 1);
    const used = Math.max(lifetimeSpent, spentToday, 0);
    // Real credit spent in the CURRENT calendar month (from /api/me spentThisMonth). The "Đã dùng
    // tháng này" card must show this, not lifetimeSpent. Fall back to spentToday, then 0.
    const usedThisMonth = Math.max(0, finiteNumber(account.spentThisMonth, usage.spentThisMonth, spentToday, 0));
    const pctUsed = Math.max(0, Math.min(100, Math.round((used / quota) * 100)));
    const pctRem = Math.max(0, Math.min(100, Math.round((balance / quota) * 100)));
    const pBarCol = pctRem < 15 ? "var(--danger)" : pctRem < 35 ? "#f59e0b" : "var(--brand)";
    return {
      balance,
      quota,
      used,
      usedThisMonth,
      spentToday,
      pctUsed,
      pctRem,
      pBarCol,
      known: balanceKnown,
      low: pctRem < 15 || balance <= 0,
      moneyBalance: finiteNumber(account.moneyBalance, wallet.moneyBalance, 0) // ví VND (từ /api/me)
    };
  }

  function creditLogRows(existingRows = []) {
    const usage = state.lastCreditUsage || {};
    const rows = Array.isArray(existingRows) ? existingRows.slice(0, 12) : [];
    if (!usage.serviceId && !usage.serviceName && usage.creditCost == null) return rows;
    const cost = finiteNumber(usage.creditCost);
    const at = usage.at || usage.createdAt || Date.now();
    const serviceName = usage.serviceName || serviceNameForId(usage.serviceId, usage.serviceId || "Dịch vụ");
    return [{
      model: usage.modelId || usage.detectedModelId || "model mặc định",
      service: serviceName,
      cost: cost ? `-${formatCreditValue(cost)} cr` : "0 cr",
      time: formatUrlTime(Number(at) || Date.now()),
      status: usage.allowed === false ? "Bị chặn" : "Đã trừ credit",
      color: usage.allowed === false ? "var(--danger)" : "var(--ok-text)"
    }, ...rows].slice(0, 12);
  }

  function applyLiveAccountVals(vals) {
    // ── "Hóa đơn & xuất VAT" recipient form: BLANK until saved, persisted per userId. Override the design's
    // demo vatCur with a draft seeded from the saved profile (state.portal.billing). Typing updates the draft
    // WITHOUT a re-render (no cursor jump); "Lưu thông tin" persists via the per-user billing endpoint, after
    // which the draft re-seeds from the freshly saved profile.
    {
      const b = userBillingProfile();
      const sig = JSON.stringify([b.legalName || "", b.taxCode || "", b.billingEmail || "", b.billingAddress || ""]);
      if (!state.vatDraft || state.vatDraftSig !== sig) {
        state.vatDraft = { name: b.legalName || "", tax: b.taxCode || "", email: b.billingEmail || "", addr: b.billingAddress || "" };
        state.vatDraftSig = sig;
      }
      const d = state.vatDraft;
      vals.vatCur = { name: d.name, tax: d.tax, mst: d.tax, email: d.email, addr: d.addr };
      vals.onVatName = (e) => { state.vatDraft.name = (e && e.target ? e.target.value : ""); };
      vals.onVatTax = (e) => { state.vatDraft.tax = (e && e.target ? e.target.value : ""); };
      vals.onVatEmail = (e) => { state.vatDraft.email = (e && e.target ? e.target.value : ""); };
      vals.onVatAddr = (e) => { state.vatDraft.addr = (e && e.target ? e.target.value : ""); };
      vals.onSaveVat = () => {
        const bridge = api();
        if (!bridge?.portal?.updateUserBilling) { showActionToast("Chưa sẵn sàng lưu", "error"); return; }
        const dr = state.vatDraft || {};
        bridge.portal.updateUserBilling({ legalName: dr.name || "", taxCode: dr.tax || "", billingEmail: dr.email || "", billingAddress: dr.addr || "", vatMode: "business" })
          .then((r) => {
            if (r && r.ok !== false) {
              if (r.userPortal) { state.portal = r.userPortal; state.portalReady = true; }
              state.vatDraftSig = null; // force re-seed from the saved profile on the next render
              showActionToast("Đã lưu thông tin hóa đơn", "ok");
              scheduleAccountStateRefresh(0);
            } else showActionToast(r?.error || "Lưu thất bại", "error");
          })
          .catch((e) => showActionToast(e?.message || "Lỗi lưu thông tin", "error"));
      };
      // Strip the baked SAMPLE MST placeholder ("0317433468") — the field is blank until saved, so the sample
      // placeholder just looked like real data. Keep the design's field labels (tab-aware) intact.
      if (vals.vatForm && /0317433468/.test(String(vals.vatForm.taxPh || ""))) vals.vatForm.taxPh = "Nhập mã số thuế";
      // "Doanh nghiệp · CENTRIX MEDIA" account chip → drive from the saved legal name (or drop the fake company).
      if (vals.acctTag && /CENTRIX MEDIA/i.test(String(vals.acctTag.label || ""))) {
        vals.acctTag.label = b.legalName ? ("Doanh nghiệp · " + b.legalName) : "Doanh nghiệp";
      }
      // SCREEN B ("Đơn hàng" → "Thông tin xuất hóa đơn VAT" panel) binds to vatInfo, which the bridge never set
      // → it always showed the baked CENTRIX MEDIA sample. Drive it from the REAL saved billing (empty-state
      // prompt until the user saves on the Hóa đơn tab). Keep the design's tab-aware typeLabel.
      vals.vatInfo = {
        typeLabel: (vals.vatInfo && vals.vatInfo.typeLabel) || "Xuất theo Doanh nghiệp",
        name: b.legalName || "Chưa cập nhật thông tin",
        mst: b.taxCode || "—",
        email: b.billingEmail || "—",
        addr: b.billingAddress || "Chưa cập nhật địa chỉ xuất hóa đơn",
      };
    }
    // Google-only login: the App User signs in with Google (password login was removed), so the "Bảo mật &
    // phiên đăng nhập" 2FA row is NOT a CentriX OTP switch — 2FA is managed by the user's Google account.
    // Reflect that (and hidePasswordButton() removes the meaningless "Đổi mật khẩu" button).
    if (Array.isArray(vals.setSecurity) && vals.setSecurity[0]) {
      vals.setSecurity[0] = {
        ...vals.setSecurity[0],
        label: "Bảo mật 2 lớp (2FA)",
        desc: "Quản lý bằng tài khoản Google của bạn (CentriX đăng nhập qua Google).",
        trackBg: "var(--brand)", knobX: "translateX(16px)",
        onToggle: () => showActionToast("2FA được quản lý trong tài khoản Google (myaccount.google.com → Bảo mật). Đăng nhập CentriX qua Google nên không có mã OTP riêng.")
      };
    }
    const credit = liveCreditSnapshot();
    const balanceFmt = formatCreditValue(credit.balance);
    const quotaFmt = formatCreditValue(credit.quota);
    const usedFmt = formatCreditValue(credit.used);
    vals.balance = credit.balance;
    vals.credit = credit.balance;
    vals.credits = credit.balance;
    vals.walletBalance = credit.balance;
    vals.creditBalance = credit.balance;
    vals.creditBalanceFmt = balanceFmt;
    vals.creditBalanceLabel = `${balanceFmt} cr`;
    vals.balanceFmt = balanceFmt;
    vals.walletBalanceFmt = balanceFmt;
    // Ví VND (số dư tiền thật) — cho pill/màn ví. Định dạng "1.234.567 đ".
    vals.moneyBalance = credit.moneyBalance;
    vals.moneyBalanceFmt = Number(credit.moneyBalance || 0).toLocaleString("vi-VN");
    vals.moneyBalanceLabel = Number(credit.moneyBalance || 0).toLocaleString("vi-VN") + " đ";
    vals.pBalFmt = balanceFmt;
    vals.pQuotaFmt = quotaFmt;
    vals.pUsedFmt = formatCreditValue(credit.usedThisMonth); // "Đã dùng tháng này" card = this month only
    vals.pPctRem = `${credit.pctRem}%`;
    vals.pPctUsed = `${credit.pctUsed}%`;
    vals.pBarCol = credit.pBarCol;
    // ── Low-credit warning, wired to the "Cảnh báo khi sắp hết credit" toggle (persisted per userId) ──────
    const lowWarnOn = userBillingProfile().notifyLowCredit !== false; // default ON
    const LOW_CREDIT_THRESHOLD = 50;                                  // warn ONLY when the real balance < 50 cr
    // Gate on credit.known so a transient hydration/cache-miss 0 (before /api/me + portal respond) NEVER
    // trips the warning — a user with 480 cr was getting "⚠️ còn 0 cr (dưới 50)" on load.
    const lowForWarn = credit.known && Number(credit.balance) < LOW_CREDIT_THRESHOLD;
    vals.pLowWarn = lowWarnOn && lowForWarn;                          // the overview banner respects the toggle
    // Make the Settings toggle REAL: reflect the persisted value + persist on change (was demo local state).
    if (Array.isArray(vals.setNotify) && vals.setNotify[0]) {
      vals.setNotify[0] = {
        ...vals.setNotify[0],
        label: "Cảnh báo khi sắp hết credit",
        desc: "Hiện cảnh báo khi số dư còn dưới 50 credit.",
        on: lowWarnOn,
        trackBg: lowWarnOn ? "var(--brand)" : "var(--surface-3)",
        knobX: lowWarnOn ? "translateX(17px)" : "translateX(0)",
        onToggle: () => {
          const bridge = api();
          if (!bridge?.portal?.updateUserBilling) return;
          const next = !(userBillingProfile().notifyLowCredit !== false);
          bridge.portal.updateUserBilling({ notifyLowCredit: next })
            .then((r) => {
              if (r && r.ok !== false) {
                if (r.userPortal) { state.portal = r.userPortal; state.portalReady = true; }
                if (!next) state._lowWarned = false;
                showActionToast(next ? "Đã bật cảnh báo sắp hết credit" : "Đã tắt cảnh báo sắp hết credit", "ok");
                scheduleAccountStateRefresh(0);
              } else showActionToast(r?.error || "Lưu thất bại", "error");
            })
            .catch((e) => showActionToast(e?.message || "Lỗi", "error"));
        }
      };
    }
    // Active alert: toast ONCE each time the balance crosses below 50 cr (only while the toggle is enabled).
    if (lowWarnOn && lowForWarn) {
      if (!state._lowWarned) { state._lowWarned = true; setTimeout(() => showActionToast("⚠️ Sắp hết credit — còn " + formatCreditValue(credit.balance) + " cr (dưới 50). Mua thêm để không gián đoạn.", "error"), 0); }
    } else if (!lowForWarn) {
      state._lowWarned = false;
    }
    vals.pLog = creditLogRows(vals.pLog);
    vals.pLogEmpty = Array.isArray(vals.pLog) ? vals.pLog.length === 0 : vals.pLogEmpty;
    // Feed the real wallet into the portal's own render vars so the "Tổng quan" cards / "Hoạt động
    // gần đây" / "Lịch sử" render the TRUE data on the FIRST paint — never the sample seed. (The
    // template's renderVals returns `usage`, `activity`, pBalFmt/pUsedFmt/pPctRem; overriding them
    // here is what makes navigating to those tabs flash-free, vs. DOM-patching after the seed paints.)
    const account = state.account || {};
    const history = (Array.isArray(account.recentHistory) && account.recentHistory.length)
      ? account.recentHistory
      : (account.recentTransactions || []);
    if (Array.isArray(history) && history.length) {
      vals.usage = history.slice(0, 40).map(usageRowObj);
    }
    if (Array.isArray(account.recentTransactions) && account.recentTransactions.length) {
      vals.activity = account.recentTransactions.slice(0, 8).map(activityRowObj);
    } else {
      // Zero-transaction account: OVERRIDE the baked sample feed (4 fake rows "Dùng gpt-5-5 · -1 credit" …)
      // with an empty list so a fresh user never sees fabricated "Hoạt động gần đây".
      vals.activity = [];
    }
    // The "Tổng quan" overview cards are a `stats` array ({label,value,cap,...}) — override the credit
    // ones in-place (keep the card styling the design's .map added) so they render the real wallet on
    // the first paint instead of the seed (Số dư 320 / Đã dùng 680).
    if (Array.isArray(vals.stats)) {
      let usedCard = null, creditIdx = -1;
      vals.stats.forEach((st, i) => {
        const label = String(st && st.label || "");
        if (/^Số dư credit$/i.test(label)) {
          st.value = balanceFmt;
          st.cap = `${credit.pctRem}% hạn mức còn lại`;
          creditIdx = i;
        } else if (/Đã dùng tháng này/i.test(label)) {
          st.value = formatCreditValue(credit.usedThisMonth);
          st.cap = `trên ${quotaFmt} credit`;
          usedCard = st;
        } else if (/^Thiết bị$/i.test(label)) {
          // 4th tile ships hardcoded "2 / 3 đang đăng nhập" — product enforces ONE active device per
          // account, so show the real live-session count from portal.devices instead of the seed.
          st.value = `${Math.max(1, liveDeviceCount())} / 1`;
          st.cap = "đang đăng nhập · giới hạn 1 thiết bị";
        }
      });
      // THẺ "SỐ DƯ VNĐ" — ví tiền thật, QUAN TRỌNG NHẤT → để ĐẦU HÀNG + tô XANH (clone style thẻ credit đang xanh).
      // Idempotent: đã có thì chỉ cập nhật giá trị.
      const existingVnd = vals.stats.find((s) => /^Số dư VNĐ$/i.test(String(s && s.label || "")));
      const creditCard = creditIdx >= 0 ? vals.stats[creditIdx] : null;
      if (existingVnd) {
        existingVnd.value = vals.moneyBalanceLabel;
      } else if (creditCard) {
        const vndCard = { ...creditCard, label: "SỐ DƯ VNĐ", value: vals.moneyBalanceLabel, cap: "Nạp tiền để mua credit / gói cước" };
        vals.stats.unshift(vndCard); // đưa lên ĐẦU TIÊN (trước thẻ credit)
      }
    }
    // "Tiêu thụ theo dịch vụ · kỳ này" (pBreak bars) + "Khấu trừ theo thời gian thực" (pLog) — both ship
    // as demo. Build them from the user's REAL debits (recentTransactions): pBreak aggregates credit per
    // model, pLog lists each deduction (model · số dư còn · −X cr · giờ). Same colour per model in both.
    const debits = (Array.isArray(account.recentTransactions) ? account.recentTransactions : [])
      .filter((tx) => String(tx.type) === "debit" && Number(tx.amountDelta) < 0);
    if (debits.length) {
      const palette = ["#16a34a", "#f97316", "#3b82f6", "#ef4444", "#a855f7", "#06b6d4", "#eab308"];
      const modelOf = (tx) => tx.modelId || serviceNameForId(tx.serviceId, "") || "model";
      const byModel = new Map();
      for (const tx of debits) byModel.set(modelOf(tx), (byModel.get(modelOf(tx)) || 0) + Math.abs(Number(tx.amountDelta) || 0));
      const ranked = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
      const total = ranked.reduce((sum, [, cr]) => sum + cr, 0) || 1;
      const colorOf = new Map();
      ranked.forEach(([name], index) => colorOf.set(name, palette[index % palette.length]));
      vals.pBreak = ranked.map(([name, cr]) => ({
        dot: colorOf.get(name),
        name,
        valLabel: `${formatCreditValue(cr)} cr`,
        pctStr: `${Math.round((cr / total) * 100)}%`
      }));
      vals.pLog = debits
        .slice()
        .sort((a, b) => (Date.parse(b.createdAt || "") || 0) - (Date.parse(a.createdAt || "") || 0))
        .slice(0, 12)
        .map((tx) => ({
          dot: colorOf.get(modelOf(tx)) || palette[0],
          model: modelOf(tx),
          balLabel: `Số dư còn ${formatCreditValue(Number(tx.balanceAfter || 0))} cr`,
          costLabel: `−${formatCreditValue(Math.abs(Number(tx.amountDelta) || 0))} cr`,
          ts: formatClockTime(tx.createdAt)
        }));
    }
    // Organisation identity: the account-card tag (acctTag) + the dashboard org badge (orgShort/orgName/
    // myDept/myRole) ship as a demo ("Doanh nghiệp · CENTRIX MEDIA" / "Quản lý"). Drive them from the
    // user's REAL membership: has org → show the real org name + role; no org → a neutral "Cá nhân" tag.
    const org = currentOrgInfo();
    if (org) {
      vals.acctTag = { label: `${org.name} · ${org.role}`, color: "var(--brand)", bg: "var(--brand-soft)", border: "var(--brand-border)" };
      vals.orgShort = org.name;
      vals.orgName = org.name;
      vals.myRole = org.role;
      if (org.dept) vals.myDept = org.dept;
    } else {
      vals.acctTag = { label: "Cá nhân", color: "var(--text-2)", bg: "var(--surface-3)", border: "var(--border)" };
      vals.myRole = "";
    }
    // "Mua credit" order summary — drive Tóm tắt đơn / Tổng cộng from the REAL selected package + promo
    // (the template ships a demo 500-credit / 139.000đ summary that showed even before any selection).
    const buyPkg = portalPackagesList().find((p) => p.id === state.selectedBuyPkgId);
    if (buyPkg) {
      const baseCredits = (Number(buyPkg.credits) || 0) + (Number(buyPkg.bonusCredits) || 0);
      const basePrice = Number(buyPkg.price) || 0;
      const eff = promoEffect(state.activeBuyPromo, basePrice);
      const total = Math.max(0, basePrice - eff.discount);
      vals.buyCredit = formatCreditValue(baseCredits + eff.bonus);
      vals.buyPrice = basePrice.toLocaleString("vi-VN") + "đ";
      vals.buyTotal = total.toLocaleString("vi-VN") + "đ";
      vals.buyHasPromo = !!(state.activeBuyPromo && (eff.discount > 0 || eff.bonus > 0));
      vals.buyDiscountFmt = vals.buyHasPromo ? promoLabelText(state.activeBuyPromo, eff.discount, eff.bonus) : "—";
    } else {
      vals.buyCredit = "—";
      vals.buyPrice = "—";
      vals.buyTotal = "—";
      vals.buyHasPromo = false;
      vals.buyDiscountFmt = "—";
    }
    vals.buyPay = "Ví VNĐ";
    return vals;
  }

  // The logged-in user's organisation + role (from the portal membership), or null when not in any org.
  function currentOrgInfo() {
    // DEPLOY BUILD: never surface org identity. Returning null makes acctTag fall back to the neutral
    // "Cá nhân" tag, so the org badge ("ACME Test Co · Chủ sở hữu") cannot stick in the account popup or
    // the sidebar account chip — even for an account that really is an org owner. (Logic below kept but
    // unreachable on this build; restore by removing this return to re-enable org identity.)
    return null;
    if (!state.portalReady) return null; // don't surface org identity (acctTag/orgName/role) until a fresh per-account portal fetch confirms it — kills the stale "ACME Test Co" flash
    const portalData = (state.portal && state.portal.portal) || state.portal || {};
    const orgs = portalData.organization || portalData.organizations || [];
    const members = portalData.members || [];
    // Require BOTH an org AND the caller's own membership row — otherwise the account popup badges/chip
    // (acctTag/myRole, hydrated from here) showed a stale org for a non-member (the org-leak symptom).
    if (!Array.isArray(orgs) || !orgs.length || !Array.isArray(members) || !members.length) return null;
    const org = orgs[0] || {};
    const member = members[0] || {};
    const dept = (portalData.departments || []).find((item) => item.id === member.departmentId);
    return {
      name: org.name || org.short || "Tổ chức",
      role: member.role || "Thành viên",
      dept: (dept && dept.name) || ""
    };
  }

  function formatClockTime(at) {
    const date = at ? new Date(at) : new Date();
    if (!Number.isFinite(date.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  }

  // Row objects matching the portal templates so renderVals can emit real data directly.
  function usageRowObj(t) {
    const amt = Number(t.amountDelta || 0);
    const kind = String(t.kind || t.type || "");
    const positive = kind === "topup" || (kind === "adjust" && amt > 0);
    if (kind === "open-service") {
      return { accent: "var(--brand-border)", bg: "transparent", title: `Mở dịch vụ ${t.serviceName || serviceNameForId(t.serviceId, t.serviceId || "dịch vụ")}`, time: formatHistoryDateTime(t.createdAt), metaColor: "var(--text-3)", meta: "phiên mới" };
    }
    if (kind === "login" || kind === "login-new-device") {
      return { accent: "var(--text-3)", bg: "transparent", title: `Đăng nhập${t.email ? " · " + t.email : ""}`, time: formatHistoryDateTime(t.createdAt), metaColor: "var(--text-3)", meta: kind === "login-new-device" ? "thiết bị mới" : "đăng nhập" };
    }
    const svc = serviceNameForId(t.serviceId, "");
    return {
      accent: kind === "debit" ? "var(--brand)" : positive ? "var(--ok)" : kind === "blocked" ? "var(--danger)" : "var(--text-3)",
      bg: positive ? "var(--ok-soft)" : "transparent",
      title: kind === "debit" ? `Dùng ${t.modelId || "model"}${svc ? " · " + svc : ""}`
        : positive ? "Nạp credit"
        : (kind === "adjust" && amt < 0) ? "Điều chỉnh credit"
        : kind === "blocked" ? `Chặn ${t.modelId || "model"}`
        : (t.reason || "Giao dịch"),
      time: formatHistoryDateTime(t.createdAt),
      metaColor: positive ? "var(--ok-text)" : kind === "blocked" ? "var(--danger)" : "var(--brand)",
      meta: kind === "blocked" ? "Bị chặn" : `${amt >= 0 ? "+" : "−"}${formatCreditValue(Math.abs(amt))} credit`
    };
  }

  function activityRowObj(t) {
    const amt = Number(t.amountDelta || 0);
    const kind = String(t.kind || t.type || "");
    const positive = kind === "topup" || (kind === "adjust" && amt > 0);
    const dot = kind === "debit" ? "var(--brand)" : positive ? "var(--ok)" : kind === "blocked" ? "var(--danger)" : "var(--text-3)";
    const svc = serviceNameForId(t.serviceId, "");
    const title = kind === "debit" ? `Dùng ${t.modelId || "model"}${svc ? " · " + svc : ""} · ${amt >= 0 ? "+" : "−"}${formatCreditValue(Math.abs(amt))} credit`
      : positive ? `Nạp credit · +${formatCreditValue(Math.abs(amt))} credit`
      : kind === "blocked" ? `Chặn ${t.modelId || "model"}`
      : `${t.reason || "Giao dịch"} · ${amt >= 0 ? "+" : "−"}${formatCreditValue(Math.abs(amt))} credit`;
    return { dot, title, time: formatUrlTime(Date.parse(t.createdAt || "") || Date.now()) };
  }

  // PERF: cheap layout test on a SINGLE element (used AFTER a text-only find) instead of testing
  // offsetParent/getClientRects inside a querySelectorAll('div').find() predicate (a forced reflow ×N divs).
  const isLaidOut = (el) => !!el && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0));
  // PERF: a global "did the DOM structurally change?" gate + per-anchor leaf cache. The widgetObserver sets
  // domDirty=true on a real (non-chat) mutation and clears it after patching; the 1500ms credit sweep + its
  // fan-outs then reuse the cached header lookups (O(1)) instead of a full-DOM querySelectorAll('div') scan
  // every tick. ONLY childList-rebuilding patchers use this — text/identity reverters stay ungated so a
  // characterData-only seed revert (not seen by a childList observer) is still repaired every tick.
  let domDirty = true;
  const _leafCache = new Map();
  function findLeafByText(key, re) {
    if (!domDirty) {
      const c = _leafCache.get(key);
      if (c === null) return null;
      if (c && c.isConnected && c.children.length === 0 && re.test((c.textContent || "").trim())) return c;
    }
    const f = Array.from(document.querySelectorAll("div")).find((el) => el.children.length === 0 && re.test((el.textContent || "").trim())) || null;
    _leafCache.set(key, f);
    return f;
  }

  let lastCreditWalkText = null;
  let lastCreditWalkAt = 0;
  function patchVisibleCreditTexts() {
    if (!document.body) return;
    const credit = liveCreditSnapshot();
    const balanceText = `${formatCreditValue(credit.balance)} cr`;
    // The full-body TreeWalker (scans every text node) is the expensive part. Only run it when the
    // balance changed or every ~3s as a catch-all — the per-card patchers below always run and cover
    // the common dashboard seed, so skipping the walk on unchanged-balance ticks removes periodic jank.
    const nowMs = Date.now();
    const catchAll = (balanceText !== lastCreditWalkText || nowMs - lastCreditWalkAt >= 3000);
    if (catchAll) {
      lastCreditWalkText = balanceText;
      lastCreditWalkAt = nowMs;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const replacements = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.nodeValue || "";
        if (!/(số dư|so du|còn|con).{0,16}(\d[\d.,\s]*)\s*(cr|credit)/i.test(text)) continue;
        let next = text
          .replace(/Số dư\s*:\s*[\d.,\s]+\s*cr/gi, `Số dư: ${balanceText}`)
          .replace(/So du\s*:\s*[\d.,\s]+\s*cr/gi, `Số dư: ${balanceText}`)
          .replace(/Số dư còn\s*[\d.,\s]+\s*cr/gi, `Số dư còn ${balanceText}`)
          .replace(/Con\s*[\d.,\s]+\s*credit/gi, `Còn ${balanceText}`)
          .replace(/Còn\s*[\d.,\s]+\s*credit/gi, `Còn ${balanceText}`);
        if (next !== text) replacements.push([node, next]);
      }
      for (const [node, next] of replacements) node.nodeValue = next;
    }
    // Catch-all: on the ~3s credit-walk tick, force the anchor caches to re-scan fresh this sweep, then
    // restore the resting domDirty so in-between idle ticks stay O(1). Covers the rare case of a screen
    // appearing WITHOUT a childList mutation (which the observer's domDirty flip wouldn't have caught).
    const _restoreDirty = domDirty;
    if (catchAll) domDirty = true;
    patchDashboardCreditCards();
    patchRecentActivity();
    patchUsageHistory();
    patchOrders();
    patchInvoices();
    patchDevices();
    patchSupport();
    patchChatAutoScroll();
    patchBuyPackages();
    ensureWalletNav(); // chèn menu "Ví tiền" vào thanh nav (idempotent)
    patchReportAudit();
    patchPricingTable();
    patchOrgSettingsView();
    hideOrgSettingsSection();
    applyAccountIdentity();
    patchMenuAccountName(); // menu/bar name shows the account's Họ và tên (not the email-derived fallback)
    patchAccountGooglePanel();
    restoreAccountFields();
    restoreVatFields(); // "Hóa đơn" VAT recipient form — keep the 4 inputs on the live draft (editable + saveable)
    hideOrdersVatUpdateBtn(); // Orders VAT panel is display-only → remove its "Cập nhật thông tin" button
    hidePasswordButton(); // AFTER patchAccountGooglePanel: it hides leaf "Đổi mật khẩu" incl the card heading;
    // if it ran first the security-card patch could no longer find its (now-hidden) heading anchor → the whole
    // change-password FORM stayed on screen for a Google-login account.
    syncUserTheme();
    applyOrgVisibility();
    // hideUnusedTabs(); // 2026-06-25: un-hidden at user request — all 5 nav tabs (Mua credit/Gói cước/Hóa đơn/Đơn hàng/Cài đặt) now shown. Re-enable this call to hide them again.
    applyPersonalPanelRow();
    patchOrgAdminPanel();
    maybeRevealAfterHydration();
    hideLoginCredUI();
    patchLoginHero();
    patchLoginForm();
    if (catchAll) domDirty = _restoreDirty;
  }

  // ── Account identity ─────────────────────────────────────────────────────────────────
  // The design ships a sample profile (name "Trần Xuân Lộc" / "Phạm Khánh Linh", email
  // trxuanloc.28@gmail.com) baked into several screens (profile card, billing/VAT personal
  // info). Those are static child components, so once logged in they still show the sample
  // identity instead of the real account. Patch them to the live account, same approach as
  // the credit widgets. Email is authoritative (always present); name uses the account's
  // display name when available, else a readable form derived from the email.
  const IDENTITY_SAMPLE_EMAILS = ["trxuanloc.28@gmail.com"];
  const IDENTITY_SAMPLE_NAMES = ["Trần Xuân Lộc", "Phạm Khánh Linh"];
  // The account name/email in the popup menu + the always-mounted bottom account bar are STATIC baked text
  // that applyAccountIdentity swaps in place. Track EVERY identity applied this session (NFC-normalized) so any
  // node that later mounts still holding a previous account's name/email gets rewritten to the current account.
  const appliedEmails = new Set(), appliedNames = new Set();

  function displayNameFromEmail(email) {
    const local = String(email || "").split("@")[0] || "";
    if (!local) return "";
    return local
      .replace(/[._\-+]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  function accountIdentity() {
    // Resolve the live email from the most reliable source available. /api/me does NOT return an
    // email or name (the account object is wallet-only), and the cached credit blob only carries the
    // userId — so state.account.email is almost always empty. The email the user actually authenticated
    // with lives in state.loginDraft.email (set on every connection.login, line ~3761) and, when
    // "remember" is on, in the persisted saved-login blob. Without this fallback accountIdentity returned
    // null, applyAccountIdentity bailed at `if (!id.email) return`, and the "Tài khoản" tab stayed on the
    // demo "Trần Xuân Lộc" forever.
    const account = state.account || loadCreditCache() || {};
    let email = String(account.email || account.account?.email || "").trim();
    if (!email) email = String(state.loginDraft?.email || "").trim();
    if (!email) {
      try { email = String((loadSavedLogin() || {}).email || "").trim(); } catch { /* ignore */ }
    }
    if (!email) return null;
    const name =
      String(account.name || account.user?.name || account.displayName || "").trim() ||
      displayNameFromEmail(email);
    return { email, name };
  }

  // ── Account tab for Google-login (no password) ──────────────────────────────────────────────────
  // App User logs in with Google ONLY, so: the Email is the Google identity + the match-by-email login
  // key (lock it), there is no password to change (replace "Đổi mật khẩu" with a "Đăng nhập & Bảo mật"
  // card), and the masked sample phone ("084xxx939") must not stick. The phone has no backend field, so
  // we persist a typed number locally per-account (survives reloads on this device).
  // Editable account-tab fields (Họ và tên, SĐT) are persisted LOCALLY per-account (by email) with PRESENCE
  // semantics: once the user touches a field we store its value INCLUDING an empty string, so "cleared" is an
  // intentional, respected state (not "never set"). This local store is authoritative over the design's baked
  // sample identity AND the Google display name, so the user's own value/blank always wins on every render
  // tick. Name/phone are ALSO pushed to the backend (best-effort, multi-device) on Save. Legacy phone-only key
  // centrixUserAccountPhone is migrated on read.
  const ACCOUNT_EDIT_KEY = "centrixUserAccountEdits";
  const ACCOUNT_PHONE_KEY = "centrixUserAccountPhone"; // legacy (phone only) — migrated into ACCOUNT_EDIT_KEY
  function accountEdits(email) {
    let rec = {};
    try { const r = (JSON.parse(localStorage.getItem(ACCOUNT_EDIT_KEY) || "{}"))[email]; if (r && typeof r === "object") rec = { ...r }; } catch { rec = {}; }
    if (!("phone" in rec)) {
      try { const legacy = (JSON.parse(localStorage.getItem(ACCOUNT_PHONE_KEY) || "{}"))[email]; if (typeof legacy === "string" && legacy) rec.phone = legacy; } catch { /* ignore */ }
    }
    return rec;
  }
  function setAccountEdit(email, field, value) {
    if (!email) return;
    try {
      const all = JSON.parse(localStorage.getItem(ACCOUNT_EDIT_KEY) || "{}");
      const rec = (all[email] && typeof all[email] === "object") ? all[email] : {};
      rec[field] = String(value == null ? "" : value);
      all[email] = rec;
      localStorage.setItem(ACCOUNT_EDIT_KEY, JSON.stringify(all));
    } catch { /* ignore */ }
  }
  // Persist the editable account-tab fields (Họ và tên, SĐT) to the BACKEND per-user profile (userBilling record
  // via updateUserBilling; read back via state.portal.billing) so they SYNC across every device. The design's
  // "Lưu thay đổi" is a no-op stub; Email is the Google identity (locked) → never touched here.
  // Map labelFold → input for the account-form card (the card holding the "Email" field). Field structure:
  // <wrap><div>LABEL</div><input></wrap>, so a field's label is its input's sibling leaf <div>.
  function accountFormInputs() {
    const emailInput = findLabeledAccountInput("email");
    if (!emailInput) return {};
    let card = emailInput.parentElement;
    for (let i = 0; i < 6 && card; i += 1) { if (card.querySelectorAll("input").length >= 2) break; card = card.parentElement; }
    if (!card) return {};
    const out = {};
    for (const input of card.querySelectorAll("input")) {
      const wrap = input.parentElement;
      const label = wrap && Array.from(wrap.children).find((c) => c.tagName === "DIV" && c.childElementCount === 0 && (c.textContent || "").trim());
      const lf = label ? fold((label.textContent || "").trim()) : "";
      if (lf) out[lf] = input;
    }
    return out;
  }
  function saveAccountFieldsNow() {
    const id = accountIdentity();
    const inputs = accountFormInputs();
    if (!inputs["ho va ten"] && !inputs["so dien thoai"]) { showActionToast("Chưa sẵn sàng lưu", "error"); return; }
    const nameVal = inputs["ho va ten"] ? String(inputs["ho va ten"].value || "").trim() : undefined;
    const phoneRaw = inputs["so dien thoai"] ? String(inputs["so dien thoai"].value || "").trim() : undefined;
    const phoneVal = phoneRaw !== undefined && /x{2,}/i.test(phoneRaw) ? "" : phoneRaw; // masked sample 084xxx939 → empty
    // 1) Persist LOCALLY (authoritative, presence-aware) so it survives reload even if the backend has no
    //    matching field — this is what makes a cleared/custom name+phone actually stick.
    if (id?.email) {
      if (nameVal !== undefined) setAccountEdit(id.email, "name", nameVal);
      if (phoneVal !== undefined) setAccountEdit(id.email, "phone", phoneVal);
    }
    restoreAccountFields(); // reflect the saved values immediately
    // 2) Best-effort backend sync (multi-device). Email = Google identity (locked) → never sent.
    const bridge = api();
    const payload = {};
    if (nameVal !== undefined) payload.accountName = nameVal;
    if (phoneVal) payload.phone = phoneVal;
    if (!bridge?.portal?.updateUserBilling || !Object.keys(payload).length) { showActionToast("Đã lưu thông tin tài khoản", "ok"); return; }
    bridge.portal.updateUserBilling(payload)
      .then((r) => {
        if (r && r.ok !== false) {
          if (r.userPortal) { state.portal = r.userPortal; state.portalReady = true; }
          showActionToast("Đã lưu thông tin tài khoản", "ok");
          scheduleAccountStateRefresh(0);
        } else showActionToast("Đã lưu (cục bộ) — đồng bộ máy chủ lỗi", "ok");
      })
      .catch(() => showActionToast("Đã lưu (cục bộ) — đồng bộ máy chủ lỗi", "ok"));
  }
  // Re-apply the saved (BACKEND, multi-device) account profile onto the form each tick, AFTER applyAccountIdentity
  // (which would otherwise revert a custom "Họ và tên" to the Google name). Never touches a field being edited.
  function restoreAccountFields() {
    if (!document.body || loginScreenShowing()) return;
    const id = accountIdentity();
    const b = userBillingProfile() || {};
    const edits = id?.email ? accountEdits(id.email) : {};
    const inputs = accountFormInputs();
    const nameInput = inputs["ho va ten"];
    const phoneInput = inputs["so dien thoai"];
    // Tag the inputs so the delegated `input` listener can persist keystrokes to the right field.
    if (nameInput) nameInput.dataset.cxAcctField = "name";
    if (phoneInput) phoneInput.dataset.cxAcctField = "phone";
    // Name: the user's LOCAL edit (incl. an intentional empty string) wins; else the backend accountName;
    // else leave whatever applyAccountIdentity already mapped (the Google display name — never the sample).
    if (nameInput && nameInput !== document.activeElement) {
      let val;
      if ("name" in edits) val = edits.name;
      else if (b.accountName) val = String(b.accountName);
      if (val !== undefined && String(nameInput.value || "") !== val) nameInput.value = val;
    }
    // Phone: local edit (incl. empty) wins; else backend phone; else clear the masked sample "084xxx939".
    if (phoneInput && phoneInput !== document.activeElement) {
      let val;
      if ("phone" in edits) val = edits.phone;
      else if (b.phone) val = String(b.phone);
      else if (/x{2,}/i.test(String(phoneInput.value || ""))) val = "";
      if (val !== undefined) {
        if (String(phoneInput.value || "") !== val) phoneInput.value = val;
        if (!val && !phoneInput.placeholder) phoneInput.placeholder = "Nhập số điện thoại";
      }
    }
  }
  // ── "Hóa đơn & xuất VAT" recipient form (Screen A) — same DOM-patch triad as the account fields ──────────
  // The design's renderVals onVat*/onSaveVat handlers don't take (bound once to the design's editVat/flash),
  // so typing reverted + Save was a no-op. We drive the 4 inputs authoritatively from state.vatDraft each tick
  // (a capturing `input` listener keeps vatDraft synced with keystrokes; "Lưu thông tin" is intercepted →
  // updateUserBilling). The card is anchored by its heading; labels differ Cá nhân vs Doanh nghiệp so we match
  // the 4 inputs by POSITION (name, tax, email, addr) not label.
  function vatFormInputs() {
    try {
      // Anchor on the recipient card via ANY reliable marker (robust to the exact heading markup / tab labels):
      // (1) the "Thông tin người nhận hóa đơn" heading (folded, substring), or (2) the "Xuất hóa đơn mới nhất"
      // button which is unique to this form. Then take the card's first 4 inputs = name/tax/email/addr in order.
      let anchor = Array.from(document.querySelectorAll("div,span")).find(
        (el) => el.children.length === 0 && /thong tin nguoi nhan hoa don/.test(fold(el.textContent || "")) && el.offsetParent !== null);
      if (!anchor) {
        anchor = Array.from(document.querySelectorAll("button,[role='button']")).find(
          (el) => /xuat hoa don moi nhat/.test(fold(el.textContent || "")) && el.offsetParent !== null);
      }
      if (!anchor) return null;
      let card = anchor.parentElement;
      for (let i = 0; i < 9 && card; i += 1) { if (card.querySelectorAll("input").length >= 4) break; card = card.parentElement; }
      if (!card || card.querySelectorAll("input").length < 4) return null;
      const inputs = Array.from(card.querySelectorAll("input")).slice(0, 4);
      return { name: inputs[0], tax: inputs[1], email: inputs[2], addr: inputs[3], card };
    } catch { return null; }
  }
  function restoreVatFields() {
    if (!document.body || loginScreenShowing()) return;
    const inputs = vatFormInputs();
    if (!inputs) return; // invoice recipient form not visible
    if (!state.vatDraft) {
      const b = userBillingProfile() || {};
      state.vatDraft = { name: b.legalName || "", tax: b.taxCode || "", email: b.billingEmail || "", addr: b.billingAddress || "" };
    }
    const d = state.vatDraft;
    const apply = (input, field) => {
      if (!input) return;
      input.dataset.cxVatField = field;
      if (input === document.activeElement) return; // never fight the field being typed in
      const val = String(d[field] == null ? "" : d[field]);
      if (String(input.value || "") !== val) input.value = val;
    };
    apply(inputs.name, "name");
    apply(inputs.tax, "tax");
    apply(inputs.email, "email");
    apply(inputs.addr, "addr");
  }
  function saveVatFieldsNow() {
    const inputs = vatFormInputs();
    const d = state.vatDraft || {};
    const payload = {
      legalName: String((inputs && inputs.name ? inputs.name.value : d.name) || "").trim(),
      taxCode: String((inputs && inputs.tax ? inputs.tax.value : d.tax) || "").trim(),
      billingEmail: String((inputs && inputs.email ? inputs.email.value : d.email) || "").trim(),
      billingAddress: String((inputs && inputs.addr ? inputs.addr.value : d.addr) || "").trim(),
      vatMode: "business",
    };
    state.vatDraft = { name: payload.legalName, tax: payload.taxCode, email: payload.billingEmail, addr: payload.billingAddress };
    const bridge = api();
    if (!bridge?.portal?.updateUserBilling) { showActionToast("Chưa sẵn sàng lưu", "error"); return; }
    bridge.portal.updateUserBilling(payload)
      .then((r) => {
        if (r && r.ok !== false) {
          if (r.userPortal) { state.portal = r.userPortal; state.portalReady = true; }
          state.vatDraftSig = null; // re-seed from the freshly saved profile on the next render
          showActionToast("Đã lưu thông tin hóa đơn", "ok");
          scheduleAccountStateRefresh(0);
        } else showActionToast(r?.error || "Lưu thất bại", "error");
      })
      .catch((e) => showActionToast(e?.message || "Lỗi lưu thông tin", "error"));
  }
  // The Orders "Thông tin xuất hóa đơn VAT" panel is DISPLAY-ONLY (editing happens on the Hóa đơn tab), so
  // remove its "Cập nhật thông tin" button (which was a no-op flash anyway).
  function hideOrdersVatUpdateBtn() {
    try {
      const heading = Array.from(document.querySelectorAll("div,span")).find(
        (el) => el.children.length === 0 && /thong tin xuat hoa don vat/.test(fold(el.textContent || "")) && el.offsetParent !== null);
      if (!heading) return;
      let panel = heading.parentElement;
      for (let i = 0; i < 6 && panel; i += 1) { if (panel.querySelector("button,[role='button']")) break; panel = panel.parentElement; }
      if (!panel) return;
      for (const btn of panel.querySelectorAll("button,[role='button']")) {
        if (/^cap nhat thong tin$/.test(fold((btn.textContent || "").trim())) && btn.style.display !== "none") btn.style.display = "none";
      }
    } catch { /* ignore */ }
  }
  // Find an account-form <input> by its uppercase label div ("EMAIL", "SỐ ĐIỆN THOẠI", …).
  function findLabeledAccountInput(labelText) {
    const want = fold(labelText);
    for (const label of document.querySelectorAll("div")) {
      if (label.children.length) continue;
      if (fold((label.textContent || "").trim()) !== want) continue;
      const input = label.parentElement && label.parentElement.querySelector("input");
      if (input) return input;
    }
    return null;
  }
  function patchAccountSecurityCard(email) {
    const heading = Array.from(document.querySelectorAll("div"))
      .find((el) => el.children.length === 0 && /^Đổi mật khẩu$/i.test((el.textContent || "").trim()));
    if (!heading) return;
    let card = heading.parentElement;
    for (let i = 0; i < 5 && card; i += 1) {
      if (/box-shadow/.test((card.getAttribute && card.getAttribute("style")) || "")) break;
      card = card.parentElement;
    }
    if (!card || !/box-shadow/.test((card.getAttribute && card.getAttribute("style")) || "")) return;
    if (card.dataset.cxGooglePanel === "1") return;
    card.dataset.cxGooglePanel = "1";
    card.innerHTML = `
      <div style="font-size:17px;font-weight:700;color:var(--text);">Đăng nhập & Bảo mật</div>
      <div style="display:flex;align-items:center;gap:12px;border:1px solid var(--border-soft);border-radius:12px;padding:14px 16px;background:var(--surface-2);margin-top:16px;">
        <div style="width:38px;height:38px;border-radius:50%;background:#fff;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;font:900 18px Segoe UI,system-ui,sans-serif;color:#4285F4;">G</div>
        <div style="min-width:0;"><div style="font-size:13.5px;font-weight:700;color:var(--text);">Đã liên kết Google</div><div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(email)}</div></div>
      </div>
      <div style="font-size:12px;color:var(--text-3);margin-top:13px;line-height:1.55;">Tài khoản này đăng nhập bằng Google nên không có mật khẩu riêng tại CentriX. Quản lý mật khẩu &amp; bảo mật ngay trên tài khoản Google của bạn.</div>
      <button type="button" data-cx-account-action="google-manage" style="width:100%;margin-top:16px;height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text);font-weight:700;font-size:13.5px;cursor:pointer;">Quản lý trên Google</button>
      <button type="button" data-cx-account-action="signout-all" style="width:100%;margin-top:10px;height:42px;border:1px solid #fecaca;border-radius:10px;background:var(--surface);color:#dc2626;font-weight:700;font-size:13.5px;cursor:pointer;">Đăng xuất tất cả thiết bị</button>
      <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border-soft,#e2e8f0);">
        <div style="font-size:13px;font-weight:700;color:#dc2626;">Xóa tài khoản</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:5px;line-height:1.55;">Xóa vĩnh viễn tài khoản &amp; toàn bộ dữ liệu (credit, lịch sử, đơn hàng…). Không thể hoàn tác.</div>
        <button type="button" data-cx-account-action="delete-account" style="width:100%;margin-top:12px;height:42px;border:0;border-radius:10px;background:#dc2626;color:#fff;font-weight:700;font-size:13.5px;cursor:pointer;">Xóa tài khoản vĩnh viễn</button>
      </div>`;
  }
  function patchAccountGooglePanel() {
    if (!document.body || loginScreenShowing()) return;
    const id = accountIdentity();
    if (!id || !id.email) return;
    // 1) Lock the Email (Google identity + match-by-email login key — editing it would break login).
    const emailInput = findLabeledAccountInput("email");
    if (emailInput && emailInput.dataset.cxEmailLocked !== "1") {
      emailInput.readOnly = true;
      emailInput.style.cursor = "not-allowed";
      emailInput.style.opacity = "0.8";
      emailInput.title = "Email đăng nhập Google — không thể thay đổi";
      emailInput.dataset.cxEmailLocked = "1";
    }
    // 2) Phone + name values are owned by restoreAccountFields (presence-aware local store, authoritative
    //    over the masked sample/Google name). Nothing to set here.
    // 3) Replace the dead "Đổi mật khẩu" card with the Google login & security panel.
    patchAccountSecurityCard(id.email);
  }

  // ── Per-user light/dark theme (remembered per account, applied on login) ──────────────────────────
  // The design keeps the theme in logic.state.theme but never persists it. Save it per account (by email)
  // so each user's Sáng/Tối choice is restored when they log in. Device-local (cross-device sync would
  // need a server field). themeAppliedForEmail ensures we APPLY the saved theme once per account, then
  // keep persisting whatever theme is active (covers the user toggling it).
  const USER_THEME_KEY = "centrixUserTheme";
  function savedUserTheme(email) {
    try { return String((JSON.parse(localStorage.getItem(USER_THEME_KEY) || "{}"))[email] || ""); } catch { return ""; }
  }
  function setSavedUserTheme(email, theme) {
    try { const m = JSON.parse(localStorage.getItem(USER_THEME_KEY) || "{}"); m[email] = theme; localStorage.setItem(USER_THEME_KEY, JSON.stringify(m)); } catch { /* ignore */ }
  }
  let themeAppliedForEmail = "";
  function syncUserTheme() {
    const logic = patchedStaticLogic || staticLogic();
    if (!logic || !logic.state) return;
    const id = accountIdentity();
    if (!id || !id.email) return;
    const cur = logic.state.theme;
    if (themeAppliedForEmail !== id.email) {
      themeAppliedForEmail = id.email;
      const saved = savedUserTheme(id.email);
      if (saved && saved !== cur) { try { logic.setState({ theme: saved }); } catch { /* ignore */ } return; }
    }
    if (cur && savedUserTheme(id.email) !== cur) setSavedUserTheme(id.email, cur);
  }

  function applyAccountIdentity() {
    // Map whenever we have account data and are NOT on the login form (loginScreenShowing) — instead of
    // gating on state.loginOk, which can momentarily flap false (multi-device /api/me) and leave the
    // "Tài khoản" tab stuck on the demo identity.
    if (!document.body || loginScreenShowing()) return;
    const id = accountIdentity();
    if (!id || !id.email) return;
    // Vietnamese diacritics can be stored NFC (composed) or NFD (decomposed). The bundled template and
    // this file may differ, so a raw === / .includes against the sample names silently fails. Compare in
    // NFC on BOTH sides (this was why the "Tài khoản" tab kept showing the demo "Trần Xuân Lộc").
    const nfc = (value) => String(value || "").normalize("NFC");
    const emailSamples = IDENTITY_SAMPLE_EMAILS.map(nfc);
    const nameSamples = IDENTITY_SAMPLE_NAMES.map(nfc);
    // Swap FROM = the baked sample(s) PLUS every identity ever applied this session (appliedEmails/appliedNames)
    // EXCEPT the current one. A single "last applied" var was not enough: the popup menu + security card + bottom
    // bar mount at DIFFERENT times, so a node holding account A could appear AFTER we'd already moved on to B and
    // forgotten A → it stayed stuck on A. Remembering ALL prior accounts (id is stable per the CDP probe, so no
    // flip) makes this self-healing: whenever any node holding a prior account's email/name shows up, it is
    // rewritten to the current account.
    const curEmail = nfc(id.email), curName = nfc(id.name);
    const emailFrom = Array.from(new Set([...emailSamples, ...appliedEmails])).filter((e) => e && e !== curEmail);
    const nameFrom = Array.from(new Set([...nameSamples, ...appliedNames])).filter((n) => n && n !== curName);
    // 1) Text nodes: swap the sample/previous profile email + names for the live account.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const edits = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const original = node.nodeValue || "";
      if (!original) continue;
      let next = nfc(original);
      for (const from of emailFrom) {
        if (from && next.includes(from)) next = next.split(from).join(id.email);
      }
      for (const from of nameFrom) {
        if (from && next.includes(from)) next = next.split(from).join(id.name);
      }
      if (next !== nfc(original)) edits.push([node, next]);
    }
    for (const [node, next] of edits) node.nodeValue = next;
    // 2) Inputs (account profile / billing form fields seeded with the sample identity). Guarded by
    // loginScreenShowing() above so this never touches the login form (only shown while logged out).
    // Skip the account-tab Họ và tên / SĐT once the user OWNS them (has a saved local edit) — restoreAccountFields
    // is authoritative there; converting sample→Google name first would flash before restore overwrites it.
    const acctEdits = accountEdits(id.email);
    for (const input of document.querySelectorAll("input")) {
      const owned = input.dataset && input.dataset.cxAcctField;
      if (owned && (owned === "name" ? "name" in acctEdits : "phone" in acctEdits)) continue;
      const value = nfc(input.value);
      if (emailFrom.includes(value)) input.value = id.email;
      else if (nameFrom.includes(value)) input.value = id.name;
    }
    // 3) The account-tab "Email" field ships EMPTY (defaultvalue=""), so there's no sample string to swap
    // in step 2 — fill it explicitly. Match the label div whose own text is exactly "Email" and seed the
    // adjacent input, but only when it's empty / a sample / the previous account's email (never clobber
    // typed input). We skip fields the user is editing (activeElement) and search/filter boxes.
    for (const label of document.querySelectorAll("div")) {
      const ownText = Array.from(label.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("")
        .trim();
      if (ownText.toLowerCase() !== "email") continue;
      const input = label.parentElement && label.parentElement.querySelector("input");
      if (!input || input === document.activeElement || input.placeholder) continue;
      const cur = nfc(input.value);
      if (cur === "" || emailFrom.includes(cur)) input.value = id.email;
    }
    // Remember every identity applied so a node mounting later (or a NEXT switch) gets rewritten to current.
    if (curEmail) appliedEmails.add(curEmail);
    if (curName) appliedNames.add(curName);
  }

  // The name shown next to the email in the popup menu / bottom account bar should be the account's real Họ và
  // tên (accountName / the local edit), not the email-derived fallback (e.g. "Mir4xuanquang1"). We set it
  // TARGETED — only the identity-name leaf that sits next to an email leaf, and only if it currently holds a
  // KNOWN identity name (the derived name, a sample, or a previously-applied name). Never a global text search,
  // so a short/generic name ("123") can't corrupt prices/order-ids elsewhere.
  function patchMenuAccountName() {
    if (!document.body || loginScreenShowing()) return;
    const id = accountIdentity();
    if (!id || !id.email) return;
    const b = userBillingProfile() || {};
    const edits = accountEdits(id.email);
    const savedName = String((("name" in edits ? edits.name : b.accountName) || "")).trim();
    if (!savedName) return; // no custom name → keep the email-derived name
    const nfc = (v) => String(v || "").normalize("NFC");
    const savedN = nfc(savedName);
    // The set of SPECIFIC identity-name strings we may relabel: the email-derived name (id.name), the baked
    // samples, and every name applied this session. These are all specific (contain the email local-part or a
    // full sample name) so a global leaf match is safe — the generic savedName ("123") is NEVER searched
    // globally; it's only written onto a node we already identified + TAGGED. Catches BOTH the popup name
    // (email adjacent) AND the always-mounted bottom bar name (no email next to it → the email-anchor missed it).
    const searchable = new Set([nfc(id.name), ...IDENTITY_SAMPLE_NAMES.map(nfc), ...appliedNames]);
    searchable.delete(savedN);
    for (const el of document.querySelectorAll("div,span,p")) {
      if (el.children.length) continue;
      const t = nfc((el.textContent || "").trim());
      const tagged = el.dataset && el.dataset.cxMenuName === "1"; // a node we already relabeled → keep it in sync
      if (!tagged && !searchable.has(t)) continue;
      if (el.dataset) el.dataset.cxMenuName = "1";
      if ((el.textContent || "").trim() !== savedName) el.textContent = savedName;
    }
  }

  // ── Organization UI gating ────────────────────────────────────────────────────────────
  // The org UI (the "Thuộc tổ chức" card with the Cá nhân/Tổ chức credit toggle + org credit grid +
  // "Mở Dashboard Tổ chức", and the "Tổ chức" top tab) ships as a demo for everyone. Show it ONLY when
  // the logged-in user actually belongs to an organisation the App Server created for their userId.
  function userHasOrg() {
    if (!state.portalReady) return false; // hide org UI until a fresh per-account portal fetch confirms membership
    const p = state.portal || {};
    // organization[]/members[] from user_portal_from_db are CALLER-SCOPED (server.py filters to the orgs
    // this userId/email is a member of), so either being non-empty means "the App Server granted this user
    // into an org". state.portal is nested ({portal:{…}}) on refresh and flat on poll — read both.
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : p;
    const members = inner.members || p.members;
    if (Array.isArray(members) && members.some((m) => m && (m.orgId || m.organizationId))) return true;
    const orgs = inner.organization || p.organization;
    return Array.isArray(orgs) && orgs.length > 0;
  }

  function setOrgElHidden(el, hidden) {
    if (!el) return;
    if (hidden) {
      if (el.dataset.cxOrgHidden === "1") return;
      el.dataset.cxOrgHidden = "1";
      el.dataset.cxOrgPrevDisplay = el.style.display || "";
      el.style.display = "none";
    } else if (el.dataset.cxOrgHidden === "1") {
      el.style.display = el.dataset.cxOrgPrevDisplay || "";
      delete el.dataset.cxOrgHidden;
      delete el.dataset.cxOrgPrevDisplay;
    }
  }

  // Narrowest div that owns both given folded substrings (the wrapper row, not its big card parent).
  function narrowestDivWith(...needles) {
    let best = null;
    for (const el of document.querySelectorAll("div")) {
      const t = fold(el.textContent || "");
      if (!needles.every((n) => t.includes(n))) continue;
      const childOwns = Array.from(el.children).some((child) => {
        const ct = fold(child.textContent || "");
        return needles.every((n) => ct.includes(n));
      });
      if (!childOwns) best = el;
    }
    return best;
  }

  // The org-only pieces to hide for non-members. We DON'T hide the whole credit card — the "Credit cá
  // nhân" view must stay for every user (the template default is now 'personal' so it renders for all).
  function orgOnlyElements() {
    const out = [];
    // 1) Org info row: the "Thuộc tổ chức" badge + "Mở Dashboard Tổ chức" button.
    out.push(narrowestDivWith("thuoc to chuc", "dashboard to chuc") || narrowestDivWith("thuoc to chuc"));
    // 2) Org credit grid: "Credit tổ chức của bạn" / "Quỹ đơn vị".
    out.push(narrowestDivWith("credit to chuc cua ban") || narrowestDivWith("quy don vi"));
    // Items 3-7 in ONE pass over leaf elements (was 5 separate full-DOM querySelectorAll scans). Same
    // matches/semantics: first-only for the "Credit tổ chức" toggle / "Tổ chức" top-nav tab / account-popup
    // "Dashboard Tổ chức" menu item; ALL matches for the demo "org admin" badges + org-only "Cài đặt" sections.
    const SETTINGS_ORG = new Set(["thong tin to chuc", "chinh sach credit", "bao mat to chuc"]);
    let gotCreditToggle = false, gotOrgTab = false, gotDashMenu = false;
    for (const el of document.querySelectorAll("div,span,a,button")) {
      if (el.children.length) continue;
      const t = fold((el.textContent || "").trim());
      if (!gotCreditToggle && t === "credit to chuc") { out.push(el.parentElement || el); gotCreditToggle = true; continue; } // 3
      if (!gotOrgTab && t === "to chuc") { // 4: top-nav tab (near the top, laid out)
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.top < 150) {
          const parent = el.parentElement;
          out.push(parent && parent.children.length <= 2 ? parent : el);
          gotOrgTab = true;
        }
        continue;
      }
      if (!gotDashMenu && t === "dashboard to chuc") { // 5: account-popup menu item → hide its whole row
        let row = el.parentElement;
        for (let i = 0; i < 3 && row; i += 1) {
          if (row.querySelector("svg") || row.children.length >= 2) break;
          row = row.parentElement;
        }
        out.push(row || el);
        gotDashMenu = true;
        continue;
      }
      if (fold(el.textContent || "").includes("org admin")) { out.push(el); continue; } // 6: demo org-role badges (non-trimmed)
      if (SETTINGS_ORG.has(t)) out.push(el.parentElement || el); // 7: org-only "Cài đặt" sections
    }
    return out.filter(Boolean);
  }

  function applyOrgVisibility() {
    if (!document.body) return;
    // Show the org UI ONLY for a user the App Server made an org OWNER/ADMIN (orgRole owner|admin) — i.e.
    // the user an org was created for (admins are promoted by the owner). Regular members (credit-capped
    // only) and non-members never see it. Gate on state.portalReady (a fresh per-account portal fetch) so
    // nothing flashes during the multi-second connect handshake. isOrgAdmin() reads the caller's own,
    // caller-scoped membership row (state.portal.members[0].orgRole), so it can't leak another org's role.
    const show = state.portalReady && isOrgAdmin();
    if (!domDirty && show === lastOrgShow) return; // nothing structural changed + decision unchanged → skip the ~3 full-DOM passes
    lastOrgShow = show;
    for (const el of orgOnlyElements()) setOrgElHidden(el, !show);
  }
  let lastOrgShow = null;

  // Deploy build: top-nav tabs the customer isn't using yet — "Mua credit", "Gói cước", "Hóa đơn",
  // "Đơn hàng", "Cài đặt". Same approach as the "Tổ chức" tab hide (orgOnlyElements item 4): match a
  // top-nav leaf whose whole text is exactly the tab label, then hide its clickable wrapper. Driven from
  // the patch tick so a static re-paint can't bring them back.
  const HIDDEN_NAV_TABS = new Set(["mua credit", "goi cuoc", "hoa don", "don hang", "cai dat"]);
  function hideUnusedTabs() {
    if (!document.body) return;
    for (const el of document.querySelectorAll("span,a,div,button")) {
      if (el.children.length) continue;
      const t = fold((el.textContent || "").trim());
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) continue; // already hidden / not laid out
      if (HIDDEN_NAV_TABS.has(t) && rect.top < 150) {
        // top-nav tab → hide the clickable tab wrapper
        const parent = el.parentElement;
        (parent && parent.children.length <= 2 ? parent : el).style.display = "none";
      } else if (t === "cai dat") {
        // "Cài đặt" outside the top nav = the account-popup menu item → hide its whole row (icon + label),
        // same walk-up used for the org "Dashboard Tổ chức" menu item.
        let row = el.parentElement;
        for (let i = 0; i < 3 && row; i += 1) {
          if (row.querySelector("svg") || row.children.length >= 2) break;
          row = row.parentElement;
        }
        (row && row !== el ? row : el).style.display = "none";
      }
    }
  }

  // Account-popup "Đồng bộ hồ sơ" menu item: reload the latest App User data (services + account + portal +
  // plan + org). The design ships it as a static row; wire a click that does a full refresh.
  async function syncProfileNow() {
    showActionToast("Đang đồng bộ hồ sơ…", "ok");
    try {
      await refresh();                                       // services + account + portal + plan + activity
      await ensureOrgStructureLoaded(true).catch(() => {});  // org roster/fund (if org-admin)
      try { refreshOrgIntoDemo(); } catch (e) { /* ignore */ }
      showActionToast("Đã đồng bộ — dữ liệu mới nhất", "ok");
    } catch (e) {
      showActionToast(e?.message || "Lỗi đồng bộ", "error");
    }
  }
  // PERF: ONE capture-phase delegated click handler instead of a full-DOM querySelectorAll('div,span,a,button')
  // + fold()/element scan on EVERY render tick (which scanned the whole body for nothing whenever the account
  // popup was closed). Installed once at boot; works across popup re-renders.
  let syncProfileDelegated = false;
  function installSyncProfileHandler() {
    if (syncProfileDelegated) return;
    syncProfileDelegated = true;
    document.addEventListener("click", (event) => {
      let el = event.target;
      for (let i = 0; i < 4 && el; i += 1) {
        if (el.children && el.children.length === 0 && fold((el.textContent || "").trim()) === "dong bo ho so") {
          try { event.preventDefault(); event.stopPropagation(); } catch (err) { /* ignore */ }
          syncProfileNow();
          return;
        }
        el = el.parentElement;
      }
    }, true);
  }

  // ── Org-admin self-service panel (departments + members + per-member credit allocation) ──────────
  // The template's org dashboard is demo-only; we inject a real, functional admin panel driven by the
  // server (bridge.portal.org*). Gated to owner/admin; mounted in the "Dashboard Tổ chức" body.
  function orgEsc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function orgFmtCr(n) { return (Number(n) || 0).toLocaleString("vi-VN"); }
  // Demo-matching visual helpers (colored stat cards, % bars, avatar chips) so the real panels look like
  // the native org dashboard instead of plain tables.
  function orgPctColor(pct) { return pct >= 90 ? "#dc2626" : pct >= 70 ? "#d97706" : "#16a34a"; }
  function orgBar(pct, color) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div style="height:7px;border-radius:99px;background:var(--border-soft,#eef2f7);overflow:hidden"><div style="height:100%;width:${p}%;background:${color || orgPctColor(p)};border-radius:99px"></div></div>`;
  }
  function orgAvatar(name) {
    const pal = ["#ea7a3c", "#4f5bd5", "#12a594", "#e0457b", "#7c3aed", "#1f9d6b", "#3b82f6", "#d6356f", "#0ea5e9", "#c2410c"];
    const s = String(name || "?");
    const ch = (s.trim()[0] || "?").toUpperCase();
    let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:${pal[h % pal.length]};color:#fff;font:700 12px Segoe UI;flex:0 0 auto">${orgEsc(ch)}</span>`;
  }
  function orgCard(label, value, sub, opts) {
    const o = opts || {}; const dark = o.dark;
    return `<div style="flex:1;min-width:148px;border:1px solid ${dark ? "transparent" : "var(--border-soft,#e2e8f0)"};border-radius:12px;padding:14px 16px;background:${dark ? "#1e3a8a" : "var(--surface,#fff)"};color:${dark ? "#fff" : "var(--text,#0f172a)"}">`
      + `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:${dark ? "rgba(255,255,255,.75)" : "var(--label,#64748b)"};margin-bottom:7px">${orgEsc(label)}</div>`
      + `<div style="font:800 22px/1.05 Segoe UI,system-ui;color:${o.accent || (dark ? "#fff" : "var(--text,#0f172a)")}">${value}</div>`
      + (sub ? `<div style="font-size:11.5px;color:${dark ? "rgba(255,255,255,.7)" : "var(--label,#94a3b8)"};margin-top:5px">${orgEsc(sub)}</div>` : "")
      + `</div>`;
  }
  function orgCardRow(cards) { return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">${cards.join("")}</div>`; }
  function orgSection(title, body) { return `<div style="border:1px solid var(--border-soft,#e2e8f0);border-radius:12px;padding:14px 16px;background:var(--surface,#fff);margin-bottom:12px"><div style="font:700 14px Segoe UI;margin-bottom:12px">${orgEsc(title)}</div>${body}</div>`; }
  function currentMembership() {
    const p = (state.portal && state.portal.portal) || state.portal || {};
    const members = p.members || [];
    return members[0] || null; // user_portal_from_db returns the caller's OWN membership row(s)
  }
  function currentOrgId() {
    const m = currentMembership();
    if (m && m.orgId) return m.orgId;
    const p = (state.portal && state.portal.portal) || state.portal || {};
    const orgs = p.organization || p.organizations || [];
    return (orgs[0] && orgs[0].id) || "";
  }
  function isOrgAdmin() {
    const m = currentMembership();
    return !!(m && ["owner", "admin"].includes(String(m.orgRole || "").toLowerCase()));
  }
  // Lazy-load the full org roster + fund whenever the caller is an org-admin. Covers the login path
  // (loginFromStaticForm uses refresh(), which doesn't preload it) — without this the admin panel's
  // gate (needs state.orgStructure) never passes and the panel silently never appears.
  let orgStructureLoading = false;
  async function ensureOrgStructureLoaded(force) {
    if ((state.orgStructure && !force) || orgStructureLoading) return;
    if (!isOrgAdmin()) return;
    const orgId = currentOrgId();
    if (!orgId) return;
    orgStructureLoading = true;
    try {
      const os = await api()?.portal?.orgStructure?.({ orgId });
      if (os && os.ok !== false) { state.orgStructure = os; refreshOrgIntoDemo(); }
    } catch { /* best-effort */ } finally {
      orgStructureLoading = false;
    }
  }
  // Hydrate ALL native org sub-tabs from the ONE source (state.orgStructure) so they're real + synchronized.
  // Each tab's demo content block is detected by its folded title+subtitle, hidden, and a real panel mounted
  // in its place. Only one sub-view is visible at a time, so only the active tab gets a panel.
  const ORG_TABS = [
    { id: "overview", panelId: "centrix-org-overview", title: "tong quan to chuc", sub: "suc khoe quy credit", render: (p) => renderOrgOverview(p) },
    { id: "tree", panelId: "centrix-org-tree", title: "so do to chuc", sub: "cay phan cap", render: (p) => renderOrgTree(p) },
    { id: "members", panelId: "centrix-org-members", title: "quan ly nhan vien", sub: "thanh vien", render: (p) => renderOrgMembers(p) },
    { id: "alloc", panelId: "centrix-org-admin-panel", title: "phan bo credit", sub: "cap quy cho tung don vi", render: (p) => renderOrgAdminPanel(p) },
  ];
  // From the matched header block, walk UP to the whole sub-view container (so we hide the ENTIRE demo
  // content — cards/bars/tables that are siblings of the header — not just the header). Stop before the
  // isOrg wrapper, detected by it containing the sub-nav (≥2 tab labels).
  function orgSubviewHost(headerEl) {
    let el = headerEl;
    for (let i = 0; i < 8 && el.parentElement; i += 1) {
      const pt = fold(el.parentElement.textContent || "");
      const navHits = ["so do to chuc", "nhan vien", "phan bo credit", "mua & nap", "bao cao"].filter((n) => pt.includes(n)).length;
      if (navHits >= 2) break; // parent is the isOrg wrapper (holds the sub-nav) — don't absorb it
      el = el.parentElement;
    }
    return el;
  }
  function findActiveOrgTab() {
    // Fast path: a host we already marked that is still visible (survives our text mutations + DCLogic re-renders).
    for (const tab of ORG_TABS) {
      const ex = document.querySelector(`[data-cx-org-host="${tab.id}"]`);
      if (ex) {
        if (document.body.contains(ex) && visibleRect(ex)) return { tab, container: ex };
        ex.removeAttribute("data-cx-org-host");
      }
    }
    // One DOM scan: the tightest VISIBLE block that owns a tab's title+subtitle → walk up to its sub-view.
    for (const el of document.querySelectorAll("div,section")) {
      if (!visibleRect(el)) continue;
      const t = fold(el.textContent || "").trim();
      for (const tab of ORG_TABS) {
        if (!t.startsWith(tab.title) || !t.includes(tab.sub)) continue;
        const childOwns = Array.from(el.children).some((c) => {
          const ct = fold(c.textContent || "").trim();
          return ct.startsWith(tab.title) && ct.includes(tab.sub);
        });
        if (!childOwns) return { tab, container: orgSubviewHost(el) };
      }
    }
    return null;
  }
  // The org demo UI is now hydrated IN PLACE by overriding the org component's renderVals (see
  // applyLiveOrgVals) — the custom panels are gone. patchOrgAdminPanel is kept as the cadence hook: it
  // ensures renderVals is patched (idempotent) + cleans up anything the OLD custom-panel build left behind.
  function patchOrgAdminPanel() {
    if (!document.body) return;
    if (isOrgAdmin()) ensureOrgStructureLoaded();
    patchOrgComponents();
    for (const id of ["centrix-org-overview", "centrix-org-tree", "centrix-org-members", "centrix-org-admin-panel"]) {
      const el = document.getElementById(id); if (el) el.remove(); // remove leftover custom panels (no-op on clean launch)
    }
    document.querySelectorAll("[data-cx-org-host]").forEach((host) => { // un-hide any demo content the old build hid
      host.removeAttribute("data-cx-org-host");
      Array.from(host.children).forEach((c) => { if (c.style && c.style.display === "none") c.style.display = ""; });
    });
  }
  function patchOrgComponents() {
    try { for (const item of collectStaticCandidates()) patchOrgRenderVals(item); } catch { /* ignore */ }
  }
  function refreshOrgIntoDemo() {
    try {
      for (const c of collectStaticCandidates()) {
        patchOrgRenderVals(c);
        const s = c && c.state;
        if (s && ("orgView" in s || "orgNodes" in s) && typeof c.setState === "function") {
          try { c.setState({ orgRevision: Date.now() }); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  // Mirror of patchStaticUrlLog: wrap the org component's renderVals so our live data overrides the demo seed.
  function patchOrgRenderVals(logic) {
    if (!logic || logic.__centrixOrgValsPatched) return false;
    if (typeof logic.renderVals !== "function") return false;
    const s = logic.state || {};
    if (!("orgView" in s) && !("orgNodes" in s)) return false; // not the component that owns the org demo
    const original = logic.renderVals.bind(logic);
    logic.renderVals = function patchedOrgRenderVals(...a) {
      const v = original(...a) || {};
      try { applyLiveOrgVals(v, this.state || {}, this); } catch { /* keep demo seed on failure */ }
      return v;
    };
    try { Object.defineProperty(logic, "__centrixOrgValsPatched", { value: true, configurable: true }); }
    catch { logic.__centrixOrgValsPatched = true; }
    try { if (typeof logic.setState === "function") logic.setState({ orgRevision: Date.now() }); } catch { /* ignore */ }
    return true;
  }
  const ORG_AVATARS = ["#ea7a3c", "#4f5bd5", "#12a594", "#e0457b", "#7c3aed", "#1f9d6b", "#3b82f6", "#d6356f", "#0ea5e9", "#c2410c"];
  function orgBarColCss(p) { return p >= 90 ? "var(--danger)" : p >= 70 ? "#d97706" : "var(--ok)"; }
  function orgInitials(name) { return String(name || "?").trim().split(/\s+/).slice(-2).map((w) => w[0] || "").join("").toUpperCase(); }
  async function orgAfter(promise) {
    try {
      const r = await promise;
      if (r && r.ok === false) { showActionToast(r.error || "Lỗi", "error"); return; }
      showActionToast("Đã cập nhật phân bổ", "ok");
      await ensureOrgStructureLoaded(true);
      refreshOrgIntoDemo();
      patchVisibleCreditTextsSoon();
    } catch (e) { showActionToast(e?.message || "Lỗi", "error"); }
  }
  async function orgDeptAllocate(deptId, amount, mode) {
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal || !orgId || !(Number(amount) > 0)) return;
    await orgAfter(bridge.portal.allocate({ orgId, target: "department", departmentId: deptId, amount: Number(amount), ...(mode === "reclaim" ? { mode: "reclaim" } : {}) }));
  }
  function orgDeptSet(deptId, raw, curCap) {
    let v = parseInt(String(raw).replace(/[^0-9]/g, ""), 10); if (isNaN(v)) v = 0;
    const delta = v - (Number(curCap) || 0);
    if (delta === 0) return;
    orgDeptAllocate(deptId, Math.abs(delta), delta > 0 ? "allocate" : "reclaim");
  }
  function orgMemberCapPrompt(m) {
    const cur = (Number(m.balance) || 0) + (Number(m.used) || 0);
    const v = window.prompt("Đặt trần credit cho " + (m.name || m.email) + " (hiện tại " + cur + ")", String(cur));
    if (v == null) return;
    let n = parseInt(String(v).replace(/[^0-9]/g, ""), 10); if (isNaN(n)) return;
    const delta = n - cur; if (delta === 0) return;
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal || !orgId) return;
    orgAfter(bridge.portal.allocate({ orgId, target: "member", toUserId: m.userId, departmentId: m.departmentId || "", amount: Math.abs(delta), ...(delta < 0 ? { mode: "reclaim" } : {}) }));
  }
  // Phase 1 (personal-vs-org credit): set a member's ORG ENTITLEMENT — the cap on how much org credit they may
  // draw from the fund. Money stays in the fund; this only records the limit (server keeps sum ≤ pool budget).
  function orgSetEntitlementPrompt(m) {
    const curEnt = Number(m.entitlement) || 0;
    const v = window.prompt("Đặt HẠN MỨC tổ chức cho " + (m.name || m.email) + "\n(số credit tối đa được rút từ quỹ — tiền vẫn nằm trong quỹ).\nHiện tại: " + curEnt + " cr", String(curEnt));
    if (v == null) return;
    const n = parseInt(String(v).replace(/[^0-9]/g, ""), 10); if (isNaN(n) || n < 0) return;
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.orgSetEntitlement || !orgId) return;
    orgAfter(bridge.portal.orgSetEntitlement({ orgId, userId: m.userId, entitlement: n }));
  }
  // Phase 1: revoke a member — reclaim the org-origin remainder of their wallet back to the fund (personal
  // credit kept), then drop them from the org.
  function orgRemoveMemberFlow(m) {
    const reclaim = Number(m.orgOrigin) || 0;
    const msg = "Gỡ " + (m.name || m.email) + " khỏi tổ chức?"
      + (reclaim > 0 ? "\n\nSẽ thu hồi " + reclaim.toLocaleString("vi-VN") + " cr (credit do tổ chức cấp còn lại trong ví) về quỹ. Credit cá nhân của họ được giữ nguyên." : "");
    if (!window.confirm(msg)) return;
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.orgRemoveMember || !orgId) return;
    orgAfter(bridge.portal.orgRemoveMember({ orgId, userId: m.userId }));
  }
  // Org-admin: delete a department. Server reclaims its budget pool back to the fund + moves its members to
  // "no department" (their already-allocated credit is kept). orgAfter re-fetches the structure so the UI updates.
  function orgDeleteDeptFlow(deptId, deptName) {
    if (!deptId) return;
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.orgDeleteDepartment || !orgId) return;
    if (!window.confirm("Xoá đơn vị \"" + (deptName || deptId) + "\"?\n\nNgân sách còn lại của phòng sẽ hoàn về quỹ tổ chức; các thành viên chuyển về \"Chưa phân đơn vị\" (credit đã cấp được giữ nguyên).")) return;
    orgAfter(bridge.portal.orgDeleteDepartment({ orgId, departmentId: deptId }));
  }
  // OWNER-only: toggle a member between Quản trị viên (admin) and Thành viên (member). The server enforces the
  // owner-only rule + protects the owner role; this just flips to the other role.
  function orgSetRoleFlow(m) {
    const isAdmin = ["owner", "admin"].includes(String(m.orgRole || "").toLowerCase());
    const next = isAdmin ? "member" : "admin";
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.orgSetMemberRole || !orgId) return;
    const msg = isAdmin
      ? "Hạ " + (m.name || m.email) + " xuống Thành viên? Họ sẽ mất quyền quản trị tổ chức."
      : "Thăng " + (m.name || m.email) + " làm Quản trị viên? Họ sẽ thấy và quản lý được tổ chức.";
    if (!window.confirm(msg)) return;
    orgAfter(bridge.portal.orgSetMemberRole({ orgId, userId: m.userId, orgRole: next }));
  }
  // Owner/admin: lock/unlock a member. A locked member is blocked from spending credit (enforced server-side in
  // check_model_usage). The server protects the owner + blocks self-lock.
  function orgToggleLockFlow(m) {
    const locked = !!m.locked;
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.orgSetMemberLocked || !orgId) return;
    const msg = locked
      ? "Mở khoá " + (m.name || m.email) + "? Họ được dùng dịch vụ trở lại."
      : "Khoá " + (m.name || m.email) + "? Họ sẽ KHÔNG dùng được dịch vụ (bị chặn chi tiêu) cho tới khi mở khoá.";
    if (!window.confirm(msg)) return;
    orgAfter(bridge.portal.orgSetMemberLocked({ orgId, userId: m.userId, locked: !locked }));
  }
  // Org "Nạp quỹ ngay" (isBilling tab): an org-admin buys a credit package paid via SePay/VietQR that tops
  // up the ORG FUND — the topup order carries orgId, so the server credits orgfund-<id> (not the personal
  // wallet) on payment. Reuses the personal VietQR modal (showVietQrModal) for the QR + poll.
  function closeOrgTopupModal() { const el = document.getElementById("cx-org-topup-modal"); if (el) el.remove(); }
  function orgBuyCreditFlow() {
    const orgId = currentOrgId();
    if (!orgId || !isOrgAdmin()) { showActionToast("Chỉ quản trị tổ chức mới nạp quỹ", "error"); return; }
    const pkgs = portalPackagesList();
    if (!pkgs.length) { showActionToast("Chưa có gói credit nào để nạp", "error"); return; }
    if (document.getElementById("cx-org-topup-modal")) return;
    const cards = pkgs.map((p) => {
      const total = (Number(p.credits) || 0) + (Number(p.bonusCredits) || 0);
      const price = (Number(p.price) || 0).toLocaleString("vi-VN") + (String(p.currency || "VND") === "USD" ? " USD" : "₫");
      return `<button type="button" data-cx-org-pkg="${escapeHtml(p.id)}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;border:1px solid var(--border);background:var(--surface-2);border-radius:11px;padding:13px 15px;cursor:pointer;"><span style="min-width:0;"><span style="display:block;font-size:13px;font-weight:700;color:var(--text);">${escapeHtml(p.name || "Gói credit")}</span><span style="display:block;font-size:16px;font-weight:900;color:var(--text);margin-top:2px;">${formatCreditValue(total)} <span style="font-size:11px;color:var(--text-3);font-weight:600;">credit</span></span></span><span style="font-size:14px;font-weight:800;color:var(--brand);white-space:nowrap;flex-shrink:0;">${price}</span></button>`;
    }).join("");
    const overlay = document.createElement("div");
    overlay.id = "cx-org-topup-modal";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);";
    overlay.innerHTML = `<div role="dialog" style="width:430px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;">`
      + `<div style="font-size:17px;font-weight:900;color:var(--text);">Nạp quỹ tổ chức</div><div style="font-size:12.5px;color:var(--text-2);margin-top:3px;">Chọn gói — thanh toán SePay (VietQR), credit cộng vào quỹ chung của tổ chức.</div>`
      + `<div style="display:flex;flex-direction:column;gap:9px;margin-top:16px;max-height:48vh;overflow:auto;">${cards}</div>`
      + `<button type="button" data-cx-org-topup-cancel="1" style="width:100%;height:42px;margin-top:16px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text);font-weight:800;font-size:13px;cursor:pointer;">Hủy</button>`
      + `</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || (e.target.closest && e.target.closest("[data-cx-org-topup-cancel]"))) { closeOrgTopupModal(); return; }
      const btn = e.target.closest && e.target.closest("[data-cx-org-pkg]");
      if (btn) { const pid = btn.getAttribute("data-cx-org-pkg"); closeOrgTopupModal(); orgTopupBuy(pid, orgId); }
    });
  }
  async function orgTopupBuy(pkgId, orgId) {
    const bridge = api();
    const pkg = portalPackagesList().find((p) => p.id === pkgId);
    if (!bridge?.portal?.topupRequest || !pkg || !orgId) return;
    try {
      const credits = (Number(pkg.credits) || 0) + (Number(pkg.bonusCredits) || 0);
      const result = await bridge.portal.topupRequest({ orgId, packageId: pkg.id, credits, amount: Number(pkg.price) || 0, currency: pkg.currency || "VND", note: `Nap quy to chuc ${orgId}; method=SePay` });
      const order = result?.order;
      if (order && order.id) showVietQrModal(order).catch(() => {});
      else showActionToast("Không tạo được đơn nạp quỹ", "error");
    } catch (e) { showActionToast(e?.message || "Lỗi nạp quỹ", "error"); }
  }
  // Save the org billing/VAT info: read the form inputs (by their label), persist via the org-admin endpoint,
  // then re-fetch the org structure so the saved values render back (blank-until-saved).
  async function saveOrgBillingFromForm() {
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.orgUpdateBilling || !orgId) { showActionToast("Chưa sẵn sàng lưu", "error"); return; }
    const inputByLabel = (labelFold) => {
      const lbl = Array.from(document.querySelectorAll("div")).find((d) => d.children.length === 0 && fold((d.textContent || "").trim()) === labelFold && d.offsetParent !== null);
      const wrap = lbl && lbl.parentElement;
      return wrap ? wrap.querySelector("input") : null;
    };
    const payload = {
      orgId,
      legalName: String(inputByLabel("ten phap nhan")?.value || "").trim(),
      taxCode: String(inputByLabel("ma so thue")?.value || "").trim(),
      billingEmail: String(inputByLabel("email nhan hoa don")?.value || "").trim(),
      billingAddress: String(inputByLabel("dia chi xuat hoa don")?.value || "").trim(),
      vatEnabled: true
    };
    try {
      const result = await bridge.portal.orgUpdateBilling(payload);
      if (result && result.ok !== false) { showActionToast("Đã lưu thông tin thanh toán", "ok"); await ensureOrgStructureLoaded(true); refreshOrgIntoDemo(); }
      else showActionToast(result?.error || "Lưu thất bại", "error");
    } catch (e) { showActionToast(e?.message || "Lỗi lưu thông tin", "error"); }
  }

  // Org credit packages ("Gói quỹ cho tổ chức"): per-org, editable by the admin (stored on the org record as
  // org.creditPackages). Default to a sensible org-scale set until customized. "Mua gói" tops up the org
  // fund (VietQR); the pencil opens an editor that saves the package list via the org-billing endpoint.
  // Org-tier packages are managed by the App Server OPERATOR (a creditPackages record with tier="org") and
  // arrive in the user portal as state.portal.orgPackages. The org-admin can only BUY them — NOT edit
  // price/credit (that would be a self-discount hole), so there is no in-App-User package editor.
  function orgPackagesList() {
    const p = state.portal || {};
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : p;
    const list = inner.orgPackages || p.orgPackages || [];
    return Array.isArray(list) ? list.filter((x) => x && Number(x.credits) > 0) : [];
  }
  async function orgBuyPackage(pkg) {
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.topupRequest || !orgId || !pkg) return;
    if (!isOrgAdmin()) { showActionToast("Chỉ quản trị tổ chức mới nạp quỹ", "error"); return; }
    try {
      const credits = (Number(pkg.credits) || 0) + (Number(pkg.bonusCredits) || 0);
      const result = await bridge.portal.topupRequest({ orgId, packageId: pkg.id || "", credits, amount: Number(pkg.price) || 0, currency: pkg.currency || "VND", note: `Nap quy to chuc ${orgId}; goi ${pkg.name || ""}; method=SePay` });
      const order = result?.order;
      if (order && order.id) showVietQrModal(order).catch(() => {});
      else showActionToast("Không tạo được đơn nạp quỹ", "error");
    } catch (e) { showActionToast(e?.message || "Lỗi nạp quỹ", "error"); }
  }
  function closeOrgPkgEditor() { const el = document.getElementById("cx-org-pkg-editor"); if (el) el.remove(); }
  function orgPkgEditorRow(p) {
    const fcss = "font-size:13px;color:var(--text);background:var(--field-bg);border:1px solid var(--field-border);border-radius:8px;padding:8px 10px;box-sizing:border-box;width:100%;";
    return `<div data-cx-pkg-row="1" style="display:grid;grid-template-columns:1.3fr .85fr 1fr auto auto;gap:8px;align-items:center;">`
      + `<input data-cx-pkg-name placeholder="Tên gói" value="${escapeHtml(p.name || "")}" style="${fcss}">`
      + `<input data-cx-pkg-credits type="number" min="0" placeholder="Credit" value="${Number(p.credits) || 0}" style="${fcss}text-align:right;">`
      + `<input data-cx-pkg-price type="number" min="0" placeholder="Giá (đ)" value="${Number(p.price) || 0}" style="${fcss}text-align:right;">`
      + `<label style="display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--text-2);white-space:nowrap;cursor:pointer;"><input data-cx-pkg-pop type="checkbox" ${p.popular ? "checked" : ""}>PB</label>`
      + `<button type="button" data-cx-pkg-del="1" title="Xóa gói" style="width:30px;height:32px;border:1px solid var(--field-border);border-radius:8px;background:var(--surface);color:var(--danger);cursor:pointer;font-weight:800;">×</button>`
      + `</div>`;
  }
  function openOrgPackagesEditor() {
    const orgId = currentOrgId();
    if (!orgId || !isOrgAdmin()) { showActionToast("Chỉ quản trị tổ chức mới tùy chỉnh gói", "error"); return; }
    if (document.getElementById("cx-org-pkg-editor")) return;
    const rows = orgPackagesList().map((p) => orgPkgEditorRow(p)).join("");
    const overlay = document.createElement("div");
    overlay.id = "cx-org-pkg-editor";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);";
    overlay.innerHTML = `<div role="dialog" style="width:580px;max-width:calc(100vw - 36px);max-height:88vh;display:flex;flex-direction:column;background:var(--surface,#fff);border:1px solid var(--border);border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.3);padding:22px 24px;">`
      + `<div style="font-size:17px;font-weight:900;color:var(--text);">Tùy chỉnh gói quỹ tổ chức</div><div style="font-size:12.5px;color:var(--text-2);margin-top:3px;">Sửa tên / credit / giá / gói phổ biến (PB). Lưu để áp dụng cho tổ chức này.</div>`
      + `<div id="cx-org-pkg-rows" style="display:flex;flex-direction:column;gap:10px;margin-top:16px;overflow:auto;">${rows}</div>`
      + `<button type="button" data-cx-pkg-add="1" style="margin-top:11px;font-size:12.5px;font-weight:700;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:9px;padding:9px;cursor:pointer;">+ Thêm gói</button>`
      + `<div style="display:flex;gap:10px;margin-top:18px;"><button type="button" data-cx-pkg-cancel="1" style="flex:1;height:42px;border:1px solid var(--field-border);border-radius:10px;background:var(--surface);color:var(--text);font-weight:800;font-size:13px;cursor:pointer;">Hủy</button><button type="button" data-cx-pkg-save="1" style="flex:1.2;height:42px;border:0;border-radius:10px;background:var(--brand);color:#fff;font-weight:900;font-size:13px;cursor:pointer;">Lưu gói</button></div>`
      + `</div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || (e.target.closest && e.target.closest("[data-cx-pkg-cancel]"))) { closeOrgPkgEditor(); return; }
      if (e.target.closest && e.target.closest("[data-cx-pkg-add]")) {
        const host = document.getElementById("cx-org-pkg-rows");
        if (host) host.insertAdjacentHTML("beforeend", orgPkgEditorRow({ name: "", credits: 0, price: 0, popular: false }));
        return;
      }
      const del = e.target.closest && e.target.closest("[data-cx-pkg-del]");
      if (del) { const row = del.closest("[data-cx-pkg-row]"); if (row) row.remove(); return; }
      if (e.target.closest && e.target.closest("[data-cx-pkg-save]")) saveOrgPackagesFromEditor();
    });
  }
  async function saveOrgPackagesFromEditor() {
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.orgUpdateBilling || !orgId) return;
    const rows = Array.from(document.querySelectorAll("#cx-org-pkg-editor [data-cx-pkg-row]"));
    const creditPackages = rows.map((r) => ({
      name: String(r.querySelector("[data-cx-pkg-name]")?.value || "").trim() || "Gói",
      credits: parseInt(r.querySelector("[data-cx-pkg-credits]")?.value || "0", 10) || 0,
      price: parseInt(r.querySelector("[data-cx-pkg-price]")?.value || "0", 10) || 0,
      popular: !!r.querySelector("[data-cx-pkg-pop]")?.checked
    })).filter((p) => p.credits > 0);
    try {
      const result = await bridge.portal.orgUpdateBilling({ orgId, creditPackages });
      if (result && result.ok !== false) { closeOrgPkgEditor(); showActionToast("Đã lưu gói quỹ tổ chức", "ok"); await ensureOrgStructureLoaded(true); refreshOrgIntoDemo(); }
      else showActionToast(result?.error || "Lưu thất bại", "error");
    } catch (e) { showActionToast(e?.message || "Lỗi lưu gói", "error"); }
  }

  // ── "Báo cáo & Audit" (isReports tab) — real data from the /api/users/org/report endpoint ───────────
  const REP_COLORS = ["#3b82f6", "#12a594", "#ea7a3c", "#7c3aed", "#e0457b", "#1f9d6b", "#0ea5e9", "#d6356f", "#d97706", "#4f5bd5"];
  const REPORT_PERIODS = [["month", "Tháng này"], ["quarter", "Quý này"], ["year", "Năm nay"], ["all", "Toàn TG"]];
  function reportPeriodLabel(p) { const f = REPORT_PERIODS.find((x) => x[0] === p); return f ? f[1] : "Tháng này"; }
  function reportSinceDay(period) {
    const now = new Date(); const pad = (n) => (n < 10 ? "0" + n : "" + n);
    let d;
    if (period === "year") d = new Date(now.getFullYear(), 0, 1);
    else if (period === "quarter") d = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    else if (period === "all") return "";
    else d = new Date(now.getFullYear(), now.getMonth(), 1);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  let orgReportLoading = false;
  async function ensureOrgReportLoaded(force) {
    const bridge = api(); const orgId = currentOrgId();
    if (!bridge?.portal?.orgReport || !orgId || !isOrgAdmin()) return;
    if ((state.orgReport && !force) || orgReportLoading) return;
    orgReportLoading = true;
    try {
      const rep = await bridge.portal.orgReport({ orgId, sinceDay: reportSinceDay(state.orgReportPeriod || "month") });
      if (rep && rep.ok !== false) { state.orgReport = rep; refreshOrgIntoDemo(); }
    } catch (e) { /* keep demo seed */ } finally { orgReportLoading = false; }
  }
  function setReportPeriod(p) { state.orgReportPeriod = p; state.orgReport = null; state.reportAuditPage = 0; ensureOrgReportLoaded(true); }
  function repAuditMeta(t) {
    const s = String(t || "").toLowerCase();
    if (s === "topup") return { color: "var(--ok-text,#15803d)", label: "Nạp quỹ" };
    if (s === "debit") return { color: "var(--brand)", label: "Dùng AI" };
    if (s.indexOf("alloc") >= 0) return { color: "#7c3aed", label: "Phân bổ" };
    if (s.indexOf("reclaim") >= 0) return { color: "#d97706", label: "Thu hồi" };
    if (s === "adjust") return { color: "var(--text-2)", label: "Điều chỉnh" };
    return { color: "var(--text-2)", label: t || "Khác" };
  }
  function cxDownload(filename, content, mime) {
    try {
      const blob = new Blob(["﻿" + content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      showActionToast("Đã xuất " + filename, "ok");
    } catch (e) { showActionToast("Không tải được file", "error"); }
  }
  function reportRows() {
    const rep = state.orgReport || {};
    const fmt = (n) => (Number(n) || 0).toLocaleString("vi-VN");
    const rows = [["BÁO CÁO TỔ CHỨC — " + reportPeriodLabel(state.orgReportPeriod || "month")]];
    rows.push(["Tổng tiêu thụ (credit)", fmt(rep.total)]);
    rows.push(["Thành viên hoạt động", (rep.activeMembers || 0) + "/" + (rep.totalMembers || 0)]);
    rows.push([]);
    rows.push(["Tiêu thụ theo dịch vụ", "Credit"]);
    (rep.byModel || []).forEach((m) => rows.push([m.serviceId, fmt(m.credits)]));
    rows.push([]);
    rows.push(["Top người dùng", "Phòng ban", "Đã dùng"]);
    (rep.topMembers || []).forEach((m) => rows.push([m.name, m.dept, fmt(m.used)]));
    rows.push([]);
    rows.push(["Chargeback — phòng ban", "Thành viên", "Đã cấp", "Đã dùng", "%"]);
    (rep.chargeback || []).forEach((c) => rows.push([c.name, c.members, fmt(c.allocated), fmt(c.used), c.pct + "%"]));
    return rows;
  }
  const csvCell = (c) => `"${String(c == null ? "" : c).replace(/"/g, '""')}"`;
  function exportReportCsv() { cxDownload("bao-cao-to-chuc.csv", reportRows().map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8"); }
  function exportReportXls() {
    const tbl = reportRows().map((r) => "<tr>" + r.map((c) => `<td>${escapeHtml(String(c == null ? "" : c))}</td>`).join("") + "</tr>").join("");
    cxDownload("bao-cao-to-chuc.xls", `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1">${tbl}</table></body></html>`, "application/vnd.ms-excel");
  }
  function exportReportPdf() {
    const tbl = reportRows().map((r) => "<tr>" + r.map((c) => `<td style="border:1px solid #ccc;padding:6px 11px;font-size:12px;">${escapeHtml(String(c == null ? "" : c))}</td>`).join("") + "</tr>").join("");
    const w = window.open("", "_blank", "width=840,height=920");
    if (!w) { showActionToast("Cửa sổ in bị chặn — hãy cho phép hiển thị để xuất PDF", "error"); return; }
    w.document.write(`<html><head><meta charset="utf-8"><title>Báo cáo tổ chức</title></head><body style="font-family:Segoe UI,system-ui,sans-serif;padding:26px;color:#0f172a;"><h2>Báo cáo tổ chức — ${escapeHtml(reportPeriodLabel(state.orgReportPeriod || "month"))}</h2><table style="border-collapse:collapse;width:100%;">${tbl}</table><scr` + `ipt>window.onload=function(){setTimeout(function(){window.print();},300);};</scr` + `ipt></body></html>`);
    w.document.close();
  }
  function exportAuditCsv() {
    const rep = state.orgReport || {};
    const rows = [["Thời gian", "Người thực hiện", "Hành động", "Đối tượng", "Thay đổi (cr)", "Lý do"]];
    (rep.audit || []).forEach((a) => rows.push([a.at, a.actor, repAuditMeta(a.type).label, a.member, (a.amountDelta >= 0 ? "+" : "") + a.amountDelta, a.reason]));
    cxDownload("nhat-ky-kiem-toan.csv", rows.map((r) => r.map(csvCell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
  }
  function scheduleReport() {
    const orgId = currentOrgId(); const bridge = api();
    if (!orgId || !bridge?.portal?.orgUpdateBilling) return;
    const cur = (state.orgStructure && state.orgStructure.organization && state.orgStructure.organization.reportEmail) || "";
    const email = window.prompt("Email nhận báo cáo định kỳ hàng tháng (để trống = tắt).\nLưu ý: gửi tự động cần nhà cung cấp bật SMTP.", cur);
    if (email == null) return;
    bridge.portal.orgUpdateBilling({ orgId, reportEmail: String(email).trim(), reportFreq: String(email).trim() ? "monthly" : "" })
      .then((r) => {
        if (r && r.ok !== false) { showActionToast(String(email).trim() ? "Đã lưu lịch gửi báo cáo → " + String(email).trim() + " (gửi tự động cần SMTP nhà cung cấp)." : "Đã tắt gửi báo cáo định kỳ.", "ok"); ensureOrgStructureLoaded(true); }
        else showActionToast(r?.error || "Lưu lịch thất bại", "error");
      })
      .catch((e) => showActionToast(e?.message || "Lỗi lưu lịch", "error"));
  }
  // Set all the isReports renderVals keys: controls always; data sections only once state.orgReport is loaded.
  function applyLiveReportVals(vals, st) {
    const period = state.orgReportPeriod || "month";
    const fmtN = (n) => (Number(n) || 0).toLocaleString("vi-VN");
    vals.repPeriodLabel = reportPeriodLabel(period);
    vals.repPeriods = REPORT_PERIODS.map(([k, label]) => ({
      label, onPick: () => setReportPeriod(k),
      color: period === k ? "var(--brand)" : "var(--text-2)",
      bg: period === k ? "var(--surface)" : "transparent",
      border: period === k ? "var(--border-soft)" : "transparent"
    }));
    vals.onExportCsv = () => exportReportCsv();
    vals.onExportXlsx = () => exportReportXls();
    vals.onExportPdf = () => exportReportPdf();
    vals.onExportAudit = () => exportAuditCsv();
    vals.onScheduleReport = () => scheduleReport();
    const rep = state.orgReport;
    if (!rep) {
      // Not loaded yet → render a neutral LOADING state, NEVER the demo seed, so there's no flash of
      // fake numbers before the real data arrives (the prefetch in applyLiveOrgVals usually fills this
      // before the user even opens this sub-tab).
      const kCard = (label, brand) => ({ label, value: "…", sub: "Đang tải…", cardBg: brand ? "linear-gradient(135deg,var(--brand),var(--brand-strong))" : "var(--surface)", cardBorder: brand ? "var(--brand)" : "var(--border)", labelColor: brand ? "rgba(255,255,255,.85)" : "var(--text-3)", valColor: brand ? "#fff" : "var(--text-2)", subColor: brand ? "rgba(255,255,255,.8)" : "var(--text-3)" });
      vals.repKpis = [kCard("Tổng tiêu thụ", true), kCard("Thành viên hoạt động", false), kCard("Dịch vụ AI đã dùng", false), kCard("Ghế nhàn rỗi", false)];
      vals.repTrend = [];
      vals.serviceUsage = []; vals.repModels = []; vals.serviceUsageEmpty = true; vals.repModelsEmpty = true;
      vals.topMembers = []; vals.topMembersEmpty = true;
      vals.repIdle = []; vals.idleCount = 0; vals.reclaimCrFmt = "0"; vals.repIdleEmpty = true;
      vals.repChargeback = []; vals.repCbTotalCost = "…";
      vals.repAudit = []; vals.repAuditEmpty = true;
      return;
    }
    vals.repKpis = [
      { label: "Tổng tiêu thụ", value: fmtN(rep.total) + " cr", sub: reportPeriodLabel(period), cardBg: "linear-gradient(135deg,var(--brand),var(--brand-strong))", cardBorder: "var(--brand)", labelColor: "rgba(255,255,255,.85)", valColor: "#fff", subColor: "rgba(255,255,255,.8)" },
      { label: "Thành viên hoạt động", value: (rep.activeMembers || 0) + "/" + (rep.totalMembers || 0), sub: "có phát sinh dùng", cardBg: "var(--surface)", cardBorder: "var(--border)", labelColor: "var(--text-3)", valColor: "var(--text)", subColor: "var(--text-3)" },
      { label: "Dịch vụ AI đã dùng", value: String(rep.modelCount || 0), sub: "loại dịch vụ", cardBg: "var(--surface)", cardBorder: "var(--border)", labelColor: "var(--text-3)", valColor: "var(--text)", subColor: "var(--text-3)" },
      { label: "Ghế nhàn rỗi", value: String(rep.idleCount || 0), sub: "thu hồi ~" + fmtN(rep.idleReclaim) + " cr", cardBg: "var(--surface)", cardBorder: "var(--border)", labelColor: "var(--text-3)", valColor: "var(--text)", subColor: "var(--ok-text,#15803d)" }
    ];
    const trend = rep.trend || [];
    const maxDay = Math.max(1, ...trend.map((d) => Number(d.credits) || 0));
    vals.repTrend = trend.map((d) => ({ col: "var(--brand)", h: Math.round((Number(d.credits) || 0) / maxDay * 100) + "%", label: String(d.day || "").slice(5), valFmt: fmtN(d.credits) }));
    const totalCr = Math.max(1, rep.total || 0);
    const usage = (rep.byModel || []).map((m, i) => ({ dot: REP_COLORS[i % REP_COLORS.length], barCol: REP_COLORS[i % REP_COLORS.length], name: m.serviceId || "Dịch vụ", totalFmt: fmtN(m.credits), pctStr: Math.round((Number(m.credits) || 0) / totalCr * 100) + "%", barW: Math.round((Number(m.credits) || 0) / totalCr * 100) + "%" }));
    vals.serviceUsage = usage; vals.repModels = usage; vals.serviceUsageEmpty = usage.length === 0; vals.repModelsEmpty = usage.length === 0;
    vals.topMembers = (rep.topMembers || []).map((m) => ({ initials: orgInitials(m.name), name: m.name, dept: m.dept || "—", usedFmt: fmtN(m.used) + " cr" }));
    vals.topMembersEmpty = (rep.topMembers || []).length === 0;
    vals.repIdle = (rep.idle || []).map((m) => ({ initials: orgInitials(m.name), name: m.name, dept: m.dept || "—", balFmt: fmtN(m.balance) + " cr", reasonLabel: "Chưa dùng kỳ này" }));
    vals.idleCount = rep.idleCount || 0; vals.reclaimCrFmt = fmtN(rep.idleReclaim); vals.repIdleEmpty = (rep.idle || []).length === 0;
    vals.repChargeback = (rep.chargeback || []).map((c) => { const pct = Number(c.pct) || 0; return { name: c.name, manager: c.manager || "—", allocFmt: fmtN(c.allocated), usedFmt: fmtN(c.used), costFmt: fmtN(c.used) + " cr", pctStr: pct + "%", utilStr: pct + "%", utilCol: orgBarColCss(pct) }; });
    vals.repCbTotalCost = fmtN(rep.chargebackTotal) + " cr";
    const af = state.reportAuditFilter || "all";
    vals.auditChips = [["all", "Tất cả"], ["topup", "Nạp"], ["debit", "Dùng"], ["adjust", "Phân bổ/ĐC"]].map(([k, label]) => ({
      label, onPick: () => { state.reportAuditFilter = k; state.reportAuditPage = 0; refreshOrgIntoDemo(); },
      color: af === k ? "var(--brand)" : "var(--text-3)", bg: af === k ? "var(--brand-soft)" : "var(--surface-2)", border: af === k ? "var(--brand-border)" : "var(--border-soft)"
    }));
    const auditAll = rep.audit || [];
    const auditF = af === "all" ? auditAll : auditAll.filter((a) => { const t = String(a.type || "").toLowerCase(); return af === "adjust" ? (t.indexOf("alloc") >= 0 || t.indexOf("reclaim") >= 0 || t === "adjust") : t === af; });
    // 5 rows/page + a numbered pager (injected under the list by patchReportAudit), mirroring Đơn hàng / Lịch sử.
    const aPages = Math.max(1, Math.ceil(auditF.length / AUDIT_PAGE_SIZE));
    const aPage = Math.min(Math.max(0, Number(state.reportAuditPage) || 0), aPages - 1);
    state.reportAuditPage = aPage; state.reportAuditPages = aPages;
    vals.repAudit = auditF.slice(aPage * AUDIT_PAGE_SIZE, aPage * AUDIT_PAGE_SIZE + AUDIT_PAGE_SIZE).map((a) => { const meta = repAuditMeta(a.type); return { initials: orgInitials(a.actor), actor: a.actor || "system", action: meta.label, typeColor: meta.color, typeLabel: meta.label, target: a.member || "", delta: (Number(a.amountDelta) >= 0 ? "+" : "") + fmtN(a.amountDelta) + " cr", reason: a.reason || "—" }; });
    vals.repAuditEmpty = auditF.length === 0;
  }
  const AUDIT_PAGE_SIZE = 5;
  // "Báo cáo & Audit → Nhật ký kiểm toán": inject a numbered pager under the (DCLogic-rendered) audit rows.
  // repAudit is already sliced to the current page in applyLiveReportVals; here we just add/refresh the pager.
  function patchReportAudit() {
    const pages = Math.max(1, Number(state.reportAuditPages) || 1);
    const existing = document.querySelector('[data-cx-audit-pager="1"]');
    if (pages <= 1) { if (existing) existing.remove(); return; }
    const title = Array.from(document.querySelectorAll("div")).find((el) => el.children.length === 0
      && /Nhật ký kiểm toán/i.test((el.textContent || "").trim())
      && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0)));
    if (!title) return;
    let card = null, rows = null, node = title.parentElement;
    for (let i = 0; i < 6 && node; i += 1) {
      const r = Array.from(node.querySelectorAll("div")).filter((c) => /padding:\s*13px\s+18px/i.test(c.getAttribute("style") || ""));
      if (r.length) { card = node; rows = r; break; }
      node = node.parentElement;
    }
    if (!card || !rows || !rows.length) { if (existing) existing.remove(); return; }
    const page = Math.min(Math.max(0, Number(state.reportAuditPage) || 0), pages - 1);
    const key = page + "/" + pages;
    let pager = card.querySelector('[data-cx-audit-pager="1"]');
    if (pager && pager.dataset.cxKey === key) return;
    if (pager) pager.remove();
    const html = usagePagerHtml(page, pages).replace('data-cx-pager="1"', 'data-cx-pager="1" data-cx-audit-pager="1"');
    rows[rows.length - 1].insertAdjacentHTML("afterend", html);
    pager = card.querySelector('[data-cx-audit-pager="1"]');
    if (pager) { pager.dataset.cxKey = key; wireReportAuditPager(card); }
  }
  function wireReportAuditPager(card) {
    if (!card || card.dataset.cxAuditPagerWired === "1") return;
    card.dataset.cxAuditPagerWired = "1";
    card.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-cx-audit-pager="1"] [data-cx-page]') : null;
      if (!btn || !card.contains(btn)) return;
      const p = parseInt(btn.getAttribute("data-cx-page"), 10);
      if (isNaN(p)) return;
      e.preventDefault(); e.stopPropagation();
      state.reportAuditPage = p;
      refreshOrgIntoDemo();
      patchReportAudit();
    });
  }

  // ── Org dashboard "Cài đặt" sub-tab (moved out of the personal Settings tab) ──────────────────────────
  // When the org component's orgView === "orgsettings", none of the design's sc-if sub-screens match, so the
  // org body is empty — we DOM-inject a real settings panel (org identity wired to orgUpdateBilling + policy/
  // security toggles). Gated by the same owner/admin org visibility as the rest of the org dashboard.
  function renderOrgSettingsPanel(panel) {
    const os = state.orgStructure || {};
    const org = os.organization || {};
    const name = org.legalName || org.name || "";
    const mst = org.taxCode || org.mst || "";
    const email = org.billingEmail || "";
    const addr = org.billingAddress || "";
    // Org policy/security flags — persisted on the org record (org_update_billing). Read the SAVED value, else default.
    const flg = (k, def) => (org[k] === undefined ? def : org[k] === true);
    const blockOverCap = flg("blockOverCap", true);
    const allowPersonalWallet = flg("allowPersonalWallet", false);
    const requireSso = flg("requireSso", false);
    const require2fa = flg("require2fa", false);
    const approveInvites = flg("approveInvites", true);
    const key = JSON.stringify([name, mst, email, addr, blockOverCap, allowPersonalWallet, requireSso, require2fa, approveInvites]);
    if (panel.dataset.cxKey === key) return; // unchanged → keep DOM (don't wipe in-progress typing)
    panel.dataset.cxKey = key;
    const field = (label, id, val, ph) => `<div style="margin-bottom:13px"><div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px">${orgEsc(label)}</div><input id="${id}" value="${orgEsc(val)}" placeholder="${orgEsc(ph || "")}" style="width:100%;font-size:13.5px;color:var(--text);background:var(--field-bg);border:1px solid var(--field-border);border-radius:10px;padding:10px 13px;box-sizing:border-box"></div>`;
    const toggleRow = (title, sub, on, id) => `<div data-cx-tg="${id}" data-cx-on="${on ? "1" : "0"}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid var(--border-soft);cursor:pointer"><div style="min-width:0"><div style="font-size:13.5px;font-weight:600;color:var(--text)">${orgEsc(title)}</div><div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${orgEsc(sub)}</div></div><div class="cx-tgtrack" style="width:40px;height:22px;border-radius:99px;background:${on ? "var(--brand)" : "var(--surface-3,#e2e8f0)"};position:relative;flex:0 0 auto"><div class="cx-tgknob" style="position:absolute;top:2px;${on ? "right:2px" : "left:2px"};width:18px;height:18px;border-radius:50%;background:#fff"></div></div></div>`;
    panel.innerHTML =
      orgSection("Thông tin tổ chức",
        field("Tên pháp nhân", "cxos-name", name, "Tên công ty trên hóa đơn")
        + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:13px">`
        + field("Mã số thuế", "cxos-mst", mst, "MST")
        + field("Email nhận hóa đơn", "cxos-email", email, "ketoan@congty.vn")
        + `</div>`
        + field("Địa chỉ xuất hóa đơn", "cxos-addr", addr, "Địa chỉ pháp nhân")
        + `<button id="cxos-save" style="margin-top:4px;font-size:13px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:9px;padding:9px 18px;cursor:pointer">Lưu thông tin</button>`)
      + orgSection("Chính sách Credit",
        toggleRow("Chặn khi vượt trần", "Không cho dùng vượt hạn mức được cấp", blockOverCap, "blockOverCap")
        + toggleRow("Cho phép ví cá nhân", "Thành viên được dùng song song credit cá nhân", allowPersonalWallet, "allowPersonalWallet")
        + `<div style="font-size:11px;color:var(--text-3);margin-top:10px">Đã lưu thật. Hạn mức đang được chặn cứng theo số dư ví được cấp; định tuyến chi tiêu cá nhân↔tổ chức theo bản cập nhật kế.</div>`)
      + orgSection("Bảo mật tổ chức",
        toggleRow("Đăng nhập SSO (Google Workspace)", "Bắt buộc đăng nhập qua tổ chức", requireSso, "requireSso")
        + toggleRow("Bắt buộc 2FA toàn tổ chức", "Yêu cầu xác thực 2 lớp", require2fa, "require2fa")
        + toggleRow("Phê duyệt khi mời thành viên", "Owner duyệt trước khi thành viên tham gia", approveInvites, "approveInvites")
        + `<div style="font-size:11px;color:var(--text-3);margin-top:10px">Đã lưu thật. "Phê duyệt khi mời" có hiệu lực ngay; SSO & 2FA do tài khoản Google quản lý (CentriX đăng nhập qua Google).</div>`);
    const saveBtn = panel.querySelector("#cxos-save");
    if (saveBtn) saveBtn.addEventListener("click", () => {
      const bridge = api(); const orgId = currentOrgId();
      if (!bridge?.portal?.orgUpdateBilling || !orgId) { showActionToast("Chưa sẵn sàng lưu", "error"); return; }
      const g = (id) => (panel.querySelector("#" + id)?.value || "").trim();
      bridge.portal.orgUpdateBilling({ orgId, legalName: g("cxos-name"), taxCode: g("cxos-mst"), billingEmail: g("cxos-email"), billingAddress: g("cxos-addr") })
        .then((r) => { if (r && r.ok !== false) { showActionToast("Đã lưu cài đặt tổ chức", "ok"); ensureOrgStructureLoaded(true); } else showActionToast(r?.error || "Lưu thất bại", "error"); })
        .catch((e) => showActionToast(e?.message || "Lỗi lưu", "error"));
    });
    // Policy/security toggles → persist each flip via orgUpdateBilling (optimistic flip; reload re-renders the saved state).
    panel.querySelectorAll("[data-cx-tg]").forEach((row) => {
      row.addEventListener("click", () => {
        const bridge = api(); const orgId = currentOrgId();
        if (!bridge?.portal?.orgUpdateBilling || !orgId) { showActionToast("Chưa sẵn sàng lưu", "error"); return; }
        const id = row.dataset.cxTg; const next = row.dataset.cxOn !== "1";
        row.dataset.cxOn = next ? "1" : "0";
        const track = row.querySelector(".cx-tgtrack"); const knob = row.querySelector(".cx-tgknob");
        if (track) track.style.background = next ? "var(--brand)" : "var(--surface-3,#e2e8f0)";
        if (knob) { knob.style.left = next ? "auto" : "2px"; knob.style.right = next ? "2px" : "auto"; }
        bridge.portal.orgUpdateBilling({ orgId, [id]: next })
          .then((r) => { if (r && r.ok !== false) { showActionToast("Đã lưu cài đặt", "ok"); ensureOrgStructureLoaded(true); } else showActionToast(r?.error || "Lưu thất bại", "error"); })
          .catch((e) => showActionToast(e?.message || "Lỗi lưu", "error"));
      });
    });
  }
  function patchOrgSettingsView() {
    const existing = document.getElementById("cx-org-settings");
    // Detect the org "Cài đặt" sub-tab being ACTIVE straight from the DOM (its rendered brand border), instead
    // of the shared state.orgSettingsActive — another org component instance can clobber that flag to false
    // mid-tick, which would wrongly remove the panel even while the visible tab stays highlighted.
    // The org sub-tab labels are interpolated ({{ t.label }}), so DCLogic wraps each in a <span class="sc-interp">
    // INSIDE the tab <div> — a "div + children.length===0" finder misses them (the tab div has the span child).
    // Match the label element (span OR div) then walk up to its tab div + the nav row.
    const reportEl = Array.from(document.querySelectorAll("span,div")).find((el) => el.children.length === 0
      && /^Báo cáo & Audit$/i.test((el.textContent || "").trim())
      && (el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0)));
    const reportTab = reportEl ? reportEl.closest("div") : null;      // the clickable tab <div>
    const nav = reportTab && reportTab.parentElement;                 // the org sub-tab nav row
    const caiDatTab = nav && Array.from(nav.children).find((c) => /^Cài đặt$/i.test((c.textContent || "").trim()));
    const active = !!(caiDatTab && /var\(--brand\)/i.test(caiDatTab.getAttribute("style") || ""));
    if (!active) { if (existing) existing.remove(); return; }
    const body = nav.parentElement;                                   // the org dashboard body
    if (!body) { if (existing) existing.remove(); return; }
    let panel = document.getElementById("cx-org-settings");
    if (!panel || panel.parentElement !== body) {
      if (panel) panel.remove();
      panel = document.createElement("div");
      panel.id = "cx-org-settings";
      panel.style.marginTop = "2px";
      panel.style.minHeight = "40px";
      body.appendChild(panel);
    }
    try { renderOrgSettingsPanel(panel); }
    catch (e) { panel.dataset.cxKey = ""; panel.innerHTML = '<div style="padding:14px;color:var(--danger);font-size:13px">Lỗi hiển thị Cài đặt tổ chức: ' + orgEsc(e && e.message ? e.message : String(e)) + '</div>'; }
  }
  // Hide the duplicate "Cài đặt tổ chức" section in the personal "Cài đặt" tab (it now lives in the org tab).
  // The design's <sc-if isEnterprise> renders its children INLINE (no wrapper), so we must NOT walk up to a
  // container (that hid the shared content region → blanked every tab). Hide ONLY the title row + the grid
  // SIBLINGS that contain the org cards, stopping at the first non-org sibling.
  function hideOrgSettingsSection() {
    if (!document.body) return;
    const title = Array.from(document.querySelectorAll("div")).find((el) => el.children.length === 0
      && /^Cài đặt tổ chức$/i.test((el.textContent || "").trim())
      && !(el.closest && el.closest("#cx-org-settings")));  // never touch our own injected org panel
    const row = title && title.parentElement;
    if (!row) return;
    row.style.display = "none";
    let sib = row.nextElementSibling;
    let guard = 0;
    while (sib && guard < 8) {
      const t = fold(sib.textContent || "");
      if (t.includes("thong tin to chuc") || t.includes("chinh sach credit") || t.includes("bao mat to chuc")) {
        sib.style.display = "none";
        sib = sib.nextElementSibling;
        guard += 1;
      } else break;
    }
  }
  // Google-only login: hide the "Đổi mật khẩu" button(s) — there is no CentriX password to change (sign-in is
  // via Google). "Quản lý thiết bị" (session/device control) stays, as it's the relevant security action.
  function hidePasswordButton() {
    if (!document.body) return;
    for (const el of document.querySelectorAll("button,div,a")) {
      if (el.children.length) continue;
      if (/^Đổi mật khẩu$/i.test((el.textContent || "").trim())) el.style.display = "none";
    }
  }

  // The mapper: overwrite every org renderVals key with real data from state.orgStructure (exact demo shapes).
  function applyLiveOrgVals(vals, st, logic) {
    try { applyLiveReportVals(vals, st); ensureOrgReportLoaded(); } catch (e) { /* keep demo */ }
    // New "Cài đặt" sub-tab in the org dashboard (owner+admin), appended to the demo's orgViewTabs. Its
    // content is DOM-injected by patchOrgSettingsView when orgView==="orgsettings"; the duplicate section in
    // the personal "Cài đặt" tab is hidden by hideOrgSettingsSection.
    const isSettingsView = !!(st && st.orgView === "orgsettings"); // THIS component's view (not the shared flag,
    state.orgSettingsActive = isSettingsView;                       // which another org instance could clobber)
    if (Array.isArray(vals.orgViewTabs)) {
      vals.orgViewTabs = vals.orgViewTabs.concat([{
        label: "Cài đặt",
        onPick: () => { try { if (logic && logic.orgGo) logic.orgGo("orgsettings"); } catch (e) { /* ignore */ } },
        color: isSettingsView ? "var(--brand)" : "var(--text-2)",
        border: isSettingsView ? "var(--brand)" : "transparent"
      }]);
    }
    const os = state.orgStructure;
    if (!os || !os.organization) {
      // Org data chưa load → hiện trạng thái LOADING (rỗng), KHÔNG bao giờ hiện demo seed (phòng ban/nhân viên/
      // quỹ/đơn ảo). Prefetch ở patchOrgAdminPanel + trigger ở đây; refreshOrgIntoDemo re-render khi data về.
      ensureOrgStructureLoaded();
      const dash = "…";
      vals.orgName = "Tổ chức"; vals.orgShort = ""; vals.orgMst = "—";
      vals.orgTotal = 0; vals.orgTotalFmt = dash; vals.orgUsedFmt = dash; vals.orgRemainFmt = dash;
      vals.allocatedFmt = dash; vals.unallocFmt = dash; vals.allocOverFmt = "0"; vals.orgUsedPctStr = "0%"; vals.allocOver = false;
      vals.deptCount = 0; vals.totalMembers = 0; vals.memberCount = 0;
      vals.orgStats = []; vals.fundSegments = []; vals.orgTree = []; vals.deptBars = []; vals.allocRows = [];
      vals.deptOptions = [{ id: "all", name: "Tất cả phòng ban" }];
      vals.orgMembers = []; vals.orgMembersEmpty = true; vals.selectedCount = 0; vals.hasSelection = false;
      vals.orgAlerts = []; vals.orgAlertsEmpty = true;
      vals.vat = { name: "", mst: "", email: "", addr: "" };
      vals.orgPackages = []; vals.orgTopups = []; vals.orgTopupsEmpty = true;
      return;
    }
    const org = os.organization || {};
    const depts = os.departments || [];
    const members = os.members || [];
    const fmtN = (n) => (Number(n) || 0).toLocaleString("vi-VN");
    const total = Number(os.fundLifetimeAdded) || 0;
    const unalloc = Number(os.fundBalance) || 0;
    const allocated = Math.max(0, total - unalloc);
    const usedTot = members.reduce((a, m) => a + (Number(m.used) || 0), 0);
    const allocUnused = Math.max(0, allocated - usedTot);
    const pctOf = (u, c) => (c > 0 ? Math.min(100, Math.round((u / c) * 100)) : 0);
    const grouped = orgUsedByDept(depts, members);
    const usedByDept = grouped.used; const cntByDept = grouped.count;

    vals.orgName = org.name || "Tổ chức";
    vals.orgShort = org.short || org.name || "";
    vals.orgMst = org.mst || "—";
    vals.orgTotal = total;
    vals.orgTotalFmt = fmtN(total);
    vals.orgUsedFmt = fmtN(usedTot);
    vals.orgUsedPctStr = pctOf(usedTot, total) + "%";
    vals.orgRemainFmt = fmtN(unalloc);
    vals.allocatedFmt = fmtN(allocated);
    vals.unallocFmt = fmtN(unalloc);
    vals.allocOver = allocated > total;
    vals.allocOverFmt = fmtN(Math.abs(total - allocated));
    vals.deptCount = depts.length;
    vals.totalMembers = members.length;
    vals.memberCount = members.length;

    const statRaw = [
      { label: "Tổng quỹ Credit", value: fmtN(total), sub: "credit đã nạp", brand: true },
      { label: "Đã phân bổ", value: fmtN(allocated), sub: "xuống " + depts.length + " đơn vị", color: "var(--brand)" },
      { label: "Đã tiêu thụ", value: fmtN(usedTot), sub: pctOf(usedTot, total) + "% tổng quỹ", color: "#d97706" },
      { label: "Chưa phân bổ", value: fmtN(unalloc), sub: "sẵn sàng cấp phát", color: "var(--ok)" },
    ];
    vals.orgStats = statRaw.map((x) => (x.brand
      ? { ...x, cardBg: "linear-gradient(135deg,var(--brand),var(--brand-strong))", cardBorder: "transparent", labelColor: "rgba(255,255,255,.85)", valColor: "#fff", subColor: "rgba(255,255,255,.9)" }
      : { ...x, cardBg: "var(--surface)", cardBorder: "var(--border)", labelColor: "var(--label)", valColor: x.color || "var(--text)", subColor: "var(--text-3)" }));

    vals.fundSegments = [
      { w: pctOf(usedTot, total) + "%", col: "var(--brand)", label: "Đã tiêu thụ", valFmt: fmtN(usedTot) },
      { w: pctOf(allocUnused, total) + "%", col: "var(--brand-border)", label: "Đã cấp · chưa dùng", valFmt: fmtN(allocUnused) },
      { w: pctOf(Math.max(0, unalloc), total) + "%", col: "var(--surface-3)", label: "Chưa phân bổ", valFmt: fmtN(Math.max(0, unalloc)) },
    ];

    const deptRow = (d) => {
      const cap = Number(d.budgetTotal) || 0; const u = usedByDept[d.id] || 0; const p = pctOf(u, cap);
      const rem = cap - u; const poolRem = Number(d.budget) || 0;
      return {
        id: d.id, name: d.name || d.id, manager: "", members: cntByDept[d.id] || 0, pad: "16px",
        allocFmt: fmtN(cap), usedFmt: fmtN(u), pctStr: p + "%", pctCol: orgBarColCss(p),
        bar: [{ w: p + "%", col: orgBarColCss(p) }], isRoot: false, dot: orgBarColCss(p),
        remFmt: fmtN(rem), remNeg: rem < 0, remCol: rem < 0 ? "var(--danger)" : "var(--ok-text)",
        allocated: cap, utilStr: p + "%", utilCol: orgBarColCss(p),
        onAllocate: () => { if (logic && logic.orgGo) logic.orgGo("alloc"); },
        onAdd: () => openMemberForm(),
        onEdit: () => showActionToast("Sửa đơn vị: phân bổ ở tab Phân bổ Credit", "error"),
        onDelete: () => orgDeleteDeptFlow(d.id, d.name || d.id),
        onInc: () => orgDeptAllocate(d.id, 500, "allocate"),
        onDec: () => orgDeptAllocate(d.id, 500, "reclaim"),
        onSet: (e) => orgDeptSet(d.id, e && e.target ? e.target.value : e, cap),
        onReclaim: () => orgDeptAllocate(d.id, poolRem, "reclaim"),
      };
    };
    const rootP = pctOf(usedTot, total);
    const rootRow = {
      id: "__root", name: org.name || "Tổ chức", manager: "", members: members.length, pad: "0px",
      allocFmt: fmtN(allocated), usedFmt: fmtN(usedTot), pctStr: rootP + "%", pctCol: "var(--text-3)",
      bar: [{ w: rootP + "%", col: orgBarColCss(rootP) }], isRoot: true, dot: "var(--brand)",
      onAllocate: () => {}, onAdd: () => openDeptForm(), onEdit: () => {}, onDelete: () => {},
    };
    vals.orgTree = [rootRow].concat(depts.map(deptRow));
    vals.deptBars = depts.map(deptRow);
    vals.allocRows = depts.map(deptRow);

    vals.deptOptions = [{ id: "all", name: "Tất cả phòng ban" }].concat(depts.map((d) => ({ id: d.name || d.id, name: d.name || d.id })));

    const okM = ["var(--ok-text)", "var(--ok-soft)", "var(--ok-border)"];
    const oq = String((st && st.orgQuery) || "").trim().toLowerCase();
    const odept = (st && st.orgDept) || "all";
    const ostatus = (st && st.orgStatus) || "all";
    const built = members.map((m, i) => {
      const ent = Number(m.entitlement) || 0; const used = Number(m.used) || 0; const mp = ent > 0 ? pctOf(used, ent) : 0;
      const isAdmin = ["owner", "admin"].includes(String(m.orgRole || "").toLowerCase());
      const isLocked = !!m.locked;
      const dn = (depts.find((d) => d.id === m.departmentId) || {}).name || "";
      return {
        userId: m.userId, departmentId: m.departmentId || "",
        name: m.name || m.userId, email: m.email || "", dept: dn, role: isAdmin ? "Quản lý" : "Thành viên",
        cap: fmtN(ent), used: fmtN(used), capFmt: fmtN(ent), usedFmt: fmtN(used),
        stLabel: isLocked ? "Đã khoá" : "Hoạt động", stColor: isLocked ? "var(--danger)" : okM[0], stBg: isLocked ? "var(--danger-soft,#fee2e2)" : okM[1], stBorder: isLocked ? "var(--danger-border,#fecaca)" : okM[2],
        roleBrand: isAdmin, roleColor: isAdmin ? "var(--brand)" : "var(--text-2)", roleBg: isAdmin ? "var(--brand-soft)" : "var(--surface-3)",
        initials: orgInitials(m.name || m.email), avatarBg: ORG_AVATARS[i % ORG_AVATARS.length],
        barW: mp + "%", barCol: orgBarColCss(mp), locked: isLocked, lockTitle: isLocked ? "Mở khoá" : "Khóa",
        selected: !!(((st && st.memSel) || {})[m.email]),
        onToggle: () => { if (logic && logic.toggleMem) logic.toggleMem(m.email); },
        onCap: () => orgSetEntitlementPrompt({ userId: m.userId, name: m.name, email: m.email, entitlement: ent }),
        onRole: () => orgSetRoleFlow(m),
        onLock: () => orgToggleLockFlow(m),
        onDelete: () => orgRemoveMemberFlow({ userId: m.userId, name: m.name, email: m.email, orgOrigin: Number(m.orgOrigin) || 0 }),
      };
    }).filter((m) => (odept === "all" || m.dept === odept) && (ostatus === "all" || ostatus === "active") && (!oq || m.name.toLowerCase().includes(oq) || m.email.toLowerCase().includes(oq)));
    vals.orgMembers = built;
    vals.orgMembersEmpty = built.length === 0;
    vals.selectedCount = built.filter((m) => m.selected).length;
    vals.hasSelection = vals.selectedCount > 0;

    vals.orgAlerts = [];
    vals.orgAlertsEmpty = true;

    // Billing/VAT tab (isBilling): payment-info form from the SAVED org record — blank until the admin fills
    // + saves it (fixes the demo data). The quỹ stats (orgTotalFmt/orgUsedFmt/orgRemainFmt) are set above.
    vals.vat = { name: org.legalName || "", mst: org.taxCode || "", email: org.billingEmail || "", addr: org.billingAddress || "" };
    vals.onAddTopup = () => orgBuyCreditFlow();
    vals.onSaveOrgBilling = () => saveOrgBillingFromForm();
    vals.onExportVat = () => showActionToast("Xuất hóa đơn VAT GTGT sẽ sớm khả dụng — liên hệ hỗ trợ nếu cần gấp.", "ok");

    // "Gói quỹ cho tổ chức": real, editable per-org packages — each "Mua gói" tops up the org fund.
    vals.orgPackages = orgPackagesList().map((p) => {
      const totalCr = (Number(p.credits) || 0) + (Number(p.bonusCredits) || 0);
      return {
        name: p.name || "Gói", creditsFmt: fmtN(totalCr), price: fmtN(p.price) + "₫",
        popular: !!p.highlight, ring: p.highlight ? "var(--brand)" : "var(--border)",
        onBuy: () => orgBuyPackage(p)
      };
    });
    // Org-admin can't edit packages — the operator manages them in the App Server ("Gói nạp credit" → tier Tổ chức).
    vals.onEditPackage = () => showActionToast("Gói quỹ do nhà cung cấp quản lý — không chỉnh ở đây.", "ok");
    // "Lịch sử nạp quỹ": the org's real top-up orders (own_or_org → present in portal.orders for members).
    const allOrders = (state.portal && state.portal.orders) || (state.portal && state.portal.portal && state.portal.portal.orders) || [];
    const orgTopupOrders = allOrders.filter((o) => o && o.orgId && o.orgId === (org.id || ""));
    vals.orgTopups = orgTopupOrders.slice(0, 30).map((o) => {
      const dt = new Date(o.creditedAt || o.createdAt || "");
      const pad = (n) => (n < 10 ? "0" + n : "" + n);
      const ts = isNaN(dt.getTime()) ? "" : `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      return { name: "Nạp " + fmtN(o.credits) + " credit", creditsFmt: fmtN(o.credits), price: fmtN(o.amount) + "₫", method: "SePay", ts };
    });
    vals.orgTopupsEmpty = vals.orgTopups.length === 0;
  }
  function orgGroupMembers(depts, members) {
    const byDept = {};
    const noDept = [];
    members.forEach((m) => {
      const d = m.departmentId && depts.find((x) => x.id === m.departmentId);
      if (d) { (byDept[m.departmentId] = byDept[m.departmentId] || []).push(m); } else { noDept.push(m); }
    });
    return { byDept, noDept };
  }
  function orgUsedByDept(depts, members) {
    const used = {}; const count = {};
    members.forEach((m) => { if (m.departmentId) { used[m.departmentId] = (used[m.departmentId] || 0) + (Number(m.used) || 0); count[m.departmentId] = (count[m.departmentId] || 0) + 1; } });
    return { used, count };
  }
  function renderOrgOverview(panel) {
    const os = state.orgStructure || {};
    const depts = os.departments || [];
    const members = os.members || [];
    const total = Number(os.fundLifetimeAdded) || 0;
    const unalloc = Number(os.fundBalance) || 0;
    const allocToDept = Math.max(0, total - unalloc);
    const used = members.reduce((s, m) => s + (Number(m.used) || 0), 0);
    const usedPct = total > 0 ? Math.round((used / total) * 100) : 0;
    const sig = JSON.stringify({ total, unalloc, allocToDept, used, nd: depts.length, nm: members.length, dd: depts.map((d) => d.id + "|" + d.budgetTotal), mu: members.map((m) => m.departmentId + ":" + m.used) });
    if (panel.dataset.cxSig === sig && panel.childElementCount) return;
    panel.dataset.cxSig = sig;
    const { used: usedByDept } = orgUsedByDept(depts, members);
    const deptBars = depts.length
      ? depts.map((d) => { const cap = Number(d.budgetTotal) || 0; const u = usedByDept[d.id] || 0; const pct = cap > 0 ? Math.round((u / cap) * 100) : 0; return `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px"><span style="font-weight:600">${orgEsc(d.name || d.id)}</span><span style="color:var(--label,#64748b)">${orgFmtCr(u)} / ${orgFmtCr(cap)} · <b style="color:${orgPctColor(pct)}">${pct}%</b></span></div>${orgBar(pct)}</div>`; }).join("")
      : '<div style="color:#94a3b8">Chưa có phòng ban</div>';
    panel.innerHTML =
      orgCardRow([
        orgCard("Tổng quỹ credit", orgFmtCr(total), "credit đã nạp", { dark: true }),
        orgCard("Đã phân bổ", orgFmtCr(allocToDept), `xuống ${depts.length} phòng ban`, { accent: "#2563eb" }),
        orgCard("Đã tiêu thụ", orgFmtCr(used), `${usedPct}% tổng quỹ`, { accent: "#d97706" }),
        orgCard("Chưa phân bổ", orgFmtCr(unalloc), "sẵn sàng cấp phát", { accent: "#16a34a" }),
      ])
      + orgSection("Tiêu thụ theo phòng ban", deptBars);
  }
  function renderOrgTree(panel) {
    const os = state.orgStructure || {};
    const org = os.organization || {};
    const depts = os.departments || [];
    const members = os.members || [];
    const total = Number(os.fundLifetimeAdded) || 0;
    const unalloc = Number(os.fundBalance) || 0;
    const sig = JSON.stringify({ o: org.id + "|" + org.name, t: total, u: unalloc, d: depts.map((d) => d.id + "|" + d.name + "|" + d.budget + "|" + d.budgetTotal), m: members.map((m) => m.userId + "|" + m.departmentId + "|" + m.balance + "|" + m.used) });
    if (panel.dataset.cxSig === sig && panel.childElementCount) return;
    panel.dataset.cxSig = sig;
    const { used: usedByDept, count: cntByDept } = orgUsedByDept(depts, members);
    const { byDept, noDept } = orgGroupMembers(depts, members);
    const rows = depts.length
      ? depts.map((d) => { const cap = Number(d.budgetTotal) || 0; const u = usedByDept[d.id] || 0; const pct = cap > 0 ? Math.round((u / cap) * 100) : 0; return `<tr style="border-top:1px solid var(--border-soft,#eef2f7)"><td style="padding:9px 8px"><div style="font-weight:600">${orgEsc(d.name || d.id)}</div></td><td style="padding:9px 8px;text-align:center">${cntByDept[d.id] || 0}</td><td style="padding:9px 8px;min-width:170px"><div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px"><span>${orgFmtCr(u)}</span><span style="color:var(--label,#64748b)">${orgFmtCr(cap)}</span></div>${orgBar(pct)}</td><td style="padding:9px 8px;text-align:right;font-weight:700;color:${orgPctColor(pct)}">${pct}%</td></tr>`; }).join("")
      : '<tr><td colspan="4" style="padding:10px;color:#94a3b8">Chưa có phòng ban</td></tr>';
    const memLi = (m) => `<li style="padding:3px 0">• ${orgEsc(m.name || m.email || m.userId)} <span style="color:#94a3b8;font-size:11.5px">(${orgEsc(m.orgRole || "member")} · còn ${orgFmtCr(m.balance)} · đã dùng ${orgFmtCr(m.used)})</span></li>`;
    const deptLi = (d) => { const mem = byDept[d.id] || []; return `<li style="margin:8px 0"><div style="font-weight:700">📁 ${orgEsc(d.name || d.id)} <span style="color:#94a3b8;font-size:11.5px;font-weight:500">· ngân sách còn ${orgFmtCr(d.budget)} cr</span></div><ul style="list-style:none;margin:4px 0 0;padding-left:16px;border-left:2px solid var(--border-soft,#e2e8f0)">${mem.length ? mem.map(memLi).join("") : '<li style="color:#94a3b8;font-size:12px;padding:3px 0">— Chưa có thành viên —</li>'}</ul></li>`; };
    panel.innerHTML =
      orgCardRow([
        orgCard("Đơn vị", String(depts.length), "phòng ban"),
        orgCard("Tổng nhân sự", String(members.length), "thành viên"),
        orgCard("Đã phân bổ", orgFmtCr(Math.max(0, total - unalloc)), "xuống phòng ban", { accent: "#2563eb" }),
        orgCard("Chưa phân bổ", orgFmtCr(unalloc), "còn ở quỹ", { accent: "#16a34a" }),
      ])
      + `<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button id="cx-add-dept" style="padding:8px 14px;border:0;border-radius:9px;background:#2563eb;color:#fff;font:700 13px Segoe UI;cursor:pointer">+ Thêm phòng ban</button></div>`
      + orgSection("Phân bổ &amp; tiêu thụ theo đơn vị",
        `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr style="text-align:left;color:var(--label,#64748b);font-size:11px;text-transform:uppercase"><th style="padding:6px 8px">Đơn vị</th><th style="padding:6px 8px;text-align:center">NV</th><th style="padding:6px 8px">Đã dùng / Quỹ cấp</th><th style="padding:6px 8px;text-align:right">%</th></tr></thead><tbody>${rows}</tbody></table>`)
      + orgSection("Sơ đồ tổ chức",
        `<div style="font:800 15px Segoe UI,system-ui;margin-bottom:6px">🏢 ${orgEsc(org.name || "Tổ chức")}</div><ul style="list-style:none;margin:0;padding-left:8px">`
        + (depts.length ? depts.map(deptLi).join("") : '<li style="color:#94a3b8">Chưa có phòng ban</li>')
        + (noDept.length ? `<li style="margin:8px 0"><div style="font-weight:700;color:var(--label,#64748b)">Chưa thuộc phòng ban</div><ul style="list-style:none;margin:4px 0 0;padding-left:16px;border-left:2px dashed var(--border-soft,#e2e8f0)">${noDept.map(memLi).join("")}</ul></li>` : "")
        + `</ul>`);
    panel.querySelector("#cx-add-dept")?.addEventListener("click", () => openDeptForm());
  }
  function renderOrgMembers(panel) {
    const os = state.orgStructure || {};
    const depts = os.departments || [];
    const members = os.members || [];
    const sig = JSON.stringify({ m: members.map((m) => m.userId + "|" + m.name + "|" + m.balance + "|" + m.used + "|" + m.departmentId + "|" + m.orgRole) });
    if (panel.dataset.cxSig === sig && panel.childElementCount) return;
    panel.dataset.cxSig = sig;
    const deptName = (id) => (depts.find((d) => d.id === id) || {}).name || "";
    const badge = (txt, bg, fg) => `<span style="display:inline-block;padding:2px 9px;border-radius:99px;background:${bg};color:${fg};font-size:11px;font-weight:600;margin-right:5px">${orgEsc(txt)}</span>`;
    const rows = members.length
      ? members.map((m) => {
        const cap = (Number(m.balance) || 0) + (Number(m.used) || 0);
        const pct = cap > 0 ? Math.round(((Number(m.used) || 0) / cap) * 100) : 0;
        const dn = deptName(m.departmentId);
        const isAdmin = ["owner", "admin"].includes(String(m.orgRole || "").toLowerCase());
        return `<div class="cx-mem-row" data-name="${orgEsc((m.name || "") + " " + (m.email || ""))}" style="display:flex;align-items:center;gap:12px;padding:11px 4px;border-top:1px solid var(--border-soft,#eef2f7)">`
          + orgAvatar(m.name || m.email)
          + `<div style="flex:1;min-width:0"><div style="font-weight:600">${orgEsc(m.name || m.userId)}</div><div style="color:#94a3b8;font-size:11.5px;margin-bottom:3px">${orgEsc(m.email || "")}</div>${dn ? badge(dn, "var(--surface-2,#eef2f7)", "var(--text-2,#475569)") : ""}${badge(isAdmin ? "Quản lý" : "Thành viên", isAdmin ? "#dbeafe" : "var(--surface-2,#eef2f7)", isAdmin ? "#1d4ed8" : "var(--text-2,#475569)")}</div>`
          + `<div style="width:150px"><div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:4px"><b>${orgFmtCr(m.used)}</b><span style="color:var(--label,#64748b)">${orgFmtCr(cap)}</span></div>${orgBar(pct)}</div>`
          + `<div style="width:96px;text-align:center">${badge("Hoạt động", "#dcfce7", "#15803d")}</div></div>`;
      }).join("")
      : '<div style="padding:12px;color:#94a3b8">Chưa có thành viên — thêm bằng nút "Mời thành viên".</div>';
    panel.innerHTML =
      orgCardRow([
        orgCard("Tổng thành viên", String(members.length), "trong tổ chức"),
        orgCard("Quản lý", String(members.filter((m) => ["owner", "admin"].includes(String(m.orgRole || "").toLowerCase())).length), "owner/admin", { accent: "#2563eb" }),
        orgCard("Tổng trần đã cấp", orgFmtCr(members.reduce((s, m) => s + (Number(m.balance) || 0) + (Number(m.used) || 0), 0)), "credit", { accent: "#16a34a" }),
        orgCard("Đã tiêu thụ", orgFmtCr(members.reduce((s, m) => s + (Number(m.used) || 0), 0)), "credit", { accent: "#d97706" }),
      ])
      + `<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button id="cx-add-mem" style="padding:8px 14px;border:0;border-radius:9px;background:#2563eb;color:#fff;font:700 13px Segoe UI;cursor:pointer">✉ Mời thành viên</button></div>`
      + `<input id="cx-mem-search" placeholder="Tìm tên hoặc email…" style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid var(--field-border,#e2e8f0);border-radius:9px;margin-bottom:6px;background:var(--surface,#fff);color:var(--text,#0f172a)">`
      + orgSection("Nhân viên (" + members.length + ")", `<div id="cx-mem-list">${rows}</div>`);
    const search = panel.querySelector("#cx-mem-search");
    if (search) search.addEventListener("input", () => {
      const q = fold(search.value || "").trim();
      panel.querySelectorAll(".cx-mem-row").forEach((r) => { r.style.display = (!q || fold(r.getAttribute("data-name") || "").includes(q)) ? "flex" : "none"; });
    });
    panel.querySelector("#cx-add-mem")?.addEventListener("click", () => openMemberForm());
  }
  function renderOrgAdminPanel(panel) {
    const os = state.orgStructure || {};
    const org = os.organization || {};
    const depts = os.departments || [];
    const members = os.members || [];
    const sig = JSON.stringify({ f: os.fundBalance, d: depts.map((d) => d.id + "|" + d.name + "|" + d.budget + "|" + d.budgetAllocated), m: members.map((m) => m.userId + "|" + m.balance + "|" + m.used + "|" + m.departmentId) });
    if (panel.dataset.cxSig === sig && panel.childElementCount) return; // unchanged → keep DOM (don't reset inputs)
    panel.dataset.cxSig = sig;
    // Group members under their department; members with no/unknown dept go in a "trực tiếp từ quỹ" block.
    const byDept = {};
    const noDept = [];
    members.forEach((m) => {
      const d = m.departmentId && depts.find((x) => x.id === m.departmentId);
      if (d) { (byDept[m.departmentId] = byDept[m.departmentId] || []).push(m); } else { noDept.push(m); }
    });
    const amt = (cls) => `<input type="number" min="1" class="${cls}" placeholder="cr" style="width:84px;padding:5px 7px;border:1px solid var(--field-border,#e2e8f0);border-radius:7px;background:var(--surface,#fff);color:var(--text,#0f172a)">`;
    const memRow = (m, deptId) =>
      `<tr data-uid="${orgEsc(m.userId)}" data-dept="${orgEsc(deptId || "")}" style="border-top:1px solid var(--border-soft,#eef2f7)">`
      + `<td style="padding:7px 8px">${orgEsc(m.name || m.email || m.userId)}<div style="color:#94a3b8;font-size:11px">${orgEsc(m.email || "")} · ${orgEsc(m.orgRole || "member")}</div></td>`
      + `<td style="padding:7px 8px;white-space:nowrap;text-align:right">trần <b>${orgFmtCr(m.balance)}</b> · đã dùng ${orgFmtCr(m.used)}</td>`
      + `<td style="padding:7px 8px;white-space:nowrap;text-align:right">${amt("cx-amt")} `
      + `<button class="cx-go" style="padding:5px 10px;border:0;border-radius:7px;background:#16a34a;color:#fff;cursor:pointer">Phân bổ</button> `
      + `<button class="cx-take" style="padding:5px 10px;border:1px solid var(--field-border,#e2e8f0);border-radius:7px;background:var(--surface,#f8fafc);color:var(--text,#0f172a);cursor:pointer">Thu hồi</button></td></tr>`;
    const deptBlock = (d) => {
      const mem = byDept[d.id] || [];
      const rows = mem.length
        ? mem.map((m) => memRow(m, d.id)).join("")
        : '<tr><td colspan="3" style="padding:8px;color:#94a3b8;font-size:12px">Chưa có thành viên trong phòng — thêm bằng nút "Mời thành viên".</td></tr>';
      return `<div class="cx-dept" data-dept="${orgEsc(d.id)}" style="border:1px solid var(--border-soft,#e2e8f0);border-radius:10px;padding:12px 14px;margin-bottom:12px;background:var(--surface,#fff)">`
        + `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">`
        + `<div style="font:700 14px/1.2 Segoe UI,system-ui">${orgEsc(d.name || d.id)}</div>`
        + `<div style="font-size:12.5px;color:var(--label,#64748b)">Ngân sách phòng còn: <b style="color:var(--text,#0f172a)">${orgFmtCr(d.budget)}</b> cr · đã cấp cho TV ${orgFmtCr(d.budgetAllocated)}</div></div>`
        + `<div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;flex-wrap:wrap"><span style="font-size:12px;color:var(--label,#64748b)">Ngân sách phòng (từ quỹ tổ chức):</span>${amt("cx-dept-amt")} `
        + `<button class="cx-dept-go" style="padding:5px 10px;border:0;border-radius:7px;background:#2563eb;color:#fff;cursor:pointer">+ Cấp ngân sách</button> `
        + `<button class="cx-dept-take" style="padding:5px 10px;border:1px solid var(--field-border,#e2e8f0);border-radius:7px;background:var(--surface,#f8fafc);color:var(--text,#0f172a);cursor:pointer">Thu hồi về quỹ</button></div>`
        + `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>${rows}</tbody></table></div>`;
    };
    const noDeptBlock = noDept.length
      ? `<div class="cx-dept" data-dept="" style="border:1px dashed var(--border-soft,#e2e8f0);border-radius:10px;padding:12px 14px;margin-bottom:4px">`
        + `<div style="font:700 13px Segoe UI;margin-bottom:6px;color:var(--label,#64748b)">Chưa thuộc phòng ban (cấp trực tiếp từ quỹ tổ chức)</div>`
        + `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><tbody>${noDept.map((m) => memRow(m, "")).join("")}</tbody></table></div>`
      : "";
    panel.innerHTML =
      `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">`
      + `<div style="font:800 16px/1.2 Segoe UI,system-ui">Phân bổ Credit${org.name ? (" · " + orgEsc(org.name)) : ""}</div>`
      + `<div style="font-size:12.5px">Quỹ tổ chức còn: <b>${orgFmtCr(os.fundBalance)}</b> cr</div></div>`
      + `<div style="font-size:12px;color:var(--label,#64748b);margin-bottom:12px">Cấp ngân sách cho phòng từ quỹ tổ chức, rồi cấp trần cho từng thành viên trong phòng (tổng ≤ ngân sách phòng). Thay đổi áp dụng ngay.</div>`
      + orgCardRow([
        orgCard("Tổng quỹ", orgFmtCr(os.fundLifetimeAdded), "credit đã nạp", { dark: true }),
        orgCard("Đã phân bổ", orgFmtCr(Math.max(0, (Number(os.fundLifetimeAdded) || 0) - (Number(os.fundBalance) || 0))), `xuống ${depts.length} phòng ban`, { accent: "#2563eb" }),
        orgCard("Còn lại để phân bổ", orgFmtCr(os.fundBalance), "ở quỹ tổ chức", { accent: "#16a34a" }),
      ])
      + (depts.length ? depts.map(deptBlock).join("") : '<div style="color:#94a3b8;margin-bottom:10px">Chưa có phòng ban — tạo bằng nút "Thêm phòng ban" ở trên.</div>')
      + noDeptBlock;
    wireOrgAdminPanel(panel);
  }
  function wireOrgAdminPanel(panel) {
    const bridge = api();
    const orgId = currentOrgId();
    if (!bridge?.portal || !orgId) return;
    const after = async (promise) => {
      try {
        const r = await promise;
        if (r && r.ok === false) { showActionToast(r.error || "Lỗi", "error"); return; }
        showActionToast("Đã cập nhật phân bổ", "ok");
        await ensureOrgStructureLoaded(true); // force-reload the roster + budgets so the panel reflects the change
        patchOrgAdminPanel();
        patchVisibleCreditTextsSoon();
      } catch (e) { showActionToast(e?.message || "Lỗi", "error"); }
    };
    // LEVEL 1 — org fund <-> department budget.
    panel.querySelectorAll(".cx-dept").forEach((block) => {
      const deptId = block.getAttribute("data-dept");
      if (!deptId) return; // the "no department" block carries no dept-budget controls
      const amtEl = block.querySelector(".cx-dept-amt");
      block.querySelector(".cx-dept-go")?.addEventListener("click", () => {
        const amount = Number(amtEl?.value || 0);
        if (!(amount > 0)) { showActionToast("Nhập số credit cấp cho phòng", "error"); return; }
        after(bridge.portal.allocate({ orgId, target: "department", departmentId: deptId, amount }));
      });
      block.querySelector(".cx-dept-take")?.addEventListener("click", () => {
        const amount = Number(amtEl?.value || 0);
        if (!(amount > 0)) { showActionToast("Nhập số credit thu hồi", "error"); return; }
        after(bridge.portal.allocate({ orgId, target: "department", departmentId: deptId, amount, mode: "reclaim" }));
      });
    });
    // LEVEL 2 — department budget (or org fund for dept-less members) <-> member cap.
    panel.querySelectorAll("tr[data-uid]").forEach((tr) => {
      const uid = tr.getAttribute("data-uid");
      const deptId = tr.getAttribute("data-dept") || "";
      const amtEl = tr.querySelector(".cx-amt");
      tr.querySelector(".cx-go")?.addEventListener("click", () => {
        const amount = Number(amtEl?.value || 0);
        if (!(amount > 0)) { showActionToast("Nhập số credit", "error"); return; }
        after(bridge.portal.allocate({ orgId, target: "member", toUserId: uid, departmentId: deptId, amount }));
      });
      tr.querySelector(".cx-take")?.addEventListener("click", () => {
        const amount = Number(amtEl?.value || 0);
        if (!(amount > 0)) { showActionToast("Nhập số credit thu hồi", "error"); return; }
        after(bridge.portal.allocate({ orgId, target: "member", toUserId: uid, departmentId: deptId, amount, mode: "reclaim" }));
      });
    });
  }

  // Make the TEMPLATE's demo org buttons ("Thêm phòng ban" / "Mời thành viên") actually work: intercept
  // the click, open a real form modal, and call the App Server. The demo onclick stubs only flash a toast.
  const ORG_INPUT_CSS = "padding:8px 10px;border:1px solid var(--field-border,#e2e8f0);border-radius:8px;font:inherit;color:var(--text,#0f172a);background:var(--surface,#fff)";
  function openOrgModal(title, fieldsHtml, onSubmit) {
    const old = document.getElementById("centrix-org-modal"); if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "centrix-org-modal";
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55);font:400 13px/1.5 Segoe UI,system-ui,sans-serif";
    const card = document.createElement("div");
    card.style.cssText = "width:min(420px,calc(100vw - 40px));background:var(--surface,#fff);color:var(--text,#0f172a);border-radius:14px;padding:20px;box-shadow:0 24px 60px rgba(15,23,42,.35)";
    card.innerHTML = `<div style="font:800 16px/1.3 Segoe UI,system-ui;margin-bottom:14px">${orgEsc(title)}</div>`
      + `<div style="display:flex;flex-direction:column;gap:10px">${fieldsHtml}</div>`
      + `<div style="display:flex;gap:9px;margin-top:16px"><button id="cx-org-save" style="flex:1;padding:10px;border:0;border-radius:10px;background:#2563eb;color:#fff;font:700 13px Segoe UI;cursor:pointer">Lưu</button>`
      + `<button id="cx-org-cancel" style="padding:10px 16px;border:1px solid var(--field-border,#e2e8f0);border-radius:10px;background:var(--surface-2,#f8fafc);color:var(--text,#0f172a);cursor:pointer">Huỷ</button></div>`;
    ov.appendChild(card);
    document.body.appendChild(ov);
    const close = () => { try { ov.remove(); } catch { /* ignore */ } };
    card.querySelector("#cx-org-cancel").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    card.querySelector("#cx-org-save").addEventListener("click", async () => {
      const btn = card.querySelector("#cx-org-save"); btn.disabled = true;
      try { const ok = await onSubmit(card); if (ok !== false) close(); } catch (e) { showActionToast(e?.message || "Lỗi", "error"); } finally { btn.disabled = false; }
    });
    const first = card.querySelector("input"); if (first) first.focus();
  }
  function openDeptForm() {
    if (!isOrgAdmin() || !currentOrgId()) { showActionToast("Bạn không có quyền quản trị tổ chức", "error"); return; }
    openOrgModal("Thêm phòng ban", `<input id="cx-f-deptname" placeholder="Tên phòng ban" style="${ORG_INPUT_CSS}">`, async (card) => {
      const name = (card.querySelector("#cx-f-deptname").value || "").trim();
      if (!name) { showActionToast("Nhập tên phòng ban", "error"); return false; }
      const r = await api().portal.addDepartment({ orgId: currentOrgId(), name });
      if (r && r.ok === false) { showActionToast(r.error || "Lỗi thêm phòng ban", "error"); return false; }
      showActionToast("Đã thêm phòng ban", "ok");
      await ensureOrgStructureLoaded(true); refreshOrgIntoDemo();
    });
  }
  function openMemberForm() {
    if (!isOrgAdmin() || !currentOrgId()) { showActionToast("Bạn không có quyền quản trị tổ chức", "error"); return; }
    const depts = (state.orgStructure && state.orgStructure.departments) || [];
    const opts = ['<option value="">— Phòng ban (tuỳ chọn) —</option>'].concat(depts.map((d) => `<option value="${orgEsc(d.id)}">${orgEsc(d.name || d.id)}</option>`)).join("");
    openOrgModal("Thêm nhân viên",
      `<input id="cx-f-memmail" type="email" placeholder="Email nhân viên" style="${ORG_INPUT_CSS}">`
      + `<input id="cx-f-memname" placeholder="Tên (tuỳ chọn)" style="${ORG_INPUT_CSS}">`
      + `<select id="cx-f-memdept" style="${ORG_INPUT_CSS}">${opts}</select>`,
      async (card) => {
        const email = (card.querySelector("#cx-f-memmail").value || "").trim();
        const name = (card.querySelector("#cx-f-memname").value || "").trim();
        const departmentId = card.querySelector("#cx-f-memdept").value || "";
        if (!email) { showActionToast("Nhập email nhân viên", "error"); return false; }
        const r = await api().portal.addMember({ orgId: currentOrgId(), email, name, departmentId, orgRole: "member" });
        if (r && r.ok === false) { showActionToast(r.error || "Lỗi thêm nhân viên", "error"); return false; }
        showActionToast("Đã thêm nhân viên", "ok");
        await ensureOrgStructureLoaded(true); refreshOrgIntoDemo();
      });
  }
  // Identify a demo org button by its short folded text + small hit-area (leaf button, not a wide toolbar).
  function orgButtonKind(target) {
    let el = target;
    for (let i = 0; i < 5 && el; i += 1) {
      const t = fold(el.textContent || "").trim();
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (t.length <= 30 && r && r.width > 0 && r.height > 0 && r.width <= 600) {
        if (t.includes("them phong ban")) return "dept";
        if (t.includes("moi thanh vien") || t.includes("them thanh vien") || t.includes("moi nhan vien")) return "member";
      }
      el = el.parentElement;
    }
    return "";
  }

  // Walk up to the nearest inline-styled CSS-grid ancestor (the personal dashboard's 3-panel grid).
  function gridAncestorOf(node) {
    let el = node;
    for (let i = 0; i < 10 && el; i += 1) {
      const style = el.getAttribute && el.getAttribute("style");
      if (style && /display\s*:\s*grid/.test(style) && /grid-template-columns/.test(style)) return el;
      el = el.parentElement;
    }
    return null;
  }
  // From a descendant, return the element that is a DIRECT child of `grid` (the panel card).
  function gridChildOf(node, grid) {
    let el = node;
    for (let i = 0; i < 10 && el; i += 1) {
      if (el.parentElement === grid) return el;
      el = el.parentElement;
    }
    return null;
  }
  // Put "Tiêu thụ theo dịch vụ · kỳ này" (B) and "Khấu trừ theo thời gian thực" (C) on ONE row. These two
  // + the "Số dư credit cá nhân" balance card (A) are the 3 children of one inline-styled grid that the
  // template lays out as a single column (stacked). We switch the grid to 2 columns, keep A full-width on
  // top (grid-column:1/-1), and let B|C share the row. Idempotent + self-healing: re-asserted by the same
  // observer/interval cadence whenever a React re-render resets the inline style. (No DOM moves.)
  // Find the lowest common parent where headA and headB each have a SIBLING ancestor (the two section
  // cards). Works whether the parent is block/flex/grid — we do NOT assume a pre-existing grid.
  function siblingCardsFor(headA, headB) {
    let a = headA;
    while (a && a !== document.body) {
      const parent = a.parentElement;
      if (parent) {
        let b = headB;
        while (b && b !== document.body) {
          if (b.parentElement === parent && b !== a) return { parent, cardA: a, cardB: b };
          b = b.parentElement;
        }
      }
      a = a.parentElement;
    }
    return null;
  }
  function applyPersonalPanelRow() {
    if (!document.body || !state.loginOk) return;
    const consumeHead = narrowestDivWith("tieu thu theo dich vu", "ky nay");
    const deductHead = narrowestDivWith("khau tru theo thoi gian thuc");
    if (!consumeHead || !deductHead) return;
    // B (consumption bars "Tiêu thụ theo dịch vụ") and C (deduction log "Khấu trừ theo thời gian thực")
    // are STACKED sibling <div>s (margin-top:14px), NOT inside a CSS grid — the old gridAncestorOf found
    // nothing so the row never applied. Force their common parent to a 2-column grid: B|C share one row;
    // every other child (balance card A, recent activity, ...) spans full width so it looks unchanged.
    // Idempotent + self-healing (re-asserted by the observer/interval whenever React resets inline style).
    const found = siblingCardsFor(consumeHead, deductHead);
    if (!found) return;
    const parent = found.parent;
    const consumeCard = found.cardA;
    const deductCard = found.cardB;
    if (consumeCard === deductCard) return;
    parent.style.setProperty("display", "grid", "important");
    parent.style.setProperty("grid-template-columns", "1fr 1fr", "important");
    parent.style.setProperty("align-items", "start", "important");
    parent.style.setProperty("column-gap", "14px", "important"); // horizontal gap between B|C; vertical via margins
    for (const child of Array.from(parent.children)) {
      if (child === consumeCard || child === deductCard) {
        child.style.setProperty("grid-column", "auto", "important");
        child.style.setProperty("min-width", "0", "important"); // shrink long rows instead of overflowing
      } else {
        child.style.setProperty("grid-column", "1 / -1", "important"); // other cards stay full-width
      }
    }
  }

  function formatHistoryDateTime(at) {
    const date = at ? new Date(at) : new Date();
    if (!Number.isFinite(date.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(date.getDate())}/${p(date.getMonth() + 1)}/${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}`;
  }

  function usageHistoryRowHtml(t) {
    const amt = Number(t.amountDelta || 0);
    const kind = String(t.kind || t.type || "");
    let accent = "var(--text-3)";
    let bg = "transparent";
    let title;
    let metaColor = "var(--text-3)";
    let meta;
    if (kind === "open-service") {
      const svc = t.serviceName || serviceNameForId(t.serviceId, t.serviceId || "dịch vụ");
      accent = "var(--brand-border)";
      title = `Mở dịch vụ ${svc}`;
      meta = "phiên mới";
    } else if (kind === "login" || kind === "login-new-device") {
      title = `Đăng nhập${t.email ? " · " + t.email : ""}`;
      meta = kind === "login-new-device" ? "thiết bị mới" : "đăng nhập";
    } else {
      const positive = kind === "topup" || (kind === "adjust" && amt > 0);
      accent = kind === "debit" ? "var(--brand)" : positive ? "var(--ok)" : kind === "blocked" ? "var(--danger)" : "var(--text-3)";
      bg = positive ? "var(--ok-soft)" : "transparent";
      const svc = serviceNameForId(t.serviceId, "");
      title = kind === "debit" ? `Dùng ${t.modelId || "model"}${svc ? " · " + svc : ""}`
        : positive ? "Nạp credit"
        : (kind === "adjust" && amt < 0) ? "Điều chỉnh credit"
        : kind === "blocked" ? `Chặn ${t.modelId || "model"}`
        : (t.reason || "Giao dịch");
      metaColor = positive ? "var(--ok-text)" : kind === "blocked" ? "var(--danger)" : "var(--brand)";
      meta = kind === "blocked" ? "Bị chặn" : `${amt >= 0 ? "+" : "−"}${formatCreditValue(Math.abs(amt))} credit`;
    }
    return `<div data-cx-usage="1" style="display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid var(--border-soft);border-left:4px solid ${accent};border-radius:12px;background:${bg};padding:13px 16px;">`
      + `<div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;color:var(--text);">${escapeHtml(title)}</div>`
      + `<div style="font-size:12px;color:var(--text-3);margin-top:2px;">${escapeHtml(formatHistoryDateTime(t.createdAt))}</div></div>`
      + `<span style="font-size:13px;font-weight:700;color:${metaColor};white-space:nowrap;flex-shrink:0;">${escapeHtml(meta)}</span>`
      + `</div>`;
  }

  // "Lịch sử sử dụng" pagination: 5 rows/page, the rest spill onto numbered pages.
  const USAGE_PAGE_SIZE = 5;

  // Page-index list with ellipsis for the pager (standard windowed pagination: 1 … p-1 p p+1 … last).
  function usagePageWindow(page, pages) {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i);
    const wanted = [...new Set([0, page - 1, page, page + 1, pages - 1])]
      .filter((i) => i >= 0 && i < pages)
      .sort((a, b) => a - b);
    const out = [];
    let prev = -1;
    for (const i of wanted) {
      if (prev >= 0 && i - prev > 1) out.push("...");
      out.push(i);
      prev = i;
    }
    return out;
  }

  function usagePagerHtml(page, pages) {
    const cell = (label, target, opts) => {
      const o = opts || {};
      const base = "min-width:32px;height:32px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;font-size:13px;font-weight:600;user-select:none;border:1px solid var(--border);";
      let style;
      if (o.active) style = base + "background:var(--brand);border-color:var(--brand);color:#fff;cursor:default;";
      else if (o.disabled) style = base + "background:var(--surface-2);color:var(--text-3);opacity:.5;cursor:default;";
      else style = base + "background:var(--surface);color:var(--text-2);cursor:pointer;";
      const attr = (o.active || o.disabled) ? "" : ` data-cx-page="${target}"`;
      return `<div${attr} style="${style}">${label}</div>`;
    };
    const parts = [cell("‹", page - 1, { disabled: page <= 0 })];
    for (const it of usagePageWindow(page, pages)) {
      if (it === "...") parts.push(`<div style="min-width:22px;text-align:center;color:var(--text-3);font-size:13px;">…</div>`);
      else parts.push(cell(String(it + 1), it, { active: it === page }));
    }
    parts.push(cell("›", page + 1, { disabled: page >= pages - 1 }));
    return `<div data-cx-pager="1" style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;padding:10px 0 2px;">${parts.join("")}</div>`;
  }

  // One delegated click handler on the (persistent) container — survives innerHTML re-renders and
  // is guarded so repeated patchUsageHistory() calls don't stack listeners.
  function wireUsagePager(container) {
    if (!container || container.dataset.cxPagerWired === "1") return;
    container.dataset.cxPagerWired = "1";
    container.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-cx-page]") : null;
      if (!btn || !container.contains(btn)) return;
      const p = parseInt(btn.getAttribute("data-cx-page"), 10);
      if (isNaN(p)) return;
      e.preventDefault();
      e.stopPropagation();
      state.usageHistoryPage = p;
      patchUsageHistory();
    });
  }

  // ── "Lịch sử sử dụng" V2 — full-screen replacement wired to REAL data ─────────────────────────────
  // The design shipped a plain sample list; the product wants the richer screen (4 stat tiles, type
  // chips, search, time filter, 10-row pages, CSV export). We keep the template's own header/list as
  // the mount sentinel (visually collapsed, still laid out) and render our root next to it. Rows come
  // from portal.creditTransactions (deepest per-user window, 120) merged with /api/me recentHistory's
  // open-service + login items; tiles/counts are computed over the active TIME window.
  const UH2_PAGE_SIZE = 10;
  let uh2Page = 1;          // 1-based page of the V2 table
  let uh2Class = "all";     // all | use | topup | open | login
  let uh2Search = "";
  let uh2Time = "all";      // all | 7d | 30d | month
  let uh2MenuOpen = false;  // time-filter dropdown open?
  let uh2Refocus = false;   // restore focus to the search box after an innerHTML re-render

  function uh2HostFromDeviceId(id) {
    // deviceId = "<hostname>-<6 random chars>" (per app launch); the hostname prefix is the readable part.
    const raw = String(id || "").trim();
    if (!raw) return "";
    return raw.replace(/-[a-z0-9]{6}$/i, "");
  }

  // Normalize one credit transaction / history item into a display row for the V2 screen.
  function uh2RowFromTx(t) {
    const amt = Number(t.amountDelta || 0);
    const kind = String(t.kind || t.type || "");
    const at = Date.parse(t.createdAt || "") || 0;
    const svc = t.serviceName || serviceNameForId(t.serviceId, "");
    if (kind === "plan-gate-log") return null; // shadow-mode marker rows are internal noise
    if (kind === "open-service") {
      return { cls: "open", title: `Mở dịch vụ ${svc || t.serviceId || ""}`.trim(), sub: "Phiên mới", at, credit: null };
    }
    if (kind === "login" || kind === "login-new-device") {
      const host = uh2HostFromDeviceId(t.deviceId) || "Thiết bị này";
      const sub = kind === "login-new-device" ? `${host} · thiết bị mới` : host;
      return { cls: "login", title: "Đăng nhập", sub, at, credit: null };
    }
    if (kind === "debit") {
      return { cls: "use", title: `Dùng ${t.modelId || "model"}`, sub: svc || "Dịch vụ AI", at, credit: amt };
    }
    const topupLike = kind === "topup" || (amt > 0 && /^(adjust|org-allocate|org-dept-allocate)$/.test(kind));
    if (topupLike) {
      const reason = String(t.reason || "");
      const sub = (String(t.actor || "") === "sepay" || /^topup-order/.test(reason)) ? "Qua VietQR"
        : reason === "plan-grant" ? "Tặng theo gói"
        : kind === "org-allocate" ? "Cấp từ quỹ tổ chức"
        : (t.serviceId === "admin" || reason === "manual-topup") ? "Nạp bởi quản trị"
        : "Nạp credit";
      return { cls: "topup", title: `Nạp ${formatCreditValue(Math.abs(amt))} credit`, sub, at, credit: amt };
    }
    if (kind === "blocked") {
      return { cls: "other", title: `Chặn ${t.modelId || "model"}`, sub: svc || String(t.reason || ""), at, credit: null };
    }
    if (kind === "adjust" && amt < 0) {
      return { cls: "other", title: "Điều chỉnh credit", sub: "Quản trị viên", at, credit: amt };
    }
    if (/^org-/.test(kind)) {
      return { cls: "other", title: "Thu hồi credit tổ chức", sub: "Quỹ tổ chức", at, credit: amt || null };
    }
    return { cls: "other", title: String(t.reason || "Giao dịch"), sub: svc, at, credit: amt || null };
  }

  // Merge the two real feeds (portal tx window + /api/me merged history) into one sorted row list.
  function uh2AllRows() {
    const p = state.portal || {};
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : p;
    const txs = Array.isArray(inner.creditTransactions) ? inner.creditTransactions
      : (Array.isArray((state.account || {}).recentTransactions) ? state.account.recentTransactions : []);
    const hist = Array.isArray((state.account || {}).recentHistory) ? state.account.recentHistory : [];
    const rows = [];
    for (const t of txs) { const r = uh2RowFromTx(t); if (r) rows.push(r); }
    for (const t of hist) {
      const kind = String(t.kind || "");
      if (kind !== "open-service" && kind !== "login" && kind !== "login-new-device") continue; // tx kinds already covered
      const r = uh2RowFromTx(t);
      if (r) rows.push(r);
    }
    rows.sort((a, b) => b.at - a.at);
    return rows;
  }

  function uh2TimeWindowStart() {
    const now = new Date();
    if (uh2Time === "7d") return now.getTime() - 7 * 86400000;
    if (uh2Time === "30d") return now.getTime() - 30 * 86400000;
    if (uh2Time === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return 0;
  }

  const UH2_TIME_LABELS = { all: "Tất cả thời gian", "7d": "7 ngày qua", "30d": "30 ngày qua", month: "Tháng này" };
  const UH2_CLASS_LABELS = { all: "Tất cả", use: "Sử dụng AI", topup: "Nạp credit", open: "Mở dịch vụ", login: "Đăng nhập" };

  function uh2BadgeHtml(cls) {
    const icon = {
      use: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"></path></svg>`,
      open: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path></svg>`,
      topup: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ok-text)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v8M8 12h8"></path></svg>`,
      login: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V6z"></path><path d="M9 12l2 2 4-4"></path></svg>`,
      other: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path></svg>`
    }[cls] || "";
    const look = {
      use: "color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);",
      open: "color:#7c3aed;background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.28);",
      topup: "color:var(--ok-text);background:var(--ok-soft);border:1px solid var(--ok-border);",
      login: "color:#d97706;background:rgba(217,119,6,.12);border:1px solid rgba(217,119,6,.28);",
      other: "color:var(--text-2);background:var(--surface-3);border:1px solid var(--border);"
    }[cls] || "";
    const label = cls === "other" ? "Khác" : (UH2_CLASS_LABELS[cls] || cls);
    return `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;border-radius:999px;padding:4px 11px 4px 8px;${look}">${icon}<span>${escapeHtml(label)}</span></span>`;
  }

  function uh2CreditCellHtml(row) {
    if (row.credit == null || row.credit === 0) return `<div style="font-size:13px;font-weight:700;color:var(--text-3);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">—</div>`;
    const positive = row.credit > 0;
    const color = positive ? "var(--ok-text)" : "var(--text)";
    const sign = positive ? "+" : "−";
    return `<div style="font-size:13px;font-weight:700;color:${color};text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${sign}${formatCreditValue(Math.abs(row.credit))} credit</div>`;
  }

  function uh2RangeLabel(rows) {
    if (!rows.length) return UH2_TIME_LABELS[uh2Time] || "—";
    const p = (n) => String(n).padStart(2, "0");
    const oldest = new Date(rows[rows.length - 1].at);
    const newest = new Date(rows[0].at);
    return `${p(oldest.getDate())}/${p(oldest.getMonth() + 1)} – ${p(newest.getDate())}/${p(newest.getMonth() + 1)}/${newest.getFullYear()}`;
  }

  function uh2ExportCsv(rows) {
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = ["Loại,Hoạt động,Chi tiết,Thời gian,Credit"];
    for (const r of rows) {
      const label = r.cls === "other" ? "Khác" : (UH2_CLASS_LABELS[r.cls] || r.cls);
      const credit = r.credit == null || r.credit === 0 ? "" : `${r.credit > 0 ? "+" : "-"}${Math.abs(r.credit)}`;
      lines.push([q(label), q(r.title), q(r.sub), q(formatHistoryDateTime(r.at)), q(credit)].join(","));
    }
    cxDownload("lich-su-su-dung.csv", lines.join("\r\n"), "text/csv;charset=utf-8");
  }

  function patchUsageHistory() {
    const header = findLeafByText("usage-history", /^Lịch sử sử dụng$/i);
    const mounted = document.querySelector('[data-cx-uh2="1"]');
    if (!header || !isLaidOut(header)) {
      // Screen left (React unmounted the Lịch sử subtree) — our root lives on the SHARED scroll
      // container, so it must be torn down by hand or it bleeds into the other tabs.
      if (mounted) { mounted.remove(); uh2MenuOpen = false; }
      return;
    }
    if (!state.account && !state.portalReady) return; // wait for real data — never paint zeros over the seed

    // Collapse the template's own header + sample list. The header stays LAID OUT (position:absolute,
    // zero-size) because it is our mount/visibility sentinel; display:none would break isLaidOut().
    const HIDE_HEADER = "position:absolute;height:0;overflow:hidden;opacity:0;pointer-events:none;margin:0;padding:0;";
    if (header.getAttribute("data-cx-uh2-hidden") !== "1") {
      header.setAttribute("data-cx-uh2-hidden", "1");
      header.style.cssText += HIDE_HEADER;
    }
    const list = header.nextElementSibling;
    if (list && list.tagName === "DIV" && !list.hasAttribute("data-cx-uh2") && list.style.display !== "none") {
      list.style.display = "none";
    }

    const all = uh2AllRows();
    const windowStart = uh2TimeWindowStart();
    const inWindow = windowStart ? all.filter((r) => r.at >= windowStart) : all;
    const needle = fold(uh2Search);
    const searched = needle ? inWindow.filter((r) => fold(`${r.title} ${r.sub}`).includes(needle)) : inWindow;
    const counts = { all: searched.length, use: 0, topup: 0, open: 0, login: 0 };
    for (const r of searched) { if (counts[r.cls] != null) counts[r.cls] += 1; }
    const filtered = uh2Class === "all" ? searched : searched.filter((r) => r.cls === uh2Class);

    // Stat tiles reflect the TIME window (not search/type) — "trong kỳ này".
    const aiCount = inWindow.filter((r) => r.cls === "use").length;
    const spent = inWindow.reduce((s, r) => s + (r.cls === "use" && r.credit < 0 ? -r.credit : 0), 0);
    const added = inWindow.reduce((s, r) => s + (r.cls === "topup" && r.credit > 0 ? r.credit : 0), 0);

    const pages = Math.max(1, Math.ceil(filtered.length / UH2_PAGE_SIZE));
    uh2Page = Math.min(Math.max(1, uh2Page), pages);
    const start = (uh2Page - 1) * UH2_PAGE_SIZE;
    const pageRows = filtered.slice(start, start + UH2_PAGE_SIZE);

    const tile = (label, value, cap, valueColor) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:14px 16px;box-shadow:0 1px 3px var(--shadow);">
        <div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.05em;text-transform:uppercase;">${escapeHtml(label)}</div>
        <div style="font-size:25px;font-weight:700;color:${valueColor || "var(--text)"};letter-spacing:-.02em;line-height:1.1;margin-top:7px;font-variant-numeric:tabular-nums;">${escapeHtml(value)}</div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:3px;">${escapeHtml(cap)}</div>
      </div>`;

    const chip = (cls) => {
      const active = uh2Class === cls;
      const shell = active
        ? "color:#fff;background:var(--brand);border:1px solid var(--brand);"
        : "color:var(--text-2);background:var(--surface);border:1px solid var(--field-border);";
      const pill = active
        ? "background:rgba(255,255,255,.22);color:#fff;"
        : "background:var(--surface-3);color:var(--text-3);";
      return `<button type="button" data-cx-uh2-class="${cls}" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;${shell}border-radius:9px;padding:8px 12px;cursor:pointer;">`
        + `${escapeHtml(UH2_CLASS_LABELS[cls])}<span style="font-size:11px;font-weight:700;${pill}border-radius:999px;padding:1px 7px;min-width:14px;text-align:center;">${counts[cls] || 0}</span></button>`;
    };

    const timeMenu = !uh2MenuOpen ? "" : `
      <div style="position:absolute;top:calc(100% + 6px);right:0;z-index:40;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px var(--shadow-pop);padding:5px;min-width:170px;">
        ${Object.keys(UH2_TIME_LABELS).map((k) => `<div data-cx-uh2-time="${k}" style="font-size:12.5px;font-weight:600;color:${k === uh2Time ? "var(--brand)" : "var(--text-2)"};padding:8px 11px;border-radius:7px;cursor:pointer;${k === uh2Time ? "background:var(--brand-soft);" : ""}">${escapeHtml(UH2_TIME_LABELS[k])}</div>`).join("")}
      </div>`;

    const rowHtml = (r) => `
      <div style="display:grid;grid-template-columns:minmax(150px,170px) 1.6fr minmax(140px,180px) 120px;gap:14px;align-items:center;padding:12px 18px;border-bottom:1px solid var(--border-soft);">
        <div>${uh2BadgeHtml(r.cls)}</div>
        <div style="min-width:0;">
          <div style="font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.title)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.sub || "")}</div>
        </div>
        <div style="font-size:12.5px;color:var(--text-2);font-variant-numeric:tabular-nums;">${escapeHtml(formatHistoryDateTime(r.at))}</div>
        ${uh2CreditCellHtml(r)}
      </div>`;

    const emptyHtml = `<div style="padding:34px 18px;text-align:center;font-size:13px;color:var(--text-3);">Chưa có hoạt động nào${uh2Search || uh2Class !== "all" || uh2Time !== "all" ? " khớp bộ lọc" : ""}.</div>`;

    const shown = filtered.length ? `${start + 1}–${Math.min(start + UH2_PAGE_SIZE, filtered.length)}` : "0";
    const pagerBtn = (label, target, disabled) => `<button type="button" ${disabled ? "disabled" : `data-cx-uh2-page="${target}"`} style="display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:var(--text-2);background:var(--surface);border:1px solid var(--field-border);border-radius:8px;width:30px;height:30px;line-height:1;cursor:${disabled ? "default" : "pointer"};opacity:${disabled ? ".35" : "1"};">${label}</button>`;

    const searchIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><path d="m21 21-4.3-4.3"></path></svg>`;
    const calIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4M8 2v4M3 10h18"></path></svg>`;
    const dlIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 11l4 4 4-4M4 21h16"></path></svg>`;
    const clockIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5V12l3 2"></path></svg>`;

    const html = `
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px;">
        <div style="min-width:0;">
          <div style="font-size:19px;font-weight:700;color:var(--text);letter-spacing:-.01em;line-height:1.2;"><span>Lịch sử sử dụng</span></div>
          <div style="font-size:13px;font-weight:500;color:var(--text-2);line-height:1.45;margin-top:4px;">Toàn bộ hoạt động credit, phiên dịch vụ và đăng nhập trên tài khoản của bạn.</div>
        </div>
        <div style="display:flex;align-items:center;gap:9px;flex-shrink:0;">
          <div style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--text-2);background:var(--surface);border:1px solid var(--field-border);border-radius:9px;padding:8px 12px;">${calIcon}${escapeHtml(uh2RangeLabel(inWindow))}</div>
          <button type="button" data-cx-uh2-csv="1" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:9px;padding:8px 13px;cursor:pointer;">${dlIcon}Xuất CSV</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px;">
        ${tile("Tổng hoạt động", String(inWindow.length), "Trong kỳ này")}
        ${tile("Lượt dùng AI", String(aiCount), "Phiên gọi mô hình")}
        ${tile("Credit đã tiêu", spent ? `−${formatCreditValue(spent)}` : "0", "Tổng khấu trừ")}
        ${tile("Credit đã nạp", added ? `+${formatCreditValue(added)}` : "0", "Tổng nạp vào ví", added ? "var(--ok-text)" : "var(--text)")}
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <div style="position:relative;flex:1 1 0%;min-width:220px;">
          <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-3);display:flex;pointer-events:none;">${searchIcon}</span>
          <input data-cx-uh2-search="1" placeholder="Tìm theo mô hình, dịch vụ hoặc hoạt động…" value="${escapeHtml(uh2Search)}" style="width:100%;font-size:13px;color:var(--text);background:var(--field-bg);border:1px solid var(--field-border);border-radius:10px;padding:10px 13px 10px 36px;box-sizing:border-box;outline:none;">
        </div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;">${["all", "use", "topup", "open", "login"].map(chip).join("")}</div>
        <div style="position:relative;flex-shrink:0;">
          <button type="button" data-cx-uh2-time-btn="1" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--text-2);background:var(--surface);border:1px solid var(--field-border);border-radius:9px;padding:8px 12px;cursor:pointer;white-space:nowrap;">${clockIcon}<span>${escapeHtml(UH2_TIME_LABELS[uh2Time])}</span><span style="font-size:8px;color:var(--text-3);margin-left:1px;">▼</span></button>
          ${timeMenu}
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="display:grid;grid-template-columns:minmax(150px,170px) 1.6fr minmax(140px,180px) 120px;gap:14px;padding:11px 18px;background:var(--surface-2);border-bottom:1px solid var(--border);">
          <div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;">Loại</div>
          <div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;">Hoạt động</div>
          <div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;">Thời gian</div>
          <div style="font-size:11px;font-weight:700;color:var(--label);letter-spacing:.06em;text-transform:uppercase;text-align:right;">Credit</div>
        </div>
        ${pageRows.length ? pageRows.map(rowHtml).join("") : emptyHtml}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 18px;background:var(--surface-2);border-top:1px solid var(--border);">
          <div style="font-size:12px;color:var(--text-3);">Hiển thị <span>${shown} trên ${filtered.length} mục</span></div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:12px;font-weight:600;color:var(--text-2);">Trang ${uh2Page}/${pages}</span>
            ${pagerBtn("‹", uh2Page - 1, uh2Page <= 1)}
            ${pagerBtn("›", uh2Page + 1, uh2Page >= pages)}
          </div>
        </div>
      </div>`;

    let root = mounted;
    if (!root || !root.isConnected || root.parentElement !== header.parentElement) {
      if (root) root.remove();
      root = document.createElement("div");
      root.setAttribute("data-cx-uh2", "1");
      (list && list.parentElement === header.parentElement ? list : header).insertAdjacentElement("afterend", root);
    }
    if (root.dataset.centrixUh2Key !== html) {
      root.dataset.centrixUh2Key = html;
      root.innerHTML = html;
      if (uh2Refocus) {
        uh2Refocus = false;
        const input = root.querySelector("[data-cx-uh2-search]");
        if (input) { input.focus(); try { input.setSelectionRange(input.value.length, input.value.length); } catch {} }
      }
    }
    wireUh2(root);
  }

  function wireUh2(root) {
    if (!root || root.dataset.cxUh2Wired === "1") return;
    root.dataset.cxUh2Wired = "1";
    root.addEventListener("click", (e) => {
      const hit = (sel) => e.target && e.target.closest ? e.target.closest(sel) : null;
      const chipBtn = hit("[data-cx-uh2-class]");
      if (chipBtn) { e.stopPropagation(); uh2Class = chipBtn.getAttribute("data-cx-uh2-class") || "all"; uh2Page = 1; uh2MenuOpen = false; patchUsageHistory(); return; }
      const pageBtn = hit("[data-cx-uh2-page]");
      if (pageBtn) { const p = parseInt(pageBtn.getAttribute("data-cx-uh2-page"), 10); if (!isNaN(p)) { uh2Page = p; patchUsageHistory(); } return; }
      const timeOpt = hit("[data-cx-uh2-time]");
      if (timeOpt) { uh2Time = timeOpt.getAttribute("data-cx-uh2-time") || "all"; uh2Page = 1; uh2MenuOpen = false; patchUsageHistory(); return; }
      if (hit("[data-cx-uh2-time-btn]")) { uh2MenuOpen = !uh2MenuOpen; patchUsageHistory(); return; }
      if (hit("[data-cx-uh2-csv]")) {
        const all = uh2AllRows();
        const windowStart = uh2TimeWindowStart();
        const inWindow = windowStart ? all.filter((r) => r.at >= windowStart) : all;
        const needle = fold(uh2Search);
        const searched = needle ? inWindow.filter((r) => fold(`${r.title} ${r.sub}`).includes(needle)) : inWindow;
        uh2ExportCsv(uh2Class === "all" ? searched : searched.filter((r) => r.cls === uh2Class));
        return;
      }
      if (uh2MenuOpen && !hit("[data-cx-uh2-time-btn]") && !hit("[data-cx-uh2-time]")) { uh2MenuOpen = false; patchUsageHistory(); }
    });
    root.addEventListener("input", (e) => {
      const input = e.target && e.target.closest ? e.target.closest("[data-cx-uh2-search]") : null;
      if (!input) return;
      uh2Search = String(input.value || "");
      uh2Page = 1;
      uh2Refocus = true;
      patchUsageHistory();
    });
  }

  // Render the REAL credit transactions (from /api/me recentTransactions) into the "Hoạt động gần
  // đây" list — it is the same static child component that ships sample rows ("Mua 500 credit",
  // "Nâng cấp gói Pro") that the renderVals pLog override never reaches. DOM-patch it directly.
  function activityRowHtml(t) {
    const amt = Number(t.amountDelta || 0);
    const type = String(t.type || "");
    const positive = type === "topup" || (type === "adjust" && amt > 0);
    const dot = type === "debit" ? "var(--brand)"
      : positive ? "var(--ok)"
      : type === "blocked" ? "var(--danger)"
      : "var(--text-3)";
    const creditPart = `${amt >= 0 ? "+" : "−"}${formatCreditValue(Math.abs(amt))} credit`;
    const title = type === "debit" ? `Dùng ${t.modelId || t.serviceId || "model"} · ${creditPart}`
      : positive ? `Nạp credit · ${creditPart}`
      : (type === "adjust" && amt < 0) ? `Điều chỉnh · ${creditPart}`
      : type === "blocked" ? `Chặn ${t.modelId || "model"}`
      : `${t.reason || "Giao dịch"} · ${creditPart}`;
    const time = formatUrlTime(Date.parse(t.createdAt || "") || Date.now());
    // Match the template's activity row: round dot + title line + time line.
    return `<div style="display:flex;gap:11px;">`
      + `<div style="width:9px;height:9px;border-radius:50%;background:${dot};margin-top:5px;flex-shrink:0;"></div>`
      + `<div><div style="font-size:13px;font-weight:600;color:var(--text);">${escapeHtml(title)}</div>`
      + `<div style="font-size:11.5px;color:var(--text-3);margin-top:1px;">${escapeHtml(time)}</div></div>`
      + `</div>`;
  }

  function patchRecentActivity() {
    const tx = (state.account && state.account.recentTransactions) || [];
    if (!Array.isArray(tx) || !tx.length) return;
    const header = findLeafByText("recent-activity", /^Hoạt động gần đây$/i);
    if (!header) return;
    // A row is a div whose dot is a round (border-radius:50%) 9px div — the template's activity item.
    const looksLikeList = (el) => el && el.tagName === "DIV" && Array.from(el.children).some((row) =>
      Array.from(row.querySelectorAll("div")).some((dd) => {
        const s = dd.getAttribute("style") || "";
        return /border-radius:\s*50%/i.test(s) && /width:\s*9px/i.test(s);
      }));
    // The list container sits right after the header (sibling); fall back to scanning the parent.
    let container = header.nextElementSibling;
    if (!looksLikeList(container)) {
      container = Array.from((header.parentElement || document.body).querySelectorAll("div")).find(looksLikeList) || null;
    }
    if (!looksLikeList(container)) return;
    const html = tx.slice(0, 8).map(activityRowHtml).join("");
    if (container.dataset.centrixActivityKey === html) return; // no-op if unchanged (avoid churn)
    container.dataset.centrixActivityKey = html;
    container.innerHTML = html;
  }

  // ── "Đơn hàng" (Orders) screen — sync with the "Mua credit" flow ─────────────────────────────────
  // The orders table is the SAME kind of static child component as the lists above: it ships fake
  // ORD-2026-xxxx sample rows that the renderVals override never reaches, so it must be DOM-patched.
  // Source of truth is state.portal.orders (the user-scoped top-up orders) — NEVER the admin-wide
  // portal.topupOrders, which would leak other users' orders. Because refresh()/refreshAccountState()
  // (30s + on connect), submitTopup (new order) and the VietQR poll (on credit) all run through
  // patchVisibleCreditTexts → patchOrders, the table stays in lock-step with Mua credit: a fresh
  // top-up appears as "Đang xử lý", then flips to "Hoàn tất" the moment SePay/admin credits it.
  const ORDERS_ROW_GRID_RE = /grid-template-columns:\s*150px\s+1fr\s+110px\s+100px\s+120px\s+130px/i;
  const ORDERS_PAGE_SIZE = 5; // 5 orders/page + a pager, mirroring the "Lịch sử sử dụng" list.

  // state.portal shape differs by code path: refresh() stores the raw summary ({ portal:{orders} }),
  // while the poll/submitTopup store the unwrapped userPortal ({ orders }). Read both; ignore
  // topupOrders (admin-wide, cross-user) on purpose.
  function portalOrdersList() {
    const p = state.portal || {};
    if (Array.isArray(p.orders)) return p.orders;
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : null;
    if (inner && Array.isArray(inner.orders)) return inner.orders;
    return [];
  }
  function portalOrdersLoaded() {
    const p = state.portal;
    if (!p || typeof p !== "object") return false;
    if (Array.isArray(p.orders) || Array.isArray(p.walletTransactions)) return true;
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : null;
    return Boolean(inner && (Array.isArray(inner.orders) || Array.isArray(inner.walletTransactions)));
  }
  // Sổ giao dịch VÍ VND (nạp / mua credit / mua gói / điều chỉnh) — nguồn THẬT cho màn "Đơn hàng".
  function walletTxList() {
    const p = state.portal || {};
    if (Array.isArray(p.walletTransactions)) return p.walletTransactions;
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : null;
    if (inner && Array.isArray(inner.walletTransactions)) return inner.walletTransactions;
    return [];
  }
  // Một biến động ví → 1 dòng "đơn hàng" (đã hoàn tất, phương thức = Ví VNĐ). Nhãn theo loại giao dịch,
  // tra tên gói credit/gói cước để hiển thị đẹp. credits=0 để orderItemLabel dùng `note` làm nhãn.
  function walletTxToOrder(tx) {
    const type = String(tx.type || "").toLowerCase();
    const amt = Math.abs(Number(tx.amountDelta) || 0);
    let label;
    if (type === "topup") label = "Nạp tiền vào ví";
    else if (type === "buy-credit") {
      const pkg = portalPackagesList().find((p) => p.id === tx.ref);
      label = pkg ? `Mua ${formatCreditValue((Number(pkg.credits) || 0) + (Number(pkg.bonusCredits) || 0))} credit` : "Mua credit";
    } else if (type === "buy-plan") {
      const plans = (state.planTier && state.planTier.plans) || [];
      const pl = plans.find((p) => String(p.code).toUpperCase() === String(tx.ref).toUpperCase());
      label = `Mua gói ${pl ? (pl.name || pl.code) : (tx.ref || "cước")}`;
    } else if (type === "adjust") label = (Number(tx.amountDelta) || 0) >= 0 ? "Cộng ví (điều chỉnh)" : "Trừ ví (điều chỉnh)";
    else label = tx.note || type || "Giao dịch ví";
    return {
      id: tx.txId || tx.id, payCode: tx.txId || tx.id,
      amount: amt, credits: 0, note: label,
      status: "approved", creditedAt: tx.createdAt, paymentMethod: "vi", createdAt: tx.createdAt,
    };
  }
  // Danh sách đơn hợp nhất: giao dịch ví (đã hoàn tất) + đơn nạp SePay CÒN CHỜ (chưa settle → chưa có tx ví),
  // sắp xếp mới nhất trước. Tránh trùng: đơn nạp đã settle biểu diễn bằng tx ví type=topup.
  function ordersUnified() {
    const wallet = walletTxList().map(walletTxToOrder);
    const pending = portalOrdersList().filter((o) => !o.creditedAt && !o.settledAt).map((o) => ({ ...o }));
    const all = pending.concat(wallet);
    all.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return all;
  }

  function orderPaymentMethodLabel(method) {
    const key = fold(String(method || "")).replace(/[^a-z0-9]/g, "");
    const map = {
      vietqr: "VietQR", qr: "VietQR", napas: "VietQR",
      vi: "Ví VNĐ", vivnd: "Ví VNĐ", vnd: "Ví VNĐ", wallet: "Ví VNĐ", vidong: "Ví VNĐ",
      bank: "Chuyển khoản", banktransfer: "Chuyển khoản", chuyenkhoan: "Chuyển khoản",
      momo: "Momo", zalopay: "ZaloPay", vnpay: "VNPay", stripe: "Stripe", paypal: "PayPal", card: "Thẻ"
    };
    if (map[key]) return map[key];
    const raw = String(method || "").trim();
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "VietQR";
  }

  // Map a real order's status to the design's three states (done / proc / cancel). An order with a
  // creditedAt (or a credited/approved status) is "Hoàn tất" and can export VAT; pending stays
  // "Đang xử lý"; cancelled/failed/expired is "Đã hủy".
  function orderStatusStyle(order) {
    const st = fold(String(order.status || ""));
    if (order.creditedAt || /\b(approved|paid|completed|credited|success|done|hoan tat)\b/.test(st)) {
      return { label: "Hoàn tất", color: "var(--ok-text)", bg: "var(--ok-soft)", border: "var(--ok-border)", canVat: true };
    }
    if (/\b(cancel|canceled|cancelled|failed|expired|rejected|void|huy)\b/.test(st)) {
      return { label: "Đã hủy", color: "var(--text-3)", bg: "var(--surface-3)", border: "var(--border)", canVat: false };
    }
    return { label: "Đang xử lý", color: "#b45309", bg: "#fff7ed", border: "#fed7aa", canVat: false };
  }

  function orderItemLabel(order) {
    const credits = Number(order.credits || 0);
    if (credits > 0) return `Mua ${formatCreditValue(credits)} credit`;
    const note = String(order.note || "").trim();
    if (note && !/^app user/i.test(note)) return note.slice(0, 60);
    return "Nạp credit";
  }

  // "Mã đơn" = the payCode the user actually references in the bank transfer (matches "Nội dung CK"
  // in the VietQR modal), so the list correlates 1:1 with what they paid; fall back to the order id.
  function orderCodeLabel(order) {
    return String(order.payCode || order.id || "—");
  }

  function orderRowHtml(order) {
    const st = orderStatusStyle(order);
    const code = orderCodeLabel(order);
    const amountTxt = (Number(order.amount) || 0).toLocaleString("vi-VN") + "₫";
    const vatBtn = st.canVat
      ? `<button data-cx-order-vat="${escapeHtml(code)}" style="font-size:11.5px;font-weight:600;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:7px;padding:5px 10px;cursor:pointer;white-space:nowrap;">Hóa đơn VAT</button>`
      : "";
    return `<div data-cx-order="1" style="display:grid;grid-template-columns:150px 1fr 110px 100px 120px 130px;gap:12px;padding:13px 4px;border-bottom:1px solid var(--border-soft);align-items:center;">`
      + `<span style="font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-weight:600;color:var(--brand);overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(code)}">${escapeHtml(code)}</span>`
      + `<span style="font-size:13px;color:var(--text);">${escapeHtml(orderItemLabel(order))}</span>`
      + `<span style="text-align:right;font-size:13px;font-weight:700;color:var(--text);">${escapeHtml(amountTxt)}</span>`
      + `<span style="font-size:12.5px;color:var(--text-2);">${escapeHtml(orderPaymentMethodLabel(order.paymentMethod || order.method))}</span>`
      + `<span><span style="font-size:11px;font-weight:700;color:${st.color};background:${st.bg};border:1px solid ${st.border};border-radius:999px;padding:3px 10px;">${escapeHtml(st.label)}</span></span>`
      + `<div style="display:flex;justify-content:flex-end;">${vatBtn}</div>`
      + `</div>`;
  }

  function ordersEmptyRowHtml() {
    return `<div data-cx-order="1" style="padding:30px 4px;text-align:center;color:var(--text-3);font-size:13.5px;">`
      + `Chưa có đơn hàng nào. Mở “Mua credit” để tạo đơn đầu tiên.`
      + `</div>`;
  }

  // ── "Mua credit" → "Chọn gói credit" — sync the buyable packages with what the App Server publishes ──
  // The design ships sample packages in its "Chọn gói credit" grid; the App Server now manages real ones
  // (portal.creditPackages, enabled-only exposed as portal.packages). DOM-patch the grid with the real
  // packages (same approach as patchOrders) so an admin create/edit shows up here on the next refresh.
  function portalPackagesList() {
    const p = state.portal || {};
    if (Array.isArray(p.packages)) return p.packages;
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : null;
    if (inner && Array.isArray(inner.packages)) return inner.packages;
    if (Array.isArray(p.creditPackages)) return p.creditPackages.filter((x) => x && x.enabled !== false);
    return [];
  }
  function packageCardHtml(p) {
    const total = (Number(p.credits) || 0) + (Number(p.bonusCredits) || 0);
    const bonus = Number(p.bonusCredits) || 0;
    const price = (Number(p.price) || 0).toLocaleString("vi-VN") + (String(p.currency || "VND") === "USD" ? " USD" : "₫");
    // ONLY the explicitly-clicked card looks "selected" (brand border + soft bg). A "highlight"/popular
    // package is set apart by its bonus badge ALONE — NOT a brand-ish border: on the dark theme that
    // light-blue border read as "auto-selected" even though nothing was chosen (the reported bug).
    const selected = state.selectedBuyPkgId === p.id;
    const border = selected ? "var(--brand)" : "var(--border)";
    return `<div data-cx-pkg="1" data-cx-buy-pkg="${escapeHtml(p.id)}" style="border:2px solid ${border};background:${selected ? "var(--brand-soft)" : "var(--surface)"};border-radius:13px;padding:16px 18px;cursor:pointer;position:relative;">`
      + (bonus > 0 ? `<span style="position:absolute;top:11px;right:11px;font-size:10px;font-weight:700;color:var(--ok-text,#16a34a);background:var(--ok-soft,#dcfce7);border-radius:999px;padding:2px 8px;">+${formatCreditValue(bonus)}</span>` : "")
      + `<div style="font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:48px;">${escapeHtml(p.name || "Gói credit")}</div>`
      + `<div style="font-size:22px;font-weight:900;color:var(--text);margin-top:6px;letter-spacing:-.01em;">${formatCreditValue(total)} <span style="font-size:12px;font-weight:700;color:var(--text-3);">credit</span></div>`
      + `<div style="font-size:13.5px;color:var(--brand);font-weight:700;margin-top:4px;">${price}</div>`
      + `</div>`;
  }
  let planLoading = false;
  async function ensurePlanLoaded(force) {
    if ((state.planTier && !force) || planLoading) return;
    planLoading = true;
    try {
      const r = await api()?.portal?.planMe?.({});
      if (r && r.ok !== false) state.planTier = r;
    } catch { /* best-effort */ } finally {
      planLoading = false;
    }
  }
  // Wire the static "Gói cước" tab to REAL plan data (Phase 1: display current plan + self-downgrade; paid
  // upgrade = Phase 2). The design is minified/unknown so this is a DEFENSIVE in-place patch: find the per-card
  // action buttons, order them left→right (= priority order), map to the real plans (sorted by priority), then
  // set each button's label + action and mark the user's CURRENT plan. Wrapped so it can never break the UI.
  function patchPlanCards() {
    try {
      ensurePlanLoaded();
      const tier = state.planTier;
      if (!tier || !Array.isArray(tier.plans) || !tier.plans.length) return;
      const plans = tier.plans.slice().sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
      const current = String(tier.current || "FREE").toUpperCase();
      const curPrio = Number((plans.find((p) => String(p.code).toUpperCase() === current) || {}).priority) || 1;
      const labelRe = /^(Hạ cấp|Nâng cấp|Gói đang dùng|Gói hiện tại|Chọn gói|Dùng gói này)$/i;
      let btns = Array.from(document.querySelectorAll("[data-cx-plan-btn]"));
      if (!btns.length) {
        btns = Array.from(document.querySelectorAll("button,div,span,a")).filter((el) =>
          el.children.length === 0 && labelRe.test((el.textContent || "").trim()) && el.offsetParent !== null);
      }
      if (btns.length < 2 || btns.length < plans.length) return; // tab not visible / structure unexpected
      btns.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      btns = btns.slice(0, plans.length);
      const sig = current + "|" + plans.map((p) => p.code + ":" + p.price + ":" + p.free_grant).join("|");
      btns.forEach((btn, i) => {
        const plan = plans[i];
        if (!plan) return;
        const code = String(plan.code).toUpperCase();
        const isCur = code === current;
        const lower = (Number(plan.priority) || 0) < curPrio;
        if (btn.dataset.cxPlanSig === sig + "|" + i) return; // unchanged → skip
        btn.setAttribute("data-cx-plan-btn", "1");
        btn.dataset.cxPlanSig = sig + "|" + i;
        btn.textContent = isCur ? "Gói đang dùng" : (lower ? "Hạ cấp" : "Nâng cấp");
        btn.style.cursor = isCur ? "default" : "pointer";
        btn.style.opacity = isCur ? "0.65" : "1";
        const fresh = btn.cloneNode(true); // drop the design's old click handlers
        if (btn.parentNode) btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          if (isCur) return;
          if (lower) {
            showConfirm("Chuyển về gói " + (plan.name || plan.code) + "? Hạ cấp — không mất credit đã có.", () => {
              const bridge = api();
              if (!bridge?.portal?.planSelfDowngrade) return;
              bridge.portal.planSelfDowngrade({ planCode: plan.code })
                .then((r) => {
                  if (r && r.ok !== false) { showActionToast("Đã chuyển sang gói " + (plan.name || plan.code), "ok"); ensurePlanLoaded(true).then(() => patchPlanCards()); }
                  else showActionToast(r?.error || "Hạ cấp thất bại", "error");
                })
                .catch((err) => showActionToast(err?.message || "Lỗi hạ cấp", "error"));
            }, { title: "Đổi gói cước", ok: "Chuyển gói", danger: true });
          } else {
            showActionToast("Nâng cấp gói trả phí qua thanh toán — sắp có (Phase 2)", "ok");
          }
        });
      });
    } catch (e) { /* never break the UI */ }
  }
  function patchBuyPackages() {
    const label = Array.from(document.querySelectorAll("div"))
      .find((el) => el.children.length === 0 && /^Chọn gói credit$/i.test((el.textContent || "").trim()) && el.offsetParent !== null);
    if (!label) return; // "Mua credit" buy panel not visible
    patchBuyScreenUi(); // chuyển UI thanh toán sang ví VNĐ mỗi khi màn mua hiện (kể cả chưa có gói thật)
    let grid = label.nextElementSibling;
    if (!grid || !/grid/.test(grid.style.display || "")) {
      grid = Array.from(label.parentElement ? label.parentElement.children : []).find((c) => c !== label && /grid/.test((c.style && c.style.display) || ""));
    }
    if (!grid) return;
    const pkgs = portalPackagesList();
    if (!pkgs.length) {
      // Không có gói thật → KHÔNG để lưới demo của design (nó tự bôi sẵn gói 500 + click chết vì thiếu
      // data-cx-buy-pkg → bug "tự chọn 139.000" + "Vui lòng chọn gói"). Thay bằng trạng thái rỗng rõ ràng.
      state.selectedBuyPkgId = "";
      const emptyState = `<div style="grid-column:1/-1;padding:26px;border:1px dashed var(--border,#e6e9ee);border-radius:13px;background:var(--surface-2,#f7f9fc);text-align:center;">
        <div style="font:800 14px Segoe UI;color:var(--text,#0f172a);">Chưa có gói credit khả dụng</div>
        <div style="font:600 12.5px Segoe UI;color:var(--text-2,#5b6677);margin-top:6px;">Quản trị viên chưa cấu hình gói credit. Vui lòng liên hệ hỗ trợ.</div>
      </div>`;
      if (grid.dataset.cxPkgSig !== "empty") { grid.dataset.cxPkgSig = "empty"; grid.innerHTML = emptyState; patchBuySummary(); }
      return;
    }
    // NO default selection — the user must explicitly click a card (no pre-checked package). Only drop a
    // stale selection whose package no longer exists.
    if (state.selectedBuyPkgId && !pkgs.some((p) => p.id === state.selectedBuyPkgId)) state.selectedBuyPkgId = "";
    const promoSig = state.activeBuyPromo ? (state.activeBuyPromo.code + ":" + (state.activeBuyPromo.discountPercent || state.activeBuyPromo.value || 0) + ":" + (state.activeBuyPromo.bonusCredit || 0)) : "";
    const sig = (state.selectedBuyPkgId || "") + "|" + promoSig + "|" + pkgs.map((p) => p.id + ":" + p.name + ":" + p.credits + ":" + p.bonusCredits + ":" + p.price + ":" + (p.highlight ? 1 : 0)).join("|");
    if (grid.dataset.cxPkgSig === sig) return; // unchanged → don't churn
    grid.dataset.cxPkgSig = sig;
    grid.innerHTML = pkgs.map(packageCardHtml).join("");
    patchBuySummary();
  }
  // Update the order-summary "Gói credit" + "Tổng cộng" to match the selected package (the design summary
  // is driven by the design's own selection, which our patched cards bypass — keep it consistent).
  function setSummaryValue(label, value) {
    const want = fold(label);
    for (const el of document.querySelectorAll("div,span")) {
      if (el.children.length) continue;
      if (fold((el.textContent || "").trim()) !== want) continue;
      const row = el.parentElement;
      const sib = row && Array.from(row.children).find((c) => c !== el && !c.children.length && (c.textContent || "").trim());
      if (sib) { sib.textContent = value; return true; }
    }
    return false;
  }
  // Normalize a promo to its monetary effect. The App Server promo schema is { discountPercent, bonusCredit }
  // (managed in the admin "Khuyến mãi" panel); older code expected { type, value }. Reading only type/value
  // meant WELCOME50/PRO20 (discountPercent) applied NO discount and FRIEND (+bonusCredit) misfired. Support
  // the real schema first, fall back to type/value only when neither server field is present.
  function promoEffect(promo, baseTotal) {
    const base = Number(baseTotal) || 0;
    let discount = 0, bonus = 0;
    if (promo) {
      const pct = Number(promo.discountPercent) || 0;
      const amt = Number(promo.discountAmount) || 0;
      bonus = Number(promo.bonusCredit) || 0;
      if (pct > 0) discount = Math.round(base * pct / 100);
      if (amt > 0) discount += amt;
      if (!pct && !amt && !bonus) { // legacy { type, value }
        if (promo.type === "percent") discount = Math.round(base * (Number(promo.value) || 0) / 100);
        else if (promo.type === "fixed") discount = Number(promo.value) || 0;
        else if (promo.type === "bonus") bonus = Number(promo.value) || 0;
      }
    }
    discount = Math.max(0, Math.min(base, discount));
    return { discount, bonus };
  }
  function promoLabelText(promo, discount, bonus) {
    const parts = [];
    if (discount > 0) parts.push("−" + discount.toLocaleString("vi-VN") + "đ");
    if (bonus > 0) parts.push("+" + bonus.toLocaleString("vi-VN") + " credit");
    return parts.length ? parts.join(" ") + " · " + (promo && promo.code || "") : "—";
  }
  function patchBuySummary() {
    const pkg = portalPackagesList().find((p) => p.id === state.selectedBuyPkgId);
    if (!pkg) {
      setSummaryValue("Gói credit", "Chưa chọn");
      setSummaryValue("Khuyến mãi", "—");
      setSummaryValue("Tổng cộng", "—");
      return;
    }
    let credits = (Number(pkg.credits) || 0) + (Number(pkg.bonusCredits) || 0);
    let total = Number(pkg.price) || 0;
    let promoLabel = "—";
    const promo = state.activeBuyPromo;
    if (promo) {
      const eff = promoEffect(promo, total);
      total -= eff.discount;
      credits += eff.bonus;
      promoLabel = promoLabelText(promo, eff.discount, eff.bonus);
    }
    total = Math.max(0, total);
    setSummaryValue("Gói credit", formatCreditValue(credits) + " credit");
    setSummaryValue("Khuyến mãi", promoLabel);
    setSummaryValue("Tổng cộng", total.toLocaleString("vi-VN") + "đ");
  }
  // Luồng mua credit giờ TRỪ VÍ VNĐ (không còn SePay/QR). Chuyển toàn bộ UI thanh toán của template sang ví:
  //  - Nhãn phương thức "VietQR"/"SePay" → "Ví VNĐ"; phụ đề "Chuyển khoản ngân hàng VN" → "Trừ từ số dư ví VNĐ"
  //  - Ô QR sọc + caption "Quét mã ... để thanh toán" → panel số dư ví VNĐ (ẩn ô sọc, chèn số dư)
  //  - Nút "Thanh toán {{total}}" → "Mua bằng ví"
  // Chạy lại mỗi lần render (idempotent qua marker) vì design re-render hay xoá patch.
  function patchBuyScreenUi() {
    const bal = Number(liveCreditSnapshot().moneyBalance) || 0;
    const balFmt = bal.toLocaleString("vi-VN") + " đ";
    let caption = null;
    for (const el of document.querySelectorAll("div,span")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (t === "VietQR" || t === "SePay") el.textContent = "Ví VNĐ";
      else if (t === "Chuyển khoản ngân hàng VN") el.textContent = "Trừ từ số dư ví VNĐ khi mua";
      else if (/^Quét mã (VietQR|SePay)/.test(t) || t === "Thanh toán trực tiếp từ số dư ví VNĐ") { caption = el; el.textContent = "Thanh toán trực tiếp từ số dư ví VNĐ"; }
      else if (/^Thanh toán(\s|$)/.test(t) && t.length < 26 && !/PHƯƠNG THỨC/i.test(t)) el.textContent = "Mua bằng ví";
    }
    // Ẩn ô QR sọc (anh em ngay trước caption, nền repeating-linear-gradient) + chèn thẻ số dư ví 1 lần.
    if (caption && caption.parentElement) {
      const card = caption.parentElement;
      const striped = caption.previousElementSibling;
      if (striped && /repeating-linear-gradient/i.test(striped.getAttribute("style") || "")) striped.style.display = "none";
      let badge = card.querySelector("[data-cx-wallet-badge]");
      if (!badge) {
        badge = document.createElement("div");
        badge.setAttribute("data-cx-wallet-badge", "1");
        badge.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;padding:14px 16px;border-radius:12px;background:var(--brand-soft,#eaf5fe);border:1px solid var(--brand-border,#bfe0fc);margin-bottom:10px;box-sizing:border-box;";
        card.insertBefore(badge, striped || caption);
      }
      badge.innerHTML = `<span style="font:800 12.5px Segoe UI;color:var(--text-2,#5b6677);">Số dư ví VNĐ</span><span style="font:900 18px Segoe UI;color:var(--brand,#1e93f5);">${balFmt}</span>`;
    }
  }
  function portalPromotions() {
    const p = state.portal || {};
    if (Array.isArray(p.promotions)) return p.promotions;
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : null;
    return (inner && Array.isArray(inner.promotions)) ? inner.promotions : [];
  }
  // Find an ENABLED, non-expired promo by code in portal.promotions (managed on the App Server).
  function findPromoByCode(code) {
    const c = String(code || "").trim().toUpperCase();
    if (!c) return null;
    return portalPromotions().find((p) => String(p.code || "").toUpperCase() === c
      && p.enabled !== false
      && !(p.expiry && Number.isFinite(Date.parse(p.expiry)) && Date.parse(p.expiry) < Date.now())) || null;
  }
  // Repaint the buy panel + force an IMMEDIATE static re-render so the data-bound Tóm tắt đơn / Tổng cộng
  // reflect the new selection/promo within a frame. They're data-bound to applyLiveAccountVals; without
  // the forced render they only refreshed on the ~30s account poll — the lag the user saw on "Áp dụng".
  function repaintBuy() {
    patchBuyPackages();
    patchBuySummary();
    try { (patchedStaticLogic || staticLogic())?.setState?.({ creditRevision: Date.now() }); } catch { /* best-effort instant repaint */ }
  }
  function applyPromoFromInput() {
    const input = firstVisibleInput((i) => fold(i.placeholder).includes("nhap ma"));
    const code = String(input?.value || "").trim();
    if (!code) { state.activeBuyPromo = null; repaintBuy(); showActionToast("Nhập mã giảm giá trước", "error"); return; }
    const promo = findPromoByCode(code);
    if (!promo) { state.activeBuyPromo = null; repaintBuy(); showActionToast("Mã không hợp lệ hoặc đã hết hạn", "error"); return; }
    state.activeBuyPromo = promo;
    repaintBuy();
    showActionToast(`Đã áp dụng mã "${promo.code}"`);
  }
  // Card click SELECTS the package (highlight + summary). Payment is ONLY via "Mua bằng ví" (submitTopup → trừ ví VNĐ).
  function selectBuyPackage(id) {
    if (!id) return;
    state.selectedBuyPkgId = id;
    repaintBuy();
  }

  let ordersScreenSeen = false;
  // Reuse the "Lịch sử" pager visuals; tag the wrapper with data-cx-order so patchOrders' row cleanup
  // removes the old pager along with the old rows on each re-render.
  function ordersPagerHtml(page, pages) {
    return usagePagerHtml(page, pages).replace('data-cx-pager="1"', 'data-cx-pager="1" data-cx-order="1"');
  }
  // Delegated pager click on the persistent orders card — survives row re-renders; guarded against double-wiring.
  function wireOrdersPager(card) {
    if (!card || card.dataset.cxOrdersPagerWired === "1") return;
    card.dataset.cxOrdersPagerWired = "1";
    card.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-cx-page]") : null;
      if (!btn || !card.contains(btn)) return;
      const p = parseInt(btn.getAttribute("data-cx-page"), 10);
      if (isNaN(p)) return;
      e.preventDefault();
      e.stopPropagation();
      state.ordersPage = p;
      patchOrders();
    });
  }

  function patchOrders() {
    const header = findLeafByText("orders", /^Đơn hàng của tôi$/i);
    if (!isLaidOut(header)) { ordersScreenSeen = false; return; } // Orders screen not mounted/visible
    // First time this screen appears → pull the freshest orders so a top-up credited elsewhere (or by
    // SePay while the screen was closed) shows up immediately, not after the next 30s refresh tick.
    if (!ordersScreenSeen) {
      ordersScreenSeen = true;
      scheduleAccountStateRefresh(0);
    }
    if (!portalOrdersLoaded()) return; // portal not fetched yet — leave the design's rows until data lands

    // Walk up from the title to the orders card, identified by its uppercase column-header grid.
    let card = header.parentElement;
    let colHeader = null;
    for (let i = 0; i < 5 && card; i += 1) {
      colHeader = Array.from(card.children).find((c) =>
        c.tagName === "DIV"
        && ORDERS_ROW_GRID_RE.test(c.getAttribute("style") || "")
        && /text-transform:\s*uppercase/i.test(c.getAttribute("style") || ""));
      if (colHeader) break;
      card = card.parentElement;
    }
    if (!card || !colHeader) return;

    const orders = ordersUnified().slice(0, 60);
    const completed = orders.filter((o) => orderStatusStyle(o).canVat).length;
    // 5 rows/page + a numbered pager (mirrors "Lịch sử sử dụng"); clamp state.ordersPage to the valid range.
    const pages = Math.max(1, Math.ceil(orders.length / ORDERS_PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(state.ordersPage) || 0), pages - 1);
    state.ordersPage = page;
    const start = page * ORDERS_PAGE_SIZE;
    const rowsHtml = (orders.length ? orders.slice(start, start + ORDERS_PAGE_SIZE).map(orderRowHtml).join("") : ordersEmptyRowHtml())
      + (pages > 1 ? ordersPagerHtml(page, pages) : "");

    // Re-render only when our rows are missing (a design re-render repainted the samples) or the data
    // changed (new/credited order) — idempotent so it never churns the MutationObserver.
    const firstData = colHeader.nextElementSibling;
    const mine = firstData && firstData.getAttribute("data-cx-order") === "1";
    if (!(mine && card.dataset.centrixOrdersKey === rowsHtml)) {
      // Remove every existing data row after the column header (sample rows OR our previous rows),
      // stopping at the first non-row sibling so any trailing card content is preserved.
      let node = colHeader.nextElementSibling;
      while (node) {
        const style = node.getAttribute("style") || "";
        const isRow = node.tagName === "DIV"
          && (node.getAttribute("data-cx-order") === "1"
            || (ORDERS_ROW_GRID_RE.test(style) && !/text-transform:\s*uppercase/i.test(style)));
        const next = node.nextElementSibling;
        if (!isRow) break;
        node.remove();
        node = next;
      }
      colHeader.insertAdjacentHTML("afterend", rowsHtml);
      card.dataset.centrixOrdersKey = rowsHtml;
      card.querySelectorAll("[data-cx-order-vat]").forEach((b) => {
        if (b.__cxVatBound) return;
        b.__cxVatBound = true;
        b.addEventListener("click", () => showActionToast("Xuất hóa đơn VAT sẽ sớm khả dụng — liên hệ hỗ trợ nếu cần gấp."));
      });
    }
    wireOrdersPager(card);

    // Keep the "{n} đơn đã hoàn tất · …" subtitle in sync with the real completed count.
    const sub = Array.from(card.querySelectorAll("div"))
      .find((el) => el.children.length === 0 && /\d+\s*đơn đã hoàn tất/i.test(el.textContent || ""));
    if (sub) {
      const txt = `${completed} đơn đã hoàn tất · có thể xuất hóa đơn VAT`;
      if ((sub.textContent || "") !== txt) sub.textContent = txt;
    }
  }

  // ── "Bảng giá" (model price) screen — per-service model credit costs ──────────────────────────────
  // Data source: each service row in liveServices() already carries a modelPrices[] table (fields:
  // modelId, displayName, creditCost, enabled, isDefault) plus service-level defaultModel/defaultCreditCost
  // fallbacks, attached by the backend servicesForUser() — NO new endpoint. Show ONLY services the user's
  // plan allows (planBlocksService), each with its enabled models, default first then cheapest. Same
  // DOM-patch + idempotency-signature approach as patchOrders: anchor on the screen's title leaf, build the
  // body once, re-render only the list on data/filter changes (so the search input keeps focus).
  let pricingScreenSeen = false;
  let pricingQuery = "";

  // Prettify a raw model id ("gpt-5-5-thinking_max") into a human label ("GPT 5.5 Thinking Max"): join
  // version digits (5-5 → 5.5), split on - / _ / space, title-case each word, keep known brand casings.
  // Idempotent on already-nice names (an admin-set displayName with spaces survives unchanged).
  const MODEL_WORD_CASE = { gpt: "GPT", ai: "AI", api: "API", xai: "xAI", llm: "LLM", deepseek: "DeepSeek", chatgpt: "ChatGPT", openai: "OpenAI", o1: "o1", o3: "o3", o4: "o4" };
  function prettyModelName(raw) {
    const s0 = String(raw || "").trim();
    if (!s0) return "";
    const joined = s0.replace(/(\d)-(\d)/g, "$1.$2"); // version segments: 5-5 → 5.5, 4-6 → 4.6
    const words = joined.split(/[-_\s]+/).filter(Boolean);
    if (!words.length) return s0;
    return words.map((w) => {
      const lw = w.toLowerCase();
      if (MODEL_WORD_CASE[lw]) return MODEL_WORD_CASE[lw];
      if (/^[\d.]+$/.test(w)) return w;                    // keep version numbers as-is
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  function serviceDefaultPrice(service) {
    const prices = Array.isArray(service?.modelPrices) ? service.modelPrices : [];
    const enabled = prices.filter((p) => p && p.enabled !== false && p.modelId);
    const wantId = String(service?.defaultModel || "").trim();
    // Match the SERVER's default resolution (serviceModelDefaults): isDefault → service.defaultModel → first.
    const def = enabled.find((p) => p.isDefault === true)
      || (wantId && enabled.find((p) => String(p.modelId) === wantId))
      || enabled[0] || null;
    if (def) return { model: prettyModelName(def.displayName || def.modelId), cost: Math.max(1, Math.round(Number(def.creditCost) || 1)) };
    return { model: prettyModelName(service?.defaultModel) || "Mặc định", cost: serviceCreditCost(service) };
  }

  function pricingGroups() {
    const q = fold(pricingQuery || "").trim();
    const groups = liveServices()
      .filter((svc) => !planBlocksService(svc.id))
      .map((svc) => {
        const prices = Array.isArray(svc.modelPrices) ? svc.modelPrices : [];
        let models = prices
          .filter((p) => p && p.enabled !== false && p.modelId)
          .map((p) => ({
            name: prettyModelName(p.displayName || p.modelId),
            cost: Math.max(1, Math.round(Number(p.creditCost) || 1)),
            isDefault: p.isDefault === true
          }));
        if (!models.length) {
          const dp = serviceDefaultPrice(svc);
          models = [{ name: dp.model, cost: dp.cost, isDefault: true }];
        }
        // Default model first, then cheapest, then name — a stable, predictable order.
        models.sort((a, b) => (Number(b.isDefault) - Number(a.isDefault)) || (a.cost - b.cost) || a.name.localeCompare(b.name));
        return { id: svc.id, name: String(svc.name || svc.id), initial: serviceInitial(svc.name || svc.id), models };
      });
    if (!q) return groups;
    return groups
      .map((g) => (fold(g.name).includes(q) ? g : { ...g, models: g.models.filter((m) => fold(m.name).includes(q)) }))
      .filter((g) => g.models.length > 0);
  }

  function pricingGroupHtml(g) {
    const rows = g.models.map((m) =>
      `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border-soft);border-radius:11px;background:var(--surface-2);">`
      + `<span style="flex:1;min-width:0;font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">`
      + (m.isDefault ? `<span title="Model mặc định" style="color:var(--brand);margin-right:6px;">★</span>` : ``)
      + `${escapeHtml(m.name)}</span>`
      + `<span style="font-size:14px;font-weight:700;color:var(--brand);letter-spacing:-.01em;white-space:nowrap;">`
      + `${escapeHtml(formatCreditValue(m.cost))} <span style="font-size:11px;font-weight:600;color:var(--text-3);">cr/lượt</span></span>`
      + `</div>`
    ).join("");
    return `<div style="margin-bottom:18px;">`
      + `<div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;">`
      + `<div style="width:26px;height:26px;border-radius:8px;background:var(--brand);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;flex-shrink:0;">${escapeHtml(g.initial)}</div>`
      + `<span style="font-size:14px;font-weight:700;color:var(--text);">${escapeHtml(g.name)}</span>`
      + `<span style="font-size:11px;font-weight:600;color:var(--text-3);background:var(--surface-3);border-radius:999px;padding:2px 9px;">${g.models.length} model</span>`
      + `</div>`
      + `<div style="display:flex;flex-direction:column;gap:7px;">${rows}</div>`
      + `</div>`;
  }

  function renderPricingList(card) {
    const list = card.querySelector("#cx-pricing-list");
    if (!list) return;
    const balEl = card.querySelector("#cx-pricing-balance");
    if (balEl) {
      const bt = `Số dư: ${formatCreditValue(liveCreditSnapshot().balance)} cr`;
      if (balEl.textContent !== bt) balEl.textContent = bt;
    }
    const groups = pricingGroups();
    const html = groups.length
      ? groups.map(pricingGroupHtml).join("")
      : `<div style="padding:26px;text-align:center;color:var(--text-3);font-size:13px;">Không tìm thấy dịch vụ / model phù hợp.</div>`;
    if (list.dataset.cxKey === html) return; // idempotent — don't churn the DOM when nothing changed
    list.dataset.cxKey = html;
    list.innerHTML = html;
  }

  function ensurePricingBody(card) {
    if (card.querySelector("#cx-pricing-list")) return; // body already built for this render
    const wrap = document.createElement("div");
    wrap.innerHTML =
      `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:16px 0 14px;">`
      + `<div style="position:relative;flex:1;min-width:180px;max-width:320px;">`
      + `<span style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text-3);font-size:13px;pointer-events:none;">⚲</span>`
      + `<input id="cx-pricing-search" placeholder="Tìm model / dịch vụ" style="width:100%;font-size:13px;color:var(--text);background:var(--field-bg);border:1px solid var(--field-border);border-radius:9px;padding:8px 12px 8px 32px;box-sizing:border-box;outline:none;">`
      + `</div>`
      + `<span id="cx-pricing-balance" style="font-size:11.5px;font-weight:700;color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);border-radius:999px;padding:5px 13px;white-space:nowrap;">Số dư: … cr</span>`
      + `</div>`
      + `<div id="cx-pricing-list"></div>`;
    while (wrap.firstChild) card.appendChild(wrap.firstChild);
    const input = card.querySelector("#cx-pricing-search");
    if (input) {
      input.value = pricingQuery;
      input.addEventListener("input", () => { pricingQuery = input.value || ""; renderPricingList(card); });
      input.addEventListener("focus", () => { input.style.borderColor = "var(--brand)"; });
      input.addEventListener("blur", () => { input.style.borderColor = "var(--field-border)"; });
    }
  }

  function patchPricingTable() {
    const title = findLeafByText("pricing", /^Bảng giá model$/i);
    if (!isLaidOut(title)) { pricingScreenSeen = false; return; } // screen not mounted/visible
    if (!pricingScreenSeen) { pricingScreenSeen = true; scheduleAccountStateRefresh(0); } // first sight → pull fresh
    const card = title.parentElement;
    if (!card) return;
    ensurePricingBody(card);
    renderPricingList(card);
  }

  // ── "Hóa đơn" (Invoices) screen — mapped to the "Mua credit" flow ─────────────────────────────────
  // No backend ever populates portal.invoices, so a PAID top-up IS the invoice record: every COMPLETED
  // (credited) buy-credit order becomes a "Hóa đơn của tôi" row + feeds the summary cards (Tổng chi
  // tiêu / Số hóa đơn / Đã xuất VAT). VAT (GTGT) issuance itself isn't built yet, so every real invoice
  // shows "Chưa xuất" with a "Xuất VAT" action (informational toast). Same DOM-patch + sync approach as
  // patchOrders; reuses orderStatusStyle/orderItemLabel/orderPaymentMethodLabel/orderCodeLabel.
  const INVOICE_ROW_GRID_RE = /grid-template-columns:\s*148px\s+1fr\s+96px\s+104px\s+118px\s+116px/i;

  function invoiceDateLabel(order) {
    const d = new Date(order.creditedAt || order.updatedAt || order.createdAt || "");
    if (isNaN(d.getTime())) return "";
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  // Completed buy-credit orders → invoice view-models (sorted newest-first like the orders feed).
  function invoicesFromOrders() {
    return portalOrdersList()
      .filter((o) => orderStatusStyle(o).canVat) // canVat === completed/credited
      .map((o) => ({
        id: orderCodeLabel(o),
        desc: orderItemLabel(o),
        date: invoiceDateLabel(o),
        amount: Number(o.amount) || 0,
        method: orderPaymentMethodLabel(o.paymentMethod || o.method),
        vat: false // VAT GTGT export not implemented yet → "Chưa xuất"
      }));
  }

  // Live value of the invoice search box ("Tìm mã HĐ hoặc nội dung…"), folded for accent-insensitive match.
  function invoiceSearchQuery() {
    const input = Array.from(document.querySelectorAll("input"))
      .find((i) => fold(i.placeholder || "").includes("tim ma hd"));
    return input ? fold(String(input.value || "").trim()) : "";
  }

  function invoiceRowHtml(iv) {
    const amountTxt = iv.amount.toLocaleString("vi-VN") + "₫";
    const vc = iv.vat
      ? { label: "Đã xuất VAT", color: "var(--ok-text)", bg: "var(--ok-soft)", border: "var(--ok-border)" }
      : { label: "Chưa xuất", color: "#b45309", bg: "#fff7ed", border: "#fed7aa" };
    const action = iv.vat
      ? "" // a real Download/Resend needs an issued PDF — omit until VAT export exists
      : `<button data-cx-invoice-vat="${escapeHtml(iv.id)}" style="font-size:11.5px;font-weight:600;color:#fff;background:var(--brand);border:none;border-radius:8px;padding:6px 11px;cursor:pointer;white-space:nowrap;">Xuất VAT</button>`;
    return `<div data-cx-invoice="1" style="display:grid;grid-template-columns:148px 1fr 96px 104px 118px 116px;gap:10px;padding:13px 20px;border-bottom:1px solid var(--border-soft);align-items:center;">`
      + `<span style="font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(iv.id)}">${escapeHtml(iv.id)}</span>`
      + `<span style="font-size:13px;color:var(--text);">${escapeHtml(iv.desc)}</span>`
      + `<span style="font-size:12px;color:var(--text-2);">${escapeHtml(iv.date)}</span>`
      + `<span style="text-align:right;font-size:13px;font-weight:700;color:var(--text);">${escapeHtml(amountTxt)}</span>`
      + `<span><span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:${vc.color};background:${vc.bg};border:1px solid ${vc.border};border-radius:999px;padding:3px 9px;white-space:nowrap;"><span style="width:5px;height:5px;border-radius:50%;background:currentColor;"></span>${escapeHtml(vc.label)}</span></span>`
      + `<div style="display:flex;gap:5px;justify-content:flex-end;align-items:center;">${action}</div>`
      + `</div>`;
  }

  function invoiceEmptyRowHtml(filtered) {
    const msg = filtered ? "Không tìm thấy hóa đơn nào khớp." : "Chưa có hóa đơn nào. Mở “Mua credit” để tạo hóa đơn đầu tiên.";
    return `<div data-cx-invoice="1" style="padding:36px;text-align:center;color:var(--text-3);font-size:13.5px;">${msg}</div>`;
  }

  // Keep the 3 summary cards (Tổng chi tiêu / Số hóa đơn / Đã xuất VAT) consistent with the real list.
  function patchInvoiceSummary(all) {
    const total = all.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const count = all.length;
    const vatCount = all.filter((x) => x.vat).length;
    const totalFmt = total.toLocaleString("vi-VN") + "₫";
    const setText = (el, v) => { if (el && (el.textContent || "") !== v) el.textContent = v; };
    const cardFor = (labelRe) => {
      const label = Array.from(document.querySelectorAll("div"))
        .find((el) => el.children.length === 0 && labelRe.test((el.textContent || "").trim()));
      return label ? label.parentElement : null;
    };
    const numDiv = (card) => card && Array.from(card.children)
      .find((c) => c.tagName === "DIV" && /font-size:\s*20px/i.test(c.getAttribute("style") || ""));

    const totalCard = cardFor(/^Tổng chi tiêu$/i);
    if (totalCard) {
      setText(numDiv(totalCard), totalFmt);
      const subEl = Array.from(totalCard.children).find((c) => c.tagName === "DIV" && /hóa đơn đã thanh toán/i.test(c.textContent || ""));
      setText(subEl, `${count} hóa đơn đã thanh toán`);
    }
    const countCard = cardFor(/^Số hóa đơn$/i);
    if (countCard) setText(numDiv(countCard), String(count));
    const vatCard = cardFor(/^Đã xuất VAT$/i);
    const nd = numDiv(vatCard);
    if (nd) {
      const html = `${vatCount}<span style="font-size:14px;color:var(--text-3);font-weight:600;"> / ${count}</span>`;
      if (nd.innerHTML !== html) nd.innerHTML = html;
    }
  }

  let invoicesScreenSeen = false;
  function patchInvoices() {
    const header = findLeafByText("invoices", /^Hóa đơn của tôi$/i);
    if (!isLaidOut(header)) { invoicesScreenSeen = false; return; }
    if (!invoicesScreenSeen) { invoicesScreenSeen = true; scheduleAccountStateRefresh(0); }
    if (!portalOrdersLoaded()) return;

    // Walk up from the title to the table card, identified by its uppercase invoice column-header grid.
    let card = header.parentElement;
    let colHeader = null;
    for (let i = 0; i < 5 && card; i += 1) {
      colHeader = Array.from(card.children).find((c) =>
        c.tagName === "DIV"
        && INVOICE_ROW_GRID_RE.test(c.getAttribute("style") || "")
        && /text-transform:\s*uppercase/i.test(c.getAttribute("style") || ""));
      if (colHeader) break;
      card = card.parentElement;
    }
    if (!card || !colHeader) return;

    const all = invoicesFromOrders();
    const q = invoiceSearchQuery();
    const shown = q ? all.filter((iv) => fold(iv.id).includes(q) || fold(iv.desc).includes(q)) : all;
    const rowsHtml = shown.length ? shown.slice(0, 120).map(invoiceRowHtml).join("") : invoiceEmptyRowHtml(Boolean(q && all.length));

    const firstData = colHeader.nextElementSibling;
    const mine = firstData && firstData.getAttribute("data-cx-invoice") === "1";
    if (!(mine && card.dataset.centrixInvoicesKey === rowsHtml)) {
      // Remove sample rows, our previous rows, AND the design's "không tìm thấy…" empty div, then insert.
      let node = colHeader.nextElementSibling;
      while (node) {
        const style = node.getAttribute("style") || "";
        const isMine = node.getAttribute("data-cx-invoice") === "1";
        const isGridRow = node.tagName === "DIV" && INVOICE_ROW_GRID_RE.test(style) && !/text-transform:\s*uppercase/i.test(style);
        const isDesignEmpty = node.tagName === "DIV" && node.children.length === 0 && /không tìm thấy hóa đơn/i.test(node.textContent || "");
        const next = node.nextElementSibling;
        if (!(isMine || isGridRow || isDesignEmpty)) break;
        node.remove();
        node = next;
      }
      colHeader.insertAdjacentHTML("afterend", rowsHtml);
      card.dataset.centrixInvoicesKey = rowsHtml;
      card.querySelectorAll("[data-cx-invoice-vat]").forEach((b) => {
        if (b.__cxVatBound) return;
        b.__cxVatBound = true;
        b.addEventListener("click", () => showActionToast("Xuất hóa đơn VAT (GTGT) sẽ sớm khả dụng — liên hệ hỗ trợ nếu cần gấp."));
      });
    }

    patchInvoiceSummary(all);
  }

  // Saved per-user invoice/VAT profile (from the portal summary). The form itself is hydrated via renderVals
  // in applyLiveAccountVals (vatCur + onVat* + onSaveVat) — blank until saved, persisted per userId.
  function userBillingProfile() {
    const p = state.portal || {};
    if (p.billing && typeof p.billing === "object") return p.billing;
    if (p.portal && p.portal.billing && typeof p.portal.billing === "object") return p.portal.billing;
    return {};
  }

  // ── "Thiết bị" (Devices) screen — single active device, told truthfully ──────────────────────────
  // The product enforces ONE active device per account (+ takeover, see the multi-device model), so the
  // design's multi-row "log out strange devices" table is misleading: there is normally exactly one live
  // session (this machine), and the backend captures no device name / location / OS / IP. So instead of
  // faking a device list we replace the table with a single "Thiết bị này" card built from REAL data:
  // OS from navigator.userAgent (this renderer), session times from state.portal.devices, email from the
  // account, a device-bound (DPoP) note, and a "Đăng xuất máy này" button (the existing logout teardown).
  const DEVICES_ROW_GRID_RE = /grid-template-columns:\s*1fr\s+150px\s+140px\s+120px/i;

  function portalDevicesList() {
    const p = state.portal || {};
    if (Array.isArray(p.devices)) return p.devices;
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : null;
    return (inner && Array.isArray(inner.devices)) ? inner.devices : [];
  }
  function currentDeviceOsLabel() {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (/Windows/i.test(ua)) return "Windows";
    if (/Macintosh|Mac OS X/i.test(ua)) return "macOS";
    if (/Linux|X11/i.test(ua)) return "Linux";
    return "Thiết bị";
  }
  // Live sessions = non-revoked rows whose lastSeenAt heartbeat is fresh (~5s while an app runs; 10min
  // window absorbs sleep/backoff). Stale rows pile up because deviceId is re-rolled per app launch.
  function liveDeviceCount() {
    const now = Date.now();
    return portalDevicesList().filter((d) => d && !d.revokedAt
      && (now - (Date.parse(d.lastSeenAt || d.issuedAt || "") || 0)) < 10 * 60 * 1000).length;
  }
  // single-active-device: the live session is the newest non-revoked row for this account.
  function currentDeviceSession() {
    const live = portalDevicesList().filter((d) => d && !d.revokedAt);
    if (!live.length) return null;
    return live.slice().sort((a, b) =>
      (Date.parse(b.issuedAt || b.lastSeenAt || "") || 0) - (Date.parse(a.issuedAt || a.lastSeenAt || "") || 0))[0];
  }
  function deviceLastActiveLabel(sess) {
    const t = Date.parse((sess && (sess.lastSeenAt || sess.issuedAt)) || "");
    if (!Number.isFinite(t)) return "vừa xong";
    const diff = Date.now() - t;
    if (diff < 2 * 60 * 1000) return "vừa xong";
    if (diff < 60 * 60 * 1000) return `${Math.round(diff / 60000)} phút trước`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)} giờ trước`;
    return formatHistoryDateTime(sess.lastSeenAt || sess.issuedAt);
  }

  function deviceCardBlockHtml() {
    const sess = currentDeviceSession();
    const account = state.account || {};
    const email = (sess && sess.email) || account.email || account.account || "";
    const name = `${currentDeviceOsLabel()} · CentriX App User`;
    const detail = (k, v) => `<div style="display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:3px 0;"><span style="color:var(--text-3);">${escapeHtml(k)}</span><span style="color:var(--text);font-weight:600;">${escapeHtml(v)}</span></div>`;
    const rows = [
      ["Hoạt động cuối", deviceLastActiveLabel(sess)],
      sess && sess.issuedAt ? ["Đăng nhập từ", formatHistoryDateTime(sess.issuedAt)] : null,
      email ? ["Email", email] : null
    ].filter(Boolean).map((r) => detail(r[0], r[1])).join("");
    const monitor = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`;
    return `<div data-cx-device="1" style="display:flex;flex-direction:column;gap:10px;border:1px solid var(--border-soft);border-left:4px solid var(--ok);border-radius:12px;background:var(--ok-soft);padding:16px 18px;margin-top:4px;">`
      + `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">`
      +   `<div style="display:flex;align-items:center;gap:11px;min-width:0;">`
      +     `<div style="width:38px;height:38px;border-radius:10px;background:var(--surface);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;">${monitor}</div>`
      +     `<div style="min-width:0;"><div style="font-size:14px;font-weight:700;color:var(--text);">${escapeHtml(name)}</div>`
      +       `<div style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:var(--ok-text);margin-top:3px;"><span style="width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;"></span>Đang hoạt động · đã khoá theo thiết bị</div></div>`
      +   `</div>`
      +   `<button data-cx-device-logout="1" style="font-size:12px;font-weight:600;color:var(--danger);background:var(--surface);border:1px solid var(--field-border);border-radius:8px;padding:7px 13px;cursor:pointer;white-space:nowrap;flex-shrink:0;">Đăng xuất máy này</button>`
      + `</div>`
      + `<div style="border-top:1px dashed var(--border);padding-top:8px;">${rows}</div>`
      + `</div>`;
  }

  let devicesScreenSeen = false;
  function patchDevices() {
    const title = findLeafByText("devices", /^Thiết bị đăng nhập$/i);
    if (!isLaidOut(title)) { devicesScreenSeen = false; return; }
    if (!devicesScreenSeen) { devicesScreenSeen = true; scheduleAccountStateRefresh(0); }
    if (!state.account) return; // wait for /api/me so the email/session are real, not a flash of blanks

    const card = title.parentElement; // the title is a direct child of the devices card
    if (!card) return;

    // Replace the design's "log out strange devices" line with the single-device policy.
    const subTxt = "Mỗi tài khoản chỉ đăng nhập 1 thiết bị tại một thời điểm. Đăng nhập máy mới sẽ tự đăng xuất máy này.";
    const subtitle = Array.from(card.children).find((c) =>
      c.tagName === "DIV" && c.children.length === 0 && /đang dùng|thiết bị lạ|bảo mật/i.test(c.textContent || ""));
    if (subtitle && (subtitle.textContent || "") !== subTxt) subtitle.textContent = subTxt;

    const block = deviceCardBlockHtml();
    const existing = card.querySelector('[data-cx-device="1"]');
    if (existing && card.dataset.centrixDevicesKey === block) return; // idempotent

    // Drop the sample table (column header + every device row) and our previous block, then insert the card.
    Array.from(card.children).forEach((c) => {
      const style = c.getAttribute("style") || "";
      if (DEVICES_ROW_GRID_RE.test(style) || c.getAttribute("data-cx-device") === "1") c.remove();
    });
    card.insertAdjacentHTML("beforeend", block);
    card.dataset.centrixDevicesKey = block;
    const btn = card.querySelector("[data-cx-device-logout]");
    if (btn && !btn.__cxBound) {
      btn.__cxBound = true;
      btn.addEventListener("click", () => { performLogoutTeardown(); });
    }
  }

  // ── "Hỗ trợ" (Support) screen — user's ticket history + admin replies ────────────────────────────
  // The support screen ships only a submit form (already wired via submitSupport) + an FAQ — there is NO
  // ticket history at all. state.portal.tickets IS populated though, so we INJECT a "Yêu cầu của tôi"
  // card next to the form showing each submitted ticket's status + the admin's reply (the App Server
  // persists reply/status onto the ticket via the portal upsert). DOM-patch in the patchOrders style.
  const SUPPORT_FORM_TITLE_RE = /^Gửi yêu cầu hỗ trợ$/i;

  function portalTicketsList() {
    const p = state.portal || {};
    if (Array.isArray(p.tickets)) return p.tickets;
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : null;
    return (inner && Array.isArray(inner.tickets)) ? inner.tickets : [];
  }
  function portalTicketsLoaded() {
    const p = state.portal;
    if (!p || typeof p !== "object") return false;
    if (Array.isArray(p.tickets)) return true;
    const inner = (p.portal && typeof p.portal === "object") ? p.portal : null;
    return Boolean(inner && Array.isArray(inner.tickets));
  }

  function ticketStatusStyle(t) {
    const s = fold(String(t.status || ""));
    if (/answered|replied|tra loi/.test(s) || (t.reply && String(t.reply).trim())) {
      return { label: "Đã trả lời", color: "var(--ok-text)", bg: "var(--ok-soft)", border: "var(--ok-border)" };
    }
    if (/closed|close|resolved|done|dong|giai quyet/.test(s)) {
      return { label: "Đã đóng", color: "var(--text-3)", bg: "var(--surface-3)", border: "var(--border)" };
    }
    if (/in.?progress|processing|xu ly/.test(s)) {
      return { label: "Đang xử lý", color: "var(--brand)", bg: "var(--brand-soft)", border: "var(--brand-border)" };
    }
    return { label: "Đang chờ", color: "#b45309", bg: "#fff7ed", border: "#fed7aa" };
  }

  function ticketRowHtml(t) {
    const st = ticketStatusStyle(t);
    const when = formatHistoryDateTime(t.createdAt);
    const msg = String(t.message || "").slice(0, 160);
    const reply = String(t.reply || "").trim();
    const replyHtml = reply
      ? `<div style="margin-top:8px;border-left:3px solid var(--ok-border);background:var(--ok-soft);border-radius:0 8px 8px 0;padding:7px 10px;"><div style="font-size:11px;font-weight:700;color:var(--ok-text);margin-bottom:2px;">CentriX phản hồi</div><div style="font-size:12.5px;color:var(--text);line-height:1.45;white-space:pre-wrap;">${escapeHtml(reply.slice(0, 400))}</div></div>`
      : "";
    return `<div data-cx-ticket="1" style="border:1px solid var(--border-soft);border-radius:12px;background:var(--surface-2,transparent);padding:12px 14px;">`
      + `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;"><div style="min-width:0;"><div style="font-size:13.5px;font-weight:600;color:var(--text);">${escapeHtml(t.subject || "Yêu cầu hỗ trợ")}</div><div style="font-size:12px;color:var(--text-3);margin-top:2px;">${escapeHtml(when)}</div></div><span style="font-size:11px;font-weight:700;color:${st.color};background:${st.bg};border:1px solid ${st.border};border-radius:999px;padding:3px 10px;white-space:nowrap;flex-shrink:0;">${escapeHtml(st.label)}</span></div>`
      + (msg ? `<div style="font-size:12.5px;color:var(--text-2);margin-top:6px;line-height:1.45;">${escapeHtml(msg)}</div>` : "")
      + replyHtml
      + `</div>`;
  }

  function ticketsEmptyHtml() {
    return `<div data-cx-ticket="1" style="padding:22px 4px;text-align:center;color:var(--text-3);font-size:13px;">Chưa có yêu cầu nào. Gửi yêu cầu đầu tiên ở bên trái.</div>`;
  }

  let supportScreenSeen = false;
  // Standard chat scrolling for the CSKH/AI support chat popup: pinned to the NEWEST message by default; when the
  // user scrolls UP to read history we STOP auto-sticking until they return to the bottom (like Zalo/Messenger).
  // Runs on the body tick, which fires whenever the popup renders a new bubble.
  let _chatPinned = true, _chatLastScrollH = 0;
  // Find the ACTUAL scrollable message list: anchor on the chat input (stable across renders), climb to the popup
  // root, then pick the descendant that truly overflows + scrolls vertically (by COMPUTED style, not the inline
  // string — the design's real scroller may be a different node than the styled wrapper).
  function chatScrollEl() {
    const input = Array.from(document.querySelectorAll("input,textarea"))
      .find((i) => /nhập tin nhắn/i.test(i.getAttribute("placeholder") || "") && i.offsetParent !== null);
    if (!input) return null;
    // Climb to the popup ROOT = the nearest fixed/absolute-positioned ancestor (the floating chat window), so the
    // search stays INSIDE the popup and never matches the main app's own scroll area.
    let root = input.parentElement;
    for (let i = 0; i < 12 && root && root !== document.body; i += 1) {
      const pos = getComputedStyle(root).position;
      if (pos === "fixed" || pos === "absolute") break;
      root = root.parentElement;
    }
    if (!root || root === document.body) { root = input.parentElement; for (let i = 0; i < 6 && root.parentElement && root.parentElement !== document.body; i += 1) root = root.parentElement; }
    const cands = Array.from(root.querySelectorAll("div")).filter((el) => {
      const st = getComputedStyle(el);
      return (st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 4;
    });
    return cands.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
  }
  function patchChatAutoScroll() {
    const el = chatScrollEl();
    if (!el) { _chatPinned = true; _chatLastScrollH = 0; return; } // chat closed / nothing to scroll → reset
    if (!el.dataset.cxChatScroll) {
      el.dataset.cxChatScroll = "1";
      // user scroll → "pinned" = within 60px of the bottom (at newest); further up = reading history.
      el.addEventListener("scroll", () => { _chatPinned = (el.scrollHeight - el.scrollTop - el.clientHeight) < 60; });
      _chatPinned = true; _chatLastScrollH = 0; // force the snap below on first sight of this scroller
    }
    if (el.scrollHeight !== _chatLastScrollH) {          // freshly opened OR a new bubble grew the content
      if (_chatPinned) el.scrollTop = el.scrollHeight;   // stick to newest UNLESS the user scrolled up to read
      _chatLastScrollH = el.scrollHeight;
    }
  }
  const SUPPORT_PAGE_SIZE = 10; // "Yêu cầu của tôi" — 10 rows/page + a numbered pager (mirrors Đơn hàng / Lịch sử).
  // Delegated pager click on the persistent tickets card — survives row re-renders; guarded against double-wiring.
  function wireSupportPager(card) {
    if (!card || card.dataset.cxSupportPagerWired === "1") return;
    card.dataset.cxSupportPagerWired = "1";
    card.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-cx-page]") : null;
      if (!btn || !card.contains(btn)) return;
      const p = parseInt(btn.getAttribute("data-cx-page"), 10);
      if (isNaN(p)) return;
      e.preventDefault();
      e.stopPropagation();
      state.supportPage = p;
      patchSupport();
    });
  }
  function patchSupport() {
    const header = findLeafByText("support", SUPPORT_FORM_TITLE_RE);
    if (!isLaidOut(header)) { supportScreenSeen = false; return; }
    if (!supportScreenSeen) { supportScreenSeen = true; scheduleAccountStateRefresh(0); }
    if (!portalTicketsLoaded()) return; // wait for the portal so we don't paint an empty card prematurely

    const formCard = header.parentElement;            // leaf title → the submit-form card
    const grid = formCard && formCard.parentElement;  // → the 2-col (1fr 1fr) outer grid
    if (!grid) return;

    const allTickets = portalTicketsList().slice()
      .sort((a, b) => (Date.parse(b.createdAt || "") || 0) - (Date.parse(a.createdAt || "") || 0))
      .slice(0, 200);
    // 10 rows/page + a numbered pager. Clamp state.supportPage to the valid range (list may shrink).
    const pages = Math.max(1, Math.ceil(allTickets.length / SUPPORT_PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(state.supportPage) || 0), pages - 1);
    state.supportPage = page;
    const start = page * SUPPORT_PAGE_SIZE;
    const rowsHtml = (allTickets.length ? allTickets.slice(start, start + SUPPORT_PAGE_SIZE).map(ticketRowHtml).join("") : ticketsEmptyHtml())
      + (pages > 1 ? usagePagerHtml(page, pages) : "");

    const existing = grid.querySelector('[data-cx-ticket-card="1"]');
    if (existing && grid.dataset.centrixTicketsKey === rowsHtml) { wireSupportPager(existing); return; } // idempotent
    if (existing) existing.remove();
    const cardHtml = `<div data-cx-ticket-card="1" style="grid-column:1 / -1;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);padding:20px 22px;"><div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:14px;">Yêu cầu của tôi</div><div style="display:flex;flex-direction:column;gap:10px;">${rowsHtml}</div></div>`;
    grid.insertAdjacentHTML("beforeend", cardHtml);
    grid.dataset.centrixTicketsKey = rowsHtml;
    wireSupportPager(grid.querySelector('[data-cx-ticket-card="1"]'));
  }

  // ── "Nhân viên CSKH" live chat (floating widget) — real chat synced with App Server ──────────────
  // The widget's message list (s.chatLog) + sendChat()/setChatMode() are static-logic driven. In CSKH
  // mode we DRIVE s.chatLog from the user's backend livechat thread (state.portal.tickets, channel=
  // "livechat") and send via portal.livechatSend; a 3.5s poll picks up agent replies. "Trợ lý AI" mode
  // is left untouched. Reuses portalTicketsList (defined for patchSupport).
  const CSKH_GREETING = "Bạn đang kết nối với CSKH CentriX. Để lại câu hỏi, nhân viên sẽ phản hồi sớm nhất nhé.";
  // Clock time (HH:MM) shown above each live-chat bubble ("Bạn · 17:18" / "CSKH CentriX · 17:22"),
  // forced to Vietnam time (Asia/Ho_Chi_Minh, UTC+7) so it's right regardless of the machine timezone
  // (the stored `at` is UTC). The optimistic echo passes new Date().toISOString() (also UTC) → consistent.
  function livechatClock(at) {
    const t = Date.parse(at || "");
    if (!Number.isFinite(t)) return "";
    try {
      return new Date(t).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });
    } catch {
      const d = new Date(t); const p = (n) => String(n).padStart(2, "0");
      return p(d.getHours()) + ":" + p(d.getMinutes());
    }
  }
  function userLivechatRecord() {
    return portalTicketsList().find((t) => t && t.channel === "livechat") || null;
  }
  function livechatChatLog() {
    const rec = userLivechatRecord();
    const msgs = (rec && Array.isArray(rec.messages)) ? rec.messages : [];
    // Each message carries who+time so the static design renders a "Tên · HH:MM" header (see index.html
    // chatMsgs map). The greeting has no time → no header. AI-assistant messages never get who/time.
    return [{ role: "agent", text: CSKH_GREETING, who: "CSKH CentriX", time: "" }].concat(
      msgs.map((m) => {
        const agent = m && m.from === "agent";
        return { role: agent ? "agent" : "user", text: String((m && m.text) || ""), who: agent ? "CSKH CentriX" : "Bạn", time: livechatClock(m && m.at) };
      }).filter((m) => m.text)
    );
  }
  function refreshCskhChatLog() {
    const logic = patchedStaticLogic || staticLogic();
    if (!logic || !logic.state || logic.state.chatMode !== "cskh") return;
    const next = livechatChatLog();
    const key = next.map((m) => m.role + "|" + m.time + "|" + m.text).join("\n");
    if (logic.__centrixCskhKey === key) return; // unchanged → don't churn / reset scroll
    logic.__centrixCskhKey = key;
    try { logic.setState({ chatLog: next }); } catch { /* ignore */ }
  }
  let cskhPollTimer = 0;
  let cskhPollBusy = false;
  function ensureCskhPoll() {
    if (cskhPollTimer) return;
    cskhPollTimer = setInterval(async () => {
      if (cskhPollBusy) return; // in-flight guard: don't pile up reads that starve the Docker write
      const logic = patchedStaticLogic || staticLogic();
      if (!logic || !logic.state || !logic.state.chatOpen || logic.state.chatMode !== "cskh") return; // only poll while open+CSKH
      cskhPollBusy = true;
      try {
        const r = await api()?.portal?.summary();
        const p = (r && (r.portal || r)) || null;
        if (p && (Array.isArray(p.tickets) || (p.portal && Array.isArray(p.portal.tickets)))) { state.portal = p; refreshCskhChatLog(); }
      } catch { /* keep polling */ } finally { cskhPollBusy = false; }
    }, 1500);
  }
  function patchStaticChatHandlers(logic) {
    if (!logic || logic.__centrixChatPatched) return logic;
    const origSend = typeof logic.sendChat === "function" ? logic.sendChat.bind(logic) : null;
    const origSetMode = typeof logic.setChatMode === "function" ? logic.setChatMode.bind(logic) : null;
    logic.__centrixChatPatched = true;
    if (origSend) {
      logic.sendChat = function centrixPatchedSendChat(...args) {
        if (this.state && this.state.chatMode === "cskh") {
          const text = String(this.state.chatInput || "").trim();
          if (!text) return undefined;
          this.setState({ chatLog: [...(this.state.chatLog || []), { role: "user", text, who: "Bạn", time: livechatClock(new Date().toISOString()) }], chatInput: "" }); // optimistic (instant local echo)
          const bridge = api();
          if (bridge?.portal?.livechatSend) {
            bridge.portal.livechatSend({ text }).then((r) => {
              const p = r && (r.portal || r);
              if (p && (Array.isArray(p.tickets) || (p.portal && Array.isArray(p.portal.tickets)))) state.portal = p;
              ensureCskhPoll();
              refreshCskhChatLog();
            }).catch(() => showActionToast("Gửi tin nhắn thất bại", "error"));
          }
          return undefined;
        }
        return origSend ? origSend(...args) : undefined;
      };
    }
    if (origSetMode) {
      logic.setChatMode = function centrixPatchedSetChatMode(mode, ...args) {
        const result = origSetMode(mode, ...args);
        if (mode === "cskh") { ensureCskhPoll(); setTimeout(refreshCskhChatLog, 0); setTimeout(refreshCskhChatLog, 250); }
        return result;
      };
    }
    return logic;
  }

  // The "Tổng quan" dashboard credit widgets are a SEPARATE static child component seeded with
  // sample numbers (balance 320 = quota 1000 − used 680); the renderVals override never reaches
  // them, so they showed fake data. Patch their interpolated spans directly with the real wallet.
  // Only runs once a real account balance is known, so we never overwrite with a transient 0.
  function patchDashboardCreditCards() {
    const account = state.account || {};
    if (!Number.isFinite(Number(account.balance))) return;
    const credit = liveCreditSnapshot();
    const balTxt = formatCreditValue(credit.balance);
    const usedMonthTxt = formatCreditValue(credit.usedThisMonth); // "Đã dùng tháng này" = THIS month only
    const quotaTxt = formatCreditValue(credit.quota);

    const cardForLabel = (labelRe) => {
      const label = Array.from(document.querySelectorAll("span,div"))
        .find((el) => el.children.length === 0 && labelRe.test((el.textContent || "").trim()));
      if (!label) return null;
      let card = label.parentElement;
      for (let i = 0; i < 3 && card; i += 1) {
        if (card.querySelectorAll("span,div,b").length >= 3) break;
        card = card.parentElement;
      }
      return card;
    };
    const leaves = (card) => Array.from(card?.querySelectorAll("span,div,b,strong") || [])
      .filter((el) => el.children.length === 0);

    // Only write when the value actually changes — otherwise re-setting textContent every tick fires a
    // DOM mutation that re-triggers the MutationObserver in a tight loop.
    const setText = (el, value) => { if ((el.textContent || "") !== value) el.textContent = value; };

    const balCard = cardForLabel(/^Số dư credit$/i);
    if (balCard) {
      for (const el of leaves(balCard)) {
        const t = (el.textContent || "").trim();
        if (/^\d[\d.,\s]*$/.test(t)) setText(el, balTxt);             // balance number
        else if (/hạn mức/i.test(t)) setText(el, `${credit.pctRem}% hạn mức còn lại`);
      }
    }

    const usedCard = cardForLabel(/Đã dùng tháng này/i);
    if (usedCard) {
      let setUsed = false;
      for (const el of leaves(usedCard)) {
        const t = (el.textContent || "").trim();
        if (!setUsed && /^\d[\d.,\s]*$/.test(t)) { setText(el, usedMonthTxt); setUsed = true; } // first number = used THIS MONTH
        else if (/trên\s*[\d.,\s]+\s*credit/i.test(t)) setText(el, t.replace(/trên\s*[\d.,\s]+\s*credit/i, `trên ${quotaTxt} credit`));
      }
    }

    // "GÓI HIỆN TẠI" card + the "Gói X · Y cr/tháng" badge ship as a STATIC demo (always "Pro · gia hạn …").
    // Drive the plan NAME + subtitle from the user's REAL plan (state.planTier from /plans/me). Keep the quota
    // number untouched (it's the real credit.quota already patched above) — only the plan name was wrong.
    ensurePlanLoaded();
    const tier = state.planTier;
    if (tier) {
      const code = String(tier.current || "FREE").toUpperCase();
      const planObj = (tier.plans || []).find((p) => String(p.code).toUpperCase() === code) || {};
      const planName = tier.currentName || planObj.name || (code === "FREE" ? "Free" : code);
      const renew = tier.currentExpiresAt || tier.currentRenew || "";
      const daysLeft = tier.currentDaysLeft;
      let sub = "";
      if (renew) { const d = new Date(renew); if (Number.isFinite(d.getTime())) sub = `Hết hạn ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` + (typeof daysLeft === "number" ? ` (còn ${daysLeft} ngày)` : ""); }
      if (!sub) sub = code === "FREE" ? "Gói miễn phí" : "Đang hoạt động";
      const planCard = cardForLabel(/^Gói hiện tại$/i);
      if (planCard) {
        const ls = leaves(planCard);
        const labelEl = ls.find((el) => /^Gói hiện tại$/i.test((el.textContent || "").trim()));
        const subEl = ls.find((el) => /gia hạn|hết hạn|miễn phí|đang hoạt động/i.test((el.textContent || "").trim()));
        const nameEl = ls.find((el) => el !== labelEl && el !== subEl && (el.textContent || "").trim() && (el.textContent || "").trim().length < 40);
        if (nameEl) setText(nameEl, planName);
        if (subEl) setText(subEl, sub);
      }
      // "Gói <name> · <quota> cr/tháng" pill: swap ONLY the name part, keep the (real) quota number.
      const badge = Array.from(document.querySelectorAll("span,div")).find((el) => el.children.length === 0 && /^Gói\s+\S.*·.*\/\s*tháng$/i.test((el.textContent || "").trim()));
      if (badge) setText(badge, (badge.textContent || "").replace(/^Gói\s+.+?\s+·/, `Gói ${planName} ·`));
    }

    // "THIẾT BỊ" tile ships hardcoded "2 / 3 · đang đăng nhập". Anchor on the label leaf whose card also
    // carries the "đang đăng nhập" caption so the bare nav-tab label "Thiết bị" can never match.
    const devLabel = Array.from(document.querySelectorAll("span,div")).find((el) =>
      el.children.length === 0 && /^Thiết bị$/i.test((el.textContent || "").trim())
      && /đang đăng nhập/i.test(((el.parentElement && el.parentElement.parentElement) || el).textContent || ""));
    if (devLabel) {
      let devCard = devLabel.parentElement;
      for (let i = 0; i < 3 && devCard; i += 1) {
        if (devCard.querySelectorAll("span,div,b").length >= 3) break;
        devCard = devCard.parentElement;
      }
      if (devCard) {
        const devValue = `${Math.max(1, liveDeviceCount())} / 1`;
        for (const el of leaves(devCard)) {
          const t = (el.textContent || "").trim();
          if (/^\d+\s*\/\s*\d+$/.test(t)) setText(el, devValue);
          else if (/^đang đăng nhập/i.test(t)) setText(el, "đang đăng nhập · giới hạn 1 thiết bị");
        }
      }
    }
  }

  function patchVisibleCreditTextsSoon() {
    for (const delay of [0, 260]) setTimeout(patchVisibleCreditTexts, delay); // was [0,80,240] — the 0ms pass still paints the real balance over the seed immediately
  }

  function applyLiveServiceVals(vals, staticState = {}) {
    if (typeof ensurePlanLoaded === "function") ensurePlanLoaded();  // load planTier (gate + blockedServices) so the sidebar can filter by plan
    const live = liveServices();
    if (!live.length) {
      if (staticState.screen === "app") {
        vals.services = [];
        vals.svcCount = 0;
        vals.demoRows = [];
      }
      return vals;
    }

    let svcRows = liveServiceRows(staticState);
    if (typeof planBlocksService === "function") svcRows = svcRows.filter((r) => !planBlocksService(r.id));  // plan gating: hide services the user's plan doesn't allow (only when gate ON)
    vals.services = svcRows;
    vals.svcCount = svcRows.length;
    vals.demoRows = liveDemoRows(staticState);

    const activeService = live.find((service) => (
      service.id === state.browser.activeServiceId ||
      fold(service.name) === fold(state.browser.activeServiceName || staticState.active)
    ));
    if (activeService) {
      const meta = serviceMeta(activeService, activeService.name);
      vals.activeName = activeService.name;
      vals.activeHost = hostFromUrl(activeService.url);
      vals.activeInitial = meta.initial;
      vals.activeBg = meta.bg;
      vals.activeCost = serviceCreditCost(activeService);
      vals.onRunRequest = () => openService(activeService);
    }

    if (state.browser.activeServiceId && state.browser.opening) {
      vals.showRunning = false;
      vals.showOpening = true;
      vals.showContent = false;
      // "Đợi nạp profile": hiện TIẾN ĐỘ theo phase (nhận hồ sơ → tải → ổn định) bằng tiếng Việt rõ ràng thay vì 1
      // text tĩnh → khách biết app đang chạy, không tưởng treo (đặc biệt khi kéo profile chậm / cần re-seed).
      const __pst = String((state.browser.prepare && state.browser.prepare.status) || "").toLowerCase();
      const __pnm = state.browser.pendingServiceName || state.browser.activeServiceName || "dịch vụ";
      const __pmsg = ({
        profile: "Đang nhận hồ sơ đăng nhập…",
        "local-store": "Đang nạp dữ liệu phiên…",
        loading: "Đang tải " + __pnm + "…",
        "dom-stable": "Đang chờ giao diện dịch vụ ổn định…",
        settling: "Đang ổn định giao diện trước khi hiển thị…",
        ready: __pnm + " đã sẵn sàng.",
      })[__pst] || ("Đang chuẩn bị " + __pnm + "…");
      vals.openingTitle = "Đang chuẩn bị " + __pnm;
      vals.openingText = __pmsg;
      vals.openingMessage = __pmsg;
      vals.openingStatus = __pmsg;
      vals.loadingText = __pmsg;
      vals.activeStatus = __pmsg;
    } else if (state.browser.activeServiceId && !state.browser.opening) {
      // Service finished loading: render the SERVICE CARD (showRunning) — header (‹ › ↻ + credit +
      // close) over the card-body placeholder the native browser view covers. Leaving all three
      // show* false rendered an EMPTY Main area → the content area went blank (white) after load.
      vals.showRunning = true;
      vals.showOpening = false;
      vals.showContent = false;
    }

    return vals;
  }

  // Mua/nâng cấp gói cước = TRỪ TIỀN VÍ VNĐ (server tự tra giá theo planCode/duration — chống spoof), kích
  // hoạt gói + cộng credit gói nguyên tử ở dbapi. Thiếu tiền ví → mời nạp (prefill đúng số tiền gói).
  function submitPlanUpgrade(plan, durationMonths = 1) {
    const bridge = api();
    if (!bridge?.portal?.buyPlanMoney) { showActionToast("Phiên bản app chưa hỗ trợ mua bằng ví, vui lòng cập nhật", "error"); return; }
    const months = Number(durationMonths) === 12 ? 12 : 1;
    const price = Number(months === 12 ? (plan.price_annual || plan.price) : plan.price) || 0;
    bridge.portal.buyPlanMoney({ planCode: plan.code, durationMonths: months, note: "Mua goi " + plan.code + " " + months + "m; vi=VND" })
      .then((result) => {
        showActionToast("Đã mua gói " + (plan.name || plan.code) + " từ ví VNĐ");
        state.planTier = null;
        ensurePlanLoaded(true);
        refresh().catch(() => {});
      })
      .catch((e) => {
        const msg = e?.message || String(e);
        if (/402|insufficient|khong du|không đủ/i.test(msg)) {
          showActionToast("Số dư ví VNĐ không đủ. Vui lòng nạp thêm tiền vào ví.", "error");
          try { openMoneyTopupPrompt(price); } catch (err) {}
        } else showActionToast(msg || "Lỗi nâng cấp", "error");
      });
  }
  // Chọn thời hạn (1 tháng / 12 tháng) TRƯỚC khi mua. Mua = TRỪ VÍ VNĐ nên modal hiện luôn số dư ví + đánh dấu
  // gói nào đủ/thiếu tiền; thiếu thì nút đổi thành "Nạp thêm để mua" (mở modal nạp ví, prefill số tiền còn thiếu).
  // Server tự tra giá theo planCode/duration (chống spoof). Gói không có giá năm → chỉ hiện 1 lựa chọn 1 tháng.
  function chooseAndUpgrade(plan) {
    const monthly = Number(plan.price) || 0;
    const annual = Number(plan.price_annual) || 0;
    const bal = Number(liveCreditSnapshot().moneyBalance) || 0;
    const fmt = (n) => (Number(n) || 0).toLocaleString("vi-VN") + "₫";
    const old = document.getElementById("cx-plan-dur-modal"); if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "cx-plan-dur-modal";
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);";
    const optBtn = (m, label, price, hint) => {
      const enough = bal >= price;
      const badge = enough
        ? `<span style="font:800 10.5px Segoe UI;color:#16a34a;background:#dcfce7;border-radius:6px;padding:2px 7px;white-space:nowrap;">Đủ tiền</span>`
        : `<span style="font:800 10.5px Segoe UI;color:#b91c1c;background:#fee2e2;border-radius:6px;padding:2px 7px;white-space:nowrap;">Thiếu ${fmt(price - bal)}</span>`;
      return `<button type="button" data-dur="${m}" data-price="${price}" style="display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;margin-top:10px;padding:13px 15px;border:1px solid ${enough ? "var(--field-border,#cbd5e1)" : "#fecaca"};border-radius:11px;background:var(--surface,#fff);color:var(--text,#0f172a);cursor:pointer;font:700 14px Segoe UI;">
        <span>${label}${hint ? `<div style="font-size:11.5px;color:var(--brand,#2563eb);font-weight:700;margin-top:2px;">${hint}</div>` : ""}<div style="margin-top:5px;">${badge}</div></span>
        <span style="font:900 15px Segoe UI;white-space:nowrap;">${fmt(price)}</span>
      </button>`;
    };
    const saveTxt = (annual > 0 && monthly > 0 && annual < monthly * 12) ? `Tiết kiệm ${Math.round((1 - annual / (monthly * 12)) * 100)}% so với trả tháng` : "";
    ov.innerHTML = `<div role="dialog" style="width:380px;max-width:calc(100vw - 40px);background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:16px;padding:20px 22px;box-sizing:border-box;">
      <div style="font:900 17px Segoe UI;color:var(--text,#0f172a);">Mua gói — ${escapeHtml(plan.name || plan.code)}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding:10px 13px;border-radius:11px;background:var(--brand-soft,#eff6ff);border:1px solid var(--brand,#2563eb);">
        <span style="font:800 12px Segoe UI;color:var(--text-2,#475569);">Số dư ví VNĐ</span>
        <span style="font:900 15px Segoe UI;color:var(--brand,#2563eb);">${fmt(bal)}</span>
      </div>
      <div style="font-size:12px;color:var(--text-2,#475569);margin-top:8px;">Thanh toán bằng ví VNĐ. Hết hạn sẽ tự về gói Free.</div>
      ${optBtn(1, "1 tháng", monthly, "")}
      ${annual > 0 ? optBtn(12, "12 tháng", annual, saveTxt) : ""}
      <button type="button" data-dur="0" style="margin-top:14px;width:100%;height:38px;border:1px solid var(--field-border,#cbd5e1);border-radius:9px;background:transparent;color:var(--text-2,#475569);font:800 13px Segoe UI;cursor:pointer;">Hủy</button>
    </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("mousedown", (e) => { if (e.target === ov) ov.remove(); });
    ov.querySelectorAll("[data-dur]").forEach((b) => b.addEventListener("click", () => {
      const m = Number(b.getAttribute("data-dur")) || 0;
      const price = Number(b.getAttribute("data-price")) || 0;
      ov.remove();
      if (m <= 0) return;
      // Thiếu tiền → mở thẳng modal nạp ví (prefill đúng số cần) thay vì để server trả 402.
      if (bal < price) {
        showActionToast("Số dư ví VNĐ không đủ. Vui lòng nạp thêm tiền vào ví.", "error");
        try { openMoneyTopupPrompt(price); } catch (e) {}
        return;
      }
      submitPlanUpgrade(plan, m);
    }));
  }
  // "Gói cước" tab (vals.plans): override the design's demo plan cards with the REAL plans from the backend
  // (state.planTier from /api/users/plans/me). Marks the user's current plan, fixes name/price/credits, and
  // wires the buttons (downgrade = real self-downgrade; paid upgrade = Phase 2 toast). Same renderVals-override
  // mechanism the org tab uses. Keeps the design demo on any failure / before data loads.
  function applyLivePlanVals(vals, st, logic) {
    try {
      if (!vals || !Array.isArray(vals.plans) || !vals.plans.length) return;
      const first = vals.plans[0] || {};
      if (!("cycle" in first) || !("credits" in first) || !("btnLabel" in first)) return; // not the plan component
      ensurePlanLoaded();
      const tier = state.planTier;
      if (!tier || !Array.isArray(tier.plans) || !tier.plans.length) return;   // keep demo until loaded
      const real = tier.plans.slice().sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
      // Emit ONE card per REAL plan (the design template loops `sc-for list="{{ plans }}"`, so card count =
      // vals.plans.length). Previously this bailed when real.length !== demo length, capping the screen at the
      // design's 3 demo cards → a 4th server plan never showed. Map over `real`, reusing a demo entry as the
      // style template (falling back to the first demo when real has more plans than the demo).
      const demo = vals.plans;
      const current = String(tier.current || "FREE").toUpperCase();
      const curPrio = Number((real.find((p) => String(p.code).toUpperCase() === current) || {}).priority) || 1;
      const fmtPrice = (n) => { n = Number(n) || 0; return n <= 0 ? "0₫" : (n % 1000 === 0 ? (n / 1000) + "K" : n.toLocaleString("vi-VN") + "₫"); };
      vals.plans = real.map((rp, i) => {
        const orig = demo[i] || demo[0] || {};
        const code = String(rp.code).toUpperCase();
        const cur = code === current;
        const lower = (Number(rp.priority) || 0) < curPrio;
        const creditsLine = (Number(rp.free_grant) || 0).toLocaleString("vi-VN") + " credit / tháng";
        // Feature bullets: prefer the admin-configured list from the App Server "Sửa gói" modal (rp.features,
        // JSON string or array); fall back to the demo card's bullets. Either way, replace the "… credit / tháng"
        // line with the real free_grant so the displayed credit always matches the plan.
        let realFeatures = rp.features;
        if (typeof realFeatures === "string") { try { realFeatures = JSON.parse(realFeatures || "[]"); } catch (e) { realFeatures = []; } }
        const baseFeatures = (Array.isArray(realFeatures) && realFeatures.length)
          ? realFeatures
          : (Array.isArray(orig.features) ? orig.features : [creditsLine]);
        let features = baseFeatures.map((f) => /credit\s*\/\s*th/i.test(String(f)) ? creditsLine : f);
        // On the user's CURRENT paid plan, append its expiry so the card shows when it runs out.
        if (cur && tier.currentExpiresAt) {
          const d = new Date(tier.currentExpiresAt);
          if (Number.isFinite(d.getTime())) {
            features = features.concat([`Hết hạn ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` + (typeof tier.currentDaysLeft === "number" ? ` (còn ${tier.currentDaysLeft} ngày)` : "")]);
          }
        }
        return {
          ...orig,
          name: rp.name || rp.code,
          price: fmtPrice(rp.price),
          cycle: (Number(rp.price) || 0) > 0 ? "/ tháng" : "mãi mãi",
          credits: creditsLine,
          current: cur,
          features,
          perNote: "",
          hasPerNote: false,
          cardBorder: cur ? "var(--brand)" : "var(--border)",
          cardBg: cur ? "var(--brand-soft)" : "var(--surface)",
          priceColor: cur ? "var(--brand)" : "var(--text)",
          btnLabel: cur ? "Gói đang dùng" : (lower ? "Hạ cấp" : ((Number(rp.price) || 0) > 0 ? "Mua bằng ví" : "Nâng cấp")),
          btnBg: cur ? "var(--surface)" : "var(--brand)",
          btnColor: cur ? "var(--text-3)" : "#fff",
          btnBorder: cur ? "var(--field-border)" : "var(--brand)",
          onPick: cur ? (() => {}) : (lower
            ? (() => showConfirm("Chuyển về gói " + (rp.name || rp.code) + "? Hạ cấp — không mất credit đã có.", () => {
                const bridge = api();
                if (!bridge?.portal?.planSelfDowngrade) return;
                bridge.portal.planSelfDowngrade({ planCode: rp.code })
                  .then((r) => {
                    if (r && r.ok !== false) {
                      showActionToast("Đã chuyển sang gói " + (rp.name || rp.code), "ok");
                      state.planTier = null;
                      ensurePlanLoaded(true).then(() => { try { if (logic && logic.setState) logic.setState({ __planRefresh: Date.now() }); } catch (e) { /* re-render best-effort */ } });
                    } else showActionToast(r?.error || "Hạ cấp thất bại", "error");
                  })
                  .catch((e) => showActionToast(e?.message || "Lỗi hạ cấp", "error"));
              }, { title: "Đổi gói cước", ok: "Chuyển gói", danger: true }))
            : (() => chooseAndUpgrade(rp))),
        };
      });
    } catch (e) { /* keep demo on any failure */ }
  }

  function patchStaticUrlLog(logic = staticLogic()) {
    if (!logic || logic.__centrixUrlLogPatched) return Boolean(logic?.__centrixUrlLogPatched);
    if (typeof logic.renderVals !== "function") return false;
    const originalRenderVals = logic.renderVals.bind(logic);
    logic.renderVals = function patchedRenderVals(...args) {
      const vals = originalRenderVals(...args) || {};
      const rows = staticUrlRows(this.state || {});
      applyLiveServiceVals(vals, this.state || {});
      applyLiveAccountVals(vals);
      applyLivePlanVals(vals, this.state || {}, this);
      vals.urlLog = rows;
      vals.urlCount = `${rows.length} mục`;
      vals.urlEmpty = rows.length === 0;
      return vals;
    };
    try {
      Object.defineProperty(logic, "__centrixUrlLogPatched", { value: true, configurable: true });
    } catch {
      logic.__centrixUrlLogPatched = true;
    }
    return true;
  }

  // Patch renderVals on (and force a re-render of) EVERY component that carries the url log — the main
  // shell AND the separate Nhật ký child that owns urlTime/urlLog. The child may mount late (on tab
  // navigation), so re-scanning here is what catches it; without this its renderVals stays unpatched
  // and the date filter / real history never reach the rendered list. Returns how many were nudged.
  function patchAndRefreshUrlComponents() {
    let nudged = 0;
    for (const item of collectStaticCandidates()) {
      if (typeof item.renderVals === "function") patchStaticUrlLog(item);
      const st = item.state;
      const ownsUrlLog = st && (
        Object.prototype.hasOwnProperty.call(st, "urlTime") ||
        Object.prototype.hasOwnProperty.call(st, "urlLog") ||
        Object.prototype.hasOwnProperty.call(st, "urlQuery") ||
        Object.prototype.hasOwnProperty.call(st, "urlHistoryRevision")
      );
      if (ownsUrlLog && typeof item.setState === "function") {
        try {
          item.setState({ urlHistoryRevision: Date.now() });
          nudged += 1;
        } catch {
          // best-effort; another candidate may still take the update
        }
      }
    }
    return nudged;
  }

  function refreshStaticUrlLogSoon() {
    setTimeout(() => {
      let nudged = 0;
      try {
        nudged = patchAndRefreshUrlComponents();
      } catch {
        // fall through to the main-logic nudge below
      }
      const logic = staticLogic();
      if (logic?.setState && nudged === 0) {
        // No dedicated url child found yet — nudge the main shell so its render tree (incl. children) repaints.
        patchStaticUrlLog(logic);
        try {
          logic.setState({ urlHistoryRevision: Date.now() });
        } catch {
          // Static UI refresh is best-effort; URL history is still stored.
        }
      }
      try {
        patchVisibleCreditTextsSoon();
      } catch {
        // credit-text repaint is best-effort
      }
    }, 0);
  }

  function openHistoryUrl(row) {
    const service = serviceFromUrl(row?.url, row?.serviceId, row?.serviceName);
    if (service?.id) openService(service, row.url);
  }

  function showStaticAppScreenSoon() {
    for (const delay of [0, 120, 300, 700, 1200, 2200]) {
      setTimeout(() => {
        if (state.loginOk) {
          showStaticAppScreen();
          patchStaticUrlLog();
          refreshStaticUrlLogSoon();
        }
      }, delay);
    }
  }

  function ensureBrowserControl() {
    let panel = document.getElementById("centrix-user-browser-control");
    panel?.remove();
    ensureServiceLoadingOverlay();
    patchServiceCard();
    ensureServiceCloseButton();
    ensureBrowserCornerMasks();
    ensureBrowserNavToolbar();
    polishCollapsedSidebar();
  }

  function ensureServiceLoadingOverlay() {
    let overlay = document.getElementById("centrix-user-service-loading-overlay");
    if (!state.browser.activeServiceId || state.browser.opening !== true) {
      overlay?.remove();
      return;
    }

    normalizeServiceLoadingText();

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "centrix-user-service-loading-overlay";
      overlay.setAttribute("role", "status");
      overlay.setAttribute("aria-live", "polite");
      overlay.innerHTML = `
        <div style="width:min(520px,calc(100% - 42px));padding:34px 30px;border:1px solid rgba(191,224,252,.9);border-radius:14px;background:rgba(255,255,255,.96);box-shadow:0 22px 54px rgba(15,23,42,.14);display:flex;flex-direction:column;align-items:center;text-align:center;">
          <div style="width:48px;height:48px;border-radius:15px;background:#1e93f5;display:flex;align-items:center;justify-content:center;color:#fff;font:800 18px/1 Segoe UI,system-ui,sans-serif;box-shadow:0 10px 26px rgba(30,147,245,.28);" data-centrix-loading-initial></div>
          <div style="margin-top:15px;font:800 18px/1.2 Segoe UI,system-ui,sans-serif;color:#0f172a;" data-centrix-loading-name></div>
          <div style="margin-top:9px;font:600 13px/1.45 Segoe UI,system-ui,sans-serif;color:#5b6677;">${SERVICE_BACKGROUND_LOADING_TEXT}</div>
          <div style="margin-top:18px;display:inline-flex;align-items:center;gap:9px;height:34px;padding:0 14px;border-radius:999px;border:1px solid #bfe0fc;background:#eaf5fe;color:#0b7bdd;font:700 13px/1 Segoe UI,system-ui,sans-serif;">
            <span style="width:14px;height:14px;border:2px solid rgba(30,147,245,.28);border-top-color:#1e93f5;border-radius:50%;animation:cxSpin .8s linear infinite;"></span>
            <span>${SERVICE_BACKGROUND_LOADING_TEXT}</span>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }

    const bounds = pendingPredictedBrowserBounds?.bounds || measureBrowserBounds();
    overlay.style.cssText = [
      "position:fixed",
      `left:${bounds.x}px`,
      `top:${bounds.y}px`,
      `width:${bounds.width}px`,
      `height:${bounds.height}px`,
      "z-index:2147483000",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:#eef1f5",
      "pointer-events:auto"
    ].join(";");

    const name = state.browser.activeServiceName || state.browser.pendingServiceName || state.browser.activeServiceId || "D\u1ecbch v\u1ee5";
    const initial = serviceInitial(name);
    const nameEl = overlay.querySelector("[data-centrix-loading-name]");
    const initialEl = overlay.querySelector("[data-centrix-loading-initial]");
    if (nameEl) nameEl.textContent = name;
    if (initialEl) initialEl.textContent = initial;
  }

  function normalizeServiceLoadingText() {
    if (state.browser.opening !== true || !document.body) return;
    const replacements = new Map([
      ["Đang nạp dữ liệu ẩn trong nền…", SERVICE_BACKGROUND_LOADING_TEXT],
      ["Đang nạp dữ liệu ẩn trong nền...", SERVICE_BACKGROUND_LOADING_TEXT],
      ["Đang nạp dữ liệu ẩn trong nền", SERVICE_BACKGROUND_LOADING_TEXT],
      ["Nạp dữ liệu ẩn", SERVICE_BACKGROUND_LOADING_TEXT]
    ]);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (nodes.length < 80) {
      const node = walker.nextNode();
      if (!node) break;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.parentElement?.tagName || "")) continue;
      const value = node.nodeValue || "";
      if ([...replacements.keys()].some((text) => value.includes(text))) nodes.push(node);
    }
    for (const node of nodes) {
      let value = node.nodeValue || "";
      for (const [from, to] of replacements) {
        value = value.split(from).join(to);
      }
      node.nodeValue = value;
    }
  }

  // Shared layout for the service header buttons on the right: a back (\u2039) button immediately left of
  // the close (\u00d7) button, both anchored just past the "\u0110ang theo d\u00f5i credit" pill and clamped to the
  // frame's right edge. (Forward/reload were removed per request; the design's left nav group is
  // hidden in ensureBrowserNavToolbar.)
  function serviceHeaderButtonLayout() {
    const bounds = measureBrowserBounds();
    const watchPill = allLayoutRects()
      .filter(({ rect, text }) => (
        rect.width >= 110 &&
        rect.width <= 220 &&
        rect.height >= 24 &&
        rect.height <= 42 &&
        text.includes("dang theo doi credit")
      ))
      .sort((a, b) => b.rect.left - a.rect.left)[0];
    const W = 38;
    const GAP = 6;
    const EDGE = 12; // margin from the frame's right edge
    // Vertical alignment follows the "Đang theo dõi credit" pill row; horizontally the [‹][×] cluster
    // is anchored to the FAR RIGHT edge of the service frame (per request), not to the pill.
    const top = Math.max(8, Math.round(watchPill?.rect.top || (bounds.y - 42)));
    const height = Math.max(30, Math.round(watchPill?.rect.height || 30));
    const frameRight = bounds.x + bounds.width;
    const closeLeft = Math.max(0, Math.round(frameRight - EDGE - W));
    const backLeft = Math.max(0, closeLeft - GAP - W);
    return { backLeft, closeLeft, top, height, W };
  }

  function ensureServiceCloseButton() {
    let button = document.getElementById("centrix-user-service-close");
    if (!state.browser.activeServiceId) {
      button?.remove();
      ensureServiceBackButton();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.id = "centrix-user-service-close";
      button.type = "button";
      button.title = "\u0110\u00f3ng d\u1ecbch v\u1ee5";
      button.setAttribute("aria-label", "\u0110\u00f3ng d\u1ecbch v\u1ee5");
      button.innerHTML = `<span style="font-size:18px;line-height:1;">\u00d7</span>`;
      document.body.appendChild(button);
    }

    const layout = serviceHeaderButtonLayout();
    button.style.cssText = [
      "position:fixed",
      `left:${layout.closeLeft}px`,
      `top:${layout.top}px`,
      "z-index:2147483647",
      `width:${layout.W}px`,
      `height:${layout.height}px`,
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "border:1px solid rgba(248,113,113,.65)",
      "border-radius:9px",
      "background:#ef4444",
      "color:#fff",
      "box-shadow:0 8px 18px rgba(220,38,38,.22)",
      "font:800 15px/1 Segoe UI,system-ui,sans-serif",
      "cursor:pointer"
    ].join(";");
    ensureServiceBackButton();
    hideDesignServiceCloseGlyph();
  }

  // The lone "back" navigation control, parked next to the close (\u00d7) button. Bound via the
  // data-centrix-browser-nav-action attribute so the existing click handler routes it to runBrowserNav.
  function ensureServiceBackButton() {
    let button = document.getElementById("centrix-user-service-back");
    if (!state.browser.activeServiceId) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.id = "centrix-user-service-back";
      button.type = "button";
      button.dataset.centrixBrowserNavAction = "back";
      button.setAttribute("role", "button");
      button.title = "Quay l\u1ea1i";
      button.setAttribute("aria-label", "Quay l\u1ea1i");
      button.innerHTML = `<span style="font-size:19px;line-height:1;">\u2039</span>`;
      markNoDrag(button);
      document.body.appendChild(button);
    }

    const layout = serviceHeaderButtonLayout();
    const canBack = state.browser.lastState?.canGoBack === true;
    button.setAttribute("aria-disabled", canBack ? "false" : "true");
    button.setAttribute("tabindex", canBack ? "0" : "-1");
    button.style.cssText = [
      "position:fixed",
      `left:${layout.backLeft}px`,
      `top:${layout.top}px`,
      "z-index:2147483647",
      `width:${layout.W}px`,
      `height:${layout.height}px`,
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "border:1px solid rgba(226,232,240,.96)",
      "border-radius:9px",
      "background:rgba(255,255,255,.92)",
      `color:${canBack ? "#475569" : "#cbd5e1"}`,
      "box-shadow:0 8px 18px rgba(15,23,42,.10)",
      "font:800 18px/1 Segoe UI Symbol,Segoe UI,system-ui,sans-serif",
      `cursor:${canBack ? "pointer" : "default"}`,
      `opacity:${canBack ? "1" : ".55"}`
    ].join(";");
  }

  // The design's running header has its OWN close (×) button sitting between the credit pills and the
  // bridge's ‹/× — a duplicate of the bridge's red close. Hide it (the leaf carrying a × glyph on the
  // header row, right half, not a bridge element).
  function hideDesignServiceCloseGlyph() {
    if (!state.browser.activeServiceId) return;
    const layout = serviceHeaderButtonLayout();
    const rowMid = layout.top + layout.height / 2;
    const closeGlyphs = new Set(["×", "✕", "✖", "⨯", "ⅹ", "╳"]);
    for (const el of document.querySelectorAll("button,[role='button'],span,div,a")) {
      if (el.id && el.id.startsWith("centrix-user-")) continue;
      if (el.children.length) continue; // leaf carrying the glyph
      const text = (el.textContent || "").trim();
      if (!closeGlyphs.has(text)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.width > 64 || rect.height > 64) continue;
      if (Math.abs((rect.top + rect.height / 2) - rowMid) > 24) continue; // same header row
      if (rect.left < window.innerWidth * 0.5) continue; // right half only
      const target = el.closest("button,[role='button']") || el;
      if (target.id && target.id.startsWith("centrix-user-")) continue;
      target.style.setProperty("display", "none", "important");
    }
  }

  function ensureBrowserCornerMasks() {
    let leftMask = document.getElementById("centrix-user-browser-corner-left");
    let rightMask = document.getElementById("centrix-user-browser-corner-right");
    leftMask?.remove();
    rightMask?.remove();
    if (!state.browser.activeServiceId) return;

    const bounds = measureBrowserBounds();
    const surface = allLayoutRects()
      .filter(({ rect }) => (
        Math.abs(rect.left - bounds.x) <= 4 &&
        Math.abs(rect.top - bounds.y) <= 4 &&
        Math.abs(rect.width - bounds.width) <= 8 &&
        Math.abs(rect.height - bounds.height) <= 8
      ))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.el;
    if (!surface) return;
    surface.dataset.centrixBrowserSurface = "1";
    // The native service view is now rounded (WebContentsView.setBorderRadius), so its corners reveal
    // the DOM panel behind. Keep that panel rounded on all four corners (14px) to match — previously
    // the bottom corners were flattened to butt a square BrowserView.
    surface.style.setProperty("border-radius", "14px", "important");
    surface.style.setProperty("overflow", "hidden", "important");
  }

  function ensureBrowserNavToolbar() {
    document.getElementById("centrix-user-browser-nav-toolbar")?.remove();
    if (!state.browser.activeServiceId) return;

    const bounds = measureBrowserBounds();
    const actionFor = (element) => {
      const existing = element.dataset?.centrixBrowserNavAction || "";
      if (existing === "back" || existing === "forward" || existing === "reload") return existing;
      const raw = String(element.textContent || "").trim();
      const title = fold(element.getAttribute("title") || element.getAttribute("aria-label") || "");
      if (title.includes("back") || title.includes("lui") || raw === "\u2039" || raw === "<") return "back";
      if (title.includes("forward") || title.includes("tien") || raw === "\u203a" || raw === ">") return "forward";
      if (title.includes("reload") || title.includes("lam moi") || raw === "\u21bb" || raw === "R") return "reload";
      return "";
    };

    const candidates = Array.from(document.querySelectorAll("button,div,[role='button']"))
      .map((element) => ({ element, rect: visibleRect(element), action: actionFor(element) }))
      .filter(({ rect, action }) => (
        rect &&
        action &&
        rect.left >= bounds.x - 32 &&
        rect.left <= bounds.x + 190 &&
        rect.top >= bounds.y - 72 &&
        rect.top <= bounds.y + 78 &&
        rect.width >= 16 &&
        rect.width <= 64 &&
        rect.height >= 16 &&
        rect.height <= 64
      ))
      .sort((a, b) => a.rect.left - b.rect.left);

    const byAction = new Map();
    for (const item of candidates) {
      if (!byAction.has(item.action)) byAction.set(item.action, item);
    }

    const navState = state.browser.lastState || {};
    const labels = { back: "Back", forward: "Forward", reload: "Reload" };
    const glyphs = { back: "\u2039", forward: "\u203a", reload: "\u21bb" };
    const navElements = ["back", "forward", "reload"]
      .map((action) => byAction.get(action)?.element)
      .filter(Boolean);
    const navParent = navElements[0]?.parentElement || null;
    const navParentRect = visibleRect(navParent);
    // Hide the design's built-in back/forward/reload group: navigation is now a single bridge-owned
    // back button (ensureServiceBackButton) parked next to the close (×) button. Forward + reload are
    // dropped per request.
    if (
      navParent &&
      navParentRect &&
      navParentRect.width <= 240 &&
      navParentRect.height <= 74 &&
      navElements.length >= 2 &&
      navElements.every((element) => element.parentElement === navParent)
    ) {
      navParent.dataset.centrixBrowserNavGroup = "1";
      // Do NOT display:none the group — the toolbar uses justify-content:space-between, so removing it
      // from the flex flow collapses the credit pills ("Số dư" / "Đang theo dõi credit") to the LEFT.
      // Keep it as a zero-width invisible spacer so the credit group stays pinned to the right, and
      // also force the toolbar row to right-align as a belt-and-suspenders.
      navParent.style.setProperty("display", "flex", "important");
      navParent.style.setProperty("width", "0", "important");
      navParent.style.setProperty("min-width", "0", "important");
      navParent.style.setProperty("padding", "0", "important");
      navParent.style.setProperty("margin", "0", "important");
      navParent.style.setProperty("border", "none", "important");
      navParent.style.setProperty("background", "transparent", "important");
      navParent.style.setProperty("box-shadow", "none", "important");
      navParent.style.setProperty("overflow", "hidden", "important");
      const toolbar = navParent.parentElement;
      if (toolbar) {
        if (/justify-content\s*:\s*(space-between|flex-start)/.test(toolbar.getAttribute("style") || "")) {
          toolbar.style.setProperty("justify-content", "flex-end", "important");
        }
        // Reserve room on the right for the bridge-owned ‹ × buttons (fixed at the frame edge) so the
        // credit pills sit just to their LEFT instead of underneath them.
        toolbar.style.setProperty("padding-right", "104px", "important");
      }
    }
    for (const action of ["back", "forward", "reload"]) {
      const element = byAction.get(action)?.element;
      if (!element) continue;
      // Drop any prior binding so a hidden design button can't still capture nav clicks.
      delete element.dataset.centrixBrowserNavAction;
      element.style.setProperty("display", "none", "important");
    }
    // Refresh the lone back button's enabled state whenever navigation state changes.
    ensureServiceBackButton();
  }

  async function runBrowserNav(action) {
    const bridge = api();
    if (!bridge?.browser) return;
    try {
      let browserState = null;
      if (action === "back") browserState = await bridge.browser.back?.();
      if (action === "forward") browserState = await bridge.browser.forward?.();
      if (action === "reload") browserState = await bridge.browser.reload?.();
      const fallbackState = bridge.browser.state ? await bridge.browser.state().catch(() => null) : null;
      state.browser.lastState = browserState || fallbackState || state.browser.lastState || null;
      publishState();
    } catch (error) {
      state.browser.error = error.message || String(error);
      showActionToast("Không thực hiện được thao tác, vui lòng thử lại", "error");
    }
    ensureBrowserNavToolbar();
    syncBrowserBoundsSoon();
  }

  function isStaticSidebarCollapsed() {
    const logic = staticLogic();
    return logic?.state?.collapsed === true;
  }

  function collapsedSidebarRight(items, topChromeBottom) {
    if (!isStaticSidebarCollapsed()) return 0;
    const rail = items
      .filter(({ rect }) => (
        rect.left <= 24 &&
        rect.top >= topChromeBottom - 6 &&
        rect.width >= 48 &&
        rect.width <= 96 &&
        rect.height >= Math.min(420, window.innerHeight - topChromeBottom - 120)
      ))
      .sort((a, b) => b.rect.height - a.rect.height)[0];
    return Math.round(rail?.rect.right || 66);
  }

  function polishCollapsedSidebar() {
    const collapsed = isStaticSidebarCollapsed();
    document.documentElement.dataset.centrixUserSidebarCollapsed = collapsed ? "1" : "0";
    disableStaticSidebarTransition();
    if (!collapsed) return;

    const items = Array.from(document.querySelectorAll("div,button,img,span"))
      .filter((element) => {
        const rect = visibleRect(element);
        if (!rect) return false;
        const text = fold(element.textContent || "");
        return (
          rect.left >= 0 &&
          rect.right <= 96 &&
          rect.width >= 28 &&
          rect.width <= 58 &&
          rect.height >= 28 &&
          rect.height <= 58 &&
          (text.length <= 2 || element.tagName === "IMG")
        );
      });

    for (const element of items) {
      element.style.setProperty("border-radius", "50%", "important");
      element.style.setProperty("overflow", "hidden", "important");
    }
  }

  function disableStaticSidebarTransition() {
    if (!state.browser.activeServiceId) return;
    const items = allLayoutRects();
    const topChromeBottom = findTopChromeBottom(items);
    const sidebar = findNativeSidebar(items, topChromeBottom);
    const collapsedRight = collapsedSidebarRight(items, topChromeBottom);
    const candidates = items
      .filter(({ rect, text }) => (
        rect.left <= 12 &&
        rect.top >= topChromeBottom - 8 &&
        rect.width >= 48 &&
        rect.width <= 360 &&
        rect.height >= Math.min(420, window.innerHeight - topChromeBottom - 120) &&
        (text.includes("centrix ai") || text.includes("dich vu") || rect.width <= 96)
      ))
      .sort((a, b) => b.rect.height - a.rect.height);
    const sidebarElement = sidebar?.el || candidates[0]?.el;
    if (sidebarElement) {
      sidebarElement.dataset.centrixInstantSidebar = "1";
      sidebarElement.style.setProperty("transition", "none", "important");
      sidebarElement.style.setProperty("will-change", "auto", "important");
      sidebarElement.style.setProperty("overflow", "hidden", "important");
    }
    if (collapsedRight && candidates[0]?.el) {
      candidates[0].el.style.setProperty("transition", "none", "important");
    }
  }

  function visibleRect(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) return null;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
    return rect;
  }

  function rectToBrowserBounds(rect) {
    const left = Math.max(0, Math.round(rect.left));
    const top = Math.max(0, Math.round(rect.top));
    const right = Math.min(window.innerWidth, Math.round(rect.right));
    const bottom = Math.min(window.innerHeight, Math.round(rect.bottom));
    return {
      x: left,
      y: top,
      width: Math.max(360, right - left),
      height: Math.max(320, bottom - top)
    };
  }

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

  function stableBounds(bounds) {
    if (!bounds) return bounds;
    if (sameBounds(bounds, lastSentBrowserBounds, 4)) return lastSentBrowserBounds;
    return bounds;
  }

  function cleanBrowserBounds(bounds) {
    if (!bounds || typeof bounds !== "object") return null;
    const x = Math.max(0, Math.round(Number(bounds.x) || 0));
    const y = Math.max(0, Math.round(Number(bounds.y) || 0));
    const width = Math.max(360, Math.round(Number(bounds.width) || 0));
    const height = Math.max(320, Math.round(Number(bounds.height) || 0));
    if (x >= window.innerWidth || y >= window.innerHeight) return null;
    return {
      x,
      y,
      width: Math.min(width, Math.max(360, window.innerWidth - x)),
      height: Math.min(height, Math.max(320, window.innerHeight - y))
    };
  }

  function activeBrowserStateBounds() {
    return cleanBrowserBounds(state.browser.lastState?.bounds || state.browser.bounds);
  }

  // The service CARD BODY (showRunning placeholder: "{service} đang chạy") is the SAME React element
  // for every service and sits BELOW the in-card header — anchoring the native view to it keeps the
  // header (‹ › ↻ + credit + close) visible and the rect identical across services.
  function findServiceCardBody() {
    // Match ONLY the RUNNING placeholder ("{service} đang chạy"). The opening branch has NO in-card
    // header, so its flex:1 div fills the whole main area (top ~y68) instead of the real body (top
    // ~y117, below the ‹›↻ header) — anchoring to it locked the native view to the wrong rect and
    // broke the layout on first open. We only lock bounds once the running card renders.
    // Fast path: the element tagged on a previous find — same node every call means zero drift and no
    // full-DOM text scan. Re-validate before trusting it (React may have recreated the subtree).
    // The card body ALWAYS sits right of the sidebar (min ~56px even collapsed). rect.left >= MIN_CARD_LEFT
    // rejects a transient full-width/corner element that also carries "đang chạy" (seen after alt-tab /
    // focus re-render): matching it locked the native view to x≈0 → the webview shrank into the top-left
    // corner (ChatGPT's login squeezed there) while the loader showed through the real card frame.
    const MIN_CARD_LEFT = 40;
    const tagged = document.querySelector('[data-centrix-service-card-body="1"]');
    if (tagged) {
      const rect = visibleRect(tagged);
      const text = fold(tagged.textContent || "");
      if (rect && rect.left >= MIN_CARD_LEFT && rect.width >= 360 && rect.height >= 200 && text.includes("dang chay") && !text.includes("dang theo doi credit")) {
        return { el: tagged, rect, text };
      }
      tagged.removeAttribute("data-centrix-service-card-body");
    }
    const found = allLayoutRects()
      .filter(({ rect, text }) => (
        rect.left >= MIN_CARD_LEFT &&            // never the top-left corner — the body is right of the sidebar
        rect.width >= 360 &&
        rect.height >= 200 &&
        text.includes("dang chay") &&            // "{service} đang chạy" lives only in the card body
        !text.includes("dang theo doi credit")   // exclude the card root (it also wraps the header)
      ))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0] || null;
    if (found?.el) found.el.setAttribute("data-centrix-service-card-body", "1");
    return found;
  }

  function measureServiceWorkbenchBounds() {
    const items = allLayoutRects();
    const topChromeBottom = findTopChromeBottom(items);
    const sidebar = findNativeSidebar(items, topChromeBottom);
    const collapsedRight = collapsedSidebarRight(items, topChromeBottom);
    const sidebarRight = Math.round(collapsedRight || sidebar?.rect.right || 330);
    const marked = document.querySelector("[data-centrix-main-workbench='1']");
    const candidates = Array.from(document.querySelectorAll("div,main,section"))
      .map((el) => {
        const rect = visibleRect(el);
        const computed = rect ? window.getComputedStyle(el) : null;
        const paddingLeft = computed ? parseFloat(computed.paddingLeft) || 0 : 0;
        const paddingRight = computed ? parseFloat(computed.paddingRight) || 0 : 0;
        const paddingTop = computed ? parseFloat(computed.paddingTop) || 0 : 0;
        const paddingBottom = computed ? parseFloat(computed.paddingBottom) || 0 : 0;
        return {
          el,
          rect,
          paddingLeft,
          paddingRight,
          paddingTop,
          paddingBottom,
          marked: el === marked
        };
      })
      .filter(({ rect, paddingLeft, paddingRight, paddingTop, paddingBottom, marked }) => (
        rect &&
        rect.left >= sidebarRight - 8 &&
        rect.top >= topChromeBottom - 8 &&
        rect.right <= window.innerWidth + 4 &&
        rect.bottom <= window.innerHeight + 4 &&
        rect.width >= 360 &&
        rect.height >= 320 &&
        (
          marked ||
          (paddingLeft + paddingRight + paddingTop + paddingBottom >= 32)
        )
      ))
      .sort((a, b) => {
        if (a.marked !== b.marked) return a.marked ? -1 : 1;
        const aArea = a.rect.width * a.rect.height;
        const bArea = b.rect.width * b.rect.height;
        return bArea - aArea;
      });
    const frame = candidates[0];
    if (!frame?.rect) return null;
    const left = frame.rect.left + frame.paddingLeft;
    const top = frame.rect.top + frame.paddingTop;
    const right = frame.rect.right - frame.paddingRight;
    const bottom = frame.rect.bottom - frame.paddingBottom;
    if (right - left < 360 || bottom - top < 320) return null;
    return rectToBrowserBounds({ left, top, right, bottom });
  }

  function allLayoutRects() {
    return Array.from(document.querySelectorAll("div,main,section,aside,nav"))
      .map((el) => ({ el, rect: visibleRect(el), text: fold(el.textContent || "") }))
      .filter((item) => item.rect);
  }

  function findTopChromeBottom(items) {
    const candidate = items
      .filter(({ rect, text }) => (
        rect.top <= 8 &&
        rect.height >= 42 &&
        rect.height <= 72 &&
        rect.width >= window.innerWidth * 0.75 &&
        (text.includes("file") || text.includes("edit") || text.includes("window") || text.includes("sang") || text.includes("toi"))
      ))
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
    return Math.round(candidate?.rect.bottom || 50);
  }

  function findNativeSidebar(items, topChromeBottom) {
    return items
      .filter(({ rect, text }) => (
        rect.left <= 24 &&
        rect.top >= topChromeBottom - 6 &&
        rect.width >= 56 &&
        rect.width <= 430 &&
        rect.height >= Math.min(440, window.innerHeight - topChromeBottom - 80) &&
        (
          text.includes("centrix ai") ||
          text.includes("dich vu") ||
          text.includes("nhat ky")
        )
      ))
      .map((item) => {
        const text = item.text;
        let score = item.rect.height;
        if (text.includes("dich vu")) score += 400;
        if (text.includes("nhat ky")) score += 400;
        if (text.includes("centrix ai")) score += 150;
        if (item.rect.width >= 240) score += 80;
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score)[0];
  }

  function findBrowserSurface(items, sidebarRight, topChromeBottom) {
    const activeName = fold(state.browser.activeServiceName || "");
    const keywords = ["webview", "request", "credit", "dang chay", "browser"];
    if (activeName) keywords.push(activeName);
    const minLeft = Math.max(56, sidebarRight - 8);
    const minTop = Math.max(45, topChromeBottom - 6);

    return items
      .filter(({ rect }) => (
        rect.left >= minLeft &&
        rect.top >= minTop &&
        rect.width >= 360 &&
        rect.height >= 320 &&
        rect.right <= window.innerWidth + 4 &&
        rect.bottom <= window.innerHeight + 4
      ))
      .map((item) => {
        const hitCount = keywords.reduce((total, keyword) => total + (keyword && item.text.includes(keyword) ? 1 : 0), 0);
        const area = item.rect.width * item.rect.height;
        let score = hitCount * 500 + Math.min(240, area / 12000);
        score += Math.max(0, 140 - Math.abs(item.rect.left - sidebarRight));
        if (item.rect.top > topChromeBottom + 36) score += Math.min(120, item.rect.top - topChromeBottom);
        if (!hitCount && item.rect.width > window.innerWidth * 0.9) score -= 200;
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score)[0];
  }

  function measureBrowserBounds() {
    // Native view fills the service CARD BODY ("{service} đang chạy"): same React element for every
    // service, sits below the in-card header. (Restored to the simple 17:30 logic — the Codex
    // markAppLayoutRegions/measureServiceWorkbenchBounds/data-centrix-browser-viewport layer left
    // the native view off the card body so only the placeholder showed.)
    if (state.browser.activeServiceId) {
      // Once locked, reuse the EXACT same rect for every service + every opening↔running transition
      // (re-measured only after resize/collapse invalidate it). This is what stops the tab-switch
      // jank: the native view never moves to a slightly different rect on switch.
      if (stableServiceBounds) {
        // Self-heal: if the (tagged) card body MOVED since we locked (late reflow after maximize,
        // theme switch, font load), re-lock onto its live rect instead of pinning the view off-frame.
        const live = findServiceCardBody();
        if (live?.rect && live.rect.width >= 360 && live.rect.height >= 200) {
          const liveBounds = rectToBrowserBounds(live.rect);
          if (!sameBounds(liveBounds, stableServiceBounds, 4)) stableServiceBounds = liveBounds;
        }
        return stableServiceBounds;
      }
      const cardBody = findServiceCardBody();
      if (cardBody?.rect && cardBody.rect.width >= 360 && cardBody.rect.height >= 200) {
        stableServiceBounds = rectToBrowserBounds(cardBody.rect);
        return stableServiceBounds;
      }
    }

    const explicitViewport = document.querySelector("#browserViewport,.browser-viewport");
    const explicitRect = visibleRect(explicitViewport);
    if (explicitRect && explicitRect.width >= 360 && explicitRect.height >= 320) {
      return rectToBrowserBounds(explicitRect);
    }

    const items = allLayoutRects();
    const topChromeBottom = findTopChromeBottom(items);
    const sidebar = findNativeSidebar(items, topChromeBottom);
    const collapsedRight = collapsedSidebarRight(items, topChromeBottom);
    const sidebarRight = Math.round(collapsedRight || sidebar?.rect.right || 330);
    const surface = findBrowserSurface(items, sidebarRight, topChromeBottom);
    if (surface?.rect) return rectToBrowserBounds(surface.rect);

    const left = Math.max(sidebarRight, 330);
    const top = Math.max(topChromeBottom, 50);
    return {
      x: left,
      y: top,
      width: Math.max(360, Math.round(window.innerWidth - left)),
      height: Math.max(320, Math.round(window.innerHeight - top))
    };
  }

  function nowMs() {
    return Number(window.performance?.now?.() || Date.now());
  }

  function waitForNextPaint(timeoutMs = 180) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      setTimeout(finish, timeoutMs);
      try {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      } catch {
        finish();
      }
    });
  }

  function waitForServiceLoadingNotice(startedAt, minMs = SERVICE_LOADING_MIN_VISIBLE_MS) {
    const remaining = Math.max(0, minMs - (nowMs() - Number(startedAt || 0)));
    return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
  }

  function shouldHoldMeasuredBounds(bounds) {
    if (!pendingPredictedBrowserBounds) return false;
    if (nowMs() > pendingPredictedBrowserBounds.until) {
      pendingPredictedBrowserBounds = null;
      return false;
    }
    const target = pendingPredictedBrowserBounds.bounds;
    if (Math.abs(bounds.x - target.x) <= 4 && Math.abs(bounds.width - target.width) <= 8) {
      pendingPredictedBrowserBounds = null;
      return false;
    }
    return true;
  }

  function sendBrowserBounds(bounds, options = {}) {
    if (!state.browser.activeServiceId) return;
    const bridge = api();
    if (!bridge?.browser?.setBounds) return;
    // BACKSTOP (catches ANY upstream mis-measure): the service view is always right of the sidebar + below
    // the top chrome. A rect jammed into the top-left corner (x≈0 / y≈0) is never legitimate — keep the last
    // good bounds instead of teleporting the native view over the sidebar. This is what made "alt-tab away
    // then back" show ChatGPT's login squeezed in the corner + the loader in the empty frame.
    if ((bounds.x < 40 || bounds.y < 30) && lastSentBrowserBounds && lastSentBrowserBounds.x >= 40 && lastSentBrowserBounds.y >= 30) {
      return lastSentBrowserBounds;
    }
    if (!options.force && shouldHoldMeasuredBounds(bounds)) return bounds;
    const nextBounds = options.force ? bounds : stableBounds(bounds);
    if (!sameBounds(nextBounds, lastSentBrowserBounds, 4)) {
      lastSentBrowserBounds = nextBounds;
      bridge.browser.setBounds(nextBounds).catch(() => {});
    }
    return nextBounds;
  }

  // Replace the design's showRunning card-body placeholder (the marketing blurb + the demo "Mô phỏng 1
  // request · −1 credit" button + fake "Số dư còn N cr") with a neutral "Đang nạp dữ liệu…" loader. The
  // native webview covers this card once the service is loaded; in any gap (loading / detach / resize) the
  // user now sees a clean loading state instead of the fake demo. A hidden "{service} đang chạy" span is
  // kept so findServiceCardBody's anchor-text match (and the webview anchoring) still works.
  function patchServiceCard() {
    if (!state.browser.activeServiceId) return;
    const found = findServiceCardBody();
    const body = found && found.el;
    if (!body) return;
    if (body.querySelector("[data-cx-svc-loader]")) return; // already ours — idempotent, don't fight ourselves
    const name = state.browser.activeServiceName || state.browser.activeServiceId || "Dịch vụ";
    const initial = serviceInitial(name);
    body.innerHTML =
      `<span aria-hidden="true" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;clip:rect(0 0 0 0);">${escapeHtml(name)} đang chạy</span>`
      + `<div data-cx-svc-loader="1" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:16px;width:100%;">`
      +   `<div style="width:56px;height:56px;border-radius:16px;background:#1e93f5;display:flex;align-items:center;justify-content:center;color:#fff;font:800 22px Segoe UI,system-ui,sans-serif;box-shadow:0 10px 26px rgba(30,147,245,.28);">${escapeHtml(initial)}</div>`
      +   `<div style="display:inline-flex;align-items:center;gap:10px;font:700 14.5px Segoe UI,system-ui,sans-serif;color:#0b7bdd;">`
      +     `<span style="width:16px;height:16px;border:2px solid rgba(30,147,245,.28);border-top-color:#1e93f5;border-radius:50%;animation:cxSpin .8s linear infinite;"></span>Đang nạp dữ liệu…`
      +   `</div>`
      + `</div>`;
  }

  function syncBrowserBoundsInstant() {
    if (!state.browser.activeServiceId) return;
    const bounds = sendBrowserBounds(measureBrowserBounds());
    ensureServiceLoadingOverlay();
    patchServiceCard();
    ensureServiceCloseButton();
    ensureBrowserCornerMasks();
    ensureBrowserNavToolbar();
    polishCollapsedSidebar();
    return bounds;
  }

  function syncBrowserBoundsForCollapsed(nextCollapsed, previousCollapsed) {
    if (!state.browser.activeServiceId || nextCollapsed === previousCollapsed) return;
    const current = measureBrowserBounds();
    const items = allLayoutRects();
    const topChromeBottom = findTopChromeBottom(items);
    const sidebar = findNativeSidebar(items, topChromeBottom);
    const currentSidebarWidth = previousCollapsed
      ? Math.max(48, collapsedSidebarRight(items, topChromeBottom) || 66)
      : Math.max(240, Math.round(sidebar?.rect.width || 330));
    const nextSidebarWidth = nextCollapsed ? 66 : Math.max(240, Math.round(sidebar?.rect.width || 330));
    const delta = nextSidebarWidth - currentSidebarWidth;
    if (!delta) return syncBrowserBoundsInstant();
    const predicted = {
      x: Math.max(0, current.x + delta),
      y: current.y,
      width: Math.max(360, current.width - delta),
      height: current.height
    };
    pendingPredictedBrowserBounds = {
      bounds: predicted,
      until: nowMs() + 120
    };
    sendBrowserBounds(predicted, { force: true });
    return predicted;
  }

  function syncBrowserBoundsSoon() {
    if (!state.browser.activeServiceId) return;
    cancelAnimationFrame(boundsFrame);
    boundsFrame = requestAnimationFrame(() => {
      syncBrowserBoundsInstant();
    });
  }

  async function syncBrowserBoundsNow() {
    const bridge = api();
    if (!bridge?.browser?.setBounds) return measureBrowserBounds();
    const bounds = stableBounds(measureBrowserBounds());
    if (!sameBounds(bounds, lastSentBrowserBounds, 4)) {
      lastSentBrowserBounds = bounds;
      await bridge.browser.setBounds(bounds).catch(() => null);
    }
    ensureServiceCloseButton();
    ensureBrowserCornerMasks();
    ensureBrowserNavToolbar();
    polishCollapsedSidebar();
    return bounds;
  }

  function syncBrowserBoundsBurst(forceRemeasure = false) {
    if (!state.browser.activeServiceId) return;
    cancelAnimationFrame(boundsFrame);
    const tick = () => {
      // On collapse/expand the card body (and thus the native view rect) genuinely moves, so drop the
      // locked bounds and re-read the LIVE card body each time — otherwise measureBrowserBounds keeps
      // returning the rect captured BEFORE the sidebar settled and the native view sticks half over the
      // sidebar. (On a plain tab switch we keep the lock to avoid sub-pixel jank.)
      if (forceRemeasure) stableServiceBounds = null;
      syncBrowserBoundsInstant();
    };
    tick();
    queueMicrotask(tick);
    requestAnimationFrame(() => {
      tick();
      requestAnimationFrame(tick);
    });
    if (forceRemeasure) {
      // Past the 120ms prediction-hold window: re-lock onto the SETTLED layout after the sidebar
      // finishes its collapse/expand animation, so the native view never sticks at the predicted
      // (approximate) position.
      for (const delayMs of [150, 320, 520]) setTimeout(tick, delayMs);
    }
  }

  function isRememberLoginOn() {
    return localStorage.getItem(REMEMBER_LOGIN_KEY) === "1"; // opt-IN (default OFF)
  }

  function loadSavedLogin() {
    try {
      const raw = JSON.parse(localStorage.getItem(SAVED_LOGIN_KEY) || "null");
      if (raw && typeof raw === "object" && raw.email
        && !LOGIN_SAMPLE_VALUES.has(String(raw.email).trim().toLowerCase())) {
        // One-time migration: scrub any plaintext password an older build wrote here.
        if ("password" in raw) {
          try { localStorage.setItem(SAVED_LOGIN_KEY, JSON.stringify({ email: String(raw.email) })); } catch { /* ignore */ }
        }
        // Skip the design's sample account so it never pre-fills back as "the saved login".
        return { email: String(raw.email) };
      }
    } catch { /* ignore */ }
    return null;
  }

  function saveLastLogin(email) {
    try {
      const isSample = LOGIN_SAMPLE_VALUES.has(String(email || "").trim().toLowerCase());
      if (isRememberLoginOn() && email && !isSample) {
        // Email only — the password is never persisted to disk (renderer localStorage = leveldb).
        localStorage.setItem(SAVED_LOGIN_KEY, JSON.stringify({ email }));
      } else if (!isRememberLoginOn()) {
        localStorage.removeItem(SAVED_LOGIN_KEY);
      }
    } catch { /* ignore */ }
  }

  // Locate the VISIBLE login email + password inputs. The design ships several password fields (login +
  // sign-up screens); filtering to visible ones avoids grabbing a hidden field on another screen.
  function loginCredInputs() {
    const inputs = Array.from(document.querySelectorAll("input"))
      .filter((input) => input.type !== "checkbox" && input.type !== "hidden" && visibleRect(input));
    const passwordInput = inputs.find((input) => input.type === "password") || null;
    const emailInput = inputs.find((input) => (
      input !== passwordInput &&
      (input.type === "email" || /@/.test(String(input.value || input.getAttribute("defaultvalue") || "")))
    )) || inputs.find((input) => input !== passwordInput) || null;
    return { emailInput, passwordInput };
  }

  // ── GOOGLE-ONLY: ẩn UI đăng nhập email/mật khẩu (đăng nhập mật khẩu ĐÃ GỠ — chỉ còn Google) ─────────
  // Ẩn ô email + ô mật khẩu + nút "Đăng nhập" + "Quên mật khẩu" + "Ghi nhớ" trên MÀN LOGIN; giữ nút
  // Google + thương hiệu → màn login chỉ còn đăng nhập Google. (Đây là trạng thái CHÍNH THỨC, không phải
  // tạm: client đã bỏ hẳn luồng password — xem loginWithAccount/loginApiRequest/loginFromStaticForm.)
  const HIDE_LOGIN_CREDS = true;
  // Hide an email/password field by climbing to its field wrapper — but NEVER into a container that also
  // holds the Google button or the Terms (so those ALWAYS stay visible). Fixes over-hiding the whole form.
  function hideLoginField(input) {
    if (!input) return;
    let el = input;
    for (let i = 0; i < 3 && el.parentElement; i += 1) {
      const pt = fold(el.parentElement.textContent || "");
      if (pt.includes("dang nhap bang google") || pt.includes("tiep tuc voi google") || pt.includes("dieu khoan") || pt.includes("chinh sach bao mat")) break;
      el = el.parentElement;
    }
    if (el && el.style.display !== "none") { el.dataset.cxAuthHidden = "1"; el.style.display = "none"; }
  }
  // ── Login-hero orbit ─────────────────────────────────────────────────────────────────────────────
  // The login card's hero draws a "constellation" of FAKE letter-tiles on a <canvas>. Replace it with a
  // clean DOM orbit of the 12 REAL service logos (recognizable brand glyphs, white on brand colour) circling
  // the CentriX logo. We hide the canvas and inject our own ring; self-heals if the design re-renders.
  const CX_HERO_LOGOS = [
    { bg: "#10a37f", svg: '<path fill="#fff" d="M16.9 9.9a3.4 3.4 0 0 0-.3-2.8 3.5 3.5 0 0 0-3.7-1.65 3.4 3.4 0 0 0-2.6-1.15 3.5 3.5 0 0 0-3.3 2.35 3.4 3.4 0 0 0-2.2 1.6 3.5 3.5 0 0 0 .4 4.1 3.4 3.4 0 0 0 .3 2.8 3.5 3.5 0 0 0 3.7 1.65 3.4 3.4 0 0 0 2.6 1.15 3.5 3.5 0 0 0 3.3-2.35 3.4 3.4 0 0 0 2.2-1.6 3.5 3.5 0 0 0-.4-4.1Zm-4.9 6.9a2.6 2.6 0 0 1-1.65-.6l3.9-2.25a.63.63 0 0 0 .32-.55V8.2l1.15.66v3.9a2.6 2.6 0 0 1-3.72 4Zm-5.6-2.4a2.6 2.6 0 0 1-.3-1.75l3.9 2.25a.63.63 0 0 0 .64 0l4.42-2.55v1.32l-3.94 2.28a2.6 2.6 0 0 1-4.72-1.55Zm-.72-6a2.6 2.6 0 0 1 1.35-1.14v4.62a.63.63 0 0 0 .32.55l4.42 2.55-1.15.66-3.94-2.27a2.6 2.6 0 0 1-1-4.97Zm9.9 2.3L11.16 8.4 12.3 7.74l3.94 2.27a2.6 2.6 0 0 1-.4 4.7v-4.62a.63.63 0 0 0-.32-.55ZM16.68 8.9l-3.9-2.25a.63.63 0 0 0-.64 0L7.72 9.2V7.88l3.94-2.27a2.6 2.6 0 0 1 3.86 2.7ZM7.1 11.5l-1.15-.66V6.94a2.6 2.6 0 0 1 4.26-2l-3.9 2.25a.63.63 0 0 0-.32.55l.01 3.76Zm.62-1.35L9.68 9l1.76 1.02v2.28L9.68 13.3 7.72 12.15v-2Z"/>' },
    { bg: "#d97757", svg: '<path fill="#fff" d="M12 3.5l1.4 4.6L18 6.8l-2.9 3.7 4.6 1.5-4.6 1.5 2.9 3.7-4.6-1.3L12 20.5l-1.4-4.6L6 17.2l2.9-3.7L4.3 12l4.6-1.5L6 6.8l4.6 1.3z"/>' },
    { bg: "#1a73e8", svg: '<path fill="#fff" d="M12 2.5c.3 4.9 4.1 8.7 9 9-4.9.3-8.7 4.1-9 9-.3-4.9-4.1-8.7-9-9 4.9-.3 8.7-4.1 9-9z"/>' },
    { bg: "#20b8cd", svg: '<g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14"/><path d="M12 8.5L6 5v6.5l6 3.5 6-3.5V5l-6 3.5z"/><path d="M6 11.5V18l6-3.5M18 11.5V18l-6-3.5"/></g>' },
    { bg: "#0a7ed9", svg: '<path fill="#fff" d="M8.2 6c1.7 0 2.6 1 3.1 2.5.6 1.8 1.1 2.8 2.6 2.8 1.2 0 2-.8 2.3-1.9.4 0 .8.1 1.1.3-.4 2.4-1.9 4-4.1 4-1.9 0-2.9-1.1-3.5-2.9-.5-1.6-1-2.4-2.2-2.4-1.1 0-1.9.8-2.2 1.9-.4 0-.8-.1-1.1-.3C6.9 7.6 8 6 8.2 6z"/>' },
    { bg: "#111111", svg: '<g fill="#fff"><path d="M14.6 5.8h2.6L9.9 18.2H7.3z"/><path d="M17.2 18.2h-2.6l-2.05-3.45 1.3-2.2z"/></g>' },
    { bg: "#4d6bfe", svg: '<path fill="#fff" d="M4.5 9c2.2-.2 3.8.6 4.9 2.1.9 1.2 2 1.9 3.6 1.9 1.3 0 2-.5 2.6-1.2.2-.9-.1-1.7-.6-2.2.6.1 1.3.5 1.8 1.1 1 1.2.9 3-.3 4-.9.8-2.2 1.1-3.8 1.1-2.6 0-4.3-1.1-5.4-2.6-.9-1.2-1.7-1.7-2.7-1.7L4.5 9zM15.7 8.2a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>' },
    { bg: "#fa520f", svg: '<g fill="#fff"><rect x="4" y="6" width="3.4" height="3.4"/><rect x="16.6" y="6" width="3.4" height="3.4"/><rect x="4" y="10.3" width="3.4" height="3.4"/><rect x="8.3" y="10.3" width="3.4" height="3.4"/><rect x="12.3" y="10.3" width="3.4" height="3.4"/><rect x="16.6" y="10.3" width="3.4" height="3.4"/><rect x="4" y="14.6" width="3.4" height="3.4"/><rect x="16.6" y="14.6" width="3.4" height="3.4"/></g>' },
    { bg: "#2b2f3b", svg: '<g fill="#fff"><path d="M11.3 5.4v9.1H5.1c1-3.6 3.1-6.8 6.2-9.1z"/><path d="M12.7 7.3c1.9 2 3.3 4.4 4.2 7.2h-4.2z"/><path d="M4 16h16c-.6 1.1-2.5 2.4-8 2.4S4.6 17.1 4 16z"/></g>' },
    { bg: "#5a4ee0", svg: '<path fill="#fff" d="M8 5h4.2c2.5 0 4.3 1.6 4.3 4s-1.8 4-4.3 4H10.3V19H8V5zm2.3 2v4h1.9c1.2 0 2-.8 2-2s-.8-2-2-2h-1.9z"/>' },
    { bg: "#d96570", svg: '<g fill="#fff"><path d="M12 4.5c.4 2.6 1.9 4.1 4.5 4.5-2.6.4-4.1 1.9-4.5 4.5-.4-2.6-1.9-4.1-4.5-4.5 2.6-.4 4.1-1.9 4.5-4.5z"/><path d="M16.8 14.2c.2 1.3 1 2.1 2.2 2.3-1.2.2-2 1-2.2 2.3-.2-1.3-1-2.1-2.2-2.3 1.2-.2 2-1 2.2-2.3z"/></g>' },
    { bg: "#111111", svg: '<g fill="#fff"><rect x="7.5" y="6" width="3" height="12" rx="1.2"/><rect x="13.5" y="6" width="3" height="12" rx="1.2"/></g>' }
  ];
  function ensureCxOrbitStyle() {
    if (document.getElementById("cx-orbit-style")) return;
    const st = document.createElement("style");
    st.id = "cx-orbit-style";
    st.textContent = "@keyframes cxHeroFloat{0%,100%{transform:translate(0,0)}50%{transform:translate(0,-5px)}}@keyframes cxHeroDash{to{stroke-dashoffset:-24}}";
    (document.head || document.documentElement).appendChild(st);
  }
  function patchLoginHero() {
    if (!document.body) return;
    const canvas = document.querySelector("canvas");
    if (!canvas || canvas.style.display === "none") return;   // no hero canvas, or already replaced
    const stage = canvas.parentElement;
    if (!stage || stage.querySelector("[data-cx-orbit]")) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 80) return;         // not laid out / too small
    if (!stage.querySelector("img")) return;                  // the hero stage carries the centre CentriX logo <img>
    ensureCxOrbitStyle();
    canvas.style.display = "none";                            // kill the fake letter-constellation
    const w = Math.round(rect.width), h = Math.round(rect.height);
    const cx = w / 2, cy = h / 2;
    const size = Math.min(w, h);
    const maxR = size * 0.46;
    const nsz = Math.max(20, Math.round(size * 0.155));
    const glyph = Math.round(nsz * 0.6);
    // Scattered "constellation" (NOT a rotating ring): each real logo sits at a fixed angle + radius, with
    // per-node angle jitter and a big radius spread so it reads as an organic network, not a circle. Nodes
    // gently float (staggered) and the dashed links flow toward the centre — a subtle "alive" motion.
    const ANG_JITTER = [7, -11, 5, -8, 10, -5, 8, -10, 6, -7, 4, -6];
    const RAD_FRAC = [0.82, 0.54, 0.95, 0.6, 0.86, 0.5, 0.9, 0.58, 0.8, 0.66, 0.97, 0.52];
    let lines = "", nodes = "";
    const n = CX_HERO_LOGOS.length;
    CX_HERO_LOGOS.forEach((L, i) => {
      const ang = ((i * 360 / n) + ANG_JITTER[i % ANG_JITTER.length]) * Math.PI / 180 - Math.PI / 2;
      const r = maxR * RAD_FRAC[i % RAD_FRAC.length];
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      const nx = (cx + x).toFixed(1), ny = (cy + y).toFixed(1);
      const dur = (3.4 + (i % 4) * 0.55).toFixed(2), delay = (-(i * 0.41)).toFixed(2);
      const dash = (2.6 + (i % 5) * 0.22).toFixed(2);
      lines += `<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="var(--brand-border,#bfe0fc)" stroke-width="1" stroke-dasharray="3 5" opacity=".55" style="animation:cxHeroDash ${dash}s linear infinite;"></line>`;
      nodes += `<div style="position:absolute;left:${nx}px;top:${ny}px;width:${nsz}px;height:${nsz}px;margin:${-nsz / 2}px 0 0 ${-nsz / 2}px;border-radius:${Math.round(nsz * 0.28)}px;background:${L.bg};display:flex;align-items:center;justify-content:center;box-shadow:0 5px 13px rgba(15,23,42,.16);animation:cxHeroFloat ${dur}s ease-in-out ${delay}s infinite;"><svg width="${glyph}" height="${glyph}" viewBox="0 0 24 24">${L.svg}</svg></div>`;
    });
    const wrap = document.createElement("div");
    wrap.setAttribute("data-cx-orbit", "1");
    wrap.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:1;overflow:visible;";
    wrap.innerHTML =
      `<svg style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${lines}</svg>`
      + nodes;
    stage.appendChild(wrap);
  }

  // ── Login form: brand badge + subtitle + REAL Google logo button ──────────────────────────────────
  // The design's right-hand login panel shows a left-aligned "Chào mừng đến với CentriX AI" heading and a
  // Google button with a FAKE mono "G". Reshape it to the approved mockup: a centred column with the CentriX
  // brand badge on top, a product subtitle, and a WHITE "Tiếp tục với Google" button carrying the REAL
  // 4-colour Google logo. Idempotent + self-healing (re-applies if the design re-renders).
  const CX_GOOGLE_LOGO =
    '<svg width="19" height="19" viewBox="0 0 48 48" aria-hidden="true" style="display:block;flex-shrink:0;">' +
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  const CX_BRAND_BADGE =
    '<span style="width:56px;height:56px;border-radius:16px;background:linear-gradient(150deg,var(--brand,#1e93f5),var(--brand-strong,#0b7bdd));display:flex;align-items:center;justify-content:center;box-shadow:0 10px 24px var(--brand-shadow,rgba(30,147,245,.3));">' +
    '<svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="#fff" d="M12 2.6c.5 3.4 2.9 5.8 6.3 6.3-3.4.5-5.8 2.9-6.3 6.3-.5-3.4-2.9-5.8-6.3-6.3 3.4-.5 5.8-2.9 6.3-6.3z"/>' +
    '<path fill="#fff" d="M18 14.4c.25 1.5 1.3 2.55 2.8 2.8-1.5.25-2.55 1.3-2.8 2.8-.25-1.5-1.3-2.55-2.8-2.8 1.5-.25 2.55-1.3 2.8-2.8z"/></svg></span>';
  function patchLoginForm() {
    if (!document.body) return;
    // Detect the login screen WITHOUT loginScreenShowing(): that helper needs a visible password field +
    // "Đăng nhập" submit button, but hideLoginCredUI() (runs just before us in the same tick) already hid
    // both on this Google-only screen, so it returns false and we'd never fire. Instead: find the LOGIN
    // Google button (text has "google" AND "dang nhap"/"tiep tuc" — NOT the account tab's "Quản lý trên
    // Google") and require the "Chào mừng" heading to sit in its column. That pair is unique to login.
    let gBtn = null;
    for (const el of document.querySelectorAll('button,[role="button"]')) {
      if (!visibleRect(el)) continue;
      const t = fold(el.textContent || "");
      if (t.includes("google") && (t.includes("dang nhap") || t.includes("tiep tuc"))) { gBtn = el; break; }
    }
    if (!gBtn) return;
    // Climb from the button to the column whose DIRECT child is the welcome heading (robust vs the heading
    // stretching to the column's width — narrowestDivWith would tie and return the column itself). If no
    // such heading is found, we're not on the login screen → bail before touching anything.
    let col = gBtn.parentElement, heading = null;
    for (let i = 0; i < 5 && col; i += 1) {
      heading = Array.from(col.children).find((ch) => ch.tagName === "DIV" && fold(ch.textContent || "").includes("chao mung den voi"));
      if (heading) break;
      col = col.parentElement;
    }
    if (!col || !heading) return;
    // 1) The Google sign-in button → real 4-colour logo, "Tiếp tục với Google", white pill.
    if (gBtn.dataset.cxGoogleReal !== "1") {
      gBtn.dataset.cxGoogleReal = "1";
      gBtn.innerHTML = CX_GOOGLE_LOGO + '<span>Tiếp tục với Google</span>';
      gBtn.style.background = "#ffffff";
      gBtn.style.color = "#1f2937";
      gBtn.style.border = "1px solid #dadce0";
      gBtn.style.boxShadow = "0 1px 2px rgba(15,23,42,.08)";
      gBtn.style.fontWeight = "600";
      gBtn.style.gap = "11px";
    }
    // 2) Heading → centred, with the CentriX brand badge above + product subtitle below (inserted once).
    if (col.querySelector("[data-cx-login-badge]")) return;
    col.style.alignItems = "center";
    col.style.textAlign = "center";
    heading.style.width = "100%";
    heading.style.textAlign = "center";
    heading.style.marginBottom = "10px";
    const badge = document.createElement("div");
    badge.setAttribute("data-cx-login-badge", "1");
    badge.style.cssText = "display:flex;justify-content:center;margin-bottom:18px;";
    badge.innerHTML = CX_BRAND_BADGE;
    col.insertBefore(badge, heading);
    if (!col.querySelector("[data-cx-login-sub]")) {
      const sub = document.createElement("div");
      sub.setAttribute("data-cx-login-sub", "1");
      sub.style.cssText = "font-size:13px;color:var(--text-2);line-height:1.6;max-width:330px;margin:0 auto 24px;";
      sub.textContent = "AI workspace cho người dùng chuyên nghiệp: gom nhiều model, nhiều file và nhiều workflow vào một desktop app duy nhất.";
      heading.insertAdjacentElement("afterend", sub);
    }
  }

  function hideLoginCredUI() {
    if (!HIDE_LOGIN_CREDS || !document.body || !loginScreenShowing()) return;
    const { emailInput, passwordInput } = loginCredInputs();
    hideLoginField(emailInput);
    hideLoginField(passwordInput);
    // Hide ONLY the password "Đăng nhập" button + "Quên mật khẩu". KEEP the Google button + Terms checkbox
    // (the Terms checkbox is the only checkbox on the login screen — do NOT hide it).
    for (const el of document.querySelectorAll('button,[role="button"],a')) {
      if (!visibleRect(el) || el.closest("[data-cx-auth-hidden]")) continue;
      const t = fold(el.textContent || "").trim();
      if (t === "dang nhap" || t.startsWith("quen mat khau")) { el.dataset.cxAuthHidden = "1"; el.style.display = "none"; }
    }
  }

  // ── "Đổi mật khẩu" (change password) on the account tab ──────────────────────────────────────────
  // The 3-field form lives in the minified static template; we wire it at runtime. The card heading is
  // "Đổi mật khẩu" (folds to "doi mat khau"); the submit button text is "Cập nhật mật khẩu".
  function changePwCard() {
    let el = narrowestDivWith("doi mat khau");
    while (el && el.querySelectorAll('input[type="password"]').length < 3) el = el.parentElement;
    return el && el.querySelectorAll('input[type="password"]').length >= 3 ? el : null;
  }
  function changePwInputs() {
    const card = changePwCard();
    if (!card) return null;
    const pw = Array.from(card.querySelectorAll('input[type="password"]')).filter(visibleRect);
    if (pw.length < 3) return null;
    // Prefer label/placeholder mapping; fall back to DOM order [current, new, confirm].
    const roleOf = (input) => {
      const ph = fold(input.getAttribute("placeholder") || "");
      if (ph.includes("toi thieu")) return "new"; // the NEW field is the only one with a placeholder
      const around = fold((input.previousElementSibling?.textContent || "") + " " + (input.parentElement?.textContent || ""));
      if (around.includes("mat khau hien tai")) return "current";
      if (around.includes("nhap lai")) return "confirm";
      if (around.includes("mat khau moi")) return "new";
      return null;
    };
    let current = null, next = null, confirm = null;
    for (const input of pw) {
      const role = roleOf(input);
      if (role === "current" && !current) current = input;
      else if (role === "new" && !next) next = input;
      else if (role === "confirm" && !confirm) confirm = input;
    }
    if (!current) current = pw[0];
    if (!next) next = pw.find((i) => i !== current) || pw[1];
    if (!confirm) confirm = pw.find((i) => i !== current && i !== next) || pw[2];
    if (!current || !next || !confirm) return null;
    return { current, next, confirm, card };
  }

  // Apply our intended value to a login field WITHOUT fighting the user: skip if focused (typing), and
  // only overwrite when the field is empty or still holds the design's sample placeholder.
  function applyLoginValue(input, value) {
    if (!input || input === document.activeElement) return;
    const current = String(input.value || "");
    if (current === value) return;
    if (current && !LOGIN_SAMPLE_VALUES.has(current.trim().toLowerCase())) return;
    input.value = value;
    input.defaultValue = value;
  }

  // Keep the login form showing the saved/typed account (never the design's sample) + the remember box.
  function prefillLoginForm() {
    // Only touch the LOGIN screen. Guarding on loginScreenShowing() (a real type=password field is laid
    // out) — not just state.loginOk — stops the prefill + the "Lưu tài khoản" checkbox from latching onto
    // the app screen's "Tìm kiếm dịch vụ" box when loginOk momentarily flaps false after login.
    if (state.loginOk || !loginScreenShowing()) {
      document.querySelectorAll("[data-cx-remember-row]").forEach((row) => row.remove());
      return;
    }
    const { emailInput, passwordInput } = loginCredInputs();
    // The generated design hard-codes readonly="{{ true }}" on the login inputs (it's a display-only
    // mockup), so the user can't type a new account. Make them editable.
    for (const input of [emailInput, passwordInput]) {
      if (!input) continue;
      if (input.readOnly || input.hasAttribute("readonly")) {
        input.readOnly = false;
        input.removeAttribute("readonly");
      }
    }
    applyLoginValue(emailInput, state.loginDraft.email || "");
    applyLoginValue(passwordInput, state.loginDraft.password || "");
    ensureRememberCheckbox(passwordInput);
  }

  function ensureRememberCheckbox(anchorInput) {
    // Anchor ONLY to the real login password field — never a stray text/search input.
    if (!anchorInput || anchorInput.type !== "password" || document.getElementById("centrix-remember-login")) return;
    const container = anchorInput.closest("label, div") || anchorInput.parentElement;
    if (!container?.parentElement) return;
    const row = document.createElement("label");
    row.setAttribute("data-cx-remember-row", "1");
    // Match the design's own "Tôi đồng ý…" terms checkbox EXACTLY (same size, weight, colour, accent and
    // alignment) so the two checkbox rows look identical, with a 14px rhythm between password and button.
    row.style.cssText = "display:flex;align-items:flex-start;gap:9px;margin:0 0 14px;font-size:12.5px;line-height:1.5;color:var(--text-2);cursor:pointer;user-select:none;";
    row.innerHTML = '<input id="centrix-remember-login" type="checkbox" style="width:16px;height:16px;cursor:pointer;margin-top:1px;flex-shrink:0;accent-color:var(--brand);"><span>Lưu tài khoản (chỉ email)</span>';
    container.parentElement.insertBefore(row, container.nextSibling);
    const checkbox = row.querySelector("#centrix-remember-login");
    checkbox.checked = isRememberLoginOn();
    checkbox.addEventListener("change", () => {
      localStorage.setItem(REMEMBER_LOGIN_KEY, checkbox.checked ? "1" : "0");
      if (!checkbox.checked) {
        try { localStorage.removeItem(SAVED_LOGIN_KEY); } catch { /* ignore */ }
      }
    });
  }

  function inputValues() {
    hydrateStaticDefaults();
    // Prefer what the user actually typed (captured into loginDraft by the input listener) — the design
    // ships several email/password inputs, so reading "an" input can pick the wrong one. Fall back to
    // the visible fields only when the draft is empty.
    const { emailInput, passwordInput } = loginCredInputs();
    const email = String(state.loginDraft?.email || "").trim() || cleanTemplateValue(emailInput?.value);
    return { email, password: "" }; // Google-only client — never carry a password
  }

  async function loadActivityHistory() {
    const bridge = api();
    if (!bridge?.activity?.list) return;
    const result = await bridge.activity.list({ limit: 400 }).catch(() => null);
    // Only real PAGE-VISIT actions belong in the usage history (skip storage/cache sync noise).
    const URL_HISTORY_ACTIONS = new Set(["open-service", "navigate", "navigate-in-page", "page-loaded"]);
    const rows = (Array.isArray(result?.activity) ? result.activity : [])
      .filter((row) => row?.url && URL_HISTORY_ACTIONS.has(row.action));
    if (!rows.length) return;
    setUrlHistory(rows, { merge: true });
    refreshStaticUrlLogSoon();
  }

  let activityRefreshTimer = 0;
  function scheduleActivityHistoryRefresh(delayMs = 350) {
    clearTimeout(activityRefreshTimer);
    activityRefreshTimer = setTimeout(() => {
      loadActivityHistory()
        .then(() => {
          patchStaticUrlLog();
          refreshStaticUrlLogSoon();
        })
        .catch(() => {});
    }, delayMs);
  }

  async function refreshAccountState() {
    const bridge = api();
    if (!bridge) return null;
    if (state.loggedOut) { state.account = null; state.portal = null; state.loginOk = false; publishState(); return null; }
    const [account, portal, planTier] = await Promise.all([
      bridge.account?.me?.().catch(() => null),
      bridge.portal?.summary?.().catch(() => null),
      bridge.portal?.planMe?.({}).catch(() => null)
    ]);
    if (account) { state.account = account; saveCreditCache(account); }
    if (portal) { state.portal = portal; state.portalReady = true; }
    if (planTier && planTier.ok !== false) { state.planTier = planTier; lastPlanSyncAt = Date.now(); enforcePlanOnOpenService(); }  // re-sync plan cards + close a now-blocked open service
    // Org-admin: pull the full org roster + fund for the injected admin panel (best-effort).
    try {
      const oid = currentOrgId();
      if (oid && isOrgAdmin()) {
        const os = await bridge.portal?.orgStructure?.({ orgId: oid });
        state.orgStructure = (os && os.ok !== false) ? os : null;
      } else {
        state.orgStructure = null;
      }
    } catch { state.orgStructure = null; }
    state.loginOk = Boolean(state.account?.ok || state.account?.account || state.account?.email || state.portal?.wallet || state.portal?.packages);
    if (state.loginOk) wasEverLoggedIn = true;
    state.updatedAt = new Date().toISOString();
    publishState();
    patchStaticUrlLog();
    refreshStaticUrlLogSoon();
    patchVisibleCreditTextsSoon();
    return { account, portal };
  }

  let accountRefreshTimer = 0;
  function scheduleAccountStateRefresh(delayMs = 250) {
    clearTimeout(accountRefreshTimer);
    accountRefreshTimer = setTimeout(() => {
      refreshAccountState().catch(() => {});
    }, delayMs);
  }

  // ── Live credit-balance: instant value + smooth highlight ───────────────────────────────────────
  // The service-header watch pill ("Số dư · <b>{{ pBalFmt }}</b> cr") is data-bound, so the
  // creditRevision re-render below already swaps in the new number. These helpers make it bullet-proof
  // and smooth: (1) snapCreditBalanceValue() writes the authoritative balance directly into every
  // visible balance <b> so the number is correct the instant a charge settles even if a re-render is
  // deferred, and (2) pulseCreditBalanceUI() adds a soft highlight so the user SEES the deduction land.
  // Pure cosmetic + idempotent — never throws into the gate.
  let cxBalPulseStyleInjected = false;
  function ensureBalPulseStyle() {
    if (cxBalPulseStyleInjected || !document.head) return;
    cxBalPulseStyleInjected = true;
    const style = document.createElement("style");
    style.textContent = `
      @keyframes cxBalPulse { 0% { background: transparent; } 16% { background: var(--brand-weak, rgba(99,102,241,.22)); } 100% { background: transparent; } }
      .cx-bal-pulse { animation: cxBalPulse .8s ease-out; border-radius: 5px; transition: color .2s ease; }
    `;
    document.head.appendChild(style);
  }
  function creditBalanceBoldNodes() {
    const out = [];
    if (!document.body) return out;
    const bolds = document.body.getElementsByTagName("b");
    for (const b of bolds) {
      const raw = (b.textContent || "").trim();
      if (!raw || !/^[\d.,\s]+$/.test(raw)) continue;               // the <b> holds ONLY the number
      const ctx = b.parentElement?.textContent || "";
      if (/(số dư|so du|còn|con)/i.test(ctx) && /\bcr\b|credit/i.test(ctx)) out.push(b); // ...inside a balance line
    }
    return out;
  }
  function snapCreditBalanceValue() {
    try {
      const balanceText = formatCreditValue(liveCreditSnapshot().balance);
      for (const b of creditBalanceBoldNodes()) {
        if ((b.textContent || "").trim() !== balanceText) b.textContent = balanceText;
      }
    } catch { /* cosmetic */ }
  }
  function pulseCreditBalanceUI() {
    try {
      ensureBalPulseStyle();
      snapCreditBalanceValue();
      for (const b of creditBalanceBoldNodes()) {
        b.classList.remove("cx-bal-pulse");
        void b.offsetWidth; // force reflow so the animation restarts on repeat charges
        b.classList.add("cx-bal-pulse");
        setTimeout(() => { try { b.classList.remove("cx-bal-pulse"); } catch { /* gone */ } }, 850);
      }
    } catch { /* cosmetic */ }
  }

  function applyCreditUsagePayload(payload = {}) {
    const prevBalance = liveCreditSnapshot().balance;
    // Optimistic + reconcile emits arrive with the SAME usageRequestId: apply the first one fully
    // (toast, spend tally, pulse) and treat the repeat as a silent balance reconcile so we never
    // toast or double-count the same charge.
    const rid = String(payload?.usageRequestId || "");
    if (!state._creditRidSeen) state._creditRidSeen = new Set();
    const isReconcile = rid !== "" && state._creditRidSeen.has(rid);
    if (rid) {
      state._creditRidSeen.add(rid);
      if (state._creditRidSeen.size > 80) state._creditRidSeen = new Set([...state._creditRidSeen].slice(-40));
    }
    state.lastCreditUsage = { ...(payload || {}), at: Date.now() };
    const balance = Number(payload?.balance ?? payload?.remaining);
    if (Number.isFinite(balance)) {
      state.account = {
        ...(state.account || {}),
        ok: true,
        balance
      };
      state.portal = {
        ...(state.portal || {}),
        wallet: {
          ...portalWallet(),
          balance
        }
      };
      // Anchor the authoritative settled balance so a lagging account.me() poll can't revert the pill
      // back up to the stale pre-charge value (see liveCreditSnapshot anti-revert clamp).
      if (payload?.allowed !== false) state._lastSettle = { balance, at: Date.now() };
    }
    const cost = Number(payload?.creditCost);
    if (!isReconcile && payload?.allowed !== false && Number.isFinite(cost) && cost > 0) {
      state.account = {
        ...(state.account || {}),
        spentToday: finiteNumber(state.account?.spentToday) + cost,
        lifetimeSpent: finiteNumber(state.account?.lifetimeSpent) + cost
      };
      const serviceName = payload?.serviceName
        || serviceNameForId(payload?.serviceId, state.browser?.activeServiceName || "Dịch vụ");
      showCreditToast(`Request ${serviceName} · −${formatCreditValue(cost)} credit`);
    }
    state.updatedAt = new Date().toISOString();
    publishState();
    // Force the main React shell to re-render NOW so the data-bound service-header watch pill
    // ("Số dư · {{ pBalFmt }} cr") recomputes pBalFmt this tick instead of waiting for the
    // deferred account.me()/30s poll (the lag the user saw). Same idempotent no-op-render trick
    // as urlHistoryRevision/orgRevision; creditRevision is a bridge-only key (in no template) so
    // it can't collide, and React only re-diffs the <b> balance text — the pill's rect that
    // serviceHeaderButtonLayout() measures is unchanged.
    try { (patchedStaticLogic || staticLogic())?.setState?.({ creditRevision: Date.now() }); } catch { /* best-effort instant repaint */ }
    patchStaticUrlLog();
    refreshStaticUrlLogSoon();
    patchVisibleCreditTextsSoon();
    // Live header pill: snap the number across the re-render window, and pulse once when it changed.
    const newBalance = liveCreditSnapshot().balance;
    for (const d of [0, 120, 300]) setTimeout(snapCreditBalanceValue, d);
    if (!isReconcile && (!Number.isFinite(prevBalance) || newBalance !== prevBalance)) setTimeout(pulseCreditBalanceUI, 30);
    scheduleAccountStateRefresh(450);
    setTimeout(() => scheduleAccountStateRefresh(0), 1600);
  }

  async function refresh() {
    const bridge = api();
    if (!bridge) {
      state.ok = false;
      ensureBadge();
      return;
    }
    if (state.loggedOut) { state.account = null; state.portal = null; state.loginOk = false; publishState(); return; }
    try {
      let listResult = await bridge.services.refresh().catch(() => null);
      let serviceRows = listResult?.services || listResult?.config?.services || [];
      if (!normalizeServiceRows(serviceRows).length) {
        const localList = await bridge.services.list().catch(() => null);
        if (normalizeServiceRows(localList?.services || localList?.config?.services || []).length) {
          listResult = localList;
          serviceRows = localList.services || localList.config?.services || [];
        }
      }
      setLiveServices(serviceRows, "api");
      if (state.urlHistory?.length) setUrlHistory(state.urlHistory, { merge: false });
      const [account, portal, planTier] = await Promise.all([
        bridge.account.me().catch(() => null),
        bridge.portal.summary().catch(() => null),
        bridge.portal.planMe?.({}).catch(() => null)
      ]);
      // Keep the last-known wallet when a poll momentarily fails (e.g. a transient /api/me 401 on
      // the tunnel server). Overwriting state.account with null wiped the balance → the UI flashed
      // "Số dư · 0 cr" even though the real balance was unchanged. A genuine logout is handled
      // separately via the "connection:expired" event, so this never masks a real sign-out.
      if (account) { state.account = account; saveCreditCache(account); }
      if (portal) { state.portal = portal; state.portalReady = true; }
      if (planTier && planTier.ok !== false) { state.planTier = planTier; lastPlanSyncAt = Date.now(); enforcePlanOnOpenService(); }  // re-sync plan cards + close a now-blocked open service
      state.loginOk = Boolean(state.account?.ok || state.account?.account || state.account?.email || state.portal?.wallet || state.portal?.packages);
      if (state.loginOk) wasEverLoggedIn = true;
      state.ok = true;
      state.error = "";
      state.updatedAt = new Date().toISOString();
      await loadActivityHistory().catch(() => {});
      // Fire-and-forget: a one-time bulk upload must never delay login/refresh completion (a slow or
      // unreachable url-history route would otherwise stall the whole connect sequence).
      backfillUrlHistoryToServer().catch(() => {}); // upload any client-only history once
      await loadServerUrlHistory().catch(() => {}); // durable per-user history (cross-device)
      patchStaticUrlLog();
      refreshStaticUrlLogSoon();
      patchVisibleCreditTextsSoon();
      await syncBrowserStateFromMain(bridge).catch(() => null);
      publishState();
      if (state.loginOk && !state.browser.activeServiceId && !state.browser.opening) {
        showStaticAppScreenSoon();
      }
    } catch (error) {
      state.ok = false;
      state.error = error.message;
      publishState();
    }
    if (document.body) ensureBadge();
    if (document.body) ensureBrowserControl();
  }

  // Login spinner overlay. The bridge intercepts the "Đăng nhập" click (preventDefault), so the static
  // form can't surface its own loading state — the network round-trip (connection.login + refresh) then
  // feels like a freeze. This overlay is owned by the bridge (outside the static render tree, so a
  // re-render can't wipe it) and blocks double-submits while the request is in flight.
  function ensureLoginSpinnerStyles() {
    if (document.getElementById("centrix-login-spinner-style")) return;
    const style = document.createElement("style");
    style.id = "centrix-login-spinner-style";
    style.textContent = `
      @keyframes centrix-login-spin { to { transform: rotate(360deg); } }
      @keyframes centrix-login-fade { from { opacity: 0; } to { opacity: 1; } }
      #centrix-login-spinner {
        position: fixed; inset: 0; z-index: 2147483000;
        display: flex; align-items: center; justify-content: center;
        background: rgba(15, 23, 42, 0.18);
        -webkit-backdrop-filter: blur(1.5px); backdrop-filter: blur(1.5px);
        animation: centrix-login-fade 0.15s ease;
      }
      #centrix-login-spinner .centrix-login-card {
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        background: #ffffff; padding: 26px 34px; border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #centrix-login-spinner .centrix-login-ring {
        width: 42px; height: 42px; border-radius: 50%;
        border: 4px solid #dbeafe; border-top-color: #1e93f5;
        animation: centrix-login-spin 0.8s linear infinite;
      }
      #centrix-login-spinner .centrix-login-text { font-size: 14px; font-weight: 600; color: #334155; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showLoginSpinner(message = "Đang đăng nhập…") {
    ensureLoginSpinnerStyles();
    let overlay = document.getElementById("centrix-login-spinner");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "centrix-login-spinner";
      overlay.innerHTML = '<div class="centrix-login-card"><div class="centrix-login-ring"></div><div class="centrix-login-text"></div></div>';
      (document.body || document.documentElement).appendChild(overlay);
    }
    const textEl = overlay.querySelector(".centrix-login-text");
    if (textEl) textEl.textContent = message;
    overlay.style.display = "flex";
  }

  function hideLoginSpinner() {
    const overlay = document.getElementById("centrix-login-spinner");
    if (overlay) overlay.remove();
  }

  // ── Hydration mask: kill the "demo seed flashes before real data" on login ──────────────────────
  // The static template ships demo data (sample identity "Trần Xuân Lộc", demo credit/org). On login the
  // app screen flips BEFORE the bridge patches in the real account → a flash of the old UI. We cover the
  // WHOLE app with an opaque mask the instant login succeeds and only reveal once the real account data
  // has actually been applied to the DOM (or a safety timeout). Covers everything, not just identity.
  let hydrationMaskTimer = 0;
  function showHydrationMask() {
    let m = document.getElementById("centrix-hydration-mask");
    if (!document.getElementById("cx-hydration-kf")) {
      const st = document.createElement("style"); st.id = "cx-hydration-kf";
      st.textContent = "@keyframes cxspin{to{transform:rotate(360deg)}}";
      (document.head || document.documentElement).appendChild(st);
    }
    if (!m) {
      m = document.createElement("div");
      m.id = "centrix-hydration-mask";
      m.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:var(--surface,#ffffff);transition:opacity .2s ease";
      m.innerHTML = '<div style="text-align:center;font:600 13px/1.4 Segoe UI,system-ui,sans-serif;color:var(--text-2,#64748b)"><div style="width:34px;height:34px;border:3px solid var(--border-soft,#e2e8f0);border-top-color:#2563eb;border-radius:50%;margin:0 auto 12px;animation:cxspin .8s linear infinite"></div>Đang tải tài khoản…</div>';
      (document.body || document.documentElement).appendChild(m);
    }
    m.style.opacity = "1"; m.style.display = "flex";
    clearTimeout(hydrationMaskTimer);
    hydrationMaskTimer = setTimeout(hideHydrationMask, 8000); // safety: never stay stuck
  }
  function hideHydrationMask() {
    clearTimeout(hydrationMaskTimer);
    const m = document.getElementById("centrix-hydration-mask");
    if (!m) return;
    m.style.opacity = "0";
    setTimeout(() => { try { m.remove(); } catch { /* ignore */ } }, 220);
  }
  // Reveal only when the app screen is up AND the real account identity has been applied (demo gone).
  function maybeRevealAfterHydration() {
    if (!document.getElementById("centrix-hydration-mask")) return;
    if (state.loginOk && !loginScreenShowing() && accountIdentity() && accountIdentity().email) hideHydrationMask();
  }

  // --- Single-active-device: takeover prompt (this device) + eviction banner (the other device) ---
  function removeTakeoverPrompt() {
    const el = document.getElementById("centrix-takeover-prompt");
    if (el) el.remove();
  }
  function showTakeoverPrompt(activeDevice, email) {
    removeTakeoverPrompt();
    const overlay = document.createElement("div");
    overlay.id = "centrix-takeover-prompt";
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483646", "display:flex",
      "align-items:center", "justify-content:center", "background:rgba(15,23,42,.55)",
      "backdrop-filter:blur(2px)", "font:400 13px/1.5 Segoe UI,system-ui,sans-serif"
    ].join(";");
    const card = document.createElement("div");
    card.style.cssText = [
      "width:min(420px,calc(100vw - 40px))", "background:#fff", "color:#0f172a",
      "border-radius:14px", "padding:22px", "box-shadow:0 24px 60px rgba(15,23,42,.35)", "text-align:center"
    ].join(";");
    const seen = activeDevice && activeDevice.lastBeat
      ? `Hoạt động gần nhất: ${Math.max(0, Math.round((Date.now() - Number(activeDevice.lastBeat)) / 1000))} giây trước.`
      : "";
    card.innerHTML =
      '<div style="font:800 16px/1.3 Segoe UI,system-ui;margin-bottom:8px">Tài khoản đang được sử dụng</div>' +
      '<div style="color:#475569;margin-bottom:6px">Tài khoản này đang đăng nhập ở một thiết bị khác. Chỉ cho phép 1 thiết bị đăng nhập cùng lúc.</div>' +
      (seen ? `<div style="color:#94a3b8;font-size:12px;margin-bottom:16px">${seen}</div>` : '<div style="margin-bottom:16px"></div>') +
      '<button id="cx-takeover-go" style="width:100%;padding:11px;border:0;border-radius:10px;background:#b91c1c;color:#fff;font:800 13px Segoe UI,system-ui;cursor:pointer;margin-bottom:9px">Đăng xuất thiết bị đang đăng nhập</button>' +
      '<button id="cx-takeover-cancel" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;color:#475569;font:700 13px Segoe UI,system-ui;cursor:pointer">Huỷ</button>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const go = card.querySelector("#cx-takeover-go");
    const cancel = card.querySelector("#cx-takeover-cancel");
    if (go) go.addEventListener("click", () => confirmTakeover(email));
    if (cancel) cancel.addEventListener("click", () => {
      removeTakeoverPrompt();
      const bridge = api();
      try { bridge?.connection?.cancelTakeover?.(); } catch { /* best-effort */ }
    });
  }
  async function confirmTakeover(email) {
    const bridge = api();
    if (!bridge?.connection?.takeover) return;
    removeTakeoverPrompt();
    showLoginSpinner("Đang đăng xuất thiết bị kia…");
    try {
      const result = await bridge.connection.takeover();
      if (result && result.needTakeover) { hideLoginSpinner(); showTakeoverPrompt(result.activeDevice, email); return; }
      state.loggedOut = false;
      state.loginIntent = true;
      resetAccountScopedState(); // wipe the PREVIOUS account's cached + in-memory data (no cross-account leak)
      if (email) state.loginDraft = { email, password: "" }; // authoritative current-account email for accountIdentity()
      showHydrationMask(); // cover the app until real data is applied (no demo-identity flash)
      await refresh();
      if (email) saveLastLogin(email);
      if (state.loginOk && !state.browser.activeServiceId && !state.browser.opening) showStaticAppScreenSoon();
    } catch (error) {
      state.error = error.message;
      publishState();
      ensureBadge();
      showActionToast(`Đăng xuất thiết bị kia thất bại - ${error.message}`, "error");
    } finally {
      hideLoginSpinner();
    }
  }
  function removeEvictBanner() {
    clearInterval(showEvictBanner.timer);
    const b = document.getElementById("centrix-evict-banner");
    if (b) b.remove();
  }
  function showEvictBanner(graceMs, message) {
    let banner = document.getElementById("centrix-evict-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "centrix-evict-banner";
      banner.style.cssText = [
        "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
        "padding:11px 16px", "text-align:center", "background:rgba(185,28,28,.97)", "color:#fff",
        "font:800 13px/1.3 Segoe UI,system-ui,sans-serif", "box-shadow:0 6px 20px rgba(15,23,42,.3)"
      ].join(";");
      document.body.appendChild(banner);
    }
    const total = Math.max(1, Math.round((Number(graceMs) || 5000) / 1000));
    let left = total;
    const base = String(message || "Đang có thiết bị đăng nhập vào, sẽ logout sau 5 giây");
    const render = () => { banner.textContent = base.replace(/\d+\s*giây/, `${left} giây`); };
    render();
    clearInterval(showEvictBanner.timer);
    showEvictBanner.timer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(showEvictBanner.timer); banner.textContent = "Đang đăng xuất…"; return; }
      render();
    }, 1000);
  }

  async function loginFromStaticForm(payload) {
    // Password login REMOVED — Google-only client. No-op backstop (never sends credentials).
    hideLoginSpinner();
    showActionToast("Vui lòng đăng nhập bằng Google", "error");
    return;
    const bridge = api(); // eslint-disable-line no-unreachable
    if (!bridge || !payload.email || !payload.password) {
      hideLoginSpinner();
      return;
    }
    try {
      const result = await bridge.connection.login(payload);
      // Remember the typed account up front so a takeover/retry keeps the creds.
      state.loginDraft = { email: payload.email, password: payload.password };
      if (result && result.needTakeover) {
        // Credentials valid, but the account is active on another device — offer the takeover.
        hideLoginSpinner();
        showTakeoverPrompt(result.activeDevice, payload.email);
        return;
      }
      state.loggedOut = false; // re-login clears the logout guard so refresh() can restore the app screen
      state.loginIntent = true; // explicit user login this session — only now may the app screen be shown
      resetAccountScopedState(); // wipe the PREVIOUS account's cached + in-memory data (no cross-account leak)
      showHydrationMask(); // cover the app until real data is applied (no demo-identity flash)
      await refresh();
      saveLastLogin(payload.email);
      if (state.loginOk && !state.browser.activeServiceId && !state.browser.opening) showStaticAppScreenSoon();
    } catch (error) {
      state.error = error.message;
      publishState();
      ensureBadge();
      showActionToast("Đăng nhập không thành công, vui lòng thử lại", "error");
    } finally {
      hideLoginSpinner();
    }
  }

  // "Đăng nhập bằng Google": main opens the Google OAuth window + exchanges the code via the App Server,
  // then connects. Reuses the same success / single-device-takeover handling as the password login.
  async function loginWithGoogleFromStatic() {
    const bridge = api();
    if (!bridge?.connection?.loginGoogle) { showActionToast("Không gọi được đăng nhập Google", "error"); return; }
    showLoginSpinner("Đã mở trình duyệt — hoàn tất đăng nhập Google rồi quay lại đây…");
    try {
      const result = await bridge.connection.loginGoogle();
      if (result && result.needTakeover) {
        hideLoginSpinner();
        showTakeoverPrompt(result.activeDevice, result.account?.email || "");
        return;
      }
      state.loggedOut = false;
      state.loginIntent = true;
      resetAccountScopedState(); // wipe the PREVIOUS account's cached + in-memory data (no cross-account leak)
      // Carry the AUTHORITATIVE login email in-memory (loginDraft) so accountIdentity() resolves the CURRENT
      // account regardless of the remember-login flag — /api/me is wallet-only. Cleared on logout (line ~8259).
      if (result?.account?.email) state.loginDraft = { email: result.account.email, password: "" };
      showHydrationMask(); // cover the app until real data is applied (no demo-identity flash)
      await refresh();
      if (result?.account?.email) saveLastLogin(result.account.email);
      if (state.loginOk && !state.browser.activeServiceId && !state.browser.opening) showStaticAppScreenSoon();
    } catch (error) {
      state.error = error?.message;
      publishState();
      ensureBadge();
      showActionToast(`Đăng nhập Google thất bại - ${error?.message || ""}`, "error");
    } finally {
      hideLoginSpinner();
    }
  }

  let logoutInFlight = false;
  let wasEverLoggedIn = false;
  // The design's logout controls (onLogout/onAcctLogout) only flip the static screen to 'login'
  // — logout(){ this.setState({ screen:'login' }) } — WITHOUT disconnecting. So the open service
  // browsers stay attached (the screenshot's leftover Gemini view) and main keeps the live connection,
  // which makes the login screen flip straight back to the app ("tự động đăng nhập"). Run a REAL
  // disconnect: main closeAll() destroys every service WebContentsView + drops the connection.
  async function performLogoutTeardown(options = {}) {
    // `force` bypasses the state.loggedOut short-circuit. Needed by the account-lock overlay's "Đăng xuất":
    // the lock path (admin lock revokes the session → /api/me 401 → connection:expired) ALREADY set
    // state.loggedOut=true, so a plain call would bail here and the button did nothing — the real teardown
    // (flip to the login screen + self-revoke + wipe borrowed cookies + drop the connection) never ran.
    const force = options && options.force === true;
    if (logoutInFlight || (state.loggedOut && !force)) return;
    logoutInFlight = true;
    try {
      // Reflect logged-out state immediately + raise the guard so refresh() can't restore the app screen.
      state.loggedOut = true;
      state.loginIntent = false; // explicit logout — block any flip back to the app screen
      state.account = null;
      state.portal = null;
      state.loginOk = false;
      if (state.browser) { state.browser.activeServiceId = ""; state.browser.opening = false; }
      publishState();
      // Explicitly leave the app screen for the LOGIN screen. The design's own "Đăng xuất" button flips
      // the screen itself, but callers like the account-lock overlay don't go through that button — so
      // drive the flip here to guarantee we land on login (not just hide whatever was on top).
      try {
        const logic = patchedStaticLogic || staticLogic();
        if (logic && typeof logic.logout === "function") logic.logout();
        else logic?.setState?.({ screen: "login", active: null, opening: false });
      } catch { /* ignore */ }
      // Explicit logout: forget the remembered email + scrub any legacy saved password.
      try { localStorage.removeItem(SAVED_LOGIN_KEY); } catch { /* ignore */ }
      // Reset the in-memory login carrier too — otherwise prefillLoginForm() (500ms loop) keeps re-stamping
      // the previous user's email into the login box, making the app look "stuck" on the last account.
      state.loginDraft = { email: "", password: "" };
      clearAccountCaches(); // drop this account's cached wallet/services/history so the next login starts clean
      const bridge = api();
      if (bridge?.connection?.disconnect) await bridge.connection.disconnect(); // main: closeAll() + connection = null
    } catch {
      // best-effort; the design already showed the login screen
    } finally {
      logoutInFlight = false;
    }
  }

  function isLogoutTarget(target) {
    let el = target;
    for (let i = 0; i < 5 && el; i += 1) {
      const title = fold(el.getAttribute?.("title") || "");
      const text = fold(el.textContent || "").trim();
      if (/dang xuat|logout|sign out/.test(title) || text === "dang xuat") return true;
      el = el.parentElement;
    }
    return false;
  }

  function handleLogoutClickIntent(target) {
    if (isLogoutTarget(target)) performLogoutTeardown();
  }

  // Detect a click on the change-password submit button ("Cập nhật mật khẩu") — match the leaf button by
  // folded text + a sane hit-area, so it never false-matches the heading div or the nav "Đổi mật khẩu".
  function isChangePwTarget(target) {
    let el = target;
    for (let i = 0; i < 5 && el; i += 1) {
      if (fold(el.textContent || "").trim() === "cap nhat mat khau") {
        const r = el.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0 && r.width <= 600) return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  let changePwBusy = false; // double-submit guard
  async function handleChangePwClick() {
    if (changePwBusy) return;
    const fields = changePwInputs();
    if (!fields) { showActionToast("Mở tab Tài khoản để đổi mật khẩu", "error"); return; }
    const current = String(fields.current.value || "");
    const next = String(fields.next.value || "");
    const confirm = String(fields.confirm.value || "");
    if (!current || !next || !confirm) { showActionToast("Vui lòng nhập đủ các ô", "error"); return; }
    if (next.length < 6) { showActionToast("Mật khẩu mới phải từ 6 ký tự", "error"); return; }
    if (next !== confirm) { showActionToast("Xác nhận mật khẩu không khớp", "error"); return; }
    if (next === current) { showActionToast("Mật khẩu mới phải khác mật khẩu hiện tại", "error"); return; }
    const bridge = api();
    if (!bridge?.account?.changePassword) { showActionToast("Không gọi được dịch vụ đổi mật khẩu", "error"); return; }
    changePwBusy = true;
    try {
      const res = await bridge.account.changePassword({ current, next });
      if (res?.ok) {
        for (const f of [fields.current, fields.next, fields.confirm]) { f.value = ""; f.defaultValue = ""; }
        showActionToast("Đã đổi mật khẩu", "ok");
      } else {
        showActionToast(res?.error || "Đổi mật khẩu thất bại", "error");
      }
    } catch (error) {
      showActionToast(error?.message || "Đổi mật khẩu thất bại", "error");
    } finally {
      changePwBusy = false;
    }
  }

  // True only when the login submit button ("Đăng nhập", exact — not "…với Google" / spinner text) is
  // laid out. This is what separates the login SCREEN from the account tab's "Đổi mật khẩu" section,
  // which also has visible password fields but no login button.
  function loginSubmitButtonVisible() {
    for (const el of document.querySelectorAll("button,[role='button'],a,div,span")) {
      if (fold(el.textContent || "").trim() !== "dang nhap") continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.width <= 600) return true;
    }
    return false;
  }

  function loginScreenShowing() {
    // The login screen is up when the password field is laid out. CAVEAT: the design grew an account-tab
    // "Đổi mật khẩu" section (current/new/confirm), so password fields are NO LONGER login-only — a bare
    // password check false-positives on the account tab, which made applyAccountIdentity bail there and
    // left the "Tài khoản" tab on the demo identity. Require BOTH a visible password field AND a visible
    // "Đăng nhập" submit button (present only on the real login screen) to disambiguate. Works even while
    // a leftover native service view overlays it (getBoundingClientRect ignores native overlays).
    const { passwordInput } = loginCredInputs();
    if (!(passwordInput && visibleRect(passwordInput) && passwordInput.type === "password")) return false;
    return loginSubmitButtonVisible();
  }

  // BACKUP for any logout control the click handler doesn't recognize (e.g. an unlabeled icon): if a
  // click flips the design from the app screen TO the login screen, that IS a logout. Click-triggered
  // (not polling) so the brief login→app transition during startup session-restore can't false-trigger.
  function handleLogoutTransitionAfterClick() {
    if (state.loginOk) wasEverLoggedIn = true;
    if (state.loggedOut || !wasEverLoggedIn) return;
    if (loginScreenShowing()) return; // already on the login screen before this click — not a transition
    setTimeout(() => {
      if (!state.loggedOut && wasEverLoggedIn && loginScreenShowing()) performLogoutTeardown();
    }, 250);
  }

  function serviceFromClick(target) {
    // Detect service-open clicks even when loginOk momentarily flaps false so reopening/switching
    // keeps working (openService itself is best-effort).
    if (!state.services.length) return null;
    if (target?.closest?.("[data-url]")) return null; // history rows open via their own data-url
    let el = target?.closest?.("button,div,span,a");
    let depth = 0;
    while (el && depth < 8) {
      const matchedService = serviceFromOpenElement(el);
      if (matchedService) return matchedService;
      const rect = el.getBoundingClientRect();
      const text = fold(el.textContent || "");
      const isReasonableHitArea =
        rect.width >= 18 &&
        rect.height >= 12 &&
        rect.width <= 560 &&
        rect.height <= 220;
      const hasOpenIntent =
        /(^|\s)(mo|open)(\s|$|→|↗)/.test(text) ||
        text.includes("dang mo") ||
        text.includes("dang chay");
      if (
        isReasonableHitArea &&
        hasOpenIntent
      ) {
        const service = servicesByName().find((item) => text.includes(fold(item.name))) ||
          serviceFromNearbyServiceRow(target);
        if (service) return service;
      }
      el = el.parentElement;
      depth += 1;
    }
    // NO unconditional nearby-row fallback here: it fired for ANY click in the sidebar (incl. the
    // account card / account menu at the bottom), opening a random nearby service and corrupting the
    // UI. Legitimate service opens are already caught above — by serviceFromOpenElement (the row/card
    // carries the service name) or the open-intent branch (the "Mở" control → serviceFromNearbyServiceRow).
    return null;
  }

  function hasServiceOpenIntent(text) {
    return (
      text.includes(" mo") ||
      text.includes("mo ") ||
      text.endsWith("mo") ||
      text.includes("moâ†’") ||
      text.includes("mo â†—") ||
      text.includes("open") ||
      text.includes("dang mo") ||
      text.includes("dang chay")
    );
  }

  function serviceFromOpenElement(element) {
    if (!element || !state.services.length || !visible(element)) return null;
    if (element.closest?.("[data-url]")) return null; // history rows are not generic service-open controls
    const rect = element.getBoundingClientRect();
    if (rect.width < 18 || rect.height < 12 || rect.width > 560 || rect.height > 220) return null;
    const text = fold(element.textContent || "");
    const matches = servicesByName().filter((item) => text.includes(fold(item.name)));
    if (matches.length !== 1) return null;
    const looksLikeServiceRow =
      hasServiceOpenIntent(text) ||
      (rect.width >= 120 && rect.width <= 460 && rect.height >= 34 && rect.height <= 120);
    return looksLikeServiceRow ? matches[0] : null;
  }

  const staticServiceOpenGuard = {
    id: "",
    at: 0
  };

  function planBlocksService(serviceId) {
    // True only when the plan gate is ENFORCING ("on") AND the user's plan has this service disabled. Mirrors
    // the server-side check_model_usage gate so a blocked service can't even be OPENED (not just charged).
    const t = state.planTier;
    if (!t || t.gate !== "on") return false;
    return (Array.isArray(t.blockedServices) ? t.blockedServices : []).includes(String(serviceId || ""));
  }
  function dispatchStaticServiceOpen(service, event) {
    if (!service) return;
    if (planBlocksService(service.id)) {
      event?.preventDefault?.(); event?.stopPropagation?.(); event?.stopImmediatePropagation?.();
      showActionToast("Gói " + (((state.planTier || {}).current) || "Free") + " không dùng được dịch vụ này — nâng cấp gói để mở.", "error");
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    const now = Date.now();
    if (staticServiceOpenGuard.id === service.id && now - staticServiceOpenGuard.at < 500) return;
    staticServiceOpenGuard.id = service.id;
    staticServiceOpenGuard.at = now;
    setTimeout(() => {
      const opener = typeof window.centrixUserOpenService === "function"
        ? window.centrixUserOpenService(service.id)
        : openService(service);
      Promise.resolve(opener).catch((error) => {
        state.browser = {
          ...(state.browser || {}),
          opening: false,
          error: error.message || String(error)
        };
        publishState();
        ensureBadge();
      });
    }, 0);
  }

  function serviceFromStaticOpenEvent(event, fallbackElement = null) {
    const currentTarget = event?.currentTarget?.dataset
      ? event.currentTarget
      : null;
    const fallbackTarget = fallbackElement?.dataset
      ? fallbackElement
      : null;
    const eventTarget = event?.target?.closest?.("[data-centrix-service-open-id]") || null;
    const serviceId =
      currentTarget?.dataset?.centrixServiceOpenId ||
      fallbackTarget?.dataset?.centrixServiceOpenId ||
      eventTarget?.dataset?.centrixServiceOpenId ||
      "";
    return liveServices().find((item) => item.id === serviceId) || null;
  }

  function serviceById(serviceId) {
    return liveServices().find((item) => item.id === serviceId) || null;
  }

  function onStaticServiceOpenControlClick(event) {
    dispatchStaticServiceOpen(serviceFromStaticOpenEvent(event, this), event);
  }

  function onStaticServiceOpenControlPointer(event) {
    if (event.button !== undefined && event.button !== 0) return;
    dispatchStaticServiceOpen(serviceFromStaticOpenEvent(event, this), event);
  }

  const historyOpenGuard = { url: "", at: 0 };

  // A "Nhật ký sử dụng" row carries the REAL previously-used URL in its data-url attribute. Open it
  // at that exact URL — otherwise the generic service-open handler matched the row by service name +
  // "Mở" and opened the service's DEFAULT url, ignoring the specific history url.
  function historyOpenFromClick(target) {
    const row = target?.closest?.("[data-url]");
    if (!row) return null;
    const url = String(row.getAttribute("data-url") || "").trim();
    if (!url || url.includes("{{")) return null;
    const service = serviceFromUrl(url);
    if (!service?.id) return null;
    return { service, url };
  }

  function dispatchHistoryOpen(hist, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    const now = Date.now();
    if (historyOpenGuard.url === hist.url && now - historyOpenGuard.at < 500) return;
    historyOpenGuard.url = hist.url;
    historyOpenGuard.at = now;
    setTimeout(() => {
      Promise.resolve(openService(hist.service, hist.url)).catch((error) => {
        state.browser = { ...(state.browser || {}), opening: false, error: error.message || String(error) };
        publishState();
      });
    }, 0);
  }

  function onWindowServiceOpenIntent(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const hist = historyOpenFromClick(event.target);
    if (hist) {
      dispatchHistoryOpen(hist, event);
      return;
    }
    const service = serviceFromClick(event.target);
    if (service) dispatchStaticServiceOpen(service, event);
  }

  function bindStaticServiceOpenControls() {
    // Bind even when loginOk momentarily flaps false so reopen/switch keeps working.
    if (!state.services.length || !document.body) return;
    for (const element of Array.from(document.querySelectorAll("button,div,span,a"))) {
      const service = serviceFromOpenElement(element);
      if (!service) continue;
      element.dataset.centrixServiceOpenId = service.id;
      if (
        element.dataset.centrixServiceOpenBound !== "1" ||
        element.__centrixServiceOpenHandlerId !== service.id
      ) {
        if (element.__centrixServiceOpenPointerHandler) {
          element.removeEventListener("pointerdown", element.__centrixServiceOpenPointerHandler, true);
          element.removeEventListener("mousedown", element.__centrixServiceOpenPointerHandler, true);
        }
        if (element.__centrixServiceOpenClickHandler) {
          element.removeEventListener("click", element.__centrixServiceOpenClickHandler, true);
        }
        const serviceId = service.id;
        const clickHandler = function centrixBoundStaticServiceClick(event) {
          dispatchStaticServiceOpen(serviceById(serviceId) || service, event);
        };
        const pointerHandler = function centrixBoundStaticServicePointer(event) {
          if (event.button !== undefined && event.button !== 0) return;
          dispatchStaticServiceOpen(serviceById(serviceId) || service, event);
        };
        element.addEventListener("pointerdown", pointerHandler, true);
        element.addEventListener("mousedown", pointerHandler, true);
        element.addEventListener("click", clickHandler, true);
        element.__centrixServiceOpenHandlerId = service.id;
        element.__centrixServiceOpenClickHandler = clickHandler;
        element.__centrixServiceOpenPointerHandler = pointerHandler;
        element.dataset.centrixServiceOpenBound = "1";
      }
      element.onclick = element.__centrixServiceOpenClickHandler;
      markNoDrag(element);
      element.style.cursor = "pointer";
    }
  }

  // ── Menu "Ví tiền": nav item + màn ví VNĐ (số dư + Nạp tiền + lịch sử giao dịch ví) ──────────────────
  function walletNavLca(a, b) {
    const anc = new Set(); let x = a; while (x) { anc.add(x); x = x.parentElement; }
    let y = b; while (y) { if (anc.has(y)) return y; y = y.parentElement; } return null;
  }
  function ensureWalletNav() {
    // Chèn "Ví tiền" vào ĐÚNG container flex của thanh nav, làm ANH EM của tab "Tổng quan" (không chèn cạnh
    // text bên trong tab → tránh bị xuống hàng). Nav container = tổ tiên chung thấp nhất của "Tổng quan" +
    // "Lịch sử". Nút COPY display/font/padding/margin của tab thật để đều nhau. Idempotent (id guard).
    const leaves = Array.from(document.querySelectorAll("button,div,a,span"))
      .filter((el) => el.children.length === 0 && el.offsetParent !== null);
    const tq = leaves.find((el) => fold(el.textContent || "").trim() === "tong quan");
    const ls = leaves.find((el) => fold(el.textContent || "").trim() === "lich su");
    if (!tq || !ls) return;
    const nav = walletNavLca(tq, ls);
    if (!nav) return;
    let btn = nav.querySelector("#cx-wallet-nav");
    if (!btn) {
      let tab = tq; while (tab && tab.parentElement !== nav) tab = tab.parentElement; // tab "Tổng quan" (con trực tiếp của nav)
      if (!tab) return;
      let cs; try { cs = getComputedStyle(tab); } catch (e) { cs = null; }
      btn = document.createElement("div");
      btn.id = "cx-wallet-nav";
      btn.textContent = "Ví tiền";
      const base = "box-sizing:border-box;cursor:pointer;white-space:nowrap;background:transparent;border:0;color:var(--text-2,#5b6677);";
      btn.style.cssText = cs
        ? base + "display:" + (cs.display === "block" ? "inline-block" : cs.display) + ";"
          + "font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";font-weight:" + cs.fontWeight + ";line-height:" + cs.lineHeight + ";"
          + "padding:" + cs.paddingTop + " " + cs.paddingRight + " " + cs.paddingBottom + " " + cs.paddingLeft + ";"
          + "margin:" + cs.marginTop + " " + cs.marginRight + " " + cs.marginBottom + " " + cs.marginLeft + ";"
        : base + "display:inline-block;font:600 14px var(--cx-font-sans);padding:10px 12px;";
      btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openWalletScreen(); });
      tab.insertAdjacentElement("afterend", btn);
    }
    syncWalletNavActive(nav, btn);
  }
  // Đồng bộ gạch active: mở Ví tiền → gạch xanh dưới "Ví tiền" + ẨN gạch của tab design đang active (chỉ 1
  // gạch). Đóng → bỏ gạch "Ví tiền", trả gạch design về. Chạy mỗi tick nên tự áp lại sau khi design re-render.
  function syncWalletNavActive(nav, btn) {
    const open = !!document.getElementById("cx-wallet-screen");
    if (btn) { btn.style.color = open ? "var(--brand,#1e93f5)" : "var(--text-2,#5b6677)"; btn.style.borderBottom = open ? "2px solid var(--brand,#1e93f5)" : "0"; }
    // Mở Ví tiền → chỉ Ví tiền có gạch xanh; ẩn gạch của MỌI tab design (cả gạch trên chính tab lẫn phần tử con)
    // bằng cách LƯU border-bottom gốc rồi ép transparent — khi đóng KHÔI PHỤC CHÍNH XÁC (không xoá nhầm gạch
    // active thật của design). Nhờ vậy luôn đúng 1 gạch = tab đang mở.
    const paint = (el, hide) => {
      if (!el || !el.style) return;
      if (hide) {
        if (el.getAttribute("data-cx-nav-bb") == null) el.setAttribute("data-cx-nav-bb", el.style.borderBottom || "__none__");
        el.style.setProperty("border-bottom-color", "transparent", "important");
      } else if (el.getAttribute("data-cx-nav-bb") != null) {
        const saved = el.getAttribute("data-cx-nav-bb");
        el.style.removeProperty("border-bottom-color");
        if (saved && saved !== "__none__") el.style.borderBottom = saved; else el.style.removeProperty("border-bottom");
        el.removeAttribute("data-cx-nav-bb");
      }
    };
    for (const ch of Array.from(nav.children)) {
      if (ch === btn) continue;
      paint(ch, open);
      for (const d of Array.from(ch.children || [])) paint(d, open); // phòng khi gạch nằm ở phần tử con
    }
    // Ngoài gạch, còn phải TRUNG HOÀ MÀU CHỮ xanh của tab design đang active. Nếu không: mở Ví tiền mà tab cũ
    // (Tổng quan/Lịch sử) vẫn xanh → 2 tab cùng xanh. Ép MỌI chữ trong tab design về màu inactive khi mở Ví tiền
    // (duyệt toàn bộ hậu duệ để bắt cả text leaf lồng sâu); khôi phục chính xác khi đóng. Chạy mỗi tick nên tự
    // áp lại sau khi design re-render (React set inline color không có !important → bị ép lại ngay tick sau).
    const INACTIVE_FG = "var(--text-2,#5b6677)";
    const paintFg = (el) => {
      if (!el || !el.style) return;
      if (open) {
        if (el.getAttribute("data-cx-nav-fg") == null) el.setAttribute("data-cx-nav-fg", el.style.color || "__none__");
        el.style.setProperty("color", INACTIVE_FG, "important");
      } else if (el.getAttribute("data-cx-nav-fg") != null) {
        const saved = el.getAttribute("data-cx-nav-fg");
        el.style.removeProperty("color");
        if (saved && saved !== "__none__") el.style.color = saved;
        el.removeAttribute("data-cx-nav-fg");
      }
    };
    for (const ch of Array.from(nav.children)) {
      if (ch === btn) continue;
      paintFg(ch);
      for (const d of Array.from(ch.querySelectorAll("*"))) paintFg(d);
    }
  }
  function walletTxLabel(tx) {
    const t = String(tx.type || "").toLowerCase();
    if (t === "topup") return "Nạp tiền vào ví";
    if (t === "buy-credit") { const p = portalPackagesList().find((x) => x.id === tx.ref); return p ? ("Mua " + formatCreditValue((Number(p.credits) || 0) + (Number(p.bonusCredits) || 0)) + " credit") : "Mua credit"; }
    if (t === "buy-plan") { const pl = ((state.planTier || {}).plans || []).find((x) => String(x.code).toUpperCase() === String(tx.ref).toUpperCase()); return "Mua gói " + (pl ? (pl.name || pl.code) : (tx.ref || "cước")); }
    if (t === "adjust") return (Number(tx.amountDelta) || 0) >= 0 ? "Cộng ví (điều chỉnh)" : "Trừ ví (điều chỉnh)";
    return tx.note || t || "Giao dịch ví";
  }
  // Badge loại giao dịch — ĐỒNG BỘ style badge màn "Lịch sử" (pill bo tròn + icon SVG + màu var). look/icon/sub.
  function walletTxTypeMeta(tx) {
    const t = String(tx.type || "").toLowerCase();
    const ico = (stroke, path) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    if (t === "topup") return { label: "Nạp tiền", sub: "Nạp vào ví VNĐ", look: "color:var(--ok-text);background:var(--ok-soft);border:1px solid var(--ok-border);", icon: ico("var(--ok-text)", '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v8M8 12h8"></path>') };
    if (t === "buy-credit") return { label: "Mua credit", sub: "Trừ từ ví VNĐ", look: "color:var(--brand);background:var(--brand-soft);border:1px solid var(--brand-border);", icon: ico("var(--brand)", '<circle cx="12" cy="12" r="9"></circle><path d="M9.5 9.5a3 3 0 1 1 0 5"></path>') };
    if (t === "buy-plan") return { label: "Mua gói", sub: "Trừ từ ví VNĐ", look: "color:#7c3aed;background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.28);", icon: ico("#7c3aed", '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path>') };
    if (t === "adjust") return { label: "Điều chỉnh", sub: "Điều chỉnh ví", look: "color:#d97706;background:rgba(217,119,6,.12);border:1px solid rgba(217,119,6,.28);", icon: ico("#d97706", '<circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path>') };
    return { label: "Giao dịch", sub: "", look: "color:var(--text-2);background:var(--surface-3);border:1px solid var(--border);", icon: ico("currentColor", '<circle cx="12" cy="12" r="9"></circle>') };
  }
  const WALLET_COLS = "grid-template-columns:150px 1fr 150px 130px;gap:10px;";
  function walletTxRowHtml(tx) {
    const delta = Number(tx.amountDelta) || 0;
    const pos = delta >= 0;
    const amt = (pos ? "+" : "−") + Math.abs(delta).toLocaleString("vi-VN") + " đ";
    const m = walletTxTypeMeta(tx);
    let d = ""; try { d = formatHistoryDateTime(tx.createdAt); } catch (e) { d = ""; }
    return `<div style="display:grid;${WALLET_COLS}align-items:center;padding:13px 20px;border-bottom:1px solid var(--border-soft);">
      <div><span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;border-radius:999px;padding:4px 11px 4px 8px;${m.look}">${m.icon}<span>${m.label}</span></span></div>
      <div style="min-width:0;">
        <div style="font-size:13.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(walletTxLabel(tx))}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.sub || "")}</div>
      </div>
      <div style="font-size:12.5px;color:var(--text-2);font-variant-numeric:tabular-nums;">${escapeHtml(d)}</div>
      <div style="font-size:13px;font-weight:700;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;color:${pos ? "var(--ok-text)" : "var(--text)"};">${amt}</div>
    </div>`;
  }
  let walletDocClick = null;
  function closeWalletScreen() {
    const el = document.getElementById("cx-wallet-screen"); if (el) el.remove();
    if (walletDocClick) { document.removeEventListener("click", walletDocClick, true); walletDocClick = null; }
    ensureWalletNav(); // bỏ gạch "Ví tiền" + trả gạch design đang active về
  }
  // TRANG RIÊNG (không modal): panel đặc phủ ĐÚNG vùng nội dung (phải sidebar, dưới thanh nav) như các tab
  // Lịch sử/Mua credit. Bấm tab/sidebar khác → tự đóng (click lọt tới nav design để chuyển màn). Modal Nạp
  // tiền (#centrix-money-topup / #centrix-vietqr) được loại khỏi auto-close để mở đè lên trang ví.
  // Lịch sử ví: 10 dòng/trang + phân trang (dùng lại usagePageWindow như "Lịch sử sử dụng").
  const WALLET_PAGE_SIZE = 10;
  let walletHistPage = 0; // 0-based
  function walletPagerHtml(page, pages) {
    const cell = (label, target, opts) => {
      const o = opts || {};
      const base = "min-width:32px;height:32px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;font-size:13px;font-weight:600;user-select:none;border:1px solid var(--border);";
      let style;
      if (o.active) style = base + "background:var(--brand);border-color:var(--brand);color:#fff;cursor:default;";
      else if (o.disabled) style = base + "background:var(--surface-2);color:var(--text-3);opacity:.5;cursor:default;";
      else style = base + "background:var(--surface);color:var(--text-2);cursor:pointer;";
      const attr = (o.active || o.disabled) ? "" : ` data-cx-wpage="${target}"`;
      return `<div${attr} style="${style}">${label}</div>`;
    };
    const parts = [cell("‹", page - 1, { disabled: page <= 0 })];
    for (const it of usagePageWindow(page, pages)) {
      if (it === "...") parts.push(`<div style="min-width:22px;text-align:center;color:var(--text-3);font-size:13px;">…</div>`);
      else parts.push(cell(String(it + 1), it, { active: it === page }));
    }
    parts.push(cell("›", page + 1, { disabled: page >= pages - 1 }));
    return `<div style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;padding:12px 0 2px;">${parts.join("")}</div>`;
  }
  function renderWalletHistoryInto(container) {
    if (!container) return;
    const all = walletTxList().slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const pages = Math.max(1, Math.ceil(all.length / WALLET_PAGE_SIZE));
    if (walletHistPage >= pages) walletHistPage = pages - 1;
    if (walletHistPage < 0) walletHistPage = 0;
    const start = walletHistPage * WALLET_PAGE_SIZE;
    const pageTxs = all.slice(start, start + WALLET_PAGE_SIZE);
    const rows = pageTxs.length ? pageTxs.map(walletTxRowHtml).join("") : '<div style="padding:30px 6px;text-align:center;color:var(--text-3,#94a3b8);font:500 13px var(--cx-font-sans);">Chưa có giao dịch ví nào. Bấm "Nạp tiền ngay" để nạp.</div>';
    const hCell = (t, right) => `<div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.05em;text-transform:uppercase;${right ? "text-align:right;" : ""}">${t}</div>`;
    // Bảng nằm TRONG card (card do openWalletScreen dựng, có shadow+overflow) — chỉ render header cột + dòng + pager.
    container.innerHTML = `<div style="display:grid;${WALLET_COLS}padding:11px 20px;border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);background:var(--surface-2);">
        ${hCell("Loại")}${hCell("Hoạt động")}${hCell("Thời gian")}${hCell("Số tiền", true)}
      </div>
      <div>${rows}</div>${pages > 1 ? walletPagerHtml(walletHistPage, pages) : ""}`;
  }
  function openWalletScreen() {
    if (document.getElementById("cx-wallet-screen")) return;
    walletHistPage = 0;
    // ÉP font app (--cx-font-sans) cho TOÀN BỘ màn ví + modal nạp/QR → không còn "font riêng" khác phần app.
    if (!document.getElementById("cx-wallet-font-fix")) {
      const fs = document.createElement("style");
      fs.id = "cx-wallet-font-fix";
      fs.textContent = '#cx-wallet-screen,#cx-wallet-screen *,#centrix-money-topup,#centrix-money-topup *,#centrix-vietqr,#centrix-vietqr *{font-family:"Segoe UI Variable","Segoe UI",Inter,system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif!important;}';
      (document.head || document.documentElement).appendChild(fs);
    }
    const navBtn = document.getElementById("cx-wallet-nav");
    const navBar = navBtn ? navBtn.parentElement : null;
    const r = navBar ? navBar.getBoundingClientRect() : { left: 340, bottom: 96 };
    const left = Math.max(0, Math.round(r.left));
    const top = Math.round((r.bottom || 96) + 8);
    const width = Math.max(320, Math.round(window.innerWidth - left - 12));
    const bal = Number(liveCreditSnapshot().moneyBalance) || 0;
    const all = walletTxList();
    let totalIn = 0, totalOut = 0;
    for (const t of all) { const d = Number(t.amountDelta) || 0; if (d >= 0) totalIn += d; else totalOut += -d; }
    const money = (n) => (Number(n) || 0).toLocaleString("vi-VN") + " đ";
    const icoWallet = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="3"/><path d="M2 10h20M16.5 15h.01"/></svg>';
    const icoUp = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>';
    const icoDown = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v13M6 12l6 6 6-6"/></svg>';
    // Thẻ số liệu — ĐỒNG BỘ y hệt template "Hóa đơn": label 10.5px/700 .07em hoa, số 20px/700 -.02em, caption 11.5px;
    // thẻ ĐẦU (số dư) tô gradient brand (highlight) như card "Tổng chi tiêu".
    const statCard = (label, value, cap, valColor, highlight) => {
      if (highlight) return `<div style="background:linear-gradient(135deg,var(--brand),var(--brand-strong));border-radius:14px;padding:16px 18px;">
        <div style="font-size:10.5px;font-weight:700;color:rgba(255,255,255,.85);letter-spacing:.07em;text-transform:uppercase;">${label}</div>
        <div style="font-size:20px;font-weight:700;color:#fff;margin:6px 0 2px;letter-spacing:-.02em;">${value}</div>
        <div style="font-size:11.5px;color:rgba(255,255,255,.9);">${cap}</div></div>`;
      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;">
        <div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.07em;text-transform:uppercase;">${label}</div>
        <div style="font-size:20px;font-weight:700;color:${valColor || "var(--text)"};margin:6px 0 2px;letter-spacing:-.02em;">${value}</div>
        <div style="font-size:11.5px;color:var(--text-3);">${cap}</div></div>`;
    };
    const quickAmts = [100000, 500000, 1000000, 5000000];
    // CHỈ loại thanh toán app THẬT SỰ hỗ trợ: Chuyển khoản (VietQR/SePay). Không hiện Ví điện tử/Thẻ (chưa nối API).
    const payMethods = [
      { id: "bank", name: "Chuyển khoản", sub: "Ngân hàng nội địa (VietQR)", ico: "🏦", active: true },
    ];
    const payCard = (m) => `<div data-cx-pay="${m.id}" style="flex:1 1 120px;min-width:110px;border:1.5px solid ${m.active ? "var(--brand,#1e93f5)" : "var(--border,#e6e9ee)"};border-radius:12px;padding:12px 13px;cursor:pointer;position:relative;background:${m.active ? "var(--brand-soft,#eff6ff)" : "var(--surface,#fff)"};box-sizing:border-box;">
      ${m.active ? '<span style="position:absolute;top:7px;right:9px;color:var(--brand,#1e93f5);font-size:13px;">✔</span>' : ""}
      <div style="font-size:20px;line-height:1;">${m.ico}</div>
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-top:7px;">${m.name}</div>
      <div style="font-size:11px;color:var(--text-3);margin-top:2px;">${m.sub}</div>
    </div>`;
    const panel = document.createElement("div");
    panel.id = "cx-wallet-screen";
    panel.style.cssText = "position:fixed;left:" + left + "px;top:" + top + "px;width:" + width + "px;bottom:12px;z-index:2147483200;overflow:auto;background:var(--bg,#eef1f5);border-radius:14px;padding:22px 24px;box-sizing:border-box;font-family:'Segoe UI Variable','Segoe UI',Inter,system-ui,sans-serif;";
    panel.innerHTML = `<div style="display:flex;flex-direction:column;gap:16px;">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:18px;font-weight:700;color:var(--text);letter-spacing:-.01em;">Ví tiền VNĐ</div>
          <div style="font-size:12.5px;color:var(--text-3);margin-top:3px;">Quản lý số dư, nạp tiền và xem lịch sử giao dịch trong ví của bạn.</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
        ${statCard("Số dư ví", money(bal), "Sẵn sàng sử dụng", "", true)}
        ${statCard("Tổng đã nạp", "+" + money(totalIn), "Tổng số tiền đã nạp vào ví", "var(--ok-text)")}
        ${statCard("Tổng đã chi", "−" + money(totalOut), "Tổng số tiền đã chi từ ví", "var(--text)")}
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);padding:20px 22px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
          <div style="font-size:15px;font-weight:700;color:var(--text);">Nạp tiền vào ví</div>
          <span style="margin-left:auto;font-size:12px;font-weight:600;color:var(--ok-text);display:flex;align-items:center;gap:5px;white-space:nowrap;">🛡 Giao dịch an toàn & bảo mật</span>
        </div>
        <div style="font-size:12.5px;color:var(--text-3);line-height:1.5;margin-bottom:14px;">Nạp tiền nhanh chóng để mua credit / gói cước.</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;">
          <div style="flex:1;min-width:230px;">
            <div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Số tiền nạp</div>
            <div style="position:relative;">
              <input id="cx-wallet-amt" type="number" step="10000" min="1000" placeholder="Nhập số tiền (đ)" style="width:100%;font-size:13.5px;color:var(--text);background:var(--field-bg);border:1px solid var(--field-border);border-radius:10px;padding:11px 34px 11px 13px;box-sizing:border-box;">
              <span style="position:absolute;right:13px;top:50%;transform:translateY(-50%);color:var(--text-3);font-weight:600;">đ</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px;">
              ${quickAmts.map((q) => `<button type="button" data-cx-wamt="${q}" style="font-size:12.5px;font-weight:600;color:var(--text);background:var(--surface-2);border:1px solid var(--field-border);border-radius:9px;padding:9px 0;cursor:pointer;white-space:nowrap;">${(q / 1000).toLocaleString("vi-VN")}k</button>`).join("")}
            </div>
          </div>
          <div style="flex:1;min-width:230px;">
            <div style="font-size:10.5px;font-weight:700;color:var(--label);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">Phương thức thanh toán</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">${payMethods.map(payCard).join("")}</div>
          </div>
        </div>
        <button type="button" id="cx-wallet-go" style="width:100%;margin-top:18px;font-size:14px;font-weight:700;color:#fff;background:var(--brand);border:0;border-radius:10px;padding:13px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">Nạp tiền ngay <span style="font-size:17px;line-height:1;">›</span></button>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 1px 3px var(--shadow);overflow:hidden;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px 14px;flex-wrap:wrap;">
          <div style="font-size:15px;font-weight:700;color:var(--text);">Lịch sử giao dịch ví</div>
          <div style="display:flex;gap:8px;">
            <span style="font-size:12.5px;font-weight:600;color:var(--text-2);border:1px solid var(--field-border);border-radius:9px;padding:8px 12px;background:var(--surface);">Tất cả loại ▾</span>
            <span style="font-size:12.5px;font-weight:600;color:var(--text-2);border:1px solid var(--field-border);border-radius:9px;padding:8px 12px;background:var(--surface);">Tất cả thời gian ▾</span>
          </div>
        </div>
        <div id="cx-wallet-hist"></div>
      </div>
    </div>`;
    (document.body || document.documentElement).appendChild(panel);
    // Lịch sử ví: render trang đầu + wire phân trang (click số trang → đổi walletHistPage → render lại đúng container).
    const wHist = panel.querySelector("#cx-wallet-hist");
    renderWalletHistoryInto(wHist);
    wHist?.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest("[data-cx-wpage]") : null;
      if (!b) return;
      const p = parseInt(b.getAttribute("data-cx-wpage"), 10);
      if (isNaN(p)) return;
      walletHistPage = p;
      renderWalletHistoryInto(wHist);
    });
    // Nạp tiền INLINE (không mở modal chọn số tiền nữa): điền số → "Nạp tiền ngay" → tạo đơn VietQR + show QR.
    const wAmt = panel.querySelector("#cx-wallet-amt");
    panel.querySelectorAll("[data-cx-wamt]").forEach((b) => b.addEventListener("click", () => { if (wAmt) { wAmt.value = b.getAttribute("data-cx-wamt"); wAmt.focus(); } }));
    panel.querySelector("#cx-wallet-go")?.addEventListener("click", () => {
      const amt = Math.round(Number(wAmt && wAmt.value) || 0);
      if (!(amt >= 1000)) { try { showActionToast("Nhập số tiền tối thiểu 1.000đ", "error"); } catch (e) {} return; }
      try { startMoneyTopup(amt); } catch (e) {}
    });
    // Phương thức thanh toán: GIỮ NGUYÊN — chỉ Chuyển khoản (VietQR) hoạt động; chọn cái khác → báo.
    panel.querySelectorAll("[data-cx-pay]").forEach((c) => c.addEventListener("click", () => {
      if (c.getAttribute("data-cx-pay") !== "bank") { try { showActionToast("Hiện chỉ hỗ trợ Chuyển khoản (VietQR)"); } catch (e) {} }
    }));
    ensureWalletNav(); // đồng bộ gạch active ngay (highlight Ví tiền + ẩn gạch design)
    walletDocClick = (e) => {
      const t = e.target;
      if (t && t.closest && (t.closest("#cx-wallet-screen") || t.closest("#cx-wallet-nav") || t.closest("#centrix-money-topup") || t.closest("#centrix-vietqr"))) return;
      closeWalletScreen(); // click ra ngoài (tab/sidebar khác) → đóng trang ví, để design chuyển màn
    };
    setTimeout(() => document.addEventListener("click", walletDocClick, true), 0);
  }

  function clickedNav(target) {
    const text = fold(target?.textContent || "");
    return [
      "tong quan",
      "lich su",
      "mua credit",
      "goi cuoc",
      "hoa don",
      "don hang",
      "thiet bi",
      "tai khoan",
      "ho tro",
      "cai dat",
      "to chuc"
    ].includes(text);
  }

  async function openService(service, targetUrl = "") {
    const bridge = api();
    if (!bridge?.browser?.openService || !service?.id) return;
    if (planBlocksService(service.id)) {
      showActionToast("Gói " + (((state.planTier || {}).current) || "Free") + " không dùng được dịch vụ này — nâng cấp gói.", "error");
      return;
    }
    const requestSerial = ++openServiceSerial;
    if (!state.loginOk) {
      // Best-effort: try to recover the session but DO NOT bail if it's still degraded — the embedded
      // service loads from its own profile cookies, so open/switch/reopen + clicking a "Nhật ký" row
      // must keep working even when the CentriX session flaps to logged-out. Bailing here was why
      // "after closing a service, reopening / clicking history did nothing".
      await refresh().catch(() => {});
    }
    const requestedUrl = cleanUrl(targetUrl) || cleanUrl(service.url);
    const previousBrowser = { ...(state.browser || {}) };
    const sameActiveService = previousBrowser.activeServiceId === service.id;
    const keepCurrentBrowser = Boolean(sameActiveService && previousBrowser.opening !== true);
    const frozenBounds = previousBrowser.activeServiceId
      ? (cleanBrowserBounds(previousBrowser.lastState?.bounds) || cleanBrowserBounds(lastSentBrowserBounds) || measureBrowserBounds())
      : null;
    let loadingNoticeStartedAt = 0;
    if (keepCurrentBrowser) {
      state.browser = {
        ...previousBrowser,
        pendingServiceId: service.id,
        pendingServiceName: service.name || service.id,
        opening: false,
        error: ""
      };
    } else {
      loadingNoticeStartedAt = nowMs();
      if (frozenBounds) {
        pendingPredictedBrowserBounds = {
          bounds: frozenBounds,
          until: nowMs() + 1400
        };
      }
      state.browser = {
        activeServiceId: service.id,
        activeServiceName: service.name || service.id,
        opening: true,
        error: ""
      };
      showStaticBrowserService(service, true);
      if (frozenBounds) sendBrowserBounds(frozenBounds, { force: true });
      ensureServiceLoadingOverlay();
      if (previousBrowser.activeServiceId) {
        await bridge.browser.home?.().catch(() => null);
        ensureServiceLoadingOverlay();
      }
      syncBrowserBoundsSoon();
      await waitForNextPaint();
      await waitForServiceLoadingNotice(loadingNoticeStartedAt);
    }
    ensureBadge();
    ensureBrowserControl();
    publishState();
    if (keepCurrentBrowser) syncBrowserBoundsBurst();
    const bounds = frozenBounds || await syncBrowserBoundsNow();
    try {
      const browserState = await bridge.browser.openService({
        serviceId: service.id,
        // Send the full service so main can open it even when main's own `services` list is empty
        // (cleared on session expiry) while the renderer still shows it from cache — otherwise main
        // throws "No services loaded from server" / "Unknown serviceId" and nothing opens.
        service: {
          id: service.id,
          name: service.name,
          url: service.url,
          iconUrl: service.iconUrl,
          modelPricingEnabled: service.modelPricingEnabled,
          defaultModel: service.defaultModel,
          defaultCreditCost: service.defaultCreditCost,
          uiRules: service.uiRules,
          modelPolicy: service.modelPolicy,
          modelPrices: service.modelPrices
        },
        bounds,
        url: requestedUrl
      });
      if (requestSerial !== openServiceSerial) return state.browser;
      state.browser = {
        ...(state.browser || {}),
        activeServiceId: service.id,
        activeServiceName: service.name || service.id,
        pendingServiceId: "",
        pendingServiceName: "",
        opening: false,
        error: "",
        lastState: browserState || null
      };
      clearStaticRunningPlaceholder();
      recordUrlHistory({
        serviceId: service.id,
        serviceName: service.name,
        url: browserState?.url || requestedUrl || service.url,
        title: browserState?.title || service.name,
        action: "open-service",
        at: Date.now()
      });
    } catch (error) {
      if (requestSerial !== openServiceSerial) return state.browser;
      if (keepCurrentBrowser) {
        state.browser = {
          ...previousBrowser,
          opening: false,
          error: error.message || "Cannot open browser"
        };
      } else {
        state.browser.opening = false;
        state.browser.error = error.message || "Cannot open browser";
        showStaticBrowserService(service, false);
      }
    }
    publishState();
    ensureBadge();
    ensureBrowserControl();
    syncBrowserBoundsBurst();
    setTimeout(syncBrowserBoundsInstant, 96);
  }

  function topupPayloadFromUi(target) {
    // Prefer the package the user SELECTED in our patched grid so "Thanh to\u00e1n" buys exactly that one
    // (not whatever the design's own summary defaulted to).
    const selPkg = portalPackagesList().find((p) => p.id === state.selectedBuyPkgId);
    if (selPkg) {
      let credits = (Number(selPkg.credits) || 0) + (Number(selPkg.bonusCredits) || 0);
      let amount = Number(selPkg.price) || 0;
      const promo = state.activeBuyPromo;
      if (promo) {
        const eff = promoEffect(promo, amount);
        amount = Math.max(0, amount - eff.discount);
        credits += eff.bonus;
      }
      return {
        packageId: selPkg.id,
        credits,
        amount: Math.max(0, amount),
        currency: selPkg.currency || "VND",
        // Payment goes through SePay (VietQR bank transfer); the SePay webhook auto-credits on payment.
        note: ["App User UI checkout", "method=SePay", promo ? `promo=${promo.code}` : ""].filter(Boolean).join("; ")
      };
    }
    const creditText = valueAfterLabel("G\u00f3i credit") || document.body.innerText;
    const credits = numberFromText(creditText) || 500;
    const packageByCredit = {
      100: "ui-pkg-100",
      500: "ui-pkg-500",
      1000: "ui-pkg-1000",
      5000: "ui-pkg-5000"
    };
    const totalText = valueAfterLabel("T\u1ed5ng c\u1ed9ng") || target?.textContent || "";
    const amount = numberFromText(totalText);
    const method = valueAfterLabel("Ph\u01b0\u01a1ng th\u1ee9c") || "VietQR";
    const promo = firstVisibleInput((input) => fold(input.placeholder).includes("nhap ma"))?.value || "";

    return {
      packageId: packageByCredit[credits] || "",
      credits,
      amount,
      currency: "VND",
      note: [
        "App User UI checkout",
        method ? `method=${method}` : "",
        promo ? `promo=${promo}` : ""
      ].filter(Boolean).join("; ")
    };
  }

  function supportPayloadFromUi() {
    const subjectInput = firstVisibleInput((input) => fold(input.placeholder).includes("khong tru dung credit"));
    const messageInput = firstVisibleInput((input) => fold(input.placeholder).includes("mo ta van de"));
    return {
      subject: cleanTemplateValue(subjectInput?.value) || "Yeu cau ho tro tu App User UI",
      message: cleanTemplateValue(messageInput?.value) || "Nguoi dung gui yeu cau ho tro tu man hinh App User.",
      priority: "normal",
      channel: "app-user-ui"
    };
  }

  async function submitTopup(target) {
    const bridge = api();
    // Luồng mới: MUA credit = TRỪ TIỀN VÍ VNĐ (không còn tạo đơn SePay ở đây). Nạp tiền vào ví là một
    // luồng riêng (openMoneyTopupPrompt → VietQR). Thiếu tiền ví → mời nạp thẳng.
    if (!bridge?.portal?.buyCreditMoney) { showActionToast("Phiên bản app chưa hỗ trợ mua bằng ví, vui lòng cập nhật", "error"); return; }
    if (!state.loginOk) {
      await refresh();
      if (!state.loginOk) return;
    }
    if (!state.selectedBuyPkgId) { showActionToast("Vui lòng chọn gói credit trước khi thanh toán", "error"); return; }
    const payload = topupPayloadFromUi(target);
    state.actions = { ...state.actions, pending: "Topup", error: "" };
    publishState();
    ensureBadge();
    try {
      const result = await bridge.portal.buyCreditMoney({ packageId: payload.packageId, credits: payload.credits, note: payload.note });
      state.actions = {
        pending: "",
        error: "",
        last: { type: "buy-credit", amount: payload.amount, credits: payload.credits, balance: result?.balance, moneyBalance: result?.moneyBalance }
      };
      const cfmt = Number(payload.credits || 0).toLocaleString("vi-VN");
      showActionToast(`Đã mua ${cfmt} credit từ ví VNĐ`);
      await refresh();
    } catch (error) {
      const msg = error?.message || String(error);
      const insufficient = /402|insufficient|khong du|không đủ/i.test(msg);
      state.actions = { pending: "", last: state.actions.last, error: msg };
      publishState();
      ensureBadge();
      if (insufficient) {
        showActionToast("Số dư ví VNĐ không đủ. Vui lòng nạp thêm tiền vào ví.", "error");
        try { openMoneyTopupPrompt(Number(payload.amount || 0)); } catch (e) {}
      } else {
        showActionToast("Mua credit không thành công, vui lòng thử lại", "error");
      }
    }
  }

  // ── VietQR top-up: show a scannable QR for the pending order + poll until SePay credits it ──────────
  // Self-contained overlay (own DOM, outside the static render tree) so a DCLogic re-render can't wipe it.
  // The receiving bank account comes from the App Server (state.portal.paymentConfig, env-driven) — NOT
  // hardcoded — so changing the account never needs an App User rebuild/re-sign.
  const cxVqEsc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function getPaymentConfig() {
    const p = state.portal || {};
    return p.paymentConfig || (p.portal && p.portal.paymentConfig) || null;
  }
  function buildVietQrUrl(order, cfg) {
    const bank = encodeURIComponent(String(cfg.bankBin || cfg.bankCode || "").trim());
    const acct = encodeURIComponent(String(cfg.accountNo || "").trim());
    const tpl = encodeURIComponent(String(cfg.template || "compact2").trim());
    const qs = new URLSearchParams({
      amount: String(Math.round(Number(order.amount) || 0)),
      addInfo: String(order.payCode || order.id || ""),
      accountName: String(cfg.accountName || "")
    });
    return `https://img.vietqr.io/image/${bank}-${acct}-${tpl}.png?${qs.toString()}`;
  }
  function ensureVietQrStyles() {
    if (document.getElementById("centrix-vietqr-style")) return;
    const s = document.createElement("style");
    s.id = "centrix-vietqr-style";
    s.textContent = `
      #centrix-vietqr{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);font-family:var(--cx-font-sans)}
      #centrix-vietqr .cx-vq-card{width:min(420px,92vw);max-height:92vh;overflow:auto;background:#fff;border-radius:18px;box-shadow:0 18px 60px rgba(0,0,0,.28);padding:22px}
      #centrix-vietqr h3{margin:0 0 2px;font-size:18px;color:#0f172a}
      #centrix-vietqr .cx-vq-sub{font-size:12.5px;color:#64748b;margin-bottom:14px}
      #centrix-vietqr .cx-vq-qr{display:block;width:236px;height:236px;margin:0 auto 12px;object-fit:contain;border-radius:12px;border:1px solid #e2e8f0;background:#f8fafc}
      #centrix-vietqr .cx-vq-row{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px dashed #e2e8f0;font-size:13.5px}
      #centrix-vietqr .cx-vq-row b{color:#0f172a;text-align:right;word-break:break-all}
      #centrix-vietqr .cx-vq-row span{color:#64748b;white-space:nowrap}
      #centrix-vietqr .cx-vq-amt b{color:#1e93f5;font-size:16px}
      #centrix-vietqr .cx-vq-copy{margin-left:6px;border:none;background:#eff6ff;color:#1e93f5;border-radius:7px;padding:2px 8px;font-size:11.5px;cursor:pointer}
      #centrix-vietqr .cx-vq-status{margin-top:14px;padding:10px 12px;border-radius:10px;font-size:13px;display:flex;align-items:center;gap:9px;background:#fff7ed;color:#9a3412}
      #centrix-vietqr .cx-vq-status.ok{background:#ecfdf5;color:#047857}
      #centrix-vietqr .cx-vq-status.err{background:#fef2f2;color:#b91c1c}
      #centrix-vietqr .cx-vq-spin{width:15px;height:15px;border-radius:50%;border:2.5px solid #fed7aa;border-top-color:#ea580c;animation:cx-vq-rot .8s linear infinite;flex:0 0 auto}
      @keyframes cx-vq-rot{to{transform:rotate(360deg)}}
      #centrix-vietqr .cx-vq-close{margin-top:14px;width:100%;border:1px solid #e2e8f0;background:#fff;color:#334155;border-radius:10px;padding:10px;font-size:14px;font-weight:600;cursor:pointer}
    `;
    (document.head || document.documentElement).appendChild(s);
  }
  let vietqrPollTimer = 0;
  function stopVietQrPoll() { if (vietqrPollTimer) { clearInterval(vietqrPollTimer); vietqrPollTimer = 0; } }
  function closeVietQrModal() { stopVietQrPoll(); document.getElementById("centrix-vietqr")?.remove(); }
  function setVietQrStatus(kind, msg) {
    const el = document.querySelector("#centrix-vietqr .cx-vq-status");
    if (!el) return;
    el.className = "cx-vq-status" + (kind === "paid" ? " ok" : (kind === "timeout" || kind === "err") ? " err" : "");
    el.innerHTML = kind === "waiting"
      ? `<span class="cx-vq-spin"></span><span>${cxVqEsc(msg || "Đang chờ xác nhận thanh toán…")}</span>`
      : `<span>${cxVqEsc(msg || "")}</span>`;
  }
  async function showVietQrModal(order) {
    let cfg = getPaymentConfig();
    if (!cfg || !cfg.accountNo) {
      try { const r = await api()?.portal?.summary(); const p = (r && (r.portal || r)) || null; if (p && p.paymentConfig) { state.portal = p; cfg = p.paymentConfig; } } catch { /* ignore */ }
    }
    if (!cfg || !cfg.accountNo || cfg.enabled === false) { showActionToast("Chưa cấu hình tài khoản nhận VietQR", "error"); return; }
    ensureVietQrStyles();
    closeVietQrModal();
    const amountTxt = (Number(order.amount) || 0).toLocaleString("vi-VN") + " đ";
    const payCode = String(order.payCode || order.id || "");
    const qrUrl = buildVietQrUrl(order, cfg);
    const copyBtn = (val) => `<button class="cx-vq-copy" data-cx-copy="${cxVqEsc(val)}">Copy</button>`;
    const wrap = document.createElement("div");
    wrap.id = "centrix-vietqr";
    wrap.innerHTML = `
      <div class="cx-vq-card" role="dialog" aria-modal="true">
        <h3>Quét VietQR để thanh toán</h3>
        <div class="cx-vq-sub">Mở app ngân hàng → quét mã, hoặc chuyển khoản theo thông tin bên dưới.</div>
        <img class="cx-vq-qr" alt="VietQR" src="${cxVqEsc(qrUrl)}" />
        <div class="cx-vq-row"><span>Ngân hàng</span><b>${cxVqEsc(cfg.bankCode || cfg.bankBin || "")}</b></div>
        <div class="cx-vq-row"><span>Số tài khoản</span><b>${cxVqEsc(cfg.accountNo)}${copyBtn(cfg.accountNo)}</b></div>
        <div class="cx-vq-row"><span>Chủ tài khoản</span><b>${cxVqEsc(cfg.accountName || "")}</b></div>
        <div class="cx-vq-row cx-vq-amt"><span>Số tiền</span><b>${cxVqEsc(amountTxt)}</b></div>
        <div class="cx-vq-row"><span>Nội dung CK</span><b>${cxVqEsc(payCode)}${copyBtn(payCode)}</b></div>
        <div class="cx-vq-status"></div>
        <button class="cx-vq-close">Đóng</button>
      </div>`;
    document.body.appendChild(wrap);
    setVietQrStatus("waiting");
    const qrImg = wrap.querySelector(".cx-vq-qr");
    if (qrImg) qrImg.addEventListener("error", () => { qrImg.style.display = "none"; });
    wrap.querySelector(".cx-vq-close")?.addEventListener("click", closeVietQrModal);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) closeVietQrModal(); });
    wrap.querySelectorAll("[data-cx-copy]").forEach((b) => b.addEventListener("click", () => {
      try { navigator.clipboard.writeText(b.getAttribute("data-cx-copy") || ""); b.textContent = "Đã copy"; setTimeout(() => { b.textContent = "Copy"; }, 1200); } catch { /* ignore */ }
    }));
    startVietQrPoll(order.id);
  }
  function startVietQrPoll(orderId) {
    stopVietQrPoll();
    const deadline = Date.now() + 15 * 60 * 1000; // give up after 15 min (SePay still credits server-side)
    const tick = async () => {
      if (Date.now() > deadline) { stopVietQrPoll(); setVietQrStatus("timeout", "Hết thời gian chờ. Nếu đã chuyển, số dư sẽ tự cập nhật."); return; }
      try {
        const r = await api()?.portal?.summary();
        const portal = (r && (r.portal || r)) || {};
        const order = (portal.orders || []).find((o) => o.id === orderId);
        if (order && (order.creditedAt || /approved|paid|completed|credited/i.test(String(order.status || "")))) {
          stopVietQrPoll();
          if (portal.orders || portal.wallet) state.portal = portal;
          await refresh().catch(() => {});
          patchVisibleCreditTextsSoon();
          const isMoney = String(order.kind || "").toLowerCase() === "money";
          setVietQrStatus("paid", isMoney
            ? `Đã thanh toán! +${(Number(order.amount) || 0).toLocaleString("vi-VN")} đ vào ví VNĐ.`
            : `Đã thanh toán! +${(Number(order.credits) || 0).toLocaleString("vi-VN")} credit đã được cộng.`);
          setTimeout(closeVietQrModal, 3500);
        }
      } catch { /* keep polling */ }
    };
    vietqrPollTimer = setInterval(tick, 4000);
    setTimeout(tick, 1500);
  }

  // ── NẠP TIỀN VÍ VNĐ qua SePay VietQR ─────────────────────────────────────────────────────────────
  // Tạo đơn kind="money" (chỉ số tiền) → dùng lại showVietQrModal (QR + poll). SePay khớp payCode → dbapi
  // approve_portal_topup cộng thẳng vào VÍ VNĐ (Phase 2). Bấm thẻ "SỐ DƯ VNĐ" ở Tổng quan để mở.
  async function startMoneyTopup(amountVnd) {
    const bridge = api();
    if (!bridge?.portal?.topupRequest) { showActionToast("Chưa sẵn sàng", "error"); return; }
    const amt = Math.round(Number(amountVnd) || 0);
    if (!(amt >= 1000)) { showActionToast("Số tiền tối thiểu 1.000đ", "error"); return; }
    try {
      const result = await bridge.portal.topupRequest({ kind: "money", amount: amt, currency: "VND", note: "Nap vi VND; method=SePay" });
      const order = (result && (result.order || result)) || null;
      if (order && order.id) { closeMoneyTopupPrompt(); showVietQrModal(order).catch(() => {}); }
      else showActionToast("Tạo đơn nạp thất bại", "error");
    } catch (e) { showActionToast("Lỗi tạo đơn nạp tiền", "error"); }
  }
  function closeMoneyTopupPrompt() { document.getElementById("centrix-money-topup")?.remove(); }
  function openMoneyTopupPrompt(prefillAmount) {
    if (document.getElementById("centrix-vietqr") || document.getElementById("centrix-money-topup")) return;
    ensureVietQrStyles();
    const quick = [50000, 100000, 200000, 500000, 1000000];
    const wrap = document.createElement("div");
    wrap.id = "centrix-money-topup";
    wrap.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.55);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);font-family:var(--cx-font-sans),system-ui,sans-serif;";
    wrap.innerHTML = `
      <div style="width:min(420px,92vw);background:#fff;border-radius:18px;box-shadow:0 18px 60px rgba(0,0,0,.28);padding:22px;">
        <div style="font-size:18px;font-weight:900;color:#0f172a;">Nạp tiền vào ví VNĐ</div>
        <div style="font-size:12.5px;color:#64748b;margin:2px 0 16px;">Chuyển khoản qua VietQR (SePay). Tiền vào ví VNĐ để mua credit / gói cước.</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
          ${quick.map((q) => `<button type="button" data-cx-money-q="${q}" style="border:1px solid #cbd5e1;border-radius:10px;background:#f8fafc;color:#0f172a;font:800 13px var(--cx-font-sans);padding:11px 0;cursor:pointer;">${q.toLocaleString("vi-VN")}</button>`).join("")}
        </div>
        <label style="display:block;font:800 10.5px var(--cx-font-sans);color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Hoặc nhập số tiền (VND)</label>
        <input id="cx-money-amt" type="number" step="10000" min="1000" placeholder="vd 100000" style="width:100%;height:46px;border:1px solid #cbd5e1;border-radius:11px;padding:0 13px;box-sizing:border-box;font:800 16px var(--cx-font-sans);margin-top:6px;">
        <div style="display:flex;gap:10px;margin-top:18px;">
          <button type="button" id="cx-money-cancel" style="flex:1;height:44px;border:1px solid #cbd5e1;border-radius:11px;background:#fff;color:#475569;font:800 13px var(--cx-font-sans);cursor:pointer;">Hủy</button>
          <button type="button" id="cx-money-go" style="flex:1.5;height:44px;border:0;border-radius:11px;background:#1e93f5;color:#fff;font:900 13px var(--cx-font-sans);cursor:pointer;box-shadow:0 6px 16px rgba(30,147,245,.32);">Tạo mã VietQR</button>
        </div>
      </div>`;
    (document.body || document.documentElement).appendChild(wrap);
    const amtEl = wrap.querySelector("#cx-money-amt");
    // Prefill khi được mở từ "mua nhưng thiếu tiền" (làm tròn lên bội 10.000 để tiện chuyển khoản).
    const pf = Number(prefillAmount || 0);
    if (pf > 0) amtEl.value = String(Math.max(1000, Math.ceil(pf / 10000) * 10000));
    wrap.addEventListener("click", (e) => { if (e.target === wrap) closeMoneyTopupPrompt(); });
    wrap.querySelectorAll("[data-cx-money-q]").forEach((b) => b.addEventListener("click", () => { amtEl.value = b.getAttribute("data-cx-money-q"); }));
    wrap.querySelector("#cx-money-cancel")?.addEventListener("click", closeMoneyTopupPrompt);
    wrap.querySelector("#cx-money-go")?.addEventListener("click", () => startMoneyTopup(amtEl.value));
    setTimeout(() => amtEl?.focus(), 30);
  }
  // Bấm thẻ "SỐ DƯ VNĐ" (Tổng quan) → MỞ TAB VÍ TIỀN (không mở form nạp ngay tại Tổng quan). Nạp tiền chỉ thực
  // hiện ở màn Ví tiền. Delegate 1 lần trên document (thẻ do template render).
  if (!window.__cxMoneyCardWired) {
    window.__cxMoneyCardWired = true;
    document.addEventListener("click", (e) => {
      let el = e.target;
      for (let i = 0; i < 6 && el && el.getAttribute; i++) {
        const txt = (el.textContent || "").trim();
        if (/^SỐ DƯ VNĐ/i.test(txt) && txt.length < 160) { e.preventDefault(); e.stopPropagation(); try { openWalletScreen(); } catch (err) {} return; }
        el = el.parentElement;
      }
    }, true);
  }

  async function submitSupport() {
    const bridge = api();
    if (!bridge?.portal?.supportTicket) return;
    if (!state.loginOk) {
      await refresh();
      if (!state.loginOk) return;
    }
    const payload = supportPayloadFromUi();
    state.actions = { ...state.actions, pending: "Support", error: "" };
    publishState();
    ensureBadge();
    try {
      const result = await bridge.portal.supportTicket(payload);
      state.portal = result?.portal || state.portal;
      state.actions = {
        pending: "",
        error: "",
        last: {
          type: "support",
          id: result?.ticket?.id || "",
          status: result?.ticket?.status || "",
          subject: result?.ticket?.subject || payload.subject
        }
      };
      showActionToast("Đã gửi yêu cầu hỗ trợ");
      await refresh();
    } catch (error) {
      state.actions = { pending: "", last: state.actions.last, error: error.message || String(error) };
      showActionToast("Gửi yêu cầu hỗ trợ không thành công, vui lòng thử lại", "error");
      publishState();
      ensureBadge();
    }
  }

  async function closeBrowser() {
    const bridge = api();
    openServiceSerial += 1;
    try {
      await bridge?.browser?.home?.();
    } catch {
      // Best effort: detach the BrowserView when navigation changes.
    }
    state.browser = {
      activeServiceId: "",
      activeServiceName: "",
      opening: false,
      error: ""
    };
    clearStaticBrowserService();
    publishState();
    ensureBadge();
    ensureBrowserControl();
  }

  // ── Plan-gating live sync ────────────────────────────────────────────────────
  // Admin plan edits reach the App User ONLY by polling /api/users/plans/me. refresh() (30s) already
  // re-fetches planTier but never re-paints the sidebar nor CLOSES a service that just became blocked,
  // so a disallowed service can linger up to ~30s — and for services with no server-side model-request
  // pattern (the network gate in remote-user-main.js only fires for mapped services) the client filter is
  // the ONLY guard. This lightweight layer closes that gap with a planMe-only poll (NO full refresh()):
  // pull the latest plan, force-close a now-blocked open service, and re-paint the sidebar ONLY when
  // gating actually changed (so steady-state polling causes zero re-render / no flicker).
  let planSyncTimer = 0;
  let planSyncFocusTimer = 0;
  let lastPlanSyncAt = 0;

  function repaintSidebarForPlan() {
    // Re-run the patched renderVals → applyLiveServiceVals re-applies the planBlocksService filter.
    try {
      const logic = patchedStaticLogic || staticLogic();
      if (logic && logic.setState) logic.setState({ __planRefresh: Date.now() });
    } catch { /* re-render best-effort */ }
  }

  // Close the embedded service if the (possibly just-updated) plan now blocks it. Cheap + idempotent;
  // a no-op unless the gate is "on" AND the open service's id is in state.planTier.blockedServices.
  function enforcePlanOnOpenService() {
    const openId = state.browser && state.browser.activeServiceId;
    if (!openId || !planBlocksService(openId)) return false;
    showActionToast("Gói " + (((state.planTier || {}).current) || "Free") + " không còn dùng được dịch vụ này — đã đóng.", "error");
    closeBrowser().then(showStaticAppScreenSoon).catch(() => { try { showStaticAppScreenSoon(); } catch { /* ignore */ } });
    return true;
  }

  // Pull latest plan, then close any now-blocked open service + re-paint the sidebar on change.
  // `force` bypasses the 12s dedup guard (used by focus/visibility for promptness).
  async function syncPlanTier(force) {
    if (state.loggedOut || !state.loginOk) return;
    const now = Date.now();
    if (!force && now - lastPlanSyncAt < 12000) { enforcePlanOnOpenService(); return; } // refresh() fetched recently → no double-poll
    lastPlanSyncAt = now;
    const beforeBlocked = JSON.stringify(((state.planTier || {}).blockedServices) || []);
    const beforeGate = (state.planTier || {}).gate;
    await ensurePlanLoaded(true).catch(() => {});
    const changed = beforeBlocked !== JSON.stringify(((state.planTier || {}).blockedServices) || [])
      || beforeGate !== (state.planTier || {}).gate;
    const closed = enforcePlanOnOpenService();
    if (changed || closed) repaintSidebarForPlan(); // re-paint only when gating actually changed (no flicker)
  }

  function startPlanSyncPoll() {
    if (planSyncTimer) return;
    planSyncTimer = setInterval(() => { syncPlanTier(false).catch(() => {}); scheduleAccountStateRefresh(0); }, 20000); // 20s: plan + credit balance (admin top-ups show within 20s)
    const onActive = () => {
      if (document.visibilityState === "hidden") return;
      clearTimeout(planSyncFocusTimer);
      planSyncFocusTimer = setTimeout(() => { syncPlanTier(true).catch(() => {}); scheduleAccountStateRefresh(0); }, 150); // refresh plan + credit on focus → an admin top-up shows IMMEDIATELY when you switch back to the App User
    };
    document.addEventListener("visibilitychange", onActive);
    window.addEventListener("focus", onActive);
  }

  function scheduleLayoutRefresh() {
    polishCollapsedSidebar();
    disableStaticSidebarTransition();
    syncBrowserBoundsBurst();
    for (const delay of [32, 96]) {
      setTimeout(() => {
        polishCollapsedSidebar();
        disableStaticSidebarTransition();
        syncBrowserBoundsInstant();
      }, delay);
    }
  }

  function setStaticView(view) {
    const logic = staticLogic();
    if (!logic?.setState) return false;
    try {
      logic.setState({ screen: "app", view });
      return true;
    } catch {
      return false;
    }
  }

  function toggleStaticSidebar() {
    const logic = staticLogic();
    if (!logic?.setState) return false;
    try {
      const nextCollapsed = logic.state?.collapsed !== true;
      disableStaticSidebarTransition();
      logic.setState({ collapsed: nextCollapsed });
      scheduleLayoutRefresh();
      return true;
    } catch {
      return false;
    }
  }

  function toggleStaticTheme() {
    const logic = staticLogic();
    if (!logic?.setState) return false;
    try {
      const next = logic.state?.theme === "dark" ? "light" : "dark";
      logic.setState({ theme: next });
      return true;
    } catch {
      return false;
    }
  }

  function focusStaticSearch() {
    const input = Array.from(document.querySelectorAll("input"))
      .find((item) => {
        if (!visible(item)) return false;
        const text = fold([item.placeholder, item.getAttribute("aria-label"), item.value].join(" "));
        return text.includes("tim") || text.includes("search") || text.includes("loc");
      }) || Array.from(document.querySelectorAll("input")).find(visible);
    input?.focus?.();
    input?.select?.();
  }

  function openDefaultChatService() {
    const service = servicesByName().find((item) => /chatgpt/i.test(item.name || "")) || servicesByName()[0];
    if (service) openService(service);
  }

  function registerBridgeEvents() {
    if (menuEventsRegistered) return;
    const bridge = api();
    if (!bridge?.on) return;
    menuEventsRegistered = true;
    const listen = (channel, handler) => {
      try {
        bridge.on(channel, handler);
      } catch {
        // Older preloads may not expose every channel.
      }
    };
    listen("browser:navigation", (payload) => {
      applyBrowserStateSnapshot(payload || {}, { source: "browser:navigation" });
      recordUrlHistory({
        serviceId: payload?.serviceId || payload?.activeServiceId || state.browser.activeServiceId,
        serviceName: payload?.serviceName || state.browser.activeServiceName,
        url: payload?.url || "",
        title: payload?.title || "",
        action: "navigate",
        at: Date.now()
      });
      ensureBrowserNavToolbar();
    });
    listen("browser:loading", (payload) => {
      state.browser.lastState = { ...(state.browser.lastState || {}), ...(payload || {}) };
      ensureBrowserNavToolbar();
    });
    listen("browser:title", (payload) => {
      const title = String(payload?.title || "").trim();
      if (!title) return;
      state.browser.lastState = { ...(state.browser.lastState || {}), title };
      updateHistoryTitleForActiveUrl(title);
    });
    listen("browser:prepare", (payload) => {
      applyBrowserPrepareSnapshot(payload || {});
    });
    listen("browser:download", (payload) => {
      // In-app toast (bonus). The reliable, always-visible feedback is the native OS notification fired from
      // main (the service view overlays this DOM), so we skip progress here to avoid toast spam.
      const p = payload || {};
      const name = String(p.filename || "tệp").slice(0, 80);
      if (p.state === "start") showActionToast("⬇ Đang tải " + name + "…", "ok");
      else if (p.state === "done") showActionToast("✓ Đã tải " + name + " về thư mục Downloads", "ok");
      else if (p.state === "fail") showActionToast(p.reason === "rate-limited" ? "Quá nhiều lượt tải cùng lúc — thử lại sau" : ("✗ Tải " + name + " thất bại"), "error");
    });
    listen("browser:error", (payload) => {
      const message = payload?.errorDescription || payload?.message || "Khong tai duoc giao dien dich vu";
      state.browser = {
        ...(state.browser || {}),
        opening: false,
        error: message,
        lastState: {
          ...(state.browser?.lastState || {}),
          ...(payload || {}),
          lastError: message,
          source: "browser:error"
        }
      };
      publishState();
      showActionToast(message);
      ensureBrowserNavToolbar();
    });
    listen("credit:usage", (payload) => {
      applyCreditUsagePayload(payload || {}); // instant optimistic balance + state update
      // Instant full sync: refetch account + portal NOW so "Hoạt động gần đây" / "Lịch sử" / "Tiêu thụ theo
      // dịch vụ" / "Khấu trừ theo thời gian thực" reflect the new charge at once (not after the 30s poll),
      // then re-render every credit widget.
      refreshAccountState().catch(() => {});
      for (const d of [0, 90, 240]) setTimeout(patchVisibleCreditTexts, d);
      scheduleActivityHistoryRefresh();
    });
    listen("connection:expired", (payload) => {
      // Real token expiry/sign-out from main. The refresh() poll deliberately KEEPS the last
      // balance on a transient /api/me failure, so a genuine expiry must clear the wallet here —
      // otherwise the UI would keep showing a stale "Số dư · X cr" after the session is dead.
      state.loggedOut = true; // keep the login screen until an explicit re-login (don't flip back)
      state.loginIntent = false; // expiry/sign-out — block any flip back to the app screen
      state.account = null;
      state.portal = null;
      state.loginOk = false;
      clearAccountCaches(); // expiry/sign-out: drop cached account data so a re-login can't show stale data
      state.updatedAt = new Date().toISOString();
      removeEvictBanner(); // we're now logged out; the takeover countdown banner has served its purpose
      hideHydrationMask(); // never leave the login screen masked
      publishState();
      patchVisibleCreditTextsSoon();
      // Admin "Khóa tài khoản": show a clear reason instead of a silent return to the login screen.
      if (payload && payload.reason === "account-locked") {
        setTimeout(() => showActionToast(payload.message || "Tài khoản đã bị khóa — liên hệ quản trị viên", "error"), 120);
      }
    });
    listen("connection:restored", () => {
      // PERSISTENT LOGIN: main reconnected from the sealed session on boot. Unlock the flip and reveal the app
      // (mirrors a fresh Google login's post-connect state, minus the OAuth window).
      state.loggedOut = false;
      state.loginIntent = true;
      showStaticAppScreenSoon();
    });
    listen("session:evicting", (payload) => {
      // Another device took over this account. Show the 5s countdown; main pushes cookies then logs us out.
      showEvictBanner(payload && payload.graceMs, payload && payload.message);
    });
    listen("version:lock", (payload) => {
      // Server marked this build blocked/too-old. Main already closed every tab + froze traffic; paint the
      // full-screen lock. Un-dismissable — lifts only on "version:unlock" when the admin re-allows the version.
      showVersionLockOverlay(payload || {});
    });
    listen("version:unlock", () => {
      removeVersionLockOverlay();
    });
    // In-app auto-update (non-forced): offer → download-with-progress → installer launched.
    listen("update:available", (info) => { showUpdateAvailableDialog(info || {}); });
    listen("update:progress", (p) => { showUpdateProgress(p || {}); });
    listen("update:installing", (p) => { showUpdateInstalling(p && p.version); });
    listen("update:launched", () => { showUpdateLaunched(); });
    refreshDesktopVersion(); // show the REAL app version in the header (design template bakes a stale one)
    listen("update:error", (e) => { showUpdateError(e && e.reason); });
    listen("account:lock", (payload) => {
      // Admin locked this account. Main already closed every tab + froze traffic; paint the full-screen
      // freeze. Un-dismissable — lifts to the login screen when the admin unlocks (main sends account:unlock).
      showAccountLockOverlay(payload || {});
    });
    listen("account:unlock", () => {
      // Admin unlocked the account. Locking revoked the session server-side, so we can't silently resume —
      // run a REAL logout to the login screen (self-revoke + cookie wipe via disconnect) and tell the user.
      removeAccountLockOverlay();
      setTimeout(() => showActionToast("Tài khoản đã được mở khóa. Vui lòng đăng nhập lại.", "ok"), 120);
      performLogoutTeardown({ force: true }); // lock already set state.loggedOut → force the real teardown to login
    });
    listen("menu:new-chat", openDefaultChatService);
    listen("menu:open-settings", () => setStaticView("settings"));
    listen("menu:find-chat", focusStaticSearch);
    listen("menu:delete-chat", closeBrowser);
    listen("menu:toggle-sidebar", toggleStaticSidebar);
    listen("menu:toggle-theme", toggleStaticTheme);
    listen("menu:show-shortcuts", () => showActionToast("Ctrl+N, Ctrl+F, Ctrl+B, Ctrl+T, Ctrl+S, F11"));
    listen("menu:check-updates", () => showActionToast(`CentriX AI Desktop v${_realAppVersion || ""} is up to date`.replace(/ v is/, " is")));
    listen("menu:contact-support", () => setStaticView("support"));
    listen("menu:new-window", () => showActionToast("New App User window is handled by the main process"));
  }

  function observeLayoutResize() {
    if (layoutResizeObserver || !window.ResizeObserver || !document.body) return;
    layoutResizeObserver = new ResizeObserver(() => {
      stableServiceBounds = null; // an observed layout box changed size → the locked rect is stale by definition
      syncBrowserBoundsInstant();
    });
    layoutResizeObserver.observe(document.body);
    const logicRoot = Array.from(document.querySelectorAll("body > div,main,section"))
      .find((element) => visible(element));
    if (logicRoot) layoutResizeObserver.observe(logicRoot);
  }

  window.addEventListener("pointerdown", onWindowServiceOpenIntent, true);
  window.addEventListener("mousedown", onWindowServiceOpenIntent, true);
  window.addEventListener("click", onWindowServiceOpenIntent, true);

  document.addEventListener("click", (event) => {
    const windowAction = event.target?.closest?.("[data-centrix-window-action]")?.dataset?.centrixWindowAction;
    if (windowAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setTimeout(() => runWindowAction(windowAction), 0);
      return;
    }

    const browserNavAction = event.target?.closest?.("[data-centrix-browser-nav-action]")?.dataset?.centrixBrowserNavAction;
    if (browserNavAction) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.target.closest("[data-centrix-browser-nav-action]")?.getAttribute("aria-disabled") === "true") {
        return;
      }
      setTimeout(() => runBrowserNav(browserNavAction), 0);
      return;
    }

    if (event.target?.closest?.("#centrix-user-service-close,#centrix-user-browser-control")) {
      closeBrowser();
      return;
    }

    const service = serviceFromClick(event.target);
    if (service) {
      dispatchStaticServiceOpen(service, event);
      return;
    }

    const target = event.target?.closest?.("button,div");
    const label = fold(target?.textContent || "").trim();
    // Only the actual "Đăng nhập" submit button logs in — its OWN text is exactly "đăng nhập". Previously
    // this matched label.includes("dang nhap"), so a click on the account/password field (whose closest
    // div is the login form container that *contains* the button) auto-logged-in and blocked editing.
    // Require an exact match + a non-form-field target so the account/password fields stay editable and
    // the user only logs in by pressing the button. ("Đăng nhập bằng Google" is also excluded.)
    const isFormField = /^(input|textarea|select)$/i.test(event.target?.tagName || "");
    const targetIsButton = /^button$/i.test(target?.tagName || "") || target?.getAttribute?.("role") === "button";
    // The submit button's OWN text is "đăng nhập" (exact), OR it's a <button> whose short text contains it
    // (allowing a spinner/icon) — but never the "Đăng nhập bằng Google" button. A click on the form
    // container (a long-text div) or the account/password field must NOT log in.
    // Match BOTH texts: the design's original "Đăng nhập bằng Google" AND our restyled "Tiếp tục với
    // Google" (patchLoginForm). CRITICAL: if this matcher misses, the click falls through to the design's
    // inline onLogin = its DEMO login() → setState({screen:'app'}) + "Đăng nhập thành công" flash → the
    // FAKE "Trần Xuân Lộc" dashboard. That looked like "app dính bản cũ" after the button text changed.
    if (!isFormField && targetIsButton && label.includes("google") && (label.includes("dang nhap") || label.includes("tiep tuc"))) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setTimeout(() => loginWithGoogleFromStatic(), 0);
      return;
    }
    // NEVER treat clicks inside the usage-history screen ([data-cx-uh2] root) as a login: its "Đăng nhập"
    // FILTER chip (text "Đăng nhập" + count) and login-activity rows/badges fold to "dang nhap" and were
    // wrongly firing the login toast. This document handler is CAPTURE phase, so it runs BEFORE wireUh2's
    // bubble handler and its stopImmediatePropagation would block the filter — the guard MUST live here (a
    // stopPropagation inside wireUh2 cannot cancel an already-fired capture handler). We key off
    // [data-cx-uh2] (set at render, line 4699) not [data-cx-uh2-wired] (set later at wire time) so the guard
    // holds even on the first click before wiring runs. Those clicks belong to wireUh2's filter handler.
    const inUsageHistory = !!event.target?.closest?.("[data-cx-uh2]");
    const isPrimaryLogin =
      label === "dang nhap" ||
      (targetIsButton && label.includes("dang nhap") && !label.includes("google") && label.length <= 24);
    if (!isFormField && !inUsageHistory && isPrimaryLogin) {
      // Password login REMOVED — Google-only client. Swallow the click; never submit credentials.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      showActionToast("Vui lòng đăng nhập bằng Google", "error");
      return;
    }

    const screenText = fold(document.body?.innerText || "");
    if (label.includes("thanh toan") && screenText.includes("chon goi credit")) {
      // Suppress the design's inline onclick={{onPay}} → this.flash("Đang xử lý thanh toán…") mock toast.
      // This is a CAPTURE-phase document handler, so stopImmediatePropagation prevents the event from ever
      // reaching the button node — only submitTopup's REAL toast (order created / choose-a-package) shows.
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      setTimeout(() => submitTopup(target), 0);
      return;
    }

    if (label === "gui yeu cau" && screenText.includes("gui yeu cau ho tro")) {
      setTimeout(() => submitSupport(), 0);
      return;
    }

    if (state.browser.activeServiceId && clickedNav(target)) {
      setTimeout(closeBrowser, 0);
    }
  }, true);

  document.addEventListener("dblclick", (event) => {
    const target = event.target;
    if (
      target?.closest?.("[data-centrix-window-no-drag='1'],[data-centrix-window-action],button,input,textarea,select,a,label")
    ) {
      return;
    }
    if (target?.closest?.("[data-centrix-window-drag='1']")) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setTimeout(() => runWindowAction("maximize"), 0);
    }
  }, true);

  window.centrixUserApiUiRefresh = refresh;
  window.centrixUserOpenService = async (serviceId) => {
    let service = (state.services || []).find((item) => item.id === serviceId);
    if (!service) {
      await refresh();
      service = (state.services || []).find((item) => item.id === serviceId);
    }
    return openService(service);
  };
  window.centrixUserCloseBrowser = closeBrowser;
  window.centrixUserSubmitTopup = () => submitTopup(document.activeElement);
  window.centrixUserSubmitSupport = submitSupport;

  let bridgeStarted = false;
  function startBridge() {
    if (bridgeStarted) return;
    bridgeStarted = true;
    // Nav "Ví tiền" HIỆN NGAY cùng các menu khác: vòng lặp ngắn (80ms) chèn ngay khi thanh nav design xuất hiện,
    // KHÔNG chờ refresh 800ms → hết cảnh "load xíu mới hiện Ví tiền". Dừng khi đã chèn (hoặc sau ~5s an toàn).
    try {
      let __wtick = 0;
      const __witv = setInterval(() => {
        try { ensureWalletNav(); } catch (e) { /* ignore */ }
        __wtick += 1;
        if (document.getElementById("cx-wallet-nav") || __wtick > 60) clearInterval(__witv);
      }, 80);
    } catch (e) { /* ignore */ }
    installTypographySystem();
    installStableServiceLayout();
    loadLocalUrlHistory();
    publishState();
    hydrateStaticDefaults();
    registerBridgeEvents();
    // Login form: seed from the saved last-login (when "Lưu tài khoản" is on) and keep it editable —
    // no baked-in sample account, no auto-submit. Typing into the fields updates the intended login.
    const savedLogin = loadSavedLogin();
    if (savedLogin) state.loginDraft = { email: savedLogin.email, password: "" };
    prefillLoginForm();
    document.addEventListener("input", (event) => {
      if (state.loginOk) return;
      const input = event.target;
      if (!input || input.tagName !== "INPUT") return;
      // Capture typing straight from the field being edited so the saved/prefill value never resets it.
      // On the login screen the only fields are the account + password, so any non-checkbox/number text
      // input is the account/email.
      if (input.type === "password") {
        state.loginDraft.password = String(input.value || "");
      } else if (!["checkbox", "radio", "number", "range", "file"].includes(input.type)) {
        state.loginDraft.email = cleanTemplateValue(input.value);
      }
    }, true);
    // Logout: the design only flips to the login screen — run a real disconnect so the service
    // browsers close and main drops the connection (no flip-back / "auto re-login"). Fast path detects
    // a labeled logout control; the transition check catches any other control that flips app→login.
    document.addEventListener("click", (event) => {
      handleLogoutClickIntent(event.target);
      handleLogoutTransitionAfterClick();
    }, true);
    // Capture phase so we run before the static UI's own onChangePw stub.
    document.addEventListener("click", (event) => {
      if (isChangePwTarget(event.target)) handleChangePwClick();
    }, true);
    // Capture the demo org buttons ("Thêm phòng ban" / "Mời thành viên") and run the REAL form+API
    // instead of the template's toast stub. Skip our own injected panel/modal so we don't double-fire.
    document.addEventListener("click", (event) => {
      const t = event.target;
      if (t && t.closest && t.closest("[data-cx-org-host],#centrix-org-modal")) return; // our own panels handle add directly
      const kind = orgButtonKind(t);
      if (!kind) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      if (kind === "dept") openDeptForm(); else openMemberForm();
    }, true);
    // GUARANTEED hook: the design's logout() (patched in index.html) calls window.__cxOnLogout BEFORE it
    // flips to the login screen — so every logout, no matter which control triggered it, runs the real
    // teardown (close ALL service browsers via main closeAll() + drop the connection) first.
    window.__cxOnLogout = () => { performLogoutTeardown(); };
    window.addEventListener("centrix:credit-usage", (event) => {
      applyCreditUsagePayload(event.detail || {});
      scheduleActivityHistoryRefresh();
    }, false);
    polishCollapsedSidebar();
    observeLayoutResize();
    enhanceWindowChromeSoon();
    setInterval(hydrateStaticDefaults, 500);
    setInterval(prefillLoginForm, 500); // keep the login form on the saved/typed account + remember box
    setInterval(enhanceWindowChromeSoon, 750);
    setInterval(syncBrowserBoundsSoon, 1000);
    // Re-apply the live wallet onto the "Tổng quan" dashboard credit cards periodically — that widget
    // is a separate static child component seeded with sample numbers (320/680/1000) that re-renders
    // on its own / on view change, so an event-only patch left it showing the seed until the next
    // refresh. This keeps it on the real balance within ~1.5s of navigating there.
    setInterval(patchVisibleCreditTexts, 1500);
    // Patch the credit widgets the MOMENT the static UI (re)renders them — inside the rAF that runs
    // BEFORE the next paint — so navigating to a tab never flashes the sample seed before the real
    // data loads. The renderer DOM only mutates on static re-renders (not from the native browser
    // view), so this stays cheap; the patches are idempotent (skip when unchanged).
    // Patch SYNCHRONOUSLY inside the observer callback (a microtask that runs after the DOM mutation
    // but BEFORE the browser paints) so the sample seed a re-render injects is overwritten with real
    // data in the same frame — no visible flash. Re-entrancy guard + idempotent patches prevent loops.
    let patchingWidgets = false;
    let lastFanoutVersion = "";
    const WIDGET_OBSERVE_OPTS = { childList: true, subtree: true };
    const widgetObserver = new MutationObserver(() => {
      if (patchingWidgets) return;
      // While the CSKH live-chat overlay is open, an arriving message mutates the DOM and fires this
      // observer, but the underlying portal screen + data are unchanged — running the ~13 DOM-scanning
      // patchers then is pure waste (a major chat-lag source). Skip when chat is open AND our data
      // version (state.updatedAt) is unchanged since the last real fan-out (navigation/refresh bump it).
      const chatOpen = !!(patchedStaticLogic || staticLogic())?.state?.chatOpen;
      const ver = String(state.updatedAt || "");
      if (chatOpen && ver === lastFanoutVersion) return;
      lastFanoutVersion = ver;
      domDirty = true; // a real (non-chat-skip) DOM mutation → the cached header anchors must re-scan this pass
      patchingWidgets = true;
      // CRITICAL (perf): STOP observing while WE mutate the DOM. Several patches below add/remove nodes
      // (rebuild the activity/usage lists, etc.). Observing {childList,subtree} on the whole <body> means
      // those self-caused mutations re-queue this callback as a fresh microtask — an endless loop that
      // pins the renderer at ~100% CPU even when idle (UI thread starved → typing lag; reported on macOS
      // v3.6.0). Disconnect + discard our own records + re-arm breaks the loop while keeping the patch run
      // SYNCHRONOUS (a re-render's demo seed is still overwritten before paint → no flash). The plain
      // re-entrancy guard alone did NOT help: it only blocks sync re-entry, not the async re-fire.
      widgetObserver.disconnect();
      try {
        patchDashboardCreditCards();
        patchRecentActivity();
        patchUsageHistory();
        patchOrders();
        patchInvoices();
        patchDevices();
        patchSupport();
        patchChatAutoScroll();
        patchBuyPackages();
        patchReportAudit();
        patchPricingTable();
        patchOrgSettingsView();
        hideOrgSettingsSection();
        applyAccountIdentity();
        patchMenuAccountName();
        patchAccountGooglePanel();
        restoreAccountFields();
        restoreVatFields();
        hideOrdersVatUpdateBtn();
        hidePasswordButton(); // run AFTER the security-card patch (see the other call site) so the card's
        // "Đổi mật khẩu" heading is still visible as the patch anchor before it gets hidden.
        syncUserTheme();
        applyOrgVisibility();
        // hideUnusedTabs(); // 2026-06-25: un-hidden at user request (2nd call site — widgetObserver tick). Re-enable to hide the 5 nav tabs again.
        applyPersonalPanelRow();
        patchOrgAdminPanel();
        maybeRevealAfterHydration();
        hideLoginCredUI();
        patchLoginHero();
        patchLoginForm();
      } finally {
        widgetObserver.takeRecords(); // drop the mutation records our own patches just generated
        try { widgetObserver.observe(document.body, WIDGET_OBSERVE_OPTS); } catch { /* ignore */ }
        domDirty = false; // re-synced → the 1500ms credit sweep + fan-outs reuse cached anchors until the next mutation
        patchingWidgets = false;
      }
    });
    try {
      widgetObserver.observe(document.body, WIDGET_OBSERVE_OPTS);
    } catch {
      // best-effort; the 1.5s interval still patches.
    }
    // Click a credit-package card → SELECT it (highlight + update the order summary). It must NOT pay —
    // only the "Thanh toán" button triggers payment (submitTopup → SePay/VietQR, already wired at ~6498).
    document.addEventListener("click", (event) => {
      const card = event.target?.closest?.("[data-cx-buy-pkg]");
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();
      const packageId = card.dataset.cxBuyPkg || "";
      if (packageId) selectBuyPackage(packageId);
    }, true);
    // Promo: "Áp dụng" validates the typed code; a promo chip (e.g. "WELCOME50 · Giảm 50%") fills + applies.
    document.addEventListener("click", (event) => {
      const leaf = event.target?.closest?.("button,[role='button'],div,span,a");
      if (!leaf || leaf.children.length > 2) return;
      const txt = (leaf.textContent || "").trim();
      if (fold(txt) === "ap dung") { event.preventDefault(); event.stopPropagation(); setTimeout(applyPromoFromInput, 0); return; }
      const codeMatch = txt.match(/^([A-Za-z0-9_]{3,24})\b/);
      if (codeMatch && findPromoByCode(codeMatch[1])) {
        event.preventDefault(); event.stopPropagation();
        const input = firstVisibleInput((i) => fold(i.placeholder).includes("nhap ma"));
        if (input) input.value = codeMatch[1].toUpperCase();
        setTimeout(applyPromoFromInput, 0);
      }
    }, true);
    // Account tab (Google login): "Quản lý trên Google" / "Đăng xuất tất cả thiết bị", and persist a typed
    // phone locally on "Lưu thay đổi" (there is no backend phone field) so the number sticks on reload.
    document.addEventListener("click", (event) => {
      const act = event.target?.closest?.("[data-cx-account-action]")?.dataset?.cxAccountAction;
      if (act === "google-manage") { event.preventDefault(); event.stopPropagation(); try { window.open("https://myaccount.google.com/security", "_blank"); } catch { /* ignore */ } return; }
      if (act === "signout-all") { event.preventDefault(); event.stopPropagation(); setTimeout(async () => { try { await performLogoutTeardown(); } catch { /* ignore */ } try { location.reload(); } catch { /* ignore */ } }, 0); return; }
      if (act === "delete-account") { event.preventDefault(); event.stopPropagation(); promptDeleteAccount(); return; }
      const btn = event.target?.closest?.("button,[role='button']");
      if (btn && !btn.dataset?.cxAccountAction && /^luu thay doi$/.test(fold((btn.textContent || "").trim()))) {
        event.preventDefault(); event.stopPropagation(); // suppress the design's no-op onSaveAccount flash (a false "Đã lưu…")
        saveAccountFieldsNow(); // persist Họ và tên + SĐT locally + backend (multi-device); it toasts on save.
      }
    }, true);
    // Persist Họ và tên / SĐT the instant the user edits them (presence-aware local store), so a cleared or
    // custom value sticks on the next render tick — even before "Lưu thay đổi" — and never snaps back to the
    // baked sample "Trần Xuân Lộc" / masked phone or the Google display name. Inputs are tagged with
    // data-cx-acct-field by restoreAccountFields each tick.
    document.addEventListener("input", (event) => {
      const input = event.target;
      const field = input && input.tagName === "INPUT" && input.dataset && input.dataset.cxAcctField;
      if (field !== "name" && field !== "phone") return;
      const id = accountIdentity();
      if (id?.email) setAccountEdit(id.email, field, String(input.value || ""));
    }, true);
    // "Hóa đơn" VAT recipient form: persist each keystroke into state.vatDraft (tagged data-cx-vat-field by
    // restoreVatFields) so typing sticks across the design's re-renders — the exact fix that makes the fields
    // editable (the design's own oninput went to a separate state the bridge's value binding then overwrote).
    document.addEventListener("input", (event) => {
      const input = event.target;
      if (!input || input.tagName !== "INPUT") return;
      // Resolve the VAT field: the tag set by restoreVatFields, else map on-the-fly by position in the card
      // (so the FIRST keystroke works even before a tick has tagged the inputs).
      let field = input.dataset && input.dataset.cxVatField;
      if (!field) {
        const vf = vatFormInputs();
        if (vf) { if (input === vf.name) field = "name"; else if (input === vf.tax) field = "tax"; else if (input === vf.email) field = "email"; else if (input === vf.addr) field = "addr"; }
      }
      if (field !== "name" && field !== "tax" && field !== "email" && field !== "addr") return;
      // CRITICAL: this is a CAPTURE-phase listener, so stopPropagation here prevents the event from reaching
      // the input's own oninput={{onVatName}} (the design's editVat → setState → re-render). That per-keystroke
      // re-render RE-CREATES the input element, dropping characters mid-typing ("999888" → "698") — the reason
      // the field felt un-typeable. The native value change already happened before this event, so the typed
      // char is kept; we mirror it into state.vatDraft for the render vals.
      event.stopPropagation();
      if (!state.vatDraft) state.vatDraft = { name: "", tax: "", email: "", addr: "" };
      state.vatDraft[field] = String(input.value || "");
    }, true);
    // "Lưu thông tin" on the invoice VAT form → suppress the design's no-op flash + persist via updateUserBilling.
    // Scoped to the invoice recipient card (vatFormInputs present) and excludes the org-dashboard's cxos-save.
    document.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("button,[role='button']");
      if (!btn || btn.id === "cxos-save") return;
      if (!/^luu thong tin$/.test(fold((btn.textContent || "").trim()))) return;
      const vf = vatFormInputs();
      if (vf && vf.card && vf.card.contains(btn)) {
        event.preventDefault(); event.stopPropagation();
        saveVatFieldsNow();
      }
    }, true);
    // Clicking the portal "Lịch sử" tab → pull the freshest credit history then re-render, so it never
    // shows a stale/cached list.
    document.addEventListener("click", (event) => {
      const el = event.target;
      if (!el || el.children?.length) return; // only the leaf tab label
      if (/^Lịch sử$/i.test((el.textContent || "").trim())) {
        scheduleAccountStateRefresh(0);
        for (const d of [120, 450, 1000]) setTimeout(patchUsageHistory, d);
      }
    }, true);
    // "Nhật ký sử dụng" date filter (Hôm nay / 7 ngày / 30 ngày / 90 ngày / 12 tháng / Tất cả). The
    // design's dropdown lives on a different component, so its urlTime didn't reach the list; the
    // bridge owns the filter and re-renders.
    const DATE_FILTER_MAP = { "hom nay": "today", "7 ngay": "7d", "30 ngay": "30d", "90 ngay": "90d", "12 thang": "12m", "tat ca": "all" };
    document.addEventListener("click", (event) => {
      let el = event.target;
      for (let i = 0; i < 4 && el; i += 1) {
        const rect = el.getBoundingClientRect?.();
        if (rect && rect.left < 360 && rect.width < 240) {
          const clean = fold((el.textContent || "").trim()).replace(/[^a-z0-9 ]/g, "").trim();
          const key = DATE_FILTER_MAP[clean];
          if (key !== undefined) {
            state.urlTimeFilter = key;
            refreshStaticUrlLogSoon();
            return;
          }
        }
        el = el.parentElement;
      }
    }, true);
    setInterval(() => {
      if (state.loginOk) recoverStaticDemoServiceState(patchedStaticLogic || staticLogic());
    }, 700);
    for (const delay of [250, 900, 1800, 3200]) {
      setTimeout(() => {
        patchStaticUrlLog();
        refreshStaticUrlLogSoon();
      }, delay);
    }
    // Paint the cached real balance over the template seed (320) ASAP on load so it never flashes.
    for (const delay of [0, 300, 1000]) setTimeout(patchVisibleCreditTexts, delay); // was 6 timers — fewer redundant full sweeps
    installSyncProfileHandler(); // one delegated "Đồng bộ hồ sơ" click handler (replaces the per-tick full-DOM scan)
    // PERSISTENT LOGIN: on boot, ask main whether it already holds (or is restoring) a session. If so, unlock the
    // flip to the app screen (set loginIntent) + show the hydration mask so the login form doesn't flash — the
    // first refresh() then reveals the app directly. Only trusts a MAIN-confirmed connection, not a saved email.
    try {
      const bootBridge = api();
      bootBridge?.connection?.state?.().then((st) => {
        if (st && (st.connected || st.restoring) && !state.loggedOut) {
          state.loginIntent = true;
          state.loggedOut = false;
          try { showHydrationMask(); } catch (e) { /* ignore */ }
        }
      }).catch(() => {});
    } catch (e) { /* ignore */ }
    setTimeout(refresh, 800);
    setInterval(refresh, 30000);
    startPlanSyncPoll(); // dedicated planMe-only poll (20s) + focus/visibility → close a now-blocked open service fast
  }
  window.addEventListener("DOMContentLoaded", startBridge, { once: true });
  setTimeout(startBridge, 0);
  window.addEventListener("resize", () => {
    stableServiceBounds = null; // window size changed → re-measure the locked bounds
    // Maximize/restore reflows the React layout ASYNCHRONOUSLY — a single next-frame measure reads a
    // MID-TRANSITION rect and re-locks stale bounds (webview stuck small in a corner). The burst keeps
    // re-measuring across ~520ms so the final tick reads the settled layout.
    syncBrowserBoundsBurst(true);
  });
  // Page zoom / monitor-DPI change re-maps CSS px↔window DIP, so every cached rect is wrong. matchMedia
  // resolution listeners are one-shot per ratio — re-arm on each change.
  function watchDevicePixelRatio() {
    try {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener("change", () => {
        stableServiceBounds = null;
        syncBrowserBoundsBurst(true);
        watchDevicePixelRatio();
      }, { once: true });
    } catch {}
  }
  watchDevicePixelRatio();
})();
