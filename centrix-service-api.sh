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
export CENTRIX_V2_API_URL="${CENTRIX_V2_API_URL:-https://api.cetrix.app}"
export CENTRIX_V2_SESSION="${CENTRIX_V2_SESSION:-$SCRIPT_DIR/.cetrix-session.json}"
export CENTRIX_OUT_DIR="${CENTRIX_OUT_DIR:-$SCRIPT_DIR/cookies}"

CMD="${1:-info}"
shift || true

exec node - "$CMD" "$@" <<'NODE_EOF'
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API_BASE = String(process.env.CENTRIX_V2_API_URL || "https://api.cetrix.app").trim().replace(/\/+$/, "");
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

async function apiRequest(endpoint, options = {}, retry = true) {
  let token = await getAccessToken();
  let res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
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

function decryptEnvelope(envelope, leaseToken) {
  if (!envelope || !envelope.ciphertext) throw new Error("ENVELOPE_EMPTY");
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
    "copilot", "grok", "deepseek", "canva", "semrush",
    "monica", "gamma", "quillbot", "notion"
  ];

  for (const s of services) {
    const res = await apiRequest("/v1/managed-profiles/assign", {
      method: "POST",
      body: JSON.stringify({
        serviceId: s,
        idempotencyKey: `test:${s}:${Date.now()}`,
        ttlSeconds: 1800,
        reclaim: true
      })
    });
    if (res.ok) {
      console.log(`✅ ${s.padEnd(14)} -> 200 OK (Profile: ${res.data.assignment?.profileId || "N/A"})`);
    } else {
      console.log(`❌ ${s.padEnd(14)} -> ${res.status} (${res.data.error?.message || JSON.stringify(res.data)})`);
    }
  }
  console.log("");
}

async function handleAssign(serviceId) {
  console.log(`🔑 Requesting Lease Assignment for '${serviceId}'...`);
  const res = await apiRequest("/v1/managed-profiles/assign", {
    method: "POST",
    body: JSON.stringify({
      serviceId,
      idempotencyKey: `cli:${serviceId}:${Date.now()}`,
      ttlSeconds: 1800,
      reclaim: true
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
  const res = await apiRequest("/v1/managed-profiles/assign", {
    method: "POST",
    body: JSON.stringify({
      serviceId,
      idempotencyKey: `cli:${serviceId}:${Date.now()}`,
      ttlSeconds: 1800,
      reclaim: true
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
      "x-managed-lease-token": leaseToken
    }
  });

  if (!snapRes.ok) {
    if (!silent) console.error(`❌ Failed to fetch snapshot for '${serviceId}' (${snapRes.status})`);
    return { ok: false, error: `SNAPSHOT_HTTP_${snapRes.status}` };
  }

  const snap = await snapRes.json();
  try {
    const payload = decryptEnvelope(snap.envelope, leaseToken);
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

    if (!silent) {
      console.log(`✅ [${serviceId.padEnd(14)}] -> Success! (${(payload.cookies || []).length} cookies, ${Object.keys(payload.localStorage || {}).length} localStorage keys)`);
      console.log(`   📁 Cookies: ${cookieFile}`);
      console.log(`   📁 Session: ${sessionFile}`);
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
    "copilot", "grok", "deepseek", "canva", "semrush",
    "monica", "notion", "gamma", "quillbot", "scribd",
    "envato-elements", "zoom"
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

async function main() {
  switch (cmd) {
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
    case "assign":
      await handleAssign(targetService);
      break;
    case "snapshot":
    case "export-cookies":
    case "cookies":
      await handleExportCookies(targetService, false, OUT_DIR);
      break;
    case "all":
    case "export-all":
    case "down-all":
    case "download-all":
      await handleExportAll();
      break;
    default:
      if (cmd && !["help", "-h", "--help"].includes(cmd)) {
        await handleExportCookies(cmd, false, OUT_DIR);
        break;
      }
      console.log(`Unknown command: ${cmd}`);
      console.log("Usage: ./centrix-service-api.sh [info|list|test-all|assign <id>|export-cookies <id>|all|<serviceId>]");
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
NODE_EOF
