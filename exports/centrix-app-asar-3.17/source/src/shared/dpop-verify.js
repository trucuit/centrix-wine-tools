"use strict";

// Server-side verification of a CentriX device proof (DPoP-style, RFC 9449 / 7638), pure node:crypto —
// no jose/PKI dependency. Binds a session to a device's Ed25519 key (jkt): a token copied to another
// machine cannot produce a valid proof (no private key) → fails. See CentriX-KeyHardening.md §3.
const crypto = require("node:crypto");

function b64urlToBuf(s) {
  return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// RFC 7638 thumbprint of an Ed25519 (OKP) public JWK. MUST match the client's deviceIdentity().jkt
// (same canonical {crv,kty,x} ordering) so the login-bound jkt == the proof's recomputed thumbprint.
function jwkThumbprint(jwk) {
  if (!jwk) return "";
  const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return crypto.createHash("sha256").update(canon).digest("base64url");
}

const seenJti = new Map(); // jti -> expiry epoch-seconds (replay cache)

// Verify a 3-part proof "b64(header).b64(payload).b64(sig)" (EdDSA over header.payload). Returns
// { ok, jkt, reason }. Checks performed depend on opts (omit a field to skip that check — used in the
// staged log-only phase where htm/htu aren't enforced yet).
function verifyDeviceProof(proof, opts = {}) {
  try {
    const parts = String(proof || "").split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const [h, p, s] = parts;
    const header = JSON.parse(b64urlToBuf(h).toString("utf8"));
    const payload = JSON.parse(b64urlToBuf(p).toString("utf8"));
    if (!header.jwk || header.jwk.kty !== "OKP") return { ok: false, reason: "bad-jwk" };
    const pub = crypto.createPublicKey({ key: header.jwk, format: "jwk" });
    if (!crypto.verify(null, Buffer.from(h + "." + p), pub, b64urlToBuf(s))) return { ok: false, reason: "bad-signature" };
    const jkt = jwkThumbprint(header.jwk);
    if (opts.expectedJkt && jkt !== opts.expectedJkt) return { ok: false, jkt, reason: "jkt-mismatch" }; // token off-device
    if (opts.method && String(payload.htm || "").toUpperCase() !== String(opts.method).toUpperCase()) return { ok: false, jkt, reason: "htm" };
    if (opts.expectedHtu && payload.htu !== opts.expectedHtu) return { ok: false, jkt, reason: "htu" };
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.iat) || Math.abs(now - payload.iat) > 90) return { ok: false, jkt, reason: "stale" };
    if (opts.token) {
      const ath = crypto.createHash("sha256").update(String(opts.token)).digest("base64url");
      if (payload.ath !== ath) return { ok: false, jkt, reason: "ath" };
    }
    if (payload.jti) {
      if (seenJti.has(payload.jti)) return { ok: false, jkt, reason: "replay" };
      seenJti.set(payload.jti, now + 300);
      if (seenJti.size > 50000) { for (const [k, v] of seenJti) { if (v < now) seenJti.delete(k); } }
    }
    return { ok: true, jkt, ath: payload.ath };
  } catch (e) {
    return { ok: false, reason: "error:" + ((e && e.message) || "x") };
  }
}

module.exports = { jwkThumbprint, verifyDeviceProof, b64urlToBuf };
