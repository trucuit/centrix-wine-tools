"use strict";
// Proves the DB-snapshot mode: the backend serves /api/profile/export|import from a STORED at-rest snapshot
// with NO worker and NO Electron — i.e. the server needs no always-on App Server. Plain node (no Electron).

const path = require("node:path");
const SNAPDIR = path.join(process.env.TEMP || ".", "centrix-dbsnap-test-" + process.pid);
process.env.CENTRIX_BACKEND_PORT = "18793";
process.env.CENTRIX_STAFF_RBAC = "on";
process.env.CENTRIX_REMOTE_TOKEN = "dbsnap-master";
process.env.CENTRIX_PROFILE_FROM_DB = "1";              // ← DB mode (no worker)
process.env.CENTRIX_MASTER_SNAPSHOT_KEY = require("node:crypto").randomBytes(32).toString("base64");
process.env.CENTRIX_SNAPSHOT_AT_REST_KEY = require("node:crypto").randomBytes(32).toString("base64");
process.env.CENTRIX_SNAPSHOT_DIR = SNAPDIR;
// deliberately NO CENTRIX_WORKER_RPC_URL — there is no worker; any accidental worker call must NOT be reached.

const http = require("node:http");
const { URL } = require("node:url");
const profileCrypto = require("./shared/profile-crypto");
const appAttest = require("./shared/app-attest");
const localDb = require("./shared/local-db");
const profileSnapshot = require("./profile-snapshot");

const BACKEND = "http://127.0.0.1:18793";
const MASTER = process.env.CENTRIX_REMOTE_TOKEN, MASTER_KEY = process.env.CENTRIX_MASTER_SNAPSHOT_KEY;
const ACCT = "ACCT_DBSNAP", ACCT_KEY = profileCrypto.newSessionKey();

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + "  " + (e != null ? JSON.stringify(e).slice(0, 220) : "")); } }
function req(method, p, { token = MASTER, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BACKEND + p);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) };
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => { let raw = ""; res.on("data", (c) => raw += c); res.on("end", () => { let j; try { j = JSON.parse(raw); } catch { j = raw; } resolve({ status: res.statusCode, json: j }); }); });
    r.on("error", reject); r.setTimeout(15000, () => r.destroy(new Error("timeout"))); if (data) r.write(data); r.end();
  });
}
const acctHdr = () => ({ "X-CentriX-User": "dbu1", "X-CentriX-Attest": appAttest.clientAttestHeader("dbu1"), "X-CentriX-Sig": appAttest.exportSignHeader(ACCT, "default") });

