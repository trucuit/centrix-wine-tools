# Scout Report — Kiến trúc hệ thống CentriX (deep)

**Task:** Phân tích sâu kiến trúc CentriX App, API, và các thành phần hoạt động  
**Date:** 2026-07-14  
**Sources:** asar 3.6.16 extract + wine-tools + live health probe + 3× Explore agents  
**App:** CentriX App User `3.6.16` · asar sha256 `165fbfb7…` · package main `src/remote-user-main.js`

---

## 1. Bản đồ hệ thống (toàn cảnh)

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ ECOSYSTEM CENTRIX                                                        │
├───────────────┬────────────────────┬─────────────────────────────────────┤
│ App User      │ App Server /       │ Phase-B Backend (production live)   │
│ (client)      │ Tabs Server        │ api-centrixapp-quang.centrix.asia │
│ Electron      │ (bundled asar)     │ Cloudflare · profilePool=true       │
│ Wine on Mac   │ port 19778 local   │ db :19779 · optional worker RPC     │
└───────┬───────┴─────────┬──────────┴──────────────────┬──────────────────┘
        │                 │                             │
        │  Google OAuth   │  custodian partition        │
        │  lock/export    │  persist:nkkqiwedoap-*      │
        │                 │  manager login AI sites     │
        ▼                 ▼                             ▼
   RAM jar              snapshot AES-GCM            portal/admin/credits
   tgbyhnujmik-*        cookies+storage             plans/org/staff
        │
        ▼  [hook wine-tools]
   cookies-dump → J2TEAM → Chrome CDP (optional)
```

### Các “sản phẩm CentriX” trong asar monorepo

| Thành phần | Entry | Chạy khi nào |
|------------|-------|--------------|
| **App User** | `remote-user-main.js` | Build user cài (máy bạn) |
| **App Server** | `remote-server-main.js` → `remote-tabs-main.js` | Máy quản trị / custodian |
| **Phase-B Backend** | Ngoài asar (live API) | Production pool + health |
| **Desktop User/Admin** | `desktop-*-main.js` | Shell local services.json |
| **Remote control** | `remote-control-main.js` | POC :19777 |
| **Worker RPC** | `shared/worker-rpc.js` | `CENTRIX_WORKER_RPC=1` — Electron snapshot ops sau backend |

---

## 2. Luồng hoạt động chính

### 2.1 Login + connect (App User)

```text
UI loginGoogle
  → system browser OAuth PKCE (loopback 127.0.0.1)
  → POST /api/auth/google { code, codeVerifier, deviceId, deviceJkt }
  → connection { serverUrl, token, profileId, deviceId, sessionKey, expiresAt }
  → saveSession → session.bin (safeStorage)
  → GET /api/health  +  GET /api/services
  → profilePoolMode = health.profilePool (live: true)
  → POST /api/profile/lock
       OK → heartbeat + revision poll
       423 device_active → UI takeover
```

Password login: **disabled** client + server 410.

### 2.2 Mở service (pool mode — production)

```text
browser:open-service(serviceId)
  → GET /api/profile/export?service=<id>&includeStorage=1
       headers: Bearer + App-Key + User + Profile + Session
                + Attest + DPoP Proof + X-CentriX-Sig
  → decrypt AES-GCM(sessionKey) → snapshot v1
  → importProfileSnapshot(session "tgbyhnujmik-"+profileId)
       session.cookies.set × N
       hidden window localStorage/sessionStorage
  → markPoolDomainOwner(service)
  → WebContentsView.loadURL(service.url)
  → site AI coi như đã login
```

### 2.3 Whole-profile mode (pool off)

```text
connect → export?profileId= (cookies then storage bg)
open service → dùng jar sẵn, có thể push ngược import
pool mode → KHÔNG push (borrowed logins)
```

### 2.4 Custodian (server)

- Partition **persist** `nkkqiwedoap-<profileId>`
- Manager/loader browser login ChatGPT/Grok/… vào jar này
- Cookie change → bump revision → App User poll → re-pull
- **Custodian = giữ hộ login thật; App User = mượn snapshot tạm**

---

## 3. API surface (nhóm)

Base live: `https://api-centrixapp-quang.centrix.asia`

