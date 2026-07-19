"use strict";
// Verifies that cutover-preflight.js is a TRUSTWORTHY gate: it must go GREEN on a healthy topology and RED
// (with the right reason) when the worker is down or the master token is wrong. Boots a real backend+worker,
// runs the ACTUAL preflight script as a child process against it in three scenarios.

const TPORT = 18797, WPORT = 17933, T1 = "preflight-verify-master", S = "preflight-verify-secret";
process.env.CENTRIX_BACKEND_PORT = String(TPORT);
process.env.CENTRIX_STAFF_RBAC = "on";
process.env.CENTRIX_REMOTE_TOKEN = T1;
process.env.CENTRIX_PROFILE_VIA_WORKER = "1";
process.env.CENTRIX_LOADER_VIA_WORKER = "1";
process.env.CENTRIX_WORKER_RPC_SECRET = S;
process.env.CENTRIX_WORKER_RPC_URL = `http://127.0.0.1:${WPORT}/rpc`;
process.env.CENTRIX_MASTER_SNAPSHOT_KEY = require("node:crypto").randomBytes(32).toString("base64");
process.env.CENTRIX_BACKEND_WEB_DIR = "D:\\VCF\\centrix-website\\src\\remote-server-web";

const { app, session } = require("electron");
app.disableHardwareAcceleration();
const { execFile } = require("node:child_process");
const { createWorkerRpcServer } = require("../centrix-website/src/shared/worker-rpc");
const realSync = require("../centrix-website/src/shared/profile-sync");

let pass = 0, fail = 0;
function check(n, c, e) { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + "  " + (e != null ? String(e).slice(0, 400) : "")); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runPreflight(extraEnv) {
  return new Promise((resolve) => {
    execFile(process.execPath, ["cutover-preflight.js"],
      { cwd: __dirname, timeout: 40000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CUTOVER_BACKEND_URL: `http://127.0.0.1:${TPORT}`, ...extraEnv } },
      (err, stdout, stderr) => resolve({ code: err && typeof err.code === "number" ? err.code : (err ? 1 : 0), out: String(stdout || "") + String(stderr || "") }));
  });
}

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const custodian = session.fromPartition("persist:preflight-verify");
  await custodian.cookies.set({ url: "https://chatgpt.com/", name: "cg", value: "1", domain: "chatgpt.com", path: "/", secure: true });
  const revisions = new Map();
  const rpc = createWorkerRpcServer({
    secret: S, port: WPORT,
    exportProfileSnapshot: realSync.exportProfileSnapshot, importProfileSnapshot: realSync.importProfileSnapshot,
    getProfileSession: async (pid) => ({ targetSession: custodian, profileId: pid || "default" }),
    profileRevision: (pid) => revisions.get(pid) || 0, setProfileRevision: (pid, r) => revisions.set(pid, r),
    readServicesConfig: async () => ({ services: [{ id: "chatgpt", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com"] }] }),
    lockHeldBy: () => true,
    loaderApi: { serviceLoginStatuses: async (ids) => (ids || []).map((id) => ({ serviceId: id, loggedIn: false })) },
  });
  await rpc.start();
  require("./server");
  await sleep(700);
  console.log("\n== Verify cutover-preflight.js is a trustworthy gate ==");

  // Scenario 1 — healthy topology → GREEN
  const r1 = await runPreflight({ CENTRIX_REMOTE_TOKEN: T1 });
  check("HEALTHY topology → preflight GREEN (exit 0 + SAFE TO RETARGET)", r1.code === 0 && /SAFE TO RETARGET/.test(r1.out), "exit=" + r1.code + " out=" + r1.out.replace(/\s+/g, " "));

  // Scenario 2 — wrong master token (worker still up) → RED
  const r2 = await runPreflight({ CENTRIX_REMOTE_TOKEN: "WRONG-TOKEN" });
  check("WRONG master token → preflight RED (exit 1 + DO NOT CUT OVER)", r2.code === 1 && /DO NOT CUT OVER/.test(r2.out), "exit=" + r2.code);
  check("  …and it names the token mismatch", /master token mismatch/i.test(r2.out), r2.out.replace(/\s+/g, " ").slice(0, 300));

  // Scenario 3 — worker DOWN → RED with the worker hint (the cutover-blocking condition)
  await rpc.stop();
  await sleep(200);
  const r3 = await runPreflight({ CENTRIX_REMOTE_TOKEN: T1 });
  check("WORKER DOWN → preflight RED (exit 1 + DO NOT CUT OVER)", r3.code === 1 && /DO NOT CUT OVER/.test(r3.out), "exit=" + r3.code);
  check("  …and it FAILs the worker-RPC checks with the worker-down hint", /worker DOWN or CENTRIX_WORKER_RPC_SECRET mismatch/i.test(r3.out) && /FAIL  WORKER RPC reachable/.test(r3.out), r3.out.replace(/\s+/g, " ").slice(0, 360));

  try { await custodian.cookies.remove("https://chatgpt.com/", "cg"); } catch { /* */ }
  console.log(`\n== ${pass} passed, ${fail} failed ==\n`);
  app.exit(fail === 0 ? 0 : 1);
});
