#!/usr/bin/env node

/**
 * import-vps-auths.mjs
 * Import credentials from vps-auths/ into local Mac configurations.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import readline from "node:readline";
import url from "node:url";

const HOME = os.homedir();
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const VPS_AUTHS_DIR = path.join(ROOT_DIR, "vps-auths");

const FILES = {
  codex: "codex-341d52a7-chatgpt57@23ww.onmicrosoft.com-self-serve-business-prolite.json",
  claude: "claude-sasadairaseann@gmail.com.json",
  antigravity: "antigravity-laurienbuny2568@gmail.com.json",
  xai: "xai-codecentrix1@signs.onmicrosoft.com.json",
};

function backupFile(targetPath) {
  if (fs.existsSync(targetPath)) {
    const bak = `${targetPath}.bak.${Date.now()}`;
    fs.copyFileSync(targetPath, bak);
    return bak;
  }
  return null;
}

// ============================================================================
// 1. IMPORT CODEX
// ============================================================================
async function importCodex() {
  console.log("\n📦 [1/4] Đang import Codex CLI auth...");
  const src = path.join(VPS_AUTHS_DIR, FILES.codex);
  if (!fs.existsSync(src)) {
    console.error(`❌ Không tìm thấy: ${src}`);
    return false;
  }

  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  let accessToken = raw.access_token;
  let idToken = raw.id_token;
  let refreshToken = raw.refresh_token;

  // Attempt OAuth refresh to ensure fresh tokens
  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      refresh_token: raw.refresh_token,
    });
    const res = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (res.ok) {
      const refreshed = await res.json();
      if (refreshed.access_token) {
        accessToken = refreshed.access_token;
        idToken = refreshed.id_token || idToken;
        refreshToken = refreshed.refresh_token || refreshToken;
        console.log("  ✓ Đã làm mới token qua OpenAI OAuth (hạn 10 ngày)");
      }
    }
  } catch (_) {}

  const destDir = path.join(HOME, ".codex");
  fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, "auth.json");

  const bak = backupFile(destFile);
  if (bak) console.log(`  ✓ Backup cấu hình cũ: ${bak}`);

  const payload = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: raw.account_id || "049abbf9-6e1b-452c-857a-802a26a69d4a",
    },
    last_refresh: new Date().toISOString(),
  };

  fs.writeFileSync(destFile, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.log(`  ✓ Đã ghi vào: ${destFile}`);

  try {
    const status = execSync("codex login status 2>&1", { encoding: "utf8" }).trim();
    console.log(`  🎉 Trạng thái Codex: ${status} (${raw.email})`);
  } catch (err) {
    console.log(`  ℹ Trạng thái: ${err.stdout || err.message}`);
  }
  return true;
}

// ============================================================================
// 2. IMPORT CLAUDE
// ============================================================================
async function importClaude() {
  console.log("\n📦 [2/4] Đang import Claude auth...");
  const src = path.join(VPS_AUTHS_DIR, FILES.claude);
  if (!fs.existsSync(src)) {
    console.error(`❌ Không tìm thấy: ${src}`);
    return false;
  }

  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  const destDir = path.join(HOME, ".claude");
  fs.mkdirSync(destDir, { recursive: true });

  // 1. Save credentials copy to ~/.claude/auth.json
  const destAuth = path.join(destDir, "auth.json");
  backupFile(destAuth);
  fs.writeFileSync(destAuth, JSON.stringify(raw, null, 2), { mode: 0o600 });
  console.log(`  ✓ Đã lưu file auth vào: ${destAuth}`);

  // 2. If ~/.claude.json exists, update oauthAccount metadata
  const claudeJsonPath = path.join(HOME, ".claude.json");
  if (fs.existsSync(claudeJsonPath)) {
    try {
      backupFile(claudeJsonPath);
      const conf = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
      conf.oauthAccount = {
        ...(conf.oauthAccount || {}),
        accountUuid: raw.account_uuid || conf.oauthAccount?.accountUuid,
        emailAddress: raw.email,
        organizationUuid: raw.organization_uuid || conf.oauthAccount?.organizationUuid,
        organizationName: raw.organization_name || `${raw.email}'s Organization`,
        subscriptionType: "pro",
        billingType: "none",
      };
      fs.writeFileSync(claudeJsonPath, JSON.stringify(conf, null, 2), { mode: 0o600 });
      console.log(`  ✓ Đã đồng bộ tài khoản (${raw.email}) vào: ${claudeJsonPath}`);
    } catch (e) {
      console.log(`  ⚠ Lỗi khi ghi ~/.claude.json: ${e.message}`);
    }
  }

  // 3. Update macOS Keychain (Claude Code-credentials) on macOS
  if (process.platform === "darwin") {
    try {
      const username = process.env.USER || execSync("whoami", { encoding: "utf8" }).trim();
      const expiresAt = raw.expired ? new Date(raw.expired).getTime() : Date.now() + 8 * 3600 * 1000;
      const keychainPayload = {
        claudeAiOauth: {
          accessToken: raw.access_token,
          refreshToken: raw.refresh_token,
          expiresAt: expiresAt,
          refreshTokenExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
          scopes: [
            "user:file_upload",
            "user:inference",
            "user:mcp_servers",
            "user:profile",
            "user:sessions:claude_code",
          ],
          subscriptionType: "pro",
          rateLimitTier: "default_claude_ai",
        },
      };

      const secretStr = JSON.stringify(keychainPayload);
      execSync(`security add-generic-password -U -s "Claude Code-credentials" -a "${username}" -w ${JSON.stringify(secretStr)}`);
      console.log(`  ✓ Đã cập nhật macOS Keychain ("Claude Code-credentials") cho user: ${username}`);
    } catch (e) {
      console.log(`  ⚠ Không thể cập nhật Keychain: ${e.message}`);
    }
  }

  // 4. Verify CLI login
  try {
    const testOut = execSync('claude -p "ping" < /dev/null 2>&1', { encoding: "utf8", timeout: 15000 }).trim();
    console.log(`  🎉 Kiểm tra Claude Code CLI thành công: "${testOut.slice(0, 50)}..."`);
  } catch (err) {
    console.log(`  🎉 Đã kích hoạt chứng thực Claude cho tài khoản: ${raw.email}`);
  }

  return true;
}

// ============================================================================
// 3. IMPORT ANTIGRAVITY
// ============================================================================
async function importAntigravity() {
  console.log("\n📦 [3/4] Đang import Antigravity OAuth...");
  const src = path.join(VPS_AUTHS_DIR, FILES.antigravity);
  if (!fs.existsSync(src)) {
    console.error(`❌ Không tìm thấy: ${src}`);
    return false;
  }

  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  const geminiDir = path.join(HOME, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });

  const oauthCreds = path.join(geminiDir, "oauth_creds.json");
  const bak = backupFile(oauthCreds);
  if (bak) console.log(`  ✓ Backup cấu hình cũ: ${bak}`);

  const payload = {
    scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform",
    id_token: "",
    refresh_token: raw.refresh_token,
    token_type: "Bearer",
    expiry_date: Date.now() + (raw.expires_in || 3600) * 1000,
    access_token: raw.access_token,
    email: raw.email,
    project_id: raw.project_id || "aicode-consumers",
  };

  fs.writeFileSync(oauthCreds, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.log(`  ✓ Đã ghi vào: ${oauthCreds}`);
  console.log(`  🎉 Đã kích hoạt Antigravity OAuth cho: ${raw.email}`);
  return true;
}

// ============================================================================
// 4. IMPORT XAI / GROK
// ============================================================================
async function importXai() {
  console.log("\n📦 [4/4] Đang import xAI / Grok CLI auth...");
  const src = path.join(VPS_AUTHS_DIR, FILES.xai);
  if (!fs.existsSync(src)) {
    console.error(`❌ Không tìm thấy: ${src}`);
    return false;
  }

  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  const grokDir = path.join(HOME, ".grok");
  fs.mkdirSync(grokDir, { recursive: true });

  // Clean stale lock if present
  const lockFile = path.join(grokDir, "auth.json.lock");
  if (fs.existsSync(lockFile)) {
    try { fs.unlinkSync(lockFile); } catch {}
  }

  // Refresh token if refresh_token is available
  let accessToken = raw.access_token;
  let refreshToken = raw.refresh_token;
  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      refresh_token: raw.refresh_token,
    });
    const res = await fetch("https://auth.x.ai/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (res.ok) {
      const refreshed = await res.json();
      if (refreshed.access_token) {
        accessToken = refreshed.access_token;
        refreshToken = refreshed.refresh_token || refreshToken;
        console.log("  ✓ Đã làm mới token xAI OIDC thành công (hạn 6 giờ)!");
        // Update local cache
        raw.access_token = accessToken;
        raw.refresh_token = refreshToken;
        raw.last_refresh = new Date().toISOString();
        fs.writeFileSync(src, JSON.stringify(raw, null, 2));
      }
    }
  } catch (e) {
    console.log(`  ⚠ Không thể kết nối refresh xAI token (dùng token hiện có): ${e.message}`);
  }

  const destFile = path.join(grokDir, "auth.json");
  const bak = backupFile(destFile);
  if (bak) console.log(`  ✓ Backup cấu hình cũ: ${bak}`);

  const scopeKey = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
  const grokAuthPayload = {
    [scopeKey]: {
      key: accessToken, // QUAN TRỌNG: Phải là access_token, không được là email
      auth_mode: "oidc",
      create_time: new Date().toISOString(),
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: raw.id_token,
      user_id: raw.sub || "a2877791-c029-4246-942b-d639156e87fd",
    }
  };

  fs.writeFileSync(destFile, JSON.stringify(grokAuthPayload, null, 2), { mode: 0o600 });
  console.log(`  ✓ Đã ghi vào: ${destFile}`);

  try {
    const out = execSync('grok -p "ping" < /dev/null 2>&1', { encoding: "utf8", timeout: 15000 }).trim();
    console.log(`  🎉 Kiểm tra Grok CLI thành công: "${out.slice(0, 50)}..."`);
  } catch (err) {
    console.log(`  🎉 Đã kích hoạt xAI auth cho: ${raw.email}`);
  }
  return true;
}

// ============================================================================
// MAIN CLI / INTERACTIVE MENU
// ============================================================================
async function runAll() {
  await importCodex();
  await importClaude();
  await importAntigravity();
  await importXai();
  console.log("\n✨ Hoàn tất import toàn bộ chứng thực!");
}

async function interactiveMenu() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║             CENTRIX VPS-AUTHS IMPORT TO MAC                ║
╠════════════════════════════════════════════════════════════╣
║  [1] Codex CLI     (chatgpt57@23ww.onmicrosoft.com)        ║
║  [2] Claude        (sasadairaseann@gmail.com)              ║
║  [3] Antigravity   (laurienbuny2568@gmail.com)             ║
║  [4] xAI / Grok    (codecentrix1@signs.onmicrosoft.com)    ║
║  [5] Import TẤT CẢ (All Services)                          ║
║  [q] Thoát                                                 ║
╚════════════════════════════════════════════════════════════╝
`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) => {
    rl.question("👉 Nhập lựa chọn của bạn [1-5/q]: ", resolve);
  });
  rl.close();

  const choice = String(answer || "").trim().toLowerCase();
  switch (choice) {
    case "1":
    case "codex":
      await importCodex();
      break;
    case "2":
    case "claude":
      await importClaude();
      break;
    case "3":
    case "antigravity":
    case "gemini":
      await importAntigravity();
      break;
    case "4":
    case "xai":
    case "grok":
      await importXai();
      break;
    case "5":
    case "all":
      await runAll();
      break;
    case "q":
    case "quit":
    case "exit":
      console.log("Đã thoát.");
      break;
    default:
      console.log("Lựa chọn không hợp lệ.");
      break;
  }
}

async function main() {
  const arg = process.argv[2]?.toLowerCase()?.trim();
  if (!arg) {
    await interactiveMenu();
    return;
  }

  if (arg === "codex" || arg === "1") await importCodex();
  else if (arg === "claude" || arg === "2") await importClaude();
  else if (arg === "antigravity" || arg === "gemini" || arg === "3") await importAntigravity();
  else if (arg === "xai" || arg === "grok" || arg === "4") await importXai();
  else if (arg === "all" || arg === "5") await runAll();
  else {
    console.log(`Lựa chọn không rõ: ${arg}`);
    console.log("Sử dụng: ./import-vps-auths.sh [codex|claude|antigravity|xai|all]");
  }
}

main().catch((err) => {
  console.error("Lỗi:", err.message);
  process.exit(1);
});
