"use strict";
// Prove the END of the chain: what an App User RECEIVES when it pulls export?service=chatgpt — the stored
// profile run through the real getSnapshotForExport (decrypt at-rest → scope to the service). Confirms scoping
// drops anything outside chatgpt.com/openai.com and the auth login survives.
process.env.CENTRIX_SNAPSHOT_DIR = "D:\\VCF\\centrix-backend\\snapshot-store";
const ps = require("./profile-snapshot");
const cookieScope = require("./shared/cookie-scope");
const svc = { id: "chatgpt", url: "https://chatgpt.com", cookieDomains: ["chatgpt.com", "openai.com"] };
(async () => {
  const out = await ps.getSnapshotForExport("chatgpt-1", { services: [svc], scopeCookies: true });
  const snap = out.snapshot || {};
  const cookies = snap.cookies || [];
  const regs = [...new Set(cookies.map((c) => cookieScope.registrableDomain(c.domain)))].sort();
  const allowed = new Set(["chatgpt.com", "openai.com"]);
  const extra = regs.filter((r) => !allowed.has(r));
  console.log("EXPORTED to App User — cookies:", cookies.length);
  console.log("registrable domains          :", regs.join(", "));
  console.log("auth/login cookie present    :", cookies.some((c) => /session|__Secure|cf_clearance|__Host/i.test(c.name || "")));
  console.log("ALL within chatgpt scope     :", extra.length === 0 ? "YES — clean (no other-service leak)" : "NO — extra: " + extra.join(", "));
})().catch((e) => console.log("ERROR:", e.message));
