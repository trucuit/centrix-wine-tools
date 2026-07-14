# Lock & Takeover — single active device

Sources: `src/remote-tabs-main.js` (server), `src/remote-user-main.js` (client).

## Constants

| Name | Default | Meaning |
|------|---------|---------|
| `ACCOUNT_SINGLE_DEVICE` | ON (`!= "0"`) | 1 account = 1 live device |
| `ACTIVE_DEVICE_TTL_MS` | 35000 | Holder live if `lastBeat` within window |
| `TAKEOVER_GRACE_MS` | 5000 | Countdown on evicted device |
| `TAKEOVER_FORCE_MS` | grace + 4000 ≈ 9000 | Force free + revoke old token |

## Server state

```js
activeDevices: Map<userId, {
  deviceId: string,
  token: string,
  profileId: string,
  since: number,
  lastBeat: number,
  evictAt: number,   // 0 = not evicting
  evictBy: string    // challenger deviceId
}>
```

### claimActiveDevice(userId, deviceId, token, profileId)

| Condition | Result |
|-----------|--------|
| Single-device off / empty ids | ok, maybe set holder |
| No rec / same device / stale | ok → setActiveHolder |
| Other live holder, no eviction | `{ ok:false, reason:"device_active", activeDevice }` |
| Eviction in progress by this device, within force window | `{ ok:false, reason:"takeover_pending", graceMs }` |
| Eviction past force window | revoke old token, set holder = new device, ok |

### requestAccountTakeover(userId, newDeviceId)

Soft-mark: `evictAt=now`, `evictBy=newDevice`. Holder still valid during grace.

### evictionStatusFor(userId, deviceId)

Returned on revision poll for current holder: `{ pending, graceMs, sinceMs }`.

## Client APIs

| API | When |
|-----|------|
| `POST /api/profile/lock` | Connect — claim device + profile |
| `POST /api/profile/takeover` | User confirms kick other device |
| `POST /api/profile/release` | Logout / graceful leave |
| `POST /api/auth/self-revoke` | Cancel pending / logout |
| `GET /api/profile/revision` | Poll; carries `evict` signal |

IPC: `connection:takeover`, `connection:cancel-takeover`.

## Sequences

### Connect free

```text
Device A                    Server
  |-- auth/google ---------->|
  |<-- token+sessionKey -----|
  |-- health + services ----->|
  |-- POST /profile/lock --->|
  |   claimActiveDevice(A)   |
  |<-- ok + revision --------|
  |  saveSession, heartbeat  |
```

### B blocked while A live

```text
Device B                    Server                    Device A
  |-- lock ---------------->|                           |
  |  claim → device_active  |                           |
  |<-- DEVICE_ACTIVE -------|                           |
  |  pendingTakeover=conn   |                           |
  |  UI: kick other device? |                           |
```

### Takeover

```text
B                           Server                    A
 |-- POST /profile/takeover>|                         |
 |  evictAt, evictBy=B      |                         |
 |<-- evicting grace 5s ----|                         |
 |                          |  (A poll revision)      |
 |                          |<-- GET /revision -------|
 |                          |-- evict:{pending} ----->|
 |                          |  A countdown + push     |
 |                          |  A release + self-revoke|
 |-- lock retry ----------->|                         |
 |  (or force after ~9s)    |  revoke token A         |
 |<-- ok holder=B ----------|                         |
```

### Cancel

```text
B -- self-revoke(pending) --> clear pendingTakeover
```

## State machine

```text
NO_HOLDER --lock--> HOLDER=A --lock(B)--> DEVICE_ACTIVE
                         ^                      |
                         |                      | takeover(B)
                         |                      v
                    HOLDER=B <----------- EVICTING (grace/force)
                         ^                 |
                         |-- A releases ---|
```

## Two lock layers

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| Account device | `activeDevices` + lock/takeover | One live install per CentriX account |
| Profile revision | `lockHeldBy` + `baseRevision` on import | Optional single-device push (`PROFILE_SINGLE_DEVICE`) |

## Client error codes

| Code / reason | UX |
|---------------|-----|
| `DEVICE_ACTIVE` / `device_active` | Offer takeover |
| `takeover_pending` | Wait / retry lock |
| Generic lock fail | “Profile đang dùng ở thiết bị khác…” |
