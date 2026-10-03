// One post, step by step: FAST SCRIPTED STEPS with an AI FALLBACK.
//
// Every step first tries its scripted way (rules.js TARGETS: TikTok Studio's known buttons and
// boxes). When a step cannot find its target in time, or its check fails afterwards, the step asks
// Groot (POST /api/groot-post/next-action): the page's visible elements and a screenshot go up,
// ONE action comes back (click / type / press / scroll / wait / done / need_user), it is checked
// again here (rules.js validateAction), done with human pacing, and the step checks again. At most
// MAX_AI_PER_STEP tries a step and MAX_AI_PER_POST a post (the server caps it too).
//
// Blockers: a captcha or a login page pauses everything, says so in the window's bar and in the
// app, and waits for the creator (Groot never solves a captcha and never types a password).
//
// Pure of Electron: `page` is a CdpPage (or a fake in a test), `groot` is the client for the
// platform, `report` gets progress. Returns { status: posted | ready | failed | stopped, error }.
"use strict";

const { TARGETS, AI_STEPS, STEP_WORDS, MAX_AI_PER_STEP, MAX_AI_PER_POST, planSteps, validateAction, captionText, TIKTOK_UPLOAD_URL } = require("./rules");

class StepMissed extends Error {}
class Failed extends Error {}

const BLOCKER_WAIT_MS = 15 * 60 * 1000;
const PROCESS_WAIT_MS = 15 * 60 * 1000;
const HANDOFF_WATCH_MS = 30 * 60 * 1000;

