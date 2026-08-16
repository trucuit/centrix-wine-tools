#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  domainAllowed,
  isCookieSourceNoise,
  isHostScopedCookieFile,
  listImportableServices,
  loadServiceCookies,
  loadServiceStorage,
  normalizeCookie,
  selectCookieSourceFiles,
  toNetworkSetCookieParams,
} from "../scripts/import-cookies-to-chrome.mjs";

assert.equal(domainAllowed(".grok.com", ["grok.com", "x.ai"]), true);
assert.equal(domainAllowed("accounts.x.ai", ["grok.com", "x.ai"]), true);
assert.equal(domainAllowed("evilgrok.com", ["grok.com"]), false);
assert.equal(domainAllowed("auth.openai.com", ["chatgpt.com", "openai.com"]), true);
assert.equal(domainAllowed(".auth.openai.com", ["chatgpt.com", "openai.com"]), true);

const normalized = normalizeCookie({
  name: "session", value: "redacted", domain: ".grok.com", path: "/",
  secure: true, httpOnly: true, sameSite: "no_restriction", session: true,
}, ["grok.com"]);
assert.deepEqual(normalized, {
  name: "session", value: "redacted", domain: ".grok.com", path: "/",
  secure: true, httpOnly: true, hostOnly: false, sameSite: "None",
});
assert.equal(normalizeCookie({ name: "x", value: "y", domain: ".example.com" }, ["grok.com"]), null);
assert.equal(normalizeCookie({ name: "x", value: "y", domain: ".grok.com", expirationDate: 1, session: false }, ["grok.com"], 2), null);

// __Host- → host-only + secure; Network params use url not domain
const hostCookie = normalizeCookie({
  name: "__Host-next-auth.csrf-token", value: "tok", domain: "chatgpt.com",
  path: "/", hostOnly: true, httpOnly: true, sameSite: "lax", session: true,
}, ["chatgpt.com", "openai.com"]);
assert.equal(hostCookie.hostOnly, true);
assert.equal(hostCookie.secure, true);
const netParams = toNetworkSetCookieParams(hostCookie);
assert.equal(netParams.url, "https://chatgpt.com/");
assert.equal(netParams.domain, undefined);

