// The TikTok page as Groot sees and touches it, through the Chrome DevTools Protocol
// (webContents.debugger). Everything Groot does is real input: the mouse moves, presses and lets
// go (Input.dispatchMouseEvent), text arrives as typing (Input.insertText), the video goes into
// TikTok's own file input (DOM.setFileInputFiles). Our page scripts run in an ISOLATED WORLD
// (Page.createIsolatedWorld): they see TikTok's DOM, TikTok's scripts never see them, and Runtime
// is never enabled.
"use strict";

const { delay, chunks, TIMEOUTS } = require("./rules");

const WORLD = "goviral-groot";
const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal && signal.aborted) return rej(stopped());
  const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); res(); }, ms);
  const onAbort = () => { clearTimeout(t); rej(stopped()); };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
});
function stopped() { const e = new Error("Stopped"); e.stopped = true; return e; }

// Runs in the isolated world. Finds the first match of a list of ways (see rules.js TARGETS),
// keeps the element in the world's own list and returns its ref and box.
// Ways (2026-10-06): a css way may also say `near` (a regex the words AROUND the element must match:
// its label), `has` (a regex its own words must match), `notIn` (a selector it must not be inside),
// `valueRe` (a regex its value must match). `learned` finds an element the AI found before, from its
// description (rules.js describeElement): data-e2e, role, words, aria-label, placeholder, dialog,
// the words around it; the best match wins.
const FIND = function (arg) {
  const g = (window.__gv = window.__gv || { els: [] });
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const ownText = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
  const words = (t) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const DLG = '[role=dialog], [aria-modal="true"], [class*="TUXModal"]';
  const roleOf = (el) => el.getAttribute("role") || (el.isContentEditable ? "textbox" : el.tagName.toLowerCase());
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  // the words around an element: the nearest parent (up to 4 up, short) with words of its own
  const nearOf = (el) => {
    const own = norm(el.innerText);
    let a = el.parentElement;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) {
      const t = norm(a.innerText);
      if (t.length > 120) break; // a label, not a whole form (which would carry the caption)
      const rest = (own ? t.split(own).join(" ") : t).replace(/\s+/g, " ").trim();
      if (/\p{L}{3}/u.test(rest)) return rest.slice(0, 60);
    }
    return "";
  };
  // a regex over the text around it: any parent up to 5 up with at most 400 characters
  const around = (el, re) => {
    let a = el.parentElement;
    for (let i = 0; a && i < 5; i++, a = a.parentElement) {
      const t = (a.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length > 400) return false;
      if (re.test(t)) return true;
    }
    return false;
  };
  const valueOf = (el) => (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value || "" : el.isContentEditable ? el.innerText || "" : "");
  const LEARNED_SEL = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=option], [role=tab], [role=menuitem], [role=menuitemradio], [role=combobox], [role=textbox], [role=switch], [contenteditable="true"], label, [data-e2e], [aria-haspopup], li, div[tabindex], span[tabindex]';
  for (let wi = 0; wi < arg.ways.length; wi++) {
    const way = arg.ways[wi];
    let found = null;
    if (way.css) {
      const nearRe = way.near ? new RegExp(way.near, "iu") : null;
      const hasRe = way.has ? new RegExp(way.has, "iu") : null;
      const valRe = way.valueRe ? new RegExp(way.valueRe, "u") : null;
      for (const el of document.querySelectorAll(way.css)) {
        if (!(way.hidden || visible(el))) continue;
        if (way.notIn && el.closest(way.notIn)) continue;
        if (hasRe && !hasRe.test(el.tagName === "SELECT" ? ((el.selectedOptions && el.selectedOptions[0]) || {}).text || "" : (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim())) continue;
        if (valRe && !valRe.test(valueOf(el))) continue;
        if (nearRe && !around(el, nearRe)) continue;
        found = el;
        break;
      }
    } else if (way.learned) {
      const L = way.learned;
      let best = 0;
      let sel = LEARNED_SEL;
      if (L.e2e) { try { sel = `[data-e2e="${CSS.escape(L.e2e)}"]`; } catch { sel = LEARNED_SEL; } }
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        if (L.role && roleOf(el) !== L.role) continue;
        if (!!L.dlg !== !!el.closest(DLG)) continue;
        if (L.type && el.tagName === "INPUT" && (el.getAttribute("type") || "text").toLowerCase() !== L.type) continue;
        let s = 1 + (L.e2e ? 4 : 0);
        let named = !(L.label || L.text || L.ph);
        if (L.label && norm(el.getAttribute("aria-label")) === norm(L.label)) { s += 3; named = true; }
        if (L.text && norm(el.innerText || el.value) === norm(L.text)) { s += 3; named = true; }
        if (L.ph && norm(el.getAttribute("placeholder")) === norm(L.ph)) { s += 2; named = true; }
        if (!named && !L.e2e) continue;
        if (L.near) { if (nearOf(el).includes(norm(L.near))) s += 2; else s -= 1; }
        if (s > best) { best = s; found = el; }
      }
    } else if (way.text) {
      const re = new RegExp(way.text, "i");
      const all = [...document.querySelectorAll(way.within || "*")].filter((el) => visible(el) && re.test(ownText(el)));
      // the innermost match (the button, not the page around it)
      found = all.find((el) => !all.some((o) => o !== el && el.contains(o))) || null;
    } else if (way.best && arg.value) {
      const want = words(arg.value);
      let best = 0;
      for (const el of document.querySelectorAll(way.best)) {
        if (!visible(el)) continue;
        const have = new Set(words(ownText(el)));
        const score = want.filter((w) => have.has(w)).length / Math.max(1, want.length);
        if (score > best) { best = score; found = el; }
      }
      if (best < 0.5) found = null;
    }
    if (!found) continue;
    if (!way.hidden) {
      const r0 = found.getBoundingClientRect();
      if (r0.top < 0 || r0.bottom > innerHeight || r0.left < 0 || r0.right > innerWidth) found.scrollIntoView({ block: "center", inline: "center" });
    }
    const r = found.getBoundingClientRect();
    g.els.push(found);
    const disabled = !!(found.disabled || found.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(found.className || ""));
    return { ref: g.els.length - 1, way: wi, x: r.left, y: r.top, w: r.width, h: r.height, disabled, text: ownText(found).slice(0, 200) };
  }
  return null;
};

