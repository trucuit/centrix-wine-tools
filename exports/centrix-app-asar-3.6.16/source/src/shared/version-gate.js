"use strict";
// Shared App-User VERSION GATE — the "force update / emergency lock" feature. Pure functions, no I/O.
// The App User sends User-Agent "CentriXAppUser/<version>"; the server reads it and returns HTTP 426 for
// versions that are below the minimum, explicitly blocked, or below latest (when force-update is on).
// Keep this file BYTE-IDENTICAL between centrix-backend/shared and centrix-website/src/shared.

function parseVer(s) { return String(s || "").trim().split(".").map((n) => parseInt(n, 10) || 0); }

// Numeric semver compare: cmpVer("3.10.0","3.9.0") === 1 (NOT a string compare). Missing parts = 0.
function cmpVer(a, b) {
  const A = parseVer(a), B = parseVer(b), n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

// Extract the App User version from a User-Agent ("CentriXAppUser/3.6.0" -> "3.6.0"). "" if not the App User.
function appUserVersion(ua) {
  const m = /CentriXAppUser\/([0-9][0-9.]*)/.exec(String(ua || ""));
  return m ? m[1] : "";
}

// Decide whether an App-User version must be blocked. Returns null (allowed) or a verdict { blocked, reason, ... }.
// cfg = { latestVersion, minVersion, blocked:[], notes, installerFile, forceLatest }.
// SAFETY: empty/unset cfg = permissive (nobody blocked); a missing/unparseable version = allowed (fail-open).
function versionVerdict(version, cfg) {
  cfg = cfg || {};
  const v = String(version || "").trim();
  if (!v) return null; // unknown client version -> never block (don't lock on a stripped UA)
  const blocked = (Array.isArray(cfg.blocked) ? cfg.blocked : []).map((x) => String(x).trim()).filter(Boolean);
  const min = String(cfg.minVersion || "").trim();
  const latest = String(cfg.latestVersion || "").trim();
  const force = cfg.forceLatest === true;
  if (!blocked.length && !min && !force) return null; // nothing configured -> permissive
  const base = {
    blocked: true, version: v, latestVersion: latest, minVersion: min,
    notes: String(cfg.notes || ""), installerFile: String(cfg.installerFile || ""),
  };
  if (blocked.includes(v)) return { ...base, reason: "blocked" };
  if (min && cmpVer(v, min) < 0) return { ...base, reason: "below-min" };
  if (force && latest && cmpVer(v, latest) < 0) return { ...base, reason: "force-latest" };
  return null;
}

module.exports = { parseVer, cmpVer, appUserVersion, versionVerdict };
