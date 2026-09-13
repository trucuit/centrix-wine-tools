#!/usr/bin/env zsh
# centrix-service-api.sh
#
# CentriX Service API Client & Profile Manager
#
# Usage:
#   ./centrix-service-api.sh info                  # Show account profile, credit & quota
#   ./centrix-service-api.sh list                  # List all services in catalog
#   ./centrix-service-api.sh test-all              # Test server lease assignment for all AI services
#   ./centrix-service-api.sh assign <serviceId>    # Assign a lease for a service (e.g. claude, chatgpt)
#   ./centrix-service-api.sh export-cookies <id>   # Download & decrypt session cookies (e.g. claude)
#   ./centrix-service-api.sh all                   # Export cookies for every service
#
# Auth: dùng chung session v2 với ./export-centrix-api.sh — login bằng
#       ./export-centrix-api.sh login (OTP) trước khi chạy script này.
#
# Env:
#   CENTRIX_V2_API_URL   API base        (default: https://api.cetrix.app)
#   CENTRIX_V2_SESSION   session file    (default: ./.cetrix-session.json)
#   CENTRIX_OUT_DIR      output dir      (default: ./cookies)
#
set -euo pipefail

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"

# Chia sẻ session + output với export-centrix-api.sh (v2 flow) nên chỉ cần login một lần.
export CENTRIX_APP_VERSION="${CENTRIX_APP_VERSION:-0.1.391}"
export CENTRIX_V2_API_URL="${CENTRIX_V2_API_URL:-https://api.cetrix.app}"
export CENTRIX_V2_SESSION="${CENTRIX_V2_SESSION:-$SCRIPT_DIR/.cetrix-session.json}"
export CENTRIX_OUT_DIR="${CENTRIX_OUT_DIR:-$SCRIPT_DIR/cookies}"

show_menu() {
  print -r -- "╔══════════════════════════════════════════════════════════╗"
  print -r -- "║             CentriX Service API Manager                  ║"
  print -r -- "╚══════════════════════════════════════════════════════════╝"
  print -r -- "  1) 👤 Info           - Thông tin tài khoản & hạn mức gói"
  print -r -- "  2) 📋 List Catalog   - Danh sách dịch vụ trong hệ thống"
  print -r -- "  3) 🚀 Test All       - Kiểm tra lease assignment toàn bộ AI"
  print -r -- "  4) 🔑 Assign Lease   - Cấp lease session cho 1 dịch vụ cụ thể"
  print -r -- "  5) 🍪 Export Cookies - Tải & giải mã cookies cho 1 dịch vụ"
  print -r -- "  6) 🌐 Export & Chrome- Tải cookies & nạp trực tiếp vào Chrome"
  print -r -- "  7) 📦 Export All     - Tải cookies cho tất cả dịch vụ"
  print -r -- "  0) ❌ Exit           - Thoát"
  print -r -- ""
}

select_service() {
  local prompt_text="$1"
  print -r -- "" >&2
  print -r -- "Danh sách dịch vụ:" >&2
  print -r -- "  1) chatgpt        2) gptpro         3) claude         4) gemini" >&2
  print -r -- "  5) perplexity     6) copilot        7) grok           8) grok-heavy" >&2
  print -r -- "  9) deepseek      10) canva         11) semrush       12) monica" >&2
  print -r -- " 13) freepik       14) gamma         15) quillbot      16) scribd" >&2
  print -r -- " 17) envato        18) zoom          19) notion        20) web" >&2
  print -r -- "" >&2
  read -r "selected_svc?👉 $prompt_text [chọn số 1-20 hoặc nhập tên, mặc định: chatgpt]: " || selected_svc="chatgpt"
  local clean_input
  clean_input="$(echo "${selected_svc:-chatgpt}" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$clean_input" in
    1) echo "chatgpt" ;;
    2) echo "gptpro" ;;
    3) echo "claude" ;;
    4) echo "gemini" ;;
    5) echo "perplexity" ;;
    6) echo "copilot" ;;
    7) echo "grok" ;;
    8) echo "grok-heavy" ;;
    9) echo "deepseek" ;;
    10) echo "canva" ;;
    11) echo "semrush" ;;
    12) echo "monica" ;;
    13) echo "freepik" ;;
    14) echo "gamma" ;;
    15) echo "quillbot" ;;
    16) echo "scribd" ;;
    17) echo "envato-elements" ;;
    18) echo "zoom" ;;
    19) echo "notion" ;;
    20) echo "web" ;;
    "grok-heavy"|grokheavy|grok_heavy|"grok heavy"|heavy) echo "grok-heavy" ;;
    "gpt-pro"|gptpro|"gpt pro"|pro|"gpt-5"|"gpt 5") echo "gptpro" ;;
    copilot|"microsoft-copilot"|ms-copilot) echo "copilot" ;;
    envato|"envato-elements"|elements) echo "envato-elements" ;;
    *) echo "${clean_input:-chatgpt}" ;;
  esac
}

