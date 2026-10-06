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
const ORDER = ["fileInput", "uploaded", "uploadProgress", "captionBox", "addLink", "productsOption", "linkNext", "productSearch", "productNoResults", "productNext", "productNameInput", "productNameError", "productAdd", "dialog", "postButton", "posted", "attachLink", "privacyControl", "privacyOpt"];
const REF = Object.fromEntries(ORDER.map((n, i) => [n, i + 1]));
const INVALID = /[^\p{L}\p{N} '&.,-]/u; // what the fake TikTok refuses in a link name (like the mock's)
const PRIVACY_LABEL = { everyone: "Everyone", friends: "Friends", followers: "Followers", only_me: "Only you" };

// opt (2026-10-06): privacy = what "Who can watch" shows at first ("Everyone", "Only you");
// privacyControl: false = Groot's selectors can't see it; nameError: TikTok says "Invalid
// characters" (else it only refuses Add); nameHidden: the name field is there but no selector
// finds it (only the AI's snapshot sees it).
function fakeStudio(opt = {}) {
  const o = {
    processMs: 4000, progressText: true, uploadedText: true, stuckAt: null, eat: false, eatOnce: false, showcase: SHOWCASE,
    addLink: true, addLinkOffWhileUploading: false, prefillOnUploaded: false, postOnWhileUploading: false, fileName: "comfort slippers", pageSize: Infinity, searchMode: "all", pageJunk: false,
    privacy: "Everyone", privacyControl: true, nameError: true, nameHidden: false, ...opt,
  };
  const S = { page: null, file: null, fileAt: 0, caption: "", focused: null, suggest: false, sessions: 0, dialog: null, typeChosen: false, search: "", searched: false, rows: [], pageNo: 1, selected: null, nameValue: "", product: null, productName: null, posted: false, postedAt: 0, prefilled: false, searches: [], captionAtFirstProgress: null, events: [], aborted: false, privacy: o.privacy, privacyOpen: false, privacyWant: null, privacyAtPost: null, addRefused: 0 };
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
      case "productNameInput": return S.dialog === "name" && !o.nameHidden;
      case "productNameError": return S.dialog === "name" && o.nameError && INVALID.test(S.nameValue);
      case "productAdd": return S.dialog === "name";
      case "dialog": return !!S.dialog;
      case "postButton": return !!S.file && !S.posted;
      case "posted": return S.posted;
      case "privacyControl": return !!S.file && !S.posted && !S.dialog && o.privacyControl;
      default: return false;
    }
  };
  // what the AI's snapshot sees (selectors or not)
  const seen = (n) => (n === "productNameInput" ? S.dialog === "name" : n === "privacyControl" ? !!S.file && !S.posted && !S.dialog : n === "privacyOpt" ? S.privacyOpen : visible(n));
  const NAMES = { attachLink: "Attach a shop link", privacyControl: () => S.privacy, privacyOpt: () => PRIVACY_LABEL[S.privacyWant || "everyone"] };
  const nameOf = (n) => (typeof NAMES[n] === "function" ? NAMES[n]() : NAMES[n] || n);
  const disabled = (name) => {
    if (name === "linkNext") return !S.typeChosen;
    if (name === "productNext") return !S.selected;
    if (name === "addLink") return o.addLinkOffWhileUploading && !uploaded();
    if (name === "postButton") return !uploaded() && !o.postOnWhileUploading;
    return false;
  };
  const text = (name) => (name === "uploadProgress" ? `Uploading ${pct()}%` : name === "uploaded" ? "Uploaded (12.4MB)" : name === "productNoResults" ? "No products found" : name === "posted" ? "Your video has been posted. Everyone can see this." : name === "productNameError" ? "Invalid characters. Remove them and try again." : nameOf(name));
  const doSearch = () => {
    S.searches.push(S.search);
    const words = S.search.toLowerCase().split(/\s+/).filter(Boolean);
    const has = (p, w) => p.toLowerCase().includes(w);
    S.rows = o.searchMode === "none" && words.length ? [] : o.showcase.filter((p) => (o.searchMode === "any" ? words.some((w) => has(p, w)) : words.every((w) => has(p, w))));
    S.pageNo = 1;
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
      // a privacy option (rules.js privacyOptionWays): there while the list is open
      if (ways && ways[0] && ways[0].privacyOption) { if (!S.privacyOpen) return null; S.privacyWant = ways[0].privacyOption; return { ref: REF.privacyOpt, way: 0, disabled: false, text: PRIVACY_LABEL[S.privacyWant] }; }
      // a learned target: found by its words, like page.js FIND `learned`
      if (ways && ways[0] && ways[0].learned) {
        const t = ways[0].learned;
        const n = ORDER.find((x) => seen(x) && (t.privacy ? x === "privacyControl" : nameOf(x) === (t.text || t.label)) && !!t.dlg === (["productNameInput", "productAdd", "productNext", "productsOption", "linkNext", "productSearch"].includes(x)));
        return n ? { ref: REF[n], way: 0, disabled: disabled(n), text: nameOf(n) } : null;
      }
      const name = NAME_OF.get(ways);
      if (!name || !visible(name)) return null;
      return { ref: REF[name], way: 0, disabled: disabled(name), text: text(name) };
    },
    async variant() { return { url: page.url(), dialog: S.dialog || "" }; },
    async rows(ways) {
      await tick();
      const name = NAME_OF.get(ways);
      if (S.dialog !== "search") return [];
      const from = Number.isFinite(o.pageSize) ? (S.pageNo - 1) * o.pageSize : 0;
      const all = S.rows.slice(from, from + o.pageSize).map((t, i) => ({ ref: 1000 + from + i, text: t, selected: S.selected === t }));
      const pages = Math.max(1, Math.ceil(S.rows.length / o.pageSize));
      const buttons = pages > 1 ? [...Array.from({ length: Math.min(pages, 3) }, (_, i) => String(i + 1)), String(pages), ""].map((t, i) => ({ ref: 2000 + i, text: t, selected: false })) : [];
      // TikTok's page numbers read as rows by a loose selector (Drew's post, 2026-10-05)
      if (name === "productRows") return o.pageJunk ? [...all, ...buttons] : all;
      if (name === "productPages") return buttons;
      if (name === "productSelected") return all.filter((r) => r.selected);
      return [];
    },
    async textOf(ref) { settle(); if (ref === REF.captionBox) return S.caption; if (ref === REF.productNameInput) return S.nameValue; if (ref === REF.privacyControl) return S.privacy; return ""; },
    async snapshot() {
      const inDlg = (n) => ["productNameInput", "productNameError", "productAdd", "productNext", "productsOption", "linkNext", "productSearch", "productNoResults"].includes(n);
      const els = ORDER.filter((n) => n !== "fileInput" && n !== "dialog" && seen(n)).map((n) => ({
        ref: REF[n], role: n === "productNameInput" ? "input" : n === "privacyOpt" ? "option" : "button", name: nameOf(n), tag: n === "productNameInput" ? "input" : "button", x: 10, y: 10, w: 50, h: 20,
        ...(n === "productNameInput" ? { type: "text", value: S.nameValue } : { text: nameOf(n) }),
        ...(n === "privacyControl" ? { near: "who can watch this video" } : n === "productNameInput" ? { near: "link name" } : {}),
        ...(inDlg(n) ? { dlg: true } : {}),
        ...(disabled(n) ? { disabled: true } : {}),
      }));
      return { width: 1200, height: 800, url: page.url(), elements: els, dialog: S.dialog || "", notices: visible("productNameError") ? ["Invalid characters. Remove them and try again."] : [] };
    },
    async screenshot() { return "x".repeat(2000); },
    async clickRef(ref) {
      await page.pause("beforeClick");
      settle();
      const name = ORDER.find((n) => REF[n] === ref);
      if (ref >= 2000) {
        const pages = Math.max(1, Math.ceil(S.rows.length / o.pageSize));
        const btn = [...Array.from({ length: Math.min(pages, 3) }, (_, i) => String(i + 1)), String(pages), ""][ref - 2000];
        S.pageNo = btn ? Number(btn) : Math.min(pages, S.pageNo + 1);
        S.events.push(`page ${S.pageNo}`);
      } else if (ref >= 1000) { S.selected = S.rows[ref - 1000] || null; S.events.push(`selected ${S.selected}`); }
      else if (name === "captionBox") S.focused = "caption";
      else if (name === "addLink" || name === "attachLink") { if (!disabled("addLink")) { S.dialog = "type"; S.typeChosen = false; } }
      else if (name === "productsOption") S.typeChosen = true;
      else if (name === "linkNext") { if (S.typeChosen) { S.dialog = "search"; S.rows = o.showcase.slice(); S.searched = false; } }
      else if (name === "productSearch") S.focused = "search";
      else if (name === "productNext") { if (S.selected) { S.dialog = "name"; S.nameValue = S.selected; } }
      else if (name === "productNameInput") S.focused = "name";
      else if (name === "productAdd") {
        if (INVALID.test(S.nameValue)) { S.addRefused++; S.events.push("add refused"); } // TikTok won't take the name
        else { S.product = S.selected; S.productName = S.nameValue; S.dialog = null; S.events.push(`product ${S.product}`); }
      }
      else if (name === "postButton") { if (!disabled("postButton")) { S.posted = true; S.postedAt = NOW; S.privacyAtPost = S.privacy; S.events.push("posted"); } }
      else if (name === "privacyControl") { S.privacyOpen = true; S.events.push("privacy list"); }
      else if (name === "privacyOpt") { S.privacy = PRIVACY_LABEL[S.privacyWant || "everyone"]; S.privacyOpen = false; S.events.push(`privacy ${S.privacy}`); }
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
  // an answer with `actions` is a plan (the platform sends the first as `action` too, for old engines)
  const g = { calls: [], async nextAction(body) { g.calls.push({ step: body.step, at: NOW, elements: body.view.elements.length }); const a = await answer(body, g.calls.length); return a && a.ok === false ? a : a && a.actions ? { ok: true, action: a.actions[0], actions: a.actions } : { ok: true, action: a }; } };
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
  assert(/Groot searched "Fuzzy Bear Earmuffs", "Earmuffs", "earmuff", "Bear", "Fuzzy" and the whole showcase. Add it to your showcase in TikTok, then tap Try again./.test(r.error), r.error);
  assert.deepStrictEqual(S.searches, ["Fuzzy Bear Earmuffs", "Earmuffs", "earmuff", "Bear", "Fuzzy", ""]);
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
  assert.deepStrictEqual(S.searches.slice(0, 2), ["Comfort slippers", "slippers"], "the full name, then the product word");
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

test("Drew's slipper (2026-10-05): page numbers aren't products, the search goes to page 3 of the results", async () => {
  const filler = Array.from({ length: 24 }, (_, i) => `Weekend Bag ${i + 1} Canvas Tote`);
  const want = "Comfrt | Weekend Slipper | Faux Suede Slip-On With Sherpa-Lin";
  const { r, S, groot } = await run({ showcase: [...filler, want, "Cloud Comfort Slides"], pageSize: 10, searchMode: "any", pageJunk: true }, { job: { product: "comfrt weekend slippers" } });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(S.product, want);
  assert.deepStrictEqual(S.searches, ["comfrt weekend slippers"], "found on the first search's pages");
  assert(S.events.includes("page 3"), S.events.join(" / "));
  assert(/"comfrt weekend slippers" page 3/.test(r.steps.find((s) => s.step === "product_pick").how));
  assert.strictEqual(groot.calls.length, 0);
});

test("TikTok's search finds nothing for any word: the whole showcase, page by page", async () => {
  const filler = Array.from({ length: 37 }, (_, i) => `Item ${i + 1} Thing`);
  const want = "Comfrt Weekend Slipper";
  const { r, S, groot } = await run({ showcase: [...filler, want, "Cloud Comfort Slides"], pageSize: 10, searchMode: "none" }, { job: { product: "Comfort weekend slippers" } });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(S.product, want);
  assert.strictEqual(S.searches[S.searches.length - 1], "", "the whole showcase last");
  assert(S.events.includes("page 4"), S.events.join(" / "));
  assert.strictEqual(groot.calls.length, 0);
});

test("a showcase with pages and nothing like it: every page once, then not in showcase", async () => {
  const filler = Array.from({ length: 30 }, (_, i) => `Item ${i + 1} Thing`);
  const { r, S } = await run({ showcase: filler, pageSize: 10, searchMode: "none" }, { job: { product: "Fuzzy Bear Earmuffs" } });
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.code, "product_not_found");
  assert(S.events.filter((e) => e === "page 3").length >= 1 && S.events.filter((e) => e.startsWith("page ")).length < 10, S.events.join(" / "));
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

// ---- v1.2.4 (2026-10-06): who can watch, the product name, the smarter fallback, learning ----------

// A platform that remembers fixes the way src/lib/groot-learn*.ts does (trusted until 2 misses in a row).
function fakeLearning(seed = []) {
  const L = { rows: seed.map((r, i) => ({ id: `L${i + 1}`, scope: "creator", wins: 1, losses: 0, streak: 0, variant: "", ...r })), solved: [], used: [], asked: 0 };
  return {
    L,
    async learned() { L.asked++; return { ok: true, targets: L.rows.filter((r) => r.streak < 2).map(({ streak, ...r }) => r) }; },
    async learn(body) {
      if (body.solved) { L.solved.push(body.solved); L.rows.push({ id: `L${L.rows.length + 1}`, scope: "creator", wins: 1, losses: 0, streak: 0, ...body.solved }); }
      for (const u of body.used || []) { L.used.push(u); const r = L.rows.find((x) => x.id === u.id); if (r) { if (u.ok) { r.wins++; r.streak = 0; } else { r.losses++; r.streak++; } } }
      return { ok: true };
    },
  };
}
const withLearning = (g, l) => Object.assign(g, { learned: l.learned, learn: l.learn });
const settleLearn = async () => { for (let i = 0; i < 5; i++) await tick(); };

test("who can watch: TikTok remembered 'Only you' → set to Everyone and read back before Post, no AI", async () => {
  const { r, S, groot } = await run({ privacy: "Only you" });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(S.privacyAtPost, "Everyone", "posted as Everyone");
  assert.strictEqual(groot.calls.length, 0);
  const st = r.steps.find((s) => s.step === "privacy");
  assert(/was "Only you": setting Everyone/.test(st.how) && /Everyone \(read back\)/.test(st.how), st.how);
  const i = r.steps.findIndex((s) => s.step === "privacy");
  assert.strictEqual(r.steps[i + 1].step, "post", "right before Post");
});

test("who can watch: already Everyone → nothing touched", async () => {
  const { r, S } = await run({});
  assert.strictEqual(r.status, "posted");
  assert(!S.events.includes("privacy list"), "the setting was never opened");
  assert(/already Everyone/.test(r.steps.find((s) => s.step === "privacy").how));
});

test("who can watch: the creator chose Friends in GoViral → Friends (respected, not Everyone)", async () => {
  const { r, S } = await run({ privacy: "Everyone" }, { job: { privacy: "friends" } });
  assert.strictEqual(r.status, "posted");
  assert.strictEqual(S.privacyAtPost, "Friends");
});

test("who can watch, Manual: set before the handoff, never posted", async () => {
  const page = fakeStudio({ privacy: "Only you" });
  const engine = createEngine({ page, groot: fakeGroot(), report: () => {}, timeouts: { handoff: 3000 }, log: () => {} });
  const r = await engine.run({ ...JOB, mode: "manual" });
  assert.strictEqual(r.status, "ready");
  assert.strictEqual(page.S.privacy, "Everyone");
  assert.strictEqual(page.S.posted, false);
});

test("who can watch, the selectors miss it: Groot sets it (a plan: open, then the option), the check reads it back", async () => {
  const groot = fakeGroot((b) => {
    if (b.step !== "privacy") return { action: "need_user", reason: "other", message: "?" };
    assert.strictEqual(b.privacy, "everyone", "the goal's privacy is sent");
    assert(b.tried.some((t) => /privacyControl not found/.test(t)), "what the script tried goes up");
    const opt = b.view.elements.find((e) => e.role === "option" && /everyone/i.test(e.name));
    if (opt) return { action: "click", ref: opt.ref };
    const ctl = b.view.elements.find((e) => /who can watch/.test(e.near || ""));
    return { action: "click", ref: ctl.ref };
  });
  const { r, S, groot: g } = await run({ privacy: "Only you", privacyControl: false }, { groot });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(S.privacyAtPost, "Everyone");
  assert.strictEqual(g.calls.filter((c) => c.step === "privacy").length, 2);
});

test("product name: TikTok refuses Add over a '|' with no message Groot knows → only the rejected characters come out, Added, no AI", async () => {
  const want = "Comfrt | Weekend Slipper | Faux Suede";
  const { r, S, groot, events } = await run({ showcase: [want], nameError: false }, { job: { product: "comfrt weekend slipper" } });
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(S.productName, "Comfrt Weekend Slipper Faux Suede", "the rest of TikTok's title kept");
  assert(S.addRefused >= 1, "TikTok refused it first");
  assert.strictEqual(groot.calls.length, 0);
  assert(!events.some((e) => e.status === "needs_you"));
  assert(/TikTok refused Add/.test(r.steps.find((s) => s.step === "product_add").how));
});

test("product name: the field no selector finds → Groot types the CLEANED name (cleared first) and presses Add in one plan; learned", async () => {
  const want = "Comfrt | Weekend Slipper | Faux Suede";
  const l = fakeLearning();
  const groot = withLearning(fakeGroot((b) => {
    if (b.step !== "product_add") return { action: "need_user", reason: "other", message: "?" };
    const f = b.view.elements.find((e) => e.dlg && e.value);
    const add = b.view.elements.find((e) => e.name === "productAdd");
    return { actions: [{ action: "type", ref: f.ref, text: "Comfrt Weekend Slipper Faux Suede", clear: true }, { action: "click", ref: add.ref }] };
  }), l);
  const { r, S, events } = await run({ showcase: [want], nameError: false, nameHidden: true }, { job: { product: "comfrt weekend slipper" }, groot });
  await settleLearn();
  assert.strictEqual(r.status, "posted", JSON.stringify(r));
  assert.strictEqual(S.productName, "Comfrt Weekend Slipper Faux Suede");
  assert(!events.some((e) => e.status === "needs_you"), "no needs-you");
  assert.strictEqual(groot.calls.filter((c) => c.step === "product_add").length, 1, "one look, a two-action plan");
  const fix = l.L.solved.find((s) => s.step === "product_add");
  assert(fix, "the fix was saved");
  assert.deepStrictEqual(fix.recipe.map((a) => a.do + (a.value ? `:${a.value}` : "")), ["type:clean_name", "click"]);
  assert(!JSON.stringify(fix).includes("Comfrt"), "nothing of the product in the saved fix");
});

test("product name: Groot may NOT type a name of its own (only the cleaned one)", async () => {
  const want = "Comfrt | Weekend Slipper | Faux Suede";
  const groot = fakeGroot((b) => {
    if (b.step !== "product_add") return { action: "need_user", reason: "other", message: "?" };
    const f = b.view.elements.find((e) => e.dlg && e.value);
    return { action: "type", ref: f.ref, text: "Best Slippers Ever" };
  });
  const page = fakeStudio({ showcase: [want], nameError: false, nameHidden: true });
  const events = [];
  const engine = createEngine({ page, groot, report: (e) => { events.push(e); if (e.status === "needs_you") setImmediate(() => { page.S.dialog = null; page.S.product = want; }); }, log: () => {} });
  const r = await engine.run({ ...JOB, product: "comfrt weekend slipper" });
  assert(!page.S.nameValue.includes("Best"), "never typed");
  assert(events.some((e) => e.status === "needs_you" && e.step === "product_add"));
  assert.strictEqual(r.status, "posted");
});

test("learning: a fix the AI found on one post is tried FIRST on the next, with no AI", async () => {
  const l = fakeLearning();
  const answer = (b) => {
    if (b.step !== "product_open") return { action: "need_user", reason: "other", message: "?" };
    const el = b.view.elements.find((e) => /attach a shop link/i.test(e.name));
    return el ? { action: "click", ref: el.ref } : { action: "need_user", reason: "other", message: "no link button" };
  };
  const g1 = withLearning(fakeGroot(answer), l);
  const first = await run({ addLink: false }, { groot: g1 });
  await settleLearn();
  assert.strictEqual(first.r.status, "posted");
  assert.strictEqual(g1.calls.length, 1);
  assert.strictEqual(first.r.learnedSaved, 1);
  assert.deepStrictEqual(l.L.solved[0].recipe, [{ do: "click", target: { role: "button", tag: "button", text: "Attach a shop link" } }]);
  const g2 = withLearning(fakeGroot(answer), l);
  const second = await run({ addLink: false }, { groot: g2 });
  await settleLearn();
  assert.strictEqual(second.r.status, "posted", JSON.stringify(second.r));
  assert.strictEqual(g2.calls.length, 0, "no AI the second time");
  assert.strictEqual(second.r.learnedUsed, 1);
  assert.deepStrictEqual(l.L.used, [{ id: "L1", ok: true }]);
  assert(/learned fix worked/.test(second.r.steps.find((s) => s.step === "product_open").how));
});

test("learning: a learned fix that misses is reported and demoted (served no more after 2 misses), the post still goes", async () => {
  const l = fakeLearning([{ step: "product_open", recipe: [{ do: "click", target: { role: "button", tag: "button", text: "Old shop link button" } }] }]);
  for (let i = 0; i < 3; i++) {
    const g = withLearning(fakeGroot(), l);
    const { r } = await run({}, { groot: g });
    await settleLearn();
    assert.strictEqual(r.status, "posted", JSON.stringify(r));
  }
  assert.deepStrictEqual(l.L.used, [{ id: "L1", ok: false }, { id: "L1", ok: false }], "tried twice, then no longer served");
  assert.strictEqual(l.L.rows[0].losses, 2);
});

test("learning: nothing from the platform (old platform, or no answer) never slows a post", async () => {
  const g = fakeGroot();
  g.learned = () => new Promise(() => {}); // never answers
  const t = realNow();
  const page = fakeStudio({});
  const engine = createEngine({ page, groot: g, report: () => {}, log: () => {} });
  const r = await engine.run(JOB);
  assert.strictEqual(r.status, "posted");
  assert(realNow() - t < 8000, "the 5 s cap");
});

test("the AI's context: what the script tried, then each action with what happened after it", async () => {
  const bodies = [];
  const groot = fakeGroot((b, n) => {
    bodies.push(JSON.parse(JSON.stringify({ tried: b.tried, history: b.history, plan: b.plan })));
    if (b.step !== "product_open") return { action: "need_user", reason: "other", message: "?" };
    if (n === 1) return { action: "scroll", dy: 300 };
    const el = b.view.elements.find((e) => /attach a shop link/i.test(e.name));
    return { action: "click", ref: el.ref };
  });
  const { r } = await run({ addLink: false }, { groot });
  assert.strictEqual(r.status, "posted");
  assert(bodies[0].tried.some((t) => /addLink not found/.test(t)), JSON.stringify(bodies[0]));
  assert.strictEqual(bodies[0].plan, true);
  assert(/^scrolled 300 → no dialog is open, the step isn't done yet$/.test(bodies[1].history[0]), bodies[1].history[0]);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e && (e.stack || e.message).split("\n").slice(0, 3).join("\n       ")}`); }
  }
  Date.now = realNow;
  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
})();
