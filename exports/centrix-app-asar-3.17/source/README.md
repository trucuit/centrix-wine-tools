# CentriX Embedded Browser POC

This is a focused proof of concept for replacing the Orbita/GoLogin launcher with an in-app Electron browser.

## Run

```powershell
cmd /c npm install
cmd /c npm run user
cmd /c npm run admin
```

The user app opens the first configured service by default. The admin app edits the shared service list and URLs stored at:

```text
%APPDATA%\CentriX Desktop App\services.json
```

To build the two desktop app bundles:

```powershell
cmd /c npm run build:desktop
```

Outputs:

```text
dist\CentriXDesktopUserPortable\CentriX Desktop User.exe
dist\CentriXDesktopAdminPortable\CentriX Desktop Admin.exe
```

The original proof-of-concept browser shell is still available with:

```powershell
cmd /c npm run poc
```

The in-app browser opens without the debug URL toolbar by default. Press `Ctrl+Shift+U` to show or hide that toolbar while the app is running. To start with the toolbar visible, set:

```powershell
$env:CENTRIX_SHOW_BROWSER_CHROME = "1"
cmd /c npm start
```

## Remote Claude Web UI

```powershell
cmd /c npm run remote
```

This starts a local control page:

```text
http://127.0.0.1:19777/
```

The control page streams screenshots from a real Electron browser window opened at `https://claude.ai/login`, then sends mouse, keyboard, navigation, account, proxy, resize, and DevTools commands back to that browser.

## Shared Browser Tabs

```powershell
cmd /c npm run tabs
```

This starts a Windows test server where multiple remote-control clients map to separate server-side browser tabs while sharing one Electron profile/session. It opens two tabs by default:

```text
http://127.0.0.1:19778/?tabId=tab-a
http://127.0.0.1:19778/?tabId=tab-b
```

Both tabs load `https://chat.zalo.me/` and use the same shared partition:

```text
persist:centrix-shared-browser-default
```

To build only this test app:

```powershell
cmd /c npm run build:tabs
```

Output:

```text
dist\CentriXSharedBrowserTabsPortable\CentriX Shared Browser Tabs.exe
```

## LAN Server / User Test Pair

```powershell
cmd /c npm run server
cmd /c npm run remote-user
```

The Server app binds to `0.0.0.0:19778`, creates a local token, keeps the shared browser/profile, and exposes LAN URLs for another PC. The User app logs in with:

```text
Server URL: http://SERVER-LAN-IP:19778
Token: shown in the Server app console/window URL
User: local-user, user-a, user-b, or another unique user id
Profile: default
```

### Docker Local DB

The Server app can store per-user service visibility, UI hide rules, activity, and localStorage rows in Docker Desktop. Start the local DB before opening the Server app:

```powershell
cmd /c npm run db:start
```

This creates the `centrix-local-db` container and exposes a local-only DB API:

```text
http://127.0.0.1:19779
```

The Electron Server automatically uses this Docker DB when it is healthy. If Docker Desktop or the DB container is not running, it falls back to:

```text
%APPDATA%\CentriX Shared Browser Server\local-db.json
```

To stop only the DB container:

```powershell
cmd /c npm run db:stop
```

The portable Server bundle includes:

```text
Start CentriX Local DB (Docker).cmd
Stop CentriX Local DB (Docker).cmd
```

To build the two portable test apps:

```powershell
cmd /c npm run build:remote-pair
```

Outputs:

```text
dist\CentriXAppServerPortable\CentriX App Server.exe
dist\CentriXAppUserPortable\CentriX App User.exe
```

## What It Proves

- Browser is embedded inside the Electron window.
- Each account uses its own persistent Electron partition.
- Proxy can be set per account before navigation.
- App receives current URL, title, loading state, network summaries, and screenshots.
- No Orbita or GoLogin browser process is used.
- A separate local web UI can control a real `claude.ai` browser session.

## Migration Target

The same shape can replace the existing CentriX `open-chrome` launcher:

```text
CentriX UI
  -> BrowserSessionManager.open(accountId, url, proxy)
  -> Electron WebContentsView or BrowserView fallback
  -> account partition / proxy / cookie storage
  -> network observer
  -> agent/browser context bridge
```

## Notes

This is not a Cloudflare bypass. It is a visible, user-operated embedded browser with persistent sessions.
