"use strict";
// Profile POOL for a service: one service backed by MANY login profiles (each = one account). App Users are
// spread across them to avoid overloading any one account. Strategy = CAPACITY-FILL (fill profile #1 to N
// active users, then #2, …), STICKY per (service,user) within a TTL, DEAD profiles (snapshot lost the
// service's auth cookie) auto-pruned. All state mutation runs under a single async mutex (no over-fill race).
const fsp = require("node:fs/promises");
const path = require("node:path");
const store = require("./snapshot-store");
const profileCrypto = require("./shared/profile-crypto");
const cookieScope = require("./shared/cookie-scope");

const CAPACITY = Math.max(1, Number(process.env.CENTRIX_POOL_CAPACITY || 10)); // max active users per profile
const TTL_MS = Math.max(60000, Number(process.env.CENTRIX_POOL_TTL_MS || 30 * 60 * 1000)); // assignment idle TTL
// SLOT COOLDOWN: 1 slot pool bị loại TẠM khỏi assign (vd tài khoản Claude chạm weekly/usage limit — cookie VẪN
// sống nên KHÔNG phải "dead"/reseed; chỉ không được phát ra tới khi limit reset). Ưu tiên mốc reset parse được;
// parse fail → fallback DEFAULT; trần MAX chống cooldown-vô-hạn do parse sai.
const DEFAULT_COOLDOWN_MS = Math.max(60000, Number(process.env.CENTRIX_SLOT_COOLDOWN_MS || 24 * 60 * 60 * 1000));
const MAX_COOLDOWN_MS = Math.max(DEFAULT_COOLDOWN_MS, Number(process.env.CENTRIX_SLOT_COOLDOWN_MAX_MS || 8 * 24 * 60 * 60 * 1000));
function atRestKey() { return process.env.CENTRIX_SNAPSHOT_AT_REST_KEY || ""; }
function stateFile() { return path.join(store.snapshotDir, "pool-state.json"); }
const LOCK = "__pool_state__"; // single global lock key (state is one shared object)

const RECENT_MS = 24 * 60 * 60 * 1000; // lịch sử gán đã hết TTL — cho web admin quy đúng phiên dài (tab mở > TTL)
// CLUSTER-SAFE (2026-07-10): KHÔNG cache state vĩnh viễn nữa. File này viết cho 1 process; từ khi backend chạy
// 8 worker (2026-07-08), mỗi worker giữ 1 bản RAM riêng + save() ghi đè TOÀN BỘ file → last-writer-wins: worker
// B (cache cũ) lưu sau là MẤT gán worker A vừa tạo (gán "biến mất", slot chập chờn). Fix: đọc lại file mỗi lần
// load() (file vài KB — rẻ) + mutator load() BÊN TRONG mutex → cửa sổ race co từ "cache cũ mãi mãi" về mili-giây.
let state = null;
async function load() {
  try { state = JSON.parse(await fsp.readFile(stateFile(), "utf8")); } catch { state = { index: {}, assign: {}, recent: {} }; }
  if (!state.index) state.index = {}; if (!state.assign) state.assign = {}; if (!state.recent) state.recent = {};
  // SỨC CHỨA TÙY CHỈNH: số user/slot. Ưu tiên byProfile > byService > default (env CENTRIX_POOL_CAPACITY là fallback).
  if (!state.capacity || typeof state.capacity !== "object") state.capacity = { default: CAPACITY, byService: {}, byProfile: {} };
  if (!(Number(state.capacity.default) >= 1)) state.capacity.default = CAPACITY;
  if (!state.capacity.byService || typeof state.capacity.byService !== "object") state.capacity.byService = {};
  if (!state.capacity.byProfile || typeof state.capacity.byProfile !== "object") state.capacity.byProfile = {};
  if (!state.cooldown || typeof state.cooldown !== "object") state.cooldown = {}; // profileId -> { until, reason, serviceId, at }
  return state;
}
// Sức chứa hiệu lực cho (profile, dịch vụ): byProfile > byService > default. state phải đã load().
function effectiveCapacity(profileId, serviceId) {
  const cap = state.capacity || {};
  const p = Number(cap.byProfile && cap.byProfile[profileId]);
  if (p >= 1) return p;
  const s = Number(cap.byService && cap.byService[serviceId]);
  if (s >= 1) return s;
  const d = Number(cap.default);
  return d >= 1 ? d : CAPACITY;
}
let saveChain = Promise.resolve(), tmpN = 0;
function save() {
  const data = JSON.stringify(state); // chốt snapshot TẠI THỜI ĐIỂM GỌI — load() giờ re-read mỗi lần, nếu để
  // stringify lúc queue chạy thì 1 reader chen giữa có thể thay `state` (bản chưa-mutation) → ghi mất mutation.
  saveChain = saveChain.then(async () => {
    try {
      await fsp.mkdir(store.snapshotDir, { recursive: true });
      const tmp = `${stateFile()}.${process.pid}.${++tmpN}.tmp`;
      await store.withFsRetry(() => fsp.writeFile(tmp, data));
      await store.withFsRetry(() => fsp.rename(tmp, stateFile())); // atomic + retried through AV/indexer lock races
    } catch { /* best-effort */ }
  });
  return saveChain;
}