(async () => {
  // Seed the store (this is what a manager-app push / bootstrap does): chatgpt + an unrelated facebook cookie.
  await profileSnapshot.seedSnapshot("default", {
    origins: ["https://chatgpt.com", "https://facebook.com"],
    cookies: [
      { name: "__Secure-next-auth.session-token", value: "CG", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" },
      { name: "c_user", value: "FB", domain: "facebook.com", path: "/", url: "https://facebook.com/" },
    ],
    storage: [{ origin: "https://chatgpt.com", localStorage: { k: "v" }, sessionStorage: {} }],
  });

  localDb.verifyAccountToken = async (t) => (t === ACCT ? { userId: "dbu1", profileId: "default", deviceId: "d1", email: "u1@x", sessionKey: ACCT_KEY } : null);
  localDb.servicesForUser = async () => ({ config: { services: [{ id: "chatgpt", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com", "openai.com"] }] }, user: {}, uiRules: [], modelPolicies: [] });
  require("./server");
  await new Promise((r) => setTimeout(r, 500));

  console.log("\n== DB-snapshot mode (NO worker, NO Electron — server serves cookies from the stored snapshot) ==");
  try {
    const h = await req("GET", "/api/health");
    check("backend up (pure Node, no worker)", h.status === 200 && h.json.ok, h.status);

    // master pull from the STORE
    const exp = await req("GET", "/api/profile/export?profileId=default&includeStorage=0");
    check("master export from STORE → 200 encrypted (no worker called)", exp.status === 200 && exp.json.ok && exp.json.encrypted, { st: exp.status, j: exp.json });
    const mSnap = profileCrypto.decryptSnapshot(exp.json.encrypted, MASTER_KEY);
    check("master snapshot has the seeded cookies", (mSnap.cookies || []).length === 2, (mSnap.cookies || []).map((c) => c.name));
    check("revision starts at 1 (seeded)", exp.json.revision === 1, exp.json.revision);

    // account pull — gate + scope + per-session key, all from the STORE
    const acct = { token: ACCT };
    await req("GET", "/api/services", acct); // stamp interaction
    const aexp = await req("GET", "/api/profile/export?includeStorage=0", { token: ACCT, headers: acctHdr() });
    check("account export from STORE → 200 encrypted-with-sessionKey", aexp.status === 200 && aexp.json.encrypted, { st: aexp.status, j: aexp.json });
    const aSnap = profileCrypto.decryptSnapshot(aexp.json.encrypted, ACCT_KEY);
    let masterCant = false; try { profileCrypto.decryptSnapshot(aexp.json.encrypted, MASTER_KEY); } catch { masterCant = true; }
    check("account snapshot NOT decryptable with master key (per-session, no relay)", masterCant, null);
    check("account scope drops facebook (granted=chatgpt only)", !(aSnap.cookies || []).some((c) => /facebook/.test(c.domain || "")) && (aSnap.cookies || []).length >= 1, (aSnap.cookies || []).map((c) => c.name));

    // account push (refreshed cookie) → store bumps + merges
    aSnap.cookies.push({ name: "cg_refreshed", value: "NEW", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" });
    const imp = await req("POST", "/api/profile/import", { token: ACCT, body: { encrypted: profileCrypto.encryptSnapshot(aSnap, ACCT_KEY) } });
    check("account encrypted push → 200 + revision bump (2)", imp.status === 200 && imp.json.ok && imp.json.revision === 2, { st: imp.status, j: imp.json });

    // re-pull (master) → merged: facebook STILL there (not wiped by the scoped account push) + new cookie present
    const exp2 = await req("GET", "/api/profile/export?profileId=default&includeStorage=0");
    const m2 = profileCrypto.decryptSnapshot(exp2.json.encrypted, MASTER_KEY);
    const names = (m2.cookies || []).map((c) => c.name);
    check("merge: scoped account push KEPT facebook + ADDED cg_refreshed", names.includes("c_user") && names.includes("cg_refreshed"), names);
    check("revision now 2 after push", exp2.json.revision === 2, exp2.json.revision);

    // lock/revision in DB mode (no live custodian)
    check("profile/lock (db mode) → ok", (await req("POST", "/api/profile/lock", { token: ACCT, body: {} })).json.ok === true, null);
    check("profile/revision (db mode) → 2", (await req("GET", "/api/profile/revision?profileId=default")).json.revision === 2, null);

    // empty-profile export → 404 no-snapshot (not a crash, not plaintext)
    check("export of an un-seeded profile → 404 no-snapshot", (await req("GET", "/api/profile/export?profileId=ghost")).status === 404, null);

    // ----- adversarial-fix verification -----
    // (A) optimistic CAS: a stale baseRevision is rejected, not silently clobbered
    const staleBody = { encrypted: profileCrypto.encryptSnapshot({ version: 1, cookies: [{ name: "z", domain: "chatgpt.com", path: "/", url: "https://chatgpt.com/" }] }, ACCT_KEY), baseRevision: 0 };
    check("stale baseRevision → 409 (optimistic CAS, no lost-update)", (await req("POST", "/api/profile/import", { token: ACCT, body: staleBody })).status === 409, null);

    // (B) wrong at-rest key on the EXISTING blob → fail CLOSED (no silent overwrite/data-loss)
    const storeMod = require("./snapshot-store");
    await storeMod.putSnapshotRecord("wrongkey", { blob: profileCrypto.encryptSnapshot({ version: 1, cookies: [{ name: "keep", domain: "x.com", path: "/" }] }, profileCrypto.newSessionKey()), revision: 5 });
    const wk = await req("POST", "/api/profile/import", { body: { profileId: "wrongkey", encrypted: profileCrypto.encryptSnapshot({ version: 1, cookies: [{ name: "evil", domain: "chatgpt.com", path: "/" }] }, MASTER_KEY) } });
    check("import onto an undecryptable blob → NOT 200 (fail closed)", wk.status !== 200, wk.status);
    const wkRec = await storeMod.getSnapshotRecord("wrongkey");
    check("…and the shared snapshot is NOT replaced (revision still 5)", wkRec && wkRec.revision === 5, wkRec && wkRec.revision);

    // (C) logout propagation: a scoped push that omits a cookie REPLACES that service's cookies (not union)
    const logoutSnap = { version: 1, cookies: [{ name: "cc_keep", value: "1", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" }] };
    await req("POST", "/api/profile/import", { token: ACCT, body: { encrypted: profileCrypto.encryptSnapshot(logoutSnap, ACCT_KEY) } });
    const mL = profileCrypto.decryptSnapshot((await req("GET", "/api/profile/export?profileId=default&includeStorage=0")).json.encrypted, MASTER_KEY);
    const cg = mL.cookies.filter((c) => /chatgpt/.test(c.domain || ""));
    check("logout propagates: chatgpt cookies = only the latest push; facebook (other service) kept", cg.length === 1 && cg[0].name === "cc_keep" && mL.cookies.some((c) => /facebook/.test(c.domain || "")), mL.cookies.map((c) => c.name));

    // (D) concurrency: 10 simultaneous pushes → revision advances by exactly 10 (mutex serialized, none lost)
    const before = (await req("GET", "/api/profile/revision?profileId=default")).json.revision;
    const pushes = [];
    for (let i = 0; i < 10; i++) {
      const snap = { version: 1, cookies: [{ name: "race" + i, value: "v", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" }] };
      pushes.push(req("POST", "/api/profile/import", { token: ACCT, body: { encrypted: profileCrypto.encryptSnapshot(snap, ACCT_KEY) } }));
    }
    const oks = (await Promise.all(pushes)).filter((r) => r.status === 200).length;
    const after = (await req("GET", "/api/profile/revision?profileId=default")).json.revision;
    check("10 concurrent pushes → all 200 + revision += exactly 10 (no lost-update)", oks === 10 && after === before + 10, { oks, before, after });
  } catch (e) { fail++; console.log("  FAIL  harness threw: " + (e && e.message)); }

  try { require("node:fs").rmSync(SNAPDIR, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
