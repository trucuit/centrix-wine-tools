import { deriveKey, encryptJson, decryptJson, randomB64 } from './crypto.js';

const setupView = document.getElementById('setupView');
const unlockView = document.getElementById('unlockView');
const vaultView = document.getElementById('vaultView');
const statusEl = document.getElementById('status');
const entriesEl = document.getElementById('entries');
const siteLabel = document.getElementById('siteLabel');
const savedSitesBar = document.getElementById('savedSitesBar');
const siteInput = document.getElementById('siteInput');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const loginUrlInput = document.getElementById('loginUrlInput');
const useCurrentUrlBtn = document.getElementById('useCurrentUrlBtn');
const autoFillInput = document.getElementById('autoFillInput');
const autoLoginInput = document.getElementById('autoLoginInput');
const submitDelayInput = document.getElementById('submitDelayInput');
const contextHint = document.getElementById('contextHint');
const totpSecretInput = document.getElementById('totpSecretInput');
const totpDigitsInput = document.getElementById('totpDigitsInput');
const totpPeriodInput = document.getElementById('totpPeriodInput');
const totpPreviewInput = document.getElementById('totpPreviewInput');
const emailOtpEnabledInput = document.getElementById('emailOtpEnabledInput');
const emailOtpProviderInput = document.getElementById('emailOtpProviderInput');
const emailOtpRegexInput = document.getElementById('emailOtpRegexInput');
const emailOtpSenderInput = document.getElementById('emailOtpSenderInput');
const emailOtpSubjectInput = document.getElementById('emailOtpSubjectInput');
const emailOtpPreviewInput = document.getElementById('emailOtpPreviewInput');
const saveBtn = document.getElementById('saveBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');

let session = {
  key: null,
  hostname: '',
  currentUrl: '',
  tabId: null,
  vault: {},
  meta: null,
  totpTicker: null,
  renderedEntries: [],
  editingRef: null,
  editReturnSite: null
};

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || '';
  statusEl.style.color = isError ? '#f97066' : '#98a2b3';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function normalizeSite(input) {
  try {
    if (!input) return '';
    if (/^https?:\/\//i.test(input)) return new URL(input).hostname.replace(/^www\./, '').toLowerCase();
    return String(input || '').trim().toLowerCase().replace(/^www\./, '');
  } catch {
    return String(input || '').trim().toLowerCase().replace(/^www\./, '');
  }
}

function looksDynamicPathSegment(segment) {
  const value = String(segment || '').trim();
  if (!value) return false;
  return /^[0-9a-f]{16,}$/i.test(value)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)
    || /^[A-Za-z0-9_-]{20,}$/.test(value);
}

function normalizeLoginUrlPattern(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length && looksDynamicPathSegment(segments[segments.length - 1])) {
        segments.pop();
      }
      let pathname = segments.length ? `/${segments.join('/')}` : '/';
      const shouldKeepTrailingSlash = raw.endsWith('/')
        || /(?:login|signin|sign-in|auth|authorize|verify|verification|challenge|otp|2fa|mfa)$/i.test(segments[segments.length - 1] || '');
      if (pathname !== '/' && shouldKeepTrailingSlash) pathname += '/';
      return `${url.origin.toLowerCase()}${pathname}`;
    }
  } catch {
    // Fall through to generic string normalization.
  }

  return raw
    .toLowerCase()
    .split('#')[0]
    .split('?')[0]
    .trim();
}

function normalizeLoginUrlList(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '')
      .split(/\r?\n|,/)
      .map((item) => item.trim());

  return [...new Set(values
    .map((item) => normalizeLoginUrlPattern(item))
    .filter(Boolean))]
    .slice(0, 20);
}

function loginUrlListToText(list) {
  return normalizeLoginUrlList(list).join('\n');
}

function getComparableEntrySignature(entry) {
  const normalized = normalizeStoredEntry(entry);
  return JSON.stringify({
    username: normalized.username,
    password: normalized.password,
    loginUrls: normalized.loginUrls,
    autoFill: normalized.autoFill,
    autoLogin: normalized.autoLogin,
    submitDelayMs: normalized.submitDelayMs,
    totpSecret: normalized.totpSecret,
    totpDigits: normalized.totpDigits,
    totpPeriod: normalized.totpPeriod,
    emailOtpEnabled: normalized.emailOtpEnabled,
    emailOtpProvider: normalized.emailOtpProvider,
    emailOtpRegex: normalized.emailOtpRegex,
    emailOtpSender: normalized.emailOtpSender,
    emailOtpSubject: normalized.emailOtpSubject
  });
}

function findMatchingEntryIndex(entries, entry, ignoreIndex = -1) {
  const list = Array.isArray(entries) ? entries : [];
  const signature = getComparableEntrySignature(entry);
  return list.findIndex((candidate, index) => index !== ignoreIndex && getComparableEntrySignature(candidate) === signature);
}

