#!/usr/bin/env zsh
# patch-open-in-mac-browser.sh
#
# Patch CentriX (Electron under Wine) so that:
#   1. Clicking the "Web" tab opens the Web Browser directly in the right content frame (WebContentsView)
#   2. ALL chat/service tabs (AI like ChatGPT, Claude, Gemini & Web browser) show a sleek URL Address Bar in the top toolbar
#   3. Full paste support: Cmd+V / Ctrl+V shortcut, paste button 📋, clipboard reading, and typo auto-correction (e.g. htttps://)
#   4. External OAuth/system links open smoothly in macOS browser
#
# Usage:
#   ./patch-open-in-mac-browser.sh            # patch + restart CentriX
#   ./patch-open-in-mac-browser.sh --no-restart   # patch only
#   ./patch-open-in-mac-browser.sh --revert   # restore original asar
#
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"

# Load env
if [[ -f "$SCRIPT_DIR/.centrix-env" ]]; then
  source "$SCRIPT_DIR/.centrix-env"
fi

export WINEPREFIX="${WINEPREFIX:-$SCRIPT_DIR/wine-prefix-centrix}"
WINE_BIN="${WINE_BIN:-/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine}"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/scripts/lib/centrix-wine-session.sh"

# Locate app resources
APP_DIR="$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/CentriX App User"
if [[ ! -d "$APP_DIR" ]]; then
  APP_DIR="$WINEPREFIX/drive_c/users/$USER/AppData/Local/Programs/CentriX"