if [[ $# -eq 0 ]]; then
  show_menu
  read -r "choice?👉 Chọn một tuỳ chọn [1-7, 0] (mặc định: 1): " || choice="1"
  choice="${choice:-1}"
  case "$choice" in
    1|info|me) CMD="info" ;;
    2|list|services) CMD="list" ;;
    3|test|test-all) CMD="test-all" ;;
    4|assign)
      CMD="assign"
      svc=$(select_service "Chọn dịch vụ cần cấp lease")
      set -- "$svc"
      ;;
    5|export|export-cookies|cookies)
      CMD="export-cookies"
      svc=$(select_service "Chọn dịch vụ cần export cookies")
      set -- "$svc"
      ;;
    6|chrome|export-chrome|"export & chrome")
      CMD="export-cookies"
      svc=$(select_service "Chọn dịch vụ cần export & mở Chrome")
      set -- "$svc" "--chrome"
      ;;
    7|all|export-all) CMD="all" ;;
    0|q|exit|quit)
      print -r -- "Thoát."
      exit 0
      ;;
    *)
      print -r -- "Lựa chọn không hợp lệ: $choice"
      exit 1
      ;;
  esac
else
  case "${1:-}" in
    -h|--help|help)
      show_menu
      print -r -- "Usage: $0 [info | list | test-all | assign <id> | export-cookies <id> [--chrome] | all]"
      exit 0
      ;;
    *)
      CMD="$1"
      shift || true
      ;;
  esac
fi

exec node - "$CMD" "$@" <<'NODE_EOF'
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API_BASE = String(process.env.CENTRIX_V2_API_URL || "https://api.cetrix.app").trim().replace(/\/+$/, "");
const APP_VERSION = String(process.env.CENTRIX_APP_VERSION || "0.1.391").trim();
const SESSION_FILE = process.env.CENTRIX_V2_SESSION;
const OUT_DIR = process.env.CENTRIX_OUT_DIR;
const cmd = process.argv[2] || "info";
const targetService = (process.argv[3] || "claude").toLowerCase().trim();

function getAuthData() {
  if (!SESSION_FILE || !fs.existsSync(SESSION_FILE)) {
    console.error(`❌ Session not found: ${SESSION_FILE}`);
    console.error("Login first:  ./export-centrix-api.sh login");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  if (!data.accessToken) {
    console.error(`❌ Session has no accessToken: ${SESSION_FILE}`);
    console.error("Login again:  ./export-centrix-api.sh login");
    process.exit(1);
  }
  return { file: SESSION_FILE, data };
}

// Ghi lại token mới nhưng giữ nguyên các field khác của session (email, userId, sessionId...)
function saveAuthData(tokens) {
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch (_) {}
    writeSecretJson(SESSION_FILE, {
      ...existing,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      savedAt: new Date().toISOString()
    });
  } catch (_) {}
}

