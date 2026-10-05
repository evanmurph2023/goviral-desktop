// One post from start to finish, the way the app asks for it: get the video (download a finished
// export, or the creator's own file from a folder they picked or dropped, or download it from their
// Google Drive), open (or reuse) the TikTok window, drive TikTok with the engine, clean up (only our
// own temp folder: the creator's files are never moved or deleted). One post at a time; the app
// queues the rest. Used by the IPC bridge (index.js) and by the harness
// (scripts/tiktok-harness.cjs), which points it at a local mock of TikTok Studio.
// Trybe (2026-10-05): a job with platform "trybe" goes through the Trybe window (its own session,
// persist:trybe, where the creator signed in) and the Trybe engine (trybe-engine.js).
// Reads (2026-10-05): read() runs read-engine.js in the same windows, one at a time with posts.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTikTokWindow } = require("./window");
const { saveBody } = require("./transfer");
const { CdpPage } = require("./page");
const { createEngine } = require("./engine");
const { createTrybeEngine } = require("./trybe-engine");
const { createReadEngine } = require("./read-engine");
const { TRYBE_ORIGIN } = require("./trybe");
const { STEP_WORDS, safeFileName, TIKTOK_UPLOAD_URL } = require("./rules");

const MAX_BYTES = 4 * 1024 ** 3;
const AI_FETCH_MS = 35000; // the platform's route allows 30 s; the engine gives up at 40 s either way
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// The platform's AI fallback, called with the app's own sign-in (the default session's cookie).
function makeGrootClient({ fetchImpl, origin }) {
  return {
    async nextAction(body) {
      try {
        const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(AI_FETCH_MS) : undefined;
        const res = await fetchImpl(`${origin}/api/groot-post/next-action`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal });
        const j = await res.json().catch(() => null);
        if (res.ok && j && j.ok && j.action) return { ok: true, action: j.action };
        return { ok: false, error: (j && typeof j.error === "string" && j.error) || `Groot couldn't see the page (${res.status}).` };
      } catch { return { ok: false, error: "Groot couldn't reach GoViral. Check your internet." }; }
    },
  };
}

