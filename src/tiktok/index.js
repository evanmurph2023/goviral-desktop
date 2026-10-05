// The bridge between the app and Groot's TikTok poster (main process side). The page asks through
// the preload (window.goviralDesktop.tiktok / .files / .drive); every call is checked here: it must
// come from the app itself (<APP_ORIGIN>/desktop), and every field is validated (rules.js).
//
//   gvd:tiktok:post   { postId, source | videoUrl, name, product, caption, hashtags, mode, platform?, brand? }
//                     source = { kind: "url", url } | { kind: "file", fileId } | { kind: "drive", fileId }
//                     platform = "tiktok" (default) | "trybe"; a Trybe post names the brand (no product)
//                     → { ok, status: posted | ready | failed | stopped, error?, code?, submissionId? }
//                     progress: "gvd:tiktok:progress" { postId, status, step, message, reason, ai, code }
//   gvd:tiktok:stop   → stops the post running now
//   gvd:tiktok:open   → shows the TikTok window (to log in once, ahead of the first post)
//   gvd:trybe:open    → shows the Trybe window (the creator signs in to Trybe there, once)
//   gvd:tiktok:status → { signedIn, handle? }  TikTok's session cookie in the TikTok window's session
//   gvd:trybe:status  → { signedIn, handle? }  Trybe's session in the Trybe window's storage
//                       (accounts.js; neither ever opens a window to check)
//
// Groot READS the creator's accounts (reads.js, read-engine.js; navigation and reading only):
//   gvd:reads:run     { read: "trybe_brands" | "trybe_brand" | "tiktok_recent_posts", params: { brandId?, brand?, limit? }, readId? }
//                     → { ok, read, status: done | failed | stopped, result, partial, error?, code?, aiSteps }
//                     progress on "gvd:tiktok:progress" with read set; one at a time with posts
//   gvd:reads:brands  → the last "My brands" read, kept on disk: { at, brands } | null
//
// The creator's finished videos (src/tiktok/files.js): only folders they picked, only files they dropped.
//   gvd:files:roots                       → [{ id, name, path, remembered, missing }]
//   gvd:files:pick   { remember }         → the system folder dialog → { ok, root } | { ok: false, canceled }
//   gvd:files:remember { rootId, on }     → keep (or stop keeping) a picked folder across launches
//   gvd:files:forget { rootId }
//   gvd:files:folders { rootId }          → { ok, folders: [{ rel, name, videos, depth }] }
//   gvd:files:videos { rootId, rel, recursive } → { ok, videos: [{ fileId, name, size, seconds, folder }] }
//   gvd:files:thumb  { fileId }           → a small JPEG data URL from the system's own thumbnails, or null
//   gvd:files:dropped [paths]             → (from the preload only) { ok, videos, skipped }
// Google Drive (src/tiktok/drive.js):
//   gvd:drive:connect                     → { ok, email? } (the system browser, Google's consent)
"use strict";

const path = require("path");
const { createPoster, makeGrootClient } = require("./poster");
const { createFileRegistry } = require("./files");
const { createDriveClient } = require("./drive");
const { createAccounts } = require("./accounts");
const { isAllowedCaller, validatePostRequest, TIKTOK_UPLOAD_URL } = require("./rules");
const { validateReadRequest } = require("./reads");
const { TRYBE_ORIGIN } = require("./trybe");

const isId = (v, re) => typeof v === "string" && re.test(v);
const ROOT_ID = /^r_[A-Za-z0-9_-]{8,40}$/;
const FILE_ID = /^f_[A-Za-z0-9_-]{16,64}$/;

