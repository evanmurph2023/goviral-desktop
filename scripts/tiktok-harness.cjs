// npm run harness:tiktok — Groot's TikTok engine, end to end, against a LOCAL MOCK of TikTok
// Studio's upload page (test/tiktok-mock/upload.html). Never touches tiktok.com.
//
//   electron scripts/tiktok-harness.cjs [shots-dir]
//
// A tiny local server plays every part: the mock upload page, the "finished export" (a few KB of
// bytes, no real video), the app's own /desktop page (for the preload bridge), and a mock of the
// platform's AI fallback (POST /api/groot-post/next-action) that answers like Groot would.
// Scenarios:
//   1 bridge: the app page calls window.goviralDesktop.tiktok.post() → IPC → download → upload →
//     product tag → caption → post → posted; progress events reach the page
//   2 bridge refuses: a non-export URL, a page outside /desktop has no tiktok API
//   3 changed page: the Post and Add link buttons are different, the AI fallback finds them
//   4 manual: stops on the filled-in page; the creator presses Post; Groot sees it posted
//   5 manual, "Done, next video": handed back without posting → ready
//   6 captcha: Groot pauses (needs_you: captcha) until the creator clears it, then posts
//   7 logged out: Groot pauses (needs_you: login) until the creator logs in, then posts
//   8 stop: the Stop button mid-post → stopped, nothing posted
//   9 no product: no product steps, posted
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
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
const TIMEOUTS = { find: 3500, posted: 15000, blocker: 30000, handoff: 30000, processed: 20000 };

app.commandLine.appendSwitch("disable-gpu-sandbox");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the local server ----------------------------------------------------------------------------
const aiCalls = [];
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
      const el = named(/^(publish( now)?|post)$/i);
      return el ? { ...nulls, action: "click", ref: el.ref, why: "publish" } : { ...nulls, action: "need_user", reason: "other", message: "No post button", why: "lost" };
    }
    default:
      return { ...nulls, action: "need_user", reason: "other", message: `mock Groot has no answer for ${body.step}`, why: "mock" };
  }
}