function serviceRegistrables(service) { return cookieScope.allowedCookieRegistrables([service]); }
// Some registrable domains are SHARED by many properties that set cookies WITHOUT a login — google.com is set
// by Analytics, consent, Ads (NID), etc. on countless sites. "has ANY cookie on the domain" then falsely marks
// a profile with only tracking cookies as logged-in → it pollutes the Google services' pools → an App User gets
// assigned a profile that has NO real Google session → the service bounces to accounts.google.com/signin.
// For these domains, require an actual AUTH/session cookie BY NAME. Non-shared domains keep the any-cookie rule
// (a chatgpt.com / claude.ai cookie is a fine proxy for login there). This matches the file's own intent
// ("DEAD profiles = snapshot lost the service's AUTH cookie").
const AUTH_COOKIES_BY_REGISTRABLE = {
  "google.com": new Set([
    "SID", "HSID", "SSID", "SAPISID", "APISID", "LSID",
    "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS",
    "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-OSID", "__Host-GAPS",
  ]),
};
function snapshotServesService(snapshot, service) {
  const allowed = serviceRegistrables(service);
  return (snapshot.cookies || []).some((c) => {
    const reg = cookieScope.registrableDomain(c.domain);
    if (!allowed.has(reg)) return false;
    const authNames = AUTH_COOKIES_BY_REGISTRABLE[reg];
    if (authNames) return authNames.has(String(c.name || "")); // shared domain → require a real login cookie
    return true; // normal domain → any cookie on it counts (unchanged)
  });
}
// "alive" (serves it) | "dead" (record THẬT SỰ không có / giải mã được nhưng mất cookie → prune) | "unavailable"
// (đọc file lỗi thoáng qua HOẶC giải mã fail — SKIP nhưng KHÔNG prune: cơn nghẽn IO/xoay key không được phép
// quét sạch pool). getSnapshotRecord giờ THROW với mọi lỗi ngoài ENOENT → bắt ở đây thành "unavailable".
async function aliveState(profileId, service) {
  let rec;
  try { rec = await store.getSnapshotRecord(profileId); }
  catch { return "unavailable"; } // EMFILE/EACCES/parse-dở-file... = tạm thời, không phán "dead"
  if (!rec || !rec.blob) return "dead";
  let snap; try { snap = profileCrypto.decryptSnapshot(rec.blob, atRestKey()); } catch { return "unavailable"; }
  return snapshotServesService(snap, service) ? "alive" : "dead";
}

function pruneAssign(now) {
  let changed = false;
  for (const k in state.assign) {
    if (now - state.assign[k].at >= TTL_MS) {
      // GIỮ LỊCH SỬ: gán hết TTL không xoá hẳn — chuyển sang state.recent (24h) để web admin còn quy được
      // "user này từng kéo profile dịch vụ X" cho phiên dài (tab dùng nhiều giờ nhưng chỉ pull 1 lần đầu).
      // KHÔNG ảnh hưởng capacity/sticky: mọi logic gán chỉ đọc state.assign như cũ.
      state.recent[k] = { profileId: state.assign[k].profileId, at: state.assign[k].at };
      delete state.assign[k]; changed = true;
    }
  }
  for (const k in state.recent) { if (now - state.recent[k].at >= RECENT_MS) { delete state.recent[k]; changed = true; } }
  return changed;
}
function activeCounts(serviceId, now) {
  const counts = {};
  const pre = serviceId + "|";
  for (const k in state.assign) { if (!k.startsWith(pre)) continue; const a = state.assign[k]; if (now - a.at < TTL_MS) counts[a.profileId] = (counts[a.profileId] || 0) + 1; }
  return counts;
}

