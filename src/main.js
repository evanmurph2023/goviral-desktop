// GoViral for Windows and Mac: a window onto https://app.govirall.now/desktop.
//
// The app itself is the website's /desktop build (goviral-ai, scripts/export-desktop.cjs), so it
// updates the moment the website deploys, keeps the site's sign-in cookie and calls the same
// /api. This file is only the shell around it: the window, the menu, links, downloads, deep
// links, permissions, the offline page and updates of the shell itself.
"use strict";

const { app, BrowserWindow, Menu, Notification, clipboard, dialog, session, shell, screen, systemPreferences } = require("electron");
const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

// The app's address. A local build may point elsewhere (GOVIRAL_ORIGIN=http://localhost:3000
// npm start); an installed copy never reads it, so nothing outside can re-point a user's app.
const APP_ORIGIN = (!app.isPackaged && process.env.GOVIRAL_ORIGIN) || "https://app.govirall.now";
const { PROTOCOL, isSafeExternal, makeLinks, originOf } = require("./links");
const { appHome: APP_HOME, isAppUrl, deepLinkTarget, deepLinkIn } = makeLinks(APP_ORIGIN);
const SUPPORT_URL = `${APP_ORIGIN}/support`;
const APP_ID = "now.govirall.desktop";
const BG = "#09090b";
const TITLEBAR_H = 32; // the drag strip the preload draws, and the Windows buttons' height
const IS_MAC = process.platform === "darwin";
const OFFLINE_PAGE = path.join(__dirname, "offline.html");
const PRELOAD = path.join(__dirname, "preload.js");
const ICON = path.join(__dirname, "..", "assets", "logo.png");

// Permissions the page may have, and only for the app's own origin. Camera and microphone (the
// recorder), the clipboard (copy a caption, paste a code), HTML fullscreen (the video player's
// button) and persistent storage (so the browser never evicts the videos kept on this computer).
const ALLOWED_PERMISSIONS = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "fullscreen", "persistent-storage"]);

let mainWindow = null;
let pendingDeepLink = null;
let quitting = false;

// ---------------------------------------------------------------------------------------------
// Small helpers

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  try {
    const dir = app.getPath("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "main.log"), line);
  } catch { /* logging must never break the app */ }
  if (!app.isPackaged) process.stdout.write(line);
}

const isOfflinePage = (url) => {
  try { return url.startsWith("file:") && path.normalize(fileURLToPath(url.split(/[?#]/)[0])).toLowerCase() === path.normalize(OFFLINE_PAGE).toLowerCase(); } catch { return false; }
};

// Other sites (Commas checkout, Google Drive, TikTok, mail) open in the person's own browser or
// mail app; nothing else (file:, javascript:, custom schemes) is handed to the system.
function openExternal(url) {
  if (isSafeExternal(url)) shell.openExternal(new URL(url).href).catch((e) => log("openExternal failed", e));
}

function openDeepLink(raw) {
  const target = deepLinkTarget(raw);
  log("deep link", raw, "->", target);
  if (!target) return;
  if (!mainWindow || mainWindow.isDestroyed()) { pendingDeepLink = target; if (app.isReady()) createMainWindow(); return; }
  mainWindow.loadURL(target).catch((e) => log("deep link load failed", e));
  focusMain();
}

function focusMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------------------------
// Single instance and deep links (before anything else: a second copy hands over and exits)

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = deepLinkIn(argv);
    if (link) openDeepLink(link); else focusMain();
  });
  // Mac delivers goviral:// links here, possibly before the app is ready.
  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (app.isReady()) openDeepLink(url); else pendingDeepLink = deepLinkTarget(url);
  });
  // Windows and Linux deliver the first link on the command line.
  const firstLink = deepLinkIn(process.argv);
  if (firstLink) pendingDeepLink = deepLinkTarget(firstLink);

  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  if (process.platform === "win32") app.setAppUserModelId(APP_ID); // notifications + taskbar grouping

  // The site sees Chrome plus a GoViralDesktop token (not "Electron/…", which some services refuse).
  app.userAgentFallback = `${app.userAgentFallback.replace(/\s(?:Electron|GoViral|goviral-desktop)\/\S+/g, "")} GoViralDesktop/${app.getVersion()}`;

  app.whenReady().then(onReady).catch((e) => { log("startup failed", e); dialog.showErrorBox("GoViral could not start", String(e && e.message || e)); app.quit(); });
}

// ---------------------------------------------------------------------------------------------
// Window state: size, position, maximized, kept between launches

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