async function getAccessToken() {
  const { data } = getAuthData();
  // Check if current accessToken is still valid (decode payload)
  try {
    const payloadPart = data.accessToken.split(".")[1];
    if (payloadPart) {
      const decoded = JSON.parse(Buffer.from(payloadPart, "base64").toString("utf8"));
      const nowSec = Math.floor(Date.now() / 1000);
      if (decoded.exp && decoded.exp > nowSec + 30) {
        return data.accessToken;
      }
    }
  } catch (_) {}

  // Expired or missing exp -> Refresh
  try {
    const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: data.refreshToken })
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const refreshed = await res.json();
    const newAccess = refreshed.accessToken || data.accessToken;
    const newRefresh = refreshed.refreshToken || data.refreshToken;
    saveAuthData({ accessToken: newAccess, refreshToken: newRefresh });
    return newAccess;
  } catch (_) {
    return data.accessToken;
  }
}

let deviceIdentity = null;
function getDeviceIdentity() {
  if (deviceIdentity) return deviceIdentity;
  let rawMachineId = "";
  try {
    if (process.platform === "darwin") {
      const stdout = require("child_process").execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 4000 });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout);
      if (m) rawMachineId = m[1].trim();
    } else if (process.platform === "win32") {
      const stdout = require("child_process").execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", timeout: 4000 });
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-f-]+)/i.exec(stdout);
      if (m) rawMachineId = m[1].trim();
    }
  } catch (_) {}
  if (!rawMachineId) rawMachineId = require("os").hostname() || "centrix-cli";
  const deviceIdHash = crypto.createHash("sha256").update(rawMachineId, "utf8").digest("hex");

  const keyFile = path.join(path.dirname(SESSION_FILE), ".centrix-device-key.json");
  try {
    if (fs.existsSync(keyFile)) {
      const data = JSON.parse(fs.readFileSync(keyFile, "utf8"));
      if (data.privateKeyPkcs8 && data.publicKeySpkiBase64) {
        const privateKey = crypto.createPrivateKey({ key: Buffer.from(data.privateKeyPkcs8, "base64"), type: "pkcs8", format: "der" });
        deviceIdentity = { deviceIdHash, publicKeySpkiBase64: data.publicKeySpkiBase64, privateKey };
        return deviceIdentity;
      }
    }
  } catch (_) {}

  const pair = crypto.generateKeyPairSync("x25519");
  const privateKeyDer = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "der" }));
  const publicKeySpkiBase64 = Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })).toString("base64");
  try {
    writeSecretJson(keyFile, {
      publicKeySpkiBase64,
      privateKeyPkcs8: privateKeyDer.toString("base64"),
      createdAt: new Date().toISOString()
    });
  } catch (_) {}

  deviceIdentity = { deviceIdHash, publicKeySpkiBase64, privateKey: pair.privateKey };
  return deviceIdentity;
}

