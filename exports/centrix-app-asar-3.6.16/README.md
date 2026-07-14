# CentriX App User — asar export (3.6.16)

Folder riêng chứa **toàn bộ extract `app.asar`** + tài liệu phân rã API / snapshot / lock-takeover.

> **Cảnh báo:** Source có secret build-time (App-Key, attest default, Google OAuth client).  
> Không commit public. Đã gợi ý gitignore `exports/`.

## Cấu trúc

```text
exports/centrix-app-asar-3.6.16/
├── README.md                 ← file này
├── source/                   ← extract đầy đủ app.asar
│   ├── package.json          main: src/remote-user-main.js
│   ├── README.md
│   ├── MIGRATION_PLAN.md
│   └── src/                  ...
├── docs/                     ← phân tích
│   ├── 00-architecture.md
│   ├── 01-snapshot-schema.md
│   ├── 02-lock-takeover.md
│   ├── 03-api-surface.md
│   └── 04-module-map.md
└── meta/
    ├── app.asar              ← bản copy raw
    ├── app.asar.bak-cookie-export
    ├── EXTRACT-INFO.txt
    ├── FILE-INVENTORY.txt
    ├── JS-LOC.txt
    ├── API-ROUTES.txt
    ├── IPC-HANDLERS-APP-USER.txt
    └── DEFAULT-SERVICES.json
```

## Entry points

| Entry | Role |
|-------|------|
| `source/src/remote-user-main.js` | **App User** (build đang cài) |
| `source/src/remote-tabs-main.js` | App Server (HTTP `/api/*`) |
| `source/src/remote-server-main.js` | Server shell |
| `source/src/desktop-*-main.js` | Desktop User/Admin |
| `source/src/remote-control-main.js` | Remote control POC :19777 |

## API live (máy này)

```text
https://api-centrixapp-quang.centrix.asia
  GET /api/health → Phase-B Backend, profilePool=true, latestApp=3.6.16
```

## Đọc theo thứ tự

1. [docs/00-architecture.md](docs/00-architecture.md) — monorepo + partition + flow  
2. [docs/01-snapshot-schema.md](docs/01-snapshot-schema.md) — payload export cookies  
3. [docs/02-lock-takeover.md](docs/02-lock-takeover.md) — single device  
4. [docs/03-api-surface.md](docs/03-api-surface.md) — routes  
5. [docs/04-module-map.md](docs/04-module-map.md) — file map + IPC  
6. [docs/05-full-diagrams.md](docs/05-full-diagrams.md) — full Mermaid diagrams  
7. [docs/full-diagrams.html](docs/full-diagrams.html) — **mở browser xem diagram**  

## Tái extract

```bash
ASAR="wine-prefix-centrix/drive_c/users/$USER/AppData/Local/Programs/CentriX App User/resources/app.asar"
OUT="exports/centrix-app-asar-3.6.16"
npx --yes asar extract "$ASAR" "$OUT/source"
```

## Liên quan tool repo

| Tool | Việc |
|------|------|
| `export-centrix-cookies.sh` | Hook dump RAM session → `cookies-dump-*.json` |
| `export-pick-service.sh` | Convert dump → J2TEAM |
| `import-cookies-to-chrome.sh` | CDP import Chrome profile riêng |
