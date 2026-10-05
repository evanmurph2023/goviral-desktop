// One Trybe post, step by step: FAST SCRIPTED STEPS with an AI FALLBACK, the same shape as the
// TikTok engine (engine.js) and the same page (page.js: real mouse and keys over CDP, page scripts
// in an isolated world). The rules and the targets are in trybe.js.
//
// Drew's walk (2026-10-05): Trybe's creator portal → My brands → the brand → Create content →
// Single submission → the video → the caption → Submit → Trybe's confirmation (its submission id
// when the page shows one). A brand the creator doesn't have stops THAT video ("That brand isn't
// in your Trybe brands"); the run carries on with the others.
//
// Every step first tries its scripted way. When a step cannot find its target in time, or its
// check fails, it asks Groot (the platform's next-action, with platform "trybe"): ONE checked action
// at a time (rules.js validateAction), at most MAX_AI_PER_STEP a step and MAX_AI_PER_POST a post.
// The brand is never the AI's choice: a brand page it opens must still carry the creator's words.
//
// Blockers: a captcha or Trybe's sign-in page. "wait" (the desktop): the creator handles it in the
// Trybe window, Groot waits (never solves a captcha, never types a password). "stop" (the cloud
// poster): the post ends at once with code "captcha" / "login"; Trybe limiting the account ends it
// with "rate_limited" in both modes.
//
// Never touched: Trybe's content-rights / terms boxes, product categories, angles. When Submit stays
// off until one is chosen, that is the creator's call: "stop" ends with "terms" / "form_incomplete",
// "wait" asks the creator in the bar and carries on once Submit is on.
//
// Returns { status: posted | ready | failed | stopped, error, code, step, aiSteps, submissionId,
// confirmation, url }.
"use strict";

const { MAX_AI_PER_STEP, MAX_AI_PER_POST, validateAction } = require("./rules");
const { TRYBE_TARGETS: TARGETS, TRYBE_AI_STEPS, TRYBE_STEP_WORDS, NOT_IN_BRANDS, TRYBE_ORIGIN, isTrybeLoginUrl, brandIdOf, pickBrand, brandMatches, submissionIdFrom, planTrybeSteps, trybeCaption, brandSearchTerms } = require("./trybe");
const { StepMissed, Failed } = require("./engine");

const BLOCKER_WAIT_MS = 15 * 60 * 1000;
const PROCESS_WAIT_MS = 15 * 60 * 1000;
const HANDOFF_WATCH_MS = 30 * 60 * 1000;

