// The TikTok window: where the creator watches Groot post. One window, two parts:
//   - the bar on top (our own page, bar.html): what Groot is doing, a Stop button, and in Manual
//     mode "Done, next video";
//   - TikTok itself below, in its own persistent session (`persist:tiktok`), so the creator logs in
//     once and stays logged in, kept apart from the app's own session and cookies.
// The TikTok session gets no permissions (no camera, mic, notifications…), downloads nothing, and
// shows only TikTok and TikTok's own log-in providers. Nothing of ours is injected into TikTok's page.
"use strict";

const path = require("path");
const { isTikTokUrl, isLoginProviderUrl } = require("./rules");

const PARTITION = "persist:tiktok";
const BAR_PARTITION = "gvd-groot-bar";
const BAR_H = 56;
const BG = "#09090b";

let prepared = new WeakSet();

// Once per session: the rules for the TikTok session.
function prepareSession(ses, { userAgent, log }) {
  if (prepared.has(ses)) return;
  prepared.add(ses);
  // A plain Chrome user agent (the app's own adds a GoViralDesktop token TikTok has no need for).
  if (userAgent) ses.setUserAgent(userAgent.replace(/\s(?:GoViralDesktop|Electron|goviral-desktop)\/\S+/g, ""));
  ses.setPermissionRequestHandler((_wc, permission, cb) => { log("tiktok permission refused", permission); cb(false); });
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (_e, item) => { log("tiktok download refused", item.getFilename()); item.cancel(); });
}

const isTikTokSession = (ses, electronSession) => !!ses && (ses === electronSession.fromPartition(PARTITION) || ses === electronSession.fromPartition(BAR_PARTITION));

// Navigation inside the TikTok window: TikTok, or a log-in provider. Anything else is refused.
function guardTikTokContents(contents, { allowLocal, log, popupOptions }) {
  const ok = (url) => isTikTokUrl(url, { allowLocal }) || isLoginProviderUrl(url) || url === "about:blank";
  const guard = (details) => { if (!ok(details.url)) { log("tiktok navigation refused", details.url); details.preventDefault(); } };
  contents.on("will-navigate", (d) => { if (d.isMainFrame !== false) guard(d); });
  contents.on("will-redirect", (d) => { if (d.isMainFrame) guard(d); });
  contents.on("will-attach-webview", (e) => e.preventDefault());
  // TikTok's "log in with Google" opens a popup: allowed, in the same session, for those hosts only.
  contents.setWindowOpenHandler(({ url }) => (ok(url) && url !== "about:blank" ? { action: "allow", overrideBrowserWindowOptions: popupOptions() } : { action: "deny" }));
  contents.on("did-create-window", (child) => guardTikTokContents(child.webContents, { allowLocal, log, popupOptions }));
}

function createTikTokWindow({ electron, allowLocal = false, show = true, log = () => {}, icon, userAgent }) {
  const { BaseWindow, WebContentsView, ipcMain, session } = electron;
  const ses = session.fromPartition(PARTITION);
  prepareSession(ses, { userAgent, log });

  const win = new BaseWindow({ width: 1280, height: 900, minWidth: 900, minHeight: 640, title: "Groot is posting to TikTok", backgroundColor: BG, show, icon, autoHideMenuBar: true });
  const secure = (extra) => ({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, backgroundThrottling: false, ...extra });
  const bar = new WebContentsView({ webPreferences: secure({ partition: BAR_PARTITION, preload: path.join(__dirname, "bar-preload.js") }) });
  const tiktok = new WebContentsView({ webPreferences: secure({ partition: PARTITION, spellcheck: false }) });
  bar.setBackgroundColor(BG);
  win.contentView.addChildView(tiktok);
  win.contentView.addChildView(bar);
  const layout = () => {
    const { width, height } = win.getContentBounds();
    bar.setBounds({ x: 0, y: 0, width, height: BAR_H });
    tiktok.setBounds({ x: 0, y: BAR_H, width, height: Math.max(0, height - BAR_H) });
  };
  layout();
  win.on("resize", layout);
  bar.webContents.loadFile(path.join(__dirname, "bar.html")).catch((e) => log("bar load failed", e));
  guardTikTokContents(tiktok.webContents, {
    allowLocal, log,
    popupOptions: () => ({ width: 520, height: 720, autoHideMenuBar: true, backgroundColor: BG, webPreferences: secure({ partition: PARTITION }) }),
  });
  // A video that stopped half way (a product not in the showcase) leaves a half-filled upload page:
  // TikTok's "leave this page?" must not hold the next video back. Groot moves on; nothing was posted.
  tiktok.webContents.on("will-prevent-unload", (e) => { log("tiktok unload prompt skipped"); e.preventDefault(); });
  // The bar's own page never goes anywhere.
  bar.webContents.on("will-navigate", (d) => d.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const listeners = { stop: new Set(), next: new Set() };
  const onBar = (e, which) => { if (e.sender === bar.webContents) for (const fn of listeners[which]) fn(); };
  const stopHandler = (e) => onBar(e, "stop");
  const nextHandler = (e) => onBar(e, "next");
  ipcMain.on("gvd:tiktok-bar:stop", stopHandler);
  ipcMain.on("gvd:tiktok-bar:next", nextHandler);
  let closed = false;
  win.on("closed", () => {
    closed = true;
    ipcMain.removeListener("gvd:tiktok-bar:stop", stopHandler);
    ipcMain.removeListener("gvd:tiktok-bar:next", nextHandler);
    for (const fn of listeners.stop) fn();
    try { bar.webContents.close(); tiktok.webContents.close(); } catch { /* gone */ }
  });

  let lastStatus = null;
  bar.webContents.on("did-finish-load", () => { if (lastStatus) bar.webContents.send("gvd:tiktok-bar:status", lastStatus); });
  return {
    win,
    contents: tiktok.webContents,
    barContents: bar.webContents,
    setStatus(s) { lastStatus = s; if (!closed && !bar.webContents.isDestroyed()) bar.webContents.send("gvd:tiktok-bar:status", s); },
    onStop(fn) { listeners.stop.add(fn); return () => listeners.stop.delete(fn); },
    onNext(fn) { listeners.next.add(fn); return () => listeners.next.delete(fn); },
    focus() { if (!closed) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } },
    close() { if (!closed) win.close(); },
    isClosed: () => closed,
  };
}

module.exports = { createTikTokWindow, isTikTokSession, PARTITION, BAR_PARTITION };
