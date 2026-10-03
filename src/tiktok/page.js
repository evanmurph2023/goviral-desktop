// The TikTok page as Groot sees and touches it, through the Chrome DevTools Protocol
// (webContents.debugger). Everything Groot does is real input: the mouse moves, presses and lets
// go (Input.dispatchMouseEvent), text arrives as typing (Input.insertText), the video goes into
// TikTok's own file input (DOM.setFileInputFiles). Our page scripts run in an ISOLATED WORLD
// (Page.createIsolatedWorld): they see TikTok's DOM, TikTok's scripts never see them, and Runtime
// is never enabled.
"use strict";

const { delay, chunks } = require("./rules");

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
  for (const way of arg.ways) {
    let found = null;
    if (way.css) {
      for (const el of document.querySelectorAll(way.css)) if (way.hidden || visible(el)) { found = el; break; }
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
    return { ref: g.els.length - 1, x: r.left, y: r.top, w: r.width, h: r.height, disabled, text: ownText(found).slice(0, 200) };
  }
  return null;
};

// Runs in the isolated world: what is on screen and can be pressed or typed into, numbered.
const SNAPSHOT = function () {
  const g = (window.__gv = window.__gv || { els: [] });
  g.els = [];
  const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=checkbox], [role=radio], [role=option], [role=tab], [role=menuitem], [role=combobox], [role=textbox], [role=switch], [role=dialog] [tabindex], [contenteditable="true"], label, [data-e2e]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 250) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05) continue;
    const type = el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : undefined;
    const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("data-e2e") || "").replace(/\s+/g, " ").trim().slice(0, 100);
    const role = el.getAttribute("role") || (el.isContentEditable ? "textbox" : el.tagName.toLowerCase());
    g.els.push(el);
    const e = { ref: g.els.length - 1, role, name, tag: el.tagName.toLowerCase(), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    if (type) e.type = type;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") e.disabled = true;
    if (type && type !== "password" && type !== "file" && el.value) e.value = String(el.value).slice(0, 80);
    out.push(e);
  }
  return { width: innerWidth, height: innerHeight, url: location.href, elements: out };
};

const BOX = function (arg) {
  const el = (window.__gv && window.__gv.els[arg.ref]) || null;
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) { el.scrollIntoView({ block: "center" }); }
  const q = el.getBoundingClientRect();
  return { x: q.left, y: q.top, w: q.width, h: q.height };
};
const TEXT_OF = function (arg) {
  const el = (window.__gv && window.__gv.els[arg.ref]) || null;
  return el ? (el.innerText || el.value || "").replace(/\s+/g, " ").trim() : null;
};
const FOCUSED_IS_PASSWORD = function () {
  const el = document.activeElement;
  return !!(el && el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password");
};

class CdpPage {
  constructor(webContents, { pace = 1, signal = null, log = () => {} } = {}) {
    this.wc = webContents;
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
  sleep(ms) { return sleep(ms, this.signal); }
  pause(kind) { return this.sleep(delay(kind, this.pace)); }
  url() { return this.wc.isDestroyed() ? "" : this.wc.getURL(); }

  async goto(url) {
    this.world = null;
    await this.wc.loadURL(url).catch((e) => { if (!/ERR_ABORTED/.test(String(e && e.message))) throw e; });
  }

  // The isolated world for the page now showing (a new document needs a new one).
  async context() {
    const { frameTree } = await this.send("Page.getFrameTree");
    const f = frameTree.frame;
    if (this.world && this.world.loaderId === f.loaderId) return this.world.id;
    const { executionContextId } = await this.send("Page.createIsolatedWorld", { frameId: f.id, worldName: WORLD, grantUniveralAccess: false });
    this.world = { loaderId: f.loaderId, id: executionContextId };
    return executionContextId;
  }
  async run(fn, arg, byValue = true) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const contextId = await this.context();
      const r = await this.send("Runtime.evaluate", { expression: `(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`, contextId, returnByValue: byValue, awaitPromise: true }).catch((e) => ({ err: e }));
      if (r.err) { this.world = null; if (attempt) throw r.err; continue; } // the document changed under us
      if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.text}`);
      return byValue ? r.result.value : r.result;
    }
    return null;
  }

  find(ways, value) { return this.run(FIND, { ways, value: value || null }); }
  snapshot() { return this.run(SNAPSHOT); }
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
  async type(text) {
    if (await this.focusedIsPassword()) throw Object.assign(new Error("TikTok wants your password. Type it yourself, Groot never does."), { needUser: "password" });
    for (const c of chunks(text)) {
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