function startServer() {
  const video = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(48 * 1024, 7)]);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/tiktokstudio/upload" || u.pathname === "/tiktokstudio/content") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(MOCK_HTML); }
    if (u.pathname === "/video.mp4") { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": video.length }); return res.end(video); }
    if (u.pathname.startsWith("/desktop") || u.pathname === "/notapp") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<!doctype html><title>app</title><div id=root>app</div>"); }
    if (u.pathname === "/api/groot-post/next-action" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* bad */ }
        body.__cookie = req.headers.cookie || "";
        const action = mockGroot(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, action, left: 29 }));
      });
      return;
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
  const t0 = Date.now();
  try { await fn(); console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e}`); }
}

app.whenReady().then(async () => {
  const server = await startServer();
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const UPLOAD = `${ORIGIN}/tiktokstudio/upload`;
  const VIDEO = `${ORIGIN}/video.mp4`;
  const { createPoster, makeGrootClient } = require(path.join(ROOT, "src", "tiktok", "poster.js"));
  const { setUpTikTok } = require(path.join(ROOT, "src", "tiktok", "index.js"));
  const fetchImpl = (url, init) => net.fetch(url, init);
  const makePoster = (query = "") => createPoster({
    electron, log: LOG, pace: PACE, show: SHOW, timeouts: TIMEOUTS, allowLocal: true,
    uploadUrl: UPLOAD + query, groot: makeGrootClient({ origin: ORIGIN, fetchImpl }), fetchVideo: fetchImpl, userAgent: app.userAgentFallback,
  });
  const job = (over = {}) => ({ postId: `p${Date.now()}`, videoUrl: VIDEO, name: "Hydro test", mode: "auto", product: "Hydro Flask 40 oz", caption: "Ice for two days, no joke", hashtags: ["hydroflask", "tiktokshop"], ...over });
  const CAPTION = "Ice for two days, no joke #hydroflask #tiktokshop";
  console.log(`Groot TikTok engine harness (mock at ${ORIGIN}, pace ${PACE})`);

  // 1 + 2: through the real preload and IPC bridge, as the app will call it.
  process.env.GOVIRAL_TIKTOK_LOCAL = "1";
  // the bridge run uses the changed page, so its AI fallback goes out through the app session
  process.env.GOVIRAL_TIKTOK_UPLOAD_URL = UPLOAD + "?v=changed";
  // the app is signed in: its cookie must ride along on the AI fallback call
  await electron.session.defaultSession.cookies.set({ url: ORIGIN, name: "authjs.session-token", value: "harness-signed-in" });
  const bridged = setUpTikTok({ electron, appOrigin: ORIGIN, log: LOG, overrides: { pace: PACE, show: SHOW, timeouts: TIMEOUTS } });
  const appWin = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, "src", "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--gvd-origin=${ORIGIN}`, "--gvd-version=harness", "--gvd-titlebar=0"] } });

  await scenario("1 bridge: app page → IPC → upload, product, caption, post → posted (AI fallback, with the app's sign-in)", async () => {
    const before = aiCalls.length;
    await appWin.loadURL(`${ORIGIN}/desktop/projects`);
    const r = await appWin.webContents.executeJavaScript(`(async () => {
      const seen = [];
      const off = window.goviralDesktop.tiktok.onProgress((p) => seen.push(p.status + ":" + (p.step || "")));
      const r = await window.goviralDesktop.tiktok.post(${JSON.stringify(job({ postId: "bridge1" }))});
      off();
      return { r, seen };
    })()`);
    assert.strictEqual(r.r.status, "posted", JSON.stringify(r.r));
    assert.strictEqual(r.r.ok, true);
    assert(r.seen.includes("posting:caption") && r.seen.includes("posting:product_pick") && r.seen.includes("posted:confirm_posted"), r.seen.join(","));
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

  await scenario("2 bridge refuses: not an export, not the app", async () => {
    const bad = await appWin.webContents.executeJavaScript(`window.goviralDesktop.tiktok.post(${JSON.stringify(job({ videoUrl: "https://evil.example/x.mp4" }))})`);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /isn't a GoViral export/);
    const noMode = await appWin.webContents.executeJavaScript(`window.goviralDesktop.tiktok.post(${JSON.stringify(job({ mode: "yolo" }))})`);
    assert.strictEqual(noMode.ok, false);
    await appWin.loadURL(`${ORIGIN}/notapp`);
    const api = await appWin.webContents.executeJavaScript("typeof (window.goviralDesktop && window.goviralDesktop.tiktok)");
    assert.strictEqual(api, "undefined", "a page outside /desktop gets no TikTok API");
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

  await scenario("4 manual: filled in and handed over; the creator presses Post; Groot sees it", async () => {
    const p = makePoster();
    const events = [];
    const run = p.post(job({ postId: "manual1", mode: "manual" }), (e) => events.push(e));
    assert(await waitUntil(() => events.some((e) => e.status === "ready")), "never handed over");
    const m0 = await mockState(p);
    assert.strictEqual(m0.posted, false, "Manual never presses Post");
    assert.strictEqual(m0.product, "Hydro Flask 40 oz Tumbler");
    await shot(p, "engine-4-manual-ready");
    await inMock(p, `document.getElementById("post").click(); setTimeout(() => document.getElementById("postNow").click(), 200);`);
    const r = await run;
    assert.strictEqual(r.status, "posted");
    p.close();
  });

  await scenario("5 manual: 'Done, next video' hands it back unposted → ready", async () => {
    const p = makePoster();
    const events = [];
    const run = p.post(job({ postId: "manual2", mode: "manual" }), (e) => events.push(e));
    assert(await waitUntil(() => events.some((e) => e.status === "ready")));
    // the bar's own button, as the creator presses it
    const w = p.window();
    electron.ipcMain.emit("gvd:tiktok-bar:next", { sender: w.barContents });
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

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  server.close();
  app.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
