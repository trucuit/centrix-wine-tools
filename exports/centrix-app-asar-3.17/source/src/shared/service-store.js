const fs = require("node:fs/promises");
const path = require("node:path");
const { app } = require("electron");
const { DESKTOP_CONFIG_DIR } = require("./gibberish-names");

const CONFIG_DIR_NAME = DESKTOP_CONFIG_DIR;
const CONFIG_FILE_NAME = "services.json";

const DEFAULT_SERVICES = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    url: "https://chatgpt.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=64",
    enabled: true,
    loginUrl: "https://chatgpt.com/",
    modelPricingEnabled: true,
    defaultModel: "gpt-4o-mini",
    defaultCreditCost: 1,
    cookieDomains: ["chatgpt.com", "openai.com", "oaistatic.com", "oaiusercontent.com"]
  },
  {
    id: "claude",
    name: "Claude",
    url: "https://claude.ai/new",
    iconUrl: "https://www.google.com/s2/favicons?domain=claude.ai&sz=64",
    enabled: true,
    loginUrl: "https://claude.ai/new",
    modelPricingEnabled: true,
    defaultModel: "claude-3-5-haiku",
    defaultCreditCost: 1,
    cookieDomains: ["claude.ai", "anthropic.com"]
  },
  {
    id: "gemini",
    name: "Gemini",
    url: "https://gemini.google.com/",
    loginUrl: "https://gemini.google.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "gemini-2.5-pro",
    defaultCreditCost: 2,
    cookieDomains: ["gemini.google.com", "google.com"]
  },
  {
    id: "perplexity",
    name: "Perplexity",
    url: "https://www.perplexity.ai/",
    loginUrl: "https://www.perplexity.ai/",
    iconUrl: "https://www.google.com/s2/favicons?domain=www.perplexity.ai&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "sonar-pro",
    defaultCreditCost: 2,
    cookieDomains: ["perplexity.ai"]
  },
  {
    id: "microsoft-copilot",
    name: "Microsoft Copilot",
    url: "https://copilot.microsoft.com/",
    loginUrl: "https://copilot.microsoft.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=copilot.microsoft.com&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "copilot",
    defaultCreditCost: 2,
    cookieDomains: ["copilot.microsoft.com", "microsoft.com"]
  },
  {
    id: "grok",
    name: "Grok",
    url: "https://grok.com/",
    loginUrl: "https://grok.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=grok.com&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "grok-4",
    defaultCreditCost: 3,
    cookieDomains: ["grok.com", "x.ai", "x.com"]
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://chat.deepseek.com/",
    loginUrl: "https://chat.deepseek.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=chat.deepseek.com&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "deepseek-chat",
    defaultCreditCost: 1,
    cookieDomains: ["deepseek.com", "chat.deepseek.com"]
  },
  {
    id: "mistral",
    name: "Mistral",
    url: "https://chat.mistral.ai/",
    loginUrl: "https://chat.mistral.ai/",
    iconUrl: "https://www.google.com/s2/favicons?domain=chat.mistral.ai&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "mistral-large",
    defaultCreditCost: 2,
    cookieDomains: ["mistral.ai", "chat.mistral.ai"]
  },
  {
    id: "midjourney",
    name: "Midjourney",
    url: "https://www.midjourney.com/",
    loginUrl: "https://www.midjourney.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=www.midjourney.com&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "midjourney-v7",
    defaultCreditCost: 4,
    cookieDomains: ["midjourney.com", "discord.com"]
  },
  {
    id: "poe",
    name: "Poe",
    url: "https://poe.com/",
    loginUrl: "https://poe.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=poe.com&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "poe-assistant",
    defaultCreditCost: 2,
    cookieDomains: ["poe.com"]
  },
  {
    id: "notebooklm",
    name: "NotebookLM",
    url: "https://notebooklm.google.com/",
    loginUrl: "https://notebooklm.google.com/",
    iconUrl: "https://www.google.com/s2/favicons?domain=notebooklm.google.com&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "notebooklm",
    defaultCreditCost: 1,
    cookieDomains: ["notebooklm.google.com", "google.com"]
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    url: "https://elevenlabs.io/app",
    loginUrl: "https://elevenlabs.io/app",
    iconUrl: "https://www.google.com/s2/favicons?domain=elevenlabs.io&sz=64",
    enabled: true,
    modelPricingEnabled: true,
    defaultModel: "eleven-multilingual-v2",
    defaultCreditCost: 2,
    cookieDomains: ["elevenlabs.io"]
  }
];