// Runs in the isolated world: what says "submitted" right now (texts and submission links), to
// compare with what was there before Submit (a brand page can list older "In review" videos).
const SUBMIT_STATE = function (arg) {
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  const re = new RegExp(arg.text, "i");
  const own = (el) => (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim();
  const all = [...document.querySelectorAll(arg.within)].filter((el) => visible(el) && re.test(own(el)));
  const texts = all.filter((el) => !all.some((o) => o !== el && el.contains(o))).map((el) => own(el).slice(0, 200));
  const links = [...document.querySelectorAll(arg.links)].map((a) => a.href).slice(0, 50);
  return { texts, links, url: location.href };
};
// Runs in the isolated world: the words at the top of the page (the brand's own page names it).
const PAGE_HEAD = function () { const m = document.querySelector("main") || document.body; return (m.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400); };

function createTrybeEngine({ page, groot, report = () => {}, baseUrl = TRYBE_ORIGIN, timeouts = {}, log = () => {}, handedBack = () => false, blockerMode = "wait" }) {
  const T = { find: 12000, results: 6000, processed: PROCESS_WAIT_MS, posted: 60000, blocker: BLOCKER_WAIT_MS, handoff: HANDOFF_WATCH_MS, ...timeouts };
  const homeUrl = `${String(baseUrl).replace(/\/+$/, "")}/creator`;
  let aiUsed = 0;
  let current = null;
  let before = null;     // what said "submitted" before Submit
  let receipt = null;    // { submissionId, confirmation, url }

  const say = (step, message, status = "posting", extra = {}) => report({ step, message: message || TRYBE_STEP_WORDS[step] || "", status, platform: "trybe", ...extra });
  const find = (name, value) => page.find(TARGETS[name], value);
  const visible = async (name, value) => !!(await find(name, value));

  async function waitFor(name, { ms = T.find, value, enabled = false } = {}) {
    const until = Date.now() + ms;
    for (;;) {
      await blockers();
      const hit = await find(name, value);
      if (hit && (!enabled || !hit.disabled)) return hit;
      if (Date.now() > until) return null;
      await page.pause("poll");
    }
  }

  // ---- blockers ------------------------------------------------------------------------------
  const loggedOut = async () => isTrybeLoginUrl(page.url()) || (await visible("login"));
  async function blockers() {
    const captcha = await find("captcha");
    const login = !captcha && (await loggedOut());
    if (await visible("rateLimit")) throw new Failed("Trybe is limiting this account right now.", "rate_limited");
    if (!captcha && !login) return;
    if (blockerMode === "stop") {
      if (captcha) throw new Failed("Trybe wants a security check.", "captcha");
      throw new Failed("Trybe signed GoViral out.", "login");
    }
    const reason = captcha ? "captcha" : "login";
    say(current, captcha ? "Trybe wants a quick check that you're human. Do it in the Trybe window, Groot waits." : "Sign in to Trybe in the Trybe window. Groot never types your password.", "needs_you", { reason });
    const until = Date.now() + T.blocker;
    for (;;) {
      await page.sleep(1500);
      const still = reason === "captcha" ? await find("captcha") : await loggedOut();
      if (!still) break;
      if (Date.now() > until) throw new Failed(reason === "captcha" ? "Trybe's check wasn't finished in time." : "Not signed in to Trybe.");
    }
    say(current, "Thanks, carrying on.");
    // after a sign-in Trybe lands on its home: the walk starts again from there
    if (reason === "login" && !/\/creator/.test(page.url())) { await page.goto(homeUrl); await page.pause("betweenSteps"); }
  }

  async function click(name, opts) {
    const hit = await waitFor(name, opts);
    if (!hit) throw new StepMissed(name);
    await page.clickRef(hit.ref);
    return hit;
  }

  // ---- the brand -------------------------------------------------------------------------------
  let sawBrands = false;
  async function onBrandPage(job) {
    if (!brandIdOf(page.url())) return false;
    const title = await find("brandTitle", job.brand);
    if (title && brandMatches(job.brand, title.text)) return true;
    return brandMatches(job.brand, (await page.run(PAGE_HEAD).catch(() => "")) || "");
  }
  // The brand links on screen now: the creator's brand → its page.
  async function openBrandFrom(job) {
    const rows = await page.rows(TARGETS.brandLinks);
    if (rows.length) sawBrands = true;
    const best = pickBrand(job.brand, rows);
    if (!best) return false;
    log("trybe brand", `picked ${best.ref} of ${rows.length}`, `score ${best.score.toFixed(2)}`);
    await page.clickRef(best.ref);
    const until = Date.now() + T.find;
    while (!brandIdOf(page.url()) && Date.now() < until) await page.sleep(300);
    await page.pause("betweenSteps");
    if (!(await onBrandPage(job))) throw new StepMissed("brandPage");
    return true;
  }
  async function searchBrands(job) {
    const box = await waitFor("brandSearch", { ms: 2500 });
    if (!box) return false;
    for (const term of brandSearchTerms(job.brand)) {
      await page.clickRef(box.ref);
      await page.clearFocused();
      await page.type(term);
      await page.sleep(900);
      if (await openBrandFrom(job)) return true;
      if (await visible("brandNoResults")) sawBrands = true;
    }
    return false;
  }

  // ---- what says "submitted" -------------------------------------------------------------------
  const submitState = () => page.run(SUBMIT_STATE, { text: TARGETS.submitted[0].text, within: TARGETS.submitted[0].within, links: TARGETS.submissionLinks[0].css }).catch(() => ({ texts: [], links: [], url: page.url() }));
  async function submittedSince(base) {
    const now = await submitState();
    const b = base || { texts: [], links: [], url: "" };
    const texts = now.texts.filter((t) => !b.texts.includes(t));
    const links = now.links.filter((l) => !b.links.includes(l));
    const urlId = submissionIdFrom({ url: now.url });
    if (!texts.length && !links.length && !(urlId && now.url !== b.url)) return null;
    return { submissionId: submissionIdFrom({ url: now.url, links, text: texts.join(" ") }), confirmation: texts[0] || null, url: now.url };
  }

  // The creator's call (a terms box, a required category): stop, or ask them and wait for Submit.
  async function creatorsCall(code) {
    const msg = code === "terms" ? "Trybe wants its content terms ticked for this video. That's yours to do: finish it in Manual." : "Trybe wants more details for this video (like a category). That's yours to choose: finish it in Manual.";
    if (blockerMode === "stop") throw new Failed(msg, code);
    say(current, code === "terms" ? "Tick Trybe's terms box yourself in the Trybe window, then Groot submits." : "Pick what Trybe asks for in the Trybe window, then Groot submits.", "needs_you", { reason: "other" });
    const until = Date.now() + T.blocker;
    for (;;) {
      await page.sleep(1500);
      const btn = await find("submitButton");
      if (btn && !btn.disabled) return btn;
      if (Date.now() > until) throw new Failed(msg, code);
    }
  }

  // ---- the scripted steps ---------------------------------------------------------------------
  const SCRIPTED = {
    async trybe_open() {
      await page.goto(homeUrl);
      await page.pause("betweenSteps");
      // Trybe checks the sign-in after the page loads: wait for the portal (or the sign-in page).
      const until = Date.now() + Math.min(T.find, 8000);
      for (;;) {
        await blockers();
        if ((await page.rows(TARGETS.brandLinks)).length || (await visible("brandsNav")) || (await visible("createContent"))) return;
        if (Date.now() > until) return;
        await page.pause("poll");
      }
    },
    async trybe_brand(job) {
      if (await onBrandPage(job)) return;
      if (await openBrandFrom(job)) return;
      // not on Home: "View all", then the Brands page, each with its search
      for (const way of ["viewAllBrands", "brandsNav"]) {
        const t = await waitFor(way, { ms: 3000 });
        if (!t) continue;
        await page.clickRef(t.ref);
        await page.pause("betweenSteps");
        if (await openBrandFrom(job)) return;
        if (await searchBrands(job)) return;
        if (await visible("brandNoResults")) sawBrands = true;
        await page.key("Escape").catch(() => {});
      }
      if (sawBrands) throw new Failed(NOT_IN_BRANDS, "brand_not_found");
      throw new StepMissed("brandLinks");
    },
    async trybe_create() {
      const btn = await waitFor("createContent", { ms: T.find });
      if (btn) await page.clickRef(btn.ref);
      else if (brandIdOf(page.url())) {
        // Trybe's own link for it (the sidebar's Create Content): <brand page>?createContent=true
        const u = new URL(page.url());
        u.search = "?createContent=true";
        log("trybe create", "button not found, Trybe's createContent link");
        await page.goto(u.toString());
      } else throw new StepMissed("createContent");
      await page.pause("betweenSteps");
      if (!(await CHECK.trybe_create())) {
        const until = Date.now() + T.find;
        while (!(await CHECK.trybe_create())) { if (Date.now() > until) throw new StepMissed("createDialog"); await page.pause("poll"); }
      }
    },
    async trybe_single() {
      const single = await waitFor("singleSubmission", { ms: 5000 });
      if (single) {
        await page.clickRef(single.ref);
        await page.pause("afterClick");
        const next = await waitFor("choiceNext", { ms: 2000, enabled: true });
        if (next) await page.clickRef(next.ref);
      } else if (!(await find("fileInput"))) throw new StepMissed("singleSubmission");
      if (!(await waitFor("fileInput", { ms: T.find }))) throw new StepMissed("fileInput");
    },
    async trybe_upload(job) {
      const input = await waitFor("fileInput", { ms: T.find });
      if (!input) throw new StepMissed("fileInput");
      await page.setFiles(input.ref, job.filePath);
    },
    async trybe_wait() {
      const until = Date.now() + T.processed;
      for (;;) {
        await blockers();
        if (await visible("uploadFailed")) throw new Failed("Trybe couldn't upload the video.", "upload_failed");
        if (await CHECK.trybe_wait()) return;
        if (Date.now() > until) throw new StepMissed("uploaded");
        await page.sleep(1500);
      }
    },
    async trybe_caption(job) {
      const text = trybeCaption(job.caption, job.hashtags);
      if (!text) return;
      const box = await click("captionBox");
      await page.clearFocused();
      await page.type(text);
      await page.pause("afterClick");
      const now = (await page.textOf(box.ref)) || "";
      if (!now.includes(text.slice(0, 20))) throw new StepMissed("captionCheck");
    },
    async trybe_submit() {
      let btn = await waitFor("submitButton", { ms: T.find * 2 });
      if (!btn) throw new StepMissed("submitButton");
      if (btn.disabled) btn = (await waitFor("submitButton", { ms: 8000, enabled: true })) || btn;
      if (btn.disabled) {
        if (await visible("terms")) btn = await creatorsCall("terms");
        else if (await visible("required")) btn = await creatorsCall("form_incomplete");
        else throw new StepMissed("submitEnabled");
      }
      before = await submitState();
      await page.clickRef(btn.ref);
    },
    async trybe_confirm() {
      const until = Date.now() + T.posted;
      let confirmed = false;
      for (;;) {
        await blockers();
        const got = await submittedSince(before);
        if (got) { receipt = got; return; }
        // "Submit this video?" once, inside a dialog (never Submit twice)
        if (!confirmed) { const c = await find("confirmDialog"); if (c) { confirmed = true; await page.clickRef(c.ref); continue; } }
        if (await visible("uploadFailed")) throw new Failed("Trybe couldn't take the video.", "upload_failed");
        if (Date.now() > until) throw new StepMissed("submitted");
        await page.sleep(1200);
      }
    },
    async handoff() {
      say("handoff", "Everything is filled in. Check it and press Submit in the Trybe window.", "ready");
      const base = await submitState();
      const until = Date.now() + T.handoff;
      for (;;) {
        await page.sleep(2000);
        const got = await submittedSince(base);
        if (got) { receipt = got; return "posted"; }
        if (handedBack() || Date.now() > until) return "ready";
      }
    },
  };

  // After the AI says done (or does something), has the step really happened?
  const CHECK = {
    trybe_brand: async (job) => onBrandPage(job),
    trybe_create: async () => (await visible("singleSubmission")) || (await visible("dialog")),
    trybe_single: async () => !!(await find("fileInput")),
    trybe_upload: async () => !!(await find("fileInput")),
    trybe_wait: async () => !(await visible("uploading")) && ((await visible("uploaded")) || !!(await find("submitButton").then((b) => b && !b.disabled))),
    // the caption is in a box, or the form has no box for one at all
    trybe_caption: async (job) => {
      const b = await find("captionBox");
      if (!b) return true;
      return ((await page.textOf(b.ref)) || "").includes(trybeCaption(job.caption, job.hashtags).slice(0, 20));
    },
    trybe_submit: async () => !!(await submittedSince(before)) || (await visible("confirmDialog")),
    trybe_confirm: async () => { const got = await submittedSince(before); if (got) receipt = got; return !!got; },
  };

  // ---- the AI fallback ------------------------------------------------------------------------
  async function askGroot(step, job) {
    const history = [];
    const values = [trybeCaption(job.caption, job.hashtags), job.brand || ""];
    if (step === "trybe_submit" && !before) before = await submitState();
    for (let i = 0; i < MAX_AI_PER_STEP; i++) {
      if (aiUsed >= MAX_AI_PER_POST) throw new Failed("Groot has tried this one enough. Finish it in the Trybe window.");
      await blockers();
      aiUsed++;
      say(step, `${TRYBE_STEP_WORDS[step]} (Groot is taking a look)`, "posting", { ai: true });
      const view = await page.snapshot();
      const screenshot = await page.screenshot();
      const res = await groot.nextAction({ postId: job.postId, platform: "trybe", brand: job.brand || null, step, view, screenshot, history });
      if (!res.ok) throw new Failed(res.error || "Groot couldn't see the page.");
      const a = validateAction(res.action, view, values);
      log("trybe ai", step, a.action, a.ref !== undefined ? a.ref : "");
      switch (a.action) {
        case "done":
          if (!CHECK[step] || (await CHECK[step](job))) return;
          history.push("said done, but the step's check failed");
          break;
        case "need_user":
          if (a.reason === "other") throw new Failed(a.message, a.message === NOT_IN_BRANDS || a.message === `${NOT_IN_BRANDS}.` ? "brand_not_found" : null);
          if (blockerMode === "stop") throw new Failed(a.message, a.reason === "captcha" ? "captcha" : "login");
          say(step, a.message, "needs_you", { reason: a.reason });
          await page.sleep(4000);
          await blockers();
          history.push(`asked the creator (${a.reason})`);
          break;
        case "click":
          if (a.ref !== undefined) await page.clickRef(a.ref); else await page.clickAt(a.x, a.y);
          history.push(a.ref !== undefined ? `clicked ref ${a.ref} (${(view.elements.find((e) => e.ref === a.ref) || {}).name || ""})` : `clicked ${Math.round(a.x)},${Math.round(a.y)}`);
          break;
        case "type":
          if (a.ref !== null) await page.clickRef(a.ref);
          if (step === "trybe_caption" || step === "trybe_brand") await page.clearFocused();
          await page.type(a.text);
          history.push(`typed ${a.text === values[1] ? "the brand" : "the caption"}`);
          break;
        case "press": await page.key(a.key); history.push(`pressed ${a.key}`); break;
        case "scroll": await page.scroll(a.dy); history.push(`scrolled ${a.dy}`); break;
        case "wait": await page.sleep(a.ms); history.push(`waited ${a.ms} ms`); break;
      }
      if (CHECK[step] && a.action !== "need_user" && (await CHECK[step](job))) return;
    }
    throw new Failed(`Groot couldn't finish "${TRYBE_STEP_WORDS[step]}". Finish it in the Trybe window.`);
  }

  async function run(job) {
    const steps = planTrybeSteps(job);
    let outcome = "posted";
    try {
      if (!job.brand) throw new Failed("Which Trybe brand is this for?", "brand_missing");
      for (const step of steps) {
        current = step;
        say(step);
        try {
          const r = await SCRIPTED[step](job);
          if (step === "handoff") outcome = r;
        } catch (e) {
          if (e.stopped) throw e;
          if (!(e instanceof StepMissed) || !TRYBE_AI_STEPS.has(step)) throw e;
          log("trybe step missed", step, e.message);
          await askGroot(step, job);
          // The AI only gets the form ready for the file; attaching it is always ours.
          if (step === "trybe_upload") await SCRIPTED.trybe_upload(job);
        }
        await page.pause("betweenSteps");
      }
      const r = receipt || {};
      say(current, outcome === "posted" ? `Sent to ${job.brand} on Trybe` : "Ready for you to submit", outcome, r.submissionId ? { submissionId: r.submissionId } : {});
      return { status: outcome, aiSteps: aiUsed, submissionId: r.submissionId || null, confirmation: r.confirmation || null, url: r.url || null };
    } catch (e) {
      if (e && e.stopped) { say(current, "Stopped", "stopped"); return { status: "stopped", aiSteps: aiUsed }; }
      const error = e instanceof Failed || (e && e.needUser) ? e.message : `Something went wrong while ${String(TRYBE_STEP_WORDS[current] || "posting").toLowerCase()}.`;
      const code = e instanceof Failed ? e.code : e && e.needUser ? "login" : null;
      log("trybe post failed", current, e && (e.stack || e.message));
      say(current, error, "failed", code ? { code } : {});
      return { status: "failed", error, code, step: current, aiSteps: aiUsed };
    }
  }

  return { run };
}

module.exports = { createTrybeEngine };