function normalizeTotpSecret(secret) {
  return String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function matchLoginUrlPattern(pattern, currentUrl, currentSite) {
  const normalizedPattern = normalizeLoginUrlPattern(pattern);
  const url = String(currentUrl || '').toLowerCase();
  const site = normalizeSite(currentSite || currentUrl || '');
  if (!normalizedPattern) return 0;

  if (/^https?:\/\//i.test(normalizedPattern)) {
    if (url.startsWith(normalizedPattern)) {
      return 160 + Math.min(30, normalizedPattern.length);
    }

    try {
      const patternSite = normalizeSite(normalizedPattern);
      if (patternSite && patternSite === site) {
        return 110;
      }
    } catch {
      // Ignore malformed pattern parsing.
    }
  }

  const patternSite = normalizeSite(normalizedPattern);
  if (patternSite && patternSite === site) {
    return 105;
  }

  if (url && normalizedPattern.length >= 8 && url.includes(normalizedPattern)) {
    return 130 + Math.min(20, normalizedPattern.length);
  }

  return 0;
}

function scoreEntryForContext(storedSite, entry, currentSite, currentUrl) {
  const storedSiteNormalized = normalizeSite(storedSite);
  const siteNormalized = normalizeSite(currentSite);
  let score = 0;

  if (storedSiteNormalized && storedSiteNormalized === siteNormalized) {
    score = 90;
  }

  const bestLoginUrlScore = entry.loginUrls.reduce((best, pattern) => {
    return Math.max(best, matchLoginUrlPattern(pattern, currentUrl, siteNormalized));
  }, 0);

  score = Math.max(score, bestLoginUrlScore);

  if (score && entry.autoFill) score += 2;
  return score;
}

function getLaunchParams() {
  const params = new URLSearchParams(window.location.search);
  const tabIdParam = params.get('tabId');
  const parsedTabId = tabIdParam != null ? Number(tabIdParam) : null;
  const rawUrl = params.get('url') || '';
  return {
    tabId: Number.isFinite(parsedTabId) ? parsedTabId : null,
    site: normalizeSite(params.get('site') || rawUrl || ''),
    url: rawUrl
  };
}

async function resolveInitialContext() {
  const launch = getLaunchParams();

  if (launch.tabId !== null) {
    session.tabId = launch.tabId;
  }
  if (launch.site) {
    session.hostname = launch.site;
  }
  if (launch.url && /^https?:\/\//i.test(launch.url)) {
    session.currentUrl = launch.url;
  }

  if (session.tabId !== null && (!session.hostname || !session.currentUrl)) {
    try {
      const tab = await chrome.tabs.get(session.tabId);
      if (tab?.url?.startsWith('http://') || tab?.url?.startsWith('https://')) {
        if (!session.hostname) session.hostname = normalizeSite(tab.url);
        if (!session.currentUrl) session.currentUrl = tab.url;
      }
    } catch (error) {
      console.debug('[CentriX Vault] Unable to resolve tab from launch params:', error);
    }
  }

  if (!session.hostname || session.tabId === null || !session.currentUrl) {
    const activeTab = await getActiveTab();
    const isWebTab = activeTab?.url && /^https?:\/\//i.test(activeTab.url);
    if (isWebTab) {
      if (session.tabId === null) session.tabId = activeTab.id ?? null;
      if (!session.hostname) session.hostname = normalizeSite(activeTab.url);
      if (!session.currentUrl) session.currentUrl = activeTab.url;
    }
  }

  siteInput.value = session.hostname || '';
  updateSiteLabel();
  if (session.currentUrl) {
    loginUrlInput.placeholder = normalizeLoginUrlPattern(session.currentUrl);
  }

  if (session.tabId !== null && session.hostname) {
    contextHint.textContent = session.currentUrl
      ? `Target tab: ${session.hostname} · ${normalizeLoginUrlPattern(session.currentUrl)}`
      : `Target tab: ${session.hostname}`;
  } else if (session.hostname) {
    contextHint.textContent = `Current site: ${session.hostname}`;
  } else {
    contextHint.textContent = 'Open this page from the CentriX popup on the website you want to fill for one-click Autofill.';
  }
}

function updateSiteLabel() {
  const selectedSite = normalizeSite(siteInput.value || session.hostname);
  if (selectedSite && session.hostname && selectedSite !== session.hostname) {
    siteLabel.textContent = `Viewing saved site: ${selectedSite} · Target tab: ${session.hostname}`;
    return;
  }
  siteLabel.textContent = selectedSite || '(open Vault from the CentriX popup on a website tab)';
}

function getVaultSiteSummaries() {
  return Object.entries(session.vault || {})
    .map(([storedSite, entries]) => ({
      site: normalizeSite(storedSite),
      count: Array.isArray(entries) ? entries.length : 0,
      updatedAt: Math.max(0, ...(Array.isArray(entries) ? entries : []).map((entry) => Number(entry?.updatedAt || 0)))
    }))
    .filter((item) => item.site && item.count > 0);
}

function renderSavedSiteChips(selectedSite = siteInput.value || session.hostname) {
  if (!savedSitesBar) return;

  const selected = normalizeSite(selectedSite);
  const summaries = getVaultSiteSummaries();
  savedSitesBar.innerHTML = '';

  if (!summaries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'No saved sites yet.';
    savedSitesBar.appendChild(empty);
    return;
  }

  const hasCurrentSite = session.hostname && summaries.some((item) => item.site === session.hostname);
  if (session.hostname && !hasCurrentSite) {
    summaries.unshift({ site: session.hostname, count: 0, updatedAt: Number.MAX_SAFE_INTEGER, isCurrentTab: true });
  }

  summaries.sort((a, b) => {
    if (a.site === selected && b.site !== selected) return -1;
    if (b.site === selected && a.site !== selected) return 1;
    if (a.site === session.hostname && b.site !== session.hostname) return -1;
    if (b.site === session.hostname && a.site !== session.hostname) return 1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.site.localeCompare(b.site);
  });

  summaries.forEach((summary) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `site-chip${summary.site === selected ? ' active' : ''}`;
    button.dataset.browseSite = summary.site;
    button.innerHTML = `${escapeHtml(summary.site)} <span class="site-chip-count">(${summary.count})</span>`;
    savedSitesBar.appendChild(button);
  });
}