// onStart({ total }) once the server answered (the bytes still to come), onBytes(n) as they arrive.
async function downloadTo(fetchImpl, url, dir, name, signal, { onStart = () => {}, onBytes = () => {}, stallMs = 60000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeFileName(name));
  const res = await fetchImpl(url, { signal });
  if (!res.ok || !res.body) throw new Error(`The video didn't download (${res.status}).`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error("That video is too big to post.");
  onStart({ total: len });
  await saveBody(res.body, file, { signal, stallMs, onBytes });
  const size = fs.statSync(file).size;
  if (size < 1000) throw new Error("The video didn't download.");
  return file;
}

function createPoster({ electron, log = () => {}, groot, fetchVideo, files = null, drive = null, uploadUrl = TIKTOK_UPLOAD_URL, trybeUrl = TRYBE_ORIGIN, allowLocal = false, pace = 1, show = true, timeouts, icon, userAgent, tempRoot = path.join(os.tmpdir(), "goviral-groot") }) {
  // TikTok Studio's upload page (a function in the harness, which switches mock pages); Trybe's site
  const target = () => (typeof uploadUrl === "function" ? uploadUrl() : uploadUrl);
  const trybeBase = () => String(typeof trybeUrl === "function" ? trybeUrl() : trybeUrl).replace(/\/+$/, "");
  const windows = {};     // "tiktok" | "trybe" → its window, kept between posts of a run
  let current = null;     // { abort, handedBack }

  const kindOf = (job) => (job && job.platform === "trybe" ? "trybe" : "tiktok");
  const ensureWindow = (kind = "tiktok") => {
    const had = windows[kind];
    if (had && !had.isClosed()) return had;
    const w = createTikTokWindow({ electron, allowLocal, show, log, icon, userAgent, kind });
    w.onStop(() => { if (current) current.abort.abort(); });
    w.onNext(() => { if (current) current.handedBack = true; });
    windows[kind] = w;
    return w;
  };

  // The file TikTok gets: the creator's own (checked again by the registry), or a download.
  async function videoFile(job, dir, signal, hooks = {}) {
    const src = job.source || { kind: "url", url: job.videoUrl };
    if (src.kind === "file") {
      const p = files && files.pathOf(src.fileId);
      if (!p) throw new Error("That video isn't on this computer any more, or isn't one you picked.");
      return p;
    }
    if (src.kind === "drive") {
      if (!drive) throw new Error("Google Drive isn't connected.");
      return drive.download(src.fileId, dir, signal, hooks);
    }
    return downloadTo(fetchVideo, src.url, dir, job.name, signal, hooks);
  }

  async function post(job, onProgress = () => {}) {
    if (current) return { status: "failed", error: "Groot is already posting. One at a time.", code: "busy" };
    const abort = new AbortController();
    current = { abort, handedBack: false };
    const me = current;
    const dir = path.join(tempRoot, `${job.postId}-${Date.now()}`);
    const kind = kindOf(job);
    const w = ensureWindow(kind);
    const title = kind === "trybe" ? `Groot is sending "${job.name}" to ${job.brand} on Trybe` : `Groot is posting "${job.name}"`;
    const report = (p) => {
      const evt = { status: p.status || "posting", step: p.step || null, message: p.message || "", reason: p.reason || null, ai: !!p.ai, code: p.code || null };
      w.setStatus({ title, line: evt.message, status: evt.status });
      try { onProgress(evt); } catch { /* the app's problem */ }
    };
    if (show) w.focus();
    let page = null;
    // The download runs WHILE TikTok Studio opens and the upload area is found (2026-10-05): the
    // engine waits for the file only when it is ready to put it in. Its own abort, so a post that
    // ends early never leaves a download running.
    const dlAbort = new AbortController();
    const onStop = () => dlAbort.abort();
    abort.signal.addEventListener("abort", onStop, { once: true });
    const dl = { bytes: 0, total: 0 };
    let fileP = null;
    try {
      const src = (job.source && job.source.kind) || "url";
      report({ step: "download", message: src === "drive" ? "Getting your video from Google Drive" : "Getting your video" });
      const t0 = Date.now();
      let lastLog = t0;
      let started;
      const startedP = new Promise((res) => { started = res; });
      log("tiktok download start", job.postId, src);
      fileP = Promise.resolve().then(() => videoFile(job, dir, dlAbort.signal, {
        onStart: ({ total }) => { dl.total = total || 0; log("tiktok download answered", job.postId, `${Date.now() - t0} ms`, total ? mb(total) : "size unknown"); started(); },
        onBytes: (n) => {
          dl.bytes = n;
          if (Date.now() - lastLog > 10000) { lastLog = Date.now(); log("tiktok download progress", job.postId, mb(n), dl.total ? `of ${mb(dl.total)}` : "", `${(n / 1048576 / ((Date.now() - t0) / 1000)).toFixed(1)} MB/s`); }
        },
      })).then((file) => {
        const size = fs.statSync(file).size;
        const s = (Date.now() - t0) / 1000;
        log("tiktok download done", job.postId, src, mb(size), `${s.toFixed(1)} s`, src === "file" ? "(the creator's own file)" : `${(size / 1048576 / Math.max(s, 0.001)).toFixed(1)} MB/s`);
        return file;
      }, (e) => { log("tiktok download failed", job.postId, `${((Date.now() - t0) / 1000).toFixed(1)} s`, e && e.message); throw e; });
      fileP.catch(() => {}); // read by the engine (or below)
      // A download that fails at once (not connected, gone, too big) fails before TikTok is touched.
      const gate = await Promise.race([startedP.then(() => null), fileP.then(() => null, (e) => e)]);
      if (gate) throw Object.assign(gate, { isDownload: true });
      page = new CdpPage(w.contents, { pace, signal: abort.signal, log });
      page.attach();
      const engine = kind === "trybe"
        ? createTrybeEngine({ page, groot, report, baseUrl: trybeBase(), timeouts, log, handedBack: () => me.handedBack })
        : createEngine({ page, groot, report, uploadUrl: target(), timeouts, log, handedBack: () => me.handedBack });
      // Trybe's engine takes the finished file; TikTok's takes it as it comes.
      const r = kind === "trybe" ? await engine.run({ ...job, filePath: await fileP }) : await engine.run({ ...job, filePath: fileP, fileProgress: () => dl });
      return r;
    } catch (e) {
      if (abort.signal.aborted) { report({ status: "stopped", message: "Stopped" }); return { status: "stopped", step: "download", error: "Stopped while getting the video." }; }
      const error = (e && e.message) || "Something went wrong.";
      log("tiktok post error", e);
      report({ status: "failed", message: error });
      return { status: "failed", error, ...(e && e.isDownload ? { step: "download", code: "download" } : {}) };
    } finally {
      abort.signal.removeEventListener("abort", onStop);
      dlAbort.abort();
      if (page) page.detach();
      if (fileP) await Promise.race([fileP.catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      fs.rm(dir, { recursive: true, force: true }, () => {});
      current = null;
    }
  }

  // Groot READS the creator's account (read-engine.js): their own TikTok / Trybe window, the same
  // one-at-a-time as posting, blockers wait for the creator ("wait"). Navigation and reading only.
  // req = reads.js validateReadRequest's value: { read, platform, params, readId? }.
  async function read(req, onProgress = () => {}) {
    if (current) return { status: "failed", error: "Groot is busy in a window right now. One at a time.", code: "busy" };
    const abort = new AbortController();
    current = { abort, handedBack: false };
    const kind = req.platform === "trybe" ? "trybe" : "tiktok";
    const w = ensureWindow(kind);
    const title = req.read === "trybe_brands" ? "Groot is reading your Trybe brands" : req.read === "trybe_brand" ? "Groot is reading a Trybe brand" : "Groot is reading your recent TikTok posts";
    const report = (p) => {
      const evt = { status: p.status || "reading", step: p.step || null, message: p.message || "", reason: p.reason || null, ai: !!p.ai, code: p.code || null, read: req.read };
      w.setStatus({ title, line: evt.message, status: evt.status });
      try { onProgress(evt); } catch { /* the app's problem */ }
    };
    if (show) w.focus();
    let page = null;
    try {
      page = new CdpPage(w.contents, { pace, signal: abort.signal, log });
      page.attach();
      let tiktokBase = "https://www.tiktok.com";
      try { tiktokBase = new URL(target()).origin; } catch { /* the default */ }
      const engine = createReadEngine({ page, groot, report, trybeBase: trybeBase(), tiktokBase, timeouts, log, blockerMode: "wait" });
      return await engine.run(req);
    } catch (e) {
      if (abort.signal.aborted) { report({ status: "stopped", message: "Stopped" }); return { status: "stopped" }; }
      log("read error", e);
      report({ status: "failed", message: "Something went wrong while reading." });
      return { status: "failed", error: "Something went wrong while reading." };
    } finally {
      if (page) page.detach();
      current = null;
    }
  }

  return {
    post,
    read,
    stop() { if (current) current.abort.abort(); },
    busy: () => !!current,
    // Open the window on TikTok Studio (or Trybe's creator portal) so the creator signs in there
    // themselves before the first post. Groot never sees or types the password.
    openWindow(kind = "tiktok") {
      const k = kind === "trybe" ? "trybe" : "tiktok";
      const w = ensureWindow(k);
      if (k === "trybe") w.setStatus({ title: "Trybe", line: "Sign in to Trybe here once. Groot uses this window to submit your videos.", status: "ready" });
      else w.setStatus({ title: "TikTok", line: "Log in to TikTok here once. Groot uses this window to post.", status: "ready" });
      if (!current) w.contents.loadURL(k === "trybe" ? `${trybeBase()}/creator` : target()).catch(() => {});
      w.focus();
    },
    window: (kind = "tiktok") => windows[kind] || null,
    close() { for (const k of Object.keys(windows)) { windows[k].close(); delete windows[k]; } },
  };
}

module.exports = { createPoster, makeGrootClient, downloadTo, STEP_WORDS };
