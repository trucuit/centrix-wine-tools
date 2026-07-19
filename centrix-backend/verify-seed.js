"use strict";
// Verify a seeded pool snapshot: decrypt the at-rest blob and report STRUCTURE only (counts/domains/cookie
// names), never values. Confirms the manager push stored cookies + localStorage, scoped to the service, no cache.
const fs = require("node:fs");
const crypto = require("./shared/profile-crypto");
const rec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const key = process.env.CENTRIX_SNAPSHOT_AT_REST_KEY || "";
const snap = crypto.decryptSnapshot(rec.blob, key);
const cookies = snap.cookies || [];
const domains = [...new Set(cookies.map((c) => c.domain))].sort();
const names = [...new Set(cookies.map((c) => c.name))];
const storage = snap.storage || [];
console.log("revision        :", rec.revision);
console.log("cookies         :", cookies.length, "| domains:", domains.join(", "));
console.log("auth cookie?    :", cookies.some((c) => /chatgpt|openai/.test(c.domain || "") && /session|auth|__Secure|__Host/i.test(c.name || "")));
console.log("cookie names    :", names.slice(0, 12).join(", ") + (names.length > 12 ? " …" : ""));
console.log("localStorage    :", storage.length, "origin(s):", storage.map((s) => s.origin).join(", "), "| items:", storage.reduce((n, s) => n + ((s.localStorage && s.localStorage.length) || (s.items && s.items.length) || 0), 0));
console.log("leaked other svc:", cookies.some((c) => !/chatgpt|openai/.test(c.domain || "")) ? "YES (BAD)" : "no (scoped clean)");
console.log("cache present?  :", (("cache" in snap) || storage.some((s) => s.cache)) ? "YES (should be none)" : "no (correct - cookies+localStorage only)");