async function loadMeta() {
  const data = await chrome.storage.local.get(['vault_meta']);
  return data.vault_meta || null;
}

async function saveMeta(meta) {
  await chrome.storage.local.set({ vault_meta: meta });
}

async function loadEncryptedVault() {
  const data = await chrome.storage.local.get(['vault_blob']);
  return data.vault_blob || null;
}

async function saveEncryptedVault(blob) {
  await chrome.storage.local.set({ vault_blob: blob });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hasAnyAutoFillEntries(vault) {
  return Object.values(vault).some((entries) => Array.isArray(entries) && entries.some((entry) => entry.autoFill));
}

async function persistVault() {
  const encrypted = await encryptJson(session.key, session.vault);
  await saveEncryptedVault(encrypted);

  const shouldKeepAutoState = Boolean(session.meta?.allowDeviceAutoUnlock) && hasAnyAutoFillEntries(session.vault);
  if (shouldKeepAutoState) {
    const autoSecret = session.meta.autoSecret || randomB64(32);
    const autoSalt = session.meta.autoSalt || randomB64(16);
    const autoKey = await deriveKey(autoSecret, autoSalt);
    const autoVaultBlob = await encryptJson(autoKey, session.vault);
    session.meta = { ...(session.meta || {}), autoSecret, autoSalt, allowDeviceAutoUnlock: true };
    await saveMeta(session.meta);
    await chrome.runtime.sendMessage({
      type: 'SAVE_AUTO_STATE',
      autoSecret,
      autoSalt,
      autoVaultBlob
    });
  } else {
    await chrome.runtime.sendMessage({ type: 'CLEAR_AUTO_STATE' });
  }
}

function normalizeStoredEntry(entry = {}) {
  return {
    username: String(entry.username || '').trim(),
    password: String(entry.password || ''),
    loginUrls: normalizeLoginUrlList(entry.loginUrls || entry.loginUrl || ''),
    autoFill: Boolean(entry.autoFill),
    autoLogin: Boolean(entry.autoFill && entry.autoLogin),
    submitDelayMs: Math.max(0, Number(entry.submitDelayMs || 350)),
    totpSecret: normalizeTotpSecret(entry.totpSecret || ''),
    totpDigits: Math.min(10, Math.max(4, Number(entry.totpDigits || 6))),
    totpPeriod: Math.min(120, Math.max(15, Number(entry.totpPeriod || 30))),
    emailOtpEnabled: Boolean(entry.emailOtpEnabled),
    emailOtpProvider: ['gmail', 'outlook', 'generic'].includes(entry.emailOtpProvider) ? entry.emailOtpProvider : 'gmail',
    emailOtpRegex: String(entry.emailOtpRegex || '').trim(),
    emailOtpSender: String(entry.emailOtpSender || '').trim(),
    emailOtpSubject: String(entry.emailOtpSubject || '').trim(),
    updatedAt: Number(entry.updatedAt || Date.now())
  };
}

function base32ToBytes(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = normalizeTotpSecret(secret);
  if (!normalized) return new Uint8Array();

  let bits = '';
  for (const ch of normalized) {
    const value = alphabet.indexOf(ch);
    if (value < 0) throw new Error('Invalid TOTP secret');
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

async function generateTotpCode(secret, digits = 6, period = 30, timestamp = Date.now()) {
  const keyBytes = base32ToBytes(secret);
  if (!keyBytes.length) return null;

  const counter = BigInt(Math.floor(timestamp / 1000 / period));
  const counterBytes = new Uint8Array(8);
  let tempCounter = counter;
  for (let i = 7; i >= 0; i -= 1) {
    counterBytes[i] = Number(tempCounter & 0xffn);
    tempCounter >>= 8n;
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, counterBytes));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24)
    | ((signature[offset + 1] & 0xff) << 16)
    | ((signature[offset + 2] & 0xff) << 8)
    | (signature[offset + 3] & 0xff);
  const otp = binary % (10 ** digits);
  return String(otp).padStart(digits, '0');
}

function getTotpRemaining(period = 30, timestamp = Date.now()) {
  return period - (Math.floor(timestamp / 1000) % period || 0);
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return false;

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const temp = document.createElement('textarea');
    temp.value = text;
    temp.style.position = 'fixed';
    temp.style.opacity = '0';
    document.body.appendChild(temp);
    temp.select();
    const ok = document.execCommand('copy');
    temp.remove();
    return ok;
  }
}

