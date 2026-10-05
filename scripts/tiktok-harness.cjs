// npm run harness:tiktok — Groot's TikTok engine, end to end, against a LOCAL MOCK of TikTok
// Studio (test/tiktok-mock/upload.html). Never touches tiktok.com, Google or the platform.
//
//   electron scripts/tiktok-harness.cjs [shots-dir]
//
// A tiny local server plays every part: the mock TikTok Studio, the "finished export" (a few KB of
// bytes with an MP4 header, no real video), the app's own /desktop page (for the preload bridge),
// the platform (the AI fallback POST /api/groot-post/next-action, and /api/drive/*), and Google
// (the consent page that sends the browser back to the loopback listener, and a Drive file).
// Nothing is decoded or rendered: the "videos" are bytes.
// Scenarios:
//   1 bridge: the app page → IPC → download → upload → description → product → Post now → posted
//   2 bridge refuses: a non-export URL, a made-up file id, a page outside /desktop
//   3 changed page: the Post and Add link buttons are different, the AI fallback finds them
//   4 manual: stops on the filled-in page; the creator presses Post now; Groot sees it
//   5 manual, "Done, next video": handed back without posting → ready
//   6 captcha  7 logged out  8 stop  9 no product
//  10 Drew's flow: Studio home → Upload → Videos; description "comfort weekend slipper #slippers
//     #comfort"; "Comfort slippers" isn't found as typed, "Comfort" is, the right row is picked;
//     Next → Add; playlist and location left empty; the success notice
//  11 product not in the showcase: that video stops with the creator's words; the next one posts
//  12 invalid characters in the product link name: only those come out, then Add
//  13 a "Post now?" dialog after Post now
//  14 finished files: a folder the creator picked → its subfolders ("10-4") → the videos with their
//     lengths → posted from the file itself (never copied, never deleted); paths outside refused;
//     the folder is remembered only when asked
//  15 dropped files: a File from the page → its path in the preload → an id → posted
//  16 Google Drive: connect (PKCE + the loopback listener) → a Drive video downloaded and posted
//  17 slow upload: the description and product go in WHILE TikTok uploads; Post only after it
//  18 the hashtag list eats a space typed while it is open: Escape after each tag, exact description
//  19 TikTok puts the file name back when the upload finishes: the description is written again
//  20 the showcase shows products, none clearly the creator's: needs you with the list; the creator
//     picks one in the window; Groot carries on and posts it
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const electron = require("electron");
const { app, BrowserWindow, net } = electron;

const ROOT = path.resolve(__dirname, "..");
const MOCK_HTML = fs.readFileSync(path.join(ROOT, "test", "tiktok-mock", "upload.html"));
const SHOTS = process.argv.find((a, i) => i > 1 && !a.startsWith("-") && !a.endsWith(".cjs")) || null;
// Shown: a hidden window paints nothing, so screenshots (the AI fallback sends one) never come.
const SHOW = process.env.GVD_HARNESS_HIDE !== "1";
const PACE = 0.15;
const LOG = process.env.GVD_HARNESS_LOG === "1" ? (...a) => console.log("       ·", ((Date.now() % 100000) / 1000).toFixed(1), ...a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x)))) : () => {};
const TIMEOUTS = { find: 3500, results: 3000, posted: 15000, blocker: 30000, handoff: 30000, processed: 20000, stall: 8000, creator: 20000 };

app.commandLine.appendSwitch("disable-gpu-sandbox");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A few KB that start like an MP4: ftyp, a filler mdat, then moov with an mvhd (timescale 1000).
// Never a real video: nothing here is ever decoded.
function fakeMp4(seconds, fill = 7) {
  const box = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  return Buffer.concat([box("ftyp", Buffer.from("mp42\0\0\0\0mp42isom", "latin1")), box("mdat", Buffer.alloc(48 * 1024, fill)), box("moov", box("mvhd", mvhd))]);
}

