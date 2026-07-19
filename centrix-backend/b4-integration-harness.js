"use strict";
// B4 FULL integration (self-contained, ONE Electron process, runs to completion + exits): the cloud-backend
// HTTP front-door + the worker RPC + a REAL Electron custodian + REAL crypto, exercised over localhost HTTP
// exactly as a cutover client would. Uses a TEST custodian partition (NOT the production logins) → safe +
// deterministic. This is the two-real-processes seam, colocated for an automated run.

// env MUST be set before requiring the backend (its modules read env at load time)
process.env.CENTRIX_BACKEND_PORT = "18791";
process.env.CENTRIX_BACKEND_HOST = "127.0.0.1";
process.env.CENTRIX_STAFF_RBAC = "on";
process.env.CENTRIX_REMOTE_TOKEN = "cxm_b4_integration_master";
process.env.CENTRIX_PROFILE_VIA_WORKER = "1";
process.env.CENTRIX_WORKER_RPC_SECRET = "b4-integration-secret-xyz";
process.env.CENTRIX_WORKER_RPC_URL = "http://127.0.0.1:17966/rpc";
process.env.CENTRIX_MASTER_SNAPSHOT_KEY = require("node:crypto").randomBytes(32).toString("base64");

const { app, session } = require("electron");
app.disableHardwareAcceleration();

const http = require("node:http");
const { URL } = require("node:url");
const { createWorkerRpcServer } = require("../centrix-website/src/shared/worker-rpc");
const realSync = require("../centrix-website/src/shared/profile-sync");
const profileCrypto = require("./shared/profile-crypto");
const appAttest = require("./shared/app-attest");
const localDb = require("./shared/local-db");

// The real client signs each export (X-CentriX-Sig) + attests (X-CentriX-Attest, keyed to x-centrix-user).
function acctExportHeaders(token, userId) {
  return { "X-CentriX-User": userId, "X-CentriX-Attest": appAttest.clientAttestHeader(userId), "X-CentriX-Sig": appAttest.exportSignHeader(token, "default") };
}

const BACKEND = "http://127.0.0.1:18791";
const MASTER = process.env.CENTRIX_REMOTE_TOKEN;
const MASTER_KEY = process.env.CENTRIX_MASTER_SNAPSHOT_KEY;
const PARTITION = "persist:b4integration";
// Account-path fixtures: a real per-session key + two bearer tokens (one keyed, one key-less).
const ACCT_TOKEN = "ACCT_TEST_TOKEN", ACCT_NOKEY_TOKEN = "ACCT_NOKEY_TOKEN";
const ACCT_KEY = profileCrypto.newSessionKey();

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + "  " + (e != null ? JSON.stringify(e).slice(0, 220) : "")); } }

function httpReq(method, path, body, opts = {}) {
  const token = opts.token === undefined ? MASTER : opts.token; // null = no auth header
  const extra = opts.headers || {};
  return new Promise((resolve, reject) => {
    const u = new URL(BACKEND + path);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) };
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => { let j; try { j = JSON.parse(raw); } catch { j = raw; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject); r.setTimeout(40000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data); r.end();
  });
}

app.on("window-all-closed", () => { /* hidden storage windows close — do not quit */ });