function getFormEntryDraft() {
  return normalizeStoredEntry({
    username: usernameInput.value,
    password: passwordInput.value,
    loginUrls: loginUrlInput.value,
    autoFill: autoFillInput.checked,
    autoLogin: autoLoginInput.checked,
    submitDelayMs: submitDelayInput.value,
    totpSecret: totpSecretInput.value,
    totpDigits: totpDigitsInput.value,
    totpPeriod: totpPeriodInput.value,
    emailOtpEnabled: emailOtpEnabledInput.checked,
    emailOtpProvider: emailOtpProviderInput.value,
    emailOtpRegex: emailOtpRegexInput.value,
    emailOtpSender: emailOtpSenderInput.value,
    emailOtpSubject: emailOtpSubjectInput.value
  });
}

function setCredentialEditState(ref = null) {
  session.editingRef = ref;
  saveBtn.textContent = ref ? 'Update entry' : 'Save';
  cancelEditBtn.classList.toggle('hidden', !ref);
}

function restoreEditReturnSite() {
  if (session.editReturnSite != null) {
    siteInput.value = session.editReturnSite;
  }
  session.editReturnSite = null;
}

function populateForm(entry) {
  const normalized = normalizeStoredEntry(entry);
  usernameInput.value = normalized.username;
  passwordInput.type = normalized.password ? 'text' : 'password';
  passwordInput.value = normalized.password;
  loginUrlInput.value = loginUrlListToText(normalized.loginUrls);
  autoFillInput.checked = normalized.autoFill;
  autoLoginInput.checked = normalized.autoLogin;
  submitDelayInput.value = String(normalized.submitDelayMs);
  totpSecretInput.value = normalized.totpSecret;
  totpDigitsInput.value = String(normalized.totpDigits);
  totpPeriodInput.value = String(normalized.totpPeriod);
  emailOtpEnabledInput.checked = normalized.emailOtpEnabled;
  emailOtpProviderInput.value = normalized.emailOtpProvider;
  emailOtpRegexInput.value = normalized.emailOtpRegex;
  emailOtpSenderInput.value = normalized.emailOtpSender;
  emailOtpSubjectInput.value = normalized.emailOtpSubject;
  totpPreviewInput.value = '';
  emailOtpPreviewInput.value = '';
}

function resetCredentialForm({ keepSite = true } = {}) {
  passwordInput.type = 'password';
  usernameInput.value = '';
  passwordInput.value = '';
  loginUrlInput.value = '';
  autoFillInput.checked = true;
  autoLoginInput.checked = false;
  submitDelayInput.value = '350';
  totpSecretInput.value = '';
  totpDigitsInput.value = '6';
  totpPeriodInput.value = '30';
  totpPreviewInput.value = '';
  emailOtpEnabledInput.checked = false;
  emailOtpProviderInput.value = 'gmail';
  emailOtpRegexInput.value = '';
  emailOtpSenderInput.value = '';
  emailOtpSubjectInput.value = '';
  emailOtpPreviewInput.value = '';
  setCredentialEditState(null);
  if (!keepSite) {
    siteInput.value = session.hostname || '';
  }
}

function buildEntryTags(entry) {
  const tags = [];
  tags.push(`<span class="tag ${entry.autoFill ? 'success' : ''}">${entry.autoFill ? 'Auto fill on' : 'Auto fill off'}</span>`);
  if (entry.autoLogin) tags.push('<span class="tag warning">Auto login</span>');
  if (entry.totpSecret) tags.push('<span class="tag success">TOTP 2FA</span>');
  if (entry.emailOtpEnabled) tags.push(`<span class="tag warning">Email OTP · ${escapeHtml(entry.emailOtpProvider)}</span>`);
  if (entry.loginUrls.length) tags.push(`<span class="tag">Login URL · ${entry.loginUrls.length}</span>`);
  return tags.join('');
}