// Runs in the isolated world: every visible match of a list (the product rows), innermost first,
// each with its words and whether it is the one selected. The choosing happens in Node
// (rules.js pickProduct), never in the page.
const ROWS = function (arg) {
  const g = (window.__gv = window.__gv || { els: [] });
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const RADIO = "input[type=radio], [role=radio], [class*=radio i]";
  // The row an element stands for: the nearest row-like parent, else the widest parent that still
  // holds only this one radio (a div-built table has no tr).
  const rowOf = (el) => {
    let row = el.closest("label, tr, [role=row], [role=option]");
    if (!row || (row.innerText || "").trim().length < 4) {
      let a = el;
      while (a.parentElement && a.parentElement !== document.body && a.parentElement.querySelectorAll(RADIO).length <= 1 && !a.parentElement.querySelector("input:not([type=radio]), button, [role=button]") && (a.parentElement.innerText || "").length < 600) a = a.parentElement;
      row = a;
    }
    return row;
  };
  // What to press for a row: its radio when it shows one, else the row.
  const pressOf = (row, el) => {
    const r = el && el.tagName !== "INPUT" && visible(el) ? el : [...row.querySelectorAll(RADIO)].find(visible) || (el && el.parentElement && visible(el.parentElement) ? el.parentElement : null);
    return r || row;
  };
  const out = (pairs) => pairs.slice(0, 60).map(({ row, press }) => {
    g.els.push(press);
    const selected = !!(row.querySelector("input:checked, [aria-checked=true], [aria-selected=true], [class*=radio i][class*=checked i]:not([class*=unchecked i])") || row.getAttribute("aria-selected") === "true" || row.getAttribute("aria-checked") === "true");
    return { ref: g.els.length - 1, text: (row.innerText || row.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 200), selected };
  });
  for (const way of arg.ways) {
    if (way.priced) {
      // Any product table: each price on screen, climbed to the widest box holding only that price.
      const scope = [...document.querySelectorAll(way.priced)].filter(visible);
      const priceRe = /^[$€£]\s?\d[\d,]*(\.\d{2})?$|^\d[\d,]*(\.\d{2})?\s?(USD|[$€£])$/;
      const leaves = scope.flatMap((d) => [...d.querySelectorAll("*")]).filter((el) => !el.children.length && priceRe.test((el.textContent || "").trim()) && visible(el));
      const rows = [];
      for (const leaf of leaves) {
        let a = leaf;
        while (!a.querySelector(RADIO) && a.parentElement && !scope.includes(a.parentElement) && leaves.filter((l) => a.parentElement.contains(l)).length === 1 && !a.parentElement.querySelector("input:not([type=radio]), button, [role=button], ul, ol")) a = a.parentElement;
        if (!rows.includes(a)) rows.push(a);
      }
      if (rows.length) return out(rows.map((row) => ({ row, press: pressOf(row, null) })));
      continue;
    }
    if (!way.css) continue;
    const all = [...document.querySelectorAll(way.css)].filter((el) => el.tagName === "INPUT" || visible(el));
    const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
    if (!inner.length) continue;
    if (!way.rowOf) return out(inner.map((el) => ({ row: el, press: el })));
    const pairs = [];
    for (const el of inner) { const row = rowOf(el); if (!pairs.some((p) => p.row === row)) pairs.push({ row, press: pressOf(row, el) }); }
    return out(pairs);
  }
  return [];
};

