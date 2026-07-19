"use strict";
// Server-side store for the SHARED LOGIN snapshot ("profile in the database"). This is what lets the cloud
// backend serve /api/profile/export|import from a STORED snapshot instead of a LIVE Electron custodian →
// the server no longer needs the always-on App Server. Record = { blob (at-rest-encrypted), revision,
// updatedAt }. File-backed + atomic for a single backend; swap to a Docker table for multi-instance HA
// (same get/put contract). Path: CENTRIX_SNAPSHOT_DIR, else <data dir>/centrix-snapshots.
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const DIR = process.env.CENTRIX_SNAPSHOT_DIR
  || path.join(process.env.CENTRIX_BACKEND_DATA_DIR || process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "centrix-snapshots");

function safeId(id) { return String(id || "default").replace(/[^a-zA-Z0-9._-]/g, "_") || "default"; }
function fileFor(profileId) { return path.join(DIR, safeId(profileId) + ".json"); }

async function getSnapshotRecord(profileId) {
  // CHỈ ENOENT (file thật sự không có) mới trả null — null nghĩa là "profile không tồn tại" và pool sẽ PRUNE.
  // Mọi lỗi khác (EMFILE cạn fd, EACCES/EBUSY thoáng qua, JSON parse fail giữa lúc copyFile-fallback ghi dở)
  // phải THROW để caller coi là "unavailable" tạm thời — nếu nuốt thành null, một cơn nghẽn IO ngắn sẽ đá sạch
  // profile khỏi pool ("mở dịch vụ không nhận được profile" hàng loạt cho tới khi Manager đẩy lại).
  let raw;
  try { raw = await fsp.readFile(fileFor(profileId), "utf8"); }
  catch (e) { if (e && e.code === "ENOENT") return null; throw e; }
  return JSON.parse(raw); // parse fail → throw (transient mid-copy hoặc hỏng file — đều KHÔNG được prune)
}

// Retry a filesystem op through the transient Windows lock races (Defender/Search indexer briefly hold a handle
// on a freshly-created or being-replaced file → EPERM/EBUSY/EACCES). ~40,80,…ms backoff; other errors rethrow.
async function withFsRetry(fn, tries = 6) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const code = e && e.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES" && code !== "EEXIST") throw e;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
  throw last;
}

let tmpCounter = 0;
async function putSnapshotRecord(profileId, record) {
  await fsp.mkdir(DIR, { recursive: true });
  const dest = fileFor(profileId);
  const tmp = `${dest}.${process.pid}.${++tmpCounter}.tmp`; // UNIQUE per write (no concurrent-tmp clobber)
  const data = JSON.stringify(record);
  await withFsRetry(() => fsp.writeFile(tmp, data, "utf8"));
  try {
    await withFsRetry(() => fsp.rename(tmp, dest)); // atomic replace (retried through AV/indexer lock races)
  } catch (err) {
    // Rename still blocked after retries → fall back to copy+unlink. Not atomic, but a reader that catches a
    // partial file just JSON.parse-fails → getSnapshotRecord returns null (safe). This is what stopped the
    // "EPERM rename chatgpt-1.json.tmp" import failures when Defender was scanning the pool store.
    try { await withFsRetry(() => fsp.copyFile(tmp, dest)); await fsp.unlink(tmp).catch(() => {}); }
    catch { await fsp.unlink(tmp).catch(() => {}); throw err; }
  }
  return record;
}

// Per-profile async mutex: serialize the read-modify-write of a profile's snapshot so two concurrent imports
// can't lost-update each other (the store is a single shared file; there is no DB row-lock here).
const tails = new Map();
function withProfileLock(profileId, fn) {
  const key = safeId(profileId);
  const prev = tails.get(key) || Promise.resolve();
  const result = prev.then(() => fn());
  tails.set(key, result.catch(() => {})); // chain continues even if fn rejects
  return result;
}

// Xóa file snapshot của 1 profile (khi admin xóa profile đã đẩy). ENOENT (đã mất) = coi như xong.
async function deleteSnapshotRecord(profileId) {
  return withProfileLock(profileId, async () => {
    try { await withFsRetry(() => fsp.unlink(fileFor(profileId))); return { ok: true }; }
    catch (e) { if (e && e.code === "ENOENT") return { ok: true, alreadyGone: true }; throw e; }
  });
}

module.exports = { getSnapshotRecord, putSnapshotRecord, deleteSnapshotRecord, withProfileLock, snapshotDir: DIR, withFsRetry };
