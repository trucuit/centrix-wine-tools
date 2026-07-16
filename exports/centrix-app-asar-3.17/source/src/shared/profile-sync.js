const { BrowserWindow, session } = require("electron");
const { SHARED_BROWSER_PREFIX } = require("./gibberish-names");

const DEFAULT_PROFILE = "default";
const STORAGE_TIMEOUT_MS = 7000;

function sanitizeProfileId(value, fallback = DEFAULT_PROFILE) {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80) || fallback;
}

function partitionForProfile(profileId) {
  return `persist:${SHARED_BROWSER_PREFIX}${sanitizeProfileId(profileId)}`;
}

function sessionForProfile(profileId) {
  return session.fromPartition(partitionForProfile(profileId));
}

function originFromUrl(input) {
  try {
    return new URL(String(input || "")).origin;
  } catch {
    return "";
  }
}

function originsFromServices(services = []) {
  const origins = new Set();

  for (const service of services || []) {
    const origin = originFromUrl(service?.url);
    if (origin) origins.add(origin);
  }

  return Array.from(origins);
}

// Registrable domain via a simple last-two-labels heuristic (covers the bundled
// services: chatgpt.com, claude.ai, google.com, ...). Good enough for cookie
// scoping; multi-label public suffixes (e.g. co.uk) are not handled.
function registrableDomain(host) {
  const parts = String(host || "")
    .toLowerCase()
    .replace(/^\.+/, "")
    .split(".")
    .filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function allowedCookieRegistrables(services = []) {
  const hosts = new Set();
  for (const service of services || []) {
    for (const domain of service?.cookieDomains || []) {
      const reg = registrableDomain(domain);
      if (reg) hosts.add(reg);
    }
    for (const url of [service?.url, service?.loginUrl]) {
      try {
        const reg = registrableDomain(new URL(url).hostname);
        if (reg) hosts.add(reg);
      } catch {
        // ignore non-URL
      }
    }
  }
  return hosts;
}

function cookieUrl(cookie) {
  if (cookie.url) return cookie.url;
  const domain = String(cookie.domain || "").replace(/^\./, "");
  if (!domain) return "";
  const protocol = cookie.secure ? "https:" : "http:";
  return `${protocol}//${domain}${cookie.path || "/"}`;
}

function serializableCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    session: cookie.session,
    expirationDate: cookie.expirationDate,
    sameSite: cookie.sameSite,
    url: cookieUrl(cookie)
  };
}

function cookieForSet(cookie) {
  const name = String(cookie.name || "");
  // SECURE-REQUIRED cookies: the __Secure-/__Host- name prefixes AND SameSite=None (no_restriction) all REQUIRE
  // the Secure attribute — Electron's cookies.set (like Chrome) REJECTS the set otherwise, silently dropping
  // Google's core auth cookies (__Secure-1PSID / __Secure-3PSID / __Secure-*PSIDTS, most SameSite=None) → the
  // Google session never lands → "logged out of Google". Force Secure for these so both the cookie and its
  // https:// url are accepted, even if the source snapshot lost/omitted the secure flag.
  const sameSiteRaw = String(cookie.sameSite || "").toLowerCase();
  const isSameSiteNone = sameSiteRaw === "no_restriction" || sameSiteRaw === "none";
  const mustBeSecure = /^__(secure|host)-/i.test(name) || isSameSiteNone;
  const secure = Boolean(cookie.secure) || mustBeSecure;
  const next = {
    url: cookieUrl({ ...cookie, secure }), // https:// when secure — required for the cookies above
    name,
    value: String(cookie.value || ""),
    path: cookie.path || "/",
    secure,
    httpOnly: Boolean(cookie.httpOnly)
  };

  if (!next.url || !next.name) return null;
  // Drop an ALREADY-EXPIRED cookie instead of forwarding its past expirationDate: Electron's cookies.set
  // with a past date is a DELETE, so seeding a day-old snapshot would WIPE a still-valid same-name cookie
  // from the jar (a service that logs in one hour and not the next). A session cookie (no expiry) is kept.
  if (cookie.expirationDate && Number.isFinite(Number(cookie.expirationDate))) {
    const exp = Number(cookie.expirationDate);
    if (exp * 1000 <= Date.now()) return null;
    next.expirationDate = exp;
  }
  // Host-only / __Host- cookies MUST NOT carry a Domain attribute — Electron's cookies.set REJECTS a
  // __Host- cookie that has `domain`, silently dropping the single most important auth cookie (ChatGPT /
  // Claude / Google-class services use __Host-*). Set them host-only via `url` alone; only attach `domain`
  // for genuinely domain-scoped cookies.
  const isHostOnly = cookie.hostOnly === true || /^__Host-/i.test(name);
  if (cookie.domain && !isHostOnly) next.domain = cookie.domain;

  // Normalize SameSite to Electron's vocabulary (unspecified|no_restriction|lax|strict). Some export paths emit
  // Chrome-style "None"/"Lax"/"Strict" — map them so SameSite=None survives (Google's third-party auth cookies
  // are dropped/mis-scoped without it). Already forced Secure above (SameSite=None requires it).
  let ss = sameSiteRaw;
  if (ss === "none") ss = "no_restriction";
  if (["unspecified", "no_restriction", "lax", "strict"].includes(ss)) {
    next.sameSite = ss;
  }

  return next;
}

