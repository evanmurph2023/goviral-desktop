// Groot READS the creator's accounts (2026-10-05): Trybe's brands, one brand's page, TikTok
// Studio's recent posts. The same page as posting (page.js: real mouse over CDP, page scripts in an
// isolated world), the same blockers, the same AI fallback; the rules and the parsers are in
// reads.js. The desktop runs it in the creator's own TikTok / Trybe window (blockerMode "wait": a
// sign-in or a captcha is theirs, Groot waits); the cloud poster in its own browser ("stop": the
// read ends with "login" / "captcha" / "rate_limited" | "spam").
//
// NAVIGATION AND READING ONLY. Groot goes to Trybe's / TikTok's own list pages by address, and the
// only things it presses are "View all", "Load more" / "Show more" / "Read more", a next-page
// arrow and tabs, each checked by reads.js isSafeToPress first; the AI fallback is held to the same
// rule (validateReadAction). Nothing that submits, applies, joins, accepts or changes data.
//
// The pages are read with a resilient DOM-to-text pass (DUMP): every visible text in the page's
// main area in reading order, grouped by block, marked heading / bold label / list item /
// paragraph, with its link; reads.js turns that into the brief, the do's and don'ts and the rest
// by the headings' words, and keeps the whole text for the brain. When the words find nothing,
// the AI fallback (a "read_*" step on the platform's next-action) opens what hides it, then the
// page is read again. An AI that can't help leaves a partial result, never a crash.
//
// run({ readId, read, params }) → { status: done | failed | stopped, result, partial, error, code,
// step, aiSteps }.
"use strict";

const { TARGETS: TT } = require("./rules");
const { TRYBE_TARGETS, TRYBE_ORIGIN, NOT_IN_BRANDS, isTrybeLoginUrl, brandIdOf } = require("./trybe");
const { StepMissed, Failed } = require("./engine");
const R = require("./reads");

const BLOCKER_WAIT_MS = 15 * 60 * 1000;
const MAX_PAGES = 12;

