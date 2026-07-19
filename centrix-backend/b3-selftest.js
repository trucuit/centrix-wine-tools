"use strict";
// B3 seam test — proves the cloud-backend ↔ Electron-worker cookie pipeline end-to-end ACROSS the process
// boundary with REAL RPC auth + REAL per-session crypto, mocking ONLY the Electron cookie/storage I/O
// (dependency-injected into worker-rpc). The real-Electron + real-App-User hop is B4.

const { createWorkerRpcServer } = require("../centrix-website/src/shared/worker-rpc");
const worker = require("./worker-client");
const crypto = require("./shared/profile-crypto");

const PORT = 17988;
const SECRET = "b3-test-worker-secret-AbC_123";
const OPTS = { url: `http://127.0.0.1:${PORT}/rpc`, secret: SECRET };

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}  ${extra != null ? JSON.stringify(extra).slice(0, 240) : ""}`); } }
function reg(domain) { return String(domain || "").replace(/^\./, "").split(".").slice(-2).join("."); }

// ---- mock custodian (stands in for the Electron persistent partition) ----
function makeCustodian(seed) {
  const store = new Map();
  for (const c of seed) store.set(`${c.name}|${c.domain}`, c);
  return {
    store,
    targetSession: {
      cookies: {
        get: async () => Array.from(store.values()),
        set: async (c) => { store.set(`${c.name}|${c.domain || ""}`, c); },
      },
    },
  };
}
async function mockExport(targetSession, opts) {
  let cookies = (await targetSession.cookies.get({})).map((c) => ({
    name: c.name, value: c.value, domain: c.domain, hostOnly: false, path: c.path || "/",
    secure: !!c.secure, httpOnly: !!c.httpOnly, session: false, expirationDate: c.expirationDate || null,
    sameSite: c.sameSite || "unspecified", url: `https://${reg(c.domain)}${c.path || "/"}`,
  }));
  if (opts.scopeCookies) {
    const allowed = new Set();
    for (const s of (opts.services || [])) for (const d of (s.cookieDomains || [])) allowed.add(reg(d));
    cookies = cookies.filter((c) => allowed.has(reg(c.domain)));
  }
  return { version: 1, profileId: opts.profileId, exportedAt: "2026-06-29T00:00:00.000Z", origins: (opts.services || []).map((s) => s.url).filter(Boolean), cookies, storage: [] };
}
async function mockImport(targetSession, snapshot) {
  let n = 0;
  for (const c of (snapshot.cookies || [])) { await targetSession.cookies.set(c); n++; }
  return { cookieCount: n, cookieErrors: [], storageCount: 0, storageErrors: [] };
}

