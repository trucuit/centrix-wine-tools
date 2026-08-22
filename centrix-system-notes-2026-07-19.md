# CentriX System Notes

Updated: 2026-07-19 (Asia/Ho_Chi_Minh)

## Scope and handling

This note documents the CentriX application architecture observed from the production backend source, the extracted Electron user app, the local SQLite backup, and read-only checks on the live VPS. It intentionally excludes credentials, API keys, tokens, password hashes, session keys, cookies, cookie values, and personal account data.

## Systems and source locations

### Production CentriX App

- VPS: `103.240.7.254`
- Backend source: `/opt/centrix/backend`
- Backend systemd unit: `centrix-backend.service`
- Backend process: `cluster-launcher.js`
- DB API systemd unit: `centrix-dbapi.service`
- SQLite database: `/opt/centrix/data/centrix-local-db.sqlite`
- Runtime environment file: `/opt/centrix/centrix.env`
- Profile snapshot directory: `/opt/centrix/data/centrix-snapshots/`

The local copy of the active backend source is at:

`/Volumes/m2/apps/windows/centrix-backend/`

The local backup database is at:

`/Volumes/m2/backups/vps-103.240.7.254-2026-07-18/database-dumps/centrix-local-db.sqlite`

The extracted Electron user application source is at:

`/Volumes/m2/apps/windows/exports/centrix-app-asar-3.18.1/source/`

### Separate VPS / unrelated service family

`163.223.224.240` hosts the separate `chatgpt2api` deployment and related services. Its runtime data is distinct from CentriX App production data. In particular, `chatgpt2api` uses JSON data under `/opt/chatgpt2api/data`; it is not the CentriX SQLite database described above.

## Backend modes

The backend supports two profile delivery modes:

1. DB-snapshot mode (`CENTRIX_PROFILE_FROM_DB=1`): the backend reads stored encrypted snapshot files itself. This is the active CentriX architecture investigated here.
2. Worker mode: the backend requests a raw snapshot from a live Electron custodian through worker RPC.

The profile routes are:

- `GET /api/profile/export`
- `GET /api/profile/revision`
- `POST /api/profile/import`
- `POST /api/profile/lock`
- `POST /api/profile/release`
- `POST /api/profile/takeover`

Source: `centrix-backend/server.js` around the profile route gate.

## Database responsibilities

The central SQLite file stores application state, not raw pool cookie snapshots. Important tables include:

| Table | Responsibility |
| --- | --- |
| `users` | User identity, role, enabled state, default profile id. |
| `app_accounts` | App login email, password verifier, user id, profile id, enabled state. |
| `auth_sessions` | Login session token record, device id, profile id, encrypted/wrapped session key, expiry/revocation metadata. |
| `user_subscriptions` | Plan assignment, status, period, paid amount and credit grant. |
| `plans` | Plan definitions. |
| `service_visibility` | Per-user or global service visibility overrides. |
| `plan_service_access` | Plan-to-service configuration. It is present as data but is not currently used by `servicesForUser()` for service-list filtering. |
| `credit_wallets`, `credit_transactions`, `credit_reservations` | Credits and billing usage. |
| `model_prices`, `model_policies`, `model_usage`, `model_observations` | Model pricing/policy/usage data. |
| `ui_rules`, `ui_cache_items`, `ui_rule_reports` | Service UI rule state and UI cache. |
| `local_store` | Per-user/service/origin application state. It is not the shared profile-pool snapshot store. |

Do not treat `auth_sessions` as a cookie store. It provides the session context and key material used to protect a snapshot response.

## Authentication and session material

1. The user authenticates using an `app_accounts` login.
2. The backend creates a session token, device association, expiry timestamps, and a fresh random 32-byte `sessionKey`.
3. At rest, the session token is stored as a hash. The session key is protected by the backend vault wrapper before storage.
4. A verified request resolves the account/user/profile/session key and uses this context for profile export/import authorization.

The session key is used for AES-256-GCM protection of a snapshot in transit. It is not a provider-service cookie or a user password.

Source: `centrix-backend/shared/local-db.js` login and token verification functions; `centrix-backend/shared/profile-crypto.js`.

## Service visibility behavior

`servicesForUser(globalConfig, userId)` builds the service list returned to an enabled user:

1. Start with globally enabled services.
2. Apply `service_visibility` rules:
   - Global explicit hide is a kill switch.
   - A per-user row overrides global show.
   - A global show applies when the user has no row.
   - Without a row, an enabled user sees the service by default.
3. Merge model policy, pricing, UI rules, and blocked-link data into each returned service.

Current source does not call `plan_service_access` from this service-list path. Therefore plan rows should not be assumed to control what the Electron user app displays without a code change.

Source: `centrix-backend/shared/local-db.js`, `servicesForUser()` and `serviceVisibleForUser()`.

## Profile pool model

A pool is a set of shared login profiles per service. A profile usually follows the name `<service-id>-<slot>`, such as `chatgpt-1` or `claude-1`.

### Files

The pool lives outside SQLite:

```text
/opt/centrix/data/centrix-snapshots/
  <service>-<slot>.json       encrypted profile snapshot
  pool-state.json             pool index, assignments, capacity, cooldowns, recent history
```

Each snapshot record has this high-level shape:

```json
{
  "blob": "AES-GCM encrypted snapshot envelope",
  "revision": 0,
  "updatedAt": "ISO-8601 timestamp"
}
```