// File selection: prefer host-scoped; skip dump noise
assert.equal(isCookieSourceNoise("cookies-dump-notebooklm.cookie-editor.json"), true);
assert.equal(isCookieSourceNoise("notebooklm-1.full.json"), true);
assert.equal(isCookieSourceNoise("chatgpt-1.export.json"), true);
assert.equal(isCookieSourceNoise("notebooklm-1.json"), true);
assert.equal(isCookieSourceNoise("auth.openai.com.json"), false);
assert.equal(isHostScopedCookieFile("auth.openai.com.json", ["openai.com", "chatgpt.com"]), true);
assert.equal(isHostScopedCookieFile("notebooklm.google.com.json", ["openai.com", "chatgpt.com"]), false);
assert.equal(isHostScopedCookieFile("notebooklm.json", ["openai.com", "chatgpt.com"]), false);
assert.deepEqual(
  selectCookieSourceFiles([
    "notebooklm.json",
    "auth.openai.com.json",
    "chatgpt.com.json",
    "notebooklm.google.com.json",
    "cookies-dump-notebooklm.cookie-editor.json",
    "notebooklm.full.json",
  ], ["chatgpt.com", "openai.com"], "service"),
  ["auth.openai.com.json", "chatgpt.com.json"],
);
assert.deepEqual(
  selectCookieSourceFiles([
    "notebooklm-1.full.json",
    "notebooklm.full.json",
  ], ["chatgpt.com", "openai.com"], "full", "notebooklm"),
  ["notebooklm.full.json"],
);

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
  // mode=service: host file accounts.x.ai.json wins over grok.json bulk
  const loaded = await loadServiceCookies(serviceDir, ["grok.com", "x.ai"]);
  assert.equal(loaded.mode, "service");
  assert.deepEqual(loaded.sourceFiles, ["accounts.x.ai.json"]);
  assert.equal(loaded.cookies.length, 1);
  assert.equal(loaded.cookies[0].name, "sso");
  assert.equal(loaded.cookies.some((cookie) => cookie.name === "should-not-load"), false);

  // without host files, fall back to service json (skip noise/storage)
  await rm(resolve(serviceDir, "accounts.x.ai.json"));
  const fallback = await loadServiceCookies(serviceDir, ["grok.com", "x.ai"]);
  assert.equal(fallback.cookies.length, 1); // valid once (duplicate collapsed)
  assert.equal(fallback.rejected.duplicate, 1);
  assert.ok(fallback.sourceFiles.includes("grok.json"));

  // mode=full: only *.full.json
  const full = await loadServiceCookies(serviceDir, ["grok.com", "x.ai"], "full");
  assert.equal(full.mode, "full");
  assert.equal(full.files, 1);
  assert.equal(full.cookies.length, 1);
  assert.equal(full.cookies[0].name, "should-not-load");

  // ChatGPT family: auth.openai.com host file + ignore conflicting google dump
  const nlmDir = resolve(root, "notebooklm");
  await mkdir(nlmDir);
  await writeFile(resolve(nlmDir, "auth.openai.com.json"), JSON.stringify({
    url: "https://auth.openai.com/log-in",
    cookies: [{ name: "usc_good", value: "a", domain: ".auth.openai.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", session: true }],
  }));
  await writeFile(resolve(nlmDir, "chatgpt.com.json"), JSON.stringify({
    url: "https://chatgpt.com",
    cookies: [{ name: "__Secure-next-auth.session-token", value: "sess", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 9999999999 }],
  }));
  await writeFile(resolve(nlmDir, "notebooklm.google.com.json"), JSON.stringify({
    url: "https://notebooklm.google.com",
    cookies: [
      { name: "usc_bad", value: "b", domain: ".auth.openai.com", path: "/", secure: true, sameSite: "lax", session: true },
      { name: "usc_good", value: "overwrite-me", domain: ".auth.openai.com", path: "/", secure: true, sameSite: "lax", session: true },
    ],
  }));
  // NextAuth chunk conflict resolution: chunked .0/.1 should discard unchunked token
  await writeFile(resolve(nlmDir, "chatgpt.com.json"), JSON.stringify({
    url: "https://chatgpt.com",
    cookies: [
      { name: "__Secure-next-auth.session-token", value: "old-single", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 9999999999 },
      { name: "__Secure-next-auth.session-token.0", value: "chunk0", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 9999999999 },
      { name: "__Secure-next-auth.session-token.1", value: "chunk1", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", expirationDate: 9999999999 },
    ],
  }));
  const chatgpt = await loadServiceCookies(nlmDir, ["chatgpt.com", "openai.com"]);
  assert.deepEqual(chatgpt.sourceFiles, ["auth.openai.com.json", "chatgpt.com.json"]);
  assert.equal(chatgpt.cookies.some((c) => c.name === "usc_good" && c.value === "a"), true);
  assert.equal(chatgpt.cookies.some((c) => c.name === "usc_bad"), false);
  assert.equal(chatgpt.cookies.some((c) => c.name === "__Secure-next-auth.session-token.0" && c.value === "chunk0"), true);
  assert.equal(chatgpt.cookies.some((c) => c.name === "__Secure-next-auth.session-token.1" && c.value === "chunk1"), true);
  assert.equal(chatgpt.cookies.some((c) => c.name === "__Secure-next-auth.session-token"), false);

  const storage = await loadServiceStorage(serviceDir, "deepseek");
  assert.deepEqual(storage, { userToken: "redacted", settingsJwt: "redacted" });
  assert.deepEqual(await loadServiceStorage(serviceDir, "grok"), {});

  // listImportableServices sees source folder (grok → grok-heavy alias not present here;
  // we created cookies/grok so only ids whose source dir is "grok" light up)
  const listed = await listImportableServices(root);
  const grokRow = listed.find((row) => row.id === "grok");
  // grok sources from grok-heavy by config — folder named "grok" alone won't match source
  assert.equal(grokRow.source, "grok-heavy");
  // create matching source folder name used by alias
  const heavyDir = resolve(root, "grok-heavy");
  await mkdir(heavyDir);
  await writeFile(resolve(heavyDir, "grok-heavy.json"), JSON.stringify({ cookies: [valid] }));
  await writeFile(resolve(heavyDir, "grok-heavy.full.json"), JSON.stringify({ cookies: [valid] }));
  const listed2 = await listImportableServices(root);
  const heavyViaGrok = listed2.find((row) => row.id === "grok");
  const heavyDirect = listed2.find((row) => row.id === "grok-heavy");
  assert.equal(heavyViaGrok.hasService, true);
  assert.equal(heavyViaGrok.hasFull, true);
  assert.equal(heavyDirect.hasService, true);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("PASS cookie importer unit tests");
