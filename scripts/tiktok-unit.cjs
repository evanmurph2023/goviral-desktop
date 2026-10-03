// npm run test:tiktok — the pure rules of Groot's TikTok poster (src/tiktok/rules.js), plain Node,
// no window. The engine itself runs end to end in scripts/tiktok-harness.cjs.
"use strict";

const assert = require("assert");
const path = require("path");
const R = require(path.join(__dirname, "..", "src", "tiktok", "rules.js"));

let failures = 0;
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
test("Auto with a product: upload, caption, product tag, post, confirm", () => {
  assert.deepStrictEqual(R.planSteps({ mode: "auto", product: "Hydro" }), ["open", "upload", "wait_processed", "caption", "product_open", "product_tab", "product_search", "product_pick", "product_confirm", "post", "confirm_posted"]);
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
  assert.strictEqual(R.delay("beforeClick", 1, () => 0), 350);
  assert.strictEqual(R.delay("beforeClick", 1, () => 1), 900);
  assert.strictEqual(R.delay("beforeClick", 0.5, () => 0), 175);
  for (let i = 0; i < 50; i++) { const d = R.delay("keyChunk"); assert(d >= 35 && d <= 120); }
});
test("typing goes out in chunks of 1 to 4 characters, nothing lost", () => {
  const text = "Ice for two days, no joke #hydroflask #tiktokshop";
  for (let i = 0; i < 20; i++) {
    const c = R.chunks(text);
    assert.strictEqual(c.join(""), text);
    assert(c.every((x) => x.length >= 1 && x.length <= 4));
  }
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
