"use strict";
// Replays the App User's LIVE pool pull: takes a real account session from Docker, builds the same headers
// serverRequest() sends, calls GET /api/profile/export?service=chatgpt on the backend, and reports the result
// (200 + assignedProfile + decrypts the per-session blob → cookie count/auth). Proves the end-to-end live path
// (real token → export gate → pool assign → scoped+encrypted response) without the GUI.
const http = require("node:http");
const appAttest = require("./shared/app-attest");
const profileCrypto = require("./shared/profile-crypto");
const DB = "http://127.0.0.1:19779";
const BK = "http://127.0.0.1:18778";

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => { let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on("error", reject);
  });
}
function exportReq(headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(BK + "/api/profile/export?service=chatgpt&includeStorage=0");
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers }, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { let j; try { j = JSON.parse(d); } catch { j = d; } resolve({ status: res.statusCode, json: j }); }); });
    r.on("error", reject); r.end();
  });
}

(async () => {
  const db = (await getJson(DB + "/db")).db;
  const sessions = (db.authSessions || db.auth_sessions || []);
  // a real App User session: has a token, an account userId (not staff), most recent.
  const s = sessions.filter((x) => x && x.token && x.userId && !String(x.userId).startsWith("staff"))
    .sort((a, b) => String(b.lastSeenAt || b.last_seen_at || "").localeCompare(String(a.lastSeenAt || a.last_seen_at || "")))[0];
  if (!s) { console.log("NO account session found in Docker authSessions:", Object.keys(sessions[0] || {})); return; }
  const token = s.token, userId = s.userId, deviceId = s.deviceId || userId;
  const profileId = s.profileId || "default";
  const sessionKey = s.sessionKey || s.session_key || "";
  console.log("session:", { userId, deviceId, profileId, tokenPrefix: String(token).slice(0, 14), hasSessionKey: !!sessionKey });

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-CentriX-App-Key": appAttest.APP_REQUEST_KEY,
    "X-CentriX-User": deviceId,
    "X-CentriX-Profile": profileId,
    "X-CentriX-Session": sessionKey,
    "User-Agent": "CentriXAppUser/3.6.0",
    "X-CentriX-Attest": appAttest.clientAttestHeader(deviceId),
    "X-CentriX-Sig": appAttest.exportSignHeader(token, profileId)
  };
  const r = await exportReq(headers);
  console.log("export?service=chatgpt ->", r.status, "| assignedProfile:", r.json && r.json.assignedProfile, "| err:", r.json && r.json.error);
  if (r.status === 200 && r.json && r.json.encrypted && sessionKey) {
    try {
      const snap = profileCrypto.decryptSnapshot(r.json.encrypted, sessionKey);
      const cookies = snap.cookies || [];
      const domains = [...new Set(cookies.map((c) => c.domain))].sort();
      console.log("DECRYPTED for this device -> cookies:", cookies.length, "| domains:", domains.join(", "));
      console.log("has ChatGPT auth cookie:", cookies.some((c) => /session|__Secure|cf_clearance/i.test(c.name)));
      console.log("=> RESULT: App User would open ChatGPT ALREADY LOGGED IN from pool (chatgpt-1).");
    } catch (e) { console.log("decrypt failed:", e.message); }
  }
})().catch((e) => console.log("ERROR:", e.message));