// Manager pool profiles are named "<serviceId>-<slot>"; the owner service is the id minus the trailing slot.
function ownerServiceOf(profileId) { return String(profileId || "").replace(/-\d+$/, ""); }

// Slot đang cooldown? Trả mốc `until` (ms epoch) nếu bản ghi tồn tại, 0 nếu không. (So với `now` tại nơi gọi.)
function cooldownUntil(profileId) {
  const c = state.cooldown && state.cooldown[profileId];
  const u = c ? Number(c.until) : 0;
  return u > 0 ? u : 0;
}
function pruneCooldown(now) {
  let changed = false;
  for (const pid in (state.cooldown || {})) { if (Number(state.cooldown[pid].until) <= now) { delete state.cooldown[pid]; changed = true; } }
  return changed;
}

// On import: which services this profile (after merge) can serve; drop it from pools it no longer serves.
async function indexProfile(profileId, snapshot, services) {
  return store.withProfileLock(LOCK, async () => {
    await load(); // re-read TRONG mutex — nhặt mutation của worker khác vừa lưu
    const owner = ownerServiceOf(profileId);
    const ownerIsService = (services || []).some((s) => s.id === owner);
    const served = [];
    for (const s of (services || [])) {
      // A manager-seeded pool profile serves ONLY its own service. Two services that share a registrable
      // domain but log in with DIFFERENT accounts (e.g. noxtools semrush vs envato — both noxtools.com) must
      // NOT borrow each other's snapshot: a semrush noxtools session does NOT authenticate the envato tool.
      // Owner-pinning (only when the profile belongs to a real catalog service) fixes that cross-account leak
      // and also stops a personal/whole-profile import from polluting a service's shared pool.
      let serves = snapshotServesService(snapshot, s);
      if (serves && ownerIsService && s.id !== owner) serves = false;
      if (serves) served.push(s.id);
      const list = state.index[s.id] || (state.index[s.id] = []);
      const at = list.indexOf(profileId);
      if (serves && at < 0) list.push(profileId);
      else if (!serves && at >= 0) list.splice(at, 1);
    }
    await save();
    return served; // which services this profile now serves — lets the seeder detect a "stored but pools nothing" login
  });
}

// Assign (or reuse) a pool profile for (service, user). Serialized → capacity-fill never over-fills.
async function assignProfile(serviceId, userId, services) {
  const service = (services || []).find((s) => s.id === serviceId);
  if (!service) return null;
  return store.withProfileLock(LOCK, async () => {
    await load(); // re-read TRONG mutex — nhặt mutation của worker khác vừa lưu
    const pool = (state.index[serviceId] || []).slice();
    if (!pool.length) return null;
    const now = Date.now();
    let dirty = pruneAssign(now);
    if (pruneCooldown(now)) dirty = true;
    const key = serviceId + "|" + userId;

    const cur = state.assign[key]; // sticky
    // Sticky slot đang cooldown (vd chạm weekly limit) → KHÔNG tái dùng → rơi xuống re-pick slot khác (auto-rotate).
    if (cur && now - cur.at < TTL_MS && pool.includes(cur.profileId) && cooldownUntil(cur.profileId) <= now && (await aliveState(cur.profileId, service)) === "alive") {
      cur.at = now; await save(); return cur.profileId;
    }

    const counts = activeCounts(serviceId, now);
    let chosen = null, fallback = null, fbCount = Infinity;
    for (const pid of pool) {
      if (cooldownUntil(pid) > now) continue; // slot tạm bị loại (weekly/usage limit) — GIỮ trong pool, chỉ skip tới khi reset
      const st = await aliveState(pid, service);
      if (st === "dead") { const i = (state.index[serviceId] || []).indexOf(pid); if (i >= 0) { state.index[serviceId].splice(i, 1); dirty = true; } continue; }
      if (st === "unavailable") continue; // transient — skip, keep in pool
      const c = counts[pid] || 0;
      if (c < fbCount) { fbCount = c; fallback = pid; }
      if (c < effectiveCapacity(pid, serviceId)) { chosen = pid; break; } // first profile under (custom) capacity — fill order
    }
    const pick = chosen || fallback; // all full → overflow to least-loaded (never block)
    if (!pick) { if (dirty) await save(); return null; }
    state.assign[key] = { profileId: pick, at: now };
    delete state.recent[key]; // gán sống lại → bỏ bản ghi lịch sử (live luôn thắng recent)
    await save();
    return pick;
  });
}

