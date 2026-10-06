// One post, step by step: FAST SCRIPTED STEPS with an AI FALLBACK.
//
// The scripted steps follow Drew's own walk through TikTok Studio (2026-10-04):
//   TikTok Studio → Upload → Videos (tiktok.com/tiktokstudio/upload) → the video into the upload
//   area → the description (a short caption naming the product, then the hashtags) → no playlist,
//   no location → Add link → Products → Next → search the showcase → select the product → Next →
//   (the link name: never renamed; only characters TikTok refuses come out) → Add → Post now →
//   TikTok's success notice ("Everyone can see this", "uploading a high-quality version").
// A product that isn't in the showcase stops THAT video ("That product isn't in your TikTok Shop
// showcase"); the app carries on with the others.
//
// Speed (2026-10-05, Drew's first real post sat for 3.5 minutes and never posted): the description
// and the product go in WHILE TikTok uploads the video; the upload is waited for last, right before
// Post. Small human pauses only (rules.js DELAYS), quick polling.
//
// Every step first tries its scripted way (rules.js TARGETS). When a step cannot find its target
// in time, or its check fails afterwards, the step asks Groot (POST /api/groot-post/next-action):
// the page's visible elements and a screenshot go up, a short plan comes back (click / type / clear
// / press / scroll / wait / done / need_user), every action is checked again here (rules.js
// validateAction), done with human pacing, and the step checks again. At most MAX_AI_PER_STEP tries a step and
// MAX_AI_PER_POST a post (the server caps it too). The product is never the AI's choice: a row it
// clicks must still match the creator's words (CHECK.product_pick).
// When Groot can't (or can't be reached), the step goes to the creator: "needs you", with plain
// words saying exactly what to do in the TikTok window (rules.js STEP_HELP). Groot watches for it to
// be done and carries on, or gives this video up after TIMEOUTS.creator. Nothing waits silently:
// every wait has a limit (rules.js TIMEOUTS), and the upload waits long only while TikTok shows it
// moving.
//
// v1.2.4 (2026-10-06, Drew: a post went out "Only you"; Groot asked him to take a "|" out of the
// product name by hand; "make him as smart as you", "he needs to be able to learn"):
//   - privacy: "Who can watch this video" is set to the creator's choice (job.privacy, else
//     Everyone) right before Post / the handoff, and read back. Nothing else in the settings.
//   - the product name: found wherever it is (selectors, a learned field, any field in the dialog
//     holding characters TikTok rejects); fixed when TikTok says so OR refuses Add while it holds
//     them; only the rejected characters come out. The AI may type only those cleaned names.
//   - a smarter fallback: each look sends what the scripted step tried and why it missed, the page
//     (with its dialog, notices, labels, data-e2e), the earlier actions WITH what happened after
//     each; the answer may be a short plan (several actions on what is on screen now).
//   - learning: a step the AI gets done is reported as a fix (the platform keeps it for this
//     creator and, without anything personal, for everyone); later posts try learned fixes FIRST,
//     report every use, and a fix that misses is demoted.
//
// Every step logs its start, its end, how long it took, what it used (the selector, a learned fix,
// Groot, the creator) and why it missed; run() returns the whole trail (`steps`) for the app.
//
// Blockers: a captcha or a login page pauses everything, says so in the window's bar and in the
// app, and waits for the creator (Groot never solves a captcha and never types a password).
// blockerMode "stop" (the cloud poster, goviral-platform poster/, where nobody is at the window):
// a captcha, a login page or TikTok pushing back on the account ends the post at once with code
// "captcha" / "login" / "spam" instead of waiting, and so does a step nobody can do. The desktop
// keeps "wait".
//
// Pure of Electron: `page` is a CdpPage (or a fake in a test), `groot` is the client for the
// platform, `report` gets progress. `job.filePath` is the file, or a promise of it (the download
// still running while TikTok Studio opens). Returns { status: posted | ready | failed | stopped,
// error, code, step, steps, ms, aiSteps }.
"use strict";

const { TARGETS, AI_STEPS, STEP_WORDS, STEP_HELP, TIMEOUTS, MAX_AI_PER_STEP, MAX_AI_PER_POST, NOT_IN_SHOWCASE, planSteps, validateAction, captionText, captionParts, normCaption, showcaseList, pickProduct, searchTerms, isProductRow, SHOWCASE_PAGES, cleanProductName, productScore, PICK_AT, TIKTOK_UPLOAD_URL, KEYS, PRIVACY, parsePrivacy, privacyOf, privacyOptionWays, LEARNABLE, MAX_PLAN, NAME_STEPS, typeValues, describeElement, learnedWays, variantOf, isRecipe, scrubRecipe, forbiddenFor } = require("./rules");

class StepMissed extends Error {}
class Failed extends Error { constructor(message, code) { super(message); this.code = code || null; } }

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const short = (t, n = 80) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
const stoppedError = () => Object.assign(new Error("Stopped"), { stopped: true });

