const { contextBridge, ipcRenderer } = require("electron");

const validEvents = new Set([
  "browser:title",
  "browser:loading",
  "browser:navigation",
  "browser:error"
]);

contextBridge.exposeInMainWorld("centrixDesktop", {
  mode: () => ipcRenderer.invoke("app:mode"),
  services: {
    list: () => ipcRenderer.invoke("services:list"),
    reset: () => ipcRenderer.invoke("services:reset"),
    save: (services) => ipcRenderer.invoke("services:save", services)
  },
  browser: {
    setBounds: (bounds) => ipcRenderer.invoke("browser:set-bounds", bounds),
    openService: (payload) => ipcRenderer.invoke("browser:open-service", payload),
    reload: () => ipcRenderer.invoke("browser:reload"),
    state: () => ipcRenderer.invoke("browser:state")
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