// ---- the local server ----------------------------------------------------------------------------
const aiCalls = [];
const drive = { challenge: null, code: null, finished: 0, accessCalls: 0, files: { "DrvComfort_0123456789": "Comfort slipper drive take.mp4" } };
function mockGroot(body) {
  const els = (body.view && body.view.elements) || [];
  const named = (re, roleRe = /button|option|radio|link/) => els.find((e) => re.test(e.name || "") && (roleRe.test(e.role) || roleRe.test(e.tag)) && !e.disabled);
  const nulls = { ref: null, x: null, y: null, text: null, key: null, dy: null, ms: null, reason: null, message: null };
  aiCalls.push({ cookie: body.__cookie || "", step: body.step, elements: els.length, screenshot: typeof body.screenshot === "string" ? body.screenshot.length : 0, history: body.history });
  switch (body.step) {
    case "product_open": {
      if (named(/^products$/i, /option/)) return { ...nulls, action: "done", why: "dialog open" };
      const el = named(/link/i);
      return el ? { ...nulls, action: "click", ref: el.ref, why: "the link button" } : { ...nulls, action: "need_user", reason: "other", message: "No link button", why: "lost" };
    }
    case "post": {
      const el = named(/^(publish( now)?|post( now)?)$/i);
      return el ? { ...nulls, action: "click", ref: el.ref, why: "publish" } : { ...nulls, action: "need_user", reason: "other", message: "No post button", why: "lost" };
    }
    default:
      return { ...nulls, action: "need_user", reason: "other", message: `mock Groot has no answer for ${body.step}`, why: "mock" };
  }
}

function readJson(req) {
  return new Promise((resolve) => { let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } }); });
}
function startServer() {
  const video = fakeMp4(21.5);
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (code, j) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (/^\/tiktokstudio(\/upload|\/content)?\/?$/.test(u.pathname)) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(MOCK_HTML); }
    if (u.pathname === "/video.mp4") { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": video.length }); return res.end(video); }
    if (u.pathname.startsWith("/desktop") || u.pathname === "/notapp") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<!doctype html><title>app</title><div id=root>app</div><input type=file id=pick multiple>"); }
    if (u.pathname === "/api/groot-post/next-action" && req.method === "POST") {
      const body = await readJson(req);
      body.__cookie = req.headers.cookie || "";
      return json(200, { ok: true, action: mockGroot(body), left: 29 });
    }
    // ---- the platform's Drive routes (src/app/api/drive/* there) ----
    if (u.pathname === "/api/drive/connect" && req.method === "POST") {
      const b = await readJson(req);
      if (!(req.headers.cookie || "").includes("harness-signed-in")) return json(401, { ok: false, error: "Sign in" });
      if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(b.redirectUri || "") || !b.challenge || !b.state) return json(400, { ok: false, error: "bad" });
      drive.challenge = b.challenge;
      const g = new URL(`http://127.0.0.1:${server.address().port}/mock-google/auth`);
      for (const [k, v] of Object.entries({ redirect_uri: b.redirectUri, state: b.state, code_challenge: b.challenge, code_challenge_method: "S256", scope: "https://www.googleapis.com/auth/drive.readonly" })) g.searchParams.set(k, v);
      return json(200, { ok: true, url: g.href });
    }
    if (u.pathname === "/mock-google/auth") {
      // the creator agrees on Google's page; Google sends the browser back to the loopback listener
      drive.code = `code_${crypto.randomBytes(6).toString("hex")}`;
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("code", drive.code);
      back.searchParams.set("state", u.searchParams.get("state"));
      res.writeHead(302, { Location: back.href }); return res.end();
    }
    if (u.pathname === "/api/drive/connect/finish" && req.method === "POST") {
      const b = await readJson(req);
      const challenge = crypto.createHash("sha256").update(String(b.verifier || "")).digest("base64url");
      if (b.code !== drive.code || challenge !== drive.challenge) return json(400, { ok: false, error: "Google didn't accept that." });
      drive.finished++;
      return json(200, { ok: true, email: "creator@example.com" });
    }
    if (u.pathname === "/api/drive/access" && req.method === "POST") {
      const b = await readJson(req);
      drive.accessCalls++;
      if (!drive.finished) return json(409, { ok: false, error: "Connect Google Drive first.", code: "drive_not_connected" });
      if (!drive.files[b.fileId]) return json(404, { ok: false, error: "That video isn't in your Google Drive." });
      return json(200, { ok: true, accessToken: "ya29.harness", name: drive.files[b.fileId] });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m && u.searchParams.get("alt") === "media") {
      if (req.headers.authorization !== "Bearer ya29.harness" || !drive.files[decodeURIComponent(m[1])]) { res.writeHead(401); return res.end(); }
      const v = fakeMp4(33, 9);
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": v.length }); return res.end(v);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// ---- helpers ---------------------------------------------------------------------------------------
async function mockState(poster) { return poster.window().contents.executeJavaScript("JSON.parse(JSON.stringify(window.__mock || null))"); }
async function inMock(poster, js) { return poster.window().contents.executeJavaScript(js); }
async function shot(poster, name) {
  if (!SHOTS) return;
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const img = await poster.window().contents.capturePage();
    if (!img.isEmpty()) fs.writeFileSync(path.join(SHOTS, `${name}.png`), img.toPNG());
  } catch (e) { console.log("   (screenshot skipped:", e.message, ")"); }
}
const waitUntil = async (fn, ms = 20000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return true; await sleep(150); } return false; };

