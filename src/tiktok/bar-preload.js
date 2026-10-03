// The TikTok window's bar (bar.html): it gets the status and can say Stop or Next. Nothing else.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grootBar", Object.freeze({
  stop: () => ipcRenderer.send("gvd:tiktok-bar:stop"),
  next: () => ipcRenderer.send("gvd:tiktok-bar:next"),
  onStatus: (cb) => {
    const fn = (_e, s) => { try { cb(s); } catch { /* the page's own problem */ } };
    ipcRenderer.on("gvd:tiktok-bar:status", fn);
    return () => ipcRenderer.removeListener("gvd:tiktok-bar:status", fn);
  },
}));