async function apiRequest(endpoint, options = {}, retry = true) {
  let token = await getAccessToken();
  const device = getDeviceIdentity();
  let res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-centrix-app-version": APP_VERSION,
      "x-centrix-platform": process.platform,
      "x-centrix-arch": process.arch,
      "x-managed-device-id-hash": device.deviceIdHash,
      ...(options.headers || {})
    }
  });

  if (res.status === 401 && retry) {
    const { data } = getAuthData();
    try {
      const refRes = await fetch(`${API_BASE}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: data.refreshToken })
      });
      if (refRes.ok) {
        const refreshed = await refRes.json();
        saveAuthData({ accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken });
        token = refreshed.accessToken;
        res = await fetch(`${API_BASE}${endpoint}`, {
          ...options,
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-centrix-app-version": APP_VERSION,
            "x-centrix-platform": process.platform,
            "x-centrix-arch": process.arch,
            "x-managed-device-id-hash": device.deviceIdHash,
            ...(options.headers || {})
          }
        });
      }
    } catch (_) {}
  }

  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: body };
}

// writeFileSync chỉ áp dụng `mode` khi tạo file mới; file đã tồn tại vẫn giữ
// permission cũ, nên phải chmod lại để secret không rớt về 0644.
function writeSecretJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function decryptEnvelope(envelope, leaseToken, aad = {}) {
  if (!envelope || !envelope.ciphertext) throw new Error("ENVELOPE_EMPTY");

  // HKDF(X25519) device envelope introduced in CentriX 0.1.391
  if (envelope.keyDerivation === "HKDF(X25519)") {
    const device = getDeviceIdentity();
    const peer = crypto.createPublicKey({
      key: Buffer.from(String(envelope.ephemeralPublicKey || ""), "base64"),
      type: "spki",
      format: "der",
    });
    const shared = crypto.diffieHellman({ privateKey: device.privateKey, publicKey: peer });
    const key = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), "centrix-managed-envelope-v2", 32));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(envelope.iv || ""), "base64"));
    const aadBuf = Buffer.from(`${String(aad.assignmentId || "").trim()}:${Number(aad.snapshotVersion) || 0}:${String(aad.deviceIdHash || device.deviceIdHash || "").trim()}`, "utf8");
    decipher.setAAD(aadBuf);
    if (envelope.tag) decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(envelope.ciphertext || ""), "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  // Standard / fallback AES-256-GCM envelope
  const aesKey = crypto.createHash("sha256").update(leaseToken, "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(envelope.iv, "base64"));
  if (envelope.tag) decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function handleInfo() {
  console.log("🔍 Fetching CentriX Account Profile...\n");
  const me = await apiRequest("/v1/auth/me");
  const plans = await apiRequest("/v1/commerce/plans");
  const ledger = await apiRequest("/v1/ledger/accounts");

  if (!me.ok) {
    console.error("❌ Failed to get user profile:", me.data);
    return;
  }

  const u = me.data.user || {};
  console.log("══════════════════════════════════════════════════════");
  console.log(`👤 User:       ${u.name || "N/A"} (${u.email || "N/A"})`);
  console.log(`🆔 User ID:    ${u.id || "N/A"}`);
  console.log(`🟢 Status:     ${u.status || "active"}`);
  console.log("──────────────────────────────────────────────────────");

  const sp = plans.data?.servicePacks || {};
  const unlocked = sp.unlockedServiceIds || [];
  console.log(`📦 Unlocked:   ${unlocked.length > 0 ? unlocked.join(", ") : "chatgpt, gptpro"}`);
  console.log(`📅 Expires:    ${sp.packExpiresAt || "N/A"}`);
  console.log(`💵 Pack Credit: $${(Number(sp.packCreditUsdMicros || 0) / 1e6).toFixed(2)} USD`);
  console.log(`⚡ Quota 5h:    $${(Number(sp.usdLimit5hMicros || 0) / 1e6).toFixed(2)} USD`);
  console.log(`⚡ Quota 7d:    $${(Number(sp.usdLimit7dMicros || 0) / 1e6).toFixed(2)} USD`);

  if (ledger.ok && ledger.data.accounts) {
    console.log("──────────────────────────────────────────────────────");
    console.log("💰 Wallet Balances:");
    for (const acc of ledger.data.accounts) {
      if (acc.assetType === "PACK_USD_MICRO") {
        console.log(`   • ${acc.name}: $${(Number(acc.balance || 0) / 1e6).toFixed(2)} USD`);
      } else if (acc.assetType === "USD_MICRO") {
        console.log(`   • ${acc.name}: $${(Number(acc.balance || 0) / 1e6).toFixed(2)} USD`);
      } else if (acc.assetType === "VND") {
        console.log(`   • ${acc.name}: ${Number(acc.balance || 0).toLocaleString("vi-VN")} đ`);
      }
    }
  }
  console.log("══════════════════════════════════════════════════════\n");
}

async function handleList() {
  console.log("📋 Fetching Service Catalog...\n");
  const cat = await apiRequest("/v1/catalog/services");
  if (!cat.ok || !cat.data.services) {
    console.error("❌ Failed to fetch catalog:", cat.data);
    return;
  }
  console.log(`Found ${cat.data.services.length} services:\n`);
  console.log(String("ID").padEnd(18) + String("NAME").padEnd(24) + String("APP URL").padEnd(36) + "CONNECTION");
  console.log("─".repeat(88));
  for (const s of cat.data.services) {
    console.log(
      String(s.id).padEnd(18) +
      String(s.name || s.id).padEnd(24) +
      String(s.appUrl || s.url || "").slice(0, 34).padEnd(36) +
      String(s.connectionMode || "profile")
    );
  }
  console.log("");
}

async function handleTestAll() {
  console.log("🚀 Testing Server Lease Assignment for all AI services...\n");
  const services = [
    "claude", "chatgpt", "gptpro", "gemini", "perplexity",
    "copilot", "grok", "grok-heavy", "deepseek", "canva", "semrush",
    "monica", "freepik", "gamma", "quillbot", "scribd", "envato-elements",
    "zoom", "notion"
  ];

  const device = getDeviceIdentity();
  for (const s of services) {
    const res = await apiRequest("/v1/managed-profiles/assign", {
      method: "POST",
      body: JSON.stringify({
        serviceId: s,
        idempotencyKey: `test:${s}:${Date.now()}`,
        ttlSeconds: 1800,
        stickySeconds: 900,
        reclaim: true,
        devicePublicKey: device.publicKeySpkiBase64,
        deviceIdHash: device.deviceIdHash
      })
    });
    if (res.ok) {
      console.log(`✅ ${s.padEnd(16)} -> 200 OK (Profile: ${res.data.assignment?.profileId || "N/A"})`);
    } else {
      console.log(`❌ ${s.padEnd(16)} -> ${res.status} (${res.data.error?.message || JSON.stringify(res.data)})`);
    }
  }
  console.log("");
}

async function handleAssign(serviceId) {
  console.log(`🔑 Requesting Lease Assignment for '${serviceId}'...`);
  const device = getDeviceIdentity();
  const res = await apiRequest("/v1/managed-profiles/assign", {
    method: "POST",
    body: JSON.stringify({
      serviceId,
      idempotencyKey: `cli:${serviceId}:${Date.now()}`,
      ttlSeconds: 1800,
      stickySeconds: 900,
      reclaim: true,
      devicePublicKey: device.publicKeySpkiBase64,
      deviceIdHash: device.deviceIdHash
    })
  });

  if (!res.ok) {
    console.error(`❌ Assign failed (${res.status}):`, res.data);
    return null;
  }

  const asgn = res.data.assignment || {};
  const lease = res.data.leaseToken;
  console.log("✅ Assignment Succeeded!");
  console.log(`   • Assignment ID: ${asgn.id}`);
  console.log(`   • Profile ID:    ${asgn.profileId}`);
  console.log(`   • Lease Token:   ${lease}`);
  console.log(`   • Expires At:    ${asgn.expiresAt}`);
  return { assignmentId: asgn.id, leaseToken: lease };
}

async function handleExportCookies(serviceId, silent = false, outDir = OUT_DIR) {
  const device = getDeviceIdentity();
  const res = await apiRequest("/v1/managed-profiles/assign", {
    method: "POST",
    body: JSON.stringify({
      serviceId,
      idempotencyKey: `cli:${serviceId}:${Date.now()}`,
      ttlSeconds: 1800,
      stickySeconds: 900,
      reclaim: true,
      devicePublicKey: device.publicKeySpkiBase64,
      deviceIdHash: device.deviceIdHash
    })
  });

  if (!res.ok) {
    if (!silent) console.error(`❌ Assign failed for '${serviceId}' (${res.status}):`, res.data?.error?.message || res.data);
    return { ok: false, error: res.data?.error?.message || `HTTP_${res.status}` };
  }

  const asgn = res.data.assignment || {};
  const leaseToken = res.data.leaseToken;

  const token = await getAccessToken();
  const snapRes = await fetch(`${API_BASE}/v1/managed-profiles/${asgn.id}/snapshot`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "x-managed-lease-token": leaseToken,
      "x-centrix-app-version": APP_VERSION,
      "x-centrix-platform": process.platform,
      "x-centrix-arch": process.arch,
      "x-managed-device-id-hash": device.deviceIdHash
    }
  });

  if (!snapRes.ok) {
    if (!silent) console.error(`❌ Failed to fetch snapshot for '${serviceId}' (${snapRes.status})`);
    return { ok: false, error: `SNAPSHOT_HTTP_${snapRes.status}` };
  }

  const snap = await snapRes.json();
  try {
    const payload = decryptEnvelope(snap.envelope, leaseToken, {
      assignmentId: asgn.id || snap.assignmentId,
      snapshotVersion: asgn.snapshotVersion || snap.snapshotVersion,
      deviceIdHash: device.deviceIdHash
    });
    fs.mkdirSync(outDir, { recursive: true });

    // 1. Full session payload (origin, userAgent, cookies, localStorage, sessionStorage)
    const sessionFile = path.join(outDir, `session-${serviceId}.json`);
    writeSecretJson(sessionFile, payload);

    // 2. Browser Extension importable cookies (Cookie-Editor format)
    const cookieFile = path.join(outDir, `cookies-${serviceId}.json`);
    const browserCookies = (payload.cookies || []).map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      sameSite: c.sameSite || "Lax",
      expirationDate: c.expirationDate || c.expires || (Math.floor(Date.now() / 1000) + 30 * 86400)
    }));
    writeSecretJson(cookieFile, browserCookies);

    // 3. Sync to service subfolder (cookies/<serviceId>/)
    const svcDir = path.join(outDir, serviceId);
    fs.mkdirSync(svcDir, { recursive: true });
    writeSecretJson(path.join(svcDir, `${serviceId}.full.json`), payload);
    if (payload.localStorage && Object.keys(payload.localStorage).length > 0) {
      writeSecretJson(path.join(svcDir, `${serviceId}.storage.json`), payload.localStorage);
    }

    // Split cookies by domain in service folder
    const byDomain = {};
    for (const c of payload.cookies || []) {
      const host = String(c.domain || "").replace(/^\./, "").toLowerCase();
      if (!host) continue;
      if (!byDomain[host]) byDomain[host] = [];
      byDomain[host].push(c);
    }
    for (const [dom, domCookies] of Object.entries(byDomain)) {
      writeSecretJson(path.join(svcDir, `${dom}.json`), domCookies);
    }

    // Release lease so subsequent calls don't get 409 Conflict
    fetch(`${API_BASE}/v1/managed-profiles/${asgn.id}/release`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-centrix-app-version": APP_VERSION,
        "x-centrix-platform": process.platform,
        "x-centrix-arch": process.arch,
        "x-managed-device-id-hash": device.deviceIdHash
      },
      body: JSON.stringify({ leaseToken, reason: "cli_export_done" })
    }).catch(() => {});

    if (!silent) {
      console.log(`✅ [${serviceId.padEnd(14)}] -> Success! (${(payload.cookies || []).length} cookies, ${Object.keys(payload.localStorage || {}).length} localStorage keys)`);
      console.log(`   📁 Cookies: ${cookieFile}`);
      console.log(`   📁 Session: ${sessionFile}`);
      console.log(`   📁 Subdir:  ${svcDir}`);
    }

    return {
      ok: true,
      serviceId,
      origin: payload.origin,
      cookieCount: (payload.cookies || []).length,
      storageKeyCount: Object.keys(payload.localStorage || {}).length,
      cookieFile,
      sessionFile
    };
  } catch (e) {
    if (!silent) console.error(`❌ Decryption failed for '${serviceId}':`, e.message);
    return { ok: false, error: e.message };
  }
}

async function handleExportAll() {
  const outDir = OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("🌐 DOWNLOADING ALL SESSION COOKIES TO LOCAL FOLDER...");
  console.log(`📂 Destination: ${outDir}`);
  console.log("══════════════════════════════════════════════════════════════════════\n");

  const services = [
    "claude", "chatgpt", "gptpro", "gemini", "perplexity",
    "copilot", "grok", "grok-heavy", "deepseek", "canva", "semrush",
    "monica", "freepik", "gamma", "quillbot", "scribd",
    "envato-elements", "zoom", "notion"
  ];

  const results = [];
  for (const s of services) {
    process.stdout.write(`⏳ Fetching & decrypting ${s.padEnd(16)} ... `);
    const res = await handleExportCookies(s, true, outDir);
    if (res.ok) {
      console.log(`✅ OK (${res.cookieCount} cookies) -> ${path.basename(res.cookieFile)}`);
      results.push(res);
    } else {
      console.log(`⚠️ Skip (${res.error})`);
    }
  }

  // Save index summary
  const summaryFile = path.join(outDir, "ALL_SERVICES_INDEX.json");
  fs.writeFileSync(summaryFile, JSON.stringify({
    exportedAt: new Date().toISOString(),
    totalExported: results.length,
    services: results
  }, null, 2), "utf8");

  console.log("\n──────────────────────────────────────────────────────────────────────");
  console.log(`🎉 COMPLETED! Successfully exported ${results.length} AI services to:`);
  console.log(`📁 ${outDir}/`);
  console.log(`📋 Index summary: ${summaryFile}`);
  console.log("──────────────────────────────────────────────────────────────────────\n");
}

const SERVICE_ALIASES = {
  chatgpt: "chatgpt",
  "chatgpt-pro": "gptpro",
  "chatgpt pro": "gptpro",
  "chat gpt pro": "gptpro",
  gptpro: "gptpro",
  "gpt-pro": "gptpro",
  "gpt pro": "gptpro",
  chatgptpro: "gptpro",
  chatgpt_pro: "gptpro",
  pro: "gptpro",
  gpt: "gptpro",
  "gpt-5": "gptpro",
  "gpt 5": "gptpro",
  gpt5: "gptpro",
  claude: "claude",
  "claude.ai": "claude",
  claudeai: "claude",
  anthropic: "claude",
  "cl;aude": "claude",
  copilot: "copilot",
  "microsoft-copilot": "copilot",
  "ms-copilot": "copilot",
  mscopilot: "copilot",
  bing: "copilot",
  gemini: "gemini",
  "gemini.google": "gemini",
  grok: "grok",
  "grok_heavy": "grok-heavy",
  "grok heavy": "grok-heavy",
  grokheavy: "grok-heavy",
  heavy: "grok-heavy",
  "grok-heavy": "grok-heavy",
  mail: "outlook",
  email: "outlook",
  office: "outlook",
  office365: "outlook",
  ms365: "outlook",
};

function resolveServiceId(id) {
  const raw = String(id || "").trim().toLowerCase();
  if (!raw) return "";
  if (SERVICE_ALIASES[raw]) return SERVICE_ALIASES[raw];

  // Clean stray punctuation typos (e.g. "cl;aude" -> "claude", "claude," -> "claude")
  const cleaned = raw.replace(/[;:'",`!]/g, "").replace(/^[-_.]+|[-_.]+$/g, "");
  if (SERVICE_ALIASES[cleaned]) return SERVICE_ALIASES[cleaned];

  return cleaned;
}

