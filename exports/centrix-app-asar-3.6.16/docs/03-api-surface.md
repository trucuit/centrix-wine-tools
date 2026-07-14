# API surface

Full route list: `meta/API-ROUTES.txt` (123 paths scanned from asar).

Base (App User default): `https://api-centrixapp-quang.centrix.asia`

## App User — core lifecycle

| Method | Path | Role |
|--------|------|------|
| GET | `/api/health` | Public health, `profilePool`, `latestApp`, version verdict |
| GET | `/api/services` | Service catalog + block rules for user |
| GET | `/api/me` | Canonical auth (401 → force logout) |
| POST | `/api/auth/google` | Login |
| POST | `/api/auth/login` | Disabled / removed |
| POST | `/api/auth/self-revoke` | Logout / cancel takeover |
| POST | `/api/profile/lock` | Claim device + profile |
| POST | `/api/profile/takeover` | Kick other device |
| POST | `/api/profile/release` | Release lock |
| GET | `/api/profile/export` | Pull cookie snapshot |
| POST | `/api/profile/import` | Push snapshot |
| GET | `/api/profile/revision` | Revision + `evict` signal |
| POST | `/api/user-tabs/heartbeat` | Keep alive |
| POST | `/api/user-tabs/close` | Close tab |
| GET/POST | `/api/account/lock-status` | Admin account lock |
| GET | `/api/download/app-user` | Installer update |

## App User — usage / storage / UI

| Path | Role |
|------|------|
| `/api/users/model-usage/check` | Credit gate per model request |
| `/api/users/ui-cache` | Per-service UI cache |
| `/api/users/local-store` | localStorage sync by origin |
| `/api/users/ui-rules*` | Hide/replace/userScript |
| `/api/users/activity` | Activity log |
| `/api/users/url-history` | URL history |
| `/api/users/change-password` | Password (if enabled server) |
| `/api/users/delete-account` | Delete account |

## Portal / org / billing

| Path | Role |
|------|------|
| `/api/users/portal/summary` | Dashboard |
| `/api/users/portal/topup-request` | Topup |
| `/api/users/portal/support` | Tickets |
| `/api/users/portal/livechat` | Livechat |
| `/api/users/portal/orders` | Orders |
| `/api/users/portal/invoices` | Invoices |
| `/api/users/portal/org` | Org portal |
| `/api/users/billing` | Billing |
| `/api/users/plans/me` | Plan |
| `/api/users/plans/self-downgrade` | Downgrade |
| `/api/users/org/*` | structure, member, allocate, billing, report, set-role, set-locked, … |

## Admin / staff

| Path | Role |
|------|------|
| `/api/admin/summary` | Dashboard |
| `/api/admin/accounts/*` | Lock/delete accounts |
| `/api/admin/credits/*` | Adjust/ledger |
| `/api/admin/plans/*` | Plans CRUD + assign |
| `/api/admin/staff/*` | Staff accounts |
| `/api/admin/roles/*` | RBAC |
| `/api/admin/services` | Service admin |
| `/api/admin/settings` | Settings |
| `/api/admin/upload-installer` | Publish app binary |
| `/api/admin/billing/*` | Approve billing |
| `/api/admin/livechat` / support / promotions / organizations / model-prices | Ops |
| `/api/auth/staff-login` / staff-logout / staff-whoami / staff-change-password | Staff auth |
| `/api/webhook/sepay` | Payment webhook |

## Services admin

| Path | Role |
|------|------|
| GET `/api/services` / `/api/admin/services` | List |
| POST `/api/services/save` | Save |
| POST `/api/services/reset` | Reset defaults |

## Remote-control / tabs POC (local server)

`/api/click`, `/api/type`, `/api/move`, `/api/wheel`, `/api/navigate`, `/api/open`, `/api/close`,  
`/api/reload`, `/api/back`, `/api/forward`, `/api/frame`, `/api/devtools`, `/api/resize`,  
`/api/show`, `/api/hide`, `/api/tabs`, `/api/state`, `/api/tunnel/*`, `/api/key`

## Model observation (in-page)

Client watches third-party AI traffic and bills via `/api/users/model-usage/check`:

- `/api/v0/chat/completion` (some providers)
- Poe `/api/gql_POST` (sendMessageMutation only)

## Public vs authed

| Public (no Bearer) | Authed |
|--------------------|--------|
| `GET /api/health` | Almost everything else |
| `POST /api/auth/google` | |
| Staff login routes | |
