# CentriX Orbita Replacement Plan

## Current Constraint

The installed CentriX folder is a packaged Electron build. The runtime entry is:

```text
resources/app.asar
  -> main.js
  -> config.jsc
  -> servers/open-chrome.jsc
```

Because the real launcher logic is compiled through `bytenode`, do not patch the `.jsc` files directly. The clean replacement should be applied in the CentriX source project before packaging.

## Replacement Map

```text
Orbita/GoLogin chrome.exe
  -> Electron WebContentsView or BrowserView

GoLogin profile folder
  -> Electron persistent session partition
     persist:centrix-account-${accountId}

Chrome proxy launch args
  -> session.setProxy({ proxyRules })

Puppeteer/CDP page state
  -> webContents navigation, title, loading, screenshot, DevTools

Network capture
  -> session.webRequest.onBeforeRequest/onCompleted/onErrorOccurred
```

## Source Integration Steps

1. Replace the source implementation behind `open-chrome` with `BrowserSessionManager.open({ accountId, url, proxyRules })`.
2. Keep account isolation by deriving one Electron partition per CentriX account.
3. Move proxy setup before the first navigation for that account/session.
4. Preserve the existing CentriX UI contract by returning URL, title, loading state, screenshot path, and network events over IPC.
5. If the current Orbita extensions are still required, load them through Electron session extension APIs during account initialization.
6. Package the final app without `browsers/orbita-browser` once the embedded browser path covers login, session persistence, proxy, and capture.

## Cloudflare/CAPTCHA Position

This architecture is not a bypass layer. It is a visible embedded Chromium session. Cloudflare success still depends on normal browser reputation signals such as IP, proxy quality, prior cookies, TLS/browser fingerprint, user interaction, and target-site policy.
