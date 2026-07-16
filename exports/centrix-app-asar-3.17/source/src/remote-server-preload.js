const { contextBridge, ipcRenderer } = require("electron");

const validEvents = new Set([
  "control-window:maximized",
  "menu:new-user",
  "menu:open-settings",
  "menu:find-chat",
  "menu:delete-chat",
  "menu:toggle-sidebar",
  "menu:toggle-theme",
  "menu:show-shortcuts",
  "menu:check-updates",
  "menu:contact-support",
  "menu:new-window"
]);

contextBridge.exposeInMainWorld("centrixAppServer", {
  win: {
    minimize: () => ipcRenderer.invoke("control-window:minimize"),
    maximize: () => ipcRenderer.invoke("control-window:maximize"),
    close: () => ipcRenderer.invoke("control-window:close"),
    isMaximized: () => ipcRenderer.invoke("control-window:is-maximized")
  },
  on: (channel, callback) => {
    if (!validEvents.has(channel)) {
      throw new Error(`Unsupported event channel: ${channel}`);
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
