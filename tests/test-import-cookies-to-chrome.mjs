#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { domainAllowed, loadServiceCookies, loadServiceStorage, normalizeCookie } from "../scripts/import-cookies-to-chrome.mjs";

assert.equal(domainAllowed(".grok.com", ["grok.com", "x.ai"]), true);
assert.equal(domainAllowed("accounts.x.ai", ["grok.com", "x.ai"]), true);
assert.equal(domainAllowed("evilgrok.com", ["grok.com"]), false);

const normalized = normalizeCookie({
  name: "session", value: "redacted", domain: ".grok.com", path: "/",
  secure: true, httpOnly: true, sameSite: "no_restriction", session: true,
}, ["grok.com"]);
assert.deepEqual(normalized, {
  name: "session", value: "redacted", domain: ".grok.com", path: "/",
  secure: true, httpOnly: true, sameSite: "None",
});
assert.equal(normalizeCookie({ name: "x", value: "y", domain: ".example.com" }, ["grok.com"]), null);
assert.equal(normalizeCookie({ name: "x", value: "y", domain: ".grok.com", expirationDate: 1, session: false }, ["grok.com"], 2), null);

const root = await mkdtemp(resolve(tmpdir(), "cookie-import-test-"));
try {
  const serviceDir = resolve(root, "grok");
  await mkdir(serviceDir);
  const valid = { name: "session", value: "redacted", domain: ".grok.com", path: "/", session: true };
  await writeFile(resolve(serviceDir, "grok.json"), JSON.stringify({ url: "https://grok.com", cookies: [valid, valid] }));
  await writeFile(resolve(serviceDir, "accounts.x.ai.json"), JSON.stringify({ url: "https://accounts.x.ai", cookies: [{ ...valid, name: "sso", domain: ".x.ai" }] }));
  await writeFile(resolve(serviceDir, "grok.full.json"), JSON.stringify({ cookies: [{ ...valid, name: "should-not-load" }] }));
  await writeFile(resolve(serviceDir, "invalid.json"), JSON.stringify({ cookies: [{ ...valid, domain: ".example.com" }] }));
  await writeFile(resolve(serviceDir, "deepseek.storage.json"), JSON.stringify({
    url: "https://chat.deepseek.com",
    localStorage: { userToken: "redacted", settingsJwt: "redacted", unexpected: "blocked" },
  }));
  const loaded = await loadServiceCookies(serviceDir, ["grok.com", "x.ai"]);
  assert.equal(loaded.cookies.length, 2);
  assert.equal(loaded.rejected.duplicate, 1);
  assert.equal(loaded.rejected.invalid, 1);
  assert.equal(loaded.cookies.some((cookie) => cookie.name === "should-not-load"), false);
  const storage = await loadServiceStorage(serviceDir, "deepseek");
  assert.deepEqual(storage, { userToken: "redacted", settingsJwt: "redacted" });
  assert.deepEqual(await loadServiceStorage(serviceDir, "grok"), {});
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("PASS cookie importer unit tests");