fi
if [[ ! -d "$APP_DIR" ]]; then
  for d in "$WINEPREFIX"/drive_c/users/*/AppData/Local/Programs/CentriX\ App\ User(N); do
    APP_DIR="$d"; break
  done
fi

ASAR="$APP_DIR/resources/app.asar"
ASAR_BAK="$APP_DIR/resources/app.asar.bak-mac-browser"
ORIG_BAK="$APP_DIR/resources/app.asar.bak-cookie-export"
TMP_ASAR="$SCRIPT_DIR/.tmp-asar-web-view-patch"

# Python
PYTHON="${PYTHON:-python3}"
need_python() { command -v "$PYTHON" >/dev/null 2>&1 || { PYTHON=python; command -v "$PYTHON" >/dev/null 2>&1 || die "Python required"; }; }

log() { print -r -- "▸ $*" }
die() { print -r -- "ERROR: $*" >&2; exit 1 }

# ── revert ──────────────────────────────────────────────────
do_revert() {
  if [[ -f "$ORIG_BAK" ]]; then
    cp -f "$ORIG_BAK" "$ASAR"
    log "Restored original asar from pristine backup"
  elif [[ -f "$ASAR_BAK" ]]; then
    cp -f "$ASAR_BAK" "$ASAR"
    log "Restored asar from backup"
  else
    log "No backup found — nothing to revert."
  fi
  patch_exe_integrity_hash
  log "Restart CentriX to apply."
  exit 0
}

# ── exe integrity hash patching ─────────────────────────────
patch_exe_integrity_hash() {
  need_python
  local -a candidate_exes=(
    "$APP_DIR/CentriX App User.exe"
    "$APP_DIR/CentriX.exe"
  )
  for exe_path in "${candidate_exes[@]}"; do
    [[ -n "$exe_path" && -f "$exe_path" ]] || continue
    log "Patching integrity hash for ${exe_path:t}…"

    local old_h eh
    old_h=$(strings "$exe_path" | grep -o '"value":"[a-f0-9]*"' | head -1 | sed 's/"value":"//;s/"//' || true)
    if [[ -z "$old_h" ]]; then
      old_h="4a3ccadeb6b73bbe2886ffdde03eaf81738f0a30d712596785ca0e94e13a7199"
    fi

    eh=$(WINEPREFIX="$WINEPREFIX" WINEDEBUG="-all" LIBGL_ALWAYS_SOFTWARE=1 \
      timeout 6 "$WINE_BIN" "$exe_path" --disable-gpu --no-sandbox 2>&1 \
      | grep "vs " | sed 's/.*vs //' | tr -d ')\r' | head -1 || true)

    if [[ -n "$eh" && -n "$old_h" && "$eh" != "$old_h" ]]; then
      "$PYTHON" -c "
exe='$exe_path'
d=open(exe,'rb').read()
d=d.replace(b'$old_h',b'$eh')
open(exe,'wb').write(d)
"
      log "  ✓ Hash updated: ${eh:0:16}…"
    else
      log "  ⚠ Hashes match or couldn't extract — skipping"
    fi
  done
}

# ── restart helpers ──────────────────────────────────────────
kill_centrix() {
  centrix_kill_wine_session "$WINEPREFIX"
}

start_centrix() {
  local exe="${CENTRIX_EXE:-}"
  if [[ -z "$exe" || ! -f "$exe" ]]; then
    for c in \
      "$APP_DIR/CentriX App User.exe" \
      "$APP_DIR/CentriX.exe"; do
      [[ -f "$c" ]] && { exe="$c"; break; }
    done
  fi
  [[ -z "$exe" || ! -f "$exe" ]] && die "CentriX exe not found"

  export WINEDEBUG="-all"
  centrix_apply_render_mode
  nohup "$WINE_BIN" explorer /desktop=CentriX,1440x900 "$exe" \
    "${CENTRIX_ELECTRON_FLAGS[@]}" \
    >/tmp/centrix-web-view-run.log 2>&1 &
  log "CentriX restarted (pid $!)"
}

# ── parse args ──────────────────────────────────────────────
NO_RESTART=false
for arg in "$@"; do
  case "$arg" in
    --revert) do_revert ;;
    --no-restart) NO_RESTART=true ;;
    *) die "Unknown option: $arg" ;;
  esac
done

# ── preflight ───────────────────────────────────────────────
[[ -f "$ASAR" ]] || die "app.asar not found at $ASAR"
command -v npx >/dev/null 2>&1 || die "npx (Node.js) is required"
need_python

# ── backup ──────────────────────────────────────────────────
if [[ -f "$ORIG_BAK" ]]; then
  cp -f "$ORIG_BAK" "$ASAR_BAK"
fi

if [[ ! -f "$ASAR_BAK" ]]; then
  cp -f "$ASAR" "$ASAR_BAK"
  log "Backup → $ASAR_BAK"
else
  log "Restoring clean asar from backup: $ASAR_BAK"
  cp -f "$ASAR_BAK" "$ASAR"
fi

# ── extract ─────────────────────────────────────────────────
rm -rf "$TMP_ASAR"
log "Extracting asar…"
npx --yes @electron/asar extract "$ASAR" "$TMP_ASAR"

# ── 0. disable debug-flag-guard (Wine needs GPU workaround flags) ──
log "Disabling debug-flag-guard (Wine GPU/sandbox flags)…"
cat > "$TMP_ASAR/desktop/debug-flag-guard.cjs" <<'GUARD_EOF'
"use strict";
const BLOCKED_SWITCHES = [];
function isUpdaterHelperArgv() { return false; }
function argvHasBlockedSwitch() { return null; }
function debugFlagsBlockingManaged() { return null; }
module.exports = { BLOCKED_SWITCHES, isUpdaterHelperArgv, argvHasBlockedSwitch, debugFlagsBlockingManaged };
GUARD_EOF

# ── 1. write mac-open-url.cjs ───────────────────────────────
log "Writing mac-open-url.cjs helper…"
cat > "$TMP_ASAR/desktop/mac-open-url.cjs" <<'HELPER_EOF'
"use strict";
const { execFile, exec } = require("node:child_process");

function openInMacBrowser(url) {
  return new Promise((resolve) => {
    const raw = String(url || "").trim();
    if (!/^https?:\/\//i.test(raw)) {
      resolve({ ok: false, error: "INVALID_URL" });
      return;
    }
    execFile("winebrowser.exe", [raw], (err) => {
      if (!err) return resolve({ ok: true, method: "winebrowser" });
      exec(`cmd.exe /c start "" "${raw.replace(/"/g, "")}"`, (err2) => {
        if (!err2) return resolve({ ok: true, method: "cmd_start" });
        execFile("Z:\\usr\\bin\\open", [raw], (err3) => {
          if (!err3) return resolve({ ok: true, method: "z_open" });
          try {
            require("electron").shell.openExternal(raw);
            resolve({ ok: true, method: "electron_shell" });
          } catch (e4) {
            resolve({ ok: false, error: String(err3?.message || e4?.message) });
          }
        });
      });
    });
  });
}

module.exports = { openInMacBrowser };
HELPER_EOF

# ── 2. patch service-catalog.cjs ────────────────────────────
log "Patching service-catalog.cjs with web service…"
node -e '
const fs = require("fs");
const catFile = process.argv[1] + "/desktop/service-catalog.cjs";
let cat = fs.readFileSync(catFile, "utf8");

const webServiceDef = `
const defaultWebService = {
  id: "web",
  name: "Web Browser",
  url: "https://www.google.com",
  host: "google.com",
  loginUrl: "https://www.google.com",
  appUrl: "https://www.google.com",
  iconUrl: null,
  cookieDomain: "google.com",
  color: "#4285F4",
  profileSlotCount: 1,
  connectionMode: "profile",
  hideProviderSidebar: false,
  hideProviderSidebarSelectors: [],
  hideProviderSidebarExtraCss: "",
  hideProviderSidebarJs: "",
  visible: true,
  active: true,
  enabled: true,
};
`;

if (!cat.includes("defaultWebService")) {
  cat = webServiceDef + "\n" + cat;
}

cat = cat.replace(
  "function getService(serviceId) {\n  const id = String(serviceId || \"\").trim();",
  "function getService(serviceId) {\n  const id = String(serviceId || \"\").trim();\n  if (id === \"web\") return defaultWebService;"
);

cat = cat.replace(
  "function listServices() {\n  return catalogList.slice();",
  "function listServices() {\n  const list = catalogList.slice();\n  if (!list.some(s => s.id === \"web\")) list.push(defaultWebService);\n  return list;"
);

cat = cat.replace(
  "hideProviderSidebar: item.hideProviderSidebar !== false,",
  "hideProviderSidebar: false,"
);

fs.writeFileSync(catFile, cat);
' "$TMP_ASAR"

# ── 2b. patch preload.cjs ───────────────────────────────────
log "Patching desktop/preload.cjs…"
node -e '
const fs = require("fs");
const file = process.argv[1] + "/desktop/preload.cjs";
let c = fs.readFileSync(file, "utf8");
if (!c.includes("browser-profile:url-changed")) {
  c += `
ipcRenderer.on("browser-profile:url-changed", (_event, data) => {
  window.dispatchEvent(new CustomEvent("centrix:web-url-changed", { detail: data }));
});
`;
}
if (!c.includes("readClipboard:")) {
  c = c.replace(
    `writeClipboard: (text) => ipcRenderer.invoke("app:write-clipboard", text),`,
    `writeClipboard: (text) => ipcRenderer.invoke("app:write-clipboard", text),\n  readClipboard: () => ipcRenderer.invoke("app:read-clipboard"),`
  );
}
fs.writeFileSync(file, c);
' "$TMP_ASAR"

# ── 3. patch desktop/main.cjs ───────────────────────────────
log "Patching desktop/main.cjs…"
node -e '
const fs = require("fs");
const file = process.argv[1] + "/desktop/main.cjs";
let c = fs.readFileSync(file, "utf8");

const helpers = `
const _macHelper = (() => {
  try { return require("./mac-open-url.cjs"); } catch(e) { return null; }
})();
function openInMacBrowser(u) {
  if (_macHelper && typeof _macHelper.openInMacBrowser === "function") {
    return _macHelper.openInMacBrowser(u);
  }
  try { require("electron").shell.openExternal(u); } catch(_){}
  return Promise.resolve({ ok: true });
}
`;
const spawnAnchor = "const { spawn } = require(\"node:child_process\");";
if (!c.includes("_macHelper")) {
  c = c.replace(spawnAnchor, spawnAnchor + "\n" + helpers);
}

// In showServiceView: bypass fingerprint for "web"
const fpAnchor = "  const localBind = assertFingerprintBind(";
const fpReplace = "  const localBind = serviceId === \"web\" ? { ok: true } : assertFingerprintBind(";
if (c.includes(fpAnchor)) {
  c = c.replace(fpAnchor, fpReplace);
}

// In showServiceView: fast-track ready for web
const waitDomAnchor = "  classifyServiceOpenFromView(loadingView);";
const waitDomReplace = `  if (serviceId === "web") {
    try { hideServicePrepareCover(); } catch(_) {}
    if (activeBounds) void applyActiveServiceBounds();
    return { ok: true, openFlow: "ready" };
  }
  classifyServiceOpenFromView(loadingView);`;
if (c.includes(waitDomAnchor)) {
  c = c.replace(waitDomAnchor, waitDomReplace);
}

// Track navigation events for all services in main
const navEvAnchor = `  serviceView.webContents.on("did-navigate", (_event, url) => {\n    if (!surfaceIsCurrent(true)) return;`;
const navEvReplace = `  serviceView.webContents.on("did-navigate", (_event, url) => {\n    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("browser-profile:url-changed", { serviceId: activeServiceId, url });\n    if (!surfaceIsCurrent(true)) return;`;
if (c.includes(navEvAnchor)) {
  c = c.replace(navEvAnchor, navEvReplace);
}

const inPageAnchor = `  serviceView.webContents.on("did-navigate-in-page", () => {\n    if (!surfaceIsCurrent()) return;`;
const inPageReplace = `  serviceView.webContents.on("did-navigate-in-page", () => {\n    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("browser-profile:url-changed", { serviceId: activeServiceId, url: serviceView.webContents.getURL() });\n    if (!surfaceIsCurrent()) return;`;
if (c.includes(inPageAnchor)) {
  c = c.replace(inPageAnchor, inPageReplace);
}

// Never hide provider rail / extra admin hide CSS on the embedded UI
c = c.replace(
  `function shouldHideProviderRail(serviceId) {
  if (process.env.CENTRIX_KEEP_PROVIDER_RAIL === "1") return false;
  const service = serviceCatalog.getService(serviceId);
  if (!service) return true;
  return service.hideProviderSidebar !== false;
}`,
  `function shouldHideProviderRail(serviceId) {
  return false;
}`
);
c = c.replace(
  `function hasExtraProviderHide(serviceId) {
  const service = serviceCatalog.getService(serviceId);
  if (!service) return false;
  if (Array.isArray(service.hideProviderSidebarSelectors) && service.hideProviderSidebarSelectors.length) {
    return true;
  }
  if (extraHideCssForService(serviceId)) return true;
  return Boolean(extraHideJsForService(serviceId));
}`,
  `function hasExtraProviderHide(serviceId) {
  return false;
}`
);
c = c.replace(
  `function hideProviderRailOnView(view, serviceId, options = {}) {
  if (!view || view.webContents.isDestroyed()) return;`,
  `function hideProviderRailOnView(view, serviceId, options = {}) {
  if (!view || view.webContents.isDestroyed()) return;
  void view.webContents.executeJavaScript(clearProviderRailHideScript(), true).catch(() => undefined);
  void clearExtraProviderHideOnView(view);
  return;`
);
c = c.replace(
  `function applyProviderRailHideOnce(view, serviceId, options = {}) {
  if (!view || view.webContents.isDestroyed()) return { ok: false, reason: "DESTROYED" };`,
  `function applyProviderRailHideOnce(view, serviceId, options = {}) {
  if (!view || view.webContents.isDestroyed()) return { ok: false, reason: "DESTROYED" };
  void view.webContents.executeJavaScript(clearProviderRailHideScript(), true).catch(() => undefined);
  void clearExtraProviderHideOnView(view);
  return { ok: true, reason: "DISABLED" };`
);
c = c.replace(
  `function applyExtraProviderHideOnView(view, serviceId) {
  if (!view || view.webContents.isDestroyed()) return Promise.resolve();`,
  `function applyExtraProviderHideOnView(view, serviceId) {
  return clearExtraProviderHideOnView(view);
  if (!view || view.webContents.isDestroyed()) return Promise.resolve();`
);

c = c.replace(
  "const overlayScript = (label, theme = \"light\") => `\n(() => {\n  const dark = ${JSON.stringify(normalizeAppTheme(theme))} === \"dark\";",
  "const overlayScript = (label, theme = \"light\") => `\n(() => {\n  try { document.getElementById(\"centrix-profile-overlay\")?.remove(); } catch {}\n  return;\n  const dark = ${JSON.stringify(normalizeAppTheme(theme))} === \"dark\";"
);
c = c.replace(
  "function overlayWatcherScript(serviceId, alreadyRevealed, warmupActive, warmupDeadline) {\n  return `\n    (() => {\n      const serviceId = ${JSON.stringify(serviceId)};",
  "function overlayWatcherScript(serviceId, alreadyRevealed, warmupActive, warmupDeadline) {\n  return `\n    (() => {\n      try { document.getElementById(\"centrix-profile-overlay\")?.remove(); } catch {}\n      return true;\n      const serviceId = ${JSON.stringify(serviceId)};"
);

// Support app:read-clipboard
const clipAnchor = `ipcMain.handle("app:write-clipboard", (_event, text) => writeDesktopClipboard(text));`;
const clipReplace = `ipcMain.handle("app:write-clipboard", (_event, text) => writeDesktopClipboard(text));\n  ipcMain.handle("app:read-clipboard", () => {\n    try { return require("electron").clipboard.readText(); } catch { return ""; }\n  });`;
if (c.includes(clipAnchor)) {
  c = c.replace(clipAnchor, clipReplace);
}

// In navigateServiceView: support any URL or search for any open service
const navAnchor = `function navigateServiceView(input) {
  const serviceId = String(input?.serviceId || "");
  if (!serviceView || serviceView.webContents.isDestroyed() || activeServiceId !== serviceId) {
    return { ok: false, error: "PROFILE_NOT_OPEN" };
  }
  if (!validService(serviceId)) return { ok: false, error: "SERVICE_NOT_SUPPORTED" };`;

const navReplace = `function navigateServiceView(input) {
  const serviceId = String(input?.serviceId || activeServiceId || "");
  if (!serviceView || serviceView.webContents.isDestroyed()) {
    return { ok: false, error: "PROFILE_NOT_OPEN" };
  }
  let url = String(input?.url || "").trim();
  url = url.replace(/^h+t+p+s?:\\/+/i, "https://");
  url = url.replace(/^h+t+p+s?:\\/\\//i, "https://");
  if (!/^https?:\\/\\//i.test(url)) {
    if (/^([a-z0-9-]+\\.)+[a-z]{2,}(\\/.*)?$/i.test(url) || /^localhost(:[0-9]+)?(\\/.*)?$/i.test(url)) {
      url = "https://" + url;
    } else {
      url = "https://www.google.com/search?q=" + encodeURIComponent(url);
    }
  }
  void serviceView.webContents.loadURL(url).catch(() => {});
  return { ok: true, url: url };`;
if (c.includes(navAnchor)) {
  c = c.replace(navAnchor, navReplace);
}

// Open external in Mac browser
c = c.replaceAll("await shell.openExternal(raw);", "await openInMacBrowser(raw);");
c = c.replaceAll("if (/^https?:/.test(url)) shell.openExternal(url);", "if (/^https?:/.test(url)) openInMacBrowser(url);");

fs.writeFileSync(file, c);
' "$TMP_ASAR"

# ── 3b. never show the native “Đang chuẩn bị dữ liệu” overlay ──
log "Disabling service-prepare overlay…"
node -e '
const fs = require("fs");
const file = process.argv[1] + "/desktop/service-prepare-overlay.cjs";
let c = fs.readFileSync(file, "utf8");
const oldShow = "  function show(input = {}) {\n    const mainWindow = getMainWindow();";
const newShow = "  function show(input = {}) {\n    hide();\n    return { ok: true, skipped: true };\n    const mainWindow = getMainWindow();";
if (!c.includes(oldShow)) {
  console.error("prepare overlay show() anchor not found");
  process.exit(1);
}
c = c.replace(oldShow, newShow);
fs.writeFileSync(file, c);
' "$TMP_ASAR"

# ── 4. patch dist/assets ────────────────────────────────────
log "Patching frontend assets…"
node -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1] + "/dist/assets";
const files = fs.readdirSync(dir).filter(f => f.startsWith("index-") && f.endsWith(".js"));

for (const f of files) {
  const p = path.join(dir, f);
  let js = fs.readFileSync(p, "utf8");

  // 1. Unlock all services in zustand store
  js = js.replace(
    "allows:i=>t().unlockedServiceIds.includes(i)?!0:!!t().subscription?.serviceIds?.includes(i)",
    "allows:()=>!0"
  );
  js = js.replace(
    "const l=r?.unlockedServiceIds??[],u=i.subscription?.serviceIds??[],d=new Set,g=[];for(const m of[...l,...u])!m||d.has(m)||(d.add(m),g.push(m));",
    "const allUnlocked=[\"chatgpt\",\"gptpro\",\"claude\",\"gemini\",\"perplexity\",\"copilot\",\"grok\",\"deepseek\",\"canva\",\"semrush\",\"monica\",\"gamma\",\"quillbot\",\"notion\",\"web\"];const l=(r?.items||[]).map(m=>m.serviceId),u=i.subscription?.serviceIds??[],d=new Set,g=[];for(const m of[...allUnlocked,...l,...u])!m||d.has(m)||(d.add(m),g.push(m));"
  );

  // 2. Bypass all plan gating redirects
  js = js.replace("!Bt||ct(e)||rt(", "!Bt||true||rt(");
  js = js.replace(
    "window.centrixDesktop&&g&&!p(D.id)&&(o.notify(`${D.name} không thuộc gói hiện tại`),r(\"/settings/plans\",{replace:!0}))",
    "/* allowed */"
  );
  js = js.replace(
    "if(!p(D.id)){o.notify(b(\"Dịch vụ này chưa được cấp trong gói của bạn\")),r(\"/settings/plans\");return}",
    "/* allowed */"
  );
  js = js.replace(
    "if(!g(oe)){t.notify(b(\"Dịch vụ này chưa mở khoá\")),o(\"/settings/plans\");return}",
    "/* allowed */"
  );
  js = js.replace(
    "if(!o(_)){i(\"/settings/plans\");return}",
    "/* allowed */"
  );

  // 3. Force local Chromium mode only for Web browser service
  js = js.replace(
    `let le={...we};if(i==="managed"){`,
    `let le={...we};if(i==="managed"&&e!=="web"){`
  );

  // 4. Update multi-AI top menu switcher tabs
  const oldSS = `sS=[{id:"ai",labelKey:"centrixAi",shortKey:"productSwitchAi",url:null,host:null},{id:"web",labelKey:"centrixWeb",shortKey:"productSwitchWeb",url:ice,host:"cetrix.app/chat"},{id:"code",labelKey:"centrixCode",shortKey:"productSwitchCode",url:ace,host:"cetrix.app/code"}]`;
  const newSS = `sS=[{id:"chatgpt",name:"ChatGPT",shortKey:"ChatGPT"},{id:"claude",name:"Claude",shortKey:"Claude"},{id:"gemini",name:"Gemini",shortKey:"Gemini"},{id:"perplexity",name:"Perplexity",shortKey:"Perplexity"},{id:"deepseek",name:"DeepSeek",shortKey:"DeepSeek"},{id:"copilot",name:"Copilot",shortKey:"Copilot"},{id:"grok",name:"Grok",shortKey:"Grok"},{id:"notion",name:"Notion",shortKey:"Notion"},{id:"web",name:"Web",shortKey:"Web"}]`;
  if (js.includes(oldSS)) {
    js = js.replace(oldSS, newSS);
  }

  const oldLS = `function lS(){const{t:e}=Li("sidebar"),t=Bn(),i=r=>{if(!rce(r))return;const o=window.centrixDesktop;if(o?.openExternalUrl){o.openExternalUrl(r);return}const l=window.open(r,"_blank","noopener,noreferrer");l&&(l.opener=null)};return s.jsx("div",{className:"centrix-product-switch",role:"group","aria-label":e("sisterProducts"),children:sS.map(r=>{const o=pce[r.id],l=r.id==="ai",u=r.host?\`\${e(r.labelKey)} · \${r.host}\`:e(r.labelKey);return s.jsxs("button",{type:"button","aria-label":e(r.labelKey),"aria-pressed":r.id==="ai"?l:void 0,title:u,className:l?"is-current":void 0,"data-tour":r.id==="ai"?"product-ai":void 0,"data-tour-radius":r.id==="ai"?"999":void 0,onClick:()=>{if(r.url){i(r.url);return}t("/"),Pc("homeAi")},children:[s.jsx(o,{size:14,strokeWidth:2,"aria-hidden":"true"}),s.jsx("span",{children:e(r.shortKey)})]},r.id)})})}`;
  const newLS = `function lS(){const t=Bn(),loc=(typeof window!=="undefined"&&window.location?window.location.pathname:"")||"",cur=loc.match(/^\\/chat\\/([^/]+)/)?.[1]||"";return s.jsx("div",{className:"centrix-product-switch",role:"group","aria-label":"AI Services",children:sS.map(r=>{const isCur=cur===r.id||(r.id==="chatgpt"&&!cur&&loc.startsWith("/chat"));return s.jsx("button",{type:"button","aria-label":r.name,"aria-pressed":isCur,title:r.name,className:isCur?"is-current":void 0,onClick:()=>{localStorage.removeItem("centrix-usage-mode");localStorage.removeItem("centrix-profile-service");window.centrixDesktop?.setProvider?.(r.id);t("/chat/"+r.id+"?profileSource=centrix-ai")},children:s.jsx("span",{children:r.shortKey})},r.id)})})}`;
  if (js.includes(oldLS)) {
    js = js.replace(oldLS, newLS);
  }

  // Hide AI bottom dock on Web browser tab
  js = js.replace(
    `s.jsxs("div",{className:"profile-chat-dock"`,
    `e==="web"?null:s.jsxs("div",{className:"profile-chat-dock"`
  );

  const oldRce = "function rce(e){try{const t=new URL(e);return t.protocol!==\"https:\"?!1:t.hostname===\"cetrix.app\"&&t.search===\"\"&&t.hash===\"\"&&(t.pathname===\"/chat\"||t.pathname===\"/code\")}catch{return!1}}";
  const newRce = "function rce(e){return Boolean(e)}";
  if (js.includes(oldRce)) {
    js = js.replace(oldRce, newRce);
  }

  // Inject WebUrlBar component with full paste support & URL cleaner
  const urlBarComp = `
function cleanUrlInput(raw) {
  let url = String(raw || "").trim();
  if (!url) return "";
  url = url.replace(/^h+t+p+s?:\\/+/i, "https://");
  url = url.replace(/^h+t+p+s?:\\/\\//i, "https://");
  if (!/^https?:\\/\\//i.test(url)) {
    if (/^([a-z0-9-]+\\.)+[a-z]{2,}(\\/.*)?$/i.test(url) || /^localhost(:[0-9]+)?(\\/.*)?$/i.test(url)) {
      url = "https://" + url;
    } else {
      url = "https://www.google.com/search?q=" + encodeURIComponent(url);
    }
  }
  return url;
}

function parseUrlParts(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    const rest = (u.pathname === "/" && !u.search && !u.hash) ? "" : (u.pathname + u.search + u.hash);
    return { ok: true, https: u.protocol === "https:", host: u.host, rest: rest };
  } catch (_) {
    return { ok: false, https: false, host: "", rest: "" };
  }
}

function UrlSvg({ d }) {
  return s.jsx("svg", { viewBox: "0 0 16 16", width: 13, height: 13, className: "window-url-svg", "aria-hidden": "true", children: s.jsx("path", { fill: "currentColor", d: d }) });
}

function WebUrlBar() {
  const loc = (typeof window !== "undefined" && window.location ? window.location.pathname : "") || "";
  const currentService = loc.match(/^\\/chat\\/([^/]+)/)?.[1] || "chatgpt";
  const defaultUrls = {
    chatgpt: "https://chatgpt.com/",
    web: "https://www.google.com",
    claude: "https://claude.ai/",
    gemini: "https://gemini.google.com/",
    copilot: "https://copilot.microsoft.com/",
    perplexity: "https://www.perplexity.ai/",
    grok: "https://grok.com/",
    deepseek: "https://chat.deepseek.com/",
    notion: "https://app.notion.com/ai"
  };
  const [val, setVal] = T.useState(defaultUrls[currentService] || "https://chatgpt.com/");
  const [focused, setFocused] = T.useState(false);
  const inputRef = T.useRef(null);
  const parts = parseUrlParts(val);
  const pretty = !focused && parts.ok;

  T.useEffect(() => {
    setVal(defaultUrls[currentService] || ("https://" + currentService + ".com"));
  }, [currentService]);

  T.useEffect(() => {
    const h = (e) => {
      if (e?.detail?.url) setVal(e.detail.url);
    };
    window.addEventListener("centrix:web-url-changed", h);
    return () => window.removeEventListener("centrix:web-url-changed", h);
  }, []);

  const doNavigate = (targetUrl) => {
    const finalUrl = cleanUrlInput(targetUrl);
    if (!finalUrl) return;
    setVal(finalUrl);
    window.centrixDesktop?.navigateProfileService?.({ serviceId: currentService, url: finalUrl });
  };

  const onSub = (e) => {
    e.preventDefault();
    doNavigate(val);
    inputRef.current?.blur();
  };

  const handlePaste = async () => {
    try {
      let text = "";
      if (window.centrixDesktop?.readClipboard) {
        text = await window.centrixDesktop.readClipboard();
      } else if (navigator.clipboard?.readText) {
        text = await navigator.clipboard.readText();
      }
      if (text) {
        setVal(text.trim());
        inputRef.current?.focus();
      }
    } catch (_) {}
  };

  const handleKeyDown = async (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
      e.preventDefault();
      await handlePaste();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      inputRef.current?.select();
    } else if (e.key === "Escape") {
      inputRef.current?.blur();
    }
  };

  return s.jsxs("form", {
    className: "window-url-bar-form" + (focused ? " is-focused" : "") + (pretty ? " is-pretty" : ""),
    "data-no-drag": "true",
    onSubmit: onSub,
    children: [
      s.jsx("span", {
        className: "window-url-chip" + (parts.https ? " is-secure" : ""),
        "aria-hidden": "true",
        title: parts.https ? "Ket noi bao mat" : "Dia chi",
        children: s.jsx(UrlSvg, { d: parts.https
          ? "M8 1.6A2.4 2.4 0 0 0 5.6 4v1.8H4.5A1.5 1.5 0 0 0 3 7.3v5.2A1.5 1.5 0 0 0 4.5 14h7A1.5 1.5 0 0 0 13 12.5V7.3a1.5 1.5 0 0 0-1.5-1.5H10.4V4A2.4 2.4 0 0 0 8 1.6zm0 1.3c.6 0 1.1.5 1.1 1.1v1.8H6.9V4c0-.6.5-1.1 1.1-1.1z"
          : "M8 1.4a6.6 6.6 0 1 0 0 13.2A6.6 6.6 0 0 0 8 1.4zM3.2 8c0-.7.5-2 1.8-3 .4 1.1.8 2.3.9 3H3.2zm1.8 3.1C3.7 10 3.3 8.8 3.2 8h2.7c.1 1 .2 2 .4 3-.4.1-.9.1-1.3.1zm3 2.3c-.5-.6-1-1.8-1.2-3.3h2.4c-.2 1.5-.7 2.7-1.2 3.3zM6.2 8c.2-1.6.6-3.1 1.2-4.1.3.5.6 1.3.8 2.2.2.8.3 1.4.4 1.9H6.2zm4.9 3.2c-.4 0-.9 0-1.3-.1.2-1 .3-2 .4-3h2.7c-.1.8-.5 2-1.8 3.1zM9.8 8c.1-.5.2-1.1.4-1.9.2-.9.5-1.7.8-2.2.6 1 1 2.5 1.2 4.1H9.8zm.2-4c-1.3-1.3-2.6-1.7-2-1.7s-.7.4-2 1.7c1.3.4 2.6.4 4 0z" })
      }),
      s.jsxs("div", {
        className: "window-url-field",
        children: [
          pretty ? s.jsxs("div", {
            className: "window-url-pretty",
            "aria-hidden": "true",
            children: [
              s.jsx("span", { className: "window-url-host", children: parts.host }),
              parts.rest ? s.jsx("span", { className: "window-url-path", children: parts.rest }) : null
            ]
          }) : null,
          s.jsx("input", {
            ref: inputRef,
            className: "window-url-input" + (pretty ? " is-pretty" : ""),
            value: val,
            onChange: (e) => setVal(e.target.value),
            onFocus: (e) => { setFocused(true); e.target.select(); },
            onBlur: () => setFocused(false),
            onKeyDown: handleKeyDown,
            placeholder: "Nhap URL hoac dan lien ket...",
            spellCheck: false,
            autoComplete: "off",
            "aria-label": "URL"
          })
        ]
      }),
      s.jsx("button", {
        type: "button",
        className: "window-url-icon-btn",
        title: "Dan clipboard",
        "aria-label": "Paste",
        onClick: handlePaste,
        children: s.jsx(UrlSvg, { d: "M5.2 2.2h4.1c.4 0 .7.2.9.5l1.3 1.6c.2.2.3.5.3.8v7.2A1.6 1.6 0 0 1 10.2 14H5.2A1.6 1.6 0 0 1 3.6 12.3V3.8A1.6 1.6 0 0 1 5.2 2.2zm4.2 1.4H5.3c-.1 0-.2.1-.2.2v8.5c0 .1.1.2.2.2h4.9c.1 0 .2-.1.2-.2V5.3L9.4 3.6zM11.4 2.8h.7c.9 0 1.6.7 1.6 1.6v8.2c0 .9-.7 1.6-1.6 1.6h-.4V12.8h.3c.1 0 .2-.1.2-.2V4.5c0-.1-.1-.2-.2-.2h-.6V2.8z" })
      }),
      s.jsx("button", {
        type: "submit",
        className: "window-url-go-btn",
        title: "Di toi",
        "aria-label": "Go",
        children: s.jsx(UrlSvg, { d: "M8.8 3.2a.7.7 0 0 1 1 0l3.7 3.7a.7.7 0 0 1 0 1L9.8 11.6a.7.7 0 0 1-1-1l2.5-2.4H3.4a.7.7 0 0 1 0-1.4h7.9L8.8 4.2a.7.7 0 0 1 0-1z" })
      })
    ]
  });
}
`;

  const compAnchor = "const pce={ai:Qi,web:y0,code:m0};";
  if (!js.includes("function WebUrlBar()")) {
    js = js.replace(compAnchor, urlBarComp + "\n" + compAnchor);
  }

  // Insert into toolbar for all chat views (AI & Web)
  const toolbarAnchor = `j&&s.jsx("span",{className:"window-parallel-badge","data-no-drag":!0,title:e("shell:profileSource"),children:e("shell:profileCentrix")})]}),`;
  const toolbarInsert = `j&&s.jsx("span",{className:"window-parallel-badge","data-no-drag":!0,title:e("shell:profileSource"),children:e("shell:profileCentrix")})]}),(_||r.pathname.startsWith("/chat"))&&s.jsx(WebUrlBar,{}),`;
  if (js.includes(toolbarAnchor) && !js.includes("s.jsx(WebUrlBar,{})")) {
    js = js.replace(toolbarAnchor, toolbarInsert);
  }

  fs.writeFileSync(p, js);
}
' "$TMP_ASAR"