function shouldImportChrome(rawTokens) {
  return rawTokens.some(t => /--chrome|-c|^chrome$|^chorme$/i.test(t));
}

function runImportToChrome(serviceId) {
  const scriptDir = path.dirname(SESSION_FILE);
  const importScript = path.join(scriptDir, "import-cookies-to-chrome.sh");
  if (!fs.existsSync(importScript)) {
    console.warn("⚠️ import-cookies-to-chrome.sh not found, skipping Chrome import");
    return;
  }
  console.log(`\n🌐 Auto-importing '${serviceId}' cookies into Chrome...`);
  try {
    require("child_process").execFileSync(importScript, [serviceId], {
      stdio: "inherit",
      env: { ...process.env, CENTRIX_COOKIES_DIR: OUT_DIR }
    });
  } catch (err) {
    console.error(`❌ Chrome import failed: ${err.message}`);
  }
}

function parseServiceList(rawTokens) {
  const filtered = rawTokens.filter(t => !/^(?:--chrome|-c|chrome|chorme|import|to|into|and|\+)$/i.test(t));
  const fullString = filtered.join(" ");
  // Split on +, comma, or standalone 'and'
  const phrases = fullString.split(/\s*(?:\+|\band\b|,)\s*/i).filter(Boolean);
  const services = [];
  for (let phrase of phrases) {
    phrase = phrase.trim();
    if (phrase.includes("/") || phrase.includes("\\")) {
      const parts = phrase.split(/[/\\]/).filter(Boolean);
      phrase = parts[parts.length - 1];
    }
    const resolved = resolveServiceId(phrase);
    if (resolved) services.push(resolved);
  }
  return [...new Set(services)];
}

