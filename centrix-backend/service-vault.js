"use strict";
// KHO VAULT TẬP TRUNG cho auto-login: mỗi (serviceId, slot) ↔ 1 tài khoản dịch vụ (username + password + TOTP).
// Quản lý qua WEB ADMIN (không cần đụng máy chạy worker/VPS). Worker đọc credential (đã giải mã) để tự đăng
// nhập lại đúng account của slot. Secret (password/totpSecret) MÃ HOÁ AT-REST bằng CENTRIX_VAULT_KEY (base64 32B),
// fallback CENTRIX_MASTER_SNAPSHOT_KEY. File: <data dir>/service-accounts.json.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const profileCrypto = require("./shared/profile-crypto");

const DATA_DIR = process.env.CENTRIX_BACKEND_DATA_DIR || process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const FILE = process.env.CENTRIX_VAULT_FILE || path.join(DATA_DIR, "service-accounts.json");
const KEY = process.env.CENTRIX_VAULT_KEY || process.env.CENTRIX_MASTER_SNAPSHOT_KEY || "";

function hasKey() { return !!KEY; }
function entryId(serviceId, slot) { return `${String(serviceId || "").toLowerCase().trim()}::${Math.max(1, Number(slot) || 1)}`; }

function loadRaw() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return { accounts: [] }; }
}
let tmpCounter = 0;
async function saveRaw(db) {
  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.${++tmpCounter}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db), "utf8");
  try { await fsp.rename(tmp, FILE); } catch (e) { try { await fsp.copyFile(tmp, FILE); await fsp.unlink(tmp).catch(() => {}); } catch { await fsp.unlink(tmp).catch(() => {}); throw e; } }
}

// Bản CÔNG KHAI (an toàn để hiển thị/list): KHÔNG có password/totp thật, chỉ cờ đã-đặt.
function toPublic(a) {
  return {
    id: a.id, serviceId: a.serviceId, slot: a.slot, label: a.label || "", username: a.username || "",
    loginType: a.loginType || "password", loginUrl: a.loginUrl || "", enabled: a.enabled !== false,
    hasPassword: !!a.secret, hasTotp: !!a.totpSet,
    status: a.status || "unknown", lastSeededAt: a.lastSeededAt || "", lastError: a.lastError || "",
    updatedAt: a.updatedAt || "",
  };
}

function list() { return (loadRaw().accounts || []).map(toPublic); }

// Thêm/sửa 1 account theo (serviceId, slot). password/totpSecret CHỈ cập nhật khi truyền vào (bỏ trống = giữ cũ).
async function upsert(input, stampIso) {
  if (!hasKey()) throw new Error("no-vault-key"); // fail-closed: không có khoá thì không lưu secret
  const serviceId = String(input.serviceId || "").toLowerCase().trim();
  const slot = Math.max(1, Number(input.slot) || 1);
  if (!serviceId) throw new Error("missing-service");
  const db = loadRaw();
  db.accounts = db.accounts || [];
  const id = entryId(serviceId, slot);
  let a = db.accounts.find((x) => x.id === id);
  if (!a) { a = { id, serviceId, slot }; db.accounts.push(a); }
  a.serviceId = serviceId; a.slot = slot;
  if (input.loginType != null) a.loginType = ["password", "totp", "google"].includes(input.loginType) ? input.loginType : "password";
  if (input.label != null) a.label = String(input.label).slice(0, 120);
  if (input.username != null) a.username = String(input.username).slice(0, 200);
  if (input.loginUrl != null) a.loginUrl = String(input.loginUrl).slice(0, 500);
  if (input.enabled != null) a.enabled = !!input.enabled;
  // Secret (password + totpSecret) mã hoá chung 1 blob. Chỉ ghi lại khi có ít nhất 1 trường được truyền.
  const setPw = typeof input.password === "string" && input.password.length > 0;
  const setTotp = typeof input.totpSecret === "string"; // "" nghĩa là XOÁ totp
  if (setPw || setTotp) {
    const cur = a.secret ? safeDecrypt(a.secret) : {};
    const next = {
      password: setPw ? input.password : (cur.password || ""),
      totpSecret: setTotp ? String(input.totpSecret).replace(/\s+/g, "") : (cur.totpSecret || ""),
    };
    a.secret = profileCrypto.encryptSnapshot(next, KEY);
    a.totpSet = !!next.totpSecret;
  }
  a.updatedAt = stampIso || a.updatedAt || "";
  await saveRaw(db);
  return toPublic(a);
}

function safeDecrypt(blob) {
  try { return profileCrypto.decryptSnapshot(blob, KEY) || {}; } catch { return {}; }
}

async function remove(id) {
  const db = loadRaw();
  const before = (db.accounts || []).length;
  db.accounts = (db.accounts || []).filter((x) => x.id !== id);
  await saveRaw(db);
  return { ok: true, removed: before - db.accounts.length };
}

// DÙNG CHO WORKER: trả credential ĐÃ GIẢI MÃ của (serviceId, slot). Null nếu không có / bị tắt.
function getSecret(serviceId, slot) {
  if (!hasKey()) return null;
  const id = entryId(serviceId, slot);
  const a = (loadRaw().accounts || []).find((x) => x.id === id);
  if (!a || a.enabled === false) return null;
  const s = a.secret ? safeDecrypt(a.secret) : {};
  return { id: a.id, serviceId: a.serviceId, slot: a.slot, loginType: a.loginType || "password", username: a.username || "", loginUrl: a.loginUrl || "", password: s.password || "", totpSecret: s.totpSecret || "" };
}

// Cập nhật trạng thái sau seed (alive/dead + lỗi) — worker gọi để web admin thấy sống/chết.
async function setStatus(serviceId, slot, status, error, stampIso) {
  const id = entryId(serviceId, slot);
  const db = loadRaw();
  const a = (db.accounts || []).find((x) => x.id === id);
  if (!a) return { ok: false };
  a.status = status || a.status; if (error != null) a.lastError = String(error).slice(0, 300);
  if (status === "alive") a.lastSeededAt = stampIso || a.lastSeededAt || "";
  await saveRaw(db);
  return { ok: true };
}

module.exports = { list, upsert, remove, getSecret, setStatus, hasKey, entryId, FILE };
