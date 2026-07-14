(() => {
  const STYLE_ID = "centrix-ui-hide-rules";
  const CACHE_STYLE_ID = "centrix-ui-cache-style";
  const CACHE_PANEL_ID = "centrix-ui-cache-panel";
  const HIDE_ARG_PREFIX = "--centrix-ui-hide-css=";
  const REPLACE_ARG_PREFIX = "--centrix-ui-replace-rules=";
  const USER_SCRIPT_ARG_PREFIX = "--centrix-ui-user-script=";

  function decodeBase64UrlArg(prefix) {
    try {
      const args = typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv : [];
      const arg = args.find((item) => String(item || "").startsWith(prefix));
      if (!arg) return "";
      const encoded = String(arg).slice(prefix.length);
      if (!encoded) return "";
      const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder().decode(bytes);
    } catch {
      return "";
    }
  }

  function cssFromArgs() {
    return decodeBase64UrlArg(HIDE_ARG_PREFIX);
  }

  function replaceRulesFromArgs() {
    try {
      const parsed = JSON.parse(decodeBase64UrlArg(REPLACE_ARG_PREFIX) || "[]");
      return Array.isArray(parsed)
        ? parsed.filter((rule) => rule && typeof rule === "object" && rule.selector && rule.enabled !== false).slice(0, 80)
        : [];
    } catch {
      return [];
    }
  }

  const css = cssFromArgs();
  const replaceRules = replaceRulesFromArgs();
  const userScript = decodeBase64UrlArg(USER_SCRIPT_ARG_PREFIX).replace(/\u0000/g, "").slice(0, 30000);
  const userScriptKey = (() => {
    let hash = 5381;
    for (const ch of userScript) hash = ((hash << 5) + hash + ch.charCodeAt(0)) >>> 0;
    return `data-centrix-userscript-${hash.toString(16)}`;
  })();

  function ensureStyle() {
    if (!css) return Boolean(document.head);
    const root = document.head || document.documentElement;
    if (!root) return false;

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.setAttribute("data-centrix-ui-hide", "true");
      style.textContent = css;
      root.prepend(style);
      return Boolean(document.head);
    }

    if (document.head && style.parentElement !== document.head) {
      document.head.prepend(style);
    }

    if (style.textContent !== css) {
      style.textContent = css;
    }

    return Boolean(document.head);
  }

  function textForElement(element) {
    if (!element) return "";
    return "value" in element ? String(element.value || "") : String(element.textContent || "");
  }

  function shouldReplace(element, rule) {
    if (!rule.matchText) return true;
    return textForElement(element).includes(String(rule.matchText || ""));
  }

  function replaceElement(element, text) {
    if (!element || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName)) return false;

    if ("value" in element && /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) {
      if (String(element.value || "") === text) return false;
      element.value = text;
      element.setAttribute("value", text);
      return true;
    }

    if (element.isContentEditable) {
      if (String(element.textContent || "") === text) return false;
      element.textContent = text;
      return true;
    }

    if (String(element.textContent || "") === text) return false;
    element.textContent = text;
    return true;
  }

  function applyReplaceRules() {
    if (!replaceRules.length) return 0;
    let applied = 0;

    for (const rule of replaceRules) {
      const selector = String(rule.selector || "").trim();
      if (!selector || rule.enabled === false) continue;

      let elements = [];
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }

      for (const element of elements) {
        if (!shouldReplace(element, rule)) continue;
        if (replaceElement(element, String(rule.text || ""))) applied += 1;
      }
    }

    return applied;
  }

  function removeUiCachePanel() {
    document.getElementById(CACHE_PANEL_ID)?.remove();
    document.getElementById(CACHE_STYLE_ID)?.remove();
  }

  function runUserScript(reason = "preload") {
    if (!userScript.trim()) return { ok: true, skipped: true };
    const root = document.documentElement || document.body;
    if (root?.getAttribute(userScriptKey) === "1") return { ok: true, skipped: true, reason: "already-ran" };
    root?.setAttribute(userScriptKey, "1");

    try {
      const context = { mode: "app-user-preload", reason, url: location.href };
      window.__centrixUserScriptContext = context;
      const run = new Function("context", userScript);
      const value = run.call(window, context);
      return { ok: true, value };
    } catch (error) {
      console.warn("[CentriX] UserScript error", error);
      return { ok: false, error: error?.message || String(error) };
    }
  }

  function applyAll() {
    ensureStyle();
    applyReplaceRules();
    removeUiCachePanel();
  }

  applyAll();

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    applyAll();
    if (attempts >= 160) clearInterval(timer);
  }, 25);

  let scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyAll();
    });
  }

  try {
    const observer = new MutationObserver(scheduleApply);
    const observeRoot = () => {
      const root = document.body || document.documentElement;
      if (!root) return false;
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true
      });
      setTimeout(() => observer.disconnect(), 15000);
      return true;
    };

    if (!observeRoot()) {
      document.addEventListener("DOMContentLoaded", observeRoot, { once: true, capture: true });
    }
  } catch {
    // MutationObserver is best-effort only.
  }

  document.addEventListener("DOMContentLoaded", applyAll, { capture: true });
  window.addEventListener("load", applyAll, { capture: true });
  if (userScript.trim()) {
    const runWhenReady = () => runUserScript(document.readyState || "ready");
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", runWhenReady, { once: true, capture: true });
    } else {
      setTimeout(runWhenReady, 0);
    }
    window.addEventListener("load", runWhenReady, { once: true, capture: true });
  }
})();
