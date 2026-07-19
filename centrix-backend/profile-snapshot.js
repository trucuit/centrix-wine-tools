"use strict";
// DB-SNAPSHOT mode for /api/profile/* — the cloud backend serves cookie pull/push from a STORED, at-rest
// encrypted snapshot (no live Electron custodian). All crypto is Node (no Electron) so the server needs no
// always-on App Server. CENTRIX_SNAPSHOT_AT_REST_KEY (base64 32B) encrypts what's stored; the backend
// re-encrypts per requesting session on export (never relays one device's ciphertext to another).
const profileCrypto = require("./shared/profile-crypto");
const cookieScope = require("./shared/cookie-scope");
const store = require("./snapshot-store");

function atRestKey() {
  const k = process.env.CENTRIX_SNAPSHOT_AT_REST_KEY || "";
  if (!k) throw new Error("CENTRIX_SNAPSHOT_AT_REST_KEY not set (base64 32B) — required for DB-snapshot mode");
  return k;
}

// Pull: decrypt the stored blob with the at-rest key → optionally scope to the caller's granted services.
// The CALLER (server.js) then re-encrypts the returned plaintext snapshot with the requesting session key.
async function getSnapshotForExport(profileId, { services, scopeCookies } = {}) {
  const rec = await store.getSnapshotRecord(profileId);
  if (!rec || !rec.blob) return { snapshot: null, revision: 0 };
  let snapshot = profileCrypto.decryptSnapshot(rec.blob, atRestKey());
  if (scopeCookies) snapshot = cookieScope.scopeSnapshotToServices(snapshot, services || []);
  return { snapshot, revision: rec.revision || 0 };
}

// Merge a (scoped) push into the shared snapshot. The incoming push is AUTHORITATIVE for the registrable
// domains it touches — base cookies for those domains are dropped and replaced by incoming's, so a LOGOUT
// (cookie removed on the client) propagates; base cookies for OTHER services are kept untouched. Same per
// storage-origin. (Pure union would never delete → stale/rotated sessions would linger forever.)
function mergeSnapshots(base, incoming) {
  const reg = (c) => cookieScope.registrableDomain(c.domain);
  const ownedRegs = new Set((incoming.cookies || []).map(reg));
  const cookies = [];
  for (const c of (base.cookies || [])) if (!ownedRegs.has(reg(c))) cookies.push(c); // keep other services
  for (const c of (incoming.cookies || [])) cookies.push(c);                          // incoming authoritative
  const ownedOrigins = new Set((incoming.storage || []).map((s) => s.origin));
  const storage = [];
  for (const s of (base.storage || [])) if (!ownedOrigins.has(s.origin)) storage.push(s);
  for (const s of (incoming.storage || [])) storage.push(s);
  const origins = Array.from(new Set([...(base.origins || []).filter(Boolean), ...(incoming.origins || []).filter(Boolean)]));
  return { ...base, cookies, storage, origins };
}

// Push: store the (already-decrypted) snapshot, encrypted at rest, bumping revision. Optimistic concurrency
// via baseRevision when singleDevice. scopeServices restricts what an account may write (no cross-service).
async function putSnapshotFromImport(profileId, snapshot, { baseRevision, scopeServices } = {}) {
  // Serialize per-profile read-modify-write so concurrent imports can't lost-update each other.
  return store.withProfileLock(profileId, async () => {
    const rec = (await store.getSnapshotRecord(profileId)) || { revision: 0 };
    const current = rec.revision || 0;
    // Optimistic concurrency: if the caller carries baseRevision, it must match the CURRENT on-disk revision
    // (re-read inside the lock) — a stale push is rejected instead of silently clobbering.
    if (baseRevision != null && Number(baseRevision) !== current) {
      return { ok: false, error: "stale-revision", revision: current };
    }
    let incoming = stripExportOnlyKeys(snapshot || {});
    if (scopeServices) incoming = cookieScope.scopeSnapshotToServices(incoming, scopeServices);
    let toStore = incoming;
    if (rec.blob) {
      if (!profileCrypto.isEncryptedSnapshot(rec.blob)) {
        toStore = incoming; // genuinely not a snapshot envelope → safe to replace
      } else {
        // FAIL CLOSED on an undecryptable existing blob (wrong/rotated at-rest key) — never silently
        // overwrite the shared snapshot with just the scoped subset (that would be total data loss).
        let existing;
        try { existing = profileCrypto.decryptSnapshot(rec.blob, atRestKey()); }
        catch { return { ok: false, error: "snapshot-decrypt-failed", revision: current }; }
        toStore = mergeSnapshots(existing, incoming);
      }
    }
    const revision = current + 1;
    await store.putSnapshotRecord(profileId, {
      blob: profileCrypto.encryptSnapshot({ version: 1, profileId, ...toStore }, atRestKey()),
      revision, updatedAt: new Date().toISOString(),
    });
    return { ok: true, revision, result: { cookieCount: (toStore.cookies || []).length, storageCount: (toStore.storage || []).length } };
  });
}

async function getRevision(profileId) {
  const rec = await store.getSnapshotRecord(profileId);
  return rec ? (rec.revision || 0) : 0;
}

// One-time seed: store an already-plaintext snapshot at rest (used to bootstrap the DB store from the live
// custodian before the App Server is retired, or by an admin seed).
async function seedSnapshot(profileId, snapshot) {
  return store.withProfileLock(profileId, async () => {
    const rec = await store.getSnapshotRecord(profileId);
    const revision = (rec ? (rec.revision || 0) : 0) + 1;
    await store.putSnapshotRecord(profileId, {
      blob: profileCrypto.encryptSnapshot({ version: 1, profileId, ...stripExportOnlyKeys(snapshot || {}) }, atRestKey()),
      revision, updatedAt: new Date().toISOString(),
    });
    return { ok: true, revision };
  });
}

// uiRules is attached to EXPORT responses only (resolved fresh from the DB each time) — it must never
// be persisted into the at-rest blob, or a replayed export→import would freeze that day's rules forever.
function stripExportOnlyKeys(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !("uiRules" in snapshot)) return snapshot || {};
  const { uiRules: _dropUiRules, ...clean } = snapshot;
  return clean;
}

module.exports = { getSnapshotForExport, putSnapshotFromImport, getRevision, seedSnapshot };
