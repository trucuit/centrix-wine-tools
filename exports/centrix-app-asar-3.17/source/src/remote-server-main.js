const { app } = require("electron");
const { SERVER_USERDATA_NAME } = require("./shared/gibberish-names");
// Anonymize the on-disk userData root (%APPDATA%\<name>) — set BEFORE any path is resolved.
app.setName(SERVER_USERDATA_NAME);

process.env.CENTRIX_REMOTE_HOST ||= "0.0.0.0";
// WEBSITE CLONE: distinct port so it runs alongside the original App Server (19778). The clone is being
// developed into the browser-accessed admin website; the original repo stays the desktop App Server.
process.env.CENTRIX_REMOTE_TABS_PORT ||= "19778";
process.env.CENTRIX_REMOTE_REQUIRE_TOKEN ||= "1";
process.env.CENTRIX_REMOTE_SHOW_CONTROL ||= "1";
process.env.CENTRIX_REMOTE_SHOW_TARGETS = "0";
process.env.CENTRIX_REMOTE_PREOPEN_TABS = "0";
process.env.CENTRIX_REMOTE_DEFAULT_URL ||= "https://chat.zalo.me/";
process.env.CENTRIX_REMOTE_WEB_DIR = "remote-server-web";

// Hardening (BAO-VE-COOKIE-CentriX): block remote-debugging / inspector surfaces in shipped builds.
require("./shared/harden-runtime").hardenRuntimeOrExit();

require("./remote-tabs-main");

// Cookie at-rest encryption observability: Chromium's encrypted_value is protected by the OS keystore
// (DPAPI on Windows). Log whether it is actually available so a silent downgrade (e.g. a Linux host
// with no keyring falling back to the hard-coded "basic" key) is visible instead of assumed.
const { safeStorage } = require("electron");
app.whenReady().then(() => {
  try {
    const available = safeStorage.isEncryptionAvailable();
    let backend = process.platform;
    try { if (process.platform === "linux" && safeStorage.getSelectedStorageBackend) backend = safeStorage.getSelectedStorageBackend(); } catch { /* older electron */ }
    console.log(`[centrix] cookie at-rest encryption: available=${available} backend=${backend}`);
    if (!available) {
      console.warn("[centrix] WARNING: OS storage encryption is NOT available — cookies may be stored without DPAPI/keyring protection.");
      if (process.env.CENTRIX_REQUIRE_COOKIE_ENCRYPTION === "1") {
        console.error("[centrix] CENTRIX_REQUIRE_COOKIE_ENCRYPTION=1 and encryption unavailable — refusing to start.");
        app.quit();
      }
    }
  } catch (error) {
    console.warn("[centrix] cookie-encryption self-check failed:", error && error.message);
  }
});
