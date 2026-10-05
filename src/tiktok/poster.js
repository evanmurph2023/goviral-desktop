// One post from start to finish, the way the app asks for it: get the video (download a finished
// export, or the creator's own file from a folder they picked or dropped, or download it from their
// Google Drive), open (or reuse) the TikTok window, drive TikTok with the engine, clean up (only our
// own temp folder: the creator's files are never moved or deleted). One post at a time; the app
// queues the rest. Used by the IPC bridge (index.js) and by the harness
// (scripts/tiktok-harness.cjs), which points it at a local mock of TikTok Studio.
// Trybe (2026-10-05): a job with platform "trybe" goes through the Trybe window (its own session,
// persist:trybe, where the creator signed in) and the Trybe engine (trybe-engine.js).
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { createTikTokWindow } = require("./window");
const { CdpPage } = require("./page");
const { createEngine } = require("./engine");
const { createTrybeEngine } = require("./trybe-engine");
const { TRYBE_ORIGIN } = require("./trybe");
const { STEP_WORDS, safeFileName, TIKTOK_UPLOAD_URL } = require("./rules");

const MAX_BYTES = 4 * 1024 ** 3;

// The platform's AI fallback, called with the app's own sign-in (the default session's cookie).
function makeGrootClient({ fetchImpl, origin }) {
  return {
    async nextAction(body) {
      try {
        const res = await fetchImpl(`${origin}/api/groot-post/next-action`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
        const j = await res.json().catch(() => null);
        if (res.ok && j && j.ok && j.action) return { ok: true, action: j.action };
        return { ok: false, error: (j && typeof j.error === "string" && j.error) || `Groot couldn't see the page (${res.status}).` };
      } catch { return { ok: false, error: "Groot couldn't reach GoViral. Check your internet." }; }
    },
  };
}

async function downloadTo(fetchImpl, url, dir, name, signal) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeFileName(name));
  const res = await fetchImpl(url, { signal });
  if (!res.ok || !res.body) throw new Error(`The video didn't download (${res.status}).`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new Error("That video is too big to post.");
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file), { signal });
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
  async function videoFile(job, dir, signal) {
    const src = job.source || { kind: "url", url: job.videoUrl };
    if (src.kind === "file") {
      const p = files && files.pathOf(src.fileId);
      if (!p) throw new Error("That video isn't on this computer any more, or isn't one you picked.");
      return p;
    }
    if (src.kind === "drive") {
      if (!drive) throw new Error("Google Drive isn't connected.");
      return drive.download(src.fileId, dir, signal);
    }
    return downloadTo(fetchVideo, src.url, dir, job.name, signal);
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
    try {
      report({ step: "download", message: job.source && job.source.kind === "drive" ? "Getting your video from Google Drive" : "Getting your video" });
      const filePath = await videoFile(job, dir, abort.signal);
      page = new CdpPage(w.contents, { pace, signal: abort.signal, log });
      page.attach();
      const engine = kind === "trybe"
        ? createTrybeEngine({ page, groot, report, baseUrl: trybeBase(), timeouts, log, handedBack: () => me.handedBack })
        : createEngine({ page, groot, report, uploadUrl: target(), timeouts, log, handedBack: () => me.handedBack });
      const r = await engine.run({ ...job, filePath });
      return r;
    } catch (e) {
      if (abort.signal.aborted) { report({ status: "stopped", message: "Stopped" }); return { status: "stopped" }; }
      const error = (e && e.message) || "Something went wrong.";
      log("tiktok post error", e);
      report({ status: "failed", message: error });
      return { status: "failed", error };
    } finally {
      if (page) page.detach();
      fs.rm(dir, { recursive: true, force: true }, () => {});
      current = null;
    }
  }

  return {
    post,
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
