"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function safeWindow(BrowserWindow, getWindow) {
  const focused = BrowserWindow?.getFocusedWindow?.();
  if (focused && !focused.isDestroyed()) return focused;
  const main = getWindow?.();
  if (main && !main.isDestroyed?.()) return main;
  return null;
}

function safeWebContents(BrowserWindow, getWindow) {
  return safeWindow(BrowserWindow, getWindow)?.webContents || null;
}

function sendRenderer(BrowserWindow, getWindow, channel, payload = {}) {
  const sent = new Set();
  const send = (win) => {
    if (!win || win.isDestroyed?.()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed?.() || sent.has(wc.id)) return;
    sent.add(wc.id);
    wc.send(channel, payload);
  };
  send(BrowserWindow?.getFocusedWindow?.());
  send(getWindow?.());
}

function zoomBy(BrowserWindow, getWindow, delta) {
  const wc = safeWebContents(BrowserWindow, getWindow);
  if (!wc || wc.isDestroyed?.()) return;
  const current = Number(wc.getZoomLevel?.() || 0);
  wc.setZoomLevel?.(Math.max(-3, Math.min(5, current + delta)));
}

function resetZoom(BrowserWindow, getWindow) {
  const wc = safeWebContents(BrowserWindow, getWindow);
  if (!wc || wc.isDestroyed?.()) return;
  wc.setZoomLevel?.(0);
}

async function exportConversation(options) {
  const { BrowserWindow, dialog, getWindow, appName } = options;
  const win = safeWindow(BrowserWindow, getWindow);
  const wc = win?.webContents;
  if (!win || !wc || wc.isDestroyed?.()) return;

  const result = await dialog.showSaveDialog(win, {
    title: "Xuat cuoc tro chuyen",
    defaultPath: `centrix-conversation-${new Date().toISOString().slice(0, 10)}.md`,
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "Text", extensions: ["txt"] },
      { name: "JSON", extensions: ["json"] }
    ]
  });
  if (result.canceled || !result.filePath) return;

  const bodyText = await wc.executeJavaScript(
    "window.getSelection?.().toString?.() || document.body?.innerText?.slice(0, 50000) || ''",
    true
  ).catch(() => "");
  const ext = path.extname(result.filePath).toLowerCase();
  const exportedAt = new Date().toISOString();
  let content = bodyText || "";
  if (ext === ".json") {
    content = JSON.stringify({ app: appName, exportedAt, text: bodyText }, null, 2);
  } else if (ext === ".md") {
    content = `# ${appName} conversation export\n\nExported: ${exportedAt}\n\n${bodyText || "_No visible chat text captured._"}\n`;
  }
  await fs.writeFile(result.filePath, content, "utf8");
}

function recentChatSubmenu(options) {
  const { BrowserWindow, getWindow } = options;
  const items = typeof options.recentChats === "function" ? options.recentChats() : [];
  if (!Array.isArray(items) || !items.length) {
    return [{ label: "Chua co chat gan day", enabled: false }];
  }
  return items.slice(0, 10).map((item, index) => ({
    label: item.label || item.title || `Chat ${index + 1}`,
    click: () => sendRenderer(BrowserWindow, getWindow, "menu:open-recent-chat", item)
  }));
}