The plaintext snapshot is not stored in the database. It contains the browser state needed for a service, including cookies and optionally origin storage; it must be handled as sensitive authentication material.

### Seeding and indexing

When a manager imports/seeds a profile:

1. The backend writes the snapshot encrypted at rest.
2. The backend checks which service domains have valid auth cookies.
3. The profile id is added to that service's pool index.
4. A seeded pool profile is owner-pinned to its named service, preventing profiles for services sharing a domain from being mixed.

The pool checks a Google profile using a known set of Google authentication cookie names, rather than accepting unrelated tracking cookies as proof of login.

### Assignment algorithm

For `GET /api/profile/export?service=<service-id>`:

1. The backend looks for a sticky assignment keyed by `<service-id>|<user-id>`.
2. If it is still within its idle TTL, not cooling down, and has a valid snapshot, the same slot is reused.
3. Otherwise, the backend enumerates profiles indexed for that service in order.
4. It picks the first profile below capacity. The default capacity is 10 active users per profile; service- and profile-level overrides may replace it.
5. If all slots are full, it picks the least-loaded live slot rather than blocking the user.
6. The resulting assignment is written to `pool-state.json`.

Assignments expire after 30 minutes of idle time by default. Expired assignments stop counting toward capacity but are retained as recent history for 24 hours. A real use event can refresh the assignment.

### Slot health

- A missing or decryptable snapshot that lacks the service authentication cookie is considered dead and is removed from the pool index.
- A temporary file-read or decrypt failure is treated as unavailable for the current assignment attempt, but is not pruned.
- A service account that reaches a provider quota can be placed in cooldown. It remains indexed but is skipped until its cooldown expires or is cleared.

All state-changing pool operations use a shared async lock and atomic file replacement to avoid assignment races.

Source: `centrix-backend/pool.js` and `centrix-backend/snapshot-store.js`.

## Cookie and storage delivery flow

The backend does not deliver provider cookies with an HTTP `Set-Cookie` header.

### Service open flow

1. The Electron app opens a service and requests `/api/profile/export?service=<id>&includeStorage=1`.
2. The request carries the CentriX account bearer token, device/session proof, app attestation, and an export signature.
3. The backend applies the export gate, resolves the user services, selects or reuses a profile-pool slot, and reads the encrypted snapshot file.
4. The backend decrypts the snapshot in memory using the at-rest key.
5. It scopes cookie/storage state to the selected service and attaches current UI rules.
6. The backend encrypts the response snapshot with the requesting session's session key using AES-256-GCM.
7. The response is JSON with an `encrypted` envelope, `assignedProfile`, `revision`, and a non-sensitive summary.
8. Electron decrypts that JSON envelope locally and calls Electron's cookie API to set each cookie in the app's in-memory browser partition.
9. Electron imports origin storage through a hidden window, flushes storage, then opens/reloads the service page. Chromium subsequently sends the imported cookies to the provider as part of normal provider requests.

The Electron user partition is designed to be in-memory while the app is running. In pool mode, the client does not push the borrowed pool snapshot back to the server; only manager-side seeding/reseeding refreshes the shared profile.

### Relevant source files

- Backend export/import handling: `centrix-backend/server.js`
- At-rest snapshot handling: `centrix-backend/profile-snapshot.js`
- Snapshot file storage and locking: `centrix-backend/snapshot-store.js`
- Pool assignment: `centrix-backend/pool.js`
- AES-GCM envelope implementation: `centrix-backend/shared/profile-crypto.js`
- Electron pull/decrypt/import: `exports/centrix-app-asar-3.18.1/source/src/remote-user-main.js`
- Electron cookie/storage import: `exports/centrix-app-asar-3.18.1/source/src/shared/profile-sync.js`

## Snapshot update rules

### `<service>-<slot>.json`

This changes when a manager imports, seeds, or reseeds a profile snapshot. The backend increments `revision` and writes an encrypted replacement atomically. A normal App User opening a service does not alter this file in pool mode.

### `pool-state.json`

This changes when the backend:

- assigns or reassigns a user to a slot;
- refreshes a live assignment following service usage;
- indexes or removes a profile;
- expires an assignment into recent history;
- changes capacity;
- creates, expires, or clears a cooldown.

### Claude snapshot observed on the VPS

The current pool includes:

```text
/opt/centrix/data/centrix-snapshots/claude-1.json
```

Observed metadata on 2026-07-19:

- revision: 9
- updated at: `2026-07-18T09:49:03.853Z`
- envelope: AES-GCM
- file size: 12,392 bytes

No snapshot blob or authentication material is included in this note.

## Operations guidance

- Back up the SQLite database and `centrix-snapshots/` together if a restorable production state is required. They serve different roles.
- Do not copy/export raw snapshot files, session records, or Electron cookie folders into ordinary workspaces or reports.
- Use a redacted metadata export for audits: profile id, revision, updated time, encrypted flag, size, indexed services, capacity, assignment count, and cooldown state.
- A profile file that is present is not necessarily usable. The pool performs a service-cookie health check before assignment.
- An account can see a service only through the service-list behavior described above; a service appearing in the UI does not prove a dedicated provider account exists for that user.

## Verification status

The paths, source behavior, pool behavior, and Claude snapshot metadata above were verified from production source and read-only checks on the CentriX VPS on 2026-07-18/19. Any runtime environment values, keys, credentials, and encrypted payload contents are intentionally omitted.
