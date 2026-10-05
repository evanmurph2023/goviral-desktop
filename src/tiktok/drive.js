// Google Drive for Groot's finished-video posting (2026-10-04): the creator's own videos in their
// own Drive. The platform is the OAuth client (it holds the client id and secret and keeps the
// refresh token, encrypted); this file only does what must happen on the creator's computer:
//
// CONNECT (Google's installed-app flow, PKCE + a loopback redirect):
//   1. a fresh code verifier (kept here) and its S256 challenge, a random state, and a one-time
//      listener on http://127.0.0.1:<random port>/callback
//   2. the platform builds Google's consent address for the challenge (POST /api/drive/connect)
//   3. the system browser opens it (never an embedded window: Google refuses those); the creator
//      agrees to "see your Google Drive files" (drive.readonly)
//   4. Google sends the browser to the listener with a code; the state must match
//   5. the code + verifier go to the platform (POST /api/drive/connect/finish), which trades them
//      for tokens with its secret and keeps the refresh token
// A consent link someone else started cannot land in another person's account: the code only
// ever reaches the computer that started it, and only that computer has the verifier.
//
// DOWNLOAD: a short-lived access token from the platform (POST /api/drive/access, read-only
// scope, for the signed-in creator), then the file straight from Google into a temp folder. The
// page never sees the token.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { safeFileName } = require("./rules");
const { saveBody } = require("./transfer");

const CONNECT_WAIT_MS = 5 * 60 * 1000;
const MAX_BYTES = 4 * 1024 ** 3;
const GOOGLE_API = "https://www.googleapis.com";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function pkcePair() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
// Google's consent page (or, in a dev build, the harness's stand-in on 127.0.0.1).
function isConsentUrl(url, { allowLocal = false } = {}) {
  try {
    const u = new URL(url);
    if (allowLocal && u.protocol === "http:" && u.hostname === "127.0.0.1") return true;
    return u.protocol === "https:" && u.hostname === "accounts.google.com";
  } catch { return false; }
}

const PAGE = (title, line) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#fafafa;font:16px system-ui,sans-serif;text-align:center"><div><h1 style="font-size:22px">${title}</h1><p style="color:#a1a1aa">${line}</p></div></body>`;

function createDriveClient({ origin, platformFetch, fetchFile, openExternal, log = () => {}, allowLocal = false, googleApi = GOOGLE_API, waitMs = CONNECT_WAIT_MS }) {
  let connecting = null;

  async function call(pathname, body) {
    try {
      const res = await platformFetch(`${origin}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => null);
      return { status: res.status, j: j && typeof j === "object" ? j : {} };
    } catch { return { status: 0, j: { error: "Couldn't reach GoViral. Check your internet." } }; }
  }

  // The one-time listener on 127.0.0.1: `port` once it is up, `result` with the code (or
  // Google's error) once the browser comes back, then it closes. Only 127.0.0.1, only /callback,
  // only the state this computer made.
  async function listen(state) {
    let finish;
    const result = new Promise((resolve) => {
      let done = false;
      finish = (r) => { if (done) return; done = true; clearTimeout(timer); server.close(); resolve(r); };
      const timer = setTimeout(() => finish({ error: "timeout" }), waitMs);
    });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get("code");
      const err = u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      if (u.searchParams.get("state") !== state) { res.end(PAGE("That link isn't from GoViral", "Start again from the GoViral app.")); return; }
      res.end(code ? PAGE("Google Drive is connected", "Go back to GoViral. Groot can see your Drive videos now.") : PAGE("Google Drive isn't connected", "You can close this and try again from GoViral."));
      finish(code ? { code } : { error: err || "denied" });
    });
    const port = await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
    return { port, result, cancel: () => finish({ error: "cancelled" }) };
  }

  async function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      const { verifier, challenge } = pkcePair();
      const state = b64url(crypto.randomBytes(18));
      const l = await listen(state).catch(() => null);
      if (!l) return { ok: false, error: "Couldn't start the Google sign-in. Try again." };
      const redirectUri = `http://127.0.0.1:${l.port}/callback`;
      const start = await call("/api/drive/connect", { challenge, redirectUri, state });
      if (start.status !== 200 || typeof start.j.url !== "string" || !isConsentUrl(start.j.url, { allowLocal })) {
        l.cancel();
        return { ok: false, error: (typeof start.j.error === "string" && start.j.error) || "Google Drive isn't set up yet.", code: start.j.code || null };
      }
      await openExternal(start.j.url);
      const r = await l.result;
      if (r.error) return { ok: false, error: r.error === "timeout" ? "Google sign-in took too long. Try again." : "Google Drive wasn't connected.", code: r.error };
      const fin = await call("/api/drive/connect/finish", { code: r.code, verifier, redirectUri });
      if (fin.status !== 200 || !fin.j.ok) return { ok: false, error: (typeof fin.j.error === "string" && fin.j.error) || "Google Drive wasn't connected." };
      log("drive connected");
      return { ok: true, email: typeof fin.j.email === "string" ? fin.j.email : null };
    })().finally(() => { connecting = null; });
    return connecting;
  }

  // One Drive video into `dir`. The platform checks the file is a video in this creator's Drive
  // and hands back a short-lived read-only token for it.
  // hooks: onStart({ total }) once Google answered, onBytes(n) as the bytes arrive (poster.js logs
  // them and runs TikTok Studio meanwhile); no bytes for stallMs ends it with plain words.
  async function download(fileId, dir, signal, { onStart = () => {}, onBytes = () => {}, stallMs = 60000 } = {}) {
    const t0 = Date.now();
    const a = await call("/api/drive/access", { fileId });
    log("drive access", a.status, `${Date.now() - t0} ms`);
    if (a.status !== 200 || !a.j.ok || typeof a.j.accessToken !== "string") throw new Error((typeof a.j.error === "string" && a.j.error) || "Couldn't get that video from Google Drive.");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeFileName(typeof a.j.name === "string" ? a.j.name : "Drive video"));
    const res = await fetchFile(`${googleApi}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${a.j.accessToken}` }, signal });
    if (!res.ok || !res.body) throw new Error(`The video didn't download from Google Drive (${res.status}).`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) throw new Error("That video is too big to post.");
    onStart({ total: len });
    await saveBody(res.body, file, { signal, stallMs, onBytes });
    if (fs.statSync(file).size < 1000) throw new Error("The video didn't download from Google Drive.");
    return file;
  }

  return { connect, download };
}

module.exports = { createDriveClient, pkcePair, isConsentUrl };
