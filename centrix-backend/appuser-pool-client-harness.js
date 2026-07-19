"use strict";
// APP-USER CLIENT × POOL — REAL-Electron validation of the per-service pool pull the App User now does.
// Boots the REAL backend in pool-mode (PROFILE_FROM_DB), seeds TWO services from TWO different pool profiles,
// then exercises the exact CLIENT mechanic (`pullServiceProfileFromServer`): GET export?service=<id> with the
// real account headers → decrypt with the device session key → importProfileSnapshot into a REAL Electron
// partition. Proves the client-side properties pool-harness (pure node) can't: real cookie import, and that a
// second service's import is ADDITIVE (claude does NOT wipe chatgpt) inside one live session. Self-exits < 2m.

const path = require("node:path");
process.env.CENTRIX_BACKEND_PORT = "18794";
process.env.CENTRIX_STAFF_RBAC = "on";
process.env.CENTRIX_REMOTE_TOKEN = "appuser-pool-master";
process.env.CENTRIX_PROFILE_FROM_DB = "1";
process.env.CENTRIX_MASTER_SNAPSHOT_KEY = require("node:crypto").randomBytes(32).toString("base64");
process.env.CENTRIX_SNAPSHOT_AT_REST_KEY = require("node:crypto").randomBytes(32).toString("base64");
process.env.CENTRIX_SNAPSHOT_DIR = path.join(process.env.TEMP || ".", "centrix-appuser-pool-test-" + process.pid);
process.env.CENTRIX_POOL_CAPACITY = "5";

const { app, session } = require("electron");
app.disableHardwareAcceleration();

const http = require("node:http");
const { URL } = require("node:url");
const profileCrypto = require("./shared/profile-crypto");
const localDb = require("./shared/local-db");
const appAttest = require("./shared/app-attest");
// The CLIENT's real Electron profile-sync module (the one remote-user-main.js imports) — this is what we test.
const clientSync = require("../centrix-full-repo/src/shared/profile-sync");

const MASTER = process.env.CENTRIX_REMOTE_TOKEN, MASTER_KEY = process.env.CENTRIX_MASTER_SNAPSHOT_KEY;
const PORT = 18794, BASE = "http://127.0.0.1:" + PORT;
const PARTITION = "persist:appuser-pool-test";
const SVCS = [
  { id: "chatgpt", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com", "openai.com"] },
  { id: "claude", url: "https://claude.ai", cookieDomains: ["claude.ai"] },
];
const ACCT = "ACCT_APPUSER", ACCT_KEY = profileCrypto.newSessionKey();
// Account granted BOTH services (so per-service pulls are allowed); the pool gives one profile per service.
localDb.verifyAccountToken = async (t) => (t === ACCT ? { userId: "acct1", profileId: "default", deviceId: "d1", email: "a@x", sessionKey: ACCT_KEY } : null);
localDb.servicesForUser = async () => ({ config: { services: SVCS }, user: {}, uiRules: [], modelPolicies: [] });

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + "  " + (e != null ? JSON.stringify(e).slice(0, 220) : "")); } }