function waitForLoad(webContents, timeoutMs = STORAGE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, error = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      webContents.removeListener("did-finish-load", onFinish);
      webContents.removeListener("did-fail-load", onFail);
      resolve({ ok, error });
    };
    const onFinish = () => finish(true);
    const onFail = (_event, _code, description) => finish(false, description || "failed to load");
    const timer = setTimeout(() => finish(false, "storage load timeout"), timeoutMs);

    webContents.once("did-finish-load", onFinish);
    webContents.once("did-fail-load", onFail);
  });
}

function storageReadScript() {
  return `(() => {
    const local = {};
    const sessionItems = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      local[key] = localStorage.getItem(key);
    }
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      sessionItems[key] = sessionStorage.getItem(key);
    }
    return { localStorage: local, sessionStorage: sessionItems };
  })()`;
}

function storageWriteScript(localStorageItems = {}, sessionStorageItems = {}) {
  return `(() => {
    const local = ${JSON.stringify(localStorageItems || {})};
    const sess = ${JSON.stringify(sessionStorageItems || {})};
    let n = 0;
    for (const [key, value] of Object.entries(local)) { try { localStorage.setItem(key, value == null ? "" : String(value)); n += 1; } catch (e) {} }
    for (const [key, value] of Object.entries(sess)) { try { sessionStorage.setItem(key, value == null ? "" : String(value)); n += 1; } catch (e) {} }
    return n;
  })()`;
}

async function withHiddenStorageWindow(targetSession, task) {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: targetSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  try {
    return await task(win);
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

async function exportOriginStorage(win, origin) {
  const wc = win.webContents;
  try {
    const loadPromise = waitForLoad(wc);
    await wc.loadURL(origin).catch(() => {});
    const load = await loadPromise;
    const data = await wc.executeJavaScript(storageReadScript(), true);
    return {
      origin,
      ok: true,
      loadOk: load.ok,
      loadError: load.error,
      localStorage: data?.localStorage || {},
      sessionStorage: data?.sessionStorage || {}
    };
  } catch (error) {
    return {
      origin,
      ok: false,
      error: error.message,
      localStorage: {},
      sessionStorage: {}
    };
  }
}

async function importOriginStorage(win, item) {
  const origin = item?.origin;
  if (!origin) return { origin: "", ok: false, error: "missing origin" };

  const wc = win.webContents;
  try {
    const loadPromise = waitForLoad(wc);
    await wc.loadURL(origin).catch(() => {});
    const load = await loadPromise;
    const count = await wc.executeJavaScript(storageWriteScript(item.localStorage || {}, item.sessionStorage || {}), true);
    return {
      origin,
      ok: true,
      loadOk: load.ok,
      loadError: load.error,
      localStorageCount: count || 0
    };
  } catch (error) {
    return {
      origin,
      ok: false,
      error: error.message,
      localStorageCount: 0
    };
  }
}

async function exportProfileSnapshot(targetSession, options = {}) {
  const profileId = sanitizeProfileId(options.profileId);
  const origins = Array.isArray(options.origins)
    ? options.origins.filter(Boolean)
    : originsFromServices(options.services || []);

  let cookies = (await targetSession.cookies.get({})).map(serializableCookie);
  // Data minimization (mục 5): only sync cookies for the registrable domains of
  // the services the user is actually granted. Off by default (admin/full export).
  if (options.scopeCookies) {
    const allowed = allowedCookieRegistrables(options.services || []);
    cookies = cookies.filter((cookie) => allowed.has(registrableDomain(cookie.domain)));
  }
  const storage = [];

  if (options.includeStorage !== false && origins.length) {
    await withHiddenStorageWindow(targetSession, async (win) => {
      for (const origin of origins) {
        storage.push(await exportOriginStorage(win, origin));
      }
    });
  }

  return {
    version: 1,
    profileId,
    exportedAt: new Date().toISOString(),
    origins,
    cookies,
    storage
  };
}

async function importProfileSnapshot(targetSession, snapshot = {}) {
  const result = {
    cookieCount: 0,
    cookieErrors: [],
    storageCount: 0,
    storageErrors: []
  };

  for (const cookie of snapshot.cookies || []) {
    const next = cookieForSet(cookie);
    if (!next) continue;

    try {
      await targetSession.cookies.set(next);
      result.cookieCount += 1;
    } catch (error) {
      result.cookieErrors.push({ name: cookie.name || "", domain: cookie.domain || "", error: error.message });
    }
  }

  const storageItems = (snapshot.storage || []).filter((item) => item?.origin);
  if (storageItems.length) {
    await withHiddenStorageWindow(targetSession, async (win) => {
      for (const item of storageItems) {
        const imported = await importOriginStorage(win, item);
        if (imported.ok) {
          result.storageCount += imported.localStorageCount || 0;
        } else {
          result.storageErrors.push(imported);
        }
      }
    });
  }

  if (typeof targetSession.flushStorageData === "function") {
    await targetSession.flushStorageData();
  }

  return result;
}

module.exports = {
  exportProfileSnapshot,
  importProfileSnapshot,
  originsFromServices,
  partitionForProfile,
  sanitizeProfileId,
  sessionForProfile
};
