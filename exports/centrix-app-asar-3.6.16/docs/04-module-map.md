# Module map

## package.json

```json
{
  "name": "centrix-embedded-browser-poc",
  "version": "0.1.0",
  "main": "src/remote-user-main.js"
}
```

App version string in code: `APP_VERSION = "3.6.16"` (`remote-user-main.js`).

## Entry mains

| File | Lines (approx) | Role |
|------|----------------|------|
| `src/remote-user-main.js` | ~6–7k LOC scale | App User main |
| `src/remote-tabs-main.js` | large | App Server HTTP + tabs |
| `src/remote-server-main.js` | small | sets server userData name → tabs |
| `src/desktop-main.js` | medium | Desktop shared shell |
| `src/desktop-user-main.js` | 2 lines | `CENTRIX_DESKTOP_MODE=user` |
| `src/desktop-admin-main.js` | 2 lines | `CENTRIX_DESKTOP_MODE=admin` |
| `src/remote-control-main.js` | medium | Remote Claude :19777 |
| `src/main.js` | medium | POC multi-account browser |

See `meta/JS-LOC.txt` for exact line counts.

## shared/*

| Module | Exports (summary) |
|--------|-------------------|
| `profile-sync.js` | exportProfileSnapshot, importProfileSnapshot, partition helpers |
| `profile-crypto.js` | newSessionKey, encrypt/decrypt AES-GCM |
| `app-attest.js` | clientAttestHeader, APP_REQUEST_KEY, exportSignHeader, verify* |
| `dpop-verify.js` | verifyDeviceProof, jwkThumbprint |
| `gibberish-names.js` | userdata + partition prefixes |
| `service-store.js` | DEFAULT_SERVICES, read/write services config |
| `local-db.js` | credits, portal, org, plans, activity |
| `google-oauth.js` | client id/secret/endpoints |
| `version-gate.js` | parse/cmp version, verdict |
| `native-menu.js` | installCentrixNativeMenu |
| `harden-runtime.js` | hardenRuntimeOrExit |
| `worker-auth.js` / `worker-rpc.js` | worker channel |

## App User UI

| Path | Role |
|------|------|
| `src/remote-user/index.html` | Shell UI (large) |
| `src/remote-user/user.js` | Renderer state |
| `src/remote-user/api-ui-bridge.js` | Bridge UI + IPC (very large) |
| `src/remote-user/styles.css` | Styles |
| `src/remote-user-preload.js` | `window.centrixLocalUser` |
| `src/remote-user-browser-preload.js` | Injected into service webviews |

## App User IPC (`meta/IPC-HANDLERS-APP-USER.txt`)

Groups:

- **window:** minimize, maximize, close, bounds, move-by, is-maximized  
- **connection:** login-google, connect, disconnect, takeover, cancel-takeover, state  
- **profile:** pull, push  
- **services:** list, refresh  
- **browser:** open-service, reload, home, back, forward, set-bounds, state  
- **account:** me, logout, change-password  
- **portal:** summary, org-*, plan-*, billing, topup, support, livechat, delete-account  
- **activity / url-history**  
- **version / update:** current, download, install, cancel, skip, setAuto, check, quit  

## Server Web UI

| Path | Role |
|------|------|
| `src/remote-server-web/index.html` | Admin shell |
| `src/remote-server-web/server.js` | Admin client helpers |
| `src/remote-server-web/api-ui-bridge.js` | Massive admin UI |

## Preloads / expose

| Preload | exposeInMainWorld |
|---------|-------------------|
| `remote-user-preload.js` | `centrixLocalUser` |
| `desktop-preload.js` | `centrixDesktop` |
| `preload.js` | `centrixBrowser` |
| `remote-server-preload.js` | `centrixAppServer` |

## Session persistence modules

| File | File on disk |
|------|--------------|
| `remote-user-session.js` | `session.bin` (safeStorage) |
| `remote-user-device.js` | `device-key.bin` |

## Default services

12 catalog entries → `meta/DEFAULT-SERVICES.json`  
(chatgpt, claude, gemini, perplexity, microsoft-copilot, grok, deepseek, mistral, midjourney, poe, …)

## Size ranking (source files)

Top weight: `remote-user/api-ui-bridge.js`, `remote-server-web/api-ui-bridge.js`,  
`remote-user/index.html`, `remote-server-web/index.html`, `remote-user-main.js`,  
`remote-tabs-main.js`, `local-db.js`.
