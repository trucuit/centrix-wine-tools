#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const authFileSrc = path.resolve(ROOT_DIR, "vps-auths/codex-341d52a7-chatgpt57@23ww.onmicrosoft.com-self-serve-business-prolite.json");
const codexHome = path.join(os.homedir(), ".codex");
const authFileDest = path.join(codexHome, "auth.json");

if (!fs.existsSync(authFileSrc)) {
  console.error("❌ Không tìm thấy file nguồn:", authFileSrc);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(authFileSrc, "utf8"));

console.log("▸ Đang làm mới token qua OpenAI OAuth endpoint...");
let accessToken = raw.access_token;
let idToken = raw.id_token;
let refreshToken = raw.refresh_token;

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
      console.log("✓ Refresh token thành công! Hạn dùng mới: 10 ngày (864000s)");
    }
  } else {
    console.log("⚠ Không thể refresh tự động (dùng token hiện tại trong file): HTTP", res.status);
  }
} catch (e) {
  console.log("⚠ Lỗi khi kết nối refresh (dùng token trong file):", e.message);
}

const authPayload = {
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

fs.mkdirSync(codexHome, { recursive: true });
if (fs.existsSync(authFileDest)) {
  fs.copyFileSync(authFileDest, authFileDest + ".bak." + Date.now());
}
fs.writeFileSync(authFileDest, JSON.stringify(authPayload, null, 2), { mode: 0o600 });
console.log(`✓ Đã ghi file xác thực vào: ${authFileDest}`);

try {
  const status = execSync("codex login status", { encoding: "utf8" }).trim();
  console.log(`\n🎉 Trạng thái Codex CLI: ${status}`);
} catch (err) {
  console.log("Trạng thái:", err.stdout || err.message);
}
