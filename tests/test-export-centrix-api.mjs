import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const API_SCRIPT = join(ROOT, "scripts/export-centrix-api.mjs");

function runExport(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [API_SCRIPT, "export", "chatgpt"], { env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, output }));
  });
}

function startServer(handler) {
  const server = createServer(handler);
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function writeSession(dir, serverUrl) {
  const sessionFile = join(dir, "session.json");
  await writeFile(
    sessionFile,
    JSON.stringify({
      serverUrl,
      token: "test-token",
      sessionKey: Buffer.alloc(32).toString("base64"),
      profileId: "test-profile",
      deviceId: "test-device",
      loggedInAt: Date.now() - 10_000,
    })
  );
  return sessionFile;
}

test("export stops before profile export when the configured API returns HTML", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "centrix-api-test-"));
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>parked domain</html>");
  });
  t.after(async () => {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(dir, { recursive: true, force: true });
  });

  const sessionFile = await writeSession(dir, "http://127.0.0.1:1");
  const result = await runExport({
    CENTRIX_SERVER_URL: url,
    CENTRIX_SESSION_FILE: sessionFile,
    CENTRIX_OUT_DIR: join(dir, "cookies"),
  });

  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`CentriX API unavailable at ${url}`));
  assert.match(result.output, /expected JSON but received text\/html/);
  assert.doesNotMatch(result.output, /api\/profile\/export/);
  assert.equal(existsSync(join(dir, "cookies", "notebooklm")), false);
});

test("export returns a nonzero status when a service export fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "centrix-api-test-"));
  const { server, url } = await startServer((req, res) => {
    if (req.url?.startsWith("/api/profile/export")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "profile export unavailable" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, profilePool: true, config: { services: [] } }));
  });
  t.after(async () => {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(dir, { recursive: true, force: true });
  });

  const sessionFile = await writeSession(dir, url);
  const result = await runExport({
    CENTRIX_SESSION_FILE: sessionFile,
    CENTRIX_OUT_DIR: join(dir, "cookies"),
  });

  assert.equal(result.code, 1);
  assert.match(result.output, /! notebooklm: profile export unavailable/);
  assert.match(result.output, /Done ok=0 fail=1/);
});