// Runs in the isolated world: what is on screen and can be pressed or typed into, numbered. Each
// element also carries what the AI and the learning need (2026-10-06): its data-e2e, aria-label,
// own words, placeholder, whether it is in a dialog, the words around it (its label), and a box's
// value (up to 300 characters; a contenteditable's words). The page's open dialog title and any
// error / alert notices on screen ride along.
const SNAPSHOT = function () {
  const g = (window.__gv = window.__gv || { els: [] });
  g.els = [];
  const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=option], [role=tab], [role=menuitem], [role=menuitemradio], [role=combobox], [role=textbox], [role=switch], [role=dialog] [tabindex], [contenteditable="true"], label, [data-e2e], [aria-haspopup]';
  const DLG = '[role=dialog], [aria-modal="true"], [class*="TUXModal"]';
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    const s = getComputedStyle(el);
    return s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05 ? null : r;
  };
  const nearOf = (el) => {
    const own = norm(el.innerText).toLowerCase();
    let a = el.parentElement;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) {
      const t = norm(a.innerText);
      if (t.length > 120) break; // a label, not a whole form (which would carry the caption)
      const rest = norm(own ? t.toLowerCase().split(own).join(" ") : t.toLowerCase());
      if (/\p{L}{3}/u.test(rest)) return rest.slice(0, 60);
    }
    return "";
  };
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 250) break;
    const r = shown(el);
    if (!r) continue;
    const type = el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : undefined;
    const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("data-e2e") || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const role = el.getAttribute("role") || (el.isContentEditable ? "textbox" : el.tagName.toLowerCase());
    g.els.push(el);
    const e = { ref: g.els.length - 1, role, name, tag: el.tagName.toLowerCase(), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    if (type) e.type = type;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") e.disabled = true;
    if (el.checked === true || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") e.checked = true;
    if ((type === "radio" || type === "checkbox") && el.value) { /* a radio's value isn't text anyone typed */ }
    else if (type && type !== "password" && type !== "file" && el.value) e.value = String(el.value).slice(0, 300);
    else if (el.tagName === "TEXTAREA" && el.value) e.value = String(el.value).slice(0, 300);
    else if (el.isContentEditable && el.innerText) e.value = norm(el.innerText).slice(0, 300);
    else if (el.tagName === "SELECT" && el.selectedOptions && el.selectedOptions[0]) e.value = norm(el.selectedOptions[0].text).slice(0, 80);
    const e2e = el.getAttribute("data-e2e");
    if (e2e) e.e2e = e2e.slice(0, 60);
    const label = el.getAttribute("aria-label");
    if (label) e.label = norm(label).slice(0, 80);
    const own = el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" ? "" : norm(el.innerText);
    if (own) e.text = own.slice(0, 80);
    const ph = el.getAttribute("placeholder");
    if (ph) e.ph = norm(ph).slice(0, 60);
    if (el.closest(DLG)) e.dlg = true;
    const near = nearOf(el);
    if (near) e.near = near;
    out.push(e);
  }
  let dialog = "";
  for (const d of document.querySelectorAll('[role=dialog], [aria-modal="true"]')) {
    if (!shown(d)) continue;
    const h = d.querySelector("h1, h2, h3, h4, [class*=title i]");
    dialog = norm(d.getAttribute("aria-label") || (h && h.innerText) || "").slice(0, 60);
    if (dialog) break;
  }
  const notices = [];
  for (const n of document.querySelectorAll('[role=alert], [aria-live]:not([aria-live=off]), [class*=error i], [class*=toast i], [class*=warning i]')) {
    if (notices.length >= 6) break;
    const t = norm(n.innerText);
    if (!t || t.length > 160 || !shown(n) || notices.some((x) => x.includes(t) || t.includes(x))) continue;
    notices.push(t);
  }
  return { width: innerWidth, height: innerHeight, url: location.href, elements: out, dialog, notices };
};
// The page variant, cheaply: the address and the open dialog's title (rules.js variantOf).
const VARIANT = function () {
  let dialog = "";
  for (const d of document.querySelectorAll('[role=dialog], [aria-modal="true"]')) {
    const r = d.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const h = d.querySelector("h1, h2, h3, h4, [class*=title i]");
    dialog = String(d.getAttribute("aria-label") || (h && h.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (dialog) break;
  }
  return { url: location.href, dialog };
};

const BOX = function (arg) {
  const el = (window.__gv && window.__gv.els[arg.ref]) || null;
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  // Off screen, or under something (a dialog that scrolls inside itself keeps the showcase's page
  // buttons below its own edge): scrolled to the middle first.
  const under = (q) => { const e = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return !e || !(e === el || el.contains(e)); };
  if (r.top < 0 || r.bottom > innerHeight || (r.width > 0 && under(r))) { el.scrollIntoView({ block: "center" }); }
  const q = el.getBoundingClientRect();
  return { x: q.left, y: q.top, w: q.width, h: q.height };
};
const TEXT_OF = function (arg) {
  const el = (window.__gv && window.__gv.els[arg.ref]) || null;
  if (!el) return null;
  // a <select> reads as its chosen option (innerText would be every option); a box as its value
  if (el.tagName === "SELECT") return ((el.selectedOptions && el.selectedOptions[0] && el.selectedOptions[0].text) || "").replace(/\s+/g, " ").trim();
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return String(el.value || "").replace(/\s+/g, " ").trim();
  return (el.innerText || el.value || "").replace(/\s+/g, " ").trim();
};
const FOCUSED_IS_PASSWORD = function () {
  const el = document.activeElement;
  return !!(el && el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password");
};

class CdpPage {
  constructor(webContents, { pace = 1, signal = null, log = () => {}, cdpMs = TIMEOUTS.cdp } = {}) {
    this.wc = webContents;
    this.cdpMs = cdpMs; // one page script may take this long; then it counts as "not found" (never a hang)
    this.dbg = webContents.debugger;
    this.pace = pace;
    this.signal = signal;
    this.log = log;
    this.world = null;
    this.mouse = { x: 200 + Math.random() * 300, y: 200 + Math.random() * 200 };
  }

  attach() {
    if (!this.dbg.isAttached()) this.dbg.attach("1.3");
    this.dbg.on("detach", (_e, reason) => this.log("tiktok debugger detached", reason));
    // The page keeps behaving as focused while the creator works in another window: the caption
    // box keeps its caret and typing still lands in it.
    this.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch((e) => this.log("focus emulation", e));
  }
  detach() { try { if (this.dbg.isAttached()) this.dbg.detach(); } catch { /* already gone */ } }
  send(method, params = {}) { return this.dbg.sendCommand(method, params); }
  // A command that may never answer (a screenshot of a minimized window): give up after ms.
  sendWithin(ms, method, params = {}) {
    return Promise.race([this.send(method, params), new Promise((res) => setTimeout(() => res(null), ms))]);
  }
  // A promise that rejects after ms ("the page didn't answer") instead of waiting forever.
  within(ms, promise) {
    let t = null;
    return Promise.race([promise, new Promise((_res, rej) => { t = setTimeout(() => rej(new Error(`the page didn't answer in ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
  }
  sleep(ms) { return sleep(ms, this.signal); }
  pause(kind) { return this.sleep(delay(kind, this.pace)); }
  url() { return this.wc.isDestroyed() ? "" : this.wc.getURL(); }

  // A page load, at most ms: TikTok Studio can keep loading for a long time, and the steps find
  // their own way on whatever has loaded. Returns { ms, timedOut }.
  async goto(url, ms = 30000) {
    this.world = null;
    const t0 = Date.now();
    let timer = null;
    const load = this.wc.loadURL(url).then(() => false, (e) => { if (!/ERR_ABORTED/.test(String(e && e.message))) throw e; return false; });
    const late = new Promise((res) => { timer = setTimeout(() => res(true), ms); });
    try {
      const timedOut = await Promise.race([load, late]);
      if (timedOut) load.catch(() => {});
      return { ms: Date.now() - t0, timedOut };
    } finally { clearTimeout(timer); }
  }

  // The isolated world for the page now showing (a new document needs a new one).
  async context() {
    const { frameTree } = await this.within(this.cdpMs, this.send("Page.getFrameTree"));
    const f = frameTree.frame;
    if (this.world && this.world.loaderId === f.loaderId) return this.world.id;
    const { executionContextId } = await this.send("Page.createIsolatedWorld", { frameId: f.id, worldName: WORLD, grantUniveralAccess: false });
    this.world = { loaderId: f.loaderId, id: executionContextId };
    return executionContextId;
  }
  async run(fn, arg, byValue = true) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const contextId = await this.context();
      const r = await this.within(this.cdpMs, this.send("Runtime.evaluate", { expression: `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`, contextId, returnByValue: byValue, awaitPromise: true })).catch((e) => ({ err: e }));
      if (r.err) { this.world = null; if (attempt) throw r.err; continue; } // the document changed under us
      if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.text}`);
      return byValue ? r.result.value : r.result;
    }
    return null;
  }

  find(ways, value) { return this.run(FIND, { ways, value: value || null }); }
  rows(ways) { return this.run(ROWS, { ways }).then((r) => r || []); }
  snapshot() { return this.run(SNAPSHOT); }
  variant() { return this.run(VARIANT); }
  textOf(ref) { return this.run(TEXT_OF, { ref }); }
  focusedIsPassword() { return this.run(FOCUSED_IS_PASSWORD); }

  async screenshot() {
    for (const quality of [55, 35]) {
      const r = await this.sendWithin(6000, "Page.captureScreenshot", { format: "jpeg", quality }).catch(() => null);
      if (r && r.data && r.data.length <= 1_300_000) return r.data;
    }
    return null;
  }

  // The mouse travels to a point inside the element (never the dead centre), pauses, clicks.
  async clickRef(ref) {
    const box = await this.run(BOX, { ref });
    if (!box) throw new Error("That button went away.");
    const x = box.x + box.w * (0.3 + Math.random() * 0.4);
    const y = box.y + box.h * (0.3 + Math.random() * 0.4);
    return this.clickAt(x, y);
  }
  async clickAt(x, y) {
    await this.pause("beforeClick");
    const from = this.mouse;
    const n = 6 + Math.floor(Math.random() * 6);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const ease = t * t * (3 - 2 * t);
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (x - from.x) * ease, y: from.y + (y - from.y) * ease });
      await this.sleep(8 + Math.random() * 18);
    }
    this.mouse = { x, y };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.sleep(60 + Math.random() * 80);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await this.pause("afterClick");
  }

  // Typing: a few characters at a time with small gaps. Never into a password field.
  // { slow: true }: one character at a time (the second try at a description TikTok mangled).
  async type(text, { slow = false } = {}) {
    if (await this.focusedIsPassword()) throw Object.assign(new Error("TikTok wants your password. Type it yourself, Groot never does."), { needUser: "password" });
    for (const c of slow ? [...text] : chunks(text)) {
      await this.send("Input.insertText", { text: c });
      await this.pause("keyChunk");
    }
  }
  async key(name) {
    const K = { Enter: [13, "\r"], Tab: [9, ""], Escape: [27, ""], Backspace: [8, ""] }[name];
    if (!K) throw new Error(`key ${name}`);
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: name, code: name, windowsVirtualKeyCode: K[0], nativeVirtualKeyCode: K[0] });
    if (K[1]) await this.send("Input.dispatchKeyEvent", { type: "char", text: K[1], key: name });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: K[0], nativeVirtualKeyCode: K[0] });
    await this.pause("keyChunk");
  }
  // Select everything in the focused box and delete it (TikTok puts the file name in the caption).
  async clearFocused() {
    const mod = process.platform === "darwin" ? 4 : 2;
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: mod, commands: ["selectAll"] });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: mod });
    await this.pause("keyChunk");
    await this.key("Backspace");
  }
  async scroll(dy) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: this.mouse.x, y: this.mouse.y, deltaX: 0, deltaY: dy });
    await this.pause("afterClick");
  }
  async setFiles(ref, filePath) {
    const r = await this.run(function (a) { return window.__gv.els[a.ref]; }, { ref }, false);
    if (!r || !r.objectId) throw new Error("TikTok's file picker went away.");
    await this.send("DOM.setFileInputFiles", { files: [filePath], objectId: r.objectId });
  }
}

module.exports = { CdpPage, sleep, stopped };
