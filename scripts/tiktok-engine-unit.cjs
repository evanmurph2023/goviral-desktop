// npm run test:tiktok (second half) — Groot's TikTok ENGINE (src/tiktok/engine.js) against a fake
// TikTok Studio in plain Node: no window, no network, no video. The fake plays the page the way the
// engine sees it (TARGETS by name, refs, typing, keys, the upload's progress over time), and time
// is VIRTUAL (Date.now and every sleep move a fake clock), so a 5-minute upload runs in
// milliseconds and every "within N seconds" below is measured exactly.
//
// What it proves (2026-10-05, Drew's first real post sat for 3.5 minutes and never posted):
//   - the description and product go in WHILE TikTok uploads; Post only after it uploaded
//   - a slow upload is waited for while it moves (no AI, no needs-you), and reported
//   - an upload with nothing recognizable on screen goes to Groot within TIMEOUTS.stall
//   - a stuck upload goes to the creator ("needs you") within TIMEOUTS.stuck
//   - TikTok's hashtag list eating characters: the description still comes out exact
//   - a description that comes out wrong is typed again, slowly, once; then Groot
//   - TikTok rewriting the description when the upload finishes: written again
//   - the showcase search with 0 / 1 / many results, a confident pick or the creator's call
//   - a step that never appears → Groot within TIMEOUTS.find; Groot down or silent → needs you,
//     then the video gives up within TIMEOUTS.creator; the cloud (blockerMode stop) gives up at once
//   - the download still running while TikTok Studio opens; a failed download fails the post
//   - every step leaves a trail entry (time, what it used)
"use strict";

const assert = require("assert");
const path = require("path");
const R = require(path.join(__dirname, "..", "src", "tiktok", "rules.js"));
const { createEngine } = require(path.join(__dirname, "..", "src", "tiktok", "engine.js"));

// ---- virtual time ---------------------------------------------------------------------------------
let NOW = Date.UTC(2026, 9, 5, 7, 52, 51);
const realNow = Date.now;
Date.now = () => NOW;
const tick = () => new Promise((r) => setImmediate(r));

// ---- the fake TikTok Studio ---------------------------------------------------------------------------
const NAME_OF = new Map(Object.entries(R.TARGETS).map(([k, v]) => [v, k]));
const SHOWCASE = ["Comfort Weekend Slipper", "Cloud Comfort Slides", "Hydro Flask 40 oz Tumbler", "Stanley Quencher H2.0 40 oz", "Glow Serum Vitamin C 30ml"];
const ORDER = ["fileInput", "uploaded", "uploadProgress", "captionBox", "addLink", "productsOption", "linkNext", "productSearch", "productNoResults", "productNext", "productNameInput", "productAdd", "dialog", "postButton", "posted", "attachLink"];
const REF = Object.fromEntries(ORDER.map((n, i) => [n, i + 1]));

