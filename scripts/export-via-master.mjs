import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

// Load encryption helpers
const { decryptSnapshot } = await import(path.join(ROOT_DIR, "centrix-backend/shared/profile-crypto.js"));
const { scopeSnapshotToServices } = await import(path.join(ROOT_DIR, "centrix-backend/shared/cookie-scope.js"));

const MASTER_TOKEN = process.env.CENTRIX_REMOTE_TOKEN || "cxm_2820cd066030366f3b304a17cb86531dcb9c1b38aec2fde7a78d884c12e586ae";
const MASTER_KEY = process.env.CENTRIX_MASTER_SNAPSHOT_KEY || "hAJIodiOAczxFLkCIAKDxbroOcwGqlWRYZzmXvLVEDE=";
const AT_REST_KEY = process.env.CENTRIX_SNAPSHOT_AT_REST_KEY || "jaWOL7zFpK/dLBjjhVGW+m496i0O53E+/mnGtul5hmY=";
const BASE_URL = process.env.CENTRIX_BACKEND_URL || "http://127.0.0.1:18778";
const SNAPSHOT_DIR = process.env.CENTRIX_SNAPSHOT_DIR || path.join(ROOT_DIR, "centrix-backend/vps-103.240.7.254-data/centrix-snapshots");
const SERVICES_FILE = path.join(ROOT_DIR, "centrix-backend/vps-103.240.7.254-data/okmijnuhbzaq/services.json");
const OUT_DIR = process.env.CENTRIX_OUT_DIR || path.join(ROOT_DIR, "cookies");

// Service map & catalog
let catalogServices = [];
try {
  const sRaw = JSON.parse(await fs.readFile(SERVICES_FILE, "utf8"));
  catalogServices = sRaw.services || [];
} catch {}

const DEFAULT_SERVICES = [
  "chatgpt", "claude", "gemini", "grok", "notebooklm",
  "deepseek", "perplexity", "poe", "gamma", "freepik",
  "monica", "canva", "semrush", "envato-elements"
];

// Offline direct reader
async function exportServiceOffline(serviceId) {
  const svc = catalogServices.find((s) => s.id === serviceId) || { id: serviceId, cookieDomains: [`${serviceId}.com`] };
  
  // Try slot files (e.g. chatgpt-1.json, chatgpt.json, default.json)
  const candidateFiles = [
    path.join(SNAPSHOT_DIR, `${serviceId}-1.json`),
    path.join(SNAPSHOT_DIR, `${serviceId}-2.json`),
    path.join(SNAPSHOT_DIR, `${serviceId}.json`),
    path.join(SNAPSHOT_DIR, `default.json`)
  ];

  let rawBlob = null;
  let usedFile = "";
  for (const f of candidateFiles) {
    try {
      const data = JSON.parse(await fs.readFile(f, "utf8"));
      if (data && data.blob) {
        rawBlob = data.blob;
        usedFile = path.basename(f, ".json");
        break;
      }
    } catch {}
  }

  if (!rawBlob) throw new Error(`Không tìm thấy file snapshot cho ${serviceId}`);

  let fullSnap = decryptSnapshot(rawBlob, AT_REST_KEY);
  let scopedSnap = scopeSnapshotToServices(fullSnap, [svc]);
  let cookies = scopedSnap.cookies && scopedSnap.cookies.length > 0 ? scopedSnap.cookies : (fullSnap.cookies || []);

  return { cookies, slot: usedFile, source: "offline-snapshot" };
}

// Online API reader
async function exportServiceOnline(serviceId) {
  const res = await fetch(`${BASE_URL}/api/profile/export?service=${encodeURIComponent(serviceId)}`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || err.reason || `HTTP ${res.status}`);
  }
  const data = await res.json();
  let cookies = [];
  if (data.encrypted) {
    const snap = decryptSnapshot(data.encrypted, MASTER_KEY);
    cookies = snap.cookies || [];
  } else if (data.snapshot && data.snapshot.cookies) {
    cookies = data.snapshot.cookies;
  }
  return { cookies, slot: data.assignedProfile || `${serviceId}-1`, source: "api-backend" };
}