function getRenderedEntriesForContext(site, currentUrl) {
  const normalizedSite = normalizeSite(site);
  const useCrossSiteUrlMatches = Boolean(currentUrl) && normalizedSite && normalizedSite === session.hostname;
  const rendered = [];

  Object.entries(session.vault || {}).forEach(([storedSite, rawEntries]) => {
    (rawEntries || []).forEach((rawEntry, sourceIndex) => {
      const entry = normalizeStoredEntry(rawEntry);
      const directMatch = normalizeSite(storedSite) === normalizedSite;
      const urlScore = useCrossSiteUrlMatches ? scoreEntryForContext(storedSite, entry, normalizedSite, currentUrl) : 0;
      if (!directMatch && urlScore < 120) return;
      rendered.push({
        sourceSite: normalizeSite(storedSite),
        sourceIndex,
        directMatch,
        urlScore,
        entry
      });
    });
  });

  rendered.sort((a, b) => {
    if (a.directMatch !== b.directMatch) return a.directMatch ? -1 : 1;
    if (a.urlScore !== b.urlScore) return b.urlScore - a.urlScore;
    return (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0);
  });

  return rendered;
}

async function updateRenderedTotps() {
  const renderedEntries = session.renderedEntries || [];
  const codeNodes = Array.from(entriesEl.querySelectorAll('[data-totp-code]'));

  await Promise.all(codeNodes.map(async (node) => {
    const index = Number(node.dataset.totpCode);
    const rendered = renderedEntries[index];
    const entry = rendered?.entry;
    const remainingNode = entriesEl.querySelector(`[data-totp-remaining="${index}"]`);
    if (!entry?.totpSecret) {
      node.textContent = '------';
      if (remainingNode) remainingNode.textContent = '--s left';
      return;
    }

    try {
      const code = await generateTotpCode(entry.totpSecret, entry.totpDigits || 6, entry.totpPeriod || 30);
      node.textContent = code || '------';
      if (remainingNode) remainingNode.textContent = `${getTotpRemaining(entry.totpPeriod || 30)}s left`;
    } catch {
      node.textContent = 'invalid';
      if (remainingNode) remainingNode.textContent = 'secret error';
    }
  }));
}

function stopTotpTicker() {
  if (session.totpTicker) {
    window.clearInterval(session.totpTicker);
    session.totpTicker = null;
  }
}

function startTotpTicker() {
  stopTotpTicker();
  session.totpTicker = window.setInterval(() => {
    updateRenderedTotps().catch((error) => console.debug('[CentriX Vault] Failed to update TOTP preview:', error));
  }, 1000);
}

async function refreshEntries() {
  const site = normalizeSite(siteInput.value || session.hostname);
  updateSiteLabel();
  renderSavedSiteChips(site);
  session.renderedEntries = getRenderedEntriesForContext(site, session.currentUrl);
  entriesEl.innerHTML = '';

  if (!session.renderedEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = site
      ? `No saved credentials for ${site}. Pick another saved site above or save a new one below.`
      : 'No saved credentials yet.';
    entriesEl.appendChild(empty);
    return;
  }

  session.renderedEntries.forEach((rendered, index) => {
    const { entry } = rendered;
    const box = document.createElement('div');
    box.className = 'entry';

    const totpLine = entry.totpSecret
      ? `
        <div class="totp-line">
          <span class="totp-code" data-totp-code="${index}">------</span>
          <span class="tag warning" data-totp-remaining="${index}">--s left</span>
        </div>`
      : '';

    const sourceSiteLabel = rendered.directMatch
      ? `Stored for ${escapeHtml(site)}`
      : `Stored under ${escapeHtml(rendered.sourceSite)} · matched by login URL`;

    const loginUrlLine = entry.loginUrls.length
      ? `<div class="sub entry-match">Login URL: ${escapeHtml(entry.loginUrls[0])}${entry.loginUrls.length > 1 ? ` <span class="muted">(+${entry.loginUrls.length - 1} more)</span>` : ''}</div>`
      : '';

    box.innerHTML = `
      <div class="title">${escapeHtml(entry.username || '(no username)')}</div>
      <div class="sub">${sourceSiteLabel}</div>
      ${loginUrlLine}
      <div class="entry-tags">${buildEntryTags(entry)}</div>
      ${totpLine}
      <div class="actions">
        <button data-index="${index}" data-action="fill">Autofill</button>
        ${entry.totpSecret ? `<button data-index="${index}" data-action="copyTotp" class="secondary">Copy 2FA</button>` : ''}
        ${entry.emailOtpEnabled ? `<button data-index="${index}" data-action="fetchOtp" class="secondary">Fetch email OTP</button>` : ''}
        <button data-index="${index}" data-action="show" class="secondary">Edit</button>
        <button data-index="${index}" data-action="toggleAuto" class="secondary">${entry.autoFill ? 'Disable auto' : 'Enable auto'}</button>
        <button data-index="${index}" data-action="delete" class="secondary danger">Delete</button>
      </div>
    `;
    entriesEl.appendChild(box);
  });

  await updateRenderedTotps();
}

async function initialize() {
  await resolveInitialContext();
  const meta = await loadMeta();
  session.meta = meta;
  if (meta) {
    unlockView.classList.remove('hidden');
  } else {
    setupView.classList.remove('hidden');
  }
}