function fakeStudio(opt = {}) {
  const o = {
    processMs: 4000, progressText: true, uploadedText: true, stuckAt: null, eat: false, eatOnce: false, showcase: SHOWCASE,
    addLink: true, addLinkOffWhileUploading: false, prefillOnUploaded: false, postOnWhileUploading: false, fileName: "comfort slippers", ...opt,
  };
  const S = { page: null, file: null, fileAt: 0, caption: "", focused: null, suggest: false, sessions: 0, dialog: null, typeChosen: false, search: "", searched: false, rows: [], selected: null, nameValue: "", product: null, posted: false, postedAt: 0, prefilled: false, searches: [], captionAtFirstProgress: null, events: [], aborted: false };
  const pctRaw = () => (S.file ? Math.min(100, Math.floor(((NOW - S.fileAt) / o.processMs) * 100)) : 0);
  const pct = () => (o.stuckAt !== null ? Math.min(o.stuckAt, pctRaw()) : pctRaw());
  const uploaded = () => !!S.file && pct() >= 100;
  const settle = () => {
    if (uploaded() && o.prefillOnUploaded && !S.prefilled) { S.prefilled = true; S.caption = o.fileName; S.events.push("tiktok rewrote the description"); }
  };
  const visible = (name) => {
    settle();
    switch (name) {
      case "fileInput": return S.page === "upload" && !S.file;
      case "uploaded": return o.uploadedText && uploaded();
      case "uploadProgress": return o.progressText && !!S.file && !uploaded();
      case "captionBox": return !!S.file && !S.posted;
      case "captionSuggest": return S.suggest;
      case "addLink": return !!S.file && o.addLink && !S.dialog && !S.posted;
      case "attachLink": return !!S.file && !o.addLink && !S.dialog && !S.posted;
      case "productsOption": case "linkNext": return S.dialog === "type";
      case "productSearch": case "productNext": return S.dialog === "search";
      case "productNoResults": return S.dialog === "search" && S.searched && !S.rows.length;
      case "productNameInput": case "productAdd": return S.dialog === "name";
      case "dialog": return !!S.dialog;
      case "postButton": return !!S.file && !S.posted;
      case "posted": return S.posted;
      default: return false;
    }
  };
  const disabled = (name) => {
    if (name === "linkNext") return !S.typeChosen;
    if (name === "productNext") return !S.selected;
    if (name === "addLink") return o.addLinkOffWhileUploading && !uploaded();
    if (name === "postButton") return !uploaded() && !o.postOnWhileUploading;
    return false;
  };
  const text = (name) => (name === "uploadProgress" ? `Uploading ${pct()}%` : name === "uploaded" ? "Uploaded (12.4MB)" : name === "productNoResults" ? "No products found" : name === "posted" ? "Your video has been posted. Everyone can see this." : name);
  const doSearch = () => {
    S.searches.push(S.search);
    const words = S.search.toLowerCase().split(/\s+/).filter(Boolean);
    S.rows = o.showcase.filter((p) => words.every((w) => p.toLowerCase().includes(w)));
    S.searched = true;
    S.selected = null;
  };
  const typeChar = (ch, slow) => {
    if (S.focused === "caption") {
      if (o.eat && S.suggest && ch === " ") { S.suggest = false; S.events.push("hashtag list ate a space"); return; }
      if (o.eatOnce && S.sessions === 1 && !slow && S.caption.length >= 16) return; // the first try loses everything after 16
      S.caption += ch;
      S.suggest = /#[\p{L}\p{N}_]+$/u.test(S.caption);
      if (S.captionAtFirstProgress === null && S.file && !uploaded()) S.captionAtFirstProgress = pct();
    } else if (S.focused === "search") S.search += ch;
    else if (S.focused === "name") S.nameValue += ch;
  };

  const page = {
    S, o,
    async sleep(ms) { if (S.aborted) throw Object.assign(new Error("Stopped"), { stopped: true }); NOW += ms; await tick(); if (S.aborted) throw Object.assign(new Error("Stopped"), { stopped: true }); },
    pause(kind) { return page.sleep(R.delay(kind, 1)); },
    url: () => (S.posted ? "https://www.tiktok.com/tiktokstudio/upload?posted=1" : "https://www.tiktok.com/tiktokstudio/upload"),
    async goto() { NOW += 1500; S.page = "upload"; await tick(); return { ms: 1500, timedOut: false }; },
    async find(ways) {
      await tick();
      const name = NAME_OF.get(ways);
      if (!name || !visible(name)) return null;
      return { ref: REF[name], way: 0, disabled: disabled(name), text: text(name) };
    },
    async rows(ways) {
      await tick();
      const name = NAME_OF.get(ways);
      if (S.dialog !== "search") return [];
      const all = S.rows.map((t, i) => ({ ref: 1000 + i, text: t, selected: S.selected === t }));
      if (name === "productRows") return all;
      if (name === "productSelected") return all.filter((r) => r.selected);
      return [];
    },
    async textOf(ref) { settle(); if (ref === REF.captionBox) return S.caption; if (ref === REF.productNameInput) return S.nameValue; return ""; },
    async snapshot() {
      const els = ORDER.filter((n) => n !== "fileInput" && visible(n)).map((n) => ({ ref: REF[n], role: "button", name: n === "attachLink" ? "Attach a shop link" : n, tag: "button", x: 10, y: 10, w: 50, h: 20, ...(disabled(n) ? { disabled: true } : {}) }));
      return { width: 1200, height: 800, url: page.url(), elements: els };
    },
    async screenshot() { return "x".repeat(2000); },
    async clickRef(ref) {
      await page.pause("beforeClick");
      settle();
      const name = ORDER.find((n) => REF[n] === ref);
      if (ref >= 1000) { S.selected = S.rows[ref - 1000] || null; S.events.push(`selected ${S.selected}`); }
      else if (name === "captionBox") S.focused = "caption";
      else if (name === "addLink" || name === "attachLink") { if (!disabled("addLink")) { S.dialog = "type"; S.typeChosen = false; } }
      else if (name === "productsOption") S.typeChosen = true;
      else if (name === "linkNext") { if (S.typeChosen) { S.dialog = "search"; S.rows = o.showcase.slice(); S.searched = false; } }
      else if (name === "productSearch") S.focused = "search";
      else if (name === "productNext") { if (S.selected) { S.dialog = "name"; S.nameValue = S.selected; } }
      else if (name === "productNameInput") S.focused = "name";
      else if (name === "productAdd") { S.product = S.selected; S.dialog = null; S.events.push(`product ${S.product}`); }
      else if (name === "postButton") { if (!disabled("postButton")) { S.posted = true; S.postedAt = NOW; S.events.push("posted"); } }
      await page.pause("afterClick");
    },
    async clickAt() { await page.pause("afterClick"); },
    async type(t, { slow = false } = {}) {
      for (const ch of t) { typeChar(ch, slow); }
      NOW += t.length * (slow ? 50 : 20);
      await tick();
    },
    async key(k) {
      if (k === "Escape") S.suggest = false;
      if (k === "Enter" && S.focused === "search") doSearch();
      await page.sleep(40);
    },
    async clearFocused() {
      if (S.focused === "caption") { S.caption = ""; S.suggest = false; S.sessions++; }
      if (S.focused === "search") S.search = "";
      if (S.focused === "name") S.nameValue = "";
      await page.sleep(40);
    },
    async scroll() { await page.sleep(100); },
    async setFiles(ref, file) { assert.strictEqual(ref, REF.fileInput); S.file = file; S.fileAt = NOW; S.caption = o.fileName; S.events.push("file set"); await tick(); },
  };
  return page;
}