const SERVICES = [
  { id: "chatgpt", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com", "openai.com"] },
  { id: "claude", url: "https://claude.ai", cookieDomains: ["claude.ai"] },
];

(async () => {
  const custodian = makeCustodian([
    { name: "cg", value: "1", domain: "chatgpt.com", path: "/" },
    { name: "oa", value: "2", domain: ".openai.com", path: "/" },
    { name: "cl", value: "3", domain: "claude.ai", path: "/" },
    { name: "fb", value: "x", domain: "facebook.com", path: "/" }, // unrelated — must never leak
  ]);
  const revisions = new Map();
  const locks = new Map();
  const server = createWorkerRpcServer({
    secret: SECRET, port: PORT,
    exportProfileSnapshot: mockExport,
    importProfileSnapshot: mockImport,
    getProfileSession: async (pid) => ({ targetSession: custodian.targetSession, profileId: pid || "default" }),
    profileRevision: (pid) => revisions.get(pid) || 0,
    setProfileRevision: (pid, r) => revisions.set(pid, r),
    readServicesConfig: async () => ({ services: SERVICES }),
    acquireProfileLock: (pid, dev) => { locks.set(pid, dev); return { ok: true, holder: dev }; },
    releaseProfileLock: (pid, dev) => { if (locks.get(pid) === dev) { locks.delete(pid); return true; } return false; },
    lockHeldBy: (pid, dev) => locks.get(pid) === dev,
    requestAccountTakeover: () => ({ evicting: true, graceMs: 5000 }),
  });
  await server.start();
  console.log(`\n== B3 seam self-test (worker-rpc mock on ${PORT}) ==`);

  // 1. health + auth
  const h = await worker.workerHealth(OPTS);
  check("worker health (good secret) → ok", h.status === 200 && h.ok === true, h);
  const hBad = await worker.workerHealth({ ...OPTS, secret: "wrong" });
  check("worker health (bad secret) → 401", hBad.status === 401, hBad.status);

  // 2. getRawSnapshot — full vs scoped
  const full = await worker.getRawSnapshot({ profileId: "default", services: SERVICES, scopeCookies: false }, OPTS);
  check("getRawSnapshot full → 4 cookies", full.ok && full.snapshot.cookies.length === 4, full.snapshot && full.snapshot.cookies.length);
  const scoped = await worker.getRawSnapshot({ profileId: "default", services: [SERVICES[0]], scopeCookies: true }, OPTS);
  const scopedNames = (scoped.snapshot.cookies || []).map((c) => c.name).sort();
  check("getRawSnapshot scoped(chatgpt) → only cg+oa (claude+fb dropped)", scoped.ok && JSON.stringify(scopedNames) === JSON.stringify(["cg", "oa"]), scopedNames);
  check("scoped snapshot is version:1 + has origins", scoped.snapshot.version === 1 && Array.isArray(scoped.snapshot.origins), scoped.snapshot.version);

  // 3. per-session crypto round-trip (what the backend does before returning to the App User)
  const sessionKey = crypto.newSessionKey();
  const env = crypto.encryptSnapshot(scoped.snapshot, sessionKey);
  check("encryptSnapshot → aesgcm envelope {enc,iv,tag,data}", env.enc === "aesgcm" && !!env.iv && !!env.tag && !!env.data, Object.keys(env));
  const back = crypto.decryptSnapshot(env, sessionKey);
  check("decryptSnapshot(sessionKey) deep-equals original", JSON.stringify(back) === JSON.stringify(scoped.snapshot), null);
  let wrongKeyThrew = false;
  try { crypto.decryptSnapshot(env, crypto.newSessionKey()); } catch { wrongKeyThrew = true; }
  check("decrypt with WRONG key throws (per-session isolation)", wrongKeyThrew, null);

  // 4. FULL pipeline: backend export → App User decrypt/edit/re-encrypt → backend decrypt → worker put
  const exp = await worker.getRawSnapshot({ profileId: "default", services: [SERVICES[0]], scopeCookies: true }, OPTS);
  const envOut = crypto.encryptSnapshot(exp.snapshot, sessionKey);                 // backend → device
  const onDevice = crypto.decryptSnapshot(envOut, sessionKey);                     // device decrypts
  onDevice.cookies.push({ name: "cg2", value: "logged-in", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" });
  const envIn = crypto.encryptSnapshot(onDevice, sessionKey);                      // device → backend (push)
  const decoded = crypto.decryptSnapshot(envIn, sessionKey);                       // backend decrypts
  const put = await worker.putRawSnapshot({ profileId: "default", snapshot: decoded, deviceId: "devA" }, OPTS);
  check("putRawSnapshot → ok + revision bumped to 1", put.ok && put.revision === 1, { ok: put.ok, rev: put.revision });
  check("new cookie cg2 landed in the custodian store", custodian.store.has("cg2|chatgpt.com"), Array.from(custodian.store.keys()));
  const rev = await worker.workerRevision({ profileId: "default" }, OPTS);
  check("worker revision now 1", rev.ok && rev.revision === 1, rev.revision);

  // 5. single-device lock + optimistic baseRevision
  await worker.workerLock({ profileId: "default", deviceId: "devA", userId: "u1" }, OPTS);
  const putStale = await worker.putRawSnapshot({ profileId: "default", snapshot: decoded, deviceId: "devA", singleDevice: true, baseRevision: 0 }, OPTS);
  check("single-device put with STALE baseRevision → stale-revision", putStale.ok === false && putStale.error === "stale-revision", putStale);
  const putOther = await worker.putRawSnapshot({ profileId: "default", snapshot: decoded, deviceId: "devB", singleDevice: true, baseRevision: 1 }, OPTS);
  check("single-device put from NON-holder device → profile-locked-by-other", putOther.ok === false && putOther.error === "profile-locked-by-other", putOther);
  const putGood = await worker.putRawSnapshot({ profileId: "default", snapshot: decoded, deviceId: "devA", singleDevice: true, baseRevision: 1 }, OPTS);
  check("single-device put with CORRECT lock+baseRevision → ok (rev 2)", putGood.ok && putGood.revision === 2, { ok: putGood.ok, rev: putGood.revision });

  // 6. release + takeover
  const rel = await worker.workerRelease({ profileId: "default", deviceId: "devA", userId: "u1" }, OPTS);
  check("release → released:true", rel.ok && rel.released === true, rel);
  const tk = await worker.workerTakeover({ profileId: "default", userId: "u1", deviceId: "devB" }, OPTS);
  check("takeover → evicting", tk.ok && tk.evicting === true, tk);

  // 7. worker-auth body-binding (anti-replay): a header signed for body A is rejected for body B.
  const http = require("node:http");
  const { workerAuthHeader, bodyHash } = require("./shared/worker-auth");
  function rawPost(bodyStr, authHeader) {
    return new Promise((resolve) => {
      const data = Buffer.from(bodyStr);
      const r = http.request({ host: "127.0.0.1", port: PORT, path: "/rpc", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length, "X-Worker-Auth": authHeader } }, (res) => { let raw = ""; res.on("data", (c) => (raw += c)); res.on("end", () => resolve({ status: res.statusCode, raw })); });
      r.on("error", () => resolve({ status: 0 })); r.write(data); r.end();
    });
  }
  const bodyA = JSON.stringify({ method: "revision", params: { profileId: "default" } });
  const bodyB = JSON.stringify({ method: "revision", params: { profileId: "EVIL" } });
  const hdrForA = workerAuthHeader(SECRET, "revision", bodyHash(bodyA));
  const replayOk = await rawPost(bodyA, hdrForA);
  check("body-bound header accepts its OWN body", replayOk.status === 200, replayOk.status);
  const replayBad = await rawPost(bodyB, hdrForA); // same header, tampered params
  check("body-bound header REJECTS a tampered body (anti-replay) → 401", replayBad.status === 401, replayBad.status);

  // 8. multibyte body: a snapshot whose cookie value has non-ASCII (emoji/Vietnamese) must auth + import OK
  //    (proves the worker hashes raw BYTES, not a chunk-concatenated string that would corrupt UTF-8).
  const mbSnap = { version: 1, profileId: "default", origins: [], storage: [], cookies: [{ name: "mb", value: "việt-🍪-Ω", domain: "chatgpt.com", path: "/", url: "https://chatgpt.com/" }] };
  const mb = await worker.putRawSnapshot({ profileId: "default", snapshot: mbSnap, deviceId: "devM" }, OPTS);
  check("multibyte (UTF-8) RPC body authenticates + imports → ok", mb.ok === true, mb);

  await server.stop();
  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("B3 SELFTEST CRASH", e); process.exit(2); });
