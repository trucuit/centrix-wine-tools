const { contextBridge, ipcRenderer } = require("electron");

const validEvents = new Set([
  "browser:title",
  "browser:loading",
  "browser:navigation",
  "browser:network",
  "browser:console",
  "browser:error",
  "browser:chrome-visibility"
]);

contextBridge.exposeInMainWorld("centrixBrowser", {
  open: (payload) => ipcRenderer.invoke("browser:open", payload),
  navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
  back: () => ipcRenderer.invoke("browser:back"),
  forward: () => ipcRenderer.invoke("browser:forward"),
  reload: () => ipcRenderer.invoke("browser:reload"),
  state: () => ipcRenderer.invoke("browser:state"),
  chromeState: () => ipcRenderer.invoke("browser:chrome-state"),
  setChromeVisible: (visible) => ipcRenderer.invoke("browser:set-chrome-visible", visible),
  screenshot: () => ipcRenderer.invoke("browser:screenshot"),
  devtools: () => ipcRenderer.invoke("browser:devtools"),
  on: (channel, callback) => {
    if (!validEvents.has(channel)) {
      throw new Error(`Unsupported event channel: ${channel}`);
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
