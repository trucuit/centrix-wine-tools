# CentriX App User 3.6.16 — Full diagrams

Mở file này bằng viewer hỗ trợ Mermaid (GitHub, VS Code Markdown Preview Mermaid, Obsidian, …).

---

## 1. System overview (end-to-end)

```mermaid
flowchart TB
  subgraph USER["Mac host"]
    AU["CentriX App User 3.6.16<br/>Electron · Wine"]
    SS["session.bin<br/>device-key.bin"]
    RAM["RAM partition<br/>tgbyhnujmik-&lt;profileId&gt;"]
    DUMP["cookies-dump-*.json<br/>hook local"]
    TOOLS["centrix-wine-tools<br/>export-pick / import-chrome"]
    CHR["Chrome profile riêng<br/>.chrome-cookie-profile"]
  end

  subgraph EDGE["Cloudflare"]
    CF["api-centrixapp-quang.centrix.asia"]
  end

  subgraph BE["Phase-B Backend"]
    API["HTTP /api/*"]
    DB["dbUrl :19779"]
    POOL["profilePool = true<br/>custodian logins"]
  end

  subgraph WEB["Target AI sites"]
    GPT["chatgpt.com"]
    GRK["grok.com / accounts.x.ai"]
    CLA["claude.ai"]
    GEM["gemini.google.com"]
    OTH["copilot · deepseek · …"]
  end

  AU <-->|Bearer · DPoP · Attest · SessionKey| CF
  CF --> API
  API --> DB
  API --> POOL
  AU --> SS
  AU --> RAM
  POOL -->|AES-GCM snapshot| AU
  RAM -->|loadURL + cookies| GPT & GRK & CLA & GEM & OTH
  RAM -->|session.cookies.get| DUMP
  DUMP --> TOOLS
  TOOLS -->|CDP Storage.setCookies| CHR
  CHR --> GPT & GRK & CLA
```

---

## 2. app.asar monorepo map

```mermaid
flowchart LR
  ASAR["app.asar<br/>package main → remote-user-main.js"]

  ASAR --> AU["★ App User<br/>remote-user-main<br/>remote-user/*"]
  ASAR --> SV["App Server bundle<br/>remote-tabs-main<br/>remote-server-web/*"]
  ASAR --> DT["Desktop shells<br/>desktop-user / admin"]
  ASAR --> RC["Remote control POC<br/>:19777"]
  ASAR --> SH["shared/*"]

  SH --> PS["profile-sync"]
  SH --> PC["profile-crypto"]
  SH --> AT["app-attest"]
  SH --> DP["dpop-verify"]
  SH --> GN["gibberish-names"]
  SH --> SS2["service-store"]
  SH --> LDB["local-db"]
  SH --> GO["google-oauth"]

  AU --> SH
  SV --> SH
```

---

## 3. App User process architecture

```mermaid
flowchart TB
  subgraph RENDERER["Renderer process"]
    HTML["remote-user/index.html"]
    UJ["user.js"]
    BR["api-ui-bridge.js"]
    PL["preload → window.centrixLocalUser"]
    HTML --> UJ --> BR --> PL
  end

  subgraph MAIN["Main process · remote-user-main.js"]
    IPC["ipcMain handlers"]
    CONN["connection state<br/>token · sessionKey · profileId"]
    BM["BrowserManager<br/>tabs Map serviceId → WebContentsView"]
    SES["session.fromPartition<br/>tgbyhnujmik-profileId"]
    SR["serverRequest()"]
    HOOK["cookie dump hook optional"]
  end

  subgraph DISK["userData mkvhszparoue"]
    SB["session.bin"]
    DK["device-key.bin"]
    LOG["centrix-app-user.log"]
    CJ["cookies-dump-*.json"]
  end

  PL <-->|invoke / on| IPC
  IPC --> CONN
  IPC --> BM
  BM --> SES
  CONN --> SR
  SR -->|HTTPS| API["Phase-B API"]
  CONN <--> SB
  CONN <--> DK
  BM --> HOOK --> CJ
  IPC --> LOG
```

