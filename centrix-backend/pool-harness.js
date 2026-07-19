"use strict";
// Proves the service POOL: one service backed by many profiles; App Users spread across them by CAPACITY-FILL
// (fill profile #1 to N, then #2…), STICKY per user, and DEAD profiles auto-skipped/pruned. Pure node.

const path = require("node:path");
process.env.CENTRIX_BACKEND_PORT = "18792";
process.env.CENTRIX_STAFF_RBAC = "on";
process.env.CENTRIX_REMOTE_TOKEN = "pool-master";
process.env.CENTRIX_PROFILE_FROM_DB = "1";
process.env.CENTRIX_MASTER_SNAPSHOT_KEY = require("node:crypto").randomBytes(32).toString("base64");
process.env.CENTRIX_SNAPSHOT_AT_REST_KEY = require("node:crypto").randomBytes(32).toString("base64");
process.env.CENTRIX_SNAPSHOT_DIR = path.join(process.env.TEMP || ".", "centrix-pool-test-" + process.pid);
process.env.CENTRIX_POOL_CAPACITY = "2"; // 2 users per profile

const http = require("node:http");
const { URL } = require("node:url");
const profileCrypto = require("./shared/profile-crypto");
const storeMod = require("./snapshot-store");
const localDb = require("./shared/local-db");
const appAttest = require("./shared/app-attest");

const MASTER = process.env.CENTRIX_REMOTE_TOKEN, MASTER_KEY = process.env.CENTRIX_MASTER_SNAPSHOT_KEY, AT_REST = process.env.CENTRIX_SNAPSHOT_AT_REST_KEY;
const SVC = { id: "chatgpt", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com", "openai.com"] };
const ACCT = "ACCT_POOL", ACCT_KEY = profileCrypto.newSessionKey();
// Account granted ONLY chatgpt (NOT claude) → used to prove the pool export honors the per-account grant.
localDb.verifyAccountToken = async (t) => (t === ACCT ? { userId: "acct1", profileId: "default", deviceId: "d1", email: "a@x", sessionKey: ACCT_KEY } : null);
localDb.servicesForUser = async () => ({ config: { services: [SVC] }, user: {}, uiRules: [], modelPolicies: [] });
// services config the backend reads — make sure chatgpt is in it (use a temp services file? the backend reads
// the real services.json which already has chatgpt). We rely on the real config containing "chatgpt".

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + "  " + (e != null ? JSON.stringify(e).slice(0, 200) : "")); } }
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL("http://127.0.0.1:18792" + p);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { Authorization: `Bearer ${MASTER}`, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, (res) => { let raw = ""; res.on("data", (c) => raw += c); res.on("end", () => { let j; try { j = JSON.parse(raw); } catch { j = raw; } resolve({ status: res.statusCode, json: j }); }); });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
const chatgptSnap = (tag) => ({ version: 1, cookies: [{ name: "__Secure-next-auth.session-token", value: tag, domain: "chatgpt.com", path: "/", secure: true, httpOnly: true, url: "https://chatgpt.com/" }] });
async function seed(pid, tag) { return req("POST", "/api/profile/import", { profileId: pid, encrypted: profileCrypto.encryptSnapshot(chatgptSnap(tag), MASTER_KEY) }); }
async function assign(userId) { const r = await req("GET", "/api/profile/export?service=chatgpt&includeStorage=0&userId=" + userId); return r.json && r.json.assignedProfile; }

require("./server");