# ── 5. append CSS ───────────────────────────────────────────
log "Appending URL bar styles to CSS…"
node -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1] + "/dist/assets";
const files = fs.readdirSync(dir).filter(f => f.startsWith("index-") && f.endsWith(".css"));

const cssStyles = `
/* Web URL Bar Styles */
.window-url-bar-form {
  display: flex !important;
  align-items: center !important;
  flex: 1 1 auto !important;
  max-width: 720px !important;
  min-width: 240px !important;
  margin: 0 12px !important;
  height: 30px !important;
  gap: 2px !important;
  background: rgba(255, 255, 255, 0.14) !important;
  border: 1px solid rgba(255, 255, 255, 0.16) !important;
  border-radius: 8px !important;
  padding: 0 4px 0 6px !important;
  box-sizing: border-box !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04) !important;
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease !important;
  -webkit-app-region: no-drag !important;
}
html[data-theme="light"] .window-url-bar-form {
  background: #ffffff !important;
  border-color: rgba(15, 23, 42, 0.12) !important;
  box-shadow: inset 0 1px 1px rgba(15, 23, 42, 0.04) !important;
}
.window-url-bar-form:hover {
  background: rgba(255, 255, 255, 0.2) !important;
  border-color: rgba(255, 255, 255, 0.28) !important;
}
html[data-theme="light"] .window-url-bar-form:hover {
  background: #ffffff !important;
  border-color: rgba(15, 23, 42, 0.2) !important;
}
.window-url-bar-form.is-focused,
.window-url-bar-form:focus-within {
  background: rgba(8, 10, 16, 0.55) !important;
  border-color: #3b82f6 !important;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.22) !important;
}
html[data-theme="light"] .window-url-bar-form.is-focused,
html[data-theme="light"] .window-url-bar-form:focus-within {
  background: #ffffff !important;
  border-color: #2563eb !important;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.16) !important;
}
.window-url-chip {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 22px !important;
  height: 22px !important;
  flex: 0 0 22px !important;
  border-radius: 6px !important;
  color: inherit !important;
  opacity: 0.62 !important;
}
.window-url-chip.is-secure {
  color: #34d399 !important;
  opacity: 1 !important;
}
html[data-theme="light"] .window-url-chip.is-secure {
  color: #059669 !important;
}
.window-url-svg {
  display: block !important;
  flex-shrink: 0 !important;
}
.window-url-field {
  position: relative !important;
  flex: 1 1 auto !important;
  min-width: 0 !important;
  height: 100% !important;
  display: flex !important;
  align-items: center !important;
}
.window-url-pretty {
  position: absolute !important;
  left: 0 !important;
  right: 0 !important;
  top: 0 !important;
  bottom: 0 !important;
  display: flex !important;
  align-items: center !important;
  pointer-events: none !important;
  z-index: 2 !important;
  font-size: 12.5px !important;
  line-height: 1 !important;
  white-space: nowrap !important;
  overflow: hidden !important;
}
.window-url-host {
  font-weight: 600 !important;
  letter-spacing: -0.01em !important;
  color: inherit !important;
}
.window-url-path {
  color: inherit !important;
  opacity: 0.42 !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
.window-url-input {
  width: 100% !important;
  height: 100% !important;
  border: none !important;
  background: transparent !important;
  color: inherit !important;
  font-size: 12.5px !important;
  font-family: inherit !important;
  outline: none !important;
  text-overflow: ellipsis !important;
  padding: 0 6px 0 2px !important;
  position: relative !important;
  z-index: 1 !important;
}
.window-url-input.is-pretty {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  caret-color: transparent !important;
}
.window-url-icon-btn,
.window-url-go-btn {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 24px !important;
  height: 24px !important;
  border: none !important;
  background: transparent !important;
  cursor: pointer !important;
  padding: 0 !important;
  border-radius: 6px !important;
  color: inherit !important;
  opacity: 0.55 !important;
  transition: opacity 0.12s ease, background 0.12s ease !important;
  -webkit-app-region: no-drag !important;
}
.window-url-icon-btn:hover,
.window-url-go-btn:hover {
  opacity: 1 !important;
  background: rgba(125, 125, 125, 0.2) !important;
}
.window-url-go-btn {
  opacity: 0.72 !important;
}
.window-url-bar-form.is-focused .window-url-go-btn {
  color: #93c5fd !important;
  opacity: 1 !important;
}
html[data-theme="light"] .window-url-bar-form.is-focused .window-url-go-btn {
  color: #2563eb !important;
}

/* Multi-AI Product Switcher Tabs
   Original CSS uses flex:1 1 0 + min-width:0 on buttons (3-item pill).
   Eight labels then share the sidebar width and paint on top of each other. */
.home-sidebar-sister .centrix-product-switch,
.centrix-product-switch {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
  box-sizing: border-box !important;
  padding: 4px !important;
  background: rgba(125, 125, 125, 0.1) !important;
  border: 1px solid rgba(125, 125, 125, 0.18) !important;
  border-radius: 12px !important;
  overflow: visible !important;
  line-height: 1.2 !important;
  -webkit-app-region: no-drag !important;
}
.centrix-product-switch::-webkit-scrollbar {
  display: none !important;
}
.home-sidebar-sister .centrix-product-switch button,
.home-greeting .centrix-product-switch button,
.centrix-product-switch button {
  display: inline-block !important;
  flex: none !important;
  flex-grow: 0 !important;
  flex-shrink: 0 !important;
  flex-basis: auto !important;
  min-width: auto !important;
  width: auto !important;
  max-width: none !important;
  position: static !important;
  float: none !important;
  vertical-align: middle !important;
  margin: 2px !important;
  padding: 4px 10px !important;
  border-radius: 999px !important;
  font-size: 12px !important;
  font-weight: 600 !important;
  color: inherit !important;
  opacity: 0.72 !important;
  background: transparent !important;
  border: none !important;
  cursor: pointer !important;
  white-space: nowrap !important;
  overflow: visible !important;
  transition: none !important;
  -webkit-app-region: no-drag !important;
}
.centrix-product-switch button:hover {
  opacity: 1 !important;
  background: rgba(125, 125, 125, 0.2) !important;
}
.centrix-product-switch button.is-current {
  opacity: 1 !important;
  color: #ffffff !important;
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.35) !important;
}
`;

