# Snapshot schema — `/api/profile/export`

Source of truth in asar: `src/shared/profile-sync.js` + `src/shared/profile-crypto.js`.  
Client pull: `src/remote-user-main.js` → `pullServiceProfileFromServer` / whole-profile pull.

## Request

### Whole profile

```http
GET /api/profile/export?profileId=default&includeStorage=0|1
```

### Pool per-service (client, when `profilePool=true`)

```http
GET /api/profile/export?service=<serviceId>&includeStorage=0|1
```

Default client open: `includeStorage=1` (timeout 60s). Cookies-only: `includeStorage=0` (20s).

### Headers (export)

```http
Authorization: Bearer <token>
X-CentriX-App-Key / User / Profile / Session / Attest / Proof
X-CentriX-Sig: <exportSignHeader(token, profileId)>
User-Agent: CentriXAppUser/3.6.16
```

## Response envelope

| Field | Type | Notes |
|-------|------|-------|
| `ok` | boolean | |
| `encrypted` | object | Preferred for App User — AES-GCM |
| `snapshot` | object | Plaintext (legacy / admin opt-in) |
| `revision` | number | Profile revision |
| `summary` | object | `{ profileId, cookies, origins, storage }` counts |
| `assignedProfile` | string\|null | Pool slot id (Phase-B / client expects) |
| `rulesRevision` | number | UI rules revision (client expects) |

### Encrypted blob

```json
{
  "enc": "aesgcm",
  "iv": "<base64 12 bytes>",
  "tag": "<base64 auth tag>",
  "data": "<base64 ciphertext of JSON snapshot>"
}
```

Key = login `sessionKey` (32-byte base64). Decrypt: `decryptSnapshot(encrypted, sessionKey)`.

## Snapshot v1 (plaintext after decrypt)

```json
{
  "version": 1,
  "profileId": "default",
  "exportedAt": "2026-07-14T02:02:33.098Z",
  "origins": ["https://grok.com", "https://chatgpt.com"],
  "cookies": [ /* CookieItem */ ],
  "storage": [ /* OriginStorage */ ],
  "uiRules": [ /* optional */ ]
}
```

### CookieItem

| Field | Type | Import rules (`cookieForSet`) |
|-------|------|-------------------------------|
| `name` | string | required |
| `value` | string | required |
| `domain` | string | omitted for hostOnly / `__Host-*` |
| `hostOnly` | bool | |
| `path` | string | default `/` |
| `secure` | bool | forced true if `__Secure-`/`__Host-` or SameSite=None |
| `httpOnly` | bool | |
| `session` | bool | |
| `expirationDate` | number? | unix sec; **expired → skipped** (not delete) |
| `sameSite` | string | `unspecified\|no_restriction\|lax\|strict` (`None`→`no_restriction`) |
| `url` | string | `https://domain/path` — required by Electron set |

### OriginStorage

| Field | Type |
|-------|------|
| `origin` | string |
| `ok` | bool |
| `loadOk` / `loadError` | export meta |
| `localStorage` | `{ [key: string]: string }` |
| `sessionStorage` | `{ [key: string]: string }` |
| `error` | string? |

Import uses hidden BrowserWindow: `loadURL(origin)` + inject setItem.

### uiRules (optional)

```json
{
  "serviceId": "chatgpt",
  "enabled": true,
  "hideSelectors": [],
  "hideRules": [],
  "replaceRules": [],
  "userScript": ""
}
```

Authoritative over `/api/services` rules when present (`captureProfileUiRules`).

## Export gate (server)

With `EXPORT_GATE` on account tokens:

| Check | Block reason |
|-------|--------------|
| Recent non-export interaction | `no-client-interaction` |
| Attest (strict) | `attestation` |
| Export sig (if required) | `bad-signature` |
| DPoP jkt (if bind on) | `device-binding` |
| Risk score ≥ 70 (strict) | `risk` |

Response fail: `403 { ok:false, error:"export-blocked", reason, score }`.

## Cookie scoping

App User export: `scopeCookies: true` → only registrable domains from granted services' `cookieDomains` + urls.  
Admin/master: full jar.

## Client import pipeline

```text
result.encrypted → decrypt(sessionKey) → snapshot
  → captureProfileUiRules(snapshot)
  → importProfileSnapshot(partition, snapshot)
      cookies.set × N
      storage write × origins
      flushStorageData()
  → poolPullState[service] = { revision, rulesRevision, assignedProfile }
  → markPoolDomainOwner(service)
```

## vs local hook dump

| | API snapshot | Hook `cookies-dump-*.json` |
|--|--------------|----------------------------|
| Producer | Server | App User after open |
| Encrypt | Yes (sessionKey) | No (local file) |
| Fields | origins, cookies, storage, uiRules | url, serviceId, serviceName, cookies, localStorage |
| Password | No | No |

## Default cookieDomains (catalog)

See `meta/DEFAULT-SERVICES.json`.
