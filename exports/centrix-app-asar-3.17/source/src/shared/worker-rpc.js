"use strict";
// Phase B B3 — the WORKER side of the cloud-backend ↔ Electron-worker seam. Exposes the Electron-only
// profile operations (cookie/storage read+write, revision, single-device lock, login-status) over a private
// localhost RPC the cloud backend calls. The raw snapshot read/write REQUIRES Electron (session.cookies +
// hidden BrowserWindow) → it cannot live in the backend; this module is what stays on the worker.
//
// Dependency-injected (NO `require("electron")` here) so it unit-tests with mocks. The App Server wires the
// real closures (exportProfileSnapshot/getProfileSession/profileRevision/locks/…) in via createWorkerRpcServer.
//
// Scope-cookies + EXPORT_GATE + per-session encryption all run in the BACKEND. The worker returns the raw
// (optionally service-scoped) snapshot; an App User NEVER talks to the worker directly.
const http = require("node:http");
const { verifyWorkerAuth, bodyHash } = require("./worker-auth");

// SSRF/local-file guard: the loader drives the SHARED custodian browser and /api/frame streams its pixels
// back, so a navigate/open target MUST NOT be able to read local files (file:) or reach internal hosts.
// data:/about: are opaque-origin (cannot read files or exfil internal via the frame) → allowed.
function assertSafeLoaderUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || "")); } catch { throw new Error("loader: invalid url"); }
  if (u.protocol === "data:" || u.protocol === "about:") return rawUrl;
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("loader: scheme not allowed (" + u.protocol + ")");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const blocked =
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" ||
    /^127\./.test(host) || /^0\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
    /^fe80:/.test(host) || /^fc/.test(host) || /^fd/.test(host);
  if (blocked) throw new Error("loader: internal host not allowed (" + host + ")");
  return u.toString();
}
// Electron rejects loadURL with ERR_ABORTED(-3) when a real login page supersedes the navigation (client
// redirect / SSO bounce). That's benign — the tab DID navigate — so swallow it (mirrors did-fail-load -3).
function isAbortError(e) { return /ERR_ABORTED|(^|\D)-3(\D|$)/.test(String((e && e.message) || e)); }
async function safeLoadURL(wc, url) { try { await wc.loadURL(url); } catch (e) { if (!isAbortError(e)) throw e; } }

// Drives the custodian login browser for the website admin (B5). Dependency-injected loader closures
// (the App Server's existing tab functions) — keeps the Electron tab machinery on the worker.
async function dispatchLoader(api, verb, tabId, args) {
  const TAB = tabId || "tab-a";
  args = args || {};
  if (verb === "login-status") {
    const results = await api.serviceLoginStatuses(args.serviceIds, args.profileId || "default");
    return { ok: true, profileId: args.profileId || "default", results };
  }
  if (verb === "open") {
    const target = await api.targetFromOpenPayload(args);
    assertSafeLoaderUrl(target.url); // reject file:/internal before driving the shared browser
    let state;
    try {
      state = await api.createOrReplaceTab(TAB, {
        profileId: args.profileId || "default", userId: args.userId, proxyRules: args.proxyRules,
        serviceId: target.serviceId, serviceName: target.serviceName, url: target.url,
        width: args.width, height: args.height, show: args.show === true, focus: args.focus === true,
      });
    } catch (e) {
      if (!isAbortError(e)) throw e; // benign redirect abort — the tab was created + navigated
      try { state = api.getTabState(await api.getTabForRequest(TAB)); } catch { state = { url: target.url }; }
    }
    return { ok: true, state };
  }
  const tab = await api.getTabForRequest(TAB);
  const wc = api.getTabWebContents(tab);
  const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number(v || d))));
  switch (verb) {
    case "navigate": await safeLoadURL(wc, assertSafeLoaderUrl(api.normalizeUrl(args.url))); break;
    case "back": if (wc.canGoBack()) wc.goBack(); break;
    case "forward": if (wc.canGoForward()) wc.goForward(); break;
    case "reload": wc.reload(); break;
    case "show": tab.window.show(); tab.window.focus(); break;
    case "hide": tab.window.hide(); break;
    case "devtools": wc.openDevTools({ mode: "detach" }); break;
    case "resize": tab.window.setContentSize(clamp(args.width, 800, 2200, 1280), clamp(args.height, 520, 1600, 820)); break;
    case "click": api.sendMouseClick(tab, args); break;
    case "move": api.sendMouseMove(tab, args); break;
    case "wheel": api.sendMouseWheel(tab, args); break;
    case "type": if (args.text) await wc.insertText(String(args.text)); break;
    case "key": api.sendKey(tab, String(args.key || "")); break;
    case "close": tab.window.close(); return { ok: true, closed: TAB };
    case "frame": return { ok: true, framePng: await api.capture(tab), state: api.getTabState(tab) };
    case "state": break;
    default: throw new Error("unknown loader verb: " + verb);
  }
  return { ok: true, state: api.getTabState(tab) };
}