let failures = 0;
async function scenario(name, fn) {
  if (process.env.ONLY && !process.env.ONLY.split(",").some((o) => name.startsWith(o + " "))) return; // ONLY=10,18b runs just those
  const t0 = Date.now();
  try { await fn(); console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e}`); }
}

app.whenReady().then(async () => {
  const server = await startServer();
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const STUDIO = `${ORIGIN}/tiktokstudio`;
  const UPLOAD = `${STUDIO}/upload`;
  const VIDEO = `${ORIGIN}/video.mp4`;
  const { createPoster, makeGrootClient } = require(path.join(ROOT, "src", "tiktok", "poster.js"));
  const { setUpTikTok } = require(path.join(ROOT, "src", "tiktok", "index.js"));
  const fetchImpl = (url, init) => net.fetch(url, init);
  const makePoster = (query = "", base = UPLOAD) => createPoster({
    electron, log: LOG, pace: PACE, show: SHOW, timeouts: TIMEOUTS, allowLocal: true,
    uploadUrl: base + query, groot: makeGrootClient({ origin: ORIGIN, fetchImpl }), fetchVideo: fetchImpl, userAgent: app.userAgentFallback,
  });
  const job = (over = {}) => ({ postId: `p${Date.now()}`, videoUrl: VIDEO, name: "Hydro test", mode: "auto", product: "Hydro Flask 40 oz", caption: "Ice for two days, no joke", hashtags: ["hydroflask", "tiktokshop"], ...over });
  const CAPTION = "Ice for two days, no joke #hydroflask #tiktokshop";
  console.log(`Groot TikTok engine harness (mock at ${ORIGIN}, pace ${PACE})`);

  // The creator's computer: a picked folder "TikTok Shop vids" with 10-4 and 10-5 in it.
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gvd-harness-"));
  const SHOP = path.join(HOME, "TikTok Shop vids");
  fs.mkdirSync(path.join(SHOP, "10-4"), { recursive: true });
  fs.mkdirSync(path.join(SHOP, "10-5"), { recursive: true });
  fs.writeFileSync(path.join(SHOP, "10-4", "slipper take 1.mp4"), fakeMp4(18.2));
  fs.writeFileSync(path.join(SHOP, "10-4", "slipper take 2.mov"), fakeMp4(27));
  fs.writeFileSync(path.join(SHOP, "10-4", "notes.txt"), "not a video");
  fs.writeFileSync(path.join(SHOP, "10-5", "serum.mp4"), fakeMp4(40));
  fs.writeFileSync(path.join(HOME, "secret.mp4"), fakeMp4(5));
  const DROPPED = path.join(HOME, "dropped slipper.mp4");
  fs.writeFileSync(DROPPED, fakeMp4(12));
  const STORE = path.join(HOME, "userdata", "groot-folders.json");

  // 1 + 2: through the real preload and IPC bridge, as the app will call it.
  process.env.GOVIRAL_TIKTOK_LOCAL = "1";
  let bridgeUpload = UPLOAD + "?v=changed"; // the bridge run uses the changed page: its AI fallback goes out through the app session
  // the app is signed in: its cookie must ride along on the AI fallback and Drive calls
  await electron.session.defaultSession.cookies.set({ url: ORIGIN, name: "authjs.session-token", value: "harness-signed-in" });
  const opened = [];
  const bridged = setUpTikTok({ electron, appOrigin: ORIGIN, log: LOG, overrides: {
    pace: PACE, show: SHOW, timeouts: TIMEOUTS, uploadUrl: () => bridgeUpload, storePath: STORE, thumbnails: false,
    pickFolder: async () => SHOP, googleApi: ORIGIN, driveWaitMs: 20000,
    // the system browser, played by a fetch that follows Google's redirect to the loopback listener
    openExternal: async (url) => { opened.push(url); await net.fetch(url); },
  } });
  const appWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, "src", "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--gvd-origin=${ORIGIN}`, "--gvd-version=harness", "--gvd-titlebar=0"] } });
  const inApp = (js) => appWin.webContents.executeJavaScript(js);
  const postViaApp = (req) => inApp(`(async () => {
      const seen = [];
      const off = window.goviralDesktop.tiktok.onProgress((p) => seen.push(p.status + ":" + (p.step || "")));
      const r = await window.goviralDesktop.tiktok.post(${JSON.stringify(req)});
      off();
      return { r, seen };
    })()`);

  await scenario("1 bridge: app page → IPC → upload, description, product, Post now → posted (AI fallback, with the app's sign-in)", async () => {
    const before = aiCalls.length;
    await appWin.loadURL(`${ORIGIN}/desktop/projects`);
    const r = await postViaApp(job({ postId: "bridge1" }));
    assert.strictEqual(r.r.status, "posted", JSON.stringify(r.r));
    assert.strictEqual(r.r.ok, true);
    assert(r.seen.includes("posting:caption") && r.seen.includes("posting:product_pick") && r.seen.includes("posting:product_add") && r.seen.includes("posted:confirm_posted"), r.seen.join(","));
    const m = await mockState(bridged);
    assert.strictEqual(m.posted, true);
    assert.strictEqual(m.file, "Hydro test.mp4");
    assert(m.size > 40000, "the downloaded export went in");
    assert.strictEqual(m.product, "Hydro Flask 40 oz Tumbler");
    assert.strictEqual(m.caption, CAPTION);
    const calls = aiCalls.slice(before);
    assert(calls.length >= 2, "the changed page needed Groot");
    assert(calls.every((c) => c.cookie.includes("authjs.session-token=harness-signed-in")), "the AI fallback carries the app's sign-in");
    await shot(bridged, "engine-1-posted");
  });

  await scenario("2 bridge refuses: not an export, a made-up file id, not the app", async () => {
    const bad = await inApp(`window.goviralDesktop.tiktok.post(${JSON.stringify(job({ videoUrl: "https://evil.example/x.mp4" }))})`);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /isn't a GoViral export/);
    const noMode = await inApp(`window.goviralDesktop.tiktok.post(${JSON.stringify(job({ mode: "yolo" }))})`);
    assert.strictEqual(noMode.ok, false);
    const path1 = await inApp(`window.goviralDesktop.tiktok.post(${JSON.stringify(job({ videoUrl: undefined, source: { kind: "file", fileId: "C:/Windows/win.ini" } }))})`);
    assert.strictEqual(path1.ok, false, "a path is never a file id");
    bridgeUpload = UPLOAD;
    const madeUp = await inApp(`window.goviralDesktop.tiktok.post(${JSON.stringify(job({ videoUrl: undefined, source: { kind: "file", fileId: "f_" + "A".repeat(24) } }))})`);
    assert.strictEqual(madeUp.status, "failed");
    assert.match(madeUp.error, /isn't on this computer|isn't one you picked/);
    await appWin.loadURL(`${ORIGIN}/notapp`);
    const api = await inApp("JSON.stringify(Object.keys(window.goviralDesktop || {}))");
    assert.deepStrictEqual(JSON.parse(api), ["version", "platform"], "a page outside /desktop gets no TikTok, files or Drive API");
    bridged.close();
  });

  await scenario("3 changed page: scripted selectors miss, the AI fallback finds Add link and Publish", async () => {
    const p = makePoster("?v=changed");
    const before = aiCalls.length;
    const r = await p.post(job({ postId: "changed1" }));
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    const calls = aiCalls.slice(before);
    assert(calls.some((c) => c.step === "product_open") && calls.some((c) => c.step === "post"), JSON.stringify(calls));
    assert(calls.every((c) => c.screenshot > 1000 && c.elements > 0), "every AI call carried a screenshot and the elements");
    const m = await mockState(p);
    assert.strictEqual(m.variant, "changed");
    assert.strictEqual(m.posted, true);
    assert.strictEqual(m.product, "Hydro Flask 40 oz Tumbler");
    assert.strictEqual(m.caption, CAPTION);
    console.log(`       AI calls: ${calls.map((c) => c.step).join(", ")}`);
    await shot(p, "engine-3-changed-posted");
    p.close();
  });

  await scenario("4 manual: filled in and handed over; the creator presses Post now; Groot sees it", async () => {
    const p = makePoster();
    const events = [];
    const run = p.post(job({ postId: "manual1", mode: "manual" }), (e) => events.push(e));
    assert(await waitUntil(() => events.some((e) => e.status === "ready")), "never handed over");
    const m0 = await mockState(p);
    assert.strictEqual(m0.posted, false, "Manual never presses Post");
    assert.strictEqual(m0.product, "Hydro Flask 40 oz Tumbler");
    await sleep(2500);
    assert.strictEqual((await mockState(p)).posted, false, "the privacy setting's 'Everyone' is not a success notice");
    await shot(p, "engine-4-manual-ready");
    await inMock(p, `document.getElementById("post").click()`);
    const r = await run;
    assert.strictEqual(r.status, "posted");
    p.close();
  });

  await scenario("5 manual: 'Done, next video' hands it back unposted → ready", async () => {
    const p = makePoster();
    const events = [];
    const run = p.post(job({ postId: "manual2", mode: "manual" }), (e) => events.push(e));
    assert(await waitUntil(() => events.some((e) => e.status === "ready")));
    electron.ipcMain.emit("gvd:tiktok-bar:next", { sender: p.window().barContents });
    const r = await run;
    assert.strictEqual(r.status, "ready");
    assert.strictEqual((await mockState(p)).posted, false);
    p.close();
  });

  await scenario("6 captcha: pauses for the creator, never touches it, then posts", async () => {
    const p = makePoster("?captcha=1");
    const events = [];
    const run = p.post(job({ postId: "captcha1" }), (e) => events.push(e));
    assert(await waitUntil(() => events.some((e) => e.status === "needs_you" && e.reason === "captcha")), "no captcha pause");
    await shot(p, "engine-6-captcha-waiting");
    await sleep(1500);
    assert.strictEqual((await mockState(p)).posted, false);
    await inMock(p, `document.getElementById("captcha").remove()`); // the creator solves it
    const r = await run;
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    p.close();
  });

  await scenario("7 logged out: pauses on the log-in page, never types a password, then posts", async () => {
    const p = makePoster("?login=1");
    const events = [];
    const run = p.post(job({ postId: "login1" }), (e) => events.push(e));
    assert(await waitUntil(() => events.some((e) => e.status === "needs_you" && e.reason === "login")), "no login pause");
    const typed = await inMock(p, `document.querySelector("input[type=password]").value`);
    assert.strictEqual(typed, "", "Groot typed nothing into the password box");
    await inMock(p, `document.getElementById("loginBtn").click()`); // the creator logs in
    const r = await run;
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    p.close();
  });

  await scenario("8 stop: the Stop button mid-post → stopped, nothing posted", async () => {
    const p = makePoster();
    const events = [];
    const run = p.post(job({ postId: "stop1" }), (e) => events.push(e));
    assert(await waitUntil(() => events.some((e) => e.step === "caption")));
    electron.ipcMain.emit("gvd:tiktok-bar:stop", { sender: p.window().barContents });
    const r = await run;
    assert.strictEqual(r.status, "stopped");
    assert.strictEqual((await mockState(p)).posted, false);
    assert.strictEqual(p.busy(), false);
    p.close();
  });

  await scenario("9 no product: no product steps, posted", async () => {
    const p = makePoster();
    const events = [];
    const r = await p.post(job({ postId: "noprod1", product: null }), (e) => events.push(e));
    assert.strictEqual(r.status, "posted");
    assert(!events.some((e) => /^product_/.test(e.step || "")));
    const m = await mockState(p);
    assert.strictEqual(m.product, null);
    assert.strictEqual(m.posted, true);
    p.close();
  });

  await scenario("10 Drew's flow: Studio → Upload → Videos, description + hashtags, the showcase search, Next → Add, success notice", async () => {
    const p = makePoster("", STUDIO);
    const events = [];
    const r = await p.post(job({ postId: "drew1", name: "slipper take 1", product: "Comfort slippers", caption: "comfort weekend slipper", hashtags: ["slippers", "comfort"] }), (e) => events.push(e));
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    const m = await mockState(p);
    assert(m.events.includes("videos tab"), "went Upload → Videos");
    assert.strictEqual(m.caption, "comfort weekend slipper #slippers #comfort");
    assert.deepStrictEqual(m.searches, ["Comfort slippers", "slippers", "slipper"], "the full name first, then the product word, then its singular");
    assert.strictEqual(m.product, "Comfort Weekend Slipper", "the matching row, not Cloud Comfort Slides");
    assert.strictEqual(m.productName, "Comfort Weekend Slipper", "the link name is never renamed");
    assert.strictEqual(m.playlist, "", "no playlist");
    assert.strictEqual(m.location, "", "no location");
    assert.strictEqual(m.posted, true);
    assert(events.some((e) => e.step === "product_next") && events.some((e) => e.step === "product_add"));
    await shot(p, "engine-10-success-notice");
    p.close();
  });

  await scenario("11 not in the showcase: that video stops with the creator's words, the next one posts", async () => {
    const p = makePoster();
    const events = [];
    const r = await p.post(job({ postId: "nf1", product: "Fuzzy Bear Earmuffs" }), (e) => events.push(e));
    assert.strictEqual(r.status, "failed");
    assert(r.error.startsWith("That product isn't in your TikTok Shop showcase"), r.error);
    assert.match(r.error, /"Fuzzy Bear Earmuffs", "Earmuffs", "earmuff", "Bear", "Fuzzy" and the whole showcase/, "says what was searched");
    assert.strictEqual(r.code, "product_not_found");
    const m = await mockState(p);
    assert.strictEqual(m.posted, false);
    assert.strictEqual(m.product, null, "nothing else was tagged instead");
    assert.deepStrictEqual(m.searches, ["Fuzzy Bear Earmuffs", "Earmuffs", "earmuff", "Bear", "Fuzzy", ""]);
    assert(events.some((e) => e.status === "failed" && e.code === "product_not_found"));
    await shot(p, "engine-11-not-in-showcase");
    // the half-filled page asks "leave?": the next video goes on anyway
    const r2 = await p.post(job({ postId: "nf2" }));
    assert.strictEqual(r2.status, "posted", JSON.stringify(r2));
    p.close();
  });

  await scenario("12 invalid characters in the link name: only those come out, then Add", async () => {
    const p = makePoster();
    const r = await p.post(job({ postId: "inv1", product: "Glow Serum Vitamin C", caption: "glow serum vitamin c", hashtags: ["skincare"] }));
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    const m = await mockState(p);
    assert.strictEqual(m.product, "Glow Serum ✨ Vitamin C ★ 30ml");
    assert.strictEqual(m.productName, "Glow Serum Vitamin C 30ml");
    assert(m.nameErrors > 0, "TikTok complained first");
    p.close();
  });

  await scenario("13 a 'Post now?' dialog after Post now", async () => {
    const p = makePoster("?confirm=1");
    const r = await p.post(job({ postId: "conf1" }));
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    const m = await mockState(p);
    assert.strictEqual(m.posted, true);
    assert.strictEqual(m.events.filter((e) => e === "post pressed").length, 1, "the page's own button pressed once");
    p.close();
  });

  await scenario("14 finished files: the picked folder → 10-4 → videos with lengths → posted from the file itself", async () => {
    bridgeUpload = UPLOAD;
    await appWin.loadURL(`${ORIGIN}/desktop/post`);
    const picked = await inApp(`window.goviralDesktop.files.pickFolder({ remember: false })`);
    assert(picked.ok, JSON.stringify(picked));
    assert.strictEqual(picked.root.name, "TikTok Shop vids");
    assert.strictEqual(picked.root.remembered, false);
    assert(!fs.existsSync(STORE) || !fs.readFileSync(STORE, "utf8").includes("TikTok Shop vids"), "not remembered without permission");
    const tree = await inApp(`window.goviralDesktop.files.folders(${JSON.stringify(picked.root.id)})`);
    assert.deepStrictEqual(tree.folders.map((f) => [f.rel, f.videos]), [["", 0], ["10-4", 2], ["10-5", 1]]);
    const vids = await inApp(`window.goviralDesktop.files.videos(${JSON.stringify(picked.root.id)}, "10-4")`);
    assert(vids.ok, JSON.stringify(vids));
    assert.deepStrictEqual(vids.videos.map((v) => [v.name, v.seconds]), [["slipper take 1.mp4", 18.2], ["slipper take 2.mov", 27]]);
    assert(vids.videos.every((v) => /^f_/.test(v.fileId) && !("path" in v)), "ids, never paths");
    const out = await inApp(`window.goviralDesktop.files.videos(${JSON.stringify(picked.root.id)}, "../")`);
    assert.strictEqual(out.ok, false, "nothing outside the picked folder");
    const out2 = await inApp(`window.goviralDesktop.files.videos("r_notarealroot1", "")`);
    assert.strictEqual(out2.ok, false);
    const r = await postViaApp({ postId: "file1", source: { kind: "file", fileId: vids.videos[0].fileId }, name: vids.videos[0].name, mode: "auto", product: "Comfort slippers", caption: "comfort weekend slipper", hashtags: ["slippers", "comfort"] });
    assert.strictEqual(r.r.status, "posted", JSON.stringify(r.r));
    const m = await mockState(bridged);
    assert.strictEqual(m.file, "slipper take 1.mp4", "TikTok got the creator's own file");
    assert.strictEqual(m.product, "Comfort Weekend Slipper");
    assert(fs.existsSync(path.join(SHOP, "10-4", "slipper take 1.mp4")), "the creator's file is still there");
    // remembered only when the creator says so
    assert(await inApp(`window.goviralDesktop.files.remember(${JSON.stringify(picked.root.id)}, true)`));
    assert(fs.readFileSync(STORE, "utf8").includes("TikTok Shop vids"));
    await shot(bridged, "engine-14-finished-file-posted");
  });

  await scenario("15 dropped files: a File from the page → its path in the preload → an id → posted", async () => {
    const dbg = appWin.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const { root } = await dbg.sendCommand("DOM.getDocument", {});
    const { nodeId } = await dbg.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#pick" });
    await dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files: [DROPPED, path.join(SHOP, "10-4", "notes.txt")] });
    const added = await inApp(`window.goviralDesktop.files.addDropped(Array.from(document.getElementById("pick").files))`);
    assert.strictEqual(added.videos.length, 1, JSON.stringify(added));
    assert.deepStrictEqual(added.skipped, ["notes.txt"]);
    assert.strictEqual(added.videos[0].seconds, 12);
    const fake = await inApp(`window.goviralDesktop.files.addDropped([new File(["x"], "C:/Windows/evil.mp4")])`);
    assert.strictEqual(fake.videos.length, 0, "a File made up by the page has no path");
    const r = await postViaApp({ postId: "drop1", source: { kind: "file", fileId: added.videos[0].fileId }, name: "dropped slipper", mode: "auto", product: null, caption: "comfort weekend slipper", hashtags: ["slippers"] });
    assert.strictEqual(r.r.status, "posted", JSON.stringify(r.r));
    assert.strictEqual((await mockState(bridged)).file, "dropped slipper.mp4");
    dbg.detach();
  });

  await scenario("16 Google Drive: connect (PKCE, the loopback listener) → a Drive video downloaded and posted", async () => {
    const before = await postViaApp({ postId: "drv0", source: { kind: "drive", fileId: "DrvComfort_0123456789" }, name: "x", mode: "auto", product: null, caption: "x", hashtags: [] });
    assert.strictEqual(before.r.status, "failed");
    assert.match(before.r.error, /Connect Google Drive first/);
    const c = await inApp(`window.goviralDesktop.drive.connect()`);
    assert.deepStrictEqual(c, { ok: true, email: "creator@example.com" });
    assert.strictEqual(opened.length, 1);
    const consent = new URL(opened[0]);
    assert.strictEqual(consent.searchParams.get("code_challenge_method"), "S256");
    assert.match(consent.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const r = await postViaApp({ postId: "drv1", source: { kind: "drive", fileId: "DrvComfort_0123456789" }, name: "Comfort slipper drive take", mode: "auto", product: "Comfort slippers", caption: "comfort weekend slipper", hashtags: ["slippers", "comfort"] });
    assert.strictEqual(r.r.status, "posted", JSON.stringify(r.r));
    assert(r.seen.includes("posting:download"));
    const m = await mockState(bridged);
    assert.strictEqual(m.file, "Comfort slipper drive take.mp4");
    assert(m.size > 40000);
    const missing = await postViaApp({ postId: "drv2", source: { kind: "drive", fileId: "NotMine_0123456789" }, name: "x", mode: "auto", product: null, caption: "x", hashtags: [] });
    assert.strictEqual(missing.r.status, "failed");
    bridged.close();
  });

  await scenario("17 slow upload: description + product typed WHILE TikTok uploads; Post only after it", async () => {
    const p = makePoster("?slow=30");
    const r = await p.post(job({ postId: "slow1", product: "Comfort slippers", caption: "the comfort weekend slipper for lazy days at home", hashtags: ["slippers", "comfort", "weekendvibes", "cozyathome"] }));
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    const m = await mockState(p);
    assert(m.captionTypedPct !== null && m.captionTypedPct < 100, `typed at ${m.captionTypedPct}%`);
    assert.strictEqual(m.caption, "the comfort weekend slipper for lazy days at home #slippers #comfort #weekendvibes #cozyathome");
    assert.strictEqual(m.product, "Comfort Weekend Slipper");
    assert(Array.isArray(r.steps) && r.steps.length === 13 && r.steps.every((s) => s.ok), JSON.stringify(r.steps));
    console.log(`       steps: ${r.steps.map((s) => `${s.step} ${(s.ms / 1000).toFixed(1)}`).join(", ")}`);
    p.close();
  });

  await scenario("18 the hashtag list eats a space typed while it's open: the description still exact", async () => {
    const p = makePoster("?eat=1");
    const r = await p.post(job({ postId: "eat1", caption: "the comfort weekend slipper for lazy days at home", hashtags: ["slippers", "comfort", "weekendvibes", "cozyathome"] }));
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    const m = await mockState(p);
    assert.strictEqual(m.caption, "the comfort weekend slipper for lazy days at home #slippers #comfort #weekendvibes #cozyathome");
    assert.strictEqual(m.eaten, 0, "never typed a space into an open hashtag list");
    p.close();
  });

  await scenario("18b Drew's showcase (2026-10-05): a div table, drawn radios, pages; the slipper on page 3 of the search", async () => {
    const p = makePoster("?showcase=big");
    const r = await p.post(job({ postId: "big1", product: "comfrt weekend slippers" }));
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    const m = await mockState(p);
    assert.strictEqual(m.product, "Comfrt | Weekend Slipper | Faux Suede Slip-On With Sherpa-Lin");
    assert(m.events.includes("page 3"), m.events.join(" / ") + " :: " + r.steps.map((s) => s.step + ": " + s.how).join(" || "));
    assert.deepStrictEqual(m.searches, ["comfrt weekend slippers"], "found without a second search");
    await shot(p, "engine-18b-showcase-page-3");
    p.close();
  });

  await scenario("19 TikTok puts the file name back when the upload finishes: written again before Post", async () => {
    const p = makePoster("?prefill=1&slow=12");
    const r = await p.post(job({ postId: "prefill1", name: "comfort slippers" }));
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    const m = await mockState(p);
    assert.strictEqual(m.rewritten, 1);
    assert.strictEqual(m.caption, CAPTION, "not the file name");
    p.close();
  });

  await scenario("20 none clearly the creator's product: needs you with the list; the creator picks; posted", async () => {
    const p = makePoster();
    const events = [];
    const run = p.post(job({ postId: "pick1", product: "Comfort shoes" }), (e) => events.push(e));
    assert(await waitUntil(() => events.some((e) => e.status === "needs_you" && e.reason === "step")), "no needs-you");
    const ask = events.find((e) => e.status === "needs_you");
    assert.match(ask.message, /"Comfort Weekend Slipper", "Cloud Comfort Slides"/);
    await shot(p, "engine-20-needs-you-pick");
    await inMock(p, `[...document.querySelectorAll("#rows [role=radio]")].find((r) => r.textContent === "Cloud Comfort Slides").click()`); // the creator's choice
    const r = await run;
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
    assert.strictEqual((await mockState(p)).product, "Cloud Comfort Slides");
    p.close();
  });

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  server.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* temp */ }
  app.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
