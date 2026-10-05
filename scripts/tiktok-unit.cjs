// npm run test:tiktok — the pure rules of Groot's TikTok poster (src/tiktok/rules.js), plain Node,
// no window. The engine itself runs end to end in scripts/tiktok-harness.cjs.
"use strict";

const assert = require("assert");
const path = require("path");
const R = require(path.join(__dirname, "..", "src", "tiktok", "rules.js"));

let failures = 0;
const pending = [];
const test = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e && e.message}`); } };
const APP = "https://app.govirall.now";

console.log("callers and inputs");
test("only the app's /desktop pages may post", () => {
  assert(R.isAllowedCaller("https://app.govirall.now/desktop", APP));
  assert(R.isAllowedCaller("https://app.govirall.now/desktop/projects?x=1", APP));
  assert(!R.isAllowedCaller("https://app.govirall.now/desktopx", APP));
  assert(!R.isAllowedCaller("https://app.govirall.now/creator/upload", APP));
  assert(!R.isAllowedCaller("https://app.govirall.now.evil.example/desktop", APP));
  assert(!R.isAllowedCaller("file:///C:/offline.html", APP));
  assert(!R.isAllowedCaller("", APP));
});
test("exports only from Blob, the worker or the site; local only in a dev build", () => {
  assert(R.isVideoUrl("https://abc.public.blob.vercel-storage.com/exports/x.mp4"));
  assert(R.isVideoUrl("https://goviral-platform-production.up.railway.app/download/x.mp4"));
  assert(!R.isVideoUrl("http://abc.public.blob.vercel-storage.com/x.mp4"));
  assert(!R.isVideoUrl("https://evil.example/x.mp4"));
  assert(!R.isVideoUrl("https://user:pw@app.govirall.now/x.mp4"));
  assert(!R.isVideoUrl("file:///C:/x.mp4"));
  assert(!R.isVideoUrl("http://127.0.0.1:5000/video.mp4"));
  assert(R.isVideoUrl("http://127.0.0.1:5000/video.mp4", { allowLocal: true }));
});
test("the TikTok window shows TikTok and its log-in providers only", () => {
  assert(R.isTikTokUrl("https://www.tiktok.com/tiktokstudio/upload"));
  assert(R.isTikTokUrl("https://tiktok.com/login"));
  assert(!R.isTikTokUrl("https://tiktok.com.evil.example/"));
  assert(!R.isTikTokUrl("http://www.tiktok.com/"));
  assert(R.isLoginProviderUrl("https://accounts.google.com/o/oauth2"));
  assert(!R.isLoginProviderUrl("https://google.com.evil.example/"));
});
test("a post request is validated field by field", () => {
  const ok = R.validatePostRequest({ postId: "p_1", videoUrl: "https://a.public.blob.vercel-storage.com/x.mp4", mode: "auto", caption: "Cold  for days — really", hashtags: ["#hydro", "bad tag", "x".repeat(50), "a", "b", "c", "d", "e"], product: "  Hydro Flask ", name: "" });
  assert(ok.ok);
  assert.strictEqual(ok.value.caption, "Cold for days, really");
  assert.deepStrictEqual(ok.value.hashtags, ["hydro", "a", "b", "c", "d"]);
  assert.strictEqual(ok.value.product, "Hydro Flask");
  assert.strictEqual(ok.value.name, "GoViral video");
  assert(!R.validatePostRequest({ postId: "../x", videoUrl: "https://a.public.blob.vercel-storage.com/x.mp4", mode: "auto" }).ok);
  assert(!R.validatePostRequest({ postId: "p", videoUrl: "https://evil.example/x.mp4", mode: "auto" }).ok);
  assert(!R.validatePostRequest({ postId: "p", videoUrl: "https://a.public.blob.vercel-storage.com/x.mp4", mode: "yolo" }).ok);
  assert(!R.validatePostRequest(null).ok);
  assert(!R.validatePostRequest([]).ok);
  assert.strictEqual(R.validatePostRequest({ postId: "p", videoUrl: "https://a.public.blob.vercel-storage.com/x.mp4", mode: "manual", product: null }).value.product, null);
});
test("caption text = caption then hashtags (the platform builds the same string)", () => {
  assert.strictEqual(R.captionText("Ice for days", ["hydro", "tiktokshop"]), "Ice for days #hydro #tiktokshop");
  assert.strictEqual(R.captionText("", ["a"]), "#a");
  assert.strictEqual(R.captionText("Just words", []), "Just words");
});
test("file names are safe", () => {
  assert.strictEqual(R.safeFileName('a/b:c*?"<>|'), "a b c.mp4");
  assert.strictEqual(R.safeFileName(""), "GoViral video.mp4");
});

console.log("the scripted-step planner");
test("Auto with a product: Drew's walk (upload, description, Add link, Products, Next, search, pick, Next, name, Add, Post now, success)", () => {
  assert.deepStrictEqual(R.planSteps({ mode: "auto", product: "Hydro" }), ["open", "upload", "caption", "product_open", "product_tab", "product_search", "product_pick", "product_next", "product_name", "product_add", "wait_processed", "post", "confirm_posted"]);
});
test("speed: the description and product go in while TikTok uploads; the upload is waited for right before Post", () => {
  for (const mode of ["auto", "manual"]) for (const product of ["x", null]) {
    const s = R.planSteps({ mode, product });
    assert(s.indexOf("caption") < s.indexOf("wait_processed"), "description first");
    assert.strictEqual(s[s.indexOf("wait_processed") + 1], mode === "auto" ? "post" : "handoff");
  }
});
test("TikTok Studio, not tiktok.com/upload", () => {
  assert.strictEqual(R.TIKTOK_UPLOAD_URL, "https://www.tiktok.com/tiktokstudio/upload");
});
test("Manual vs Auto: the same filling-in, only Auto presses Post now", () => {
  const a = R.planSteps({ mode: "auto", product: "x" }), m = R.planSteps({ mode: "manual", product: "x" });
  assert.deepStrictEqual(a.slice(0, -2), m.slice(0, -1));
  assert.deepStrictEqual(a.slice(-2), ["post", "confirm_posted"]);
  assert.deepStrictEqual(m.slice(-1), ["handoff"]);
});
test("the link name is never the AI's; a row the AI clicks is still held to the creator's words", () => {
  assert(!R.AI_STEPS.has("product_name"));
  assert(R.AI_STEPS.has("product_pick"));
});
test("Manual stops at the handoff and never posts", () => {
  const s = R.planSteps({ mode: "manual", product: "Hydro" });
  assert.strictEqual(s[s.length - 1], "handoff");
  assert(!s.includes("post"));
});
test("no product: no product steps", () => {
  assert(!R.planSteps({ mode: "auto", product: null }).some((s) => s.startsWith("product_")));
});
test("every step has words, every AI step has targets to try first", () => {
  for (const s of R.planSteps({ mode: "auto", product: "x" }).concat("handoff")) assert(R.STEP_WORDS[s], s);
  for (const t of Object.values(R.TARGETS)) assert(Array.isArray(t) && t.length > 0);
  assert(!R.AI_STEPS.has("open") && !R.AI_STEPS.has("handoff"));
});

console.log("no silent hangs: every wait has a limit, every AI step has words for the creator");
test("timeouts: a missing button goes to Groot in seconds; the upload waits long only while it moves", () => {
  const T = R.TIMEOUTS;
  assert(T.find <= 10000 && T.results <= 10000 && T.goto <= 30000);
  assert(T.stall <= 30000, "nothing on screen about the upload: Groot looks within 30 s");
  assert(T.stuck <= 5 * 60000 && T.creator <= 3 * 60000 && T.ai <= 45000 && T.cdp <= 20000);
  for (const [k, v] of Object.entries(T)) assert(Number.isFinite(v) && v > 0, k);
});
test("every step Groot can try has plain words for the creator when Groot can't", () => {
  for (const s of R.AI_STEPS) assert(R.STEP_HELP[s] && /TikTok window/.test(R.STEP_HELP[s]), s);
  for (const t of Object.values(R.STEP_HELP)) assert(!/[—–]/.test(t), "no dashes in the creator's words");
});
test("TikTok's upload words: uploaded vs still going", () => {
  const re = (name) => R.TARGETS[name].filter((w) => w.text).map((w) => new RegExp(w.text, "i"));
  const up = (t) => re("uploaded").some((r) => r.test(t));
  const going = (t) => re("uploadProgress").some((r) => r.test(t));
  for (const t of ["Uploaded", "Uploaded (25.08MB)", "Uploaded（25.08MB）", "Upload complete", "Upload completed.", "100%", "100 %"]) assert(up(t), t);
  for (const t of ["Upload", "Uploaded videos", "Upload videos", "Uploading 45%", "45%"]) assert(!up(t), t);
  for (const t of ["Uploading 45%", "Uploading...", "Processing", "45%", "7.5 %"]) assert(going(t), t);
  for (const t of ["100%", "Uploaded", "Upload"]) assert(!going(t), t);
});

console.log("the description");
test("normCaption: spaces collapsed, invisible characters gone", () => {
  assert.strictEqual(R.normCaption("  a\u200b  b\n#c\u00a0d "), "a b #c d");
  assert.strictEqual(R.normCaption(null), "");
});
test("captionParts: the caption, then each hashtag on its own (Escape goes after each)", () => {
  assert.deepStrictEqual(R.captionParts("the comfort weekend slipper", ["slippers", "comfort"]), ["the comfort weekend slipper", " #slippers", " #comfort"]);
  assert.deepStrictEqual(R.captionParts("", ["a", "b"]), ["#a", " #b"]);
  assert.strictEqual(R.captionParts("x y", ["a", "b"]).join(""), R.captionText("x y", ["a", "b"]), "the pieces are exactly the caption text");
});
test("showcaseList: a few titles for a needs-you message", () => {
  assert.strictEqual(R.showcaseList([{ text: "A" }, { text: "B" }, { text: "A" }]), '"A", "B"');
  assert.strictEqual(R.showcaseList([1, 2, 3, 4, 5, 6, 7].map((n) => ({ text: `P${n}` })), 3), '"P1", "P2", "P3" and 4 more');
  assert.strictEqual(R.showcaseList([]), "");
});

console.log("the product in the showcase");
test("the creator's words find TikTok's title (plurals, case, accents, filler)", () => {
  assert.strictEqual(R.productScore("Comfort slippers", "Comfort Weekend Slipper"), 1);
  assert.strictEqual(R.productScore("the comfort slippers", "COMFORT WEEKEND SLIPPER"), 1);
  assert.strictEqual(R.productScore("Comfort slippers", "Cloud Comfort Slides"), 0.5);
  assert.strictEqual(R.productScore("Hydro Flask 40 oz", "Hydro Flask 40 oz Tumbler"), 1);
  assert.strictEqual(R.productScore("crème brûlée kit", "Creme Brulee Kit"), 1);
  assert.strictEqual(R.productScore("", "anything"), 0);
});
test("pickProduct: the best row, the shorter title on a tie, nothing below 3 in 4 words", () => {
  const rows = [{ ref: 0, text: "Cloud Comfort Slides" }, { ref: 1, text: "Comfort Weekend Slipper" }, { ref: 2, text: "Comfort Weekend Slipper Bundle 2 pack" }];
  assert.strictEqual(R.pickProduct("Comfort slippers", rows).ref, 1);
  assert.strictEqual(R.pickProduct("Fuzzy Bear Earmuffs", rows), null);
  assert.strictEqual(R.pickProduct("Comfort", [{ ref: 0, text: "Cloud Comfort Slides" }]).ref, 0);
  assert.strictEqual(R.pickProduct("Weekend comfort slippers navy", rows).ref, 1, "3 of 4 words is enough");
  assert.strictEqual(R.pickProduct("Comfort slippers navy suede", rows), null, "2 of 4 is not");
  assert.strictEqual(R.pickProduct("x", []), null);
});
test("searchTerms: as said, then the first word", () => {
  assert.deepStrictEqual(R.searchTerms("Comfort slippers"), ["Comfort slippers", "Comfort"]);
  assert.deepStrictEqual(R.searchTerms("The Comfort slippers"), ["The Comfort slippers", "Comfort"]);
  assert.deepStrictEqual(R.searchTerms("Stanley"), ["Stanley"]);
});
test("cleanProductName: only what TikTok refuses comes out", () => {
  assert.strictEqual(R.cleanProductName("Glow Serum ✨ Vitamin C ★ 30ml"), "Glow Serum Vitamin C 30ml");
  assert.strictEqual(R.cleanProductName("Comfort Weekend Slipper"), "Comfort Weekend Slipper", "unchanged when clean");
  assert.strictEqual(R.cleanProductName("Tom's Socks & Co. | Navy"), "Tom's Socks & Co. Navy");
  assert.strictEqual(R.cleanProductName("Tom's Socks & Co. (Navy)", 2), "Tom s Socks Co Navy");
  assert.strictEqual(R.cleanProductName("Hydro Flask™ 40oz®"), "Hydro Flask 40oz");
});
test("the not-in-showcase words", () => {
  assert.strictEqual(R.NOT_IN_SHOWCASE, "That product isn't in your TikTok Shop showcase");
});

console.log("where a video comes from");
test("a GoViral export, a file id, a Drive id; never a path", () => {
  const base = { postId: "p1", mode: "auto" };
  assert.deepStrictEqual(R.validatePostRequest({ ...base, source: { kind: "url", url: "https://a.public.blob.vercel-storage.com/x.mp4" } }).value.source, { kind: "url", url: "https://a.public.blob.vercel-storage.com/x.mp4" });
  const f = R.validatePostRequest({ ...base, source: { kind: "file", fileId: "f_abcdefghijklmnopqrstuv" } });
  assert(f.ok && f.value.source.kind === "file" && f.value.videoUrl === null);
  assert(R.validatePostRequest({ ...base, source: { kind: "drive", fileId: "1AbCdEfGhIjK_-xyz" } }).ok);
  assert(!R.validatePostRequest({ ...base, source: { kind: "file", fileId: "C:\\Users\\me\\x.mp4" } }).ok);
  assert(!R.validatePostRequest({ ...base, source: { kind: "file", fileId: "../../etc/passwd" } }).ok);
  assert(!R.validatePostRequest({ ...base, source: { kind: "drive", fileId: "a/b" } }).ok);
  assert(!R.validatePostRequest({ ...base, source: { kind: "path", path: "/x.mp4" } }).ok);
  assert(!R.validatePostRequest({ ...base }).ok);
  assert.strictEqual(R.validatePostRequest({ ...base, videoUrl: "https://app.govirall.now/x.mp4" }).value.source.kind, "url", "the first shape still works");
});

console.log("the creator's folders (files.js)");
const F = require(path.join(__dirname, "..", "src", "tiktok", "files.js"));
test("inside the picked folder, never outside", () => {
  assert(F.isInside("C:\\v\\TikTok Shop vids", "C:\\v\\TikTok Shop vids\\10-4", "win32"));
  assert(F.isInside("C:\\v\\TikTok Shop vids", "c:\\V\\tiktok shop vids", "win32"));
  assert(!F.isInside("C:\\v\\TikTok Shop vids", "C:\\v\\TikTok Shop vids2", "win32"));
  assert(!F.isInside("C:\\v\\TikTok Shop vids", "C:\\v", "win32"));
  assert.strictEqual(F.resolveRel(path.resolve("/tmp/shop"), "../x"), null);
  assert.strictEqual(F.resolveRel(path.resolve("/tmp/shop"), "10-4/../../x"), null);
  assert.strictEqual(F.resolveRel(path.resolve("/tmp/shop"), "10-4"), path.resolve("/tmp/shop", "10-4"));
});
test("videos only", () => {
  for (const n of ["a.mp4", "B.MOV", "c.m4v", "d.webm"]) assert(F.isVideoName(n), n);
  for (const n of ["a.txt", "a.mp4.lnk", ".hidden.mp4", "a.mkv", "a"]) assert(!F.isVideoName(n), n);
});
test("the length from the MP4 header, nothing decoded", () => {
  const os = require("os"), fs = require("fs");
  const box = (type, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
  const v0 = Buffer.alloc(100); v0.writeUInt32BE(600, 12); v0.writeUInt32BE(600 * 31, 16);
  const v1 = Buffer.alloc(112); v1[0] = 1; v1.writeUInt32BE(90000, 20); v1.writeBigUInt64BE(BigInt(90000 * 75), 24);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gvd-unit-"));
  const a = path.join(dir, "a.mp4"), b = path.join(dir, "b.mov"), c = path.join(dir, "c.mp4");
  fs.writeFileSync(a, Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(5000)), box("moov", Buffer.concat([box("trak", Buffer.alloc(40)), box("mvhd", v0)]))]));
  fs.writeFileSync(b, Buffer.concat([box("ftyp", Buffer.from("qt  0000")), box("moov", box("mvhd", v1)), box("mdat", Buffer.alloc(5000))]));
  fs.writeFileSync(c, Buffer.alloc(5000, 1));
  pending.push((async () => {
    assert.strictEqual(await F.mp4Seconds(a), 31);
    assert.strictEqual(await F.mp4Seconds(b), 75);
    assert.strictEqual(await F.mp4Seconds(c), null);
    assert.strictEqual(await F.mp4Seconds(path.join(dir, "missing.mp4")), null);
    fs.rmSync(dir, { recursive: true, force: true });
  })());
});

console.log("Google Drive (drive.js)");
const D = require(path.join(__dirname, "..", "src", "tiktok", "drive.js"));
test("PKCE: S256 of the verifier, the verifier stays here", () => {
  const { verifier, challenge } = D.pkcePair();
  assert(verifier.length >= 43 && verifier.length <= 128);
  assert.strictEqual(challenge, require("crypto").createHash("sha256").update(verifier).digest("base64url"));
});
test("only Google's consent page opens (or the harness's, in a dev build)", () => {
  assert(D.isConsentUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
  assert(!D.isConsentUrl("https://accounts.google.com.evil.example/"));
  assert(!D.isConsentUrl("http://accounts.google.com/"));
  assert(!D.isConsentUrl("http://127.0.0.1:5/x"));
  assert(D.isConsentUrl("http://127.0.0.1:5/x", { allowLocal: true }));
});

console.log("the AI fallback's actions, checked on this side too");
const view = { width: 1200, height: 800, elements: [{ ref: 0, role: "button", name: "Publish now" }, { ref: 1, role: "textbox", name: "Password", type: "password" }, { ref: 2, role: "textbox", name: "Description" }] };
const values = ["Ice #hydro", "Hydro Flask"];
test("accepts click / type / press / scroll / wait / done / need_user", () => {
  assert.deepStrictEqual(R.validateAction({ action: "click", ref: 0 }, view, values), { action: "click", ref: 0 });
  assert.deepStrictEqual(R.validateAction({ action: "click", ref: null, x: 10, y: 20 }, view, values), { action: "click", x: 10, y: 20 });
  assert.deepStrictEqual(R.validateAction({ action: "type", text: "Hydro Flask", ref: 2 }, view, values), { action: "type", text: "Hydro Flask", ref: 2 });
  assert.deepStrictEqual(R.validateAction({ action: "press", key: "Enter" }, view, values), { action: "press", key: "Enter" });
  assert.strictEqual(R.validateAction({ action: "scroll", dy: 99999 }, view, values).dy, 2000);
  assert.strictEqual(R.validateAction({ action: "wait", ms: 1 }, view, values).ms, 300);
  assert.strictEqual(R.validateAction({ action: "done" }, view, values).action, "done");
  assert.strictEqual(R.validateAction({ action: "need_user", reason: "captcha", message: "x" }, view, values).reason, "captcha");
});
test("refuses unknown refs, off-page points, passwords, foreign text, other keys, other actions", () => {
  assert.strictEqual(R.validateAction({ action: "click", ref: 9 }, view, values).action, "need_user");
  assert.strictEqual(R.validateAction({ action: "click", x: 5000, y: 1 }, view, values).action, "need_user");
  assert.strictEqual(R.validateAction({ action: "click", ref: 1 }, view, values).reason, "password");
  assert.strictEqual(R.validateAction({ action: "type", text: "hunter2", ref: 2 }, view, values).action, "need_user");
  assert.strictEqual(R.validateAction({ action: "type", text: "Hydro Flask", ref: 1 }, view, values).reason, "password");
  assert.strictEqual(R.validateAction({ action: "press", key: "Meta" }, view, values).action, "need_user");
  assert.strictEqual(R.validateAction({ action: "eval", code: "x" }, view, values).action, "need_user");
  assert.strictEqual(R.validateAction(undefined, view, values).action, "need_user");
});
test("caps", () => { assert(R.MAX_AI_PER_STEP <= 10 && R.MAX_AI_PER_POST <= 30); });

console.log("human pacing");
test("delays sit in their ranges and scale with pace", () => {
  assert.strictEqual(R.delay("beforeClick", 1, () => 0), 300);
  assert.strictEqual(R.delay("beforeClick", 1, () => 1), 700);
  assert.strictEqual(R.delay("beforeClick", 0.5, () => 0), 150);
  for (let i = 0; i < 50; i++) { const d = R.delay("keyChunk"); assert(d >= 25 && d <= 80); }
});
test("small human pauses (0.3-1.5 s between actions, never 2-8 s); polling is quick", () => {
  for (const k of ["beforeClick", "afterClick", "betweenSteps"]) { const [lo, hi] = R.DELAYS[k]; assert(lo >= 200 && hi <= 1500, k); }
  assert(R.DELAYS.beforeClick[0] + R.DELAYS.afterClick[0] >= 300, "a click is never instant");
  assert(R.DELAYS.poll[1] <= 500, "a step moves on within half a second of TikTok being ready");
});
test("typing goes out in chunks of 1 to 4 characters, nothing lost", () => {
  const text = "Ice for two days, no joke #hydroflask #tiktokshop";
  for (let i = 0; i < 20; i++) {
    const c = R.chunks(text);
    assert.strictEqual(c.join(""), text);
    assert(c.every((x) => x.length >= 1 && x.length <= 4));
  }
});

console.log("Trybe (trybe.js): where a post goes, the brand, the saved login, the steps");
const TR = require(path.join(__dirname, "..", "src", "tiktok", "trybe.js"));
test("a post names its platform; Trybe needs the brand and never takes a product", () => {
  const base = { postId: "p1", mode: "auto", videoUrl: "https://a.public.blob.vercel-storage.com/x.mp4", caption: "Healing fast", hashtags: ["tattoo"] };
  assert.strictEqual(R.validatePostRequest(base).value.platform, "tiktok", "no platform = TikTok (the app before 2026-10-05)");
  assert.strictEqual(R.validatePostRequest(base).value.brand, null);
  const t = R.validatePostRequest({ ...base, platform: "trybe", brand: "  Mad   Rabbit ", product: "Hydro Flask" });
  assert(t.ok);
  assert.strictEqual(t.value.platform, "trybe");
  assert.strictEqual(t.value.brand, "Mad Rabbit");
  assert.strictEqual(t.value.product, null, "a Trybe post has no TikTok product");
  assert(!R.validatePostRequest({ ...base, platform: "trybe" }).ok, "no brand, no post");
  assert(!R.validatePostRequest({ ...base, platform: "trybe", brand: "<>" }).ok);
  assert(!R.validatePostRequest({ ...base, platform: "instagram" }).ok);
  assert.deepStrictEqual(R.PLATFORMS, ["tiktok", "trybe"]);
});
test("the Trybe window shows Trybe only (and its auth host); local only in a dev build", () => {
  assert(TR.isTrybeUrl("https://jointrybe.com/creator"));
  assert(TR.isTrybeUrl("https://www.jointrybe.com/auth/login"));
  assert(TR.isTrybeUrl("https://sup.jointrybe.com/auth/v1/verify"));
  assert(!TR.isTrybeUrl("http://jointrybe.com/"));
  assert(!TR.isTrybeUrl("https://jointribe.com/"), "the parked look-alike domain");
  assert(!TR.isTrybeUrl("https://jointrybe.com.evil.example/"));
  assert(!TR.isTrybeUrl("https://www.tiktok.com/"));
  assert(!TR.isTrybeUrl("http://127.0.0.1:5/creator"));
  assert(TR.isTrybeUrl("http://127.0.0.1:5/creator", { allowLocal: true }));
  const W = require(path.join(__dirname, "..", "src", "tiktok", "window.js"));
  assert(W.KINDS.trybe.allowed("https://jointrybe.com/creator/brands/x", false));
  assert(!W.KINDS.trybe.allowed("https://accounts.google.com/o/oauth2", false), "Trybe signs in with email and password: no providers");
  assert(!W.KINDS.trybe.allowed("https://www.tiktok.com/tiktokstudio", false));
  assert(!W.KINDS.tiktok.allowed("https://jointrybe.com/creator", false));
  const parts = {};
  const fake = { fromPartition: (p) => (parts[p] = parts[p] || { p }) };
  assert(W.isTikTokSession(fake.fromPartition("persist:trybe"), fake), "main.js leaves the Trybe window to window.js");
  assert(!W.isTikTokSession(fake.fromPartition("persist:app"), fake));
});
test("signed out = Trybe's sign-in pages; a brand page has an id", () => {
  assert(TR.isTrybeLoginUrl("https://jointrybe.com/auth/login?redirect=%2Fcreator"));
  assert(TR.isTrybeLoginUrl("https://jointrybe.com/auth/verify-email?email=x"));
  assert(!TR.isTrybeLoginUrl("https://jointrybe.com/creator"));
  assert.strictEqual(TR.brandIdOf("https://jointrybe.com/creator/brands/mad-rabbit-42?createContent=true"), "mad-rabbit-42");
  assert.strictEqual(TR.brandIdOf("https://jointrybe.com/creator"), null);
});
test("Drew's walk: My brands → brand → Create content → Single submission → video → caption → Submit", () => {
  assert.deepStrictEqual(TR.planTrybeSteps({ mode: "auto" }), ["trybe_open", "trybe_brand", "trybe_create", "trybe_single", "trybe_upload", "trybe_wait", "trybe_caption", "trybe_submit", "trybe_confirm"]);
  const m = TR.planTrybeSteps({ mode: "manual" });
  assert.strictEqual(m[m.length - 1], "handoff");
  assert(!m.includes("trybe_submit"), "Manual never submits");
  for (const s of TR.planTrybeSteps({ mode: "auto" }).concat("handoff")) assert(TR.TRYBE_STEP_WORDS[s], s);
  assert(!TR.TRYBE_AI_STEPS.has("trybe_open") && !TR.TRYBE_AI_STEPS.has("handoff"));
  for (const t of Object.values(TR.TRYBE_TARGETS)) assert(Array.isArray(t) && t.length > 0);
  for (const t of Object.values(TR.TRYBE_TARGETS)) for (const w of t) if (w.text) new RegExp(w.text, "i");
});
test("the brand: the creator's words, never another brand", () => {
  const rows = [{ ref: 0, text: "Rabbit Hole Coffee" }, { ref: 1, text: "Mad Rabbit Tattoo 12 submissions" }, { ref: 2, text: "Mad Rabbit" }, { ref: 3, text: "Sand Cloud" }];
  assert.strictEqual(TR.pickBrand("Mad Rabbit", rows).ref, 2, "the closest title");
  assert.strictEqual(TR.pickBrand("mad rabbit tattoo", rows).ref, 1);
  assert.strictEqual(TR.pickBrand("Fuzzy Bear", rows), null);
  assert.strictEqual(TR.pickBrand("Rabbit", [{ ref: 0, text: "Rabbit Hole Coffee" }]).ref, 0);
  assert.strictEqual(TR.pickBrand("Mad Hatter", rows), null, "half the words is not the brand");
  assert(TR.brandMatches("Mad Rabbit", "Mad Rabbit Tattoo · Create Content"));
  assert.deepStrictEqual(TR.brandSearchTerms("Mad Rabbit"), ["Mad Rabbit", "Mad"]);
  assert.strictEqual(TR.NOT_IN_BRANDS, "That brand isn't in your Trybe brands");
});
test("the saved login: Trybe's Supabase session in localStorage, with a refresh token", () => {
  const session = (v) => ({ cookies: [], origins: [{ origin: "https://jointrybe.com", localStorage: [{ name: "theme", value: "dark" }, { name: "sb-sup-auth-token", value: JSON.stringify(v) }] }] });
  const live = session({ access_token: "a", refresh_token: "r1", expires_at: 1, user: { id: "u", email: "drew@x.com" } });
  assert(TR.hasTrybeSession(live), "an expired access token is fine: Trybe refreshes it");
  assert.strictEqual(TR.trybeSessionOf(live).email, "drew@x.com");
  assert(!TR.hasTrybeSession(session({ access_token: "a" })), "no refresh token");
  assert(!TR.hasTrybeSession({ cookies: [], origins: [{ origin: "https://evil.example", localStorage: [{ name: "sb-sup-auth-token", value: JSON.stringify({ refresh_token: "r" }) }] }] }));
  assert(!TR.hasTrybeSession(null));
  assert(TR.hasTrybeSession({ origins: [{ origin: "http://127.0.0.1:9", localStorage: [{ name: "sb-sup-auth-token", value: JSON.stringify({ refresh_token: "r" }) }] }] }, "http://127.0.0.1:9/"));
  const kept = TR.pickTrybeState(live);
  assert.deepStrictEqual(kept.origins[0].localStorage.map((x) => x.name), ["sb-sup-auth-token"], "only the session key is kept");
  assert.strictEqual(TR.pickTrybeState({ origins: [] }), null);
});
test("the submission id: an address, a link, or the words on the page", () => {
  assert.strictEqual(TR.submissionIdFrom({ url: "https://jointrybe.com/creator/submissions/sub_8f2a91c" }), "sub_8f2a91c");
  assert.strictEqual(TR.submissionIdFrom({ url: "https://jointrybe.com/creator", links: ["https://jointrybe.com/creator/submissions/1b2c3d4e-0000-4000-8000-000000000000"] }), "1b2c3d4e-0000-4000-8000-000000000000");
  assert.strictEqual(TR.submissionIdFrom({ text: "Submission received! Submission ID: 8f2a91" }), "8f2a91");
  assert.strictEqual(TR.submissionIdFrom({ url: "https://jointrybe.com/submissions/list" }), null);
  assert.strictEqual(TR.submissionIdFrom({ text: "Thanks!" }), null);
  assert.strictEqual(TR.trybeCaption("Healing in 3 days", ["tattoo"]), "Healing in 3 days #tattoo", "the string the platform lets the AI type");
});

Promise.all(pending.map((p) => p.catch((e) => { failures++; console.log(`  FAIL (async) ${e && e.message}`); }))).then(() => {
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
});