// Groot (the platform's AI fallback), scripted per test.
function fakeGroot(answer = () => ({ action: "need_user", reason: "other", message: "no answer" })) {
  const g = { calls: [], async nextAction(body) { g.calls.push({ step: body.step, at: NOW, elements: body.view.elements.length }); const a = await answer(body, g.calls.length); return a && a.ok === false ? a : { ok: true, action: a }; } };
  return g;
}

const JOB = { postId: "p1", mode: "auto", product: "comfort weekend slipper", caption: "the comfort weekend slipper for lazy days at home", hashtags: ["slippers", "comfort", "weekendvibes", "cozyathome"], name: "comfort slippers", filePath: "C:\\tmp\\comfort slippers.mp4" };
const FULL = "the comfort weekend slipper for lazy days at home #slippers #comfort #weekendvibes #cozyathome";

async function run(pageOpts = {}, { job = {}, groot = fakeGroot(), timeouts = {}, blockerMode = "wait" } = {}) {
  const page = fakeStudio(pageOpts);
  const events = [];
  const logs = [];
  const engine = createEngine({ page, groot, report: (e) => events.push({ ...e, at: NOW }), timeouts, log: (...a) => logs.push(a.join(" ")), blockerMode });
  const t0 = NOW;
  const r = await engine.run({ ...JOB, ...job });
  return { r, page, S: page.S, events, logs, groot, ms: NOW - t0, t0 };
}

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

