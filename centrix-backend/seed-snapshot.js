"use strict";
// ONE-TIME bootstrap: pull the CURRENT live custodian snapshot from the App Server worker (master, full) and
// SEED it into the DB-snapshot store. Run ONCE while the App Server is still up; afterwards set
// CENTRIX_PROFILE_FROM_DB=1 on the backend and the server serves cookies from the store — the App Server can
// be retired. (After this, fresh logins flow in via manager/account pushes to /api/profile/import.)
//   set CENTRIX_WORKER_RPC_URL / CENTRIX_WORKER_RPC_SECRET / CENTRIX_SNAPSHOT_AT_REST_KEY [/ CENTRIX_SNAPSHOT_DIR]
//   node seed-snapshot.js [profileId]
const worker = require("./worker-client");
const profileSnapshot = require("./profile-snapshot");
const { readServicesConfig } = require("./shared/service-store");

(async () => {
  const profileId = process.argv[2] || "default";
  if (!process.env.CENTRIX_SNAPSHOT_AT_REST_KEY) { console.error("Set CENTRIX_SNAPSHOT_AT_REST_KEY (base64 32B) first."); process.exit(2); }
  const cfg = await readServicesConfig().catch(() => ({ services: [] }));
  const raw = await worker.getRawSnapshot({ profileId, services: cfg.services || [], includeStorage: true, scopeCookies: false });
  if (!raw.ok || !raw.snapshot) {
    console.error("Worker getRawSnapshot failed — is the App Server up with CENTRIX_WORKER_RPC=1 + matching secret?", raw.error || raw.status);
    process.exit(1);
  }
  const r = await profileSnapshot.seedSnapshot(profileId, raw.snapshot);
  console.log(`Seeded "${profileId}" → revision ${r.revision}  (cookies=${(raw.snapshot.cookies || []).length}, storage=${(raw.snapshot.storage || []).length})`);
  console.log("Next: set CENTRIX_PROFILE_FROM_DB=1 on the backend; the App Server worker can be retired.");
  process.exit(0);
})().catch((e) => { console.error("seed failed:", (e && e.message) || e); process.exit(1); });