function loadWindowState() {
  const fallback = { width: 1440, height: 900, maximized: false };
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    if (!(s.width > 0 && s.height > 0)) return fallback;
    // Only keep the position if it is still on a screen (a monitor may have been unplugged).
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
        s.x + 100 > a.x && s.x < a.x + a.width - 100 && s.y >= a.y - 10 && s.y < a.y + a.height - 50);
      if (!onScreen) { delete s.x; delete s.y; }
    }
    return { ...fallback, ...s };
  } catch { return fallback; }
}

function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }));
  } catch (e) { log("window state not saved", e); }
}

// ---------------------------------------------------------------------------------------------
// Windows

function secureWebPreferences(extra = {}) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: true,
    ...extra,
  };
}

function createMainWindow() {
  const state = loadWindowState();
  const work = screen.getPrimaryDisplay().workAreaSize;
  // The minimum is 1100x700, unless the screen itself is smaller.
  const minWidth = Math.min(1100, work.width);
  const minHeight = Math.min(700, work.height);

  const win = new BrowserWindow({
    title: "GoViral",
    width: Math.max(minWidth, Math.min(state.width, work.width)),
    height: Math.max(minHeight, Math.min(state.height, work.height)),
    ...(Number.isFinite(state.x) && Number.isFinite(state.y) ? { x: state.x, y: state.y } : { center: true }),
    minWidth,
    minHeight,
    backgroundColor: BG,
    show: false,
    icon: IS_MAC ? undefined : ICON,
    ...(IS_MAC
      // The inset look, pinned: the traffic lights centred in the 32 px strip ("hiddenInset" puts
      // them lower, half over the app).
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: 9 } }
      : { titleBarStyle: "hidden", titleBarOverlay: { color: BG, symbolColor: "#e4e4e7", height: TITLEBAR_H } }),
    webPreferences: secureWebPreferences({
      preload: PRELOAD,
      // Uploads and exports keep full speed while the window is behind others or minimized.
      backgroundThrottling: false,
      additionalArguments: [
        `--gvd-version=${app.getVersion()}`,
        `--gvd-origin=${APP_ORIGIN}`,
        `--gvd-titlebar=${TITLEBAR_H}`,
      ],
    }),
  });
  mainWindow = win;
  if (state.maximized) win.maximize();

  let shown = false;
  const show = () => { if (!shown && !win.isDestroyed()) { shown = true; win.show(); } };
  win.once("ready-to-show", show);
  setTimeout(show, 4000); // a slow network never leaves the person with no window at all

  win.on("close", () => saveWindowState(win));
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
  win.on("enter-full-screen", () => win.webContents.send("gvd:fullscreen", true));
  win.on("leave-full-screen", () => win.webContents.send("gvd:fullscreen", false));

  // A page that cannot load (no internet, the site down): the offline page, which tries again.
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED: a newer navigation replaced it */) return;
    if (!isAppUrl(url)) return;
    log("load failed", code, desc, url);
    win.loadFile(OFFLINE_PAGE, { query: { retry: url, home: APP_HOME, reason: String(desc || code) } }).catch((e) => log("offline page failed", e));
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    log("renderer gone", details);
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(APP_HOME).catch((e) => log("reload after crash failed", e)); }, 800);
  });

  const target = pendingDeepLink || APP_HOME;
  pendingDeepLink = null;
  win.loadURL(target).catch((e) => log("first load failed", e));
  return win;
}

// A same-site page the app opens in a new window (a page of app.govirall.now that is not the
// app, e.g. /creator/upload): its own window with the normal title bar, same session and cookie.
function childWindowOptions() {
  return {
    width: 1200,
    height: 820,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: BG,
    autoHideMenuBar: true,
    icon: IS_MAC ? undefined : ICON,
    webPreferences: secureWebPreferences({ preload: PRELOAD, additionalArguments: [`--gvd-version=${app.getVersion()}`, `--gvd-origin=${APP_ORIGIN}`, "--gvd-titlebar=0"] }),
  };
}

// ---------------------------------------------------------------------------------------------
// Rules for every page in the app (main window, child windows, anything created later)

