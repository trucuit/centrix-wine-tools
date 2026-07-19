"use strict";
// In-process smoke test for the Phase B backend (avoids background-process reaping).
// Boots server.js in this process, fires requests at it, prints PASS/FAIL, exits.

process.env.CENTRIX_STAFF_RBAC = process.env.CENTRIX_STAFF_RBAC || "on";
process.env.CENTRIX_REMOTE_TOKEN = process.env.CENTRIX_REMOTE_TOKEN || "test-master-token-AbC_123-xyz";
process.env.CENTRIX_BACKEND_PORT = process.env.CENTRIX_BACKEND_PORT || "18799";

const http = require("node:http");
const PORT = Number(process.env.CENTRIX_BACKEND_PORT);
const MASTER = process.env.CENTRIX_REMOTE_TOKEN;

require("./server"); // starts listening

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path, headers: { ...headers, ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let j; try { j = JSON.parse(raw); } catch { j = raw; } resolve({ status: res.statusCode, json: j, setCookie: res.headers["set-cookie"] }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}  ${extra != null ? JSON.stringify(extra).slice(0, 240) : ""}`); } }

(async () => {
  await new Promise((r) => setTimeout(r, 350)); // let listen() bind
  const bearer = (tok) => ({ Authorization: `Bearer ${tok}` });
  console.log(`\n== Phase B backend self-test (port ${PORT}, STAFF_RBAC=on) ==`);

  // 1. health is public
  let h = await req("GET", "/api/health");
  check("health public 200", h.status === 200 && h.json.ok === true, h.json);
  check("health staffRbac=on", h.json && h.json.staffRbac === "on", h.json);

  // 2. gate: no token → 401
  let u = await req("GET", "/api/admin/summary");
  check("admin/summary no-token → 401", u.status === 401, u.status);

  // 3. master Bearer → real data
  let s = await req("GET", "/api/admin/summary", { headers: bearer(MASTER) });
  check("admin/summary master → 200", s.status === 200 && s.json.ok, { st: s.status, keys: s.json && Object.keys(s.json.summary || {}) });
  check("admin/summary has summary obj", s.json && s.json.summary && typeof s.json.summary === "object", null);

  // 4. master query token also works
  let sq = await req("GET", `/api/admin/summary?token=${encodeURIComponent(MASTER)}`);
  check("admin/summary master ?token= → 200", sq.status === 200 && sq.json.ok, sq.status);

  // 5. wrong token → 401 (timing-safe, underscores intact)
  let w = await req("GET", "/api/admin/summary", { headers: bearer("totally-wrong") });
  check("admin/summary wrong token → 401", w.status === 401, w.status);

  // 6. services real list
  let sv = await req("GET", "/api/services", { headers: bearer(MASTER) });
  check("services master → 200 + array", sv.status === 200 && Array.isArray(sv.json.services), { st: sv.status, n: sv.json && sv.json.services && sv.json.services.length });
  console.log(`        services count = ${sv.json && sv.json.services ? sv.json.services.length : "?"}`);

  // 7. portal snapshot
  let p = await req("GET", "/api/admin/portal", { headers: bearer(MASTER) });
  check("admin/portal master → 200", p.status === 200 && p.json.ok && p.json.portal, { st: p.status, keys: p.json && p.json.portal && Object.keys(p.json.portal).slice(0, 8) });

  // 8. livechat
  let lc = await req("GET", "/api/admin/livechat", { headers: bearer(MASTER) });
  check("admin/livechat master → 200 + threads[]", lc.status === 200 && Array.isArray(lc.json.threads), { st: lc.status });

  // 9. staff-whoami via master → synthetic owner
  let who = await req("GET", "/api/auth/staff-whoami", { headers: bearer(MASTER) });
  check("staff-whoami master → owner", who.status === 200 && who.json.staff && who.json.staff.isOwner === true, who.json);

  // 10. staff-whoami no auth → 401 (drives the website login overlay)
  let who0 = await req("GET", "/api/auth/staff-whoami");
  check("staff-whoami no-auth → 401", who0.status === 401, who0.status);

  // 11. staff-login wrong creds → 401 (not 500), proves adminLogin path wired
  let bad = await req("POST", "/api/auth/staff-login", { body: { username: "nope@centrix.asia", password: "wrong" } });
  check("staff-login bad creds → 401", bad.status === 401, { st: bad.status, j: bad.json });

  // 12. staff-login real owner (Docker) → cookie; then cookie authorizes a read
  let good = await req("POST", "/api/auth/staff-login", { body: { username: process.env.CENTRIX_SELFTEST_USER || "owner", password: process.env.CENTRIX_SELFTEST_PW || "" } });
  if (good.status === 200 && good.setCookie) {
    check("staff-login owner → 200 + Set-Cookie cxsid", /cxsid=/.test(String(good.setCookie)), good.setCookie);
    const cookie = String(good.setCookie[0]).split(";")[0]; // cxsid=...
    let viaCookie = await req("GET", "/api/admin/summary", { headers: { Cookie: cookie } });
    check("admin/summary via staff cookie → 200", viaCookie.status === 200 && viaCookie.json.ok, viaCookie.status);
    let whoCk = await req("GET", "/api/auth/staff-whoami", { headers: { Cookie: cookie } });
    check("staff-whoami via cookie → staff", whoCk.status === 200 && whoCk.json.staff, whoCk.json && whoCk.json.staff && { role: whoCk.json.staff.role, isOwner: whoCk.json.staff.isOwner });
  } else {
    console.log(`  SKIP  staff-login owner (Docker may lack owner staff / down) → status=${good.status} ${JSON.stringify(good.json).slice(0,160)}`);
  }

  // 13. new read batch (master)
  let usr = await req("GET", "/api/users", { headers: bearer(MASTER) });
  check("users master → 200 + users[]", usr.status === 200 && Array.isArray(usr.json.users), { st: usr.status });
  console.log(`        users=${usr.json && usr.json.users ? usr.json.users.length : "?"}  modelPrices=${usr.json && usr.json.modelPrices ? usr.json.modelPrices.length : "?"}`);
  check("users response has NO heavy db blob", usr.json && usr.json.db === undefined, Object.keys(usr.json || {}));

  let led = await req("GET", "/api/admin/credits/ledger", { headers: bearer(MASTER) });
  check("credits/ledger master → 200 + wallets[]+transactions[]", led.status === 200 && Array.isArray(led.json.wallets) && Array.isArray(led.json.transactions), { st: led.status });
  console.log(`        wallets=${led.json && led.json.wallets ? led.json.wallets.length : "?"}  txns=${led.json && led.json.transactions ? led.json.transactions.length : "?"}`);

  let mp = await req("GET", "/api/admin/model-prices", { headers: bearer(MASTER) });
  check("model-prices master → 200 + modelPrices[]", mp.status === 200 && Array.isArray(mp.json.modelPrices), { st: mp.status });

  let svc = await req("GET", "/api/services", { headers: bearer(MASTER) });
  check("services master → config + services[]", svc.status === 200 && svc.json.config && Array.isArray(svc.json.services), { st: svc.status });

  let me = await req("GET", "/api/me", { headers: bearer(MASTER) });
  check("me master (default user) → 200 + balance number", me.status === 200 && me.json.ok && typeof me.json.balance === "number", { st: me.status, j: me.json });
  check("me has recentHistory[]", me.json && Array.isArray(me.json.recentHistory), null);

  // 14. account-allowlist: master can reach a non-allowlisted admin route; account would be 403 (allowlist enforced)
  let cfgOnly = await req("GET", "/api/admin/credits/ledger", { headers: bearer(MASTER) });
  check("master reaches admin route (allowlist is account-only)", cfgOnly.status === 200, cfgOnly.status);

  // ---- WRITE-route routing + gating (no mutation) ----
  let lock = await req("POST", "/api/profile/lock", { headers: bearer(MASTER), body: { profileId: "default" } });
  check("profile/lock → 404 (stays on worker)", lock.status === 404, lock.status);
  let hb = await req("POST", "/api/user-tabs/heartbeat", { headers: bearer(MASTER), body: { tabId: "tab-a" } });
  check("user-tabs/heartbeat → 404 (stays on worker)", hb.status === 404, hb.status);
  let wrongM = await req("GET", "/api/users/save", { headers: bearer(MASTER) });
  check("GET on write route /api/users/save → 405", wrongM.status === 405, wrongM.status);
  let orgM = await req("POST", "/api/users/org/structure", { headers: bearer(MASTER), body: {} });
  check("org/structure as master → 403 (account-only)", orgM.status === 403, { st: orgM.status, j: orgM.json });
  let adjNoTok = await req("POST", "/api/admin/credits/adjust", { body: { userId: "x", amount: 1 } });
  check("credits/adjust no-token → 401 (gate)", adjNoTok.status === 401, adjNoTok.status);
  let miss = await req("POST", "/api/does-not-exist", { headers: bearer(MASTER), body: {} });
  check("unknown POST → 404", miss.status === 404, miss.status);

  // ---- WRITE path proven against Docker (safe: no money moved, throwaway user) ----
  let mu = await req("POST", "/api/users/model-usage/check", { headers: bearer(MASTER), body: { userId: "zz-selftest-backend", serviceId: "chatgpt", modelId: "gpt-4o", consume: false } });
  check("model-usage/check consume:false → 200 (no charge, wired)", mu.status === 200 && mu.json.ok, { st: mu.status, j: mu.json });
  let act = await req("POST", "/api/users/activity", { headers: bearer(MASTER), body: { userId: "zz-selftest-backend", serviceId: "selftest", action: "selftest-ping", title: "phase-b backend selftest" } });
  check("users/activity master → 200 + activity[] (real Docker write)", act.status === 200 && act.json.ok && Array.isArray(act.json.activity), { st: act.status });

  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("SELFTEST CRASH", e); process.exit(2); });