// READ-ONLY: the CURRENT sticky pool assignment for (service,user), or null. No re-pick, no TTL refresh, no
// disk write — safe for a warm-tab revision probe (unlike assignProfile which mutates + persists state). Only
// ever returns THIS user's own existing assignment, so it can neither leak another user's slot nor occupy a
// slot on a service the user was never assigned (an un-pulled service simply has no entry → null).
async function peekAssignment(serviceId, userId) {
  await load();
  const cur = state.assign[serviceId + "|" + userId];
  if (cur && Date.now() - cur.at < TTL_MS) return cur.profileId;
  return null;
}

// CHẠM GÁN KHI DÙNG THẬT: mỗi debit model = bằng chứng user đang dùng dịch vụ → refresh `at` của gán sống
// (phiên chat dài không bao giờ rớt TTL → web admin luôn hiện Slot #N thay vì "login riêng"), hoặc HỒI SINH gán
// từ lịch sử recent (user vẫn dùng profile đó thật → tính lại vào capacity là ĐÚNG hơn, sticky giữ nguyên slot).
// serviceId từ client có thể bị domain-lẫn (tab GPT-5.5 Pro báo "chatgpt" vì cùng chatgpt.com) → nếu user không
// có gán cho serviceId đó nhưng có gán ĐÚNG 1 dịch vụ khác chung registrable domain thì chạm dịch vụ đó.
async function touchAssignment(serviceId, userId, services) {
  return store.withProfileLock(LOCK, async () => {
    await load(); // re-read TRONG mutex — nhặt mutation của worker khác vừa lưu
    const now = Date.now();
    const hasKey = (k) => !!(state.assign[k] || state.recent[k]);
    let key = serviceId + "|" + userId;
    if (!hasKey(key)) {
      const me = (services || []).find((s) => s.id === serviceId);
      if (!me) return false;
      const myDoms = cookieScope.allowedCookieRegistrables([me]);
      const hits = (services || [])
        .filter((s) => s.id !== serviceId)
        .filter((s) => Array.from(cookieScope.allowedCookieRegistrables([s])).some((d) => myDoms.has(d)))
        .map((s) => s.id + "|" + userId)
        .filter(hasKey);
      if (hits.length !== 1) return false; // 0 = không dùng pool; >1 = mơ hồ → không đoán
      key = hits[0];
    }
    if (state.assign[key]) state.assign[key].at = now;
    else { state.assign[key] = { profileId: state.recent[key].profileId, at: now }; delete state.recent[key]; }
    await save();
    return true;
  });
}

async function poolStatus(services) {
  await load();
  const now = Date.now();
  const out = {};
  for (const s of (services || [])) {
    const counts = activeCounts(s.id, now);
    out[s.id] = (state.index[s.id] || []).map((pid) => ({ profileId: pid, activeUsers: counts[pid] || 0, capacity: effectiveCapacity(pid, s.id) }));
  }
  return out;
}

// AI-ĐANG-DÙNG-PROFILE-NÀO: liệt kê mọi gán còn TTL. Mỗi entry = { serviceId, userId, profileId(=svc-slot),
// slot, assignedAt, idleSec }. "Đang dùng" = có gán trong TTL (làm mới mỗi lần App User kéo profile cho dịch vụ
// đó) — KHÔNG khẳng định tab còn mở, chỉ là lần gán gần nhất + đã nhàn rỗi bao lâu.
function assignEntry(key, a, now) {
  const sep = key.indexOf("|");
  if (sep < 0) return null;
  const profileId = String(a.profileId || "");
  const m = /-(\d+)$/.exec(profileId);
  return {
    serviceId: key.slice(0, sep), userId: key.slice(sep + 1), profileId,
    slot: m ? Number(m[1]) : null,
    assignedAt: new Date(a.at).toISOString(),
    idleSec: Math.round((now - a.at) / 1000),
  };
}
async function poolAssignments() {
  await load();
  const now = Date.now();
  const out = [];
  for (const key in state.assign) {
    const a = state.assign[key];
    if (!a || now - a.at >= TTL_MS) continue;
    const e = assignEntry(key, a, now);
    if (e) out.push(e);
  }
  return out.sort((x, y) => (x.serviceId + x.userId).localeCompare(y.serviceId + y.userId));
}
// Lịch sử gán ĐÃ hết TTL trong 24h (state.recent) — expired:true để UI phân biệt với gán đang chiếm slot.
async function poolRecentAssignments() {
  await load();
  const now = Date.now();
  const out = [];
  for (const key in state.recent) {
    const a = state.recent[key];
    if (!a || now - a.at >= RECENT_MS) continue;
    if (state.assign[key]) continue; // đã gán sống lại → live thắng
    const e = assignEntry(key, a, now);
    if (e) out.push({ ...e, expired: true });
  }
  return out.sort((x, y) => (x.serviceId + x.userId).localeCompare(y.serviceId + y.userId));
}