function hardenContents(contents) {
  contents.on("will-attach-webview", (e) => e.preventDefault());

  // Navigation stays on app.govirall.now (and the offline page); any other site opens in the browser.
  const guard = (details) => {
    const url = details.url;
    if (isAppUrl(url) || isOfflinePage(url)) return;
    details.preventDefault();
    openExternal(url);
  };
  contents.on("will-navigate", (details) => { if (details.isMainFrame !== false) guard(details); });
  contents.on("will-redirect", (details) => { if (details.isMainFrame) guard(details); });

  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      // A link back into the app itself goes to the main window instead of a second copy.
      if (new URL(url).pathname.startsWith("/desktop") && mainWindow && !mainWindow.isDestroyed() && contents !== mainWindow.webContents) {
        mainWindow.loadURL(url); focusMain(); return { action: "deny" };
      }
      return { action: "allow", overrideBrowserWindowOptions: childWindowOptions() };
    }
    openExternal(url);
    return { action: "deny" };
  });

  // A page asking "leave this page?" (an upload running): ask in a real dialog, never just
  // refuse to close.
  contents.on("will-prevent-unload", (e) => {
    const win = BrowserWindow.fromWebContents(contents);
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Leave", "Stay"],
      defaultId: 1,
      cancelId: 1,
      title: "Leave GoViral?",
      message: "Something is still in progress.",
      detail: "If you leave now, an upload or save that has not finished may stop.",
    });
    if (choice === 0) e.preventDefault(); // preventDefault here means: ignore the page, leave
  });

  // Right-click: spelling, cut/copy/paste in fields, copy for selected text, copy link.
  contents.on("context-menu", (_e, p) => {
    const items = [];
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => contents.replaceMisspelling(s) });
      if (p.dictionarySuggestions.length) items.push({ type: "separator" });
      items.push({ label: "Add to dictionary", click: () => contents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: "separator" });
    }
    if (p.isEditable) {
      items.push({ role: "undo", enabled: p.editFlags.canUndo }, { role: "redo", enabled: p.editFlags.canRedo }, { type: "separator" });
      items.push({ role: "cut", enabled: p.editFlags.canCut }, { role: "copy", enabled: p.editFlags.canCopy }, { role: "paste", enabled: p.editFlags.canPaste }, { role: "selectAll" });
    } else if (p.selectionText && p.selectionText.trim()) {
      items.push({ role: "copy" });
    }
    if (p.linkURL && /^(https?|mailto):/i.test(p.linkURL)) {
      if (items.length) items.push({ type: "separator" });
      items.push({ label: "Open link in browser", click: () => openExternal(p.linkURL) });
      items.push({ label: "Copy link", click: () => clipboard.writeText(p.linkURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) || undefined });
  });
}

// ---------------------------------------------------------------------------------------------
// Session: permissions and downloads

function setUpSession() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const origin = originOf((details && details.requestingUrl) || (contents && contents.getURL()) || "");
    if (origin !== APP_ORIGIN || !ALLOWED_PERMISSIONS.has(permission)) {
      log("permission refused", permission, origin);
      return callback(false);
    }
    if (permission === "media") {
      const types = (details && details.mediaTypes) || [];
      if (!types.every((t) => t === "audio" || t === "video")) return callback(false); // no screen capture
      if (IS_MAC) {
        // Ask macOS first, so the system prompt names GoViral (and a "no" there is a clean no here).
        try {
          for (const t of types) {
            const ok = await systemPreferences.askForMediaAccess(t === "video" ? "camera" : "microphone");
            if (!ok) return callback(false);
          }
        } catch (e) { log("mac media access", e); }
      }
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    requestingOrigin === APP_ORIGIN && ALLOWED_PERMISSIONS.has(permission));

  // "Save to this computer": straight into Downloads (never overwriting a file already there),
  // progress on the taskbar or dock icon, and a notification that shows it in its folder.
  ses.on("will-download", (_e, item) => {
    const dir = app.getPath("downloads");
    const savePath = uniquePath(dir, item.getFilename() || "GoViral video.mp4");
    item.setSavePath(savePath);
    log("download start", path.basename(savePath), item.getTotalBytes());

    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    item.on("updated", (_ev, state) => {
      if (!win || win.isDestroyed()) return;
      const total = item.getTotalBytes();
      if (state === "progressing" && total > 0) win.setProgressBar(item.getReceivedBytes() / total);
      else if (state === "progressing") win.setProgressBar(2); // indeterminate
    });
    item.once("done", (_ev, state) => {
      if (win && !win.isDestroyed()) win.setProgressBar(-1);
      log("download", state, path.basename(savePath));
      if (state !== "completed") {
        if (state === "interrupted") notify("Save didn't finish", `${path.basename(savePath)} could not be saved. Try again.`);
        return;
      }
      if (IS_MAC && app.dock) app.dock.downloadFinished(savePath);
      notify("Saved to Downloads", `${path.basename(savePath)} — click to show it in its folder.`, () => shell.showItemInFolder(savePath));
    });
  });
}

