"use strict";
// FROZEN — private worker↔backend RPC auth (localhost only). Keep this file BYTE-IDENTICAL in the backend
// (`D:\VCF\centrix-backend\shared\worker-auth.js`) and the App Server (`src\shared\worker-auth.js`).
// Header `X-Worker-Auth: ${ts_ms}.${hex(HMAC_SHA256(secret,"ts:method:bodyHash"))[:32]}`, ±2min window,
// timing-safe. The bodyHash binding stops a captured header being replayed with DIFFERENT params.
const crypto = require("node:crypto");

const WORKER_AUTH_WINDOW_MS = 2 * 60 * 1000;

function bodyHash(raw) { return crypto.createHash("sha256").update(raw || "").digest("hex"); }

function workerAuthHeader(secret, method, bodyHashHex, tsMs) {
  const ts = String(tsMs || Date.now());
  const mac = crypto.createHmac("sha256", String(secret)).update(`${ts}:${method}:${bodyHashHex || ""}`).digest("hex").slice(0, 32);
  return `${ts}.${mac}`;
}

function verifyWorkerAuth(secret, method, bodyHashHex, header, nowMs) {
  if (!secret) return false; // never allow an unset secret (fail closed)
  const raw = String(header || "");
  const dot = raw.indexOf(".");
  if (dot < 0) return false;
  const ts = raw.slice(0, dot), mac = raw.slice(dot + 1);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs((nowMs || Date.now()) - tsNum) > WORKER_AUTH_WINDOW_MS) return false;
  const expected = crypto.createHmac("sha256", String(secret)).update(`${ts}:${method}:${bodyHashHex || ""}`).digest("hex").slice(0, 32);
  const a = Buffer.from(mac), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { workerAuthHeader, verifyWorkerAuth, bodyHash, WORKER_AUTH_WINDOW_MS };