async function setupMasterPassword() {
  const master = document.getElementById('setupMaster').value;
  const confirm = document.getElementById('setupMasterConfirm').value;
  if (!master || master.length < 8) return setStatus('Use at least 8 characters.', true);
  if (master !== confirm) return setStatus('Passwords do not match.', true);

  const salt = randomB64(16);
  const key = await deriveKey(master, salt);
  const verifier = await encryptJson(key, { ok: true, createdAt: Date.now() });
  const meta = { salt, verifier, allowDeviceAutoUnlock: false };
  await saveMeta(meta);
  await saveEncryptedVault(await encryptJson(key, {}));

  session.key = key;
  session.vault = {};
  session.meta = meta;
  setupView.classList.add('hidden');
  vaultView.classList.remove('hidden');
  await refreshEntries();
  startTotpTicker();
  setStatus('Vault created.');
}

async function unlockVault() {
  const master = document.getElementById('unlockMaster').value;
  const meta = await loadMeta();
  if (!meta) return setStatus('Vault is not initialized.', true);

  try {
    const key = await deriveKey(master, meta.salt);
    await decryptJson(key, meta.verifier);
    const blob = await loadEncryptedVault();
    const vault = blob ? await decryptJson(key, blob) : {};
    session.key = key;
    session.vault = vault;
    session.meta = meta;
    unlockView.classList.add('hidden');
    vaultView.classList.remove('hidden');
    await refreshEntries();
    startTotpTicker();
    setStatus(meta.allowDeviceAutoUnlock ? 'Vault unlocked. Device auto-unlock is enabled.' : 'Vault unlocked.');
  } catch (error) {
    console.error(error);
    setStatus('Wrong master password.', true);
  }
}

function lockVault() {
  stopTotpTicker();
  session.key = null;
  session.vault = {};
  session.renderedEntries = [];
  session.editingRef = null;
  session.editReturnSite = null;
  vaultView.classList.add('hidden');
  unlockView.classList.remove('hidden');
  document.getElementById('unlockMaster').value = '';
  resetCredentialForm({ keepSite: false });
  setStatus('Locked.');
}

async function enableHandsFreeOnThisBrowser() {
  if (!session.key) return setStatus('Unlock first.', true);
  session.meta = {
    ...(session.meta || {}),
    allowDeviceAutoUnlock: true,
    autoSecret: session.meta?.autoSecret || randomB64(32),
    autoSalt: session.meta?.autoSalt || randomB64(16)
  };
  await saveMeta(session.meta);
  await persistVault();
  setStatus('Hands-free mode enabled on this browser. Auto entries can now fill password, TOTP, and email OTP helpers without opening the vault page.');
}

async function appendCurrentTabUrl() {
  const normalizedCurrentUrl = normalizeLoginUrlPattern(session.currentUrl);
  if (!normalizedCurrentUrl) return setStatus('No target login URL was detected from the active tab.', true);

  const urls = normalizeLoginUrlList(loginUrlInput.value);
  if (!urls.includes(normalizedCurrentUrl)) {
    urls.push(normalizedCurrentUrl);
  }
  loginUrlInput.value = loginUrlListToText(urls);
  setStatus('Current tab login URL added. This helps OTP and email-OTP pages match correctly.');
}

async function generateTotpFromForm({ copy = false } = {}) {
  const draft = getFormEntryDraft();
  if (!draft.totpSecret) {
    totpPreviewInput.value = '';
    return setStatus('Enter a TOTP secret first.', true);
  }

  try {
    const code = await generateTotpCode(draft.totpSecret, draft.totpDigits, draft.totpPeriod);
    totpPreviewInput.value = code || '';
    const remaining = getTotpRemaining(draft.totpPeriod);
    if (copy && code) {
      const copied = await copyText(code);
      setStatus(copied ? `2FA code copied. ${remaining}s left.` : `2FA code ready. ${remaining}s left.`);
      return;
    }
    setStatus(`2FA code generated. ${remaining}s left.`);
  } catch (error) {
    console.error(error);
    totpPreviewInput.value = '';
    setStatus('Could not generate TOTP from this secret.', true);
  }
}

async function fetchEmailOtpFromForm() {
  const draft = getFormEntryDraft();
  if (!draft.emailOtpEnabled) return setStatus('Enable email OTP helper first.', true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_EMAIL_OTP',
      config: {
        provider: draft.emailOtpProvider,
        regex: draft.emailOtpRegex,
        senderHint: draft.emailOtpSender,
        subjectHint: draft.emailOtpSubject
      }
    });

    if (!response?.ok || !response.code) {
      emailOtpPreviewInput.value = '';
      return setStatus(response?.error || 'Could not fetch email OTP.', true);
    }

    emailOtpPreviewInput.value = response.code;
    setStatus(`Email OTP fetched from ${draft.emailOtpProvider}.`);
  } catch (error) {
    console.error(error);
    setStatus('Could not fetch email OTP.', true);
  }
}

