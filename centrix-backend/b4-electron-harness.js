"use strict";
// B4 — REAL-Electron validation of the B3 cookie seam. Self-contained, runs to completion + exits (no
// long-lived process). Boots Electron headless, builds a REAL custodian session, wires the REAL profile-sync
// (session.cookies + hidden BrowserWindow storage) into the REAL worker-rpc, and drives it through the REAL
// worker-client (RPC over localhost) + REAL per-session crypto. Proves what b3-selftest mocked: real cookies
// survive getRaw → encrypt → [device decrypt/edit/re-encrypt] → backend decrypt → putRaw, landing back in the
// live custodian — with data-minimization scoping that never leaks unrelated (e.g. facebook) cookies.
const { app, session } = require("electron");
app.disableHardwareAcceleration();

const { createWorkerRpcServer } = require("../centrix-website/src/shared/worker-rpc");
const realSync = require("../centrix-website/src/shared/profile-sync"); // the REAL Electron module
const worker = require("./worker-client");
const crypto = require("./shared/profile-crypto");

const PORT = 17977;
const SECRET = "b4-real-electron-secret-AbC_123";
const OPTS = { url: `http://127.0.0.1:${PORT}/rpc`, secret: SECRET };
const PARTITION = "persist:b4custodian";
const SERVICES = [
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com", "openai.com"] },
  { id: "claude", name: "Claude", url: "https://claude.ai", cookieDomains: ["claude.ai"] },
];

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log("  PASS  " + name); } else { fail++; console.log("  FAIL  " + name + "  " + (extra != null ? JSON.stringify(extra).slice(0, 240) : "")); } }

app.on("window-all-closed", () => { /* hidden storage windows close — do NOT quit here */ });