// ---- page scripts (the isolated world) --------------------------------------------------------------
// The page as text blocks: { url, title, blocks: [{ t: h | b | li | p, level, text, href }] }.
const DUMP = function (arg) {
  const dialogs = arg.dialog ? [...document.querySelectorAll("[role=dialog], dialog[open]")] : [];
  const root = dialogs[dialogs.length - 1] || document.querySelector("main, [role=main]") || document.body;
  const SKIP = `script, style, noscript, template, svg, nav, aside, footer, button, select, option, input, textarea, [role=button], [role=tab], [role=tablist], [role=menu], [role=navigation], [aria-hidden=true], [hidden]${arg.dialog ? "" : ", [role=dialog], dialog"}`;
  const HEAD = "h1, h2, h3, h4, h5, h6, [role=heading], dt, legend, th, summary";
  const INLINE = /^(inline|inline-block|inline-flex|inline-grid|contents)$/;
  const css = new Map();
  const st = (el) => { let s = css.get(el); if (!s) { s = getComputedStyle(el); css.set(el, s); } return s; };
  const shown = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const s = st(e); if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false; } return true; };
  const blockOf = (el) => { let e = el; while (e && e !== root && INLINE.test(st(e).display)) e = e.parentElement; return e || root; };
  const out = [];
  let last = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && out.length < arg.max; n = walker.nextNode()) {
    const raw = n.nodeValue;
    if (!raw || !raw.trim()) continue;
    const p = n.parentElement;
    if (!p || p.closest(SKIP) || !shown(p)) continue;
    const b = blockOf(p);
    const text = raw.replace(/\s+/g, " ").trim();
    const a = p.closest("a[href]");
    if (last && last.el === b) { last.text += (/^[,.;:!?)]/.test(text) ? "" : " ") + text; if (!last.href && a) last.href = a.href; continue; }
    let t = "p";
    let level = 0;
    const h = b.closest(HEAD);
    if (h && root.contains(h)) { t = "h"; const m = /^H([1-6])$/.exec(h.tagName); level = m ? Number(m[1]) : Number(h.getAttribute("aria-level")) || 4; }
    else if (b.closest("li, [role=listitem]")) t = "li";
    else if (Number(st(b).fontWeight) >= 600 || p.closest("strong, b")) { t = "b"; level = 6; }
    last = { el: b, t, level, text, href: a ? a.href : null };
    out.push(last);
  }
  const blocks = out.map((x) => ({ t: x.t === "b" && (x.text.length > 70 || /[.!?]$/.test(x.text)) ? "p" : x.t, level: x.level, text: x.text.slice(0, 1200), href: x.href }));
  return { url: location.href, title: document.title, blocks };
};
// The brand cards on screen: one per brand link, the card around it (its logo, its other words).
const BRAND_CARDS = function (arg) {
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none"; };
  const idOf = (href) => { try { const m = /\/creator\/brands\/([^/?#]+)/.exec(new URL(href, location.href).pathname); return m ? m[1] : null; } catch { return null; } };
  const sel = 'a[href*="/creator/brands/"]';
  const scope = arg.dialog ? document.querySelector("[role=dialog]") || document : document;
  const out = [];
  const seen = new Set();
  for (const a of scope.querySelectorAll(sel)) {
    const id = idOf(a.href);
    if (!id || seen.has(id) || !visible(a) || /createContent/i.test(a.href)) continue;
    seen.add(id);
    let card = a;
    for (let i = 0; i < 4 && card.parentElement && card.parentElement !== document.body; i++) {
      const others = [...card.parentElement.querySelectorAll(sel)].some((x) => idOf(x.href) !== id);
      if (others) break;
      card = card.parentElement;
    }
    const lines = (card.innerText || "").split("\n").map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
    const named = a.querySelector("h1, h2, h3, h4, h5, [class*=name i], [class*=title i]") || card.querySelector("h1, h2, h3, h4, h5, [class*=name i], [class*=title i]");
    const img = card.querySelector("img");
    out.push({ href: a.href, name: ((named && named.innerText) || a.getAttribute("aria-label") || (a.innerText || "").split("\n").map((t) => t.trim()).find(Boolean) || "").replace(/\s+/g, " ").trim(), lines, img: img ? img.currentSrc || img.src || null : null });
    if (out.length >= arg.max) break;
  }
  return out;
};
// TikTok Studio's posts: one row per video link, the row around it (its caption, date, numbers).
const POST_ROWS = function (arg) {
  const idOf = (href) => { const m = /\/video\/(\d{6,25})/.exec(href || ""); return m ? m[1] : null; };
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const rows = new Map();
  for (const a of document.querySelectorAll('a[href*="/video/"]')) {
    const id = idOf(a.href);
    if (!id) continue;
    if (rows.has(id)) { const r = rows.get(id); if (!r.linkText) r.linkText = clean(a.innerText || a.getAttribute("aria-label")).slice(0, 400); continue; }
    let row = a.closest('tr, li, [role=row], [data-e2e*="post-item" i], [data-tt*="row" i], article');
    if (!row) {
      row = a;
      for (let i = 0; i < 6 && row.parentElement && row.parentElement !== document.body; i++) {
        const ids = new Set([...row.parentElement.querySelectorAll('a[href*="/video/"]')].map((x) => idOf(x.href)).filter(Boolean));
        if (ids.size > 1) break;
        row = row.parentElement;
      }
    }
    const q = (s) => { const e = row.querySelector(s); return e ? clean(e.innerText || e.getAttribute("aria-label")).slice(0, 400) : ""; };
    const t = row.querySelector("time");
    const v = row.querySelector('[data-e2e*="view" i], [aria-label*="view" i], [title*="view" i], [class*="view" i], [class*="play-count" i]');
    const vt = v ? clean(v.innerText) : "";
    rows.set(id, {
      href: a.href,
      linkText: clean(a.innerText || a.getAttribute("aria-label")).slice(0, 400),
      caption: q('[data-e2e*="caption" i], [data-e2e*="desc" i], [data-e2e*="title" i], [class*="caption" i], [class*="desc" i], [class*="title" i]'),
      date: t ? clean(t.getAttribute("datetime") || t.innerText) : q('[data-e2e*="date" i], [data-e2e*="time" i], [class*="date" i], [class*="time" i]'),
      views: /\d/.test(vt) ? vt : v ? clean(v.getAttribute("aria-label") || v.getAttribute("title")) : "",
      lines: (row.innerText || "").split("\n").map(clean).filter(Boolean).slice(0, 20),
    });
    if (rows.size >= arg.max) break;
  }
  return [...rows.values()];
};
// Is the page still loading its content (a client-rendered portal): any words in the main area yet?
const MAIN_WORDS = function () { const m = document.querySelector("main, [role=main]") || document.body; return (m.innerText || "").replace(/\s+/g, " ").trim().length; };
// The last item of a list: where the mouse wheel goes (the list may scroll inside its own box), and
// how far the page and that box have scrolled.
const LIST_END = function (arg) {
  const all = [...document.querySelectorAll(arg.css)];
  const el = all[all.length - 1];
  if (!el) return null;
  let box = el.parentElement;
  while (box && box !== document.body && !(box.scrollHeight > box.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  const r = el.getBoundingClientRect();
  return { x: Math.max(5, Math.min(innerWidth - 5, r.left + Math.min(r.width, 200) / 2)), y: Math.max(5, Math.min(innerHeight - 5, r.top + r.height / 2)), pos: window.scrollY + (box && box !== document.body ? box.scrollTop : 0) };
};

function createReadEngine({ page, groot, report = () => {}, trybeBase = TRYBE_ORIGIN, tiktokBase = "https://www.tiktok.com", timeouts = {}, log = () => {}, blockerMode = "wait", now = () => Date.now() }) {
  const T = { find: 12000, settle: 10000, blocker: BLOCKER_WAIT_MS, ...timeouts };
  const trybeRoot = String(trybeBase).replace(/\/+$/, "");
  const tiktokRoot = String(tiktokBase).replace(/\/+$/, "");
  let aiUsed = 0;
  let platform = null;
  let current = null;
  let readId = null;
  let names = []; // a brand name the AI may type, and whose words may be in a label it presses

  const say = (step, message, status = "reading", extra = {}) => report({ step, message: message || R.READ_STEP_WORDS[step] || "", status, platform, read: true, ...extra });
  const find = (ways, value) => page.find(ways, value);

  // ---- blockers (as posting: a captcha, the sign-in page, the platform limiting the account) -------
  const loggedOut = async () => (platform === "trybe" ? isTrybeLoginUrl(page.url()) || !!(await find(TRYBE_TARGETS.login)) : /\/login(\b|\/|\?|$)/i.test(page.url()) || !!(await find(TT.login)));
  const captchaOn = async () => !!(await find(platform === "trybe" ? TRYBE_TARGETS.captcha : TT.captcha));
  async function blockers(back) {
    const captcha = await captchaOn();
    const login = !captcha && (await loggedOut());
    if (!captcha && !login) {
      if (platform === "trybe" && (await find(TRYBE_TARGETS.rateLimit))) throw new Failed("Trybe is limiting this account right now.", "rate_limited");
      if (platform === "tiktok" && (await find(TT.spam))) throw new Failed("TikTok is limiting this account right now.", "spam");
      return;
    }
    const name = platform === "trybe" ? "Trybe" : "TikTok";
    if (blockerMode === "stop") throw new Failed(captcha ? `${name} wants a security check.` : `${name} signed GoViral out.`, captcha ? "captcha" : "login");
    const reason = captcha ? "captcha" : "login";
    say(current, captcha ? `${name} wants a quick check that you're human. Do it in the ${name} window, Groot waits.` : `Sign in to ${name} in the ${name} window. Groot never types your password.`, "needs_you", { reason });
    const until = Date.now() + T.blocker;
    for (;;) {
      await page.sleep(1500);
      const still = reason === "captcha" ? await captchaOn() : await loggedOut();
      if (!still) break;
      if (Date.now() > until) throw new Failed(reason === "captcha" ? `${name}'s check wasn't finished in time.` : `Not signed in to ${name}.`, reason);
    }
    say(current, "Thanks, carrying on.");
    if (back) { await page.goto(back); await page.pause("betweenSteps"); }
  }

  // Open one of the platform's own pages by its address, then wait until it has drawn (or a blocker).
  async function open(url, ready) {
    await page.goto(url);
    await page.pause("betweenSteps");
    return settle(url, ready);
  }
  async function settle(back, ready) {
    const until = Date.now() + T.settle;
    for (;;) {
      await blockers(back);
      if (await ready()) return true;
      if (Date.now() > until) return false;
      await page.pause("poll");
    }
  }
  // Press a target only when its words are safe (reads.js): View all, Load more, a tab, a next arrow.
  async function press(hit) {
    if (!hit || hit.disabled || !R.isSafeToPress(hit.text, names)) { if (hit) log("read refused to press", hit.text); return false; }
    await page.clickRef(hit.ref);
    return true;
  }

  // ---- the AI fallback (navigation only) ----------------------------------------------------------
  async function askGroot(step, check) {
    const history = [];
    for (let i = 0; i < R.MAX_AI_PER_READ_STEP; i++) {
      if (aiUsed >= R.MAX_AI_PER_READ) return false;
      await blockers();
      aiUsed++;
      say(step, `${R.READ_STEP_WORDS[step]} (Groot is taking a look)`, "reading", { ai: true });
      const view = await page.snapshot();
      const screenshot = await page.screenshot();
      const res = await groot.nextAction({ postId: readId, platform, step, view, screenshot, history, read: true, ...(names[0] ? { brand: names[0] } : {}) }).catch(() => null);
      if (!res || !res.ok) { log("read ai unavailable", step, res && res.error); return false; }
      const a = R.validateReadAction(res.action, view, names, names);
      log("read ai", step, a.action, a.ref !== undefined ? a.ref : "");
      switch (a.action) {
        case "done": return check();
        case "need_user":
          if (a.reason === "captcha" || a.reason === "login") { await blockers(); history.push(`asked the creator (${a.reason})`); break; }
          log("read ai gave up", a.message);
          return false;
        case "click": await page.clickRef(a.ref); history.push(`clicked ref ${a.ref} (${(view.elements.find((e) => e.ref === a.ref) || {}).name || ""})`); break;
        case "type": if (a.ref !== null) await page.clickRef(a.ref); await page.clearFocused(); await page.type(a.text); history.push("typed the brand"); break;
        case "press": await page.key(a.key); history.push(`pressed ${a.key}`); break;
        case "scroll": await page.scroll(a.dy); history.push(`scrolled ${a.dy}`); break;
        case "wait": await page.sleep(a.ms); history.push(`waited ${a.ms} ms`); break;
      }
      await page.pause("afterClick");
      if (await check()) return true;
    }
    return false;
  }

  // ---- Trybe: the brands ----------------------------------------------------------------------------
  const brandCards = (dialog = false) => page.run(BRAND_CARDS, { max: 200, dialog }).then((r) => r || []).catch(() => []);
  // Every page of a list: "Load more", the next-page arrow, or scrolling for more.
  async function paged(collect, limit, { css } = {}) {
    const all = new Map();
    const add = (items) => { let n = 0; for (const it of items) if (!all.has(it.key)) { all.set(it.key, it); n++; } return n; };
    add(await collect());
    let quiet = 0;
    for (let i = 0; i < MAX_PAGES && all.size < limit; i++) {
      current = "read_more";
      const more = await find(R.READ_TARGETS.loadMore);
      const next = !more && (await find(R.READ_TARGETS.nextPage));
      let moved = false;
      if (more) moved = await press(more);
      else if (next && !next.disabled) moved = await press(next);
      else if (css) {
        // the mouse wheel over the list (real input, as a person scrolls), then: did it move?
        const a = await page.run(LIST_END, { css }).catch(() => null);
        if (a) page.mouse = { x: a.x, y: a.y };
        await page.scroll(1400);
        await page.sleep(400);
        const b = await page.run(LIST_END, { css }).catch(() => null);
        moved = !!(a && b && b.pos !== a.pos);
      }
      if (!moved && !css) break;
      await page.pause("betweenSteps");
      await blockers();
      const got = add(await collect());
      if (got) quiet = 0; else if (++quiet >= 2 || (!more && !next && !moved)) break;
    }
    return [...all.values()];
  }
  async function readBrands(limit) {
    current = "read_trybe_brands";
    say(current);
    const base = trybeRoot;
    const cards = async (dialog) => R.brandsFromCards(await brandCards(dialog), { base, limit: 500 }).map((b) => ({ ...b, key: b.id }));
    const listed = async () => (await page.rows(R.READ_TARGETS.brandLinks)).length > 0;
    const empty = async () => !!(await find(R.READ_TARGETS.noBrands));
    // 1. the Brands page (every brand, page by page)
    await open(`${base}/creator/brands`, async () => (await listed()) || (await empty()) || !!(await find(R.READ_TARGETS.notFound)));
    const css = 'a[href*="/creator/brands/"]';
    let got = (await listed()) ? await paged(() => cards(false), limit, { css }) : [];
    // 2. Home: My Brands, then View All (a list or a dialog with every brand)
    if (!got.length) {
      await open(`${base}/creator`, async () => (await listed()) || !!(await find(R.READ_TARGETS.viewAll)) || (await empty()));
      const home = await cards(false);
      const all = await find(R.READ_TARGETS.viewAll);
      if (all && (await press(all))) {
        await page.pause("betweenSteps");
        await settle(null, listed);
        const inDialog = !!(await find(TRYBE_TARGETS.dialog));
        got = await paged(() => cards(inDialog), limit, { css });
      }
      if (!got.length) got = home;
    }
    // 3. the AI shows the list
    if (!got.length && !(await empty())) {
      if (await askGroot("read_trybe_brands", listed)) { const inDialog = !!(await find(TRYBE_TARGETS.dialog)); got = await paged(() => cards(inDialog), limit, { css }); }
    }
    if (!got.length && !(await empty())) throw new Failed("Groot couldn't find your brands on Trybe.", "not_found");
    return got.slice(0, limit).map(({ key, ...b }) => b);
  }

  // ---- Trybe: one brand ---------------------------------------------------------------------------
  async function readBrand(params) {
    current = "read_trybe_brand";
    let id = params.brandId || null;
    if (!id) {
      const brands = await readBrands(R.LIMITS.trybe_brands.max);
      const hit = R.pickBrandCard(params.brand, brands);
      if (!hit) throw new Failed(NOT_IN_BRANDS, "brand_not_found");
      id = hit.id;
      current = "read_trybe_brand";
    }
    say(current);
    const url = `${trybeRoot}/creator/brands/${encodeURIComponent(id)}`;
    const drawn = async () => !!(await find(R.READ_TARGETS.notFound)) || ((await page.run(MAIN_WORDS).catch(() => 0)) > 40 && !!(await find([{ css: "h1, h2, [role=heading]" }])));
    await open(url, drawn);
    if ((await find(R.READ_TARGETS.notFound)) || brandIdOf(page.url()) !== id) throw new Failed(NOT_IN_BRANDS, "brand_not_found");
    const onPage = () => brandIdOf(page.url()) === id;
    // the page as text, and a dialog's too when one is open ("View details" may open one)
    const dump = async () => {
      const main = await page.run(DUMP, { max: 800 }).catch(() => null);
      if (!(await find(TRYBE_TARGETS.dialog))) return main;
      return R.mergeDumps(main, await page.run(DUMP, { max: 800, dialog: true }).catch(() => null));
    };
    // The name on the page: its words may be in a tab's label ("Mad Rabbit's brief").
    const head = await find([{ css: "h1" }]);
    names = [params.brand, head && head.text].filter(Boolean).slice(0, 2);
    // "Read more" / "Show more" (each at most once a round, the page never left)
    let seen = null;
    for (let i = 0; i < 6; i++) {
      const more = await find(R.READ_TARGETS.expanders);
      if (!more || !(await press(more))) break;
      await page.pause("afterClick");
      if (!onPage()) { await open(url, drawn); break; }
      if (await find(TRYBE_TARGETS.dialog)) { seen = R.mergeDumps(seen, await dump()); await page.key("Escape").catch(() => {}); await page.pause("afterClick"); }
    }
    seen = R.mergeDumps(await dump(), seen);
    // every tab (Brief, Requirements, Products ...): each one's page read too
    const readTabs = async () => {
      for (let i = 0; i < 8; i++) {
        const tabs = await page.rows(R.READ_TARGETS.tabs);
        const tab = tabs[i];
        if (!tab) break;
        if (tab.selected || !R.isSafeToPress(tab.text, names)) continue;
        await page.clickRef(tab.ref);
        await page.pause("afterClick");
        if (!onPage()) { await open(url, drawn); break; }
        seen = R.mergeDumps(seen, await dump());
      }
    };
    await readTabs();
    let brand = R.brandFromBlocks(seen, { id, base: trybeRoot, name: params.brand });
    // Nothing the words know: the AI opens what hides it, then the page is read again (its tabs too).
    if (R.brandIsEmpty(brand)) {
      say(current, "Looking for the brand's brief");
      const check = async () => { if (!onPage()) return false; seen = R.mergeDumps(seen, await dump()); brand = R.brandFromBlocks(seen, { id, base: trybeRoot, name: params.brand }); return !R.brandIsEmpty(brand); };
      if (await askGroot("read_trybe_brand", check)) { await readTabs(); brand = R.brandFromBlocks(seen, { id, base: trybeRoot, name: params.brand }); }
      if (!onPage()) await open(url, drawn);
    }
    brand.id = id;
    return brand;
  }

  // ---- TikTok Studio: the recent posts ------------------------------------------------------------
  async function readPosts(limit) {
    current = "read_tiktok_posts";
    say(current);
    const url = `${tiktokRoot}/tiktokstudio/content`;
    const listed = async () => (await page.rows(R.READ_TARGETS.postLinks)).length > 0;
    const empty = async () => !!(await find(R.READ_TARGETS.noPosts));
    await open(url, async () => (await listed()) || (await empty()));
    if (!(await listed()) && !(await empty())) {
      const tab = await find(R.READ_TARGETS.postsTab);
      if (tab && (await press(tab))) await settle(url, listed);
    }
    const rows = async () => R.postsFromRows(await page.run(POST_ROWS, { max: 200 }).catch(() => []), { now: now(), limit: 500 }).map((p) => ({ ...p, key: p.url }));
    const css = 'a[href*="/video/"]';
    let got = (await listed()) ? await paged(rows, limit, { css }) : [];
    if (!got.length && !(await empty())) {
      if (await askGroot("read_tiktok_posts", listed)) got = await paged(rows, limit, { css });
    }
    if (!got.length && !(await empty())) throw new Failed("Groot couldn't find your posts in TikTok Studio.", "not_found");
    return got.slice(0, limit).map(({ key, ...p }) => p);
  }

  async function run(job) {
    const v = R.validateReadRequest(job);
    if (!v.ok) return { status: "failed", error: v.error, code: "bad_read", aiSteps: 0 };
    const { read, params } = v.value;
    platform = R.READS[read];
    readId = (job && job.readId) || `read_${Date.now().toString(36)}`;
    names = params.brand ? [params.brand] : [];
    current = "read_open";
    try {
      let result;
      if (read === "trybe_brands") result = await readBrands(params.limit);
      else if (read === "trybe_brand") result = await readBrand(params);
      else result = await readPosts(params.limit);
      result = R.capReadResult(read, result);
      const partial = !Array.isArray(result) && !!result.partial;
      say(current, read === "trybe_brands" ? `Read ${result.length} Trybe brand${result.length === 1 ? "" : "s"}` : read === "trybe_brand" ? `Read ${result.name || "the brand"}${partial ? " (some of it)" : ""}` : `Read ${result.length} recent post${result.length === 1 ? "" : "s"}`, "done");
      return { status: "done", result, partial, aiSteps: aiUsed };
    } catch (e) {
      if (e && e.stopped) { say(current, "Stopped", "stopped"); return { status: "stopped", aiSteps: aiUsed }; }
      const error = e instanceof Failed ? e.message : e instanceof StepMissed ? "Groot couldn't find that on the page." : "Something went wrong while reading.";
      const code = e instanceof Failed ? e.code : null;
      log("read failed", read, current, e && (e.stack || e.message));
      say(current, error, "failed", code ? { code } : {});
      return { status: "failed", error, code, step: current, aiSteps: aiUsed };
    }
  }

  return { run };
}

module.exports = { createReadEngine, DUMP, BRAND_CARDS, POST_ROWS };
