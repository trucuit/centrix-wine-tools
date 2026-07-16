const crypto = require("node:crypto");

// Per-session symmetric key used to encrypt the profile snapshot in transit
// between Server and App User (defense in depth on top of HTTPS, and the key is
// revocable per login session). AES-256-GCM gives confidentiality + integrity.

function keyBuffer(keyB64) {
  const buf = Buffer.from(String(keyB64 || ""), "base64");
  if (buf.length !== 32) throw new Error("Invalid session key (expected 32 bytes base64)");
  return buf;
}

function newSessionKey() {
  return crypto.randomBytes(32).toString("base64");
}

function isEncryptedSnapshot(payload) {
  return Boolean(payload) && payload.enc === "aesgcm" && payload.iv && payload.tag && payload.data;
}

function encryptSnapshot(obj, keyB64) {
  const key = keyBuffer(keyB64);
  const iv = crypto.randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(obj ?? {}), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    enc: "aesgcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  };
}

function decryptSnapshot(payload, keyB64) {
  if (!isEncryptedSnapshot(payload)) throw new Error("Not an aesgcm snapshot payload");
  const key = keyBuffer(keyB64);
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const data = Buffer.from(payload.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = {
  newSessionKey,
  isEncryptedSnapshot,
  encryptSnapshot,
  decryptSnapshot
};