async function performAutofill(entry) {
  if (session.tabId == null) return setStatus('No target website tab was provided.', true);

  try {
    const response = await chrome.tabs.sendMessage(session.tabId, {
      type: 'AUTOFILL_CREDENTIAL',
      payload: normalizeStoredEntry(entry)
    });

    if (!response?.ok) {
      return setStatus(response?.error || 'Could not access the target page.', true);
    }

    const messages = [];
    if (response.filledCredentials) messages.push('username/password filled');
    if (response.filledOtp) messages.push(response.otpSource === 'totp' ? '2FA filled from TOTP' : 'OTP filled from email');
    if (response.submitted) messages.push('submit triggered');

    if (!messages.length) {
      return setStatus('Fields not found on the target page.', true);
    }

    setStatus(`Autofill complete: ${messages.join(', ')}.`);
  } catch (error) {
    console.error(error);
    setStatus('Could not access the target page.', true);
  }
}

async function saveCredential() {
  if (!session.key) return setStatus('Unlock first.', true);

  const site = normalizeSite(siteInput.value);
  const draft = getFormEntryDraft();
  if (!site) return setStatus('Site is required.', true);
  if (!draft.password && !draft.totpSecret && !draft.emailOtpEnabled) {
    return setStatus('Add at least a password, a TOTP secret, or email OTP helper settings.', true);
  }

  const sourceRef = session.editingRef ? { ...session.editingRef } : null;
  const wasEditing = Boolean(sourceRef);
  const siteChangedDuringEdit = Boolean(sourceRef && sourceRef.sourceSite !== site);
  const nextEntry = { ...draft, updatedAt: Date.now() };
  let saveMode = wasEditing ? 'updated' : 'created';

  if (sourceRef) {
    const { sourceSite, sourceIndex } = sourceRef;
    const existingList = session.vault[sourceSite] || [];

    if (existingList[sourceIndex]) {
      if (sourceSite === site) {
        existingList[sourceIndex] = nextEntry;
      } else {
        session.vault[site] = session.vault[site] || [];
        const existingTargetIndex = findMatchingEntryIndex(session.vault[site], nextEntry);
        if (existingTargetIndex >= 0) {
          session.vault[site][existingTargetIndex] = nextEntry;
          saveMode = 'copiedExistingUpdated';
        } else {
          session.vault[site].push(nextEntry);
          saveMode = 'copiedToNewSite';
        }
      }
    } else {
      session.vault[site] = session.vault[site] || [];
      const fallbackIndex = findMatchingEntryIndex(session.vault[site], nextEntry);
      if (fallbackIndex >= 0) {
        session.vault[site][fallbackIndex] = nextEntry;
        saveMode = 'updated';
      } else {
        session.vault[site].push(nextEntry);
        saveMode = 'created';
      }
    }
  } else {
    session.vault[site] = session.vault[site] || [];
    const existingIndex = findMatchingEntryIndex(session.vault[site], nextEntry);
    if (existingIndex >= 0) {
      session.vault[site][existingIndex] = nextEntry;
      saveMode = 'updatedDuplicate';
    } else {
      session.vault[site].push(nextEntry);
    }
  }

  if (draft.autoFill && !session.meta?.allowDeviceAutoUnlock) {
    await enableHandsFreeOnThisBrowser();
  }

  await persistVault();
  if (siteChangedDuringEdit) {
    session.editReturnSite = site;
  }
  restoreEditReturnSite();
  resetCredentialForm();
  await refreshEntries();
  const extras = [
    draft.totpSecret ? 'TOTP ready' : null,
    draft.emailOtpEnabled ? 'email OTP helper ready' : null,
    draft.loginUrls.length ? 'login URL matched' : null
  ].filter(Boolean).join(' · ');

  let message = 'Credential saved.';
  if (saveMode === 'updated' || saveMode === 'updatedDuplicate') {
    message = 'Entry updated.';
  } else if (saveMode === 'copiedToNewSite' || saveMode === 'copiedExistingUpdated') {
    message = `Entry copied to ${site}. Original under ${sourceRef.sourceSite} was kept.`;
  }

  setStatus(message + (extras ? ` ${extras}.` : ''));
}

async function cancelEdit() {
  restoreEditReturnSite();
  resetCredentialForm();
  await refreshEntries();
  setStatus('Edit cancelled.');
}

async function clearCurrentSite() {
  if (!session.key) return setStatus('Unlock first.', true);
  const site = normalizeSite(siteInput.value);
  if (!site) return setStatus('No site selected.', true);
  delete session.vault[site];
  if (session.editingRef?.sourceSite === site) {
    restoreEditReturnSite();
    resetCredentialForm();
  }
  await persistVault();
  await refreshEntries();
  setStatus('Selected site entries cleared.');
}

