"use strict";

// Hardening for BAO-VE-COOKIE-CentriX.
//
// In SHIPPED (packaged) builds, refuse to run when launched with the remote-debugging / inspector
// surfaces that let ANY local process read the live browser session over CDP (the doc's "Cach B":
// --remote-debugging-port / --remote-allow-origins, or --inspect). Dev runs (`electron src/...`) are
// unaffected because app.isPackaged is false there, so debugging during development still works.
//
// NOTE: this does NOT stop "Cach A" (swapping the app entry to a cookie-dumper) — that is blocked at
// BUILD time by asar packaging + Electron Fuses (OnlyLoadAppFromAsar / RunAsNode off / inspect off),
// see scripts/apply-electron-fuses.js and scripts/build-remote-pair-portable.ps1.

const { app } = require("electron");

function hasSwitch(name) {
  try {
    return Boolean(app && app.commandLine && app.commandLine.hasSwitch(name));
  } catch {
    return false;
  }
}

function hardenRuntimeOrExit() {
  try {
    if (!app || !app.isPackaged) return; // dev / unit runs: do not interfere with debugging
  } catch {
    return;
  }

  const argv = (process.argv || []).join(" ").toLowerCase();
  const flaggedArgv = /--(remote-debugging-port|remote-debugging-pipe|remote-allow-origins|inspect|inspect-brk|inspect-port)\b/.test(argv);
  const flaggedSwitch =
    hasSwitch("remote-debugging-port") ||
    hasSwitch("remote-debugging-pipe") ||
    hasSwitch("remote-allow-origins") ||
    hasSwitch("inspect") ||
    hasSwitch("inspect-brk");

  if (flaggedArgv || flaggedSwitch) {
    try {
      console.error("[CentriX] Remote debugging / inspector is disabled in this build to protect the login session. Exiting.");
    } catch {
      // ignore
    }
    try { app.quit(); } catch { /* before-ready: fall through to hard exit */ }
    process.exit(1);
  }
}

module.exports = { hardenRuntimeOrExit };