function uniquePath(dir, name) {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 200) || "GoViral download";
  const ext = path.extname(clean);
  const base = clean.slice(0, clean.length - ext.length);
  let candidate = path.join(dir, clean);
  for (let i = 1; fs.existsSync(candidate) && i < 1000; i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function notify(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: IS_MAC ? undefined : ICON, silent: false });
    if (onClick) n.on("click", onClick);
    n.show();
  } catch (e) { log("notification failed", e); }
}

// ---------------------------------------------------------------------------------------------
// Menu

function buildMenu() {
  const reloadApp = () => {
    const w = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!w) return;
    const url = w.webContents.getURL();
    if (isOfflinePage(url) || !url) w.loadURL(APP_HOME); else w.webContents.reload();
  };
  const template = [
    ...(IS_MAC ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => checkForUpdates(true) },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : [{
      label: "File",
      submenu: [{ label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => mainWindow && mainWindow.loadURL(APP_HOME) }, { type: "separator" }, { role: "quit", label: "Exit" }],
    }]),
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" },
        { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        ...(IS_MAC ? [{ role: "pasteAndMatchStyle" }, { role: "delete" }] : [{ role: "delete" }]),
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        ...(IS_MAC ? [{ label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => mainWindow && mainWindow.loadURL(APP_HOME) }, { type: "separator" }] : []),
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: reloadApp },
        { role: "forceReload" },
        { role: "toggleDevTools", label: "Developer Tools" },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Contact support", click: () => openExternal(SUPPORT_URL) },
        { label: "Email the team", click: () => openExternal("mailto:hello@govirall.now") },
        { type: "separator" },
        ...(IS_MAC ? [] : [{ label: "Check for updates", click: () => checkForUpdates(true) }]),
        { label: "Show log file", click: () => shell.showItemInFolder(path.join(app.getPath("logs"), "main.log")) },
        { type: "separator" },
        { label: `GoViral ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------------------------
// Updates of the shell (the app inside updates with the website; this is only for the wrapper):
// GitHub Releases via electron-updater. Downloads in the background, installs on the next quit,
// and offers a restart once it is ready.

let updater = null;
let updateReadyShown = false;

function setUpUpdates() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require("electron-updater"));
  } catch (e) { log("electron-updater missing", e); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = { info: (m) => log("update", m), warn: (m) => log("update warn", m), error: (m) => log("update error", m), debug: () => {} };
  updater.on("error", (e) => log("update error", e));
  updater.on("update-downloaded", async (info) => {
    if (updateReadyShown) return;
    updateReadyShown = true;
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `GoViral ${info.version} is ready.`,
      detail: "Restart now to use it, or it installs the next time you quit GoViral.",
    });
    if (response === 0) { quitting = true; setImmediate(() => updater.quitAndInstall()); }
  });
  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
}

async function checkForUpdates(fromMenu) {
  if (!updater) {
    if (fromMenu) dialog.showMessageBox(mainWindow || undefined, { type: "info", title: "Updates", message: app.isPackaged ? "Updates are not available in this copy." : "Updates only run in the installed app." });
    return;
  }
  try {
    const r = await updater.checkForUpdates();
    const newer = r && r.updateInfo && r.updateInfo.version !== app.getVersion();
    if (fromMenu && !newer) dialog.showMessageBox(mainWindow || undefined, { type: "info", title: "Updates", message: "GoViral is up to date.", detail: `You have version ${app.getVersion()}.` });
    else if (fromMenu && newer) dialog.showMessageBox(mainWindow || undefined, { type: "info", title: "Updates", message: `Downloading GoViral ${r.updateInfo.version}…`, detail: "It will ask to restart when it is ready." });
  } catch (e) {
    log("update check failed", e);
    if (fromMenu) dialog.showMessageBox(mainWindow || undefined, { type: "warning", title: "Updates", message: "Couldn't check for updates.", detail: "Check your internet connection and try again." });
  }
}

// ---------------------------------------------------------------------------------------------

function onReady() {
  log("start", app.getVersion(), process.platform, process.arch, "electron", process.versions.electron);
  app.setAboutPanelOptions({ applicationName: "GoViral", applicationVersion: app.getVersion(), copyright: "© GoViral", website: "https://govirall.now" });
  app.on("web-contents-created", (_e, contents) => hardenContents(contents));
  setUpSession();
  buildMenu();
  createMainWindow();
  setUpUpdates();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(); else focusMain();
  });
}

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => {
  if (!IS_MAC || quitting) app.quit();
});