// `overrides` is for the harness only (pace, show, timeouts, pickFolder, openExternal, googleApi,
// storePath); main.js passes none.
function setUpTikTok({ electron, appOrigin, log, icon, overrides = {} }) {
  const { app, ipcMain, session, net, dialog, BrowserWindow, nativeImage, shell } = electron;
  // A local build may point the engine at the mock (scripts/tiktok-harness.cjs); an installed copy never.
  const dev = !app.isPackaged;
  const allowLocal = dev && process.env.GOVIRAL_TIKTOK_LOCAL === "1";
  const uploadUrl = (dev && process.env.GOVIRAL_TIKTOK_UPLOAD_URL) || TIKTOK_UPLOAD_URL;
  const trybeUrl = (dev && allowLocal && process.env.GOVIRAL_TRYBE_URL) || TRYBE_ORIGIN;
  const o = dev ? overrides : {};
  // The platform, with the app's own sign-in cookie (the default session).
  const platformFetch = (url, init) => session.defaultSession.fetch(url, { ...init, credentials: "include" });

  const files = createFileRegistry({
    storePath: o.storePath || path.join(app.getPath("userData"), "groot-folders.json"),
    log,
    // The system's own thumbnail (Explorer / Quick Look). Nothing decodes video here.
    thumbnailer: o.thumbnails === false || !nativeImage.createThumbnailFromPath ? null : async (p) => {
      const img = await nativeImage.createThumbnailFromPath(p, { width: 216, height: 384 });
      return img && !img.isEmpty() ? `data:image/jpeg;base64,${img.toJPEG(72).toString("base64")}` : null;
    },
  });
  const drive = createDriveClient({
    origin: appOrigin, platformFetch, allowLocal, log,
    fetchFile: (url, init) => net.fetch(url, init),
    openExternal: o.openExternal || ((url) => shell.openExternal(url)),
    googleApi: (allowLocal && o.googleApi) || undefined,
    waitMs: o.driveWaitMs,
  });

  const poster = createPoster({
    electron, log, icon, allowLocal, uploadUrl: (dev && o.uploadUrl) || uploadUrl, trybeUrl: (dev && o.trybeUrl) || trybeUrl, files, drive,
    userAgent: app.userAgentFallback,
    // The AI fallback goes to our platform with the app's own sign-in cookie.
    groot: makeGrootClient({ origin: appOrigin, fetchImpl: platformFetch }),
    // The export itself is a public file on Blob or the worker: no cookie needed.
    fetchVideo: (url, init) => net.fetch(url, init),
    ...(dev ? { pace: o.pace, show: o.show, timeouts: o.timeouts } : {}),
  });

  const allowed = (e) => isAllowedCaller((e.senderFrame && e.senderFrame.url) || "", appOrigin);
  const handle = (channel, fn, refused) => ipcMain.handle(channel, async (e, arg) => {
    if (!allowed(e)) { log(`${channel} refused: caller`, e.senderFrame && e.senderFrame.url); return refused; }
    try { return await fn(e, arg && typeof arg === "object" ? arg : {}, arg); } catch (err) { log(`${channel} failed`, err); return { ok: false, error: "Something went wrong. Try again." }; }
  });

  handle("gvd:tiktok:post", async (e, _o, raw) => {
    const v = validatePostRequest(raw, { allowLocal });
    if (!v.ok) return { ok: false, status: "failed", error: v.error };
    if (poster.busy()) return { ok: false, status: "failed", error: "Groot is already posting. One at a time.", code: "busy" };
    const job = v.value;
    log("tiktok post start", job.postId, job.platform, job.mode, job.source.kind, job.platform === "trybe" ? "brand" : job.product ? "product" : "no product");
    const r = await poster.post(job, (p) => { if (!e.sender.isDestroyed()) e.sender.send("gvd:tiktok:progress", { postId: job.postId, ...p }); });
    log("tiktok post end", job.postId, r.status, r.code || "", r.error || "");
    return { ok: r.status === "posted" || r.status === "ready", postId: job.postId, platform: job.platform, status: r.status, error: r.error || null, code: r.code || null, aiSteps: r.aiSteps || 0, submissionId: r.submissionId || null };
  }, { ok: false, status: "failed", error: "Not allowed." });
  handle("gvd:tiktok:stop", () => { poster.stop(); return true; }, false);
  handle("gvd:tiktok:open", () => { poster.openWindow("tiktok"); return true; }, false);
  handle("gvd:trybe:open", () => { poster.openWindow("trybe"); return true; }, false);

  // ---- the accounts (never a window just to check) and Groot's reads ----
  const accounts = createAccounts({ electron, userData: o.userData || app.getPath("userData"), windowOf: (k) => poster.window(k), trybeOrigin: (dev && o.trybeUrl) || trybeUrl, log });
  handle("gvd:tiktok:status", () => accounts.tiktokStatus(), { signedIn: false });
  handle("gvd:trybe:status", () => accounts.trybeStatus(), { signedIn: false });
  handle("gvd:reads:run", async (e, _o, raw) => {
    const v = validateReadRequest(raw);
    if (!v.ok) return { ok: false, status: "failed", error: v.error, code: "bad_read" };
    if (poster.busy()) return { ok: false, status: "failed", error: "Groot is busy in a window right now. One at a time.", code: "busy" };
    const req = v.value;
    log("read start", req.read);
    const r = await poster.read(req, (p) => { if (!e.sender.isDestroyed()) e.sender.send("gvd:tiktok:progress", { readId: req.readId || null, ...p }); });
    log("read end", req.read, r.status, r.code || "");
    if (r.status === "done") accounts.remember(req.read, r.result);
    return { ok: r.status === "done", read: req.read, status: r.status, result: r.status === "done" ? r.result : null, partial: !!r.partial, error: r.error || null, code: r.code || null, aiSteps: r.aiSteps || 0 };
  }, { ok: false, status: "failed", error: "Not allowed." });
  handle("gvd:reads:brands", () => accounts.lastBrands(), null);

  // ---- the creator's folders and files ----
  handle("gvd:files:roots", () => files.list(), []);
  handle("gvd:files:pick", async (e, a) => {
    let picked;
    if (o.pickFolder) picked = await o.pickFolder();
    else {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win, { title: "Pick the folder with your finished videos", buttonLabel: "Use this folder", properties: ["openDirectory"] });
      picked = r.canceled ? null : r.filePaths[0];
    }
    if (!picked) return { ok: false, canceled: true };
    const root = files.addRoot(picked, { remember: a.remember === true });
    log("files folder picked", root.id, root.remembered ? "remembered" : "this session");
    return { ok: true, root };
  }, { ok: false, error: "Not allowed." });
  handle("gvd:files:remember", (e, a) => isId(a.rootId, ROOT_ID) && files.remember(a.rootId, a.on === true), false);
  handle("gvd:files:forget", (e, a) => isId(a.rootId, ROOT_ID) && files.forget(a.rootId), false);
  handle("gvd:files:folders", (e, a) => (isId(a.rootId, ROOT_ID) ? files.folders(a.rootId) : { ok: false, error: "That folder isn't one you picked." }), { ok: false, error: "Not allowed." });
  handle("gvd:files:videos", (e, a) => (isId(a.rootId, ROOT_ID) && typeof a.rel === "string" && a.rel.length <= 500 ? files.videos(a.rootId, a.rel, { recursive: a.recursive === true }) : { ok: false, error: "That folder isn't one you picked." }), { ok: false, error: "Not allowed." });
  handle("gvd:files:thumb", (e, a) => (isId(a.fileId, FILE_ID) ? files.thumbnail(a.fileId) : null), null);
  handle("gvd:files:dropped", (e, _a, raw) => files.addDropped(Array.isArray(raw) ? raw.filter((p) => typeof p === "string" && p.length < 1024) : []), { ok: false, error: "Not allowed." });

  // ---- Google Drive ----
  handle("gvd:drive:connect", () => drive.connect(), { ok: false, error: "Not allowed." });

  return Object.assign(poster, { files, drive, accounts });
}

module.exports = { setUpTikTok };
