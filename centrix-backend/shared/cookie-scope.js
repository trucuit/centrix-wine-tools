"use strict";
// Pure (no-Electron) cookie/storage scoping for IMPORT — mirror of profile-sync's registrableDomain +
// allowedCookieRegistrables (frozen: registrable = last 2 labels). The backend filters an account's
// imported snapshot to the registrable domains of its GRANTED services, so a compromised account token
// cannot inject cookies/storage for services it was never granted into the shared custodian.
function registrableDomain(host) {
  const parts = String(host || "").toLowerCase().replace(/^\.+/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function allowedCookieRegistrables(services = []) {
  const hosts = new Set();
  for (const service of services || []) {
    for (const domain of (service && service.cookieDomains) || []) { const reg = registrableDomain(domain); if (reg) hosts.add(reg); }
    for (const u of [service && service.url, service && service.loginUrl]) {
      try { const reg = registrableDomain(new URL(u).hostname); if (reg) hosts.add(reg); } catch { /* non-URL */ }
    }
  }
  return hosts;
}

function scopeSnapshotToServices(snapshot, services) {
  const allowed = allowedCookieRegistrables(services);
  const cookies = (snapshot.cookies || []).filter((c) => allowed.has(registrableDomain(c.domain)));
  const storage = (snapshot.storage || []).filter((s) => {
    try { return allowed.has(registrableDomain(new URL(s.origin).hostname)); } catch { return false; }
  });
  return { ...snapshot, cookies, storage };
}

module.exports = { registrableDomain, allowedCookieRegistrables, scopeSnapshotToServices };