// PROFILE ĐÃ ĐẨY: mọi profile Manager đã push vào pool (theo state.index), kèm metadata snapshot (KHÔNG giải mã
// blob — chỉ đọc revision/updatedAt/size, rẻ). services = đảo ngược index (profile phục vụ những dịch vụ nào).
async function poolProfiles() {
  await load();
  const byProfile = new Map();
  for (const svc in state.index) {
    for (const pid of state.index[svc] || []) {
      let e = byProfile.get(pid);
      if (!e) { e = { profileId: pid, services: [] }; byProfile.set(pid, e); }
      e.services.push(svc);
    }
  }
  const out = [];
  for (const e of byProfile.values()) {
    let rec = null, readErr = false;
    try { rec = await store.getSnapshotRecord(e.profileId); } catch { readErr = true; } // lỗi IO thoáng qua ≠ mất snapshot
    const override = Number(state.capacity.byProfile[e.profileId]) || 0; // sức chứa riêng của profile (0 = chưa đặt)
    const cdUntil = cooldownUntil(e.profileId);
    const cdActive = cdUntil > Date.now();
    out.push({
      profileId: e.profileId,
      services: e.services.sort(),
      revision: rec ? Number(rec.revision || 0) : 0,
      updatedAt: rec && rec.updatedAt ? rec.updatedAt : null,
      sizeBytes: rec && rec.blob ? (typeof rec.blob === "string" ? rec.blob.length : JSON.stringify(rec.blob).length) : 0,
      stored: readErr ? true : !!(rec && rec.blob), // false = còn trong index nhưng snapshot ĐÃ MẤT THẬT (không phải lỗi đọc tạm)
      capacity: override >= 1 ? override : Number(state.capacity.default) || CAPACITY, // sức chứa hiệu lực (profile-level)
      capacityCustom: override >= 1, // true = đang đặt riêng cho profile này
      cooldownUntil: cdActive ? new Date(cdUntil).toISOString() : null, // slot đang bị loại tạm (weekly limit…) tới lúc này
      cooldownReason: cdActive && state.cooldown[e.profileId] ? (state.cooldown[e.profileId].reason || "") : "",
    });
  }
  return out.sort((a, b) => String(a.profileId).localeCompare(String(b.profileId)));
}

// XÓA 1 profile đã đẩy: gỡ khỏi mọi index dịch vụ + hủy gán đang chiếm (assign/recent) + xóa override sức chứa
// + XÓA snapshot trên đĩa. Không khôi phục được (Manager phải đẩy lại). Nguyên tử qua mutex.
async function removeProfile(profileId) {
  const pid = String(profileId || "");
  if (!pid) return { ok: false, error: "no-profile" };
  const removedFrom = await store.withProfileLock(LOCK, async () => {
    await load();
    const svcs = [];
    for (const svc in state.index) {
      const arr = state.index[svc] || [];
      const i = arr.indexOf(pid);
      if (i >= 0) { arr.splice(i, 1); svcs.push(svc); }
    }
    for (const k in state.assign) { if (state.assign[k] && state.assign[k].profileId === pid) delete state.assign[k]; }
    for (const k in state.recent) { if (state.recent[k] && state.recent[k].profileId === pid) delete state.recent[k]; }
    if (state.capacity && state.capacity.byProfile) delete state.capacity.byProfile[pid];
    await save();
    return svcs;
  });
  await store.deleteSnapshotRecord(pid).catch(() => {}); // xóa file snapshot (best-effort)
  return { ok: true, profileId: pid, removedFromServices: removedFrom };
}

