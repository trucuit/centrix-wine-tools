"use strict";

// CentriX App User device identity (DPoP). An Ed25519 keypair is generated once per install, the private
// key is sealed with Electron safeStorage (DPAPI on Windows) and NEVER leaves the main process. Each
// request carries X-CentriX-Proof = a signature over {htm,htu,iat,jti,ath} — proving this device holds
// the private key bound (jkt) to the session. Copying the token to another machine can't forge it.
// See CentriX-KeyHardening.md §3.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const { jwkThumbprint } = require("./shared/dpop-verify");

let _priv = null, _pubJwk = null, _jkt = null;

function keyFile() {
  return path.join(app.getPath("userData"), "device-key.bin");
}

function loadOrCreate() {
  if (_priv) return;
  const file = keyFile();
  try {
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(file)) {
      const pem = safeStorage.decryptString(fs.readFileSync(file));
      _priv = crypto.createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    }
  } catch {
    _priv = null; // unreadable / from another user — regenerate below
  }
  if (!_priv) {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    _priv = privateKey;
    try {
      const pem = privateKey.export({ format: "pem", type: "pkcs8" });
      if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(file, safeStorage.encryptString(pem), { mode: 0o600 });
    } catch {
      // best-effort persistence; the key still works in-memory for this run
    }
  }
  _pubJwk = crypto.createPublicKey(_priv).export({ format: "jwk" });
  _jkt = jwkThumbprint(_pubJwk);
}

function deviceIdentity() {
  try { loadOrCreate(); return { jkt: _jkt, jwk: _pubJwk }; } catch { return { jkt: "", jwk: null }; }
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makeDeviceProof({ method, url, token, nonce } = {}) {
  try {
    loadOrCreate();
    if (!_priv) return "";
    const u = new URL(url);
    const header = { alg: "EdDSA", typ: "centrix-dpop", jwk: _pubJwk };
    const payload = {
      htm: String(method || "GET").toUpperCase(),
      htu: u.origin + u.pathname,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomBytes(16).toString("base64url"),
      ath: crypto.createHash("sha256").update(String(token || "")).digest("base64url"),
      ...(nonce ? { nonce } : {})
    };
    const signingInput = b64u(header) + "." + b64u(payload);
    const sig = crypto.sign(null, Buffer.from(signingInput), _priv).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return signingInput + "." + sig;
  } catch {
    return "";
  }
}

module.exports = { deviceIdentity, makeDeviceProof };
