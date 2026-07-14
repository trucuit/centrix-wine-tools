# Architecture — CentriX app.asar 3.6.16

## Monorepo trong một asar

```text
app.asar (~3.4 MB source)
├── App User          remote-user-main.js      ← package.json main
├── App Server        remote-tabs-main.js      HTTP /api + custodian browser
├── Server Web UI     remote-server-web/*
├── Desktop shells    desktop-user / desktop-admin
├── Remote control    remote-control-main.js   :19777
├── Tabs web UI       remote-tabs-web/*
└── Shared            shared/*                 crypto, profile, db, attest
```

Build cài đặt **CentriX App User** chỉ chạy entry App User.  
API production = **Phase-B Backend** (Cloudflare) — có thể khác code bundled `remote-tabs-main.js` (client pool mode `?service=` expect fields server Phase-B bổ sung).

## On-disk names (gibberish)

| Constant | Value | Dùng cho |
|----------|-------|----------|
| `USER_USERDATA_NAME` | `mkvhszparoue` | App User userData |
| `USER_RAM_PREFIX` | `tgbyhnujmik-` | Partition cookie client (RAM) |
| `SHARED_BROWSER_PREFIX` | `nkkqiwedoap-` | Partition custodian server (persist) |
| `SERVER_USERDATA_NAME` | `qwmbvcxzladk` | App Server userData |
| `SERVER_CONFIG_DIR` | `sdfhsdjfhdsk` | auth/tunnel/local-db |

Source: `src/shared/gibberish-names.js`.

## Partition model (App User)

```text
profileId "default"
  → session.fromPartition("tgbyhnujmik-default")   # RAM-only
  → N WebContentsView tabs (chatgpt, grok, …) SHARE 1 cookie jar

Same registrable domain (chatgpt.com vs notebooklm/GPT-5.5 Pro)
  → cookie clobber
  → poolDomainOwner force re-pull on open
```

Server custodian:

```text
persist:nkkqiwedoap-<profileId>   # real pool logins live here
```

## Runtime data (App User)

| File | Content |
|------|---------|
| `session.bin` | safeStorage blob: serverUrl, token, profileId, deviceId, sessionKey, expiresAt |
| `device-key.bin` | Ed25519 device key (DPoP jkt) |
| `centrix-app-user.log` | JSON lines events |
| `cookies-dump-*.json` | hook dump after service open |

## High-level flows

### Boot + connect

```text
load session.bin
  → GET /api/health + GET /api/services
  → POST /api/profile/lock
  → GET /api/me
  → heartbeat + revision poll
```

### Open service (pool mode)

```text
browser:open-service(id)
  → GET /api/profile/export?service=<id>&includeStorage=1
  → decrypt AES-GCM(sessionKey)
  → importProfileSnapshot(RAM partition)
  → loadURL(service.url)
  → [optional hook] cookies.get → cookies-dump-<id>.json
```

### Auth

```text
Google OAuth (system browser loopback)
  → POST /api/auth/google { code, pkce, deviceId, deviceJkt }
  → connection { token, sessionKey, … }

Password login: DISABLED client-side
```

## Request security layers

Every authenticated `serverRequest`:

```http
Authorization: Bearer <token>
X-CentriX-App-Key: <build key>
X-CentriX-User: <deviceId>
X-CentriX-Profile: <profileId>
X-CentriX-Session: <sessionKey>
X-CentriX-Attest: <HMAC>
X-CentriX-Proof: <DPoP Ed25519>
User-Agent: CentriXAppUser/3.6.16
```

Export adds `X-CentriX-Sig`.

401 force-logout **only** on `/api/me` (not every route).

## Live health (probe)

```json
{
  "ok": true,
  "app": "CentriX Phase-B Backend",
  "mode": "shadow",
  "profilePool": true,
  "latestApp": { "version": "3.6.16", "downloadUrl": "/api/download/app-user" }
}
```

Base URL default client: `https://api-centrixapp-quang.centrix.asia`