async function handleExportMultiple(services, outDir = OUT_DIR, importChrome = false) {
  if (services.length === 1) {
    const res = await handleExportCookies(services[0], false, outDir);
    if (res.ok && importChrome) {
      runImportToChrome(services[0]);
    }
    return res;
  }
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`🌐 EXPORTING ${services.length} SERVICES: ${services.join(", ")}`);
  console.log(`📂 Destination: ${outDir}`);
  console.log("══════════════════════════════════════════════════════════════════════\n");

  const results = [];
  for (const s of services) {
    const res = await handleExportCookies(s, false, outDir);
    results.push(res);
    if (res.ok && importChrome) {
      runImportToChrome(s);
    }
  }

  console.log("──────────────────────────────────────────────────────────────────────");
  const successCount = results.filter(r => r.ok).length;
  console.log(`🎉 COMPLETED! Successfully exported ${successCount}/${services.length} services to:`);
  console.log(`📁 ${outDir}/`);
  console.log("──────────────────────────────────────────────────────────────────────\n");
}

async function main() {
  const allTokens = process.argv.slice(2);
  const importChrome = shouldImportChrome(allTokens);
  const lowerCmd = cmd.toLowerCase().trim();
  switch (lowerCmd) {
    case "info":
    case "me":
      await handleInfo();
      break;
    case "list":
    case "services":
      await handleList();
      break;
    case "test-all":
    case "test":
      await handleTestAll();
      break;
    case "assign": {
      const svcs = parseServiceList(process.argv.slice(3));
      if (!svcs.length) svcs.push(resolveServiceId(targetService) || "claude");
      for (const s of svcs) {
        await handleAssign(s);
      }
      break;
    }
    case "snapshot":
    case "export-cookies":
    case "cookies": {
      const svcs = parseServiceList(process.argv.slice(3));
      if (!svcs.length) svcs.push(resolveServiceId(targetService) || "claude");
      await handleExportMultiple(svcs, OUT_DIR, importChrome);
      break;
    }
    case "all":
    case "export-all":
    case "down-all":
    case "download-all":
      await handleExportAll();
      break;
    default: {
      if (cmd && !["help", "-h", "--help"].includes(cmd)) {
        const svcs = parseServiceList(allTokens);
        if (svcs.length) {
          await handleExportMultiple(svcs, OUT_DIR, importChrome);
          break;
        }
      }
      console.log(`Unknown command: ${cmd}`);
      console.log("Usage: ./centrix-service-api.sh [info|list|test-all|assign <id>|export-cookies <id> [--chrome]|all|<serviceId, ...>]");
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
NODE_EOF