function createWorkerRpcServer(deps) {
  const {
    secret,
    port = Number(process.env.CENTRIX_WORKER_RPC_PORT || 17999),
    host = process.env.CENTRIX_WORKER_RPC_HOST || "127.0.0.1",
    // injected closures (App Server wires the real ones; tests pass mocks)
    exportProfileSnapshot, importProfileSnapshot, getProfileSession,
    profileRevision, setProfileRevision, readServicesConfig,
    acquireProfileLock, releaseProfileLock, lockHeldBy, requestAccountTakeover,
    clearActiveDeviceIfHolder, loginStatuses, pushProfileBackup, suppressBump,
    loaderApi = null, // injected tab-control closures (B5); null on a worker that only does cookies
    log = () => {},
  } = deps;

  if (!secret) throw new Error("worker-rpc: missing shared secret (CENTRIX_WORKER_RPC_SECRET)");

  async function handle(method, params) {
    params = params || {};
    switch (method) {
      case "health":
        return { ok: true, ts: Date.now() };

      case "getRawSnapshot": {
        // = exportProfileSnapshot(custodianSession, …). Backend passes the granted services + scopeCookies
        // so data-minimization happens at the source (only the user's services leave the worker).
        const { targetSession, profileId } = await getProfileSession(params.profileId);
        const snapshot = await exportProfileSnapshot(targetSession, {
          profileId,
          services: params.services || [],
          includeStorage: params.includeStorage !== false,
          scopeCookies: params.scopeCookies === true,
        });
        return { ok: true, snapshot };
      }

      case "putRawSnapshot": {
        // = importProfileSnapshot(custodianSession, snapshot) + the single-device lock/baseRevision guard,
        // best-effort backup, revision bump and self-bump suppression (revision/lock state is worker-owned).
        const { targetSession, profileId } = await getProfileSession(params.profileId);
        const deviceId = params.deviceId || "device";
        if (params.singleDevice === true) {
          if (lockHeldBy && !lockHeldBy(profileId, deviceId)) {
            return { ok: false, error: "profile-locked-by-other", revision: profileRevision(profileId) };
          }
          if (params.baseRevision == null || Number(params.baseRevision) !== profileRevision(profileId)) {
            return { ok: false, error: "stale-revision", revision: profileRevision(profileId) };
          }
        }
        try {
          const config = await readServicesConfig();
          const before = await exportProfileSnapshot(targetSession, { profileId, services: config.services, includeStorage: false });
          if (pushProfileBackup) pushProfileBackup(profileId, before);
        } catch { /* best-effort */ }
        const result = await importProfileSnapshot(targetSession, { ...(params.snapshot || {}), profileId });
        const newRevision = profileRevision(profileId) + 1;
        if (setProfileRevision) setProfileRevision(profileId, newRevision);
        if (suppressBump) suppressBump(profileId);
        return { ok: true, profileId, revision: newRevision, result };
      }

      case "revision":
        return { ok: true, profileId: params.profileId, revision: profileRevision(params.profileId) };

      case "lock": {
        const r = acquireProfileLock ? acquireProfileLock(params.profileId, params.deviceId, params.userId) : { ok: true };
        return { ok: r.ok !== false, ...r, revision: profileRevision(params.profileId) };
      }

      case "release": {
        const released = releaseProfileLock ? releaseProfileLock(params.profileId, params.deviceId) : false;
        if (clearActiveDeviceIfHolder) { try { clearActiveDeviceIfHolder(params.userId, params.deviceId); } catch { /* best-effort */ } }
        return { ok: true, released };
      }

      case "takeover": {
        const r = requestAccountTakeover ? requestAccountTakeover(params.userId, params.deviceId) : { evicting: false };
        return { ok: true, ...r };
      }

      case "loginStatus": {
        const statuses = loginStatuses ? await loginStatuses(params.serviceIds || [], params.profileId) : [];
        return { ok: true, statuses };
      }

      case "loader": {
        if (!loaderApi) throw new Error("loader not available on this worker");
        return await dispatchLoader(loaderApi, params.verb, params.tabId, params.args);
      }

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/rpc") { res.writeHead(404); res.end("not found"); return; }
    // Accumulate raw BYTES (not a decoded string) so the body hash matches the client's hash of the exact
    // bytes — a multibyte UTF-8 char split across two chunks would corrupt a string concat and break auth.
    const chunks = []; let total = 0;
    req.on("data", (c) => { chunks.push(c); total += c.length; if (total > 64 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      const rawBuf = Buffer.concat(chunks);
      let body;
      try { body = JSON.parse(rawBuf.toString("utf8") || "{}"); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"ok":false,"error":"bad json"}'); return; }
      const method = String(body.method || "");
      if (!verifyWorkerAuth(secret, method, bodyHash(rawBuf), req.headers["x-worker-auth"])) {
        res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"ok":false,"error":"unauthorized"}'); return;
      }
      try {
        const out = await handle(method, body.params);
        const buf = Buffer.from(JSON.stringify(out));
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": buf.length }); res.end(buf);
      } catch (e) {
        const buf = Buffer.from(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
        res.writeHead(500, { "Content-Type": "application/json", "Content-Length": buf.length }); res.end(buf);
      }
    });
  });

  return {
    start() { return new Promise((resolve) => server.listen(port, host, () => { log(`[worker-rpc] private RPC on ${host}:${port}`); resolve({ port, host }); })); },
    stop() { return new Promise((resolve) => server.close(() => resolve())); },
    handle, // exported for in-process unit tests
  };
}

module.exports = { createWorkerRpcServer };
