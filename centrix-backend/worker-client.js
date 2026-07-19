"use strict";
// Phase B B3 — backend → Electron-worker RPC client. Calls the private worker-rpc server (worker-rpc.js)
// for the cookie/storage operations that REQUIRE Electron. The backend keeps gate + scope + per-session
// encryption + logging; only the raw snapshot read/write crosses this seam.
const http = require("node:http");
const { workerAuthHeader, bodyHash } = require("./shared/worker-auth");

const WORKER_URL = process.env.CENTRIX_WORKER_RPC_URL || "http://127.0.0.1:17999/rpc";
const WORKER_SECRET = process.env.CENTRIX_WORKER_RPC_SECRET || "";

function rpc(method, params, opts = {}) {
  const url = opts.url || WORKER_URL;
  const secret = opts.secret != null ? opts.secret : WORKER_SECRET;
  const timeoutMs = opts.timeoutMs || 30000;
  return new Promise((resolve) => {
    // NEVER reject — a down/unreachable worker resolves to { status:0, ok:false } so callers (and the
    // backend routes) map it cleanly to 502 instead of throwing a generic 500.
    let u;
    try { u = new URL(url); } catch (e) { resolve({ status: 0, ok: false, error: "bad worker url: " + ((e && e.message) || e) }); return; }
    const data = Buffer.from(JSON.stringify({ method, params: params || {} }));
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length, "X-Worker-Auth": workerAuthHeader(secret, method, bodyHash(data)) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let j;
          try { j = JSON.parse(raw); } catch { j = { ok: false, error: "bad worker response", raw: String(raw).slice(0, 200) }; }
          if (j.ok === undefined && res.statusCode >= 400) j.ok = false;
          resolve({ status: res.statusCode, ...j });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, ok: false, error: String((e && e.message) || e) }));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("worker rpc timeout")); });
    req.write(data); req.end();
  });
}

module.exports = {
  rpc,
  workerHealth: (opts) => rpc("health", {}, opts),
  getRawSnapshot: (params, opts) => rpc("getRawSnapshot", params, opts),
  putRawSnapshot: (params, opts) => rpc("putRawSnapshot", params, opts),
  workerRevision: (params, opts) => rpc("revision", params, opts),
  workerLock: (params, opts) => rpc("lock", params, opts),
  workerRelease: (params, opts) => rpc("release", params, opts),
  workerTakeover: (params, opts) => rpc("takeover", params, opts),
  workerLoginStatus: (params, opts) => rpc("loginStatus", params, opts),
  workerLoader: (verb, tabId, args, opts) => rpc("loader", { verb, tabId, args }, opts),
  WORKER_URL, WORKER_SECRET,
};
