"use strict";

// CentriX App User PERSISTENT LOGIN. On a successful connect we seal the account session
// {serverUrl, token, profileId, deviceId, sessionKey, expiresAt} with Electron safeStorage (DPAPI on
// Windows) into userData/session.bin. On next launch the main process decrypts it and reconnects, so the
// user stays logged in across app restarts (within the server token TTL). The token is DPoP-bound to the
// per-install device key (see remote-user-device.js), so a copied session.bin can't be replayed on another
// machine. The file is cleared on explicit logout / eviction / token expiry — never on a plain app quit.
const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

function sessionFile() {
  return path.join(app.getPath("userData"), "session.bin");
}

function saveSession(obj) {
  try {
    if (!obj || !obj.token || !obj.serverUrl) return false;
    if (!safeStorage.isEncryptionAvailable()) return false; // no OS keychain → do NOT persist a plaintext token
    const blob = {
      serverUrl: String(obj.serverUrl || ""),
      token: String(obj.token || ""),
      profileId: String(obj.profileId || ""),
      deviceId: String(obj.deviceId || ""),
      sessionKey: String(obj.sessionKey || ""),
      expiresAt: String(obj.expiresAt || "")
    };
    fs.writeFileSync(sessionFile(), safeStorage.encryptString(JSON.stringify(blob)), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function loadSession() {
  try {
    const file = sessionFile();
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(file)) return null;
    const json = safeStorage.decryptString(fs.readFileSync(file));
    const obj = JSON.parse(json);
    if (!obj || !obj.token || !obj.serverUrl) return null;
    return obj;
  } catch {
    return null; // unreadable / from another user / corrupt → treat as no saved session
  }
}

function clearSession() {
  try { fs.unlinkSync(sessionFile()); } catch { /* already gone */ }
}

module.exports = { saveSession, loadSession, clearSession };