export async function exportServiceCookies(serviceId) {
  let result;
  try {
    // Try online API first
    result = await exportServiceOnline(serviceId);
  } catch (err) {
    // Fallback to offline direct snapshot decryption
    result = await exportServiceOffline(serviceId);
  }

  const { cookies, slot, source } = result;
  const serviceDir = path.join(OUT_DIR, serviceId);
  await fs.mkdir(serviceDir, { recursive: true });

  // 1. Raw JSON
  await fs.writeFile(path.join(serviceDir, "cookies.json"), JSON.stringify(cookies, null, 2), "utf8");
  await fs.writeFile(path.join(serviceDir, `${serviceId}.json`), JSON.stringify(cookies, null, 2), "utf8");

  // 2. J2TEAM format
  const j2team = {
    url: cookies[0]?.url || `https://${serviceId}.com/`,
    cookies: cookies.map((c) => ({
      domain: c.domain,
      expirationDate: c.expirationDate || c.expires || (Date.now() / 1000 + 86400 * 30),
      hostOnly: !c.domain.startsWith("."),
      httpOnly: !!c.httpOnly,
      name: c.name,
      path: c.path || "/",
      sameSite: c.sameSite || "unspecified",
      secure: !!c.secure,
      session: !!c.session,
      storeId: "0",
      value: c.value
    }))
  };
  await fs.writeFile(path.join(serviceDir, "j2team-cookies.json"), JSON.stringify(j2team, null, 2), "utf8");
  await fs.writeFile(path.join(serviceDir, `${serviceId}.j2team.json`), JSON.stringify(j2team, null, 2), "utf8");

  // 3. Write host-scoped files (e.g. claude.ai.json, chatgpt.com.json) for Chrome importer
  const svc = catalogServices.find((s) => s.id === serviceId) || {};
  const domains = svc.cookieDomains || [serviceId === "claude" ? "claude.ai" : `${serviceId}.com`];
  for (const d of domains) {
    const hostName = String(d).replace(/^\./, "");
    if (hostName.includes(".")) {
      await fs.writeFile(path.join(serviceDir, `${hostName}.json`), JSON.stringify(j2team, null, 2), "utf8");
    }
  }

  console.log(`✓ [${serviceId.padEnd(16)}] ${String(cookies.length).padStart(3)} cookies | Slot: ${slot.padEnd(14)} (${source}) → cookies/${serviceId}/`);
  return { serviceId, count: cookies.length, slot };
}

const SERVICE_ALIASES = {
  claue: "claude",
  claud: "claude",
  cl: "claude",
  gpt: "chatgpt",
  cg: "chatgpt",
  chat: "chatgpt",
  "chat-gpt": "chatgpt",
  gem: "gemini",
  copilot: "microsoft-copilot",
  msft: "microsoft-copilot",
  elements: "envato-elements",
  envato: "envato-elements",
  "gpt-5": "notebooklm",
  "gpt-pro": "notebooklm",
  gpt5: "notebooklm",
  magnific: "freepik",
  perp: "perplexity"
};

function normalizeServiceName(s) {
  const norm = String(s || "").toLowerCase().trim();
  return SERVICE_ALIASES[norm] || norm;
}

// CLI args parsing
const rawArgs = process.argv.slice(2);
let importToChrome = false;
const services = [];

for (const a of rawArgs) {
  if (a === "--chrome" || a === "-c") {
    importToChrome = true;
  } else if (a === "all") {
    services.push(...DEFAULT_SERVICES);
  } else {
    services.push(normalizeServiceName(a));
  }
}

const targetServices = services.length ? Array.from(new Set(services)) : DEFAULT_SERVICES;

console.log(`\n================================================================`);
console.log(`             CENTRIX COOKIE EXPORT (MASTER TOKEN)               `);
console.log(`================================================================\n`);

let successCount = 0;
for (const s of targetServices) {
  try {
    await exportServiceCookies(s);
    successCount++;
  } catch (err) {
    console.error(`✗ [${s.padEnd(16)}] Lỗi: ${err.message}`);
  }
}

console.log(`\n----------------------------------------------------------------`);
console.log(`Đã xuất xong ${successCount}/${targetServices.length} dịch vụ vào thư mục: ${OUT_DIR}/`);
console.log(`----------------------------------------------------------------\n`);