console.log("the engine against a fake TikTok Studio (virtual time)");

test("Drew's post: posted, the FULL description (not the file name), the product, no AI; description + product typed while uploading", async () => {
  const { r, S, ms, logs } = await run({ processMs: 30000 });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(S.caption, FULL, "the description is exactly the caption + hashtags");
  assert.notStrictEqual(S.caption, "comfort slippers");
  assert.strictEqual(S.product, "Comfort Weekend Slipper");
  assert.strictEqual(r.aiSteps, 0);
  assert(S.captionAtFirstProgress !== null && S.captionAtFirstProgress < 100, `typed while uploading (at ${S.captionAtFirstProgress}%)`);
  assert(ms < 30000 + 15000, `ready about when TikTok is: ${(ms / 1000).toFixed(1)} s for a 30 s upload`);
  assert.deepStrictEqual(r.steps.map((s) => s.step), R.planSteps(JOB));
  assert(r.steps.every((s) => s.ok && Number.isFinite(s.ms)));
  assert(r.steps.find((s) => s.step === "upload").how.includes("file set"), "the trail says what each step used");
  assert(logs.some((l) => l.startsWith("tiktok post timings posted")), "one timings line in main.log");
  assert(logs.some((l) => l.startsWith("tiktok step start caption")) && logs.some((l) => l.startsWith("tiktok step done caption")));
});

test("speed: the scripted steps take seconds, not minutes (a fast upload)", async () => {
  const { r, ms } = await run({ processMs: 1000 });
  assert.strictEqual(r.status, "posted");
  assert(ms < 35000, `whole post ${(ms / 1000).toFixed(1)} s (was ~45-60 s of pauses before TikTok's own time)`);
});

test("slow processing (5 min, moving): waited for, progress reported, no AI, no needs-you", async () => {
  const { r, events, groot, ms } = await run({ processMs: 5 * 60 * 1000 });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(groot.calls.length, 0);
  assert(!events.some((e) => e.status === "needs_you"));
  assert(events.some((e) => /TikTok is uploading the video \(\d+%\)/.test(e.message)), "the bar shows the upload's progress");
  assert(ms >= 5 * 60 * 1000 && ms < 5 * 60 * 1000 + 15000, `${(ms / 1000).toFixed(0)} s`);
});

test("upload with nothing recognizable on screen: Groot looks within TIMEOUTS.stall, says done when Post turns on", async () => {
  const groot = fakeGroot((b) => (b.step === "wait_processed" ? { action: "done" } : { action: "need_user", reason: "other", message: "?" }));
  const { r, groot: g, page, S } = await run({ processMs: 40000, progressText: false, uploadedText: false }, { groot });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert(g.calls.length >= 1 && g.calls.every((c) => c.step === "wait_processed"));
  const firstLook = g.calls[0].at - S.fileAt;
  assert(firstLook <= 40000 + R.TIMEOUTS.stall + 3000, `Groot looked ${(firstLook / 1000).toFixed(0)} s after the file went in`);
  assert(page.S.posted);
});

test("upload with nothing recognizable and Groot down: needs you within the stall limit, gives up within TIMEOUTS.creator", async () => {
  const groot = fakeGroot(() => ({ ok: false, error: "Groot is away right now." }));
  const { r, events, S } = await run({ processMs: 10 * 60 * 1000, progressText: false, uploadedText: false }, { groot });
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.code, "needs_you");
  assert.strictEqual(r.step, "wait_processed");
  assert.strictEqual(r.error, R.STEP_HELP.wait_processed);
  const ask = events.find((e) => e.status === "needs_you");
  assert(ask && ask.message === R.STEP_HELP.wait_processed);
  const waited = NOW - S.fileAt;
  assert(waited < R.TIMEOUTS.stall + R.TIMEOUTS.creator + 40000, `gave up ${(waited / 1000).toFixed(0)} s after the file went in`);
});

