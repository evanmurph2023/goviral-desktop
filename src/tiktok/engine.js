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
// the page's visible elements and a screenshot go up, ONE action comes back (click / type / press /
// scroll / wait / done / need_user), it is checked again here (rules.js validateAction), done with
// human pacing, and the step checks again. At most MAX_AI_PER_STEP tries a step and
// MAX_AI_PER_POST a post (the server caps it too). The product is never the AI's choice: a row it
// clicks must still match the creator's words (CHECK.product_pick).
// When Groot can't (or can't be reached), the step goes to the creator: "needs you", with plain
// words saying exactly what to do in the TikTok window (rules.js STEP_HELP). Groot watches for it to
// be done and carries on, or gives this video up after TIMEOUTS.creator. Nothing waits silently:
// every wait has a limit (rules.js TIMEOUTS), and the upload waits long only while TikTok shows it
// moving.
//
// Every step logs its start, its end, how long it took, what it used (the selector, Groot, the
// creator) and why it missed; run() returns the whole trail (`steps`) for the app.
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

const { TARGETS, AI_STEPS, STEP_WORDS, STEP_HELP, TIMEOUTS, MAX_AI_PER_STEP, MAX_AI_PER_POST, NOT_IN_SHOWCASE, planSteps, validateAction, captionText, captionParts, normCaption, showcaseList, pickProduct, searchTerms, cleanProductName, productScore, PICK_AT, TIKTOK_UPLOAD_URL } = require("./rules");

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
  async function safeFind(name, value) {
    try { return await page.find(TARGETS[name], value); } catch (e) {
      if (e && e.stopped) throw e;
      if (Date.now() > quietUntil) { quietUntil = Date.now() + 10000; log("tiktok page read failed", current, name, e && e.message); }
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
  async function search(term) {
    tried.add(term.toLowerCase());
    const before = sigOf(await safeRows("productRows"));
    await click("productSearch");
    await page.clearFocused();
    await page.type(term);
    await page.key("Enter");
    const t0 = Date.now();
    const until = t0 + T.results;
    let last = null;
    let rows = [];
    for (;;) {
      await page.sleep(300);
      rows = await safeRows("productRows");
      if (!rows.length && (await visible("productNoResults"))) break;
      const sig = sigOf(rows);
      if (rows.length && sig === last && (sig !== before || Date.now() - t0 > 1500)) break;
      last = sig;
      if (Date.now() > until) break;
    }
    note(`searched "${term}": ${rows.length ? `${rows.length} row(s): ${showcaseList(rows, 4)}` : "no products"} (${secs(Date.now() - t0)})`);
    return rows;
  }
  const noResults = () => visible("productNoResults");

  // The link name TikTok shows after Next. Left exactly as it is, unless TikTok says it has
  // characters it won't take: those come out (emoji and symbols first, then all but letters,
  // numbers and spaces), and nothing else changes.
  async function fixProductName() {
    if (!(await visible("productNameError"))) return true;
    const input = await waitFor("productNameInput", { ms: 3000 });
    if (!input) return false;
    for (const level of [1, 2]) {
      const now = await textOf(input.ref);
      const clean = cleanProductName(now, level);
      if (!clean || clean === now) continue;
      note(`product name level ${level}: ${now.length} → ${clean.length} chars`);
      say("product_name", "Taking out characters TikTok won't take in the product name");
      await page.clickRef(input.ref);
      await page.clearFocused();
      await page.type(clean);
      await page.pause("afterClick");
      if (!(await visible("productNameError"))) return true;
    }
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
      await click("productsOption");
      const next = await waitFor("linkNext", { ms: 3000, enabled: true });
      if (next) { note(`click ${how("linkNext", next)}`); await page.clickRef(next.ref); }
      if (!(await waitFor("productSearch", { ms: T.find }))) throw new StepMissed("productSearch not found");
    },
    async product_search(job) { await search(searchTerms(job.product)[0]); },
    async product_pick(job) {
      const terms = searchTerms(job.product);
      const seen = [];
      for (const term of terms) {
        const rows = tried.has(term.toLowerCase()) ? await safeRows("productRows") : await search(term);
        seen.push(...rows);
        const best = pickProduct(job.product, rows);
        if (best) {
          note(`picked "${short(best.text, 60)}" (score ${best.score.toFixed(2)}, ${rows.length} row(s))`);
          await page.clickRef(best.ref);
          await page.pause("afterClick");
          if (!(await CHECK.product_pick(job))) throw new StepMissed("the picked row didn't show as selected");
          return;
        }
        // nothing on screen at all and no "no products" either: the list moved, not the product
        if (!rows.length && !(await noResults())) throw new StepMissed("no product rows and no 'no products' notice");
      }
      const list = showcaseList(seen);
      if (!list) throw new Failed(`${NOT_IN_SHOWCASE}. TikTok found nothing for ${terms.map((t) => `"${t}"`).join(" or ")}.`, "product_not_found");
      // TikTok showed products, none clearly the creator's: their call, never Groot's guess.
      await needsYou("product_pick", `TikTok's showcase shows ${list}, and none is clearly "${job.product}". Select the right one in the TikTok window, or press Stop.`, {
        check: CREATOR_CHECK.product_pick,
        code: "product_not_found",
        fail: `${NOT_IN_SHOWCASE}. TikTok showed ${list}.`,
      });
    },
    async product_next() {
      await click("productNext", { enabled: true, ms: 5000 });
      await page.pause("afterClick");
    },
    async product_name() {
      // Some accounts skip the name step: on as soon as Add shows (or the box closed) without it.
      const until = Date.now() + 4000;
      for (;;) {
        if (await visible("productNameInput")) break;
        if ((await visible("productAdd")) || !(await visible("dialog"))) { note("no name step"); return; }
        if (Date.now() > until) { note("no name step showed"); return; }
        await page.pause("poll");
      }
      if (!(await fixProductName())) throw new Failed("TikTok wouldn't take the product's link name. Fix it in the TikTok window.", "product_name");
      note("the name stays as TikTok has it");
    },
    async product_add() {
      for (let i = 0; i < 3; i++) {
        const add = await waitFor("productAdd", { ms: 5000 });
        if (!add) break;
        if (add.disabled && !(await fixProductName())) throw new Failed("TikTok wouldn't take the product's link name. Fix it in the TikTok window.", "product_name");
        note(`click ${how("productAdd", add)}`);
        await page.clickRef(add.ref);
        const until = Date.now() + 3000;
        while ((await visible("dialog")) && Date.now() < until) await page.pause("poll");
        if (!(await visible("dialog"))) return;
        // TikTok may only complain about the name once Add is pressed
        if (!(await fixProductName())) throw new Failed("TikTok wouldn't take the product's link name. Fix it in the TikTok window.", "product_name");
      }
      if (await visible("dialog")) throw new StepMissed("the product box didn't close after Add");
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
    product_open: async () => visible("dialog"),
    product_tab: async () => visible("productSearch"),
    product_search: async () => (await safeRows("productRows")).length > 0 || noResults(),
    // the selected row must be the creator's product, whoever clicked it
    product_pick: async (job) => (await safeRows("productSelected")).some((r) => productScore(job.product, r.text) >= PICK_AT),
    product_next: async () => (await visible("productNameInput")) || (await visible("productAdd")) || !(await visible("dialog")),
    product_add: async () => !(await visible("dialog")),
    post: async () => (await isPosted()) || (await visible("postNowDialog")),
    confirm_posted: async () => isPosted(),
  };
  // When the creator does a step: what counts as done (the product they pick is their choice).
  const CREATOR_CHECK = {
    upload: async () => visible("fileInput"), // Groot attaches the file itself once the upload area shows
    product_pick: async () => (await safeRows("productSelected")).length > 0,
    wait_processed: async () => (await CHECK.wait_processed()) || (await isPosted()),
  };

  // ---- the AI fallback ------------------------------------------------------------------------
  // `tries`: how many actions this call may take. `waitReturns`: a "wait" answer goes back to the
  // caller (the upload loop keeps waiting itself) instead of costing more tries.
  async function askGroot(step, job, { tries = MAX_AI_PER_STEP, waitReturns = false } = {}) {
    const history = [];
    const values = [captionText(job.caption, job.hashtags), job.product || ""];
    for (let i = 0; i < tries; i++) {
      if (aiUsed >= MAX_AI_PER_POST) throw new Failed("Groot has tried this one enough.");
      await blockers();
      aiUsed++;
      stepAi++;
      say(step, `${STEP_WORDS[step]} (Groot is taking a look)`, "posting", { ai: true });
      const t0 = Date.now();
      const view = await page.snapshot().catch((e) => { if (e && e.stopped) throw e; return null; });
      if (!view) throw new Failed("Groot couldn't read the page.");
      const screenshot = await page.screenshot().catch(() => null);
      let timer = null;
      const res = await Promise.race([
        Promise.resolve().then(() => groot.nextAction({ postId: job.postId, step, view, screenshot, history })).catch(() => ({ ok: false, error: "Groot couldn't reach GoViral." })),
        new Promise((r) => { timer = setTimeout(() => r({ ok: false, error: `Groot didn't answer in ${Math.round(T.ai / 1000)} s.` }), T.ai); }),
      ]).finally(() => clearTimeout(timer));
      if (!res || !res.ok) { log("tiktok ai unavailable", step, secs(Date.now() - t0), (res && res.error) || ""); throw new Failed((res && res.error) || "Groot couldn't see the page."); }
      const a = validateAction(res.action, view, values);
      const el = a.ref !== undefined && a.ref !== null ? view.elements.find((e) => e.ref === a.ref) : null;
      note(`Groot (${secs(Date.now() - t0)}): ${a.action}${el ? ` ref ${a.ref} "${short(el.name, 40)}"` : ""}${a.action === "need_user" ? ` ${a.reason}: ${a.message}` : ""}`);
      switch (a.action) {
        case "done":
          if (!CHECK[step] || (await CHECK[step](job))) return "done";
          history.push("said done, but the step's check failed");
          break;
        case "need_user":
          if (a.reason === "other") throw new Failed(a.message, step === "product_pick" && a.message.startsWith(NOT_IN_SHOWCASE) ? "product_not_found" : null);
          if (blockerMode === "stop") throw new Failed(a.message, a.reason === "captcha" ? "captcha" : "login");
          say(step, a.message, "needs_you", { reason: a.reason });
          await page.sleep(4000);
          await blockers();
          history.push(`asked the creator (${a.reason})`);
          break;
        case "click":
          if (a.ref !== undefined) await page.clickRef(a.ref); else await page.clickAt(a.x, a.y);
          history.push(a.ref !== undefined ? `clicked ref ${a.ref} (${(el || {}).name || ""})` : `clicked ${Math.round(a.x)},${Math.round(a.y)}`);
          break;
        case "type":
          if (a.ref !== null) await page.clickRef(a.ref);
          if (step === "caption" || step === "product_search") await page.clearFocused();
          await page.type(a.text);
          if (step === "caption") await page.key("Escape").catch(() => {});
          history.push(`typed ${a.text === values[1] ? "the product" : "the caption"}`);
          break;
        case "press": await page.key(a.key); history.push(`pressed ${a.key}`); break;
        case "scroll": await page.scroll(a.dy); history.push(`scrolled ${a.dy}`); break;
        case "wait":
          await page.sleep(a.ms);
          history.push(`waited ${a.ms} ms`);
          if (waitReturns) return CHECK[step] && (await CHECK[step](job)) ? "done" : "wait";
          break;
      }
      if (CHECK[step] && a.action !== "need_user" && (await CHECK[step](job))) return "done";
    }
    if (waitReturns) return "wait";
    throw new Failed(`Groot couldn't finish "${STEP_WORDS[step]}".`);
  }

  // One step: scripted → Groot → the creator.
  async function doStep(step, job) {
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
    const summary = () => `${trail.map((s) => `${s.step} ${secs(s.ms)}${s.ai ? ` (${s.ai} AI)` : ""}${s.ok ? "" : " (ended here)"}`).join(", ")} · total ${secs(Date.now() - t0)}`;
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
      return { status: outcome, aiSteps: aiUsed, steps: trail, ms: Date.now() - t0 };
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