(async () => {
  await new Promise((r) => setTimeout(r, 600));
  console.log("\n== Service POOL: many profiles per service, capacity-fill + sticky + dead-prune ==");
  try {
    // seed 3 chatgpt accounts → pool = [chatgpt-1, chatgpt-2, chatgpt-3]
    for (const i of [1, 2, 3]) { const s = await seed("chatgpt-" + i, "ACC" + i); check("seed chatgpt-" + i + " → 200", s.status === 200 && s.json.ok, s.status); }

    // capacity-fill (cap=2): u1,u2 → cg-1 ; u3,u4 → cg-2 ; u5 → cg-3
    const a = {}; for (const u of ["u1", "u2", "u3", "u4", "u5"]) a[u] = await assign(u);
    check("u1,u2 → same first profile (filled to cap 2)", a.u1 && a.u1 === a.u2, a);
    check("u3,u4 → second profile (first full)", a.u3 && a.u3 === a.u4 && a.u3 !== a.u1, a);
    check("u5 → third profile (first two full)", a.u5 && a.u5 !== a.u1 && a.u5 !== a.u3, a);
    check("capacity-fill order = chatgpt-1, chatgpt-2, chatgpt-3", a.u1 === "chatgpt-1" && a.u3 === "chatgpt-2" && a.u5 === "chatgpt-3", a);

    // sticky: u1 again → same profile
    check("sticky: u1 re-pull → same profile", (await assign("u1")) === a.u1, null);

    // dead profile: corrupt chatgpt-2's snapshot to have NO chatgpt cookie → must be skipped + pruned
    await storeMod.putSnapshotRecord("chatgpt-2", { blob: profileCrypto.encryptSnapshot({ version: 1, cookies: [{ name: "fb", value: "x", domain: "facebook.com", path: "/" }] }, AT_REST), revision: 99 });
    const u6 = await assign("u6");
    check("dead chatgpt-2 skipped → u6 NOT assigned to chatgpt-2", u6 && u6 !== "chatgpt-2", u6);
    // a fresh user that would have landed on cg-2 now lands on a live profile (cg-3, since cg-1 full)
    check("u6 → a live profile (chatgpt-3)", u6 === "chatgpt-3", u6);

    // pool status reflects the prune
    const ps = await req("GET", "/api/admin/pool");
    const cgPool = ps.json && ps.json.pool && ps.json.pool.chatgpt ? ps.json.pool.chatgpt.map((x) => x.profileId) : [];
    check("admin pool status: chatgpt-2 pruned from the pool", ps.status === 200 && !cgPool.includes("chatgpt-2") && cgPool.includes("chatgpt-1"), cgPool);

    // GRANT gate: an account granted only chatgpt cannot pull an ungranted service via the pool path
    function reqA(p) { return new Promise((resolve, reject) => { const u = new URL("http://127.0.0.1:18792" + p); const h = { Authorization: `Bearer ${ACCT}`, "X-CentriX-User": "acct1", "X-CentriX-Attest": appAttest.clientAttestHeader("acct1"), "X-CentriX-Sig": appAttest.exportSignHeader(ACCT, "default") }; const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers: h }, (res) => { let raw = ""; res.on("data", (c) => raw += c); res.on("end", () => { let j; try { j = JSON.parse(raw); } catch { j = raw; } resolve({ status: res.statusCode, json: j }); }); }); r.on("error", reject); r.end(); }); }
    await reqA("/api/services"); // stamp interaction for the export gate
    const claim = await reqA("/api/profile/export?service=claude&includeStorage=0");
    check("account export of UNGRANTED service (claude) → 403 service-not-granted", claim.status === 403 && claim.json && claim.json.error === "service-not-granted", { st: claim.status, j: claim.json });
    const grant = await reqA("/api/profile/export?service=chatgpt&includeStorage=0");
    check("account export of GRANTED service (chatgpt) → 200", grant.status === 200 && grant.json && grant.json.ok, { st: grant.status });

    // CONCURRENCY: 2 fresh profiles (cap 2), 4 SIMULTANEOUS distinct users → exactly 2 each, NO over-fill
    await seed("cc-1", "CC1"); await seed("cc-2", "CC2");
    const cu = await Promise.all(["cu1", "cu2", "cu3", "cu4"].map((u) => assign(u)));
    const ps2 = await req("GET", "/api/admin/pool");
    const cap = Number(process.env.CENTRIX_POOL_CAPACITY);
    const fresh = (ps2.json.pool.chatgpt || []).filter((p) => p.profileId === "cc-1" || p.profileId === "cc-2");
    // The 4 concurrent users hit the FRESH profiles (which had spare capacity) → none may exceed cap. Without
    // the mutex all 4 would race onto cc-1 (count 4). (Pre-full profiles legitimately overflow — not checked.)
    check("concurrent assigns: fresh profiles NOT over-filled (mutex prevents the race)", fresh.length === 2 && fresh.every((p) => p.activeUsers <= cap), fresh);
    check("4 concurrent users split 2+2 onto cc-1/cc-2 (capacity-fill held under race)", cu.filter((x) => x === "cc-1").length === 2 && cu.filter((x) => x === "cc-2").length === 2, cu);
  } catch (e) { fail++; console.log("  FAIL  harness threw: " + (e && e.message)); }

  try { require("node:fs").rmSync(process.env.CENTRIX_SNAPSHOT_DIR, { recursive: true, force: true }); } catch { /* */ }
  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
