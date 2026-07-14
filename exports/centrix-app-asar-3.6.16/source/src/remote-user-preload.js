const { contextBridge, ipcRenderer } = require("electron");

const validEvents = new Set([
  "browser:title",
  "browser:loading",
  "browser:navigation",
  "browser:error",
  "browser:prepare",
  "browser:download",
  "credit:usage",
  "profile:sync-state",
  "profile:background-sync",
  "profile:update-available",
  "connection:expired",
  "connection:restored",
  "session:evicting",
  "version:lock",
  "version:unlock",
  "update:available",
  "update:progress",
  "update:installing",
  "update:launched",
  "update:error",
  "account:lock",
  "account:unlock",
  "window:maximized",
  "menu:new-chat",
  "menu:open-recent-chat",
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

contextBridge.exposeInMainWorld("centrixLocalUser", {
  connection: {
    // login (password) removed — Google-only client; use loginGoogle.
    loginGoogle: () => ipcRenderer.invoke("connection:login-google"),
    state: () => ipcRenderer.invoke("connection:state"),
    connect: (payload) => ipcRenderer.invoke("connection:connect", payload),
    disconnect: () => ipcRenderer.invoke("connection:disconnect"),
    takeover: () => ipcRenderer.invoke("connection:takeover"),
    cancelTakeover: () => ipcRenderer.invoke("connection:cancel-takeover")
  },
  profile: {
    pull: () => ipcRenderer.invoke("profile:pull"),
    push: () => ipcRenderer.invoke("profile:push")
  },
  version: {
    download: () => ipcRenderer.invoke("version:download"),
    quit: () => ipcRenderer.invoke("version:quit"),
    current: () => ipcRenderer.invoke("version:current")
  },
  update: {
    install: () => ipcRenderer.invoke("update:install"),
    cancel: () => ipcRenderer.invoke("update:cancel"),
    skip: (version) => ipcRenderer.invoke("update:skip", version),
    setAuto: (on) => ipcRenderer.invoke("update:setAuto", on),
    check: () => ipcRenderer.invoke("update:check")
  },
  services: {
    list: () => ipcRenderer.invoke("services:list"),
    refresh: () => ipcRenderer.invoke("services:refresh")
  },
  account: {
    me: () => ipcRenderer.invoke("account:me"),
    changePassword: (payload) => ipcRenderer.invoke("account:change-password", payload),
    logout: () => ipcRenderer.invoke("account:logout")
  },
  activity: {
    list: (payload) => ipcRenderer.invoke("activity:list", payload)
  },
  urlHistory: {
    list: (payload) => ipcRenderer.invoke("url-history:list", payload),
    push: (payload) => ipcRenderer.invoke("url-history:push", payload)
  },
  portal: {
    summary: () => ipcRenderer.invoke("portal:summary"),
    topupRequest: (payload) => ipcRenderer.invoke("portal:topup-request", payload),
    supportTicket: (payload) => ipcRenderer.invoke("portal:support-ticket", payload),
    livechatSend: (payload) => ipcRenderer.invoke("portal:livechat-send", payload),
    orgStructure: (payload) => ipcRenderer.invoke("portal:org-structure", payload),
    addDepartment: (payload) => ipcRenderer.invoke("portal:org-add-department", payload),
    addMember: (payload) => ipcRenderer.invoke("portal:org-add-member", payload),
    allocate: (payload) => ipcRenderer.invoke("portal:org-allocate", payload),
    orgUpdateBilling: (payload) => ipcRenderer.invoke("portal:org-update-billing", payload),
    orgReport: (payload) => ipcRenderer.invoke("portal:org-report", payload),
    orgSetEntitlement: (payload) => ipcRenderer.invoke("portal:org-set-entitlement", payload),
    orgRemoveMember: (payload) => ipcRenderer.invoke("portal:org-remove-member", payload),
    orgDeleteDepartment: (payload) => ipcRenderer.invoke("portal:org-delete-department", payload),
    orgSetMemberRole: (payload) => ipcRenderer.invoke("portal:org-set-role", payload),
    orgSetMemberLocked: (payload) => ipcRenderer.invoke("portal:org-set-locked", payload),
    planMe: (payload) => ipcRenderer.invoke("portal:plan-me", payload),
    planSelfDowngrade: (payload) => ipcRenderer.invoke("portal:plan-self-downgrade", payload),
    updateUserBilling: (payload) => ipcRenderer.invoke("portal:update-user-billing", payload),
    deleteAccount: (payload) => ipcRenderer.invoke("portal:delete-account", payload)
  },
  win: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    moveBy: (delta) => ipcRenderer.invoke("window:move-by", delta),
    bounds: () => ipcRenderer.invoke("window:bounds")
  },
  browser: {
    setBounds: (bounds) => ipcRenderer.invoke("browser:set-bounds", bounds),
    openService: (payload) => ipcRenderer.invoke("browser:open-service", payload),
    reload: () => ipcRenderer.invoke("browser:reload"),
    home: () => ipcRenderer.invoke("browser:home"),
    back: () => ipcRenderer.invoke("browser:back"),
    forward: () => ipcRenderer.invoke("browser:forward"),
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
