"use strict";
// B5 loader-seam validation — REAL Electron. Boots a headless Electron, provides minimal REAL tab closures
// (BrowserWindow) as loaderApi, starts the real worker-rpc, and drives the loader verbs through the real
// worker-client RPC: open → navigate → state → frame (real capturePage→PNG) → login-status → close. Proves
// the website→backend→worker loader seam reaches real Electron browser control. Runs to completion + exits.
const PORT = 17955;
const SECRET = "b5-loader-secret-AbC_123";
// Backend front-door env — set BEFORE requiring ./server + worker-client so they read it. Proves the loader
// also works through the backend HTTP gate (not just direct worker-client RPC).
process.env.CENTRIX_BACKEND_PORT = "18795";
process.env.CENTRIX_LOADER_VIA_WORKER = "1";
process.env.CENTRIX_STAFF_RBAC = "on";
process.env.CENTRIX_REMOTE_TOKEN = "b5-loader-master";
process.env.CENTRIX_WORKER_RPC_SECRET = SECRET;
process.env.CENTRIX_WORKER_RPC_URL = `http://127.0.0.1:${PORT}/rpc`;

const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
const http = require("node:http");
const { URL } = require("node:url");
const { createWorkerRpcServer } = require("../centrix-website/src/shared/worker-rpc");
const worker = require("./worker-client");
const localDb = require("./shared/local-db");

const OPTS = { url: `http://127.0.0.1:${PORT}/rpc`, secret: SECRET };
const BACKEND = "http://127.0.0.1:18795";
const MASTER = process.env.CENTRIX_REMOTE_TOKEN;
function httpReq(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BACKEND + path);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) };
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const buf = Buffer.concat(chunks); const ct = res.headers["content-type"] || ""; let j = null; if (ct.includes("json")) { try { j = JSON.parse(buf.toString()); } catch { /* */ } } resolve({ status: res.statusCode, ctype: ct, len: buf.length, json: j }); });
    });
    r.on("error", reject); r.setTimeout(20000, () => r.destroy(new Error("timeout"))); if (data) r.write(data); r.end();
  });
}

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + "  " + (e != null ? JSON.stringify(e).slice(0, 200) : "")); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.on("window-all-closed", () => { /* keep the harness alive after a tab closes */ });