function reqMaster(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { Authorization: `Bearer ${MASTER}`, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, (res) => { let raw = ""; res.on("data", (c) => raw += c); res.on("end", () => { let j; try { j = JSON.parse(raw); } catch { j = raw; } resolve({ status: res.statusCode, json: j }); }); });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
// Account GET with the SAME headers the App User client attaches for /api/profile/export (Bearer + Sig + Attest).
function reqAcct(p) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const h = { Authorization: `Bearer ${ACCT}`, "X-CentriX-User": "acct1", "X-CentriX-Attest": appAttest.clientAttestHeader("acct1"), "X-CentriX-Sig": appAttest.exportSignHeader(ACCT, "default") };
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers: h }, (res) => { let raw = ""; res.on("data", (c) => raw += c); res.on("end", () => { let j; try { j = JSON.parse(raw); } catch { j = raw; } resolve({ status: res.statusCode, json: j }); }); });
    r.on("error", reject); r.end();
  });
}
const snapFor = (id, val) => {
  if (id === "chatgpt") return { version: 1, cookies: [{ name: "__Secure-next-auth.session-token", value: val, domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" }] };
  return { version: 1, cookies: [{ name: "sessionKey", value: val, domain: "claude.ai", path: "/", secure: true, httpOnly: true, url: "https://claude.ai/" }] };
};
async function seed(pid, id, val) { return reqMaster("POST", "/api/profile/import", { profileId: pid, encrypted: profileCrypto.encryptSnapshot(snapFor(id, val), MASTER_KEY) }); }

// Replica of the client's pullServiceProfileFromServer mechanic: pull → decrypt(sessionKey) → ADDITIVE import.
async function clientPull(targetSession, serviceId) {
  const r = await reqAcct(`/api/profile/export?service=${encodeURIComponent(serviceId)}&includeStorage=0`);
  if (r.status !== 200 || !r.json || !r.json.ok) return { status: r.status, json: r.json };
  const snapshot = profileCrypto.decryptSnapshot(r.json.encrypted, ACCT_KEY); // device session key
  const imported = await clientSync.importProfileSnapshot(targetSession, snapshot);
  return { status: 200, assignedProfile: r.json.assignedProfile, snapshot, imported };
}
// The exact pool-mode flag-resolution ternary copied from remote-user-main.js connectToServer.
function resolvePoolMode(envVal, health) {
  return envVal === "1" ? true : envVal === "0" ? false : (health && health.profilePool === true);
}

require("./server");

app.on("window-all-closed", () => { /* keep the harness alive */ });

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 700));
  const sess = session.fromPartition(PARTITION);
  console.log("\n== App User client × POOL: per-service pull, real Electron additive import ==");
  try {
    // Server advertises pool capability so the client auto-enables pool-mode.
    const health = await reqMaster("GET", "/api/health");
    check("server /api/health advertises profilePool:true", health.status === 200 && health.json.profilePool === true, health.json);
    check("client resolvePoolMode(no env, health) → true", resolvePoolMode(undefined, health.json) === true, null);
    check("client resolvePoolMode('0', health) → false (emergency off)", resolvePoolMode("0", health.json) === false, null);
    check("client resolvePoolMode(no env, no-pool health) → false (legacy server)", resolvePoolMode(undefined, { ok: true }) === false, null);

    // Seed two pool profiles, one per service.
    const s1 = await seed("chatgpt-1", "chatgpt", "CGVAL"); check("seed chatgpt-1 → 200", s1.status === 200 && s1.json.ok, s1.status);
    const s2 = await seed("claude-1", "claude", "CLVAL"); check("seed claude-1 → 200", s2.status === 200 && s2.json.ok, s2.status);

    await reqAcct("/api/services"); // stamp interaction so the export gate passes

    // ---- Client opens ChatGPT: per-service pull + real Electron import ----
    const pCg = await clientPull(sess, "chatgpt");
    check("pull(chatgpt) → 200 + assignedProfile", pCg.status === 200 && pCg.assignedProfile === "chatgpt-1", { st: pCg.status, ap: pCg.assignedProfile });
    check("pulled chatgpt snapshot is SCOPED (no claude cookie leaked)", !!pCg.snapshot && !(pCg.snapshot.cookies || []).some((c) => /claude\.ai/.test(c.domain || "")), (pCg.snapshot && pCg.snapshot.cookies || []).map((c) => c.domain));
    let cg = await sess.cookies.get({ url: "https://chatgpt.com/" });
    check("chatgpt cookie ACTUALLY landed in the live Electron partition", cg.some((c) => c.name === "__Secure-next-auth.session-token" && c.value === "CGVAL"), cg.map((c) => c.name));
    let cl = await sess.cookies.get({ url: "https://claude.ai/" });
    check("claude partition still EMPTY before its service is opened", cl.length === 0, cl.map((c) => c.name));

    // ---- Client then opens Claude: import MUST be additive (must NOT wipe chatgpt) ----
    const pCl = await clientPull(sess, "claude");
    check("pull(claude) → 200 + assignedProfile", pCl.status === 200 && pCl.assignedProfile === "claude-1", { st: pCl.status, ap: pCl.assignedProfile });
    cl = await sess.cookies.get({ url: "https://claude.ai/" });
    check("claude cookie landed after opening claude", cl.some((c) => c.name === "sessionKey" && c.value === "CLVAL"), cl.map((c) => c.name));
    cg = await sess.cookies.get({ url: "https://chatgpt.com/" });
    check("ADDITIVE: chatgpt cookie SURVIVES claude import (no partition wipe)", cg.some((c) => c.name === "__Secure-next-auth.session-token" && c.value === "CGVAL"), cg.map((c) => c.name));

    // ---- Sticky: re-opening chatgpt returns the SAME assigned profile ----
    const pCg2 = await clientPull(sess, "chatgpt");
    check("sticky: re-pull(chatgpt) → same assigned profile chatgpt-1", pCg2.assignedProfile === "chatgpt-1", pCg2.assignedProfile);

    // ---- Security: a device with the WRONG session key cannot decrypt the pulled blob ----
    const raw = await reqAcct("/api/profile/export?service=chatgpt&includeStorage=0");
    let wrongThrew = false; try { profileCrypto.decryptSnapshot(raw.json.encrypted, profileCrypto.newSessionKey()); } catch { wrongThrew = true; }
    check("export blob is per-session encrypted (wrong key → decrypt throws)", wrongThrew, null);
  } catch (e) {
    fail++; console.log("  FAIL  harness threw: " + (e && e.message));
  }

  // cleanup
  try { for (const c of await sess.cookies.get({})) { const u = "http" + (c.secure ? "s" : "") + "://" + (c.domain || "").replace(/^\./, "") + (c.path || "/"); await sess.cookies.remove(u, c.name).catch(() => {}); } } catch { /* best-effort */ }
  try { require("node:fs").rmSync(process.env.CENTRIX_SNAPSHOT_DIR, { recursive: true, force: true }); } catch { /* */ }
  console.log("\n== " + pass + " passed, " + fail + " failed ==\n");
  app.exit(fail === 0 ? 0 : 1);
});