app.whenReady().then(async () => {
  const custodian = session.fromPartition(PARTITION);
  // Seed realistic auth cookies, incl. an UNRELATED one that must never leak when scoped.
  await custodian.cookies.set({ url: "https://chatgpt.com/", name: "__Secure-next-auth.session-token", value: "FAKE_CG", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true });
  await custodian.cookies.set({ url: "https://openai.com/", name: "oai", value: "FAKE_OAI", domain: ".openai.com", path: "/", secure: true });
  await custodian.cookies.set({ url: "https://claude.ai/", name: "sessionKey", value: "FAKE_CL", domain: "claude.ai", path: "/", secure: true });
  await custodian.cookies.set({ url: "https://facebook.com/", name: "c_user", value: "PRIVATE_FB", domain: "facebook.com", path: "/" });

  const revisions = new Map();
  const locks = new Map();
  const rpc = createWorkerRpcServer({
    secret: SECRET, port: PORT,
    exportProfileSnapshot: realSync.exportProfileSnapshot,
    importProfileSnapshot: realSync.importProfileSnapshot,
    getProfileSession: async (pid) => ({ targetSession: custodian, profileId: pid || "default" }),
    profileRevision: (pid) => revisions.get(pid) || 0,
    setProfileRevision: (pid, r) => revisions.set(pid, r),
    readServicesConfig: async () => ({ services: SERVICES }),
    acquireProfileLock: (pid, dev) => { locks.set(pid, dev); return { ok: true, holder: dev }; },
    releaseProfileLock: (pid, dev) => { if (locks.get(pid) === dev) { locks.delete(pid); return true; } return false; },
    lockHeldBy: (pid, dev) => locks.get(pid) === dev,
    requestAccountTakeover: () => ({ evicting: true, graceMs: 5000 }),
    loginStatuses: async () => SERVICES.map((s) => ({ serviceId: s.id, loggedIn: true })),
  });
  await rpc.start();
  console.log("\n== B4 REAL-Electron seam validation (real profile-sync + real session.cookies) ==");

  try {
    const h = await worker.workerHealth(OPTS);
    check("worker health (good secret)", h.status === 200 && h.ok, h);
    const hBad = await worker.workerHealth({ ...OPTS, secret: "wrong" });
    check("worker health (bad secret) → 401", hBad.status === 401, hBad.status);

    const full = await worker.getRawSnapshot({ profileId: "default", services: SERVICES, includeStorage: false, scopeCookies: false }, OPTS);
    check("REAL getRawSnapshot full → 4 cookies from LIVE custodian", full.ok && full.snapshot.cookies.length === 4, full.snapshot && full.snapshot.cookies.length);
    const cg = (full.snapshot.cookies || []).find((c) => c.name === "__Secure-next-auth.session-token");
    check("real cookie carries 11-field shape (httpOnly+secure+url)", !!cg && cg.httpOnly === true && cg.secure === true && /chatgpt\.com/.test(cg.url || ""), cg);

    const scoped = await worker.getRawSnapshot({ profileId: "default", services: [SERVICES[0]], includeStorage: false, scopeCookies: true }, OPTS);
    const names = (scoped.snapshot.cookies || []).map((c) => c.name).sort();
    const leaked = (scoped.snapshot.cookies || []).some((c) => /facebook/.test(c.domain || ""));
    check("REAL scoped(chatgpt) keeps cg+oai, DROPS facebook+claude (no private leak)", scoped.ok && !leaked && names.length === 2, { names, leaked });

    const key = crypto.newSessionKey();
    const env = crypto.encryptSnapshot(scoped.snapshot, key);
    check("encrypt REAL snapshot → aesgcm envelope", env.enc === "aesgcm" && !!env.iv && !!env.tag, Object.keys(env));
    check("decrypt REAL snapshot deep-equals original", JSON.stringify(crypto.decryptSnapshot(env, key)) === JSON.stringify(scoped.snapshot), null);
    let wrongThrew = false; try { crypto.decryptSnapshot(env, crypto.newSessionKey()); } catch { wrongThrew = true; }
    check("decrypt with WRONG key throws (per-device isolation)", wrongThrew, null);

    // FULL pipeline with REAL import into the live custodian.
    const onDevice = crypto.decryptSnapshot(crypto.encryptSnapshot(scoped.snapshot, key), key);
    onDevice.cookies.push({ name: "b4_pushed", value: "ROUNDTRIP_OK", domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" });
    const decoded = crypto.decryptSnapshot(crypto.encryptSnapshot(onDevice, key), key);
    const put = await worker.putRawSnapshot({ profileId: "default", snapshot: decoded, deviceId: "devA" }, OPTS);
    check("REAL putRawSnapshot → ok + revision bumped to 1", put.ok && put.revision === 1, { ok: put.ok, rev: put.revision });
    const live = await custodian.cookies.get({ url: "https://chatgpt.com/" });
    check("pushed cookie ACTUALLY landed in the live custodian session", live.some((c) => c.name === "b4_pushed" && c.value === "ROUNDTRIP_OK"), live.map((c) => c.name));

    await worker.workerLock({ profileId: "default", deviceId: "devA", userId: "u1" }, OPTS);
    const stale = await worker.putRawSnapshot({ profileId: "default", snapshot: decoded, deviceId: "devA", singleDevice: true, baseRevision: 0 }, OPTS);
    check("single-device STALE baseRevision → stale-revision", stale.ok === false && stale.error === "stale-revision", stale);
    const other = await worker.putRawSnapshot({ profileId: "default", snapshot: decoded, deviceId: "devB", singleDevice: true, baseRevision: 1 }, OPTS);
    check("single-device non-holder → profile-locked-by-other", other.ok === false && other.error === "profile-locked-by-other", other);
    const good = await worker.putRawSnapshot({ profileId: "default", snapshot: decoded, deviceId: "devA", singleDevice: true, baseRevision: 1 }, OPTS);
    check("single-device correct lock+baseRevision → ok (rev 2)", good.ok && good.revision === 2, { ok: good.ok, rev: good.revision });

    // Hidden-BrowserWindow storage path under REAL Electron (best-effort; offline/headless tolerant).
    let storageRan = false, storageErr = "";
    try {
      const ws = await worker.getRawSnapshot({ profileId: "default", services: [{ id: "ex", url: "https://example.com", cookieDomains: ["example.com"] }], includeStorage: true, scopeCookies: false }, { ...OPTS, timeoutMs: 22000 });
      storageRan = ws.ok && Array.isArray(ws.snapshot.storage);
    } catch (e) { storageErr = e.message; }
    if (storageRan) { pass++; console.log("  PASS  REAL hidden-window storage path executes under Electron"); }
    else { console.log("  SKIP  hidden-window storage (offline/headless): " + (storageErr || "no array")); }
  } catch (e) {
    fail++; console.log("  FAIL  harness threw: " + (e && e.message));
  }

  try { for (const c of await custodian.cookies.get({})) { const u = "http" + (c.secure ? "s" : "") + "://" + (c.domain || "").replace(/^\./, "") + (c.path || "/"); await custodian.cookies.remove(u, c.name).catch(() => {}); } } catch { /* best-effort cleanup */ }
  await rpc.stop();
  console.log("\n== " + pass + " passed, " + fail + " failed ==\n");
  app.exit(fail === 0 ? 0 : 1);
});