app.whenReady().then(async () => {
  const custodian = session.fromPartition(PARTITION);
  await custodian.cookies.set({ url: "https://chatgpt.com/", name: "__Secure-next-auth.session-token", value: "FAKE_CG", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true });
  await custodian.cookies.set({ url: "https://facebook.com/", name: "c_user", value: "PRIVATE_FB", domain: "facebook.com", path: "/" });

  const revisions = new Map();
  const rpc = createWorkerRpcServer({
    secret: process.env.CENTRIX_WORKER_RPC_SECRET, port: 17966,
    exportProfileSnapshot: realSync.exportProfileSnapshot,
    importProfileSnapshot: realSync.importProfileSnapshot,
    getProfileSession: async (pid) => ({ targetSession: custodian, profileId: pid || "default" }),
    profileRevision: (pid) => revisions.get(pid) || 0,
    setProfileRevision: (pid, r) => revisions.set(pid, r),
    readServicesConfig: async () => ({ services: [{ id: "chatgpt", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com", "openai.com"] }] }),
    lockHeldBy: () => true,
  });
  await rpc.start();

  // Stub ONLY the DB-auth resolution (tested elsewhere) so the seam's ACCOUNT branches run: a known bearer
  // resolves to kind:'account' with a real per-session key; servicesForUser grants chatgpt only (for scoping).
  localDb.verifyAccountToken = async (token) => {
    if (token === ACCT_TOKEN) return { userId: "acct-u1", profileId: "default", deviceId: "dev-acct", email: "acct@test", sessionKey: ACCT_KEY };
    if (token === ACCT_NOKEY_TOKEN) return { userId: "acct-u2", profileId: "default", deviceId: "dev-acct2", email: "nokey@test", sessionKey: "" };
    return null;
  };
  localDb.servicesForUser = async () => ({ config: { services: [{ id: "chatgpt", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com", "openai.com"] }] }, user: {}, uiRules: [], modelPolicies: [] });

  require("./server");                          // backend HTTP front-door, in-process (env already set)
  await new Promise((r) => setTimeout(r, 600)); // let both listeners bind

  console.log("\n== B4 FULL integration (HTTP front-door → worker RPC → REAL Electron custodian) ==");
  try {
    const health = await httpReq("GET", "/api/health");
    check("backend /api/health reachable over HTTP", health.status === 200 && health.json.ok, health.status);

    const exp = await httpReq("GET", "/api/profile/export?profileId=default&includeStorage=0");
    check("HTTP /api/profile/export → 200 encrypted (backend→worker→real custodian)", exp.status === 200 && exp.json.ok && exp.json.encrypted, { st: exp.status, err: exp.json && exp.json.error });
    check("response envelope is aesgcm (master-key encrypted, not plaintext)", exp.json.encrypted && exp.json.encrypted.enc === "aesgcm", exp.json.encrypted && exp.json.encrypted.enc);

    let snap = null;
    try { snap = profileCrypto.decryptSnapshot(exp.json.encrypted, MASTER_KEY); } catch (e) { check("decrypt with master snapshot key", false, e.message); }
    if (snap) {
      check("decrypted snapshot version:1 + cookies[]", snap.version === 1 && Array.isArray(snap.cookies), { v: snap.version });
      check("master full export carries the seeded cookies (>=2)", snap.cookies.length >= 2, snap.cookies.length);
      console.log(`        cookies=${snap.cookies.length} origins=${snap.origins.length} rev=${exp.json.revision}`);
    }

    const rev = await httpReq("GET", "/api/profile/revision?profileId=default");
    check("HTTP /api/profile/revision → 200", rev.status === 200 && rev.json.ok && typeof rev.json.revision === "number", rev.status);

    if (snap) {
      snap.cookies.push({ name: "b4http", value: "OK", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" });
      const before = exp.json.revision;
      const imp = await httpReq("POST", "/api/profile/import", { profileId: "default", encrypted: profileCrypto.encryptSnapshot(snap, MASTER_KEY) });
      check("HTTP /api/profile/import → 200 + revision bumped", imp.status === 200 && imp.json.ok && imp.json.revision === before + 1, { st: imp.status, rev: imp.json && imp.json.revision });
      const live = await custodian.cookies.get({ url: "https://chatgpt.com/" });
      check("imported cookie ACTUALLY landed in the real custodian (HTTP→RPC→Electron)", live.some((c) => c.name === "b4http" && c.value === "OK"), live.map((c) => c.name));
    }

    const noTok = await httpReq("GET", "/api/profile/export", null, { token: null });
    check("export with NO token → 401 (gate enforced over HTTP)", noTok.status === 401, noTok.status);

    // ===== ACCOUNT path (the real product path; the master tests above never exercise these branches) =====
    console.log("  --- account path (scope + per-session key + EXPORT_GATE + fail-closed) ---");
    const acct = { token: ACCT_TOKEN };
    const expNoInt = await httpReq("GET", "/api/profile/export?includeStorage=0", null, acct);
    check("account export with NO prior interaction → 403 no-client-interaction (always-on gate)", expNoInt.status === 403 && expNoInt.json && expNoInt.json.reason === "no-client-interaction", { st: expNoInt.status, j: expNoInt.json });

    await httpReq("GET", "/api/services", null, acct); // any non-export account call stamps interaction
    const expA = await httpReq("GET", "/api/profile/export?includeStorage=0", null, { token: ACCT_TOKEN, headers: acctExportHeaders(ACCT_TOKEN, "acct-u1") });
    check("account export AFTER interaction (+valid sig/attest) → 200 encrypted", expA.status === 200 && expA.json.ok && expA.json.encrypted, { st: expA.status, j: expA.json });
    let acctSnap = null;
    try { acctSnap = profileCrypto.decryptSnapshot(expA.json.encrypted, ACCT_KEY); } catch (e) { check("decrypt with account sessionKey", false, e.message); }
    if (acctSnap) {
      check("account snapshot decrypts with the account's OWN sessionKey", acctSnap.version === 1 && Array.isArray(acctSnap.cookies), null);
      let masterCantRead = false; try { profileCrypto.decryptSnapshot(expA.json.encrypted, MASTER_KEY); } catch { masterCantRead = true; }
      check("account export NOT decryptable with master key (per-session isolation, no relay)", masterCantRead, null);
      const fbLeak = acctSnap.cookies.some((c) => /facebook/.test(c.domain || ""));
      check("account scopeCookies DROPS facebook (granted=chatgpt only) over HTTP", !fbLeak && acctSnap.cookies.length >= 1, { n: acctSnap.cookies.length, fbLeak });
    }

    await httpReq("GET", "/api/services", null, { token: ACCT_NOKEY_TOKEN }); // interact so we reach the key check
    const expNoKey = await httpReq("GET", "/api/profile/export?includeStorage=0", null, { token: ACCT_NOKEY_TOKEN, headers: acctExportHeaders(ACCT_NOKEY_TOKEN, "acct-u2") });
    check("no-sessionKey account export → 403, NEVER plaintext (fail-closed)", expNoKey.status === 403 && !(expNoKey.json && expNoKey.json.snapshot), { st: expNoKey.status, j: expNoKey.json });

    const impPlain = await httpReq("POST", "/api/profile/import", { snapshot: { version: 1, cookies: [] } }, acct);
    check("account PLAINTEXT import → 400 (encrypted required, no blind overwrite)", impPlain.status === 400, { st: impPlain.status, j: impPlain.json });

    if (acctSnap) {
      acctSnap.cookies.push({ name: "acct_push", value: "OK", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" });
      const imp = await httpReq("POST", "/api/profile/import", { encrypted: profileCrypto.encryptSnapshot(acctSnap, ACCT_KEY) }, acct);
      check("account ENCRYPTED import → 200 + revision bump", imp.status === 200 && imp.json.ok && typeof imp.json.revision === "number", { st: imp.status, j: imp.json });

      // import scoping: a facebook cookie (NOT granted) is dropped; a chatgpt cookie (granted) lands.
      const inject = { version: 1, profileId: "default", origins: [], storage: [], cookies: [
        { name: "acct_fb_inject", value: "EVIL", domain: "facebook.com", path: "/", url: "https://facebook.com/" },
        { name: "acct_cg_ok", value: "GRANTED", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" },
      ] };
      const impScope = await httpReq("POST", "/api/profile/import", { encrypted: profileCrypto.encryptSnapshot(inject, ACCT_KEY) }, acct);
      check("account scoped import → 200", impScope.status === 200 && impScope.json.ok, impScope.status);
      const cgC = await custodian.cookies.get({ url: "https://chatgpt.com/" });
      const fbC = await custodian.cookies.get({ url: "https://facebook.com/" });
      check("granted chatgpt cookie LANDED via account import", cgC.some((c) => c.name === "acct_cg_ok"), null);
      check("non-granted facebook cookie DROPPED (import scoping — no cross-service injection)", !fbC.some((c) => c.name === "acct_fb_inject"), fbC.map((c) => c.name));
    }
    const badKeyExp = await httpReq("GET", "/api/profile/export?profileId=default&includeStorage=0");
    let wrongThrew = false; try { profileCrypto.decryptSnapshot(badKeyExp.json.encrypted, require("node:crypto").randomBytes(32).toString("base64")); } catch { wrongThrew = true; }
    check("response NOT decryptable with a wrong key (per-key isolation over HTTP)", wrongThrew, null);
  } catch (e) {
    fail++; console.log("  FAIL  harness threw: " + (e && e.message));
  }

  try { for (const c of await custodian.cookies.get({})) { const u = "http" + (c.secure ? "s" : "") + "://" + (c.domain || "").replace(/^\./, "") + (c.path || "/"); await custodian.cookies.remove(u, c.name).catch(() => {}); } } catch { /* best-effort */ }
  await rpc.stop();
  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  app.exit(fail === 0 ? 0 : 1);
});
