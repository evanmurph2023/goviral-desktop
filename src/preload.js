// What the page gets from the desktop shell: window.goviralDesktop = { version, platform } (and,
// on the app's own pages, `tiktok`: Groot posts to TikTok, below),
// so the app can tell it is inside the downloaded app (e.g. hide its own "Install GoViral" card).
// Sandboxed: no Node, no file system, nothing else crosses over.
//
// It also draws the window's top strip on the app's pages: the title bar is folded away (Mac
// traffic lights / the Windows buttons sit over the app), so a dark strip the window is dragged
// by sits above the app, the way the installed web app does it (goviral-ai export-desktop.cjs).
"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const arg = (name) => {
  const hit = (process.argv || []).find((a) => a.startsWith(`--gvd-${name}=`));
  return hit ? hit.slice(`--gvd-${name}=`.length) : "";
};

const ORIGIN = arg("origin");

// Groot posts to TikTok (src/tiktok/*): only on the app's own pages (<origin>/desktop), and the
// main process checks the caller and every field again. post() resolves when the video is posted
// (Auto), filled in and handed over (Manual), failed or stopped; onProgress() hears each step and
// returns the function that stops listening.
const isApp = (() => { try { return location.origin === ORIGIN && /^\/desktop(\/|$)/.test(location.pathname); } catch { return false; } })();
const tiktok = isApp ? Object.freeze({
  post: (req) => ipcRenderer.invoke("gvd:tiktok:post", req),
  stop: () => ipcRenderer.invoke("gvd:tiktok:stop"),
  open: () => ipcRenderer.invoke("gvd:tiktok:open"),
  onProgress: (cb) => {
    const fn = (_e, p) => { try { cb(p); } catch { /* the page's own problem */ } };
    ipcRenderer.on("gvd:tiktok:progress", fn);
    return () => ipcRenderer.removeListener("gvd:tiktok:progress", fn);
  },
}) : undefined;

// The creator's finished videos (src/tiktok/files.js), also on the app's own pages only: folders
// they pick with the system dialog, and files they drop on the window. The page gets names,
// lengths and opaque ids, never a way to read a path it chose itself: addDropped takes the
// dropped File objects and turns them into paths HERE (webUtils.getPathForFile), so only a file the
// creator really dropped (or picked in a file input) can be added. Pass an ARRAY of File
// (Array.from(event.dataTransfer.files)): a FileList does not cross the context bridge.
const files = isApp ? Object.freeze({
  roots: () => ipcRenderer.invoke("gvd:files:roots"),
  pickFolder: (opts) => ipcRenderer.invoke("gvd:files:pick", { remember: !!(opts && opts.remember) }),
  remember: (rootId, on) => ipcRenderer.invoke("gvd:files:remember", { rootId, on: !!on }),
  forget: (rootId) => ipcRenderer.invoke("gvd:files:forget", { rootId }),
  folders: (rootId) => ipcRenderer.invoke("gvd:files:folders", { rootId }),
  videos: (rootId, rel, opts) => ipcRenderer.invoke("gvd:files:videos", { rootId, rel: String(rel || ""), recursive: !!(opts && opts.recursive) }),
  thumbnail: (fileId) => ipcRenderer.invoke("gvd:files:thumb", { fileId }),
  addDropped: (list) => {
    const paths = [];
    for (const f of Array.from(list || []).slice(0, 200)) { try { const p = webUtils.getPathForFile(f); if (p) paths.push(p); } catch { /* not a real file */ } }
    return ipcRenderer.invoke("gvd:files:dropped", paths);
  },
}) : undefined;
// Google Drive: connecting happens in the system browser (Google's own consent page).
const drive = isApp ? Object.freeze({ connect: () => ipcRenderer.invoke("gvd:drive:connect") }) : undefined;

contextBridge.exposeInMainWorld("goviralDesktop", Object.freeze({
  version: arg("version"),
  platform: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : process.platform,
  ...(tiktok ? { tiktok } : {}),
  ...(files ? { files } : {}),
  ...(drive ? { drive } : {}),
}));
const STRIP = Number(arg("titlebar")) || 0;

function addStrip() {
  if (!STRIP || location.origin !== ORIGIN || !location.pathname.startsWith("/desktop")) return;
  if (document.getElementById("gvd-titlebar")) return;
  const style = document.createElement("style");
  style.id = "gvd-titlebar-css";
  style.textContent = `
    #gv-titlebar { display: none !important; }
    #gvd-titlebar { position: fixed; top: 0; left: 0; right: 0; height: ${STRIP}px; background: #09090b; z-index: 2147483647; -webkit-app-region: drag; app-region: drag; -webkit-user-select: none; user-select: none; }
    #root { position: fixed !important; left: 0; right: 0; bottom: 0; top: ${STRIP}px !important; height: auto !important; }
    html.gvd-fullscreen #gvd-titlebar { display: none; }
    html.gvd-fullscreen #root { top: 0 !important; }
  `;
  document.head.appendChild(style);
  const strip = document.createElement("div");
  strip.id = "gvd-titlebar";
  strip.setAttribute("aria-hidden", "true");
  document.body.prepend(strip);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addStrip, { once: true });
else addStrip();

ipcRenderer.on("gvd:fullscreen", (_e, on) => {
  document.documentElement.classList.toggle("gvd-fullscreen", !!on);
});