// ĐẶT SỨC CHỨA (số user/slot). scope: "profile" | "service" | "default". value<1 (hoặc rỗng) = xóa override (về fallback).
async function setPoolCapacity({ scope, key, value } = {}) {
  return store.withProfileLock(LOCK, async () => {
    await load();
    const n = Math.floor(Number(value) || 0);
    const clamped = n >= 1 ? Math.min(100000, n) : 0;
    if (scope === "default") {
      state.capacity.default = clamped >= 1 ? clamped : CAPACITY;
    } else if (scope === "service" && key) {
      if (clamped >= 1) state.capacity.byService[String(key)] = clamped; else delete state.capacity.byService[String(key)];
    } else if (scope === "profile" && key) {
      if (clamped >= 1) state.capacity.byProfile[String(key)] = clamped; else delete state.capacity.byProfile[String(key)];
    } else {
      return { ok: false, error: "bad-scope" };
    }
    await save();
    return { ok: true, capacity: state.capacity };
  });
}
async function getCapacity() { await load(); return state.capacity; }

// ĐẶT COOLDOWN cho 1 slot pool (loại tạm khỏi assign tới `untilMs`). profileId = "<serviceId>-<slot>" (đúng tên
// Manager đặt) — nhận trực tiếp profileId, hoặc dựng từ (serviceId, slot). reason vd "weekly-limit".
// Idempotent + GIA HẠN (lấy max until) → nhiều report không rút ngắn; parse-fail (untilMs thiếu/quá khứ) →
// fallback DEFAULT_COOLDOWN_MS; kẹp trần MAX_COOLDOWN_MS chống cooldown vô hạn do parse sai.
async function setSlotCooldown({ serviceId, slot, profileId, untilMs, reason } = {}) {
  return store.withProfileLock(LOCK, async () => {
    await load();
    const pid = String(
      profileId || (serviceId != null ? `${String(serviceId).toLowerCase().trim()}-${Math.max(1, Number(slot) || 1)}` : "")
    ).trim();
    if (!pid) return { ok: false, error: "no-profile" };
    const now = Date.now();
    let until = Math.floor(Number(untilMs) || 0);
    if (!(until > now)) until = now + DEFAULT_COOLDOWN_MS; // parse fail / thiếu mốc reset → fallback
    until = Math.min(until, now + MAX_COOLDOWN_MS);        // trần an toàn
    const prev = state.cooldown[pid];
    const finalUntil = prev && Number(prev.until) > until ? Number(prev.until) : until; // gia hạn, không rút ngắn
    state.cooldown[pid] = { until: finalUntil, reason: String(reason || "cooldown").slice(0, 40), serviceId: ownerServiceOf(pid), at: now };
    await save();
    return { ok: true, profileId: pid, until: finalUntil, untilIso: new Date(finalUntil).toISOString() };
  });
}
// GỠ cooldown 1 slot (clear thủ công web admin, hoặc khi biết đã reset).
async function clearSlotCooldown(profileId) {
  return store.withProfileLock(LOCK, async () => {
    await load();
    const pid = String(profileId || "");
    const had = !!(state.cooldown && state.cooldown[pid]);
    if (had) { delete state.cooldown[pid]; await save(); }
    return { ok: true, profileId: pid, cleared: had };
  });
}
// Danh sách slot đang cooldown (bỏ bản đã hết hạn) — cho web admin.
async function getCooldowns() {
  await load();
  const now = Date.now();
  const out = [];
  for (const pid in (state.cooldown || {})) {
    const c = state.cooldown[pid];
    if (!c || Number(c.until) <= now) continue;
    out.push({
      profileId: pid, serviceId: c.serviceId || ownerServiceOf(pid), reason: c.reason || "",
      until: new Date(Number(c.until)).toISOString(), remainingSec: Math.round((Number(c.until) - now) / 1000),
    });
  }
  return out.sort((a, b) => a.profileId.localeCompare(b.profileId));
}

module.exports = { indexProfile, assignProfile, peekAssignment, touchAssignment, poolStatus, poolAssignments, poolRecentAssignments, poolProfiles, removeProfile, setPoolCapacity, getCapacity, setSlotCooldown, clearSlotCooldown, getCooldowns, CAPACITY, TTL_MS };