test("the creator presses Post while Groot can't tell: Groot sees it posted and finishes", async () => {
  const groot = fakeGroot(() => ({ ok: false, error: "Groot is away right now." }));
  const page = fakeStudio({ processMs: 20000, progressText: false, uploadedText: false });
  const events = [];
  const engine = createEngine({ page, groot, report: (e) => { events.push(e); if (e.status === "needs_you") setImmediate(() => { NOW += 25000; page.S.posted = true; }); }, log: () => {} });
  const r = await engine.run(JOB);
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
});

test("a stuck upload (stays at 40%): needs you within TIMEOUTS.stuck with the percentage, then gives up", async () => {
  const { r, events, S } = await run({ processMs: 60000, stuckAt: 40 });
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.code, "upload_stuck");
  const ask = events.find((e) => e.status === "needs_you");
  assert(ask && /stuck at Uploading 40%/.test(ask.message), ask && ask.message);
  assert(ask.at - S.fileAt < 24000 + R.TIMEOUTS.stuck + 15000);
});

test("the hashtag list eats the space after a tag: Escape after each tag, the description still exact", async () => {
  const { r, S, groot } = await run({ eat: true });
  assert.strictEqual(r.status, "posted");
  assert.strictEqual(S.caption, FULL);
  assert.strictEqual(groot.calls.length, 0);
  assert(!S.events.includes("hashtag list ate a space"), "Groot never typed a space into an open hashtag list");
});

test("the first try loses characters: typed again slowly, once, then exact", async () => {
  const { r, S, steps = r.steps } = await run({ eatOnce: true });
  assert.strictEqual(r.status, "posted");
  assert.strictEqual(S.caption, FULL);
  const cap = steps.find((s) => s.step === "caption");
  assert(/try 1 came out "the comfort week"/.test(cap.how) && /second try/.test(cap.how), cap.how);
});

test("TikTok rewrites the description when the upload finishes: written again before Post", async () => {
  const { r, S, logs } = await run({ processMs: 20000, prefillOnUploaded: true });
  assert.strictEqual(r.status, "posted");
  assert(S.events.includes("tiktok rewrote the description"));
  assert.strictEqual(S.caption, FULL);
  assert(logs.some((l) => /description changed while uploading/.test(l)));
});

test("the description never comes out right: Groot gets the caption step", async () => {
  const groot = fakeGroot((b) => ({ action: "need_user", reason: "other", message: "can't" }));
  const page = fakeStudio({});
  page.type = async () => { NOW += 100; await tick(); }; // TikTok drops every character
  const engine = createEngine({ page, groot, report: () => {}, log: () => {} });
  const t0 = NOW;
  const r = await engine.run({ ...JOB, product: null });
  assert.strictEqual(groot.calls[0].step, "caption");
  assert(groot.calls[0].at - t0 < 30000, "Groot within seconds");
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.error, R.STEP_HELP.caption);
});

test("showcase search, 0 results: that video stops at once with what was searched, no AI", async () => {
  const { r, groot, S } = await run({ showcase: ["Cloud Comfort Slides"] }, { job: { product: "Fuzzy Bear Earmuffs" } });
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.code, "product_not_found");
  assert(r.error.startsWith(R.NOT_IN_SHOWCASE), r.error);
  assert(/"Fuzzy Bear Earmuffs" or "Fuzzy"/.test(r.error), r.error);
  assert.deepStrictEqual(S.searches, ["Fuzzy Bear Earmuffs", "Fuzzy"]);
  assert.strictEqual(groot.calls.length, 0);
  assert.strictEqual(S.product, null);
});

test("showcase search, 1 result: picked", async () => {
  const { r, S } = await run({ showcase: ["Comfort Weekend Slipper"] });
  assert.strictEqual(r.status, "posted");
  assert.strictEqual(S.product, "Comfort Weekend Slipper");
  assert(r.steps.find((s) => s.step === "product_search").how.includes("1 row(s)"));
});