---

## 4. Auth + connect sequence

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant R as Renderer
  participant M as App User main
  participant G as Google OAuth<br/>system browser
  participant S as Phase-B API

  U->>R: Login with Google
  R->>M: connection:login-google
  M->>G: open consent + loopback PKCE
  G-->>M: authorization code
  M->>S: POST /api/auth/google<br/>{code, deviceId, deviceJkt}
  S-->>M: connection{token, sessionKey,<br/>profileId, deviceId, expiresAt, serverUrl}
  M->>M: saveSession → session.bin
  M->>S: GET /api/health
  M->>S: GET /api/services
  S-->>M: profilePool, services[]
  M->>S: POST /api/profile/lock
  alt free / same device / stale
    S-->>M: ok + revision
    M->>M: startHeartbeat, profile poll
    M-->>R: connected
  else other device live
    S-->>M: device_active
    M-->>R: needTakeover UI
  end
```

---

## 5. Open service + pool cookie load

```mermaid
sequenceDiagram
  autonumber
  participant R as Renderer
  participant M as App User main
  participant S as Phase-B API
  participant P as RAM partition<br/>tgbyhnujmik-*
  participant W as WebContentsView<br/>service tab
  participant H as Cookie hook

  R->>M: browser:open-service(grok-heavy)
  M->>M: profilePoolMode?
  M->>S: GET /api/profile/export?service=grok-heavy&includeStorage=1<br/>+ X-CentriX-Sig + DPoP + Attest
  Note over S: Export gate: interaction, score, sig, jkt
  S-->>M: { encrypted, revision, assignedProfile, rulesRevision }
  M->>M: decryptSnapshot(sessionKey) → snapshot v1
  M->>M: captureProfileUiRules(snapshot)
  M->>P: importProfileSnapshot<br/>cookies.set + localStorage origins
  M->>P: markPoolDomainOwner(service)
  M->>W: loadURL(https://grok.com)
  W->>W: DOM ready / timeout
  W-->>M: service-open-ready
  opt hook installed
    M->>H: session.cookies.get({})
    H->>H: write cookies-dump-grok-heavy.json
  end
  M-->>R: browser state ready
```

---

## 6. Snapshot data model

```mermaid
flowchart TB
  ENV["HTTP response"]
  ENV --> ENC["encrypted: {enc:aesgcm, iv, tag, data}"]
  ENV --> REV["revision"]
  ENV --> AP["assignedProfile · rulesRevision"]
  ENV --> SUM["summary counts"]

  ENC -->|AES-256-GCM<br/>sessionKey 32B| SNAP["Snapshot v1"]

  SNAP --> V["version: 1"]
  SNAP --> PID["profileId"]
  SNAP --> AT["exportedAt"]
  SNAP --> OR["origins[]"]
  SNAP --> CK["cookies[] CookieItem"]
  SNAP --> ST["storage[] OriginStorage"]
  SNAP --> UR["uiRules[] optional"]

  CK --> C1["name value domain path"]
  CK --> C2["secure httpOnly session"]
  CK --> C3["expirationDate sameSite url"]

  ST --> S1["origin"]
  ST --> S2["localStorage map"]
  ST --> S3["sessionStorage map"]
```

---

## 7. Lock / takeover full sequence

```mermaid
sequenceDiagram
  autonumber
  participant A as Device A holder
  participant S as API Server<br/>activeDevices Map
  participant B as Device B challenger

  Note over A,S: A already locked, heartbeat lastBeat++

  B->>S: POST /api/auth/google → token B
  B->>S: POST /api/profile/lock
  S->>S: claimActiveDevice: A live ≠ B
  S-->>B: fail reason=device_active<br/>activeDevice=A

  B->>B: pendingTakeover = connB<br/>UI confirm kick

  B->>S: POST /api/profile/takeover
  S->>S: rec.evictAt=now, evictBy=B
  S-->>B: evicting, graceMs=5000

  loop A poll ~5s
    A->>S: GET /api/profile/revision
    S-->>A: evict:{pending:true, graceMs, sinceMs}
  end

  A->>A: evictionInProgress countdown
  A->>S: optional POST /api/profile/import push
  A->>S: POST /api/profile/release
  A->>S: POST /api/auth/self-revoke
  A->>A: clearSession logout

  loop B retry lock ≤16s
    B->>S: POST /api/profile/lock
    alt A released or force >~9s
      S->>S: setActiveHolder(B) · maybe revoke A
      S-->>B: ok
    else still grace
      S-->>B: takeover_pending
    end
  end
```

### Takeover state machine

```mermaid
stateDiagram-v2
  [*] --> NoHolder
  NoHolder --> HolderA: lock(A)
  HolderA --> HolderA: heartbeat A
  HolderA --> NoHolder: release / self-revoke / TTL expire
  HolderA --> DeviceActive: lock(B≠A)
  DeviceActive --> HolderA: B cancel
  DeviceActive --> Evicting: takeover(B)
  Evicting --> HolderB: A releases OR force ~9s
  Evicting --> Evicting: B lock → takeover_pending
  HolderB --> NoHolder: release B
  HolderB --> DeviceActive: lock(C≠B)
```

---

## 8. Request security layers

```mermaid
flowchart LR
  REQ["serverRequest(path)"]
  REQ --> H1["Authorization: Bearer token"]
  REQ --> H2["X-CentriX-App-Key<br/>CF WAF skip friction"]
  REQ --> H3["X-CentriX-User deviceId"]
  REQ --> H4["X-CentriX-Profile profileId"]
  REQ --> H5["X-CentriX-Session sessionKey"]
  REQ --> H6["X-CentriX-Attest HMAC"]
  REQ --> H7["X-CentriX-Proof DPoP Ed25519"]
  REQ --> H8["User-Agent CentriXAppUser/3.6.16"]
  REQ --> H9["X-CentriX-Sig only export"]

  H1 & H2 & H3 & H4 & H5 & H6 & H7 & H8 & H9 --> NET["HTTPS → Cloudflare → Phase-B"]
```

---

## 9. Cookie path: API → disk → Chrome

```mermaid
flowchart LR
  subgraph SERVER
    CUST["Custodian partition<br/>persist:nkkqiwedoap-*"]
    EXP["GET /api/profile/export"]
    CUST --> EXP
  end

  subgraph APPUSER
    DEC["decrypt AES-GCM"]
    IMP["importProfileSnapshot"]
    RAM["tgbyhnujmik-* RAM"]
    WEB["loadURL service"]
    HOOK["cookies.get dump"]
    EXP --> DEC --> IMP --> RAM --> WEB
    RAM --> HOOK
  end

  subgraph TOOLS
    PICK["export-pick-service.sh"]
    J2["cookies/&lt;svc&gt;/*.json J2TEAM"]
    IMPC["import-cookies-to-chrome.sh"]
    CDP["CDP Storage.setCookies"]
    HOOK --> PICK --> J2 --> IMPC --> CDP
  end

  subgraph BROWSER
    CHR["Chrome isolated profile"]
    SITE["chatgpt / grok / …"]
    CDP --> CHR --> SITE
  end
```

---

## 10. IPC map (App User)

```mermaid
flowchart TB
  UI["Renderer UI"]

  UI --> C["connection:*"]
  UI --> P["profile:*"]
  UI --> B["browser:*"]
  UI --> A["account / portal / activity"]
  UI --> W["window / version / update"]

  C --> C1["login-google"]
  C --> C2["connect · disconnect"]
  C --> C3["takeover · cancel-takeover"]
  C --> C4["state"]

  P --> P1["pull · push"]

  B --> B1["open-service"]
  B --> B2["reload · home · back · forward"]
  B --> B3["set-bounds · state"]

  A --> A1["me · logout · change-password"]
  A --> A2["portal:summary · org-* · plan-*"]
  A --> A3["topup · support · livechat"]
  A --> A4["activity · url-history"]
```

---

## 11. Partition & same-domain collision

```mermaid
flowchart TB
  PID["profileId = default"]
  PID --> SES["ONE session<br/>tgbyhnujmik-default"]

  SES --> T1["tab chatgpt"]
  SES --> T2["tab notebooklm<br/>GPT-5.5 Pro"]
  SES --> T3["tab grok-heavy"]
  SES --> T4["tab claude"]

  T1 & T2 --> DOM["same registrable domain<br/>chatgpt.com"]
  DOM --> CLB["cookie clobber risk"]
  CLB --> FIX["poolDomainOwner<br/>force re-pull on open"]

  T3 --> XAI["grok.com + x.ai cookies"]
  T4 --> CLA["claude.ai cookies"]
```

---

## 12. Export gate (server)

```mermaid
flowchart TD
  E["GET /api/profile/export"]
  E --> I{"interacted recently?<br/>health/services/heartbeat"}
  I -->|no| B1["403 no-client-interaction"]
  I -->|yes| A{"strict: attest OK?"}
  A -->|no| B2["403 attestation"]
  A -->|yes| G{"require sig?"}
  G -->|bad| B3["403 bad-signature"]
  G -->|ok| D{"bind device jkt?"}
  D -->|fail| B4["403 device-binding"]
  D -->|ok| R{"risk score ≥ 70?"}
  R -->|yes strict| B5["403 risk"]
  R -->|no| OK["200 encrypted snapshot"]
```

---

## 13. Tooling integration (this repo)

```mermaid
flowchart LR
  APP["CentriX App User<br/>+ install-hook"]
  APP -->|open service| DUMP["USERDATA/cookies-dump-*.json"]
  DUMP --> PICK["export-pick-service.sh"]
  PICK --> OUT["cookies/&lt;service&gt;/<br/>host.json · accounts.x.ai.json · .full.json"]
  OUT --> IMP["import-cookies-to-chrome.sh"]
  IMP --> CH[".chrome-cookie-profile"]
  PICK -->|--chrome| IMP
```

---

## 14. Default service catalog

```mermaid
mindmap
  root((DEFAULT_SERVICES))
    Chat
      chatgpt
      notebooklm
      claude
      gemini
      microsoft-copilot
      grok
      deepseek
      mistral
      poe
      perplexity
    Media
      midjourney
      elevenlabs
```

---

## 15. C4-style containers

```mermaid
C4Context
  title CentriX cookie/session ecosystem

  Person(user, "User", "Mac, CentriX account")
  System(app, "CentriX App User", "Electron shell, pool consumer")
  System_Ext(api, "Phase-B API", "auth, lock, profile export")
  System_Ext(ai, "AI Web Apps", "ChatGPT, Grok, Claude…")
  System(tools, "centrix-wine-tools", "dump export Chrome inject")

  Rel(user, app, "login Google, open services")
  Rel(app, api, "HTTPS Bearer+DPoP")
  Rel(api, app, "encrypted cookie snapshot")
  Rel(app, ai, "embedded Chromium + cookies")
  Rel(app, tools, "cookies-dump JSON")
  Rel(tools, ai, "Chrome CDP cookies")
```

> Note: C4 may need a Mermaid C4 plugin; if preview fails, use diagrams 1–14.

---

## File index

| # | Diagram |
|---|---------|
| 1 | System overview |
| 2 | asar monorepo |
| 3 | Process architecture |
| 4 | Auth + connect |
| 5 | Open service + pool |
| 6 | Snapshot model |
| 7 | Lock/takeover + state machine |
| 8 | Request headers |
| 9 | Cookie pipeline to Chrome |
| 10 | IPC map |
| 11 | Partition collision |
| 12 | Export gate |
| 13 | Repo tools |
| 14 | Service catalog mindmap |
| 15 | C4 context |