### Public
- `GET /api/health` — profilePool, latestApp, versionVerdict  
- `POST /api/auth/google`  
- `POST /api/account/lock-status`  
- `POST /api/webhook/sepay`  
- staff login/logout  

### App User core
- Profile: lock, release, takeover, export, import, revision  
- Me / heartbeat / close tabs  
- services, model-usage/check, ui-cache, local-store  
- activity, url-history  
- portal, plans, billing, org/*  

### Admin / staff
- summary, credits, plans, accounts, staff, roles, services, settings  
- portal admin, livechat, upload-installer  

### Loader remote-control (server UI)
- open/navigate/click/type/frame/tunnel…  

Chi tiết: `docs/03-api-surface.md`, `meta/API-ROUTES.txt`.

### Headers mọi request authenticated

```http
Authorization: Bearer <token>
X-CentriX-App-Key / User / Profile / Session
X-CentriX-Attest / X-CentriX-Proof
User-Agent: CentriXAppUser/3.6.16
X-CentriX-Sig          # chỉ export
```

---

## 4. Partition & data model

| | Custodian (server) | App User (client) |
|--|--------------------|-------------------|
| Partition | `persist:nkkqiwedoap-*` | `tgbyhnujmik-*` (no persist) |
| userData | `qwmbvcxzladk` | `mkvhszparoue` |
| Cookie life | Disk, manager-seeded | RAM, per process |
| Isolation | 1 profile jar multi-service | **Same** — domain clobber risk |

### Snapshot v1
```json
{ "version":1, "profileId", "exportedAt", "origins", "cookies", "storage", "uiRules?" }
```
Transit: `{ enc:"aesgcm", iv, tag, data }` key = `sessionKey`.

### Local runtime files
- `session.bin` — CentriX login  
- `device-key.bin` — Ed25519 DPoP  
- `centrix-app-user.log` — events  
- `cookies-dump-*.json` — hook only  

---

## 5. Device lock / takeover

```text
activeDevices[userId] = { deviceId, token, lastBeat, evictAt, evictBy }
TTL live 35s · grace 5s · force ~9s

lock free/stale/same → OK
lock other live → device_active
takeover → evict mark → victim sees revision.evict
force timeout → revoke old token → new holder
```

Two layers: **account single-device** (default ON) + optional **profile exclusive lock**.

---

## 6. Service catalog (default 12)

chatgpt · claude · gemini · perplexity · microsoft-copilot · grok ·  
deepseek · mistral · midjourney · poe · notebooklm · elevenlabs  

Live pool may add aliases: **notebooklm** = GPT-5.5 Pro (chatgpt.com), **grok-heavy**, envato, etc.

Credit: model-usage/check per request (fail-open on network blip — risk unbilled).

---

## 7. wine-tools (satellite)

Không gọi Phase-B. Pipeline:

```text
App User (sau pool import)
  → hook cookies.get → dump
  → export-pick-service → cookies/<svc>/*.json
  → import-cookies-to-chrome → CDP profile riêng
```

| Script | Việc |
|--------|------|
| `export-centrix-cookies.sh` | Patch asar hook, watch, convert |
| `export-pick-service.sh` | Offline pick + special files |
| `import-cookies-to-chrome.sh` | Chrome inject |
| `setup/run-centrix.sh` | Wine bootstrap |

---

## 8. Security posture (tóm tắt)

| Mạnh | Yếu |
|------|-----|
| AES-GCM snapshot transit | Attest/App-Key/export-key **trong asar** |
| safeStorage session.bin | Export gate chỉ friction nếu reverse client |
| DPoP device key (nếu server enforce) | Bind flags có thể log-only / off |
| Single-device + takeover | RAM jar shared cross-service |
| Password login removed | Model gate fail-open |
| hardenRuntime (no remote debug packaged) | Shell `sandbox: false` |

**Rủi ro gốc:** phân phối **session cookie AI pool** — không phải “lỗ RCE”, mà **trust client + session sharing**.

---

## Relevant Files

### App User (asar)
- `exports/.../source/src/remote-user-main.js` — main: connect, pool, browser, IPC (~5140 LOC)
- `exports/.../source/src/remote-user-preload.js` — `centrixLocalUser` bridge
- `exports/.../source/src/remote-user-browser-preload.js` — hide CSS / userScript in AI pages
- `exports/.../source/src/remote-user-session.js` — session.bin
- `exports/.../source/src/remote-user-device.js` — device-key + DPoP proof
- `exports/.../source/src/remote-user/api-ui-bridge.js` — UI bridge (huge)
- `exports/.../source/src/remote-user/index.html` — shell UI

### App Server / API (asar)
- `exports/.../source/src/remote-tabs-main.js` — HTTP /api, locks, export gates (~4277 LOC)
- `exports/.../source/src/remote-server-main.js` — server entry
- `exports/.../source/src/remote-server-web/*` — admin SPA
- `exports/.../source/src/shared/local-db.js` — accounts, credits, portal
- `exports/.../source/src/shared/worker-rpc.js` — Phase-B worker Electron ops

### Shared crypto / sync
- `.../shared/profile-sync.js` — export/import cookies+storage
- `.../shared/profile-crypto.js` — AES-GCM
- `.../shared/app-attest.js` — App-Key, attest, export sig
- `.../shared/dpop-verify.js` — device proof verify
- `.../shared/gibberish-names.js` — partition/userdata names
- `.../shared/service-store.js` — DEFAULT_SERVICES
- `.../shared/google-oauth.js` — OAuth client constants
- `.../shared/harden-runtime.js` — anti CDP packaged

### wine-tools repo
- `export-centrix-cookies.sh` — asar hook dump
- `export-pick-service.sh` — offline J2TEAM export
- `import-cookies-to-chrome.sh` + `scripts/import-cookies-to-chrome.mjs`
- `setup-centrix-mac.sh`, `run-centrix.sh`, `README.md`
- `plans/2026-07-12-terminal-cookie-importer/*`

### Docs đã export
- `docs/00-architecture.md` … `05-full-diagrams.md`, `full-diagrams.html`
- `meta/DEFAULT-SERVICES.json`, `API-ROUTES.txt`, `snapshot-v1.schema.json`

---

## Diagram tham chiếu nhanh

```text
Google → /auth/google → lock → health(profilePool)
                              │
                    ┌─────────┴─────────┐
                    │ pool=true         │ pool=false
                    ▼                   ▼
            open: export?service=   connect: export?profileId=
                    │                   │
                    └─────────┬─────────┘
                              ▼
                   importProfileSnapshot(RAM)
                              ▼
                        loadURL(AI site)
                              ▼
                   [hook] cookies-dump (tools)
```

Mở interactive: `docs/full-diagrams.html`

---

## Unresolved Questions

1. **Phase-B exact** `?service=` assignment / multi-slot admin mapping — không có trong asar User; live API khác thin health body của tabs-main local.  
2. Server production: **DPoP / BIND_SESSION_KEY / EXPORT_REQUIRE_SIG** enforce level?  
3. Account allowlist vs client org routes (`department-delete`, `set-role`, `delete-account`) — có 403 dead paths?  
4. Live service ids (`grok-heavy`, envato, gamma…) vs DEFAULT_SERVICES 12 — drift catalog.  
5. `remote-user/user.js` còn load hay chỉ `api-ui-bridge.js`?  
6. Có nên implement puller Phase-B trực tiếp (session.bin + DPoP) thay asar hook? — chưa có trong repo.

---

## Kết luận scout

CentriX = **Electron multi-product monorepo**: App User mượn **encrypted cookie snapshots** từ **custodian/pool** qua Phase-B API; browser nội bộ inject bằng `session.cookies.set` vào **RAM partition** dùng chung; bảo vệ request nhiều lớp nhưng **client-extractable**; wine-tools chỉ **exfil/import local** sau khi pool đã inject — không thay API.