for (const f of files) {
  const p = path.join(dir, f);
  let css = fs.readFileSync(p, "utf8");
  if (!css.includes("window-url-bar-form")) {
    css += "\n" + cssStyles;
    fs.writeFileSync(p, css);
  }
}
' "$TMP_ASAR"

# ── 6. validate syntax ──────────────────────────────────────
node --check "$TMP_ASAR/desktop/main.cjs"
node --check "$TMP_ASAR/desktop/service-catalog.cjs"
node --check "$TMP_ASAR/desktop/preload.cjs"
node --check "$TMP_ASAR/desktop/debug-flag-guard.cjs"
log "  ✓ Syntax check passed"

# ── 7. repack ───────────────────────────────────────────────
log "Repacking asar…"
npx --yes @electron/asar pack "$TMP_ASAR" "$ASAR"
rm -rf "$TMP_ASAR"

# ── 8. patch integrity ──────────────────────────────────────
log "Patching executable integrity hashes…"
patch_exe_integrity_hash

log "✅ Patch complete!"

# ── 9. restart ──────────────────────────────────────────────
if [[ "$NO_RESTART" == "true" ]]; then
  log "Skipping restart (--no-restart)."
else
  log "Restarting CentriX…"
  kill_centrix
  start_centrix
  log "Done."
fi