function createEngine({ page, groot, report = () => {}, uploadUrl = TIKTOK_UPLOAD_URL, timeouts = {}, log = () => {}, handedBack = () => false, blockerMode = "wait" }) {
  const T = { ...TIMEOUTS, ...timeouts };
  let aiUsed = 0;
  let current = null;
  let notes = [];          // what the current step used and saw, for its log line and the trail
  let stepAi = 0;          // Groot's tries on the current step
  let uploadStartedAt = 0;
  const trail = [];        // one entry per step: { step, ms, ok, how, ai, why? }
  const tried = new Set(); // the search terms typed into the showcase for this post

  const say = (step, message, status = "posting", extra = {}) => report({ step, message: message || STEP_WORDS[step] || "", status, ...extra });
  const note = (what) => { notes.push(what); log("tiktok step", current, what); };
  const how = (name, hit) => {
    const w = hit && TARGETS[name] && TARGETS[name][hit.way];
    return w ? `${name} by ${w.css ? `css ${short(w.css, 60)}` : `text /${short(w.text, 50)}/`}` : name;
  };

  // A page read that never hangs and never throws for a slow page: null (not found) instead.
  let quietUntil = 0;
  // `name` is a TARGETS name, or a list of ways (a learned target, a privacy option)
  async function safeFind(name, value) {
    try { return await page.find(Array.isArray(name) ? name : TARGETS[name], value); } catch (e) {
      if (e && e.stopped) throw e;
      if (Date.now() > quietUntil) { quietUntil = Date.now() + 10000; log("tiktok page read failed", current, Array.isArray(name) ? "ways" : name, e && e.message); }
      return null;
    }
  }
  async function safeRows(name) {
    try { return (await page.rows(TARGETS[name])) || []; } catch (e) { if (e && e.stopped) throw e; return []; }
  }
  async function textOf(ref) {
    try { return (await page.textOf(ref)) || ""; } catch (e) { if (e && e.stopped) throw e; return ""; }
  }

  // Wait for a target, checking for blockers while we wait. `patient`: a target that is there but
  // off while TikTok is still uploading is waited for as long as the upload moves.
  async function waitFor(name, { ms = T.find, value, enabled = false, patient = false } = {}) {
    const start = Date.now();
    let until = start + ms;
    for (;;) {
      await blockers();
      const hit = await safeFind(name, value);
      if (hit && (!enabled || !hit.disabled)) return hit;
      if (patient && hit && hit.disabled && Date.now() - start < T.processed && (await safeFind("uploadProgress"))) until = Math.max(until, Date.now() + 2000);
      if (Date.now() > until) return null;
      await page.pause("poll");
    }
  }
  const visible = async (name, value) => !!(await safeFind(name, value));
  const onUploadPage = () => /tiktokstudio\/upload/.test(page.url());
  // Posted = TikTok's content list, or its success notice with the Post button gone (the privacy
  // setting can say "Everyone" before anything is posted, so the words alone never count).
  const isPosted = async () => /tiktokstudio\/content/.test(page.url()) || ((await visible("posted")) && !(await visible("postButton")));
  // Uploaded = TikTok says so. (The AI's check also takes Post turning on with no progress left.)
  const uploadDone = async () => (await visible("uploaded")) && (await visible("captionBox"));

  // A captcha or a login page: the creator's turn. Polls until it is gone (or times out).
  async function blockers() {
    const captcha = await safeFind("captcha");
    const loginUrl = /\/login(\b|\/|\?|$)/i.test(page.url());
    const login = loginUrl || (await safeFind("login"));
    if (blockerMode === "stop") {
      if (captcha) throw new Failed("TikTok wants a security check.", "captcha");
      if (login) throw new Failed("TikTok logged GoViral out.", "login");
      if (await safeFind("spam")) throw new Failed("TikTok is limiting this account right now.", "spam");
      return;
    }
    if (!captcha && !login) return;
    const reason = captcha ? "captcha" : "login";
    log("tiktok blocker", current, reason);
    say(current, captcha ? "TikTok wants a quick check that you're human. Do it in the TikTok window, Groot waits." : "Log in to TikTok in the TikTok window. Groot never types your password.", "needs_you", { reason });
    const until = Date.now() + T.blocker;
    for (;;) {
      await page.sleep(1000);
      const still = reason === "captcha" ? await safeFind("captcha") : (/\/login(\b|\/|\?|$)/i.test(page.url()) || await safeFind("login"));
      if (!still) break;
      if (Date.now() > until) throw new Failed(reason === "captcha" ? "TikTok's check wasn't finished in time." : "Not logged in to TikTok.");
    }
    log("tiktok blocker cleared", current, reason);
    say(current, "Thanks, carrying on.");
    // After a login TikTok may land anywhere: back to the upload page.
    if (reason === "login" && !onUploadPage()) { await page.goto(uploadUrl, T.goto); await page.pause("betweenSteps"); }
  }

  async function click(name, opts = {}) {
    const hit = await waitFor(name, opts);
    if (!hit) throw new StepMissed(`${name} not found in ${secs(opts.ms || T.find)}`);
    note(`click ${how(name, hit)}`);
    await page.clickRef(hit.ref);
    return hit;
  }

  // The creator's turn for a step Groot can't do: plain words in the bar and the app, then Groot
  // watches for it to be done (`check`) and carries on, or gives this video up. The cloud poster
  // (nobody at the window) ends the post at once.
  async function needsYou(step, message, { check = null, code = "needs_you", fail = null } = {}) {
    if (blockerMode === "stop") throw new Failed(fail || message, code === "needs_you" ? null : code);
    note(`needs you: ${message}`);
    say(step, message, "needs_you", { reason: "step" });
    const until = Date.now() + T.creator;
    for (;;) {
      await page.sleep(1000);
      await blockers();
      if (check && (await check().catch((e) => { if (e && e.stopped) throw e; return false; }))) {
        note("the creator did it");
        say(step, "Thanks, carrying on.");
        return;
      }
      if (Date.now() > until) throw new Failed(fail || message, code);
    }
  }

  // The video file: there already, or still downloading (TikTok Studio opened meanwhile).
  async function videoPath(job) {
    const f = job.filePath;
    if (!f || typeof f.then !== "function") return f;
    let done = false;
    let out;
    let err = null;
    f.then((v) => { done = true; out = v; }, (e) => { done = true; err = e; });
    await Promise.resolve();
    if (!done) {
      const t0 = Date.now();
      note("waiting for the video to finish downloading");
      while (!done) {
        const p = typeof job.fileProgress === "function" ? job.fileProgress() : null;
        const mb = p && p.bytes ? ` (${Math.round(p.bytes / 1048576)} MB${p.total ? ` of ${Math.round(p.total / 1048576)} MB` : ""})` : "";
        say("upload", `${job.source && job.source.kind === "drive" ? "Getting your video from Google Drive" : "Getting your video"}${mb}`);
        await Promise.race([f.catch(() => {}), page.sleep(1000)]);
      }
      note(`the download finished ${secs(Date.now() - t0)} after TikTok was ready for it`);
    }
    if (err) {
      if (err.stopped || err.name === "AbortError") throw stoppedError();
      throw new Failed(err.message || "The video didn't download.", "download");
    }
    return out;
  }

  // ---- the description ------------------------------------------------------------------------
  // The caption, then each hashtag on its own with Escape after it (TikTok's hashtag list must not
  // take the next space or a click); then the box must hold EXACTLY that text, or it is typed again,
  // one character at a time, once.
  const wantCaption = (job) => normCaption(captionText(job.caption, job.hashtags));
  async function captionNow() {
    const b = await safeFind("captionBox");
    return b ? normCaption(await textOf(b.ref)) : null;
  }
  async function typeCaption(job, slow) {
    const box = await click("captionBox");
    await page.clearFocused();
    const left = normCaption(await textOf(box.ref));
    if (left) {
      // select-all didn't take (the box wasn't focused): click it again and clear again
      note(`the box still held "${short(left, 40)}" after clearing: clearing again`);
      await page.clickRef(box.ref);
      await page.clearFocused();
    }
    for (const part of captionParts(job.caption, job.hashtags)) {
      await page.type(part, { slow });
      if (part.includes("#")) { await page.sleep(150); await page.key("Escape").catch(() => {}); }
    }
    await page.sleep(250);
    const b = (await safeFind("captionBox")) || box;
    return normCaption(await textOf(b.ref));
  }

  // ---- the upload -----------------------------------------------------------------------------
  // Waits while TikTok shows the upload moving ("Uploading 45%", a progress bar), logging it and
  // showing it in the bar. Nothing recognizable on the page for T.stall: Groot looks (it may say
  // wait). The same progress for T.stuck: the creator. Then the description is checked again.
  async function waitUploaded(job) {
    const start = Date.now();
    const until = start + T.processed;
    let lastSig;
    let lastChange = start;
    let lastSaid = 0;
    let lastLogged = 0;
    let stallLimit = T.stall;
    let looks = 0;
    for (;;) {
      await blockers();
      if (await visible("uploadFailed")) throw new Failed("TikTok couldn't upload the video. Press Stop, then try this video again.", "upload_failed");
      if (await uploadDone()) { note(`uploaded${uploadStartedAt ? ` ${secs(Date.now() - uploadStartedAt)} after the file went in` : ""} (waited ${secs(Date.now() - start)} here)`); break; }
      const prog = await safeFind("uploadProgress");
      const sig = prog ? short(prog.text, 40) || "progress bar" : null;
      const now = Date.now();
      if (sig !== lastSig) { lastSig = sig; lastChange = now; }
      if (sig && now - lastSaid > 4000) {
        lastSaid = now;
        const pct = (/\d+(\.\d+)?\s*%/.exec(sig) || [""])[0].replace(/\s+/g, "");
        say("wait_processed", `TikTok is uploading the video${pct ? ` (${pct})` : ""}`);
      }
      if (sig && now - lastLogged > 10000) { lastLogged = now; note(`still uploading: ${sig}`); }
      if (!sig && now - lastChange > stallLimit) {
        // Nothing on the page says uploading or uploaded: Groot looks at the screen.
        note(`nothing on the page says uploading or uploaded for ${secs(now - lastChange)}: Groot looks`);
        const r = await askGroot("wait_processed", job, { tries: 1, waitReturns: true }).catch((e) => e);
        if (r && r.stopped) throw r;
        if (r === "done") break;
        if (r === "wait" && ++looks < 4) { lastChange = Date.now(); stallLimit = Math.min(stallLimit * 2, 120000); continue; }
        if (r instanceof Failed && r.code) throw r;
        if (r instanceof Error && !(r instanceof Failed)) throw r;
        await needsYou("wait_processed", STEP_HELP.wait_processed, { check: CREATOR_CHECK.wait_processed });
        break;
      }
      if (sig && now - lastChange > T.stuck) {
        await needsYou("wait_processed", `TikTok's upload has been stuck at ${sig} for ${Math.round(T.stuck / 60000)} min. Check your internet. Groot carries on when it moves, or press Stop.`, { check: CREATOR_CHECK.wait_processed, code: "upload_stuck" });
        break;
      }
      if (now > until) throw new StepMissed(`still uploading after ${Math.round(T.processed / 60000)} min`);
      await page.sleep(1000);
    }
    // TikTok may rewrite the description when the upload finishes (the file name): check it again.
    if (!(await isPosted())) {
      const now = await captionNow();
      if (now !== null && now !== wantCaption(job)) {
        note(`the description changed while uploading ("${short(now, 60)}"): writing it again`);
        await doStep("caption", job);
      }
    }
  }

  // ---- the showcase ---------------------------------------------------------------------------
  // Type one term into the product search, then wait for the rows to settle (changed from what was
  // there before, or still for a moment) or TikTok's "no products".
  const sigOf = (rows) => rows.map((r) => r.text).join("|");
  const productRows = async () => (await safeRows("productRows")).filter((r) => isProductRow(r.text));
  // Wait for the rows to change from `before` and hold still (or for a moment, or "no products").
  async function settle(before) {
    const t0 = Date.now();
    const until = t0 + T.results;
    let last = null;
    let rows = [];
    for (;;) {
      await page.sleep(300);
      rows = await productRows();
      if (!rows.length && (await visible("productNoResults"))) break;
      const sig = sigOf(rows);
      if (rows.length && sig === last && (sig !== before || Date.now() - t0 > 1500)) break;
      last = sig;
      if (Date.now() > until) break;
    }
    return { rows, ms: Date.now() - t0 };
  }
  async function search(term) {
    tried.add(term.toLowerCase());
    const before = sigOf(await productRows());
    await click("productSearch");
    await page.clearFocused();
    await page.type(term);
    await page.key("Enter");
    const { rows, ms } = await settle(before);
    note(`searched "${term}": ${rows.length ? `${rows.length} row(s): ${showcaseList(rows, 4)}` : "no products"} (${secs(ms)})`);
    return rows;
  }
  // The results' next page: the page button one past `n`, else the last wordless one (the arrow).
  // Null on the last page (nothing moved).
  async function nextPage(n) {
    const pages = await safeRows("productPages");
    const btn = pages.find((p) => p.text === String(n + 1)) || [...pages].reverse().find((p) => !p.text);
    if (!btn) { note(`no page ${n + 1} (page buttons: ${pages.map((p) => `"${p.text}"`).join(" ") || "none"})`); return null; }
    const before = sigOf(await productRows());
    await page.clickRef(btn.ref);
    const { rows } = await settle(before);
    if (!rows.length || sigOf(rows) === before) { note(`pressed "${btn.text || "next"}": page ${n + 1} didn't load`); return null; }
    note(`page ${n + 1}: ${rows.length} row(s): ${showcaseList(rows, 3)}`);
    return rows;
  }
  const noResults = () => visible("productNoResults");

  // The link name TikTok shows after Next. Left exactly as it is, unless TikTok won't take it: it
  // says so (productNameError), or it refuses Add while the name holds characters it rejects
  // (`refused`; Drew's post, 2026-10-05: no message Groot knew, Add did nothing because of a "|").
  // Then those characters come out (emoji and symbols first, then all but letters, numbers and
  // spaces), and nothing else changes. The field is found wherever it is: the selectors, a learned
  // field, or any field in the dialog holding rejected characters (TARGETS.productNameInput).
  // Returns true (nothing to fix, or fixed), false (TikTok still refuses / no field: the AI looks).
  async function nameField() {
    for (const L of learnedFor("product_name").concat(learnedFor("product_add"))) {
      for (const a of L.recipe) {
        if (a.do !== "type" || a.value !== "clean_name") continue;
        const hit = await safeFind(learnedWays(a.target));
        if (hit) { note("the name field from a learned fix"); return hit; }
      }
    }
    return waitFor("productNameInput", { ms: 3000 });
  }
  async function fixProductName({ refused = false } = {}) {
    const said = await safeFind("productNameError");
    if (!said && !refused) return true;
    const input = await nameField();
    if (!input) { note(`TikTok refuses the name${said ? ` ("${short(said.text, 60)}")` : ""}, and Groot can't find the name field`); return false; }
    let changed = false;
    for (const level of [1, 2]) {
      const now = await textOf(input.ref);
      const clean = cleanProductName(now, level);
      if (!clean || clean === now.replace(/\s+/g, " ").trim()) continue;
      note(`product name level ${level}: ${now.length} → ${clean.length} chars${said ? ` (TikTok: "${short(said.text, 50)}")` : " (TikTok refused Add)"}`);
      say("product_name", "Taking out characters TikTok won't take in the product name");
      await page.clickRef(input.ref);
      await page.clearFocused();
      await page.type(clean);
      await page.pause("afterClick");
      changed = true;
      if (!(await visible("productNameError"))) return true;
    }
    // Refused, but nothing in the name to take out: something else is wrong (the AI looks).
    if (refused && !changed) return false;
    return !(await visible("productNameError"));
  }

  // ---- the scripted steps ---------------------------------------------------------------------
  const SCRIPTED = {
    async open() {
      const r = await page.goto(uploadUrl, T.goto);
      note(r && r.timedOut ? `TikTok Studio still loading after ${secs(r.ms)}: carrying on` : `TikTok Studio loaded${r && r.ms ? ` in ${secs(r.ms)}` : ""}`);
      await blockers();
    },
    async upload(job) {
      let input = await waitFor("fileInput", { ms: T.find });
      if (!input) {
        // Not on the upload area: TikTok Studio → Upload → Videos.
        note("no file input: Upload → Videos");
        const nav = await waitFor("uploadNav", { ms: 3000 });
        if (nav) { note(`click ${how("uploadNav", nav)}`); await page.clickRef(nav.ref); await page.pause("betweenSteps"); }
        const tab = await waitFor("videosTab", { ms: 3000 });
        if (tab) { note(`click ${how("videosTab", tab)}`); await page.clickRef(tab.ref); await page.pause("afterClick"); }
        input = await waitFor("fileInput", { ms: T.find });
      }
      if (!input) throw new StepMissed("no file input on the page");
      const filePath = await videoPath(job);
      // the download can take a while: the input found before it may be gone
      if (!(await safeFind("fileInput"))) input = await waitFor("fileInput", { ms: T.find });
      if (!input) throw new StepMissed("the file input went away while the video downloaded");
      await page.setFiles(input.ref, filePath);
      uploadStartedAt = Date.now();
      note(`file set on ${how("fileInput", input)}`);
    },
    async caption(job) {
      const want = wantCaption(job);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const got = await typeCaption(job, attempt > 1);
        if (got === want) { note(`description ok: ${want.length} chars${attempt > 1 ? " (second try)" : ""}`); return; }
        note(`description try ${attempt} came out "${short(got, 100)}" (${got.length} chars, wanted ${want.length})`);
      }
      throw new StepMissed("the description box didn't hold the caption after 2 tries");
    },
    async product_open() {
      // Add link can be off while TikTok is still uploading: waited for while the upload moves.
      for (let i = 0; i < 2; i++) {
        const hit = await waitFor("addLink", { enabled: true, patient: true });
        if (!hit) throw new StepMissed(`addLink not found in ${secs(T.find)}`);
        note(`click ${how("addLink", hit)}`);
        await page.clickRef(hit.ref);
        if (await waitFor("dialog", { ms: 3000 })) return;
        note("the link box didn't open");
      }
      throw new StepMissed("Add link didn't open the link box");
    },
    async product_tab() {
      // Products may already be the choice (Drew's TikTok: no Products option to press, only Next,
      // 2026-10-05): then Next, and the product search must show.
      const opt = await waitFor("productsOption", { ms: (await visible("productSearch")) ? 500 : 3000 });
      if (opt) { note(`click ${how("productsOption", opt)}`); await page.clickRef(opt.ref); }
      else if (await visible("productSearch")) { note("already on the product list"); return; }
      else note("no Products choice to press: Next");
      const next = await waitFor("linkNext", { ms: 3000, enabled: true });
      if (next) { note(`click ${how("linkNext", next)}`); await page.clickRef(next.ref); }
      if (!(await waitFor("productSearch", { ms: opt ? T.find : 4000 }))) throw new StepMissed(opt ? "productSearch not found" : "productsOption not found, and Next didn't open the product list");
    },
    async product_search(job) { await search(searchTerms(job.product)[0]); },
    async product_pick(job) {
      // Every search term, and every page of its results, before Groot says the product isn't there.
      const terms = searchTerms(job.product);
      const seen = [];
      for (const term of terms) {
        let rows = tried.has(term.toLowerCase()) ? await productRows() : await search(term);
        const most = term ? SHOWCASE_PAGES.term : SHOWCASE_PAGES.all;
        for (let p = 1; ; p++) {
          seen.push(...rows);
          const best = pickProduct(job.product, rows);
          if (best) {
            note(`picked "${short(best.text, 60)}" (score ${best.score.toFixed(2)}, "${term}" page ${p})`);
            await page.clickRef(best.ref);
            await page.pause("afterClick");
            if (!(await CHECK.product_pick(job))) throw new StepMissed("the picked row didn't show as selected");
            return;
          }
          if (!rows.length || p >= most) { if (rows.length) note(`"${term}": no match in ${p} page(s)`); break; }
          const more = await nextPage(p);
          if (!more) break;
          rows = more;
        }
      }
      // Not one product row on any search, the whole showcase included: the list is built in a way
      // Groot doesn't read, not an empty showcase. The AI looks at the page.
      if (!seen.length) throw new StepMissed("no product rows on any search");
      const typed = terms.filter(Boolean).map((t) => `"${t}"`).join(", ");
      // Only rows that share a word with the product are worth asking about; a showcase with
      // nothing like it means the product isn't there, said at once.
      const list = showcaseList(seen.filter((r) => productScore(job.product, r.text) > 0));
      const addIt = "Add it to your showcase in TikTok, then tap Try again.";
      if (!list) throw new Failed(`${NOT_IN_SHOWCASE}. Groot searched ${typed} and the whole showcase. ${addIt}`, "product_not_found");
      // TikTok showed products, none clearly the creator's: their call, never Groot's guess.
      await needsYou("product_pick", `Groot searched ${typed} and the whole showcase. It shows ${list}, and none is clearly "${job.product}". Select the right one in the TikTok window, or press Stop.`, {
        check: CREATOR_CHECK.product_pick,
        code: "product_not_found",
        fail: `${NOT_IN_SHOWCASE}. TikTok showed ${list}. ${addIt}`,
      });
    },
    async product_next() {
      // Next must move the box on (the name step, Add, or closed). On Drew's post it didn't the
      // first time and the AI had to press it again (2026-10-05): pressed again once, then Groot.
      for (let i = 0; i < 2; i++) {
        await click("productNext", { enabled: true, ms: i ? 2000 : 5000 }).catch((e) => { if (i && e instanceof StepMissed) return null; throw e; });
        const until = Date.now() + 4000;
        for (;;) {
          await page.pause("poll");
          if (await CHECK.product_next()) return;
          if (Date.now() > until) break;
        }
        if (!(await visible("productNext"))) break;
        note("Next didn't move the product box on: pressing it again");
      }
      throw new StepMissed("Next didn't open the product name step or Add");
    },
    async product_name() {
      // Some accounts skip the name step: on as soon as Add shows (or the box closed) without it.
      const until = Date.now() + 4000;
      for (;;) {
        if (await visible("productNameInput")) break;
        if ((await visible("productAdd")) || !(await visible("dialog"))) { note("no name field: the name is checked when Add is pressed"); return; }
        if (Date.now() > until) { note("no name step showed"); return; }
        await page.pause("poll");
      }
      if (!(await fixProductName())) throw new StepMissed("TikTok still won't take the product's link name");
      note("the name stays as TikTok has it");
    },
    async product_add() {
      for (let i = 0; i < 4; i++) {
        const add = await waitFor("productAdd", { ms: 5000 });
        if (!add) break;
        if (add.disabled && !(await fixProductName({ refused: true }))) throw new StepMissed("Add is off and the name has nothing Groot may take out");
        note(`click ${how("productAdd", add)}`);
        await page.clickRef(add.ref);
        const until = Date.now() + 3000;
        while ((await visible("dialog")) && Date.now() < until) await page.pause("poll");
        if (!(await visible("dialog"))) return;
        // TikTok refused Add: often the name (it may only say so once Add is pressed, or not at all)
        note("the product box is still open after Add");
        if (!(await fixProductName({ refused: true }))) throw new StepMissed("TikTok refused Add and the name has nothing Groot may take out");
      }
      if (await visible("dialog")) throw new StepMissed("the product box didn't close after Add");
    },
    // Who can watch this video: the creator's choice (or Everyone), set and read back. Only this
    // setting: comments, duet, stitch, the AI-generated and branded-content labels stay as they are.
    async privacy(job) {
      if (await isPosted()) { note("already posted (the creator pressed Post)"); return; }
      const want = wantPrivacy(job);
      const label = PRIVACY[want].label;
      const ctl = await waitFor("privacyControl", { ms: T.find });
      if (!ctl) throw new StepMissed("privacyControl not found");
      const was = await privacyNow(ctl);
      if (was === want) { note(`who can watch: already ${label}`); return; }
      note(`who can watch was "${short(await textOf(ctl.ref), 30) || "?"}": setting ${label}`);
      say("privacy", `Setting who can watch to ${label}`);
      for (let i = 0; i < 2; i++) {
        const c = (await safeFind("privacyControl")) || ctl;
        await page.clickRef(c.ref);
        const opt = await waitFor(privacyOptionWays(want), { ms: 3000 });
        if (!opt) { await page.key("Escape").catch(() => {}); continue; }
        note(`click the "${short(opt.text, 30)}" option`);
        await page.clickRef(opt.ref);
        await page.pause("afterClick");
        if ((await privacyNow()) === want) { note(`who can watch: ${label} (read back)`); return; }
      }
      throw new StepMissed(`who can watch didn't change to ${label}`);
    },
    async wait_processed(job) { await waitUploaded(job); },
    async post() {
      if (await isPosted()) { note("already posted (the creator pressed Post)"); return; }
      await click("postButton", { enabled: true, ms: T.find * 2 });
    },
    async confirm_posted() {
      const until = Date.now() + T.posted;
      for (;;) {
        await blockers();
        if (await isPosted()) return;
        const now = await safeFind("postNowDialog");
        if (now) { note(`click ${how("postNowDialog", now)}`); await page.clickRef(now.ref); continue; }
        if (Date.now() > until) throw new StepMissed(`no success notice in ${secs(T.posted)}`);
        await page.sleep(500);
      }
    },
    async handoff() {
      say("handoff", "Everything is filled in. Check it and press Post now in the TikTok window.", "ready");
      const until = Date.now() + T.handoff;
      for (;;) {
        await page.sleep(1000);
        if (await isPosted()) return "posted";
        if (handedBack() || Date.now() > until) return "ready";
      }
    },
  };

  // After the AI says done (or does something), has the step really happened?
  const CHECK = {
    upload: async () => !(await visible("fileInput")) || (await visible("captionBox")),
    // TikTok says uploaded, or Post is on with no progress left (what the AI saw on the screen)
    wait_processed: async () => (await uploadDone()) || ((await safeFind("postButton").then((b) => !!b && !b.disabled)) && !(await visible("uploadProgress")) && (await visible("captionBox"))),
    caption: async (job) => (await captionNow()) === wantCaption(job),
    // the link box (not some other dialog): its choice, its Next, or the product search
    product_open: async () => (await visible("dialog")) && ((await visible("productsOption")) || (await visible("linkNext")) || (await visible("productSearch"))),
    product_tab: async () => visible("productSearch"),
    product_search: async () => (await safeRows("productRows")).length > 0 || noResults(),
    // the selected row must be the creator's product, whoever clicked it
    product_pick: async (job) => [...(await safeRows("productSelected")), ...(await productRows()).filter((r) => r.selected)].some((r) => productScore(job.product, r.text) >= PICK_AT),
    product_next: async () => (await visible("productNameInput")) || (await visible("productAdd")) || !(await visible("dialog")),
    // TikTok has stopped complaining about the name (or the box moved on / closed)
    product_name: async () => !(await visible("productNameError")) && ((await visible("productAdd")) || !(await visible("dialog")) || !(await nameStillRejected())),
    product_add: async () => !(await visible("dialog")),
    privacy: async (job) => (await privacyNow()) === wantPrivacy(job),
    post: async () => (await isPosted()) || (await visible("postNowDialog")),
    confirm_posted: async () => isPosted(),
  };
  // When the creator does a step: what counts as done (the product they pick is their choice).
  const CREATOR_CHECK = {
    upload: async () => visible("fileInput"), // Groot attaches the file itself once the upload area shows
    product_pick: async () => (await safeRows("productSelected")).length > 0 || (await productRows()).some((r) => r.selected),
    wait_processed: async () => (await CHECK.wait_processed()) || (await isPosted()),
    // the creator may pick another privacy in the window: theirs to choose
    privacy: async () => (await privacyNow()) !== null,
    product_name: async () => !(await visible("dialog")) || !(await visible("productNameError")),
  };

  // ---- who can watch ----------------------------------------------------------------------------
  const wantPrivacy = (job) => parsePrivacy(job && job.privacy) || "everyone";
  // What "Who can watch this video" shows now (a PRIVACY key), or null.
  async function privacyNow(hit) {
    const c = hit || (await safeFind("privacyControl"));
    if (c) return privacyOf((await textOf(c.ref)) || c.text);
    // The selectors miss it (TikTok changed it; the AI found it): what the page shows next to
    // "Who can watch", read from the snapshot (a radio counts only when it is the checked one).
    const view = await page.snapshot().catch((e) => { if (e && e.stopped) throw e; return null; });
    const els = ((view && view.elements) || []).filter((e) => !e.dlg && e.role !== "option" && /who can (watch|view|see)/i.test(`${e.near || ""} ${e.label || ""}`));
    const el = els.find((e) => (/radio/.test(e.role) || e.type === "radio" ? e.checked : true) && privacyOf(e.value || e.text || e.name));
    return el ? privacyOf(el.value || el.text || el.name) : null;
  }
  // The name field still holds characters TikTok rejects (for CHECK.product_name).
  async function nameStillRejected() {
    const f = await safeFind("productNameInput");
    if (!f) return false;
    const v = await textOf(f.ref);
    return cleanProductName(v, 1) !== v.replace(/\s+/g, " ").trim();
  }

  // ---- learning -----------------------------------------------------------------------------------
  // The platform's learned fixes for this creator (and everyone), asked for once per post while
  // TikTok Studio opens; tried FIRST on a LEARNABLE step. Every use is reported (worked / missed),
  // so the platform demotes a fix that stops working. A step the AI gets done is reported as a new
  // fix. Nothing here ever blocks a post: no answer in 5 s = no learned fixes.
  const learned = { list: [], ready: null, used: 0, saved: 0 };
  let postId = null;
  function loadLearned(job) {
    if (!groot || typeof groot.learned !== "function") { learned.ready = Promise.resolve([]); return; }
    let timer = null;
    learned.ready = Promise.race([
      Promise.resolve().then(() => groot.learned({ postId: job.postId, platform: "tiktok" })).catch(() => null),
      new Promise((r) => { timer = setTimeout(() => r(null), 5000); }),
    ]).then((r) => {
      clearTimeout(timer);
      learned.list = r && r.ok && Array.isArray(r.targets) ? r.targets.filter((t) => t && typeof t.id === "string" && LEARNABLE.has(t.step) && isRecipe(t.recipe, t.step)).slice(0, 40) : [];
      if (learned.list.length) log("tiktok learned fixes", learned.list.length, learned.list.map((t) => `${t.step}(${t.scope || "?"})`).join(" "));
      return learned.list;
    });
  }
  const learnedFor = (step) => learned.list.filter((t) => t.step === step);
  const tell = (body) => {
    if (!groot || typeof groot.learn !== "function") return;
    Promise.resolve().then(() => groot.learn({ postId, platform: "tiktok", ...body })).catch(() => {});
  };
  const targetWords = (t) => (t ? `${t.role || t.tag}${t.text ? ` "${short(t.text, 30)}"` : t.label ? ` "${short(t.label, 30)}"` : t.privacy ? " (a privacy choice)" : ""}` : "?");
  async function waitCheck(step, job, ms) {
    if (!CHECK[step]) return true;
    const until = Date.now() + ms;
    for (;;) {
      if (await CHECK[step](job).catch((e) => { if (e && e.stopped) throw e; return false; })) return true;
      if (Date.now() > until) return false;
      await page.pause("poll");
    }
  }
  // One learned fix, done the way the AI did it. Null = it worked; else why it missed.
  async function replay(fix, step, job) {
    for (const act of fix.recipe) {
      if (act.do === "press") { await page.key(act.key); continue; }
      const hit = await waitFor(learnedWays(act.target, wantPrivacy(job)), { ms: 3000 });
      if (!hit) return `${targetWords(act.target)} isn't on the page`;
      // what it found is checked again by its own words (a learned description can match the wrong
      // thing on a changed page): never Post off the post steps, Discard, or the AI / branded switches
      const no = forbiddenFor({ name: hit.text }, step);
      if (no) return `${targetWords(act.target)} matched "${short(hit.text, 30)}", which Groot never presses here`;
      if (act.do === "click") { await page.clickRef(hit.ref); continue; }
      if (act.do === "clear") { await page.clickRef(hit.ref); await page.clearFocused(); continue; }
      // type: only ever a cleaned name, worked out now from what the field holds
      const now = await textOf(hit.ref);
      let text = cleanProductName(now, 1);
      if (text === now.replace(/\s+/g, " ").trim()) text = cleanProductName(now, 2);
      if (!text || text === now.replace(/\s+/g, " ").trim()) continue; // nothing to take out
      await page.clickRef(hit.ref);
      await page.clearFocused();
      await page.type(text);
    }
    return (await waitCheck(step, job, 3000)) ? null : "the step's check failed after it";
  }
  async function tryLearned(step, job) {
    if (!LEARNABLE.has(step) || !learned.ready) return false;
    await learned.ready;
    const mine = learnedFor(step);
    if (!mine.length) return false;
    let v = "";
    try { v = variantOf(await page.variant()); } catch (e) { if (e && e.stopped) throw e; }
    // the same page variant first; otherwise the platform's order (the creator's own, then the most wins)
    const order = [...mine.filter((t) => t.variant === v), ...mine.filter((t) => t.variant !== v)].slice(0, 2);
    for (const fix of order) {
      const why = await replay(fix, step, job);
      tell({ used: [{ id: fix.id, ok: !why }] });
      if (!why) { learned.used++; note(`learned fix worked (${fix.scope === "global" ? "learned on other accounts" : "learned on this account"}, ${fix.wins || 1} win(s) before)`); return true; }
      note(`learned fix missed: ${why} (reported, it is trusted less now)`);
    }
    return false;
  }
  // What the AI did on a step it got done → a fix for next time. Clicks on things the snapshot
  // described, emptying a box, a cleaned name, keys; never a click on a bare point, never more
  // than MAX_PLAN + 1 actions, never on a step that isn't LEARNABLE.
  function learnFrom(step, variant, raw, job) {
    if (!LEARNABLE.has(step) || !raw.length || raw.length > MAX_PLAN + 1 || raw.some((r) => !r)) return;
    const recipe = scrubRecipe(raw, job);
    // every target must still say how to find it (words, a label, data-e2e...) once the post's own words are out
    if (!isRecipe(recipe, step) || recipe.some((a) => a.target && !(a.target.text || a.target.label || a.target.e2e || a.target.ph || a.target.near || a.target.privacy))) return;
    learned.saved++;
    tell({ solved: { step, variant, recipe } });
    note("what worked is saved for next time");
  }

  // The state after the AI's actions, in a few words, for its next look ("→ the box is still open").
  async function outcome(step, job) {
    const bits = [(await visible("dialog")) ? "a dialog is open" : "no dialog is open"];
    const err = await safeFind("productNameError");
    if (err) bits.push(`TikTok says "${short(err.text, 80)}"`);
    if (step === "privacy") bits.push(`who can watch shows ${PRIVACY[(await privacyNow())] ? PRIVACY[await privacyNow()].label : "something Groot can't read"}`);
    if (CHECK[step]) bits.push((await CHECK[step](job).catch(() => false)) ? "the step's check passes" : "the step isn't done yet");
    return bits.join(", ");
  }

  // ---- the AI fallback ------------------------------------------------------------------------
  // `tries`: how many actions this call may take. `waitReturns`: a "wait" answer goes back to the
  // caller (the upload loop keeps waiting itself) instead of costing more tries.
  // Each look sends the page (elements + screenshot), what the scripted step tried and why it
  // missed (the step's notes), and the earlier actions WITH what happened after each; the answer is
  // a short plan (up to MAX_PLAN actions on the elements on screen now, the platform's `actions`;
  // an older platform's single `action` works too). Every action is checked again here
  // (validateAction) before it runs. A step the AI gets done is learned (learnFrom).
  async function askGroot(step, job, { tries = MAX_AI_PER_STEP, waitReturns = false } = {}) {
    const history = [];
    const recipe = [];      // what the AI did on this step, described, for learning
    let variant = null;     // the page it was stuck on
    const caption = captionText(job.caption, job.hashtags);
    const finished = () => { learnFrom(step, variant, recipe, job); return "done"; };
    for (let i = 0; i < tries; i++) {
      if (aiUsed >= MAX_AI_PER_POST) throw new Failed("Groot has tried this one enough.");
      await blockers();
      aiUsed++;
      stepAi++;
      say(step, `${STEP_WORDS[step]} (Groot is taking a look)`, "posting", { ai: true });
      const t0 = Date.now();
      const view = await page.snapshot().catch((e) => { if (e && e.stopped) throw e; return null; });
      if (!view) throw new Failed("Groot couldn't read the page.");
      if (variant === null) variant = variantOf(view);
      const values = typeValues(step, job, view);
      const screenshot = await page.screenshot().catch(() => null);
      const tried = notes.filter((n) => !/^Groot \(/.test(n)).slice(-8).map((n) => short(n, 200));
      let timer = null;
      const res = await Promise.race([
        Promise.resolve().then(() => groot.nextAction({ postId: job.postId, step, view, screenshot, history, tried, privacy: wantPrivacy(job), plan: true })).catch(() => ({ ok: false, error: "Groot couldn't reach GoViral." })),
        new Promise((r) => { timer = setTimeout(() => r({ ok: false, error: `Groot didn't answer in ${Math.round(T.ai / 1000)} s.` }), T.ai); }),
      ]).finally(() => clearTimeout(timer));
      if (!res || !res.ok) { log("tiktok ai unavailable", step, secs(Date.now() - t0), (res && res.error) || ""); throw new Failed((res && res.error) || "Groot couldn't see the page."); }
      const plan = (Array.isArray(res.actions) && res.actions.length ? res.actions : [res.action]).slice(0, MAX_PLAN).map((x) => validateAction(x, view, values, step));
      const did = [];
      for (let k = 0; k < plan.length; k++) {
        const a = plan[k];
        const el = a.ref !== undefined && a.ref !== null ? view.elements.find((e) => e.ref === a.ref) : null;
        note(`Groot (${secs(Date.now() - t0)})${plan.length > 1 ? ` ${k + 1}/${plan.length}` : ""}: ${a.action}${el ? ` ref ${a.ref} "${short(el.name, 40)}"` : ""}${a.action === "type" ? ` ${a.text === caption ? "the caption" : a.text === job.product ? "the product" : "a cleaned name"}` : ""}${a.action === "need_user" ? ` ${a.reason}: ${a.message}` : ""}`);
        try {
          switch (a.action) {
            case "done":
              if (!CHECK[step] || (await CHECK[step](job))) return finished();
              did.push("said done, but the step's check failed");
              break;
            case "need_user":
              if (a.reason === "other") throw new Failed(a.message, step === "product_pick" && a.message.startsWith(NOT_IN_SHOWCASE) ? "product_not_found" : null);
              if (blockerMode === "stop") throw new Failed(a.message, a.reason === "captcha" ? "captcha" : "login");
              say(step, a.message, "needs_you", { reason: a.reason });
              await page.sleep(4000);
              await blockers();
              did.push(`asked the creator (${a.reason})`);
              break;
            case "click":
              if (a.ref !== undefined) await page.clickRef(a.ref); else await page.clickAt(a.x, a.y);
              recipe.push(a.ref !== undefined ? (el ? { do: "click", target: describeElement(el) } : null) : null);
              did.push(a.ref !== undefined ? `clicked ref ${a.ref} "${short((el || {}).name, 40)}"` : `clicked the point ${Math.round(a.x)},${Math.round(a.y)}`);
              break;
            case "clear":
              await page.clickRef(a.ref);
              await page.clearFocused();
              recipe.push(el ? { do: "clear", target: describeElement(el) } : null);
              did.push(`emptied ref ${a.ref} "${short((el || {}).name, 40)}"`);
              break;
            case "type": {
              if (a.ref !== null) await page.clickRef(a.ref);
              const cleaned = NAME_STEPS.has(step) && a.text !== caption && a.text !== job.product;
              if (a.clear || cleaned || step === "caption" || step === "product_search") await page.clearFocused();
              await page.type(a.text);
              if (step === "caption") await page.key("Escape").catch(() => {});
              // a cleaned name is learned as "clean the name in this field" (worked out again next time)
              recipe.push(cleaned && el ? { do: "type", value: "clean_name", target: describeElement(el) } : null);
              did.push(`typed ${a.text === caption ? "the caption" : a.text === job.product ? "the product" : `the cleaned name "${short(a.text, 60)}"`}${a.ref !== null ? ` into ref ${a.ref}` : ""}`);
              break;
            }
            case "press": await page.key(a.key); recipe.push({ do: "press", key: a.key }); did.push(`pressed ${a.key}`); break;
            case "scroll": await page.scroll(a.dy); did.push(`scrolled ${a.dy}`); break;
            case "wait":
              await page.sleep(a.ms);
              did.push(`waited ${a.ms} ms`);
              if (waitReturns) { history.push(did.join(", ")); return CHECK[step] && (await CHECK[step](job)) ? finished() : "wait"; }
              break;
          }
        } catch (e) {
          // a button from the plan went away (the page moved on): the AI looks again
          if ((e && e.stopped) || e instanceof Failed || (e && e.needUser)) throw e;
          did.push(`could not do it (${short(e && e.message, 60)})`);
          break;
        }
        if (a.action === "done" || a.action === "need_user") break; // these end a plan
        if (k < plan.length - 1) await page.pause("betweenSteps");
      }
      if (CHECK[step] && plan.every((a) => a.action !== "need_user") && (await waitCheck(step, job, 1500))) return finished();
      history.push(`${did.join(", ") || "nothing"} → ${await outcome(step, job)}`);
    }
    if (waitReturns) return "wait";
    throw new Failed(`Groot couldn't finish "${STEP_WORDS[step]}".`);
  }

  // One step: a learned fix → scripted → Groot → the creator.
  async function doStep(step, job) {
    if (LEARNABLE.has(step)) {
      const ok = await tryLearned(step, job).catch((e) => { if (e && e.stopped) throw e; if (e instanceof Failed) throw e; note(`learned fix error: ${short(e && e.message, 80)}`); return false; });
      if (ok) return undefined;
    }
    try {
      return await SCRIPTED[step](job);
    } catch (e) {
      if (e && e.stopped) throw e;
      if (!(e instanceof StepMissed) || !AI_STEPS.has(step)) throw e;
      log("tiktok step missed", step, e.message);
      notes.push(`missed: ${e.message}`);
      try {
        await askGroot(step, job);
      } catch (ae) {
        if ((ae && ae.stopped) || !(ae instanceof Failed) || ae.code) throw ae;
        log("tiktok ai gave up", step, ae.message);
        // Groot couldn't (or can't be reached): the creator, with plain words.
        await needsYou(step, STEP_HELP[step] || ae.message, { check: CREATOR_CHECK[step] || (CHECK[step] && (() => CHECK[step](job))), fail: STEP_HELP[step] || ae.message });
      }
      // The AI (or the creator) only gets the page ready for the file; attaching it is always ours.
      if (step === "upload") await SCRIPTED.upload(job);
      // The search box found by the AI: the showcase is searched and checked by the script.
      if (step === "product_search") tried.clear();
      return undefined;
    }
  }

  async function run(job) {
    const steps = planSteps(job);
    postId = job.postId;
    loadLearned(job);
    const t0 = Date.now();
    let outcome = "posted";
    let stepStart = t0;
    const finish = (ok, why) => {
      const ms = Date.now() - stepStart;
      const entry = { step: current, ms, ok, how: notes.join("; ").slice(0, 400), ai: stepAi };
      if (why) entry.why = String(why).slice(0, 200);
      trail.push(entry);
      log(ok ? "tiktok step done" : "tiktok step ended", current, secs(ms), entry.how || "", why || "");
    };
    const summary = () => `${trail.map((s) => `${s.step} ${secs(s.ms)}${s.ai ? ` (${s.ai} AI)` : ""}${s.ok ? "" : " (ended here)"}`).join(", ")} · total ${secs(Date.now() - t0)}${learned.used || learned.saved ? ` · learned fixes used ${learned.used}, saved ${learned.saved}` : ""}`;
    try {
      for (const step of steps) {
        current = step;
        notes = [];
        stepAi = 0;
        stepStart = Date.now();
        log("tiktok step start", step, `at ${secs(stepStart - t0)}`);
        say(step);
        const r = await doStep(step, job);
        if (step === "handoff") outcome = r;
        finish(true);
        await page.pause("betweenSteps");
      }
      log("tiktok post timings", outcome, summary());
      say(current, outcome === "posted" ? "Posted" : "Ready for you to post", outcome);
      return { status: outcome, aiSteps: aiUsed, steps: trail, ms: Date.now() - t0, learnedUsed: learned.used, learnedSaved: learned.saved };
    } catch (e) {
      if (e && e.stopped) {
        finish(false, "stopped");
        log("tiktok post timings", "stopped", summary());
        say(current, "Stopped", "stopped");
        return { status: "stopped", aiSteps: aiUsed, step: current, steps: trail, ms: Date.now() - t0, error: `Stopped at "${STEP_WORDS[current] || current}", ${Math.round((Date.now() - t0) / 1000)} s in.` };
      }
      const error = e instanceof Failed || (e && e.needUser) ? e.message : `Something went wrong while ${String(STEP_WORDS[current] || "posting").toLowerCase()}.`;
      const code = e instanceof Failed ? e.code : e && e.needUser ? "login" : null;
      finish(false, e && e.message);
      log("tiktok post failed", current, e && (e.stack || e.message));
      log("tiktok post timings", "failed", summary());
      say(current, error, "failed", code ? { code } : {});
      return { status: "failed", error, code, step: current, steps: trail, ms: Date.now() - t0, aiSteps: aiUsed };
    }
  }

  return { run };
}

module.exports = { createEngine, StepMissed, Failed };
