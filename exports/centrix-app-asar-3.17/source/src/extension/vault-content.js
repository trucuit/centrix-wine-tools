const vaultTotpEncoder = new TextEncoder();

function vaultIsVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style && style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}

function getAssociatedFieldText(el) {
  if (!el) return '';

  const bits = [];
  const pushText = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text) bits.push(text);
  };

  if (el.id && window.CSS?.escape) {
    document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`).forEach((label) => pushText(label.innerText || label.textContent));
  }

  const wrappingLabel = el.closest('label');
  if (wrappingLabel) pushText(wrappingLabel.innerText || wrappingLabel.textContent);

  const labelledBy = String(el.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  labelledBy.forEach((id) => {
    const node = document.getElementById(id);
    if (node) pushText(node.innerText || node.textContent);
  });

  const nearbyText = [
    el.previousElementSibling,
    el.parentElement?.previousElementSibling,
    el.closest('div, section, form, article')?.querySelector?.('label, legend, [class*="label" i], [class*="title" i]')
  ];
  nearbyText.forEach((node) => {
    if (node && node !== el) pushText(node.innerText || node.textContent);
  });

  return bits.join(' ');
}

function fieldHints(el) {
  return [
    el?.name,
    el?.id,
    el?.type,
    el?.placeholder,
    el?.autocomplete,
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('data-testid'),
    el?.getAttribute?.('inputmode'),
    getAssociatedFieldText(el)
  ].filter(Boolean).join(' ').toLowerCase();
}

function isOtpLikeField(el) {
  const hints = fieldHints(el);
  return /one-time-code|otp|totp|2fa|two-factor|verification|security code|auth(?:entication)? code|passcode|pin|token|code/i.test(hints);
}

function isUsernameLikeField(el) {
  const hints = fieldHints(el);
  return !isOtpLikeField(el) && /username|email|login|user|account|identifier|phone|mobile/i.test(hints);
}

function isPasswordField(el) {
  return String(el?.type || '').toLowerCase() === 'password';
}

function firstVisible(selectors, filterFn = null) {
  for (const selector of selectors) {
    const list = Array.from(document.querySelectorAll(selector)).filter(vaultIsVisible);
    for (const item of list) {
      if (!filterFn || filterFn(item)) return item;
    }
  }
  return null;
}

function getVisibleInputs(selector) {
  return Array.from(document.querySelectorAll(selector)).filter(vaultIsVisible);
}

function locatePasswordField() {
  return firstVisible([
    'input[autocomplete="current-password"]',
    'input[autocomplete="new-password"]',
    'input[type="password"]'
  ]);
}

function locateUsernameField(passwordField) {
  const explicit = firstVisible([
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="login" i]',
    'input[name*="email" i]',
    'input[name*="account" i]',
    'input[id*="user" i]',
    'input[id*="login" i]',
    'input[id*="email" i]',
    'input[id*="account" i]'
  ], (el) => !isOtpLikeField(el) && !isPasswordField(el));
  if (explicit) return explicit;

  const scopedRoots = [];
  if (passwordField?.form) scopedRoots.push(passwordField.form);
  const passwordContainer = passwordField?.closest?.('form, [role="dialog"], section, article, main, div');
  if (passwordContainer) scopedRoots.push(passwordContainer);

  for (const root of scopedRoots) {
    const fallback = Array.from(root.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type])'))
      .filter(vaultIsVisible)
      .find((el) => !isOtpLikeField(el) && !isPasswordField(el));
    if (fallback) return fallback;
  }

  return null;
}

function sortElementsByDomPosition(elements) {
  return [...elements].sort((a, b) => {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

function isLikelyOtpPage() {
  const pageText = String(document.body?.innerText || document.body?.textContent || '').toLowerCase();
  return /verify your identity|one-time code|verification code|security code|authentication code|two-factor|2fa|mfa|passcode|otp/.test(pageText);
}

function locateOtpFieldGroup() {
  const explicit = sortElementsByDomPosition(getVisibleInputs('input[autocomplete="one-time-code"], textarea[autocomplete="one-time-code"]'));
  if (explicit.length) {
    return { type: 'single', fields: [explicit[0]] };
  }

  const singleCharInputs = sortElementsByDomPosition(
    getVisibleInputs('input[maxlength="1"], input[size="1"]')
      .filter((el) => {
        const type = String(el.type || 'text').toLowerCase();
        return ['text', 'tel', 'number', 'password', 'search', ''].includes(type) && !el.disabled && !el.readOnly;
      })
  );

  if (singleCharInputs.length >= 4) {
    const groups = new Map();
    for (const input of singleCharInputs) {
      const container = input.closest('[role="group"], [class*="otp" i], [class*="code" i], [id*="otp" i], [id*="code" i], form, section, article, div') || input.parentElement || document.body;
      const key = container;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(input);
    }

    const bestGroup = [...groups.values()]
      .map((group) => sortElementsByDomPosition(group))
      .find((group) => group.length >= 4);

    if (bestGroup) {
      return { type: 'group', fields: bestGroup.slice(0, 8) };
    }
  }

  const singleField = firstVisible([
    'input[name*="otp" i]',
    'input[name*="totp" i]',
    'input[name*="code" i]',
    'input[name*="verification" i]',
    'input[name*="security" i]',
    'input[id*="otp" i]',
    'input[id*="totp" i]',
    'input[id*="code" i]',
    'input[id*="verification" i]',
    'input[id*="security" i]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="number"]',
    'textarea'
  ], (el) => !isPasswordField(el) && isOtpLikeField(el));

  if (singleField) {
    return { type: 'single', fields: [singleField] };
  }

  const textInputs = sortElementsByDomPosition(
    getVisibleInputs('input, textarea').filter((el) => {
      const type = String(el.type || 'text').toLowerCase();
      return ['text', 'tel', 'number', 'search', 'password', ''].includes(type) && !el.disabled && !el.readOnly && !isPasswordField(el);
    })
  );

  if (textInputs.length === 1 && isLikelyOtpPage()) {
    return { type: 'single', fields: [textInputs[0]] };
  }

  return null;
}

function getValueDescriptor(field) {
  return Object.getOwnPropertyDescriptor(field?.constructor?.prototype || {}, 'value')
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
}

function fillNativeVaultValue(field, value) {
  const descriptor = getValueDescriptor(field);
  const setter = descriptor?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
}

function fieldMatchesValue(field, value) {
  return String(field?.value ?? '') === String(value ?? '');
}

function fillVaultField(field, value) {
  if (!field) return;
  field.focus();
  fillNativeVaultValue(field, value);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value).slice(-1), inputType: 'insertText' }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
  field.blur();
}

function fillOtpFields(target, code) {
  if (!target || !code) return false;
  const cleanCode = String(code).trim();
  if (!cleanCode) return false;

  if (target.type === 'group' && target.fields.length > 1) {
    const chars = cleanCode.split('');
    target.fields.forEach((field, index) => {
      fillVaultField(field, chars[index] || '');
    });
    return true;
  }

  fillVaultField(target.fields[0], cleanCode);
  return true;
}

function otpTargetMatchesCode(target, code) {
  if (!target || !code) return false;
  const cleanCode = String(code).trim();
  if (!cleanCode) return false;

  if (target.type === 'group' && target.fields.length > 1) {
    return target.fields.every((field, index) => fieldMatchesValue(field, cleanCode[index] || ''));
  }

  return fieldMatchesValue(target.fields[0], cleanCode);
}

function locateVaultFields() {
  const passwordField = locatePasswordField();
  const usernameField = locateUsernameField(passwordField);
  const otpTarget = locateOtpFieldGroup();
  return { usernameField, passwordField, otpTarget };
}

function getFieldIdentity(field) {
  if (!field) return '';
  return [
    field.tagName,
    field.type,
    field.name,
    field.id,
    field.autocomplete,
    field.placeholder,
    field.getAttribute?.('aria-label')
  ].filter(Boolean).join('|');
}

function getOtpTargetIdentity(target) {
  if (!target?.fields?.length) return '';
  return `${target.type}:${target.fields.map((field) => getFieldIdentity(field)).join(',')}`;
}

function getVaultStepSignature(fields) {
  return [
    getFieldIdentity(fields.usernameField),
    getFieldIdentity(fields.passwordField),
    getOtpTargetIdentity(fields.otpTarget)
  ].filter(Boolean).join('::');
}

function findVaultLoginForm(fields) {
  if (fields.passwordField?.form) return fields.passwordField.form;
  if (fields.usernameField?.form) return fields.usernameField.form;
  if (fields.otpTarget?.fields?.[0]?.form) return fields.otpTarget.fields[0].form;
  return fields.passwordField?.closest?.('form')
    || fields.usernameField?.closest?.('form')
    || fields.otpTarget?.fields?.[0]?.closest?.('form')
    || firstVisible(['form'])
    || null;
}

function getActionHints(el) {
  return [
    el?.type,
    el?.name,
    el?.id,
    el?.value,
    el?.title,
    el?.className,
    el?.getAttribute?.('aria-label'),
    el?.innerText,
    el?.textContent
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function scoreVaultSubmitButton(button, form) {
  if (!button || !vaultIsVisible(button) || button.disabled) return -Infinity;

  const hints = getActionHints(button);
  const inForm = Boolean(form && button.closest('form') === form);
  const type = String(button.type || '').toLowerCase();
  let score = 0;

  if (type === 'submit') score += 120;
  if (inForm) score += 20;
  if (button === document.activeElement) score += 5;

  if (/(?:^|\s)(?:login|log in|sign in|submit|verify|verification|continue|next|proceed|confirm|approve|accept|finish|complete|unlock|authorize|enter|tiếp tục|tiep tuc|tiếp theo|tiep theo|xác nhận|xac nhan|đăng nhập|dang nhap|continuar|continu[eé]r|suivant|weiter|fortfahren|avanti|continua|segui|prossimo|siguiente|entrar|acceder|iniciar sesión|iniciar sesion|próximo|proximo|dalej|продолжить|войти|계속|계속하기|다음|続行|次へ|确认|確認|继续|繼續)(?:\s|$)/i.test(hints)) {
    score += 80;
  }

  if (/(?:primary|submit|continue|verify|login|signin|next|confirm)/i.test(hints)) {
    score += 20;
  }

  if (/(?:cancel|back|previous|skip|close|resend|change|switch|different|forgot|help|support|return|quay lại|quay lai|trở lại|tro lai|gửi lại|gui lai|hủy|huy)/i.test(hints)) {
    score -= 120;
  }

  return score;
}

function locateVaultSubmitButton(form, field) {
  const roots = [];
  if (form) roots.push(form);

  const fieldRoot = field?.closest?.('form, [role="dialog"], section, article, main, div');
  if (fieldRoot && !roots.includes(fieldRoot)) roots.push(fieldRoot);
  roots.push(document);

  const selector = 'button, input[type="submit"], input[type="button"], [role="button"]';

  for (const root of roots) {
    const candidates = Array.from(root.querySelectorAll(selector))
      .filter((button) => vaultIsVisible(button) && !button.disabled);

    if (!candidates.length) continue;

    const ranked = candidates
      .map((button) => ({ button, score: scoreVaultSubmitButton(button, form) }))
      .sort((a, b) => b.score - a.score);

    if (ranked[0]?.score > 0) return ranked[0].button;
    if (root !== document && candidates.length === 1) return candidates[0];
  }

  return null;
}

let lastVaultSubmitSignature = '';
let lastVaultSubmitAt = 0;

function submitVaultLogin(form, field) {
  const submitButton = locateVaultSubmitButton(form, field);

  if (submitButton && !submitButton.disabled) {
    submitButton.click();
    return true;
  }

  if (form && typeof form.requestSubmit === 'function') {
    form.requestSubmit();
    return true;
  }

  if (form && typeof form.submit === 'function') {
    form.submit();
    return true;
  }

  if (field) {
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    field.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'Enter' }));
    field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
    return true;
  }

  return false;
}

function normalizeBase32Secret(secret) {
  return String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function base32ToBytes(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = normalizeBase32Secret(secret);
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

function safeRegex(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'im');
  } catch (error) {
    console.warn('[CentriX Vault] Invalid OTP regex:', error);
    return null;
  }
}

function normalizeEmailText(text) {
  return String(text || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function collectEmailSections() {
  const selectors = [
    'div.a3s.aiL',
    '[data-message-id] .a3s',
    '[data-message-id]',
    '[role="document"]',
    '[aria-label*="Message body" i]',
    '.ReadingPaneContainer [role="document"]',
    '.ReadingPaneContainer',
    'article',
    'main'
  ];

  const sections = [];
  const seen = new Set();

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector)).filter(vaultIsVisible);
    for (const element of elements) {
      const text = normalizeEmailText(element.innerText || element.textContent);
      if (!text || text.length < 24) continue;
      const key = text.slice(0, 500);
      if (seen.has(key)) continue;
      seen.add(key);
      sections.push({ selector, text });
    }
  }

  const bodyText = normalizeEmailText(document.body?.innerText || document.body?.textContent);
  if (bodyText) {
    const key = bodyText.slice(0, 500);
    if (!seen.has(key)) {
      sections.push({ selector: 'body', text: bodyText });
    }
  }

  return sections.slice(0, 12);
}

function scoreEmailSection(section, config) {
  const text = section.text.toLowerCase();
  let score = section.selector === 'body' ? 0 : 5;

  if (config.senderHint && text.includes(String(config.senderHint).toLowerCase())) score += 8;
  if (config.subjectHint && text.includes(String(config.subjectHint).toLowerCase())) score += 8;
  if (/otp|verification|security code|passcode|one-time|two-factor|2fa|authentication code|login code/i.test(section.text)) score += 6;
  if (/\b\d{6}\b/.test(section.text)) score += 4;

  return score;
}

function extractOtpFromText(text, config = {}) {
  const compiled = safeRegex(config.regex);
  if (compiled) {
    const match = compiled.exec(text);
    if (match) {
      return (match[1] || match[0] || '').trim();
    }
  }

  const patterns = [
    /(?:verification|security|login|auth(?:entication)?|otp|passcode|one-time|2fa)[^\dA-Z]{0,25}([A-Z0-9]{4,10})/i,
    /\b([0-9]{6})\b/,
    /\b([0-9]{4,8})\b/
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return (match[1] || match[0] || '').trim();
  }

  return null;
}

function fetchEmailOtpFromPage(config = {}) {
  const sections = collectEmailSections()
    .map((section) => ({ ...section, score: scoreEmailSection(section, config) }))
    .sort((a, b) => b.score - a.score);

  for (const section of sections) {
    const code = extractOtpFromText(section.text, config);
    if (code) {
      return {
        ok: true,
        code,
        sourceSelector: section.selector,
        matchedWith: config.regex || 'default-pattern'
      };
    }
  }

  return {
    ok: false,
    error: 'No OTP code was found on this mail page.'
  };
}

async function resolveOtpCode(payload) {
  if (payload.totpSecret) {
    try {
      const digits = Math.min(10, Math.max(4, Number(payload.totpDigits || 6)));
      const period = Math.min(120, Math.max(15, Number(payload.totpPeriod || 30)));
      const code = await generateTotpCode(payload.totpSecret, digits, period);
      if (code) {
        return { code, source: 'totp' };
      }
    } catch (error) {
      console.warn('[CentriX Vault] Failed to generate TOTP:', error);
    }
  }

  if (payload.emailOtpEnabled) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'FETCH_EMAIL_OTP',
        config: {
          provider: payload.emailOtpProvider,
          regex: payload.emailOtpRegex,
          senderHint: payload.emailOtpSender,
          subjectHint: payload.emailOtpSubject
        }
      });
      if (response?.ok && response.code) {
        return { code: response.code, source: 'email', details: response };
      }
    } catch (error) {
      console.warn('[CentriX Vault] Failed to fetch email OTP:', error);
    }
  }

  return { code: null, source: null };
}

async function vaultAutofillCredential(payload) {
  const fields = locateVaultFields();
  const stepSignature = getVaultStepSignature(fields);
  let filledCredentials = false;
  let filledUsername = false;
  let filledPassword = false;
  let filledOtp = false;
  let otpSource = null;

  if (payload.username && fields.usernameField) {
    if (!fieldMatchesValue(fields.usernameField, payload.username)) {
      fillVaultField(fields.usernameField, payload.username);
    }
    filledUsername = true;
    filledCredentials = true;
  }

  if (payload.password && fields.passwordField) {
    if (!fieldMatchesValue(fields.passwordField, payload.password)) {
      fillVaultField(fields.passwordField, payload.password);
    }
    filledPassword = true;
    filledCredentials = true;
  }

  if (fields.otpTarget && (payload.totpSecret || payload.emailOtpEnabled)) {
    const otpResult = await resolveOtpCode(payload);
    if (otpResult.code) {
      filledOtp = otpTargetMatchesCode(fields.otpTarget, otpResult.code) || fillOtpFields(fields.otpTarget, otpResult.code);
      otpSource = otpResult.source;
    }
  }

  const form = findVaultLoginForm(fields);
  let submitted = false;
  const recentlySubmittedSameStep = stepSignature
    && lastVaultSubmitSignature === stepSignature
    && (Date.now() - lastVaultSubmitAt) < 3000;

  if (payload.autoLogin && (filledCredentials || filledOtp) && !recentlySubmittedSameStep) {
    const submitDelayMs = Math.max(0, Number(payload.submitDelayMs || 350));
    const submitField = fields.otpTarget?.fields?.[0] || fields.passwordField || fields.usernameField;
    window.setTimeout(() => {
      submitVaultLogin(form, submitField);
    }, submitDelayMs);
    submitted = true;
    if (stepSignature) {
      lastVaultSubmitSignature = stepSignature;
      lastVaultSubmitAt = Date.now();
    }
  }

  const hasOtpCapability = Boolean(payload.totpSecret || payload.emailOtpEnabled);
  const shouldRetryOtp = hasOtpCapability && !filledOtp;

  return {
    ok: true,
    filled: Boolean(filledCredentials || filledOtp),
    filledCredentials,
    filledUsername,
    filledPassword,
    filledOtp,
    otpSource,
    submitted,
    shouldRetryOtp,
    stepSignature,
    found: {
      username: Boolean(fields.usernameField),
      password: Boolean(fields.passwordField),
      otp: Boolean(fields.otpTarget)
    }
  };
}

let vaultAutofillTimer = null;
let vaultAutofillBusy = false;
let vaultAutofillObserver = null;
let vaultAutofillObserverDebounce = null;

function stopVaultAutoFillWatchers() {
  if (vaultAutofillTimer) {
    window.clearInterval(vaultAutofillTimer);
    vaultAutofillTimer = null;
  }
  if (vaultAutofillObserverDebounce) {
    window.clearTimeout(vaultAutofillObserverDebounce);
    vaultAutofillObserverDebounce = null;
  }
  if (vaultAutofillObserver) {
    vaultAutofillObserver.disconnect();
    vaultAutofillObserver = null;
  }
}

async function runVaultAutoFill() {
  try {
    stopVaultAutoFillWatchers();
    const site = location.hostname.replace(/^www\./, '').toLowerCase();
    const response = await chrome.runtime.sendMessage({ type: 'GET_AUTOFILL_FOR_SITE', site, url: location.href });
    if (!response?.entry?.autoFill) return;

    const entry = response.entry;
    const deadline = Date.now() + 45000;
    const hasOtpCapability = Boolean(entry.totpSecret || entry.emailOtpEnabled);
    const hasPassword = Boolean(entry.password);
    let filledUsernameOnce = false;
    let filledPasswordOnce = false;
    let filledOtpOnce = false;

    const shouldStop = (result) => {
      if (!result?.ok) return false;

      filledUsernameOnce = filledUsernameOnce || result.filledUsername;
      filledPasswordOnce = filledPasswordOnce || result.filledPassword;
      filledOtpOnce = filledOtpOnce || result.filledOtp;

      if (filledOtpOnce) return true;
      if (hasOtpCapability) return false;
      if (hasPassword) return filledPasswordOnce;
      return filledUsernameOnce;
    };

    const attempt = async () => {
      if (vaultAutofillBusy) return false;
      vaultAutofillBusy = true;
      try {
        const result = await vaultAutofillCredential(entry);
        return shouldStop(result);
      } finally {
        vaultAutofillBusy = false;
      }
    };

    if (await attempt()) return;

    const scheduleObserverAttempt = () => {
      if (Date.now() >= deadline) {
        stopVaultAutoFillWatchers();
        return;
      }

      if (vaultAutofillObserverDebounce) {
        window.clearTimeout(vaultAutofillObserverDebounce);
      }

      vaultAutofillObserverDebounce = window.setTimeout(async () => {
        vaultAutofillObserverDebounce = null;
        const done = await attempt();
        if (done || Date.now() >= deadline) {
          stopVaultAutoFillWatchers();
        }
      }, 75);
    };

    vaultAutofillObserver = new MutationObserver(() => {
      scheduleObserverAttempt();
    });
    vaultAutofillObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type', 'name', 'id', 'placeholder', 'autocomplete', 'aria-label', 'class', 'style', 'hidden', 'disabled']
    });

    vaultAutofillTimer = window.setInterval(async () => {
      const done = await attempt();
      if (done || Date.now() >= deadline) {
        stopVaultAutoFillWatchers();
      }
    }, 500);
  } catch (error) {
    console.debug('[CentriX Vault] Auto fill skipped:', error);
    stopVaultAutoFillWatchers();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'FETCH_EMAIL_OTP_FROM_PAGE') {
    sendResponse(fetchEmailOtpFromPage(message.config || {}));
    return true;
  }

  if (message?.type !== 'AUTOFILL_CREDENTIAL') return;

  vaultAutofillCredential(message.payload || {})
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error('[CentriX Vault] AUTOFILL_CREDENTIAL failed:', error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

if (document.contentType?.includes('text/html')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runVaultAutoFill, { once: true });
  } else {
    runVaultAutoFill();
  }
}