function servicesConfigDir() {
  return path.join(app.getPath("appData"), CONFIG_DIR_NAME);
}

function servicesConfigPath() {
  return path.join(servicesConfigDir(), CONFIG_FILE_NAME);
}

function slugify(value, fallback = "service") {
  const slug = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function normalizeUrl(input) {
  const value = String(input || "").trim();
  if (!value) return "https://www.google.com/";

  try {
    return new URL(value).toString();
  } catch {
    return new URL(`https://${value}`).toString();
  }
}

function fallbackIconForUrl(url) {
  try {
    const parsed = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`;
  } catch {
    return "https://www.google.com/s2/favicons?domain=centrix.digital&sz=64";
  }
}

function sanitizeService(input, index, usedIds) {
  // Strip angle brackets at storage time so a service name can never carry HTML markup into ANY renderer
  // (admin UI / remote-tabs / App User) — defense-in-depth backing the per-sink escaping. Names are plain
  // text labels, so no legitimate feature relies on < or >.
  const name = String(input?.name || `Dịch vụ ${index + 1}`).replace(/[<>]/g, "").trim().slice(0, 80);
  const baseId = slugify(input?.id || name, `service-${index + 1}`);
  const rawUrl = normalizeUrl(input?.url);
  const url = baseId === "claude" && rawUrl === "https://claude.ai/" ? "https://claude.ai/new" : rawUrl;
  const loginUrl = input?.loginUrl ? normalizeUrl(input.loginUrl) : url;
  let id = baseId;
  let suffix = 2;

  while (usedIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(id);

  return {
    id,
    name,
    url,
    loginUrl,
    iconUrl: String(input?.iconUrl || fallbackIconForUrl(url)).trim(),
    enabled: input?.enabled !== false,
    modelPricingEnabled: input?.modelPricingEnabled === true || ["chatgpt", "claude"].includes(baseId),
    defaultModel: String(input?.defaultModel || "").trim().slice(0, 120),
    defaultCreditCost: Math.max(1, Math.min(100000, Math.round(Number(input?.defaultCreditCost || 1) || 1))),
    cookieDomains: sanitizeCookieDomains(input?.cookieDomains)
  };
}

function sanitizeCookieDomains(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  for (const value of input) {
    const host = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^\.+/, "")
      .replace(/\/.*$/, "")
      .slice(0, 120);
    if (host && /^[a-z0-9.-]+$/.test(host)) seen.add(host);
  }
  return Array.from(seen).slice(0, 20);
}

function sanitizeServices(services) {
  const usedIds = new Set();
  const clean = Array.isArray(services)
    ? services
        .map((service, index) => sanitizeService(service, index, usedIds))
        .filter((service) => service.name && service.url)
    : [];

  return clean.length ? clean : DEFAULT_SERVICES.map((service, index) => sanitizeService(service, index, usedIds));
}

function createConfig(services = DEFAULT_SERVICES) {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    services: sanitizeServices(services)
  };
}

async function ensureConfig() {
  const filePath = servicesConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(createConfig(), null, 2), "utf8");
  }

  return filePath;
}

async function readServicesConfig() {
  const filePath = await ensureConfig();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const config = createConfig(parsed.services);
    config.updatedAt = parsed.updatedAt || config.updatedAt;
    return { ...config, filePath };
  } catch {
    const config = createConfig();
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
    return { ...config, filePath };
  }
}

async function writeServicesConfig(services) {
  const filePath = await ensureConfig();
  const config = createConfig(services);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
  return { ...config, filePath };
}

async function resetServicesConfig() {
  return writeServicesConfig(DEFAULT_SERVICES);
}

module.exports = {
  DEFAULT_SERVICES,
  normalizeUrl,
  readServicesConfig,
  resetServicesConfig,
  servicesConfigPath,
  writeServicesConfig
};
