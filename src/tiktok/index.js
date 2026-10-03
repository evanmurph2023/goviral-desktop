// The bridge between the app and Groot's TikTok poster (main process side). The page asks through
// the preload (window.goviralDesktop.tiktok); every call is checked here: it must come from the
// app itself (<APP_ORIGIN>/desktop), and the request is validated field by field (rules.js).
//
//   gvd:tiktok:post  { postId, videoUrl, name, product, caption, hashtags, mode }
//                    → { ok, status: posted | ready | failed | stopped, error? }
//                    progress: "gvd:tiktok:progress" { postId, status, step, message, reason, ai }
//   gvd:tiktok:stop  → stops the post running now
//   gvd:tiktok:open  → shows the TikTok window (to log in once, ahead of the first post)
"use strict";

const { createPoster, makeGrootClient } = require("./poster");
const { isAllowedCaller, validatePostRequest, TIKTOK_UPLOAD_URL } = require("./rules");

// `overrides` is for the harness only (pace, show, timeouts); main.js passes none.
function setUpTikTok({ electron, appOrigin, log, icon, overrides = {} }) {
  const { app, ipcMain, session, net } = electron;
  // A local build may point the engine at the mock (scripts/tiktok-harness.cjs); an installed copy never.
  const dev = !app.isPackaged;
  const allowLocal = dev && process.env.GOVIRAL_TIKTOK_LOCAL === "1";
  const uploadUrl = (dev && process.env.GOVIRAL_TIKTOK_UPLOAD_URL) || TIKTOK_UPLOAD_URL;
  const poster = createPoster({
    electron, log, icon, allowLocal, uploadUrl,
    userAgent: app.userAgentFallback,
    // The AI fallback goes to our platform with the app's own sign-in cookie.
    groot: makeGrootClient({ origin: appOrigin, fetchImpl: (url, init) => session.defaultSession.fetch(url, { ...init, credentials: "include" }) }),
    // The export itself is a public file on Blob or the worker: no cookie needed.
    fetchVideo: (url, init) => net.fetch(url, init),
    ...(dev ? overrides : {}),
  });

  const allowed = (e) => isAllowedCaller((e.senderFrame && e.senderFrame.url) || "", appOrigin);

  ipcMain.handle("gvd:tiktok:post", async (e, raw) => {
    if (!allowed(e)) { log("tiktok post refused: caller", e.senderFrame && e.senderFrame.url); return { ok: false, status: "failed", error: "Not allowed." }; }
    const v = validatePostRequest(raw, { allowLocal });
    if (!v.ok) return { ok: false, status: "failed", error: v.error };
    if (poster.busy()) return { ok: false, status: "failed", error: "Groot is already posting. One at a time.", code: "busy" };
    const job = v.value;
    log("tiktok post start", job.postId, job.mode, job.product ? "product" : "no product");
    const r = await poster.post(job, (p) => { if (!e.sender.isDestroyed()) e.sender.send("gvd:tiktok:progress", { postId: job.postId, ...p }); });
    log("tiktok post end", job.postId, r.status, r.error || "");
    return { ok: r.status === "posted" || r.status === "ready", postId: job.postId, status: r.status, error: r.error || null, aiSteps: r.aiSteps || 0 };
  });
  ipcMain.handle("gvd:tiktok:stop", (e) => { if (allowed(e)) poster.stop(); return true; });
  ipcMain.handle("gvd:tiktok:open", (e) => { if (allowed(e)) poster.openWindow(); return true; });
  return poster;
}

module.exports = { setUpTikTok };