function createEngine({ page, groot, report = () => {}, uploadUrl = TIKTOK_UPLOAD_URL, timeouts = {}, log = () => {}, handedBack = () => false }) {
  const T = { find: 12000, processed: PROCESS_WAIT_MS, posted: 60000, blocker: BLOCKER_WAIT_MS, handoff: HANDOFF_WATCH_MS, ...timeouts };
  let aiUsed = 0;
  let current = null;

  const say = (step, message, status = "posting", extra = {}) => report({ step, message: message || STEP_WORDS[step] || "", status, ...extra });

  // Wait for a target, checking for blockers while we wait.
  async function waitFor(name, { ms = T.find, value, enabled = false } = {}) {
    const until = Date.now() + ms;
    for (;;) {
      await blockers();
      const hit = await page.find(TARGETS[name], value);
      if (hit && (!enabled || !hit.disabled)) return hit;
      if (Date.now() > until) return null;
      await page.pause("poll");
    }
  }
  const visible = async (name, value) => !!(await page.find(TARGETS[name], value));

  // A captcha or a login page: the creator's turn. Polls until it is gone (or times out).
  async function blockers() {
    const captcha = await page.find(TARGETS.captcha);
    const loginUrl = /\/login(\b|\/|\?|$)/i.test(page.url());
    const login = loginUrl || (await page.find(TARGETS.login));
    if (!captcha && !login) return;
    const reason = captcha ? "captcha" : "login";
    say(current, captcha ? "TikTok wants a quick check that you're human. Do it in the TikTok window, Groot waits." : "Log in to TikTok in the TikTok window. Groot never types your password.", "needs_you", { reason });
    const until = Date.now() + T.blocker;
    for (;;) {
      await page.sleep(1500);
      const still = reason === "captcha" ? await page.find(TARGETS.captcha) : (/\/login(\b|\/|\?|$)/i.test(page.url()) || await page.find(TARGETS.login));
      if (!still) break;
      if (Date.now() > until) throw new Failed(reason === "captcha" ? "TikTok's check wasn't finished in time." : "Not logged in to TikTok.");
    }
    say(current, "Thanks, carrying on.");
    // After a login TikTok may land anywhere: back to the upload page.
    if (reason === "login" && !/tiktokstudio\/upload/.test(page.url())) { await page.goto(uploadUrl); await page.pause("betweenSteps"); }
  }

  async function click(name, opts) {
    const hit = await waitFor(name, opts);
    if (!hit) throw new StepMissed(name);
    await page.clickRef(hit.ref);
    return hit;
  }

  // ---- the scripted steps ---------------------------------------------------------------------
  const SCRIPTED = {
    async open() {
      await page.goto(uploadUrl);
      await page.pause("betweenSteps");
      await blockers();
    },
    async upload(job) {
      const input = await waitFor("fileInput", { ms: T.find * 2 });
      if (!input) throw new StepMissed("fileInput");
      await page.setFiles(input.ref, job.filePath);
    },
    async wait_processed() {
      const until = Date.now() + T.processed;
      for (;;) {
        await blockers();
        if (await visible("uploadFailed")) throw new Failed("TikTok couldn't upload the video.");
        const done = await page.find(TARGETS.uploaded);
        const box = await page.find(TARGETS.captionBox);
        if (done && box) return;
        if (Date.now() > until) throw new StepMissed("uploaded");
        await page.sleep(1500);
      }
    },
    async caption(job) {
      const text = captionText(job.caption, job.hashtags);
      const box = await click("captionBox");
      await page.clearFocused();
      await page.type(text);
      await page.pause("afterClick");
      // TikTok opens a hashtag list while typing: close it so it can't eat the next click.
      if (job.hashtags.length) await page.key("Escape").catch(() => {});
      const now = (await page.textOf(box.ref)) || "";
      if (!now.includes(job.caption.slice(0, 20))) throw new StepMissed("captionCheck");
    },
    async product_open() { await click("addLink"); },
    async product_tab() {
      await click("productsOption");
      const next = await waitFor("linkNext", { ms: 3000 });
      if (next) await page.clickRef(next.ref);
      if (!(await waitFor("productSearch", { ms: T.find }))) throw new StepMissed("productSearch");
    },
    async product_search(job) {
      await click("productSearch");
      await page.clearFocused();
      await page.type(job.product);
      await page.key("Enter");
      await page.sleep(1500);
    },
    async product_pick(job) { await click("productRows", { value: job.product }); },
    async product_confirm() {
      for (let i = 0; i < 4; i++) {
        if (!(await visible("dialog"))) return;
        const b = await waitFor("productConfirm", { ms: 4000, enabled: true });
        if (!b) break;
        await page.clickRef(b.ref);
        await page.pause("betweenSteps");
      }
      if (await visible("dialog")) throw new StepMissed("productConfirm");
    },
    async post() { await click("postButton", { enabled: true, ms: T.find * 2 }); },
    async confirm_posted() {
      const until = Date.now() + T.posted;
      for (;;) {
        await blockers();
        if (/tiktokstudio\/content/.test(page.url()) || (await visible("posted"))) return;
        const now = await page.find(TARGETS.postNow);
        if (now) { await page.clickRef(now.ref); continue; }
        if (Date.now() > until) throw new StepMissed("posted");
        await page.sleep(1200);
      }
    },
    async handoff() {
      say("handoff", "Everything is filled in. Check it and press Post in the TikTok window.", "ready");
      const until = Date.now() + T.handoff;
      for (;;) {
        await page.sleep(2000);
        if (/tiktokstudio\/content/.test(page.url()) || (await visible("posted"))) return "posted";
        if (handedBack() || Date.now() > until) return "ready";
      }
    },
  };

  // After the AI says done (or does something), has the step really happened?
  const CHECK = {
    upload: async () => !(await visible("fileInput")) || (await visible("captionBox")),
    wait_processed: async () => (await visible("uploaded")) && (await visible("captionBox")),
    caption: async (job) => { const b = await page.find(TARGETS.captionBox); return !!b && ((await page.textOf(b.ref)) || "").includes(job.caption.slice(0, 20)); },
    product_tab: async () => visible("productSearch"),
    product_confirm: async () => !(await visible("dialog")),
    post: async () => /tiktokstudio\/content/.test(page.url()) || (await visible("postNow")) || visible("posted"),
    confirm_posted: async () => /tiktokstudio\/content/.test(page.url()) || visible("posted"),
  };

  // ---- the AI fallback ------------------------------------------------------------------------
  async function askGroot(step, job) {
    const history = [];
    const values = [captionText(job.caption, job.hashtags), job.product || ""];
    for (let i = 0; i < MAX_AI_PER_STEP; i++) {
      if (aiUsed >= MAX_AI_PER_POST) throw new Failed("Groot has tried this one enough. Finish it in the TikTok window.");
      await blockers();
      aiUsed++;
      say(step, `${STEP_WORDS[step]} (Groot is taking a look)`, "posting", { ai: true });
      const view = await page.snapshot();
      const screenshot = await page.screenshot();
      const res = await groot.nextAction({ postId: job.postId, step, view, screenshot, history });
      if (!res.ok) throw new Failed(res.error || "Groot couldn't see the page.");
      const a = validateAction(res.action, view, values);
      log("tiktok ai", step, a.action, a.ref !== undefined ? a.ref : "");
      switch (a.action) {
        case "done":
          if (!CHECK[step] || (await CHECK[step](job))) return;
          history.push("said done, but the step's check failed");
          break;
        case "need_user":
          if (a.reason === "other") throw new Failed(a.message);
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
          if (step === "caption" || step === "product_search") await page.clearFocused();
          await page.type(a.text);
          history.push(`typed ${a.text === values[1] ? "the product" : "the caption"}`);
          break;
        case "press": await page.key(a.key); history.push(`pressed ${a.key}`); break;
        case "scroll": await page.scroll(a.dy); history.push(`scrolled ${a.dy}`); break;
        case "wait": await page.sleep(a.ms); history.push(`waited ${a.ms} ms`); break;
      }
      if (CHECK[step] && a.action !== "need_user" && (await CHECK[step](job))) return;
    }
    throw new Failed(`Groot couldn't finish "${STEP_WORDS[step]}". Finish it in the TikTok window.`);
  }

  async function run(job) {
    const steps = planSteps(job);
    let outcome = "posted";
    try {
      for (const step of steps) {
        current = step;
        say(step);
        try {
          const r = await SCRIPTED[step](job);
          if (step === "handoff") outcome = r;
        } catch (e) {
          if (e.stopped) throw e;
          if (!(e instanceof StepMissed) || !AI_STEPS.has(step)) throw e;
          log("tiktok step missed", step, e.message);
          await askGroot(step, job);
          // The AI only gets the page ready for the file; attaching it is always ours.
          if (step === "upload") await SCRIPTED.upload(job);
        }
        await page.pause("betweenSteps");
      }
      say(current, outcome === "posted" ? "Posted" : "Ready for you to post", outcome);
      return { status: outcome, aiSteps: aiUsed };
    } catch (e) {
      if (e && e.stopped) { say(current, "Stopped", "stopped"); return { status: "stopped", aiSteps: aiUsed }; }
      const error = e instanceof Failed || (e && e.needUser) ? e.message : `Something went wrong while ${String(STEP_WORDS[current] || "posting").toLowerCase()}.`;
      log("tiktok post failed", current, e && (e.stack || e.message));
      say(current, error, "failed");
      return { status: "failed", error, step: current, aiSteps: aiUsed };
    }
  }

  return { run };
}

module.exports = { createEngine, StepMissed, Failed };