test("showcase search, many results: the best match (not Cloud Comfort Slides)", async () => {
  const { r, S } = await run({}, { job: { product: "Comfort slippers" } });
  assert.strictEqual(r.status, "posted");
  assert.strictEqual(S.product, "Comfort Weekend Slipper");
  assert.deepStrictEqual(S.searches, ["Comfort slippers", "Comfort"], "the full name, then the first word");
  assert(/picked "Comfort Weekend Slipper" \(score 1\.00/.test(r.steps.find((s) => s.step === "product_pick").how));
});

test("showcase search, many results, none confident: needs you with what TikTok showed; the creator picks → posted", async () => {
  const page = fakeStudio({});
  const events = [];
  const engine = createEngine({ page, groot: fakeGroot(), report: (e) => { events.push(e); if (e.status === "needs_you") setImmediate(() => { page.S.selected = "Cloud Comfort Slides"; }); }, log: () => {} });
  const r = await engine.run({ ...JOB, product: "Comfort shoes" });
  const ask = events.find((e) => e.status === "needs_you");
  assert(ask && /"Comfort Weekend Slipper", "Cloud Comfort Slides"/.test(ask.message) && /none is clearly "Comfort shoes"/.test(ask.message), ask && ask.message);
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(page.S.product, "Cloud Comfort Slides", "the creator's own pick");
});

test("showcase search, many results, none confident, nobody picks: failed product_not_found listing them, within TIMEOUTS.creator", async () => {
  const t0 = NOW;
  const { r } = await run({}, { job: { product: "Comfort shoes" } });
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.code, "product_not_found");
  assert(r.error.startsWith(`${R.NOT_IN_SHOWCASE}. TikTok showed "Comfort Weekend Slipper"`), r.error);
  assert(NOW - t0 < R.TIMEOUTS.creator + 40000);
});

test("a step that never appears (Add link): Groot within TIMEOUTS.find, clicks the changed button, posted", async () => {
  const groot = fakeGroot((b) => {
    if (b.step !== "product_open") return { action: "need_user", reason: "other", message: "?" };
    const el = b.view.elements.find((e) => /attach a shop link/i.test(e.name));
    return el ? { action: "click", ref: el.ref } : { action: "need_user", reason: "other", message: "no link button" };
  });
  const { r, groot: g, events } = await run({ addLink: false }, { groot });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(r.aiSteps, 1);
  const stepAt = events.find((e) => e.step === "product_open").at;
  assert(g.calls[0].at - stepAt <= R.TIMEOUTS.find + 3000, `Groot after ${((g.calls[0].at - stepAt) / 1000).toFixed(1)} s`);
  assert.strictEqual(r.steps.find((s) => s.step === "product_open").ai, 1);
});

test("a step that never appears and Groot is down: needs you with plain words within seconds, gives up within TIMEOUTS.creator", async () => {
  const groot = fakeGroot(() => ({ ok: false, error: "Groot couldn't see the page (503)." }));
  const { r, events } = await run({ addLink: false }, { groot });
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.code, "needs_you");
  assert.strictEqual(r.error, R.STEP_HELP.product_open);
  const stepAt = events.find((e) => e.step === "product_open").at;
  const ask = events.find((e) => e.status === "needs_you");
  assert(ask.at - stepAt <= R.TIMEOUTS.find + 3000);
  const end = events[events.length - 1].at;
  assert(end - ask.at <= R.TIMEOUTS.creator + 2000);
});

test("Groot never answers: the engine stops waiting after TIMEOUTS.ai and asks the creator", async () => {
  const groot = { calls: [], nextAction: () => new Promise(() => {}) };
  const page = fakeStudio({ addLink: false });
  const events = [];
  const engine = createEngine({ page, groot, report: (e) => events.push(e), timeouts: { ai: 60, creator: 3000 }, log: () => {} });
  const t = realNow();
  const r = await engine.run(JOB);
  assert.strictEqual(r.status, "failed");
  assert(events.some((e) => e.status === "needs_you" && e.message === R.STEP_HELP.product_open));
  assert(realNow() - t < 5000);
});

