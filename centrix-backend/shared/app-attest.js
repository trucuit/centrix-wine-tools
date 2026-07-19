const crypto = require("node:crypto");

// App attestation (CentriX-BaoMat-ShipCookie Layer 1.3). The client proves it knows a build-embedded
// secret by sending HMAC(secret, deviceId:ts). A naive script (T1) doesn't have it. NOTE: the secret
// ships inside app.asar → a determined attacker who unpacks the build can extract it (this RAISES COST
// and stops naive scripts; it is NOT a hard boundary — see the doc). Override per-deploy with
// CENTRIX_APP_ATTEST_SECRET (must be set identically on client build + server) for a non-shipped secret.
const DEFAULT_ATTEST_SECRET = "cx-attest-v1-7b14d605a9f1e2c3b4d5e6f78f3a9c2e";
const APP_ATTEST_SECRET = String(process.env.CENTRIX_APP_ATTEST_SECRET || DEFAULT_ATTEST_SECRET);
// True when the server is still trusting the shipped (public, extractable) default. Enforcing attestation
// with this key is a NO-OP boundary — the startup guard uses this to refuse silent false security.
const ATTEST_SECRET_IS_DEFAULT = APP_ATTEST_SECRET === DEFAULT_ATTEST_SECRET;
const ATTEST_WINDOW_MS = 120000; // accept timestamps within +/-2 min (clock skew + travel time)

// Static app-identity key sent on EVERY /api/* request as the X-CentriX-App-Key header. It is the gate
// for the Cloudflare "Skip" WAF rule (lets the real app bypass SBFM + managed/OWASP rules in one hop) —
// see CentriX-Cloudflare-Pro-Build.md, Bước 1/2. NOTE: like the attest secret, this ships in app.asar so
// it is extractable — a FRICTION layer at the edge, not a real secret. The Cloudflare Skip rule MUST use
// the same value. Override per-build with CENTRIX_APP_KEY (then update the rule too).
const DEFAULT_APP_KEY = "cxk_28db7719b795d4eaa5a4e00fcb057029a11130eea00ec39a8bbd1467ca2ae5f7";
const APP_REQUEST_KEY = String(process.env.CENTRIX_APP_KEY || DEFAULT_APP_KEY);
// The App-Key is public by design (the Cloudflare Skip rule), so a default here is informational — not a
// hard failure — but worth surfacing so operators rotate it alongside the real secrets.
const APP_KEY_IS_DEFAULT = APP_REQUEST_KEY === DEFAULT_APP_KEY;

// Origin-side anti-replay signature for cookie EXPORT (CentriX-Cloudflare-Pro-Build Bước 6.1). The App
// User signs each /api/profile/export as X-CentriX-Sig = base64(HMAC(key, token:profileId:ts)) + "." + ts;
// the App Server re-checks it inside a short time window. Like the keys above it ships in app.asar
// (extractable) → it raises the cost of REPLAYING a captured request, NOT an unforgeable boundary.
// Env override: CENTRIX_EXPORT_SIGN_KEY.
const DEFAULT_EXPORT_SIGN_KEY = "cxs_61fb44704212be1f8aaa1d62178b5d9e7989c0e5b613e2c32499405807039402";
const EXPORT_SIGN_KEY = String(process.env.CENTRIX_EXPORT_SIGN_KEY || DEFAULT_EXPORT_SIGN_KEY);
// True when export signatures are being verified with the shipped default — anyone who unpacks the build
// can forge X-CentriX-Sig, so enforcing EXPORT_REQUIRE_SIG with this key is false security.
const EXPORT_SIGN_KEY_IS_DEFAULT = EXPORT_SIGN_KEY === DEFAULT_EXPORT_SIGN_KEY;
// Cửa sổ timestamp chữ ký export. ts do MÁY KHÁCH sinh → khách lệch đồng hồ quá cửa sổ là MỌI lần mở dịch vụ
// đều 403 bad-signature (tab mở không có profile — "đôi lúc có user không nhận được profile"). ±2 phút quá gắt
// với PC người dùng (pin CMOS yếu/tắt time-sync rất phổ biến) → nới mặc định ±10 phút: vẫn chặn replay cũ,
// tha được máy lệch giờ. Chỉnh qua env CENTRIX_EXPORT_SIG_WINDOW_MS nếu cần.
const EXPORT_SIG_WINDOW_MS = Math.max(60000, Number(process.env.CENTRIX_EXPORT_SIG_WINDOW_MS || 10 * 60 * 1000));

function exportSignHeader(token, profileId) {
  const ts = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac("sha256", EXPORT_SIGN_KEY).update(`${String(token || "")}:${String(profileId || "")}:${ts}`).digest("base64");
  return `${mac}.${ts}`;
}
function verifyExportSig(token, profileId, header) {
  const s = String(header || "");
  const dot = s.lastIndexOf(".");
  if (dot <= 0) return false;
  const mac = s.slice(0, dot);
  const ts = Number(s.slice(dot + 1));
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > EXPORT_SIG_WINDOW_MS) return false;
  const expected = crypto.createHmac("sha256", EXPORT_SIGN_KEY).update(`${String(token || "")}:${String(profileId || "")}:${ts}`).digest("base64");
  try {
    const a = Buffer.from(mac, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function computeAttest(deviceId, ts) {
  return crypto.createHmac("sha256", APP_ATTEST_SECRET).update(`${String(deviceId || "")}:${ts}`).digest("hex").slice(0, 32);
}

// Client: produce the X-CentriX-Attest header value.
function clientAttestHeader(deviceId) {
  const ts = Date.now();
  return `${ts}.${computeAttest(deviceId, ts)}`;
}

// Server: verify a header value against deviceId, with a fresh-timestamp window + constant-time compare.
function verifyAttest(deviceId, header) {
  const s = String(header || "");
  const dot = s.indexOf(".");
  if (dot <= 0) return false;
  const ts = Number(s.slice(0, dot));
  const mac = s.slice(dot + 1);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > ATTEST_WINDOW_MS) return false;
  const expected = computeAttest(deviceId, ts);
  try {
    const a = Buffer.from(mac, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = {
  computeAttest, clientAttestHeader, verifyAttest, APP_ATTEST_SECRET, APP_REQUEST_KEY, exportSignHeader, verifyExportSig,
  ATTEST_SECRET_IS_DEFAULT, APP_KEY_IS_DEFAULT, EXPORT_SIGN_KEY_IS_DEFAULT,
};
