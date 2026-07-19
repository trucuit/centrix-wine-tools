// Phase B backend shim. The App Server's shared modules (local-db.js, service-store.js) only use
// electron's app.getPath("appData") for an ON-DISK dir (JSON DB fallback + services.json). The cloud
// backend has no electron, so map "appData" to the real %APPDATA% (true parity with the App Server) —
// overridable via CENTRIX_BACKEND_DATA_DIR. NO wire-format changes; this only resolves a directory.
const path = require("node:path");
const os = require("node:os");

const DATA_DIR =
  process.env.CENTRIX_BACKEND_DATA_DIR ||
  process.env.APPDATA ||
  path.join(os.homedir(), "AppData", "Roaming");

module.exports = { app: { getPath: () => DATA_DIR } };