test("the cloud (blockerMode stop): a step nobody can do ends the post at once (it goes back in line)", async () => {
  const groot = fakeGroot(() => ({ ok: false, error: "down" }));
  const t0 = NOW;
  const { r, events } = await run({ addLink: false }, { groot, blockerMode: "stop" });
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.code, null, "no code: the cloud retries it");
  assert(!events.some((e) => e.status === "needs_you"));
  assert(NOW - t0 < 60000);
});

test("the creator does the step Groot couldn't: Groot carries on", async () => {
  const groot = fakeGroot(() => ({ ok: false, error: "down" }));
  const page = fakeStudio({ addLink: false });
  const engine = createEngine({ page, groot, report: (e) => { if (e.status === "needs_you") setImmediate(() => { page.S.dialog = "type"; }); }, log: () => {} });
  const r = await engine.run(JOB);
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(page.S.product, "Comfort Weekend Slipper");
});

test("Add link is off while TikTok uploads: waited for while the upload moves, not sent to Groot", async () => {
  const { r, groot } = await run({ processMs: 60000, addLinkOffWhileUploading: true });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(groot.calls.length, 0);
});

test("the download still running when TikTok is ready: the engine waits, shows progress, then uploads", async () => {
  let done;
  const fileP = new Promise((res) => { done = res; });
  const total = 300 * 1048576;
  const page = fakeStudio({});
  const events = [];
  const engine = createEngine({ page, groot: fakeGroot(), report: (e) => events.push(e), log: () => {} });
  const t0 = NOW;
  // 300 MB over 20 s of virtual time, read by the engine while it waits
  const fileProgress = () => { const bytes = Math.min(total, Math.round(((NOW - t0) / 20000) * total)); if (bytes >= total) done("C:\\tmp\\drive.mp4"); return { bytes, total }; };
  const r = await engine.run({ ...JOB, source: { kind: "drive", fileId: "x" }, filePath: fileP, fileProgress });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(page.S.file, "C:\\tmp\\drive.mp4");
  const waits = events.filter((e) => /^Getting your video from Google Drive/.test(e.message));
  assert(waits.some((e) => /\(\d+ MB of 300 MB\)$/.test(e.message)), waits.map((e) => e.message).join(" | "));
  assert(waits.length < 30, "about one line a second, not a flood");
});

test("the download fails while TikTok is open: failed with the download's words", async () => {
  const fileP = Promise.reject(new Error("The video stopped downloading (nothing came for 60 s). Check your internet and try again."));
  fileP.catch(() => {});
  const { r } = await run({}, { job: { filePath: fileP } });
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.code, "download");
  assert.match(r.error, /stopped downloading/);
});

test("Stop mid-post: stopped, with where it was in the error", async () => {
  const page = fakeStudio({ processMs: 120000 });
  const engine = createEngine({ page, groot: fakeGroot(), report: (e) => { if (e.step === "wait_processed") page.S.aborted = true; }, log: () => {} });
  const r = await engine.run(JOB);
  assert.strictEqual(r.status, "stopped");
  assert.strictEqual(r.step, "wait_processed");
  assert.match(r.error, /^Stopped at "TikTok is processing the video", \d+ s in\.$/);
  assert(!page.S.posted);
});

test("Manual: filled in, waits for the upload, hands over, never posts", async () => {
  const page = fakeStudio({ processMs: 10000 });
  const engine = createEngine({ page, groot: fakeGroot(), report: () => {}, timeouts: { handoff: 5000 }, log: () => {} });
  const r = await engine.run({ ...JOB, mode: "manual" });
  assert.strictEqual(r.status, "ready");
  assert.strictEqual(page.S.posted, false);
  assert.strictEqual(page.S.caption, FULL);
  assert.strictEqual(page.S.product, "Comfort Weekend Slipper");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e && (e.stack || e.message).split("\n").slice(0, 3).join("\n       ")}`); }
  }
  Date.now = realNow;
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