function installCentrixNativeMenu(options) {
  const {
    app,
    Menu,
    BrowserWindow,
    shell,
    dialog,
    getWindow,
    appName = "CentriX AI",
    appKind = "user",
    version = "v3.6.0",
    createWindow
  } = options;

  const notify = (channel, payload) => sendRenderer(BrowserWindow, getWindow, channel, payload);
  const currentWindow = () => safeWindow(BrowserWindow, getWindow);

  const template = [
    {
      label: "File",
      submenu: [
        {
          label: appKind === "server" ? "Them User" : "Chat moi",
          accelerator: "Ctrl+N",
          click: () => notify(appKind === "server" ? "menu:new-user" : "menu:new-chat")
        },
        {
          label: "Mo chat gan day",
          submenu: recentChatSubmenu(options)
        },
        {
          label: "Xuat cuoc tro chuyen",
          accelerator: "Ctrl+S",
          click: () => exportConversation({ ...options, appName }).catch((error) => {
            dialog.showErrorBox("Export failed", error.message || String(error));
          })
        },
        { type: "separator" },
        {
          label: "Cai dat",
          accelerator: "Ctrl+,",
          click: () => notify("menu:open-settings")
        },
        { type: "separator" },
        {
          label: "Thoat",
          accelerator: "Alt+F4",
          click: () => app.quit()
        }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { label: "Sao chep", accelerator: "Ctrl+C", role: "copy" },
        { label: "Dan", accelerator: "Ctrl+V", role: "paste" },
        { label: "Chon tat ca", accelerator: "Ctrl+A", role: "selectAll" },
        { type: "separator" },
        {
          label: "Tim trong chat",
          accelerator: "Ctrl+F",
          click: () => notify("menu:find-chat")
        },
        { type: "separator" },
        {
          label: "Xoa cuoc tro chuyen",
          click: async () => {
            const win = currentWindow();
            const result = await dialog.showMessageBox(win || undefined, {
              type: "warning",
              buttons: ["Xoa", "Huy"],
              defaultId: 1,
              cancelId: 1,
              title: "Xoa cuoc tro chuyen",
              message: "Ban co chac muon xoa cuoc tro chuyen hien tai?"
            });
            if (result.response === 0) notify("menu:delete-chat");
          }
        }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Phong to", accelerator: "Ctrl+Plus", click: () => zoomBy(BrowserWindow, getWindow, 0.5) },
        { label: "Thu nho", accelerator: "Ctrl+-", click: () => zoomBy(BrowserWindow, getWindow, -0.5) },
        { label: "Dat lai zoom", accelerator: "Ctrl+0", click: () => resetZoom(BrowserWindow, getWindow) },
        { type: "separator" },
        { label: "An/hien sidebar", accelerator: "Ctrl+B", click: () => notify("menu:toggle-sidebar") },
        { label: "Doi che do toi/sang", accelerator: "Ctrl+T", click: () => notify("menu:toggle-theme") }
      ]
    },
    {
      label: "Window",
      submenu: [
        { label: "Thu nho cua so", accelerator: "Ctrl+M", click: () => currentWindow()?.minimize?.() },
        {
          label: "Toan man hinh",
          accelerator: "F11",
          click: () => {
            const win = currentWindow();
            if (win) win.setFullScreen(!win.isFullScreen());
          }
        },
        { type: "separator" },
        {
          label: "Luon hien tren cung",
          type: "checkbox",
          click: (item) => currentWindow()?.setAlwaysOnTop?.(item.checked)
        },
        { type: "separator" },
        {
          label: "Cua so moi",
          accelerator: "Ctrl+Shift+N",
          click: () => {
            if (typeof createWindow === "function") createWindow();
            else notify("menu:new-window");
          }
        }
      ]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Huong dan su dung",
          accelerator: "F1",
          click: () => shell.openExternal("https://centrix.ai/docs").catch(() => {})
        },
        {
          label: "Phim tat",
          accelerator: "Ctrl+/",
          click: () => notify("menu:show-shortcuts")
        },
        {
          label: "Kiem tra cap nhat",
          click: () => notify("menu:check-updates")
        },
        { type: "separator" },
        {
          label: "Bao loi / Gop y",
          click: () => shell.openExternal("mailto:support@centrix.ai?subject=CentriX%20AI%20Feedback").catch(() => {})
        },
        {
          label: "Lien he ho tro",
          click: () => notify("menu:contact-support")
        },
        { type: "separator" },
        {
          label: `Ve CentriX AI ${version}`,
          click: () => {
            dialog.showMessageBox(currentWindow() || undefined, {
              type: "info",
              title: "Ve CentriX AI",
              message: `CentriX AI Desktop ${version}`,
              detail: `Build date: ${process.env.CENTRIX_BUILD_DATE || "2026-06-16"}\nLicense: CentriX AI Desktop`
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { installCentrixNativeMenu };
