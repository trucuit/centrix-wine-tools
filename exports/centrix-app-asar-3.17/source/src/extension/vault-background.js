(() => {
  const te = new TextEncoder();
  const td = new TextDecoder();

  const MAIL_PROVIDER_MATCHERS = {
    gmail: [
      /^https?:\/\/mail\.google\.com\//i
    ],
    outlook: [
      /^https?:\/\/outlook\.live\.com\//i,
      /^https?:\/\/outlook\.office\.com\//i,
      /^https?:\/\/outlook\.office365\.com\//i,
      /^https?:\/\/mail\.office365\.com\//i
    ],
    generic: [
      /^https?:\/\/mail\.google\.com\//i,
      /^https?:\/\/outlook\.live\.com\//i,
      /^https?:\/\/outlook\.office\.com\//i,
      /^https?:\/\/outlook\.office365\.com\//i,
      /^https?:\/\/mail\.office365\.com\//i,
      /^https?:\/\/mail\.yahoo\.com\//i,
      /^https?:\/\/mail\.proton\.(?:me|mail)\//i,
      /^https?:\/\/mail\.icloud\.com\//i,
      /^https?:\/\/[^/]*webmail[^/]*\//i
    ]
  };

  function b64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function deriveVaultKey(secret, saltB64, extractable = false) {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      te.encode(secret),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: b64ToBytes(saltB64),
        iterations: 250000,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt']
    );
  }

  async function decryptVaultJson(key, encrypted) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(encrypted.iv) },
      key,
      b64ToBytes(encrypted.cipher)
    );
    return JSON.parse(td.decode(plain));
  }

  function normalizeVaultSite(input) {
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
      // Ignore and fall through.
    }

    return raw.toLowerCase().split('#')[0].split('?')[0].trim();
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

  function normalizeEntryForMatching(entry = {}) {
    return {
      autoFill: Boolean(entry.autoFill),
      autoLogin: Boolean(entry.autoLogin),
      loginUrls: normalizeLoginUrlList(entry.loginUrls || entry.loginUrl || ''),
      updatedAt: Number(entry.updatedAt || 0)
    };
  }

  function scoreLoginUrlPattern(pattern, currentUrl, currentSite) {
    const normalizedPattern = normalizeLoginUrlPattern(pattern);
    const url = String(currentUrl || '').toLowerCase();
    const site = normalizeVaultSite(currentSite || currentUrl || '');
    if (!normalizedPattern) return 0;

    if (/^https?:\/\//i.test(normalizedPattern)) {
      if (url.startsWith(normalizedPattern)) {
        return 160 + Math.min(30, normalizedPattern.length);
      }

      const patternSite = normalizeVaultSite(normalizedPattern);
      if (patternSite && patternSite === site) {
        return 110;
      }
    }

    const patternSite = normalizeVaultSite(normalizedPattern);
    if (patternSite && patternSite === site) {
      return 105;
    }

    if (url && normalizedPattern.length >= 8 && url.includes(normalizedPattern)) {
      return 130 + Math.min(20, normalizedPattern.length);
    }

    return 0;
  }

  async function getAutoVaultState() {
    const data = await chrome.storage.local.get(['auto_vault_blob', 'auto_secret', 'auto_salt']);
    if (!data.auto_vault_blob || !data.auto_secret || !data.auto_salt) return null;

    try {
      const key = await deriveVaultKey(data.auto_secret, data.auto_salt);
      return await decryptVaultJson(key, data.auto_vault_blob);
    } catch (error) {
      console.error('[CentriX Vault] Failed to decrypt auto vault:', error);
      return null;
    }
  }

  async function getBestCredentialForTarget(site, url) {
    const vault = await getAutoVaultState();
    if (!vault) return null;

    const targetSite = normalizeVaultSite(site || url || '');
    const targetUrl = String(url || '').toLowerCase();

    let best = null;
    for (const [storedSite, entries] of Object.entries(vault)) {
      for (const rawEntry of entries || []) {
        const matchingEntry = normalizeEntryForMatching(rawEntry);
        if (!matchingEntry.autoFill) continue;

        let score = normalizeVaultSite(storedSite) === targetSite ? 90 : 0;
        const loginUrlScore = matchingEntry.loginUrls.reduce((highest, pattern) => {
          return Math.max(highest, scoreLoginUrlPattern(pattern, targetUrl, targetSite));
        }, 0);
        score = Math.max(score, loginUrlScore);
        if (!score) continue;

        const candidate = {
          entry: rawEntry,
          score,
          updatedAt: matchingEntry.updatedAt
        };

        if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.updatedAt > best.updatedAt)) {
          best = candidate;
        }
      }
    }

    return best?.entry || null;
  }

  function getMailMatchers(provider) {
    return MAIL_PROVIDER_MATCHERS[provider] || MAIL_PROVIDER_MATCHERS.generic;
  }

  function isMailTabUrl(url, provider = 'generic') {
    if (!url) return false;
    return getMailMatchers(provider).some((matcher) => matcher.test(url));
  }

  function getProviderPriority(url, provider) {
    if (!url) return -1;
    if (provider === 'gmail' && /mail\.google\.com/i.test(url)) return 30;
    if (provider === 'outlook' && /(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.office365\.com)/i.test(url)) return 30;
    if (/mail\.google\.com/i.test(url)) return 20;
    if (/(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.office365\.com)/i.test(url)) return 18;
    if (/(mail\.yahoo\.com|mail\.proton\.(?:me|mail)|mail\.icloud\.com|webmail)/i.test(url)) return 14;
    return 5;
  }

  async function requestOtpFromTab(tabId, config) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'FETCH_EMAIL_OTP_FROM_PAGE',
        config
      });
      if (response?.ok && response.code) {
        return {
          ok: true,
          code: response.code,
          sourceSelector: response.sourceSelector || null,
          matchedWith: response.matchedWith || null
        };
      }
    } catch (error) {
      console.debug('[CentriX Vault] Failed to inspect mail tab for OTP:', tabId, error?.message || error);
    }
    return null;
  }

  async function fetchEmailOtpFromMailTabs(config = {}) {
    const provider = String(config.provider || 'generic').toLowerCase();
    const allTabs = await chrome.tabs.query({});
    const candidateTabs = allTabs
      .filter((tab) => tab.id != null && isMailTabUrl(tab.url, provider))
      .sort((a, b) => {
        const scoreA = (a.active ? 50 : 0) + getProviderPriority(a.url, provider);
        const scoreB = (b.active ? 50 : 0) + getProviderPriority(b.url, provider);
        return scoreB - scoreA;
      });

    for (const tab of candidateTabs) {
      const result = await requestOtpFromTab(tab.id, config);
      if (result?.code) {
        return {
          ok: true,
          code: result.code,
          sourceTabId: tab.id,
          sourceUrl: tab.url,
          provider,
          sourceSelector: result.sourceSelector || null,
          matchedWith: result.matchedWith || null
        };
      }
    }

    const providerLabel = provider === 'generic' ? 'mail tab' : `${provider} tab`;
    return {
      ok: false,
      error: `No OTP code found in any open ${providerLabel}. Open the latest verification email first.`
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GET_AUTOFILL_FOR_SITE') {
      const site = normalizeVaultSite(message.site || '');
      const url = String(message.url || '');
      getBestCredentialForTarget(site, url)
        .then((entry) => sendResponse({ ok: true, entry: entry || null }))
        .catch((error) => {
          console.error('[CentriX Vault] GET_AUTOFILL_FOR_SITE failed:', error);
          sendResponse({ ok: false, entry: null, error: error.message });
        });
      return true;
    }

    if (message?.type === 'SAVE_AUTO_STATE') {
      chrome.storage.local.set({
        auto_secret: message.autoSecret,
        auto_salt: message.autoSalt,
        auto_vault_blob: message.autoVaultBlob
      }).then(() => {
        sendResponse({ ok: true });
      }).catch((error) => {
        console.error('[CentriX Vault] SAVE_AUTO_STATE failed:', error);
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }

    if (message?.type === 'CLEAR_AUTO_STATE') {
      chrome.storage.local.remove(['auto_secret', 'auto_salt', 'auto_vault_blob']).then(() => {
        sendResponse({ ok: true });
      }).catch((error) => {
        console.error('[CentriX Vault] CLEAR_AUTO_STATE failed:', error);
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }

    if (message?.type === 'FETCH_EMAIL_OTP') {
      fetchEmailOtpFromMailTabs(message.config || {})
        .then((result) => sendResponse(result))
        .catch((error) => {
          console.error('[CentriX Vault] FETCH_EMAIL_OTP failed:', error);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }
  });
})();