app.whenReady().then(async () => {
  const tabs = new Map();
  const loaderApi = {
    targetFromOpenPayload: async (a) => ({ serviceId: a.serviceId || "test", serviceName: a.serviceName || "Test", url: a.url || "about:blank" }),
    createOrReplaceTab: async (tabId, opts) => {
      const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { offscreen: false } });
      if (opts.url) { try { await win.loadURL(opts.url); } catch { /* benign abort */ } } // await (like the real one) → no race with navigate
      tabs.set(tabId, { window: win, state: { tabId, serviceId: opts.serviceId, url: opts.url } });
      return { tabId, serviceId: opts.serviceId, url: opts.url };
    },
    getTabForRequest: async (tabId) => { const t = tabs.get(tabId); if (!t || t.window.isDestroyed()) throw new Error("no tab"); return t; },
    getTabWebContents: (t) => t.window.webContents,
    getTabState: (t) => ({ url: t.window.webContents.getURL(), title: t.window.webContents.getTitle() }),
    normalizeUrl: (u) => String(u || ""),
    sendMouseClick: (t, a) => t.window.webContents.sendInputEvent({ type: "mouseDown", x: Number(a.x || 1), y: Number(a.y || 1), button: "left", clickCount: 1 }),
    sendMouseMove: () => {}, sendMouseWheel: () => {},
    sendKey: (t) => t.window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" }),
    serviceLoginStatuses: async (ids) => (ids || ["chatgpt"]).map((id) => ({ serviceId: id, loggedIn: false })),
    capture: async (t) => (await t.window.webContents.capturePage()).toPNG().toString("base64"),
  };
  const rpc = createWorkerRpcServer({ secret: SECRET, port: PORT, loaderApi });
  await rpc.start();
  // Stub only the DB-auth resolution so the backend gate sees an 'account' caller (must be 403 on loader).
  localDb.verifyAccountToken = async (t) => (t === "ACCT_LOADER" ? { userId: "u1", profileId: "default", deviceId: "d1", email: "a@b", sessionKey: "k" } : null);
  require("./server"); // backend HTTP front-door, in-process (env already set)
  await new Promise((r) => setTimeout(r, 500));
  console.log("\n== B5 loader seam (worker-rpc + REAL Electron BrowserWindow) ==");

  try {
    const h = await worker.workerHealth(OPTS);
    check("worker health", h.status === 200 && h.ok, h);

    const open = await worker.workerLoader("open", "tab-a", { serviceId: "test", url: "data:text/html,<title>B5Open</title><body>open" }, OPTS);
    check("loader OPEN → 200 + state", open.status === 200 && open.ok && open.state, { st: open.status, j: open });

    const nav = await worker.workerLoader("navigate", "tab-a", { url: "data:text/html,<title>B5LoaderTest</title><body>hello-b5" }, OPTS);
    check("loader NAVIGATE → 200 + state.url is the data URL", nav.ok && /B5LoaderTest/.test(nav.state && nav.state.url || ""), nav.state);
    await sleep(300); // let it paint

    const st = await worker.workerLoader("state", "tab-a", {}, OPTS);
    check("loader STATE → title reflects the navigated page", st.ok && st.state && st.state.title === "B5LoaderTest", st.state);

    const frame = await worker.workerLoader("frame", "tab-a", {}, OPTS);
    check("loader FRAME → real PNG (capturePage under Electron)", frame.ok && typeof frame.framePng === "string" && frame.framePng.startsWith("iVBOR"), { ok: frame.ok, len: frame.framePng && frame.framePng.length, head: frame.framePng && frame.framePng.slice(0, 12) });

    const ls = await worker.workerLoader("login-status", "tab-a", { serviceIds: ["chatgpt", "claude"] }, OPTS);
    check("loader LOGIN-STATUS → results[]", ls.ok && Array.isArray(ls.results) && ls.results.length === 2, ls.results);

    const keyed = await worker.workerLoader("key", "tab-a", { key: "Enter" }, OPTS);
    check("loader KEY → 200 (sendInputEvent dispatched to real webContents)", keyed.ok, keyed.status);

    // SSRF / local-file guard (HIGH fix): the shared browser must refuse file:// + internal hosts.
    const ssrfFile = await worker.workerLoader("navigate", "tab-a", { url: "file:///C:/Windows/win.ini" }, OPTS);
    check("loader navigate file:// → REJECTED (no local-file read via frame)", ssrfFile.ok === false && /not allowed/.test(ssrfFile.error || ""), ssrfFile);
    const ssrfInternal = await worker.workerLoader("navigate", "tab-a", { url: "http://127.0.0.1:19779/" }, OPTS);
    check("loader navigate 127.0.0.1 → REJECTED (no internal SSRF)", ssrfInternal.ok === false && /not allowed/.test(ssrfInternal.error || ""), ssrfInternal);
    const ssrfMeta = await worker.workerLoader("navigate", "tab-a", { url: "http://169.254.169.254/latest/meta-data/" }, OPTS);
    check("loader navigate cloud-metadata IP → REJECTED", ssrfMeta.ok === false, ssrfMeta);
    const okPublic = await worker.workerLoader("navigate", "tab-a", { url: "data:text/html,<title>ok</title>" }, OPTS);
    check("loader navigate data: (opaque, safe) → allowed", okPublic.ok === true, okPublic.status);

    const closed = await worker.workerLoader("close", "tab-a", {}, OPTS);
    check("loader CLOSE → closed", closed.ok && closed.closed === "tab-a", closed);

    const bad = await worker.workerLoader("navigate", "tab-a", { url: "x" }, { ...OPTS, secret: "wrong" });
    check("loader with bad RPC secret → 401", bad.status === 401, bad.status);

    const unknown = await worker.workerLoader("frobnicate", "tab-a", {}, OPTS);
    check("unknown loader verb → error (not 200)", unknown.status >= 400 || unknown.ok === false, { st: unknown.status, ok: unknown.ok });

    // ===== through the BACKEND over HTTP (gate + route forwarding — the real production call path) =====
    console.log("  --- via backend HTTP (gate) ---");
    const lsM = await httpReq("POST", "/api/service/login-status", MASTER, { serviceIds: ["chatgpt", "claude"] });
    check("HTTP backend login-status (master) → 200 forwarded to worker", lsM.status === 200 && lsM.json && lsM.json.ok, { st: lsM.status, j: lsM.json });
    const lsA = await httpReq("POST", "/api/service/login-status", "ACCT_LOADER", { serviceIds: ["chatgpt"] });
    check("HTTP backend loader as ACCOUNT → 403 (gate keeps accounts off the login browser)", lsA.status === 403, lsA.status);
    const openH = await httpReq("POST", "/api/open", MASTER, { tabId: "tab-h", serviceId: "test", url: "data:text/html,<title>H</title><body>http" });
    check("HTTP backend /api/open (master) → 200 + state (real tab created via RPC)", openH.status === 200 && openH.json && openH.json.ok && openH.json.state, { st: openH.status, j: openH.json });
    await sleep(400); // let tab-h paint before capturePage
    const frameH = await httpReq("GET", "/api/frame?tabId=tab-h", MASTER);
    check("HTTP backend /api/frame (master) → image/png streamed from the worker", frameH.status === 200 && /image\/png/.test(frameH.ctype) && frameH.len > 100, { st: frameH.status, ct: frameH.ctype, len: frameH.len });
    const openNoTok = await httpReq("POST", "/api/open", null, { url: "data:text/html,x" });
    check("HTTP backend /api/open with NO token → 401", openNoTok.status === 401, openNoTok.status);
  } catch (e) {
    fail++; console.log("  FAIL  harness threw: " + (e && e.message));
  }

  for (const t of tabs.values()) { try { if (!t.window.isDestroyed()) t.window.destroy(); } catch { /* */ } }
  await rpc.stop();
  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  app.exit(fail === 0 ? 0 : 1);
});