async function handleEntryAction(evt) {
  const btn = evt.target.closest('button[data-action]');
  if (!btn) return;
  const index = Number(btn.dataset.index);
  const action = btn.dataset.action;
  const rendered = session.renderedEntries[index];
  if (!rendered) return;

  const { sourceSite, sourceIndex } = rendered;
  const liveEntry = session.vault[sourceSite]?.[sourceIndex];
  if (!liveEntry) return;
  const entry = normalizeStoredEntry(liveEntry);

  if (action === 'show') {
    if (session.editReturnSite == null) {
      session.editReturnSite = siteInput.value || session.hostname || sourceSite;
    }
    siteInput.value = sourceSite;
    populateForm(entry);
    setCredentialEditState({ sourceSite, sourceIndex });
    await refreshEntries();
    setStatus(`Loaded entry from ${sourceSite}. Update the fields, then click Update entry.`);
    return;
  }

  if (action === 'toggleAuto') {
    liveEntry.autoFill = !liveEntry.autoFill;
    if (!liveEntry.autoFill) liveEntry.autoLogin = false;
    if (liveEntry.autoFill && !session.meta?.allowDeviceAutoUnlock) {
      await enableHandsFreeOnThisBrowser();
    }
    await persistVault();
    await refreshEntries();
    setStatus(liveEntry.autoFill ? 'Auto fill enabled for this account.' : 'Auto fill disabled for this account.');
    return;
  }

  if (action === 'delete') {
    session.vault[sourceSite].splice(sourceIndex, 1);
    if (!session.vault[sourceSite].length) delete session.vault[sourceSite];
    if (session.editingRef?.sourceSite === sourceSite && session.editingRef?.sourceIndex === sourceIndex) {
      restoreEditReturnSite();
      resetCredentialForm();
    }
    await persistVault();
    await refreshEntries();
    setStatus('Entry deleted.');
    return;
  }

  if (action === 'copyTotp') {
    if (!entry.totpSecret) return setStatus('This entry has no TOTP secret.', true);
    try {
      const code = await generateTotpCode(entry.totpSecret, entry.totpDigits, entry.totpPeriod);
      if (!code) return setStatus('Could not generate TOTP.', true);
      totpPreviewInput.value = code;
      const copied = await copyText(code);
      setStatus(copied ? `2FA code copied. ${getTotpRemaining(entry.totpPeriod)}s left.` : '2FA code generated.');
    } catch (error) {
      console.error(error);
      setStatus('Could not generate TOTP.', true);
    }
    return;
  }

  if (action === 'fetchOtp') {
    populateForm(entry);
    await fetchEmailOtpFromForm();
    return;
  }

  if (action === 'fill') {
    await performAutofill(entry);
  }
}

document.getElementById('setupBtn').addEventListener('click', setupMasterPassword);
document.getElementById('unlockBtn').addEventListener('click', unlockVault);
saveBtn.addEventListener('click', saveCredential);
document.getElementById('lockBtn').addEventListener('click', lockVault);
document.getElementById('clearSiteBtn').addEventListener('click', clearCurrentSite);
document.getElementById('generateTotpBtn').addEventListener('click', () => generateTotpFromForm());
document.getElementById('copyTotpBtn').addEventListener('click', () => generateTotpFromForm({ copy: true }));
document.getElementById('fetchEmailOtpBtn').addEventListener('click', fetchEmailOtpFromForm);
useCurrentUrlBtn.addEventListener('click', appendCurrentTabUrl);
cancelEditBtn.addEventListener('click', cancelEdit);
savedSitesBar.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-browse-site]');
  if (!button) return;
  siteInput.value = button.dataset.browseSite || '';
  refreshEntries().catch((error) => {
    console.error(error);
    setStatus('Could not switch saved site.', true);
  });
});
entriesEl.addEventListener('click', handleEntryAction);
siteInput.addEventListener('input', () => {
  if (!session.editingRef) {
    loginUrlInput.placeholder = session.currentUrl ? normalizeLoginUrlPattern(session.currentUrl) : 'https://auth.openai.com/mfa-challenge/';
  }
  refreshEntries().catch((error) => {
    console.error(error);
    setStatus('Could not refresh entries.', true);
  });
});

[totpSecretInput, totpDigitsInput, totpPeriodInput].forEach((input) => {
  input.addEventListener('input', () => {
    totpPreviewInput.value = '';
  });
});

[loginUrlInput, emailOtpProviderInput, emailOtpRegexInput, emailOtpSenderInput, emailOtpSubjectInput, emailOtpEnabledInput].forEach((input) => {
  input.addEventListener('input', () => {
    emailOtpPreviewInput.value = '';
  });
  input.addEventListener('change', () => {
    emailOtpPreviewInput.value = '';
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (!setupView.classList.contains('hidden')) {
    setupMasterPassword();
  } else if (!unlockView.classList.contains('hidden')) {
    unlockVault();
  }
});

window.addEventListener('beforeunload', stopTotpTicker);

initialize().catch((error) => {
  console.error(error);
  setStatus('Initialization failed.', true);
});
