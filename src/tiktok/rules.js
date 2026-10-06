// Groot posts to TikTok: the pure rules (no Electron, no network), so scripts/tiktok-unit.cjs can
// prove them with plain Node.
//   - what the app may ask for (validatePostRequest) and who may ask (isAllowedCaller)
//   - where it goes (platform: tiktok | trybe; Trybe's own rules are in trybe.js)
//   - which addresses the TikTok window may show (isTikTokUrl, isLoginProviderUrl)
//   - where a video may come from (parseSource: a GoViral export, a file the creator chose, Drive)
//   - the scripted steps for one post (planSteps) and the selectors they try (TARGETS)
//   - the product in the showcase (searchTerms, pickProduct) and the link name (cleanProductName,
//     nameFixes: the only names the AI may type)
//   - who can watch the video (PRIVACY, parsePrivacy, privacyOf, privacyOptionWays)
//   - the AI fallback's actions, checked again here before anything runs (validateAction)
//   - learning: an element described for later (describeElement, learnedWays, variantOf, isRecipe)
//   - human pacing (delay)
"use strict";

// TikTok Studio, not tiktok.com/upload (Drew, 2026-10-04: the real flow): Upload → Videos lives
// at /tiktokstudio/upload.
const TIKTOK_STUDIO_URL = "https://www.tiktok.com/tiktokstudio";
const TIKTOK_UPLOAD_URL = `${TIKTOK_STUDIO_URL}/upload`;
const MODES = ["auto", "manual"];
// Where a post goes (2026-10-05): TikTok (this file's engine.js) or Trybe (trybe.js, trybe-engine.js).
const PLATFORMS = ["tiktok", "trybe"];

// ---- callers and inputs ----------------------------------------------------------------------

// Only the app itself (the desktop build at <appOrigin>/desktop) may start a post.
function isAllowedCaller(url, appOrigin) {
  try {
    const u = new URL(url);
    return u.origin === appOrigin && (u.pathname === "/desktop" || u.pathname.startsWith("/desktop/"));
  } catch { return false; }
}

// Finished exports live on Vercel Blob, the worker, or the site. A local build may also fetch from
// 127.0.0.1 (the test harness); an installed copy never can.
function isVideoUrl(url, { allowLocal = false } = {}) {
  try {
    const u = new URL(url);
    if (allowLocal && u.protocol === "http:" && u.hostname === "127.0.0.1") return true;
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    return /\.public\.blob\.vercel-storage\.com$/.test(h) || h === "goviral-platform-production.up.railway.app" || h === "app.govirall.now";
  } catch { return false; }
}

const TIKTOK_HOST = /(^|\.)(tiktok\.com|tiktokv\.com|tiktokcdn\.com|tiktokcdn-us\.com|ttwstatic\.com|byteoversea\.com|ibytedtos\.com)$/i;
function isTikTokUrl(url, { allowLocal = false } = {}) {
  try {
    const u = new URL(url);
    if (allowLocal && u.protocol === "http:" && u.hostname === "127.0.0.1") return true;
    return u.protocol === "https:" && TIKTOK_HOST.test(u.hostname);
  } catch { return false; }
}
// TikTok's own "log in with Google / Apple / Facebook / X / Instagram" pages, which the creator
// may need while logging in. Nothing else is shown in the TikTok window.
const LOGIN_HOST = /(^|\.)(accounts\.google\.com|appleid\.apple\.com|facebook\.com|twitter\.com|x\.com|instagram\.com)$/i;
function isLoginProviderUrl(url) {
  try { const u = new URL(url); return u.protocol === "https:" && LOGIN_HOST.test(u.hostname); } catch { return false; }
}

const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const HASHTAG = /^[\p{L}\p{N}_]{1,40}$/u;

// Where the video comes from:
//   { kind: "url", url }      a finished GoViral export (Blob, the worker, the site): downloaded
//   { kind: "file", fileId }  a video on this computer the creator chose (a folder they picked, or
//                             files they dropped): an opaque id from files.js, never a path
//   { kind: "drive", fileId } a video in the creator's own Google Drive (drive.js downloads it)
// The first shape the app sent, { videoUrl }, is still a url source.
const FILE_ID = /^f_[A-Za-z0-9_-]{16,64}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
function parseSource(raw, { allowLocal = false } = {}) {
  const src = raw.source && typeof raw.source === "object" && !Array.isArray(raw.source) ? raw.source : typeof raw.videoUrl === "string" ? { kind: "url", url: raw.videoUrl } : null;
  if (!src) return { error: "Which video?" };
  if (src.kind === "url") {
    const url = typeof src.url === "string" ? src.url.trim() : "";
    return isVideoUrl(url, { allowLocal }) ? { source: { kind: "url", url } } : { error: "That video isn't a GoViral export." };
  }
  if (src.kind === "file") return typeof src.fileId === "string" && FILE_ID.test(src.fileId) ? { source: { kind: "file", fileId: src.fileId } } : { error: "That isn't a video you picked." };
  if (src.kind === "drive") return typeof src.fileId === "string" && DRIVE_ID.test(src.fileId) ? { source: { kind: "drive", fileId: src.fileId } } : { error: "That isn't a Google Drive video." };
  return { error: "Which video?" };
}

// The request the app sends for one video. Everything is checked here, in the main process: the
// page can be anything, so nothing it sends is trusted as-is.
function validatePostRequest(raw, { allowLocal = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send one post." };
  const postId = str(raw.postId, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(postId)) return { ok: false, error: "Bad post id." };
  const src = parseSource(raw, { allowLocal });
  if (src.error) return { ok: false, error: src.error };
  const mode = MODES.includes(raw.mode) ? raw.mode : null;
  if (!mode) return { ok: false, error: "Pick Auto or Manual." };
  const platform = raw.platform === undefined || raw.platform === null ? "tiktok" : PLATFORMS.includes(raw.platform) ? raw.platform : null;
  if (!platform) return { ok: false, error: "Post it where?" };
  // Trybe: the brand the creator picked in "My brands" (never empty, never guessed). TikTok: none.
  const brand = platform === "trybe" ? str(raw.brand, 120).replace(/[<>{}]/g, "").trim() || null : null;
  if (platform === "trybe" && !brand) return { ok: false, error: "Which Trybe brand is it for?" };
  const caption = str(raw.caption, 300).replace(/\s*[—–]\s*/g, ", ");
  const hashtags = Array.isArray(raw.hashtags) ? raw.hashtags.map((h) => str(h, 41).replace(/^#/, "")).filter((h) => HASHTAG.test(h)).slice(0, 5) : [];
  const product = platform === "trybe" || raw.product === null || raw.product === undefined ? null : str(raw.product, 80) || null;
  const name = str(raw.name, 120) || "GoViral video";
  // Who can watch it on TikTok: the creator's choice in GoViral when the app sends one, else Everyone.
  const privacy = platform === "tiktok" ? parsePrivacy(raw.privacy) : null;
  if (platform === "tiktok" && !privacy) return { ok: false, error: "Who can watch it?" };
  const source = src.source;
  return { ok: true, value: { postId, source, videoUrl: source.kind === "url" ? source.url : null, mode, caption, hashtags, product, name, platform, brand, privacy } };
}

// The text that goes into TikTok's description box: the caption, then the hashtags ("comfort
// weekend slipper #slippers #comfort"). The platform builds the same string (src/lib/groot-post-db.ts
// takeAiStep), which is the only text the AI may type.
function captionText(caption, hashtags) {
  return [caption || "", (hashtags || []).map((h) => `#${h}`).join(" ")].filter(Boolean).join(" ").trim();
}

// The description compared the way a person reads it: spaces collapsed, the invisible characters
// an editor adds (zero-width, BOM) gone.
function normCaption(t) {
  return String(t || "").normalize("NFC").replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
}
// What Groot types, in pieces: the caption, then each hashtag on its own (" #tag"), so TikTok's
// hashtag list is closed (Escape) after every tag, before the next space goes in.
function captionParts(caption, hashtags) {
  const out = [];
  if (caption) out.push(caption);
  for (const h of hashtags || []) out.push(`${out.length ? " " : ""}#${h}`);
  return out;
}

// The rows TikTok showed in the showcase, for a "needs you" message: a few titles, short.
function showcaseList(rows, max = 5) {
  const t = [...new Set((rows || []).map((r) => String(r.text || "").replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean))];
  if (!t.length) return "";
  return t.slice(0, max).map((x) => `"${x}"`).join(", ") + (t.length > max ? ` and ${t.length - max} more` : "");
}

// A file name for a downloaded video (TikTok shows it while uploading).
function safeFileName(name) {
  const base = String(name || "GoViral video").replace(/\.(mp4|mov|m4v|webm)$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "GoViral video";
  return `${base}.mp4`;
}

// ---- the product in the showcase ------------------------------------------------------------------
// The product is the creator's words ("Comfort slippers"); the showcase has TikTok's title
// ("Comfort Weekend Slipper"). Words are compared, not strings: lower case, accents off, simple
// plurals folded (slippers = slipper), filler words ignored. A row is the product when it has at
// least 3 in 4 of the creator's words; of several, the most words matched, then the shortest
// title. Nothing good enough = not in the showcase: Groot never tags a different product.
const FILLER = new Set(["the", "a", "an", "and", "or", "for", "with", "of", "in", "on", "to", "my", "by", "from", "new"]);
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}
function productWords(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w && !FILLER.has(w)).map(stem);
}
// Two words are the same word when they're equal, or a letter or two apart (TikTok titles are
// often misspelled: Drew's showcase lists "Comfrt Weekend Slipper", 2026-10-05). Short words must
// match exactly so "cap" never matches "car".
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
function sameWord(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  return editDistance(a, b) <= (n >= 8 ? 2 : 1);
}
function productScore(want, have) {
  const w = [...new Set(productWords(want))];
  if (!w.length) return 0;
  const h = [...new Set(productWords(have))];
  return w.filter((x) => h.some((y) => sameWord(x, y))).length / w.length;
}
const PICK_AT = 0.75;
// A product row has words: page numbers ("1", "49"), arrows, "..." and the table's header never are.
function isProductRow(text) {
  const t = String(text || "").replace(/s+/g, " ").trim();
  if (t.length < 4 || /^[ds.,…<>‹›«»|/-]*$/.test(t)) return false;
  return !/^(product( name)?|name).{0,40}(price|stock|commission|status)/i.test(t);
}
// How many result pages Groot turns before trying the next search: a few for each word, the whole
// showcase for the empty search (Drew's has 49 pages; the slipper was on page 2-3, 2026-10-05).
const SHOWCASE_PAGES = { term: 6, all: 60 };
function pickProduct(want, rows) {
  let best = null;
  for (const r of rows || []) {
    const score = productScore(want, r.text);
    if (score < PICK_AT) continue;
    const extra = productWords(r.text).length;
    if (!best || score > best.score || (score === best.score && extra < best.extra)) best = { ...r, score, extra };
  }
  return best;
}
// What to type into the showcase search, in order, until a row matches: the product as the
// creator said it; then each word alone, the last one first (usually what the thing IS: "slipper"),
// in the singular too (TikTok's search wants every word as typed, so "slippers" misses "Slipper");
// then nothing at all, which lists the whole showcase to check by eye. One term used to be tried
// and a showcase titled "Comfrt Weekend Slipper" was never found (2026-10-05).
const SHOWCASE_ALL = "";
function searchTerms(product) {
  const full = str(product, 80);
  const words = full.split(/\s+/).filter((w) => w.length > 2 && !FILLER.has(w.toLowerCase()));
  const out = [full];
  for (const w of [...words].reverse()) {
    out.push(w);
    const s = stem(w.toLowerCase());
    if (s !== w.toLowerCase()) out.push(s);
  }
  const seen = new Set();
  const terms = out.filter((t) => { const k = t.toLowerCase(); if (!t || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
  return [...terms, SHOWCASE_ALL];
}

// The product link name: Groot never renames it. Only when TikTok says it has characters it
// won't take (or refuses Add while the name holds some), they go: level 1 = emoji and symbols
// (✨ ★ ™ | / # @ …), level 2 = everything but letters, numbers and spaces. Returns the name
// unchanged when there is nothing to take out. The platform has the same function
// (src/lib/groot-post.ts cleanProductName): the AI may type only what this returns.
const REJECTED_CHARS = "[\\p{Extended_Pictographic}\\p{S}\\p{Cc}\\p{Cf}|/\\\\<>{}\\[\\]~^*#@`\"]";
function cleanProductName(name, level = 1) {
  const t = String(name || "");
  const out = level >= 2
    ? t.replace(/[^\p{L}\p{N} ]+/gu, " ")
    : t.replace(new RegExp(`${REJECTED_CHARS}+`, "gu"), " ");
  return out.replace(/\s+/g, " ").trim();
}
// The cleaned names the AI may type on the name steps (product_name, product_add): every field in
// the dialog holding a value with characters TikTok rejects, cleaned at level 1 and 2. A value
// cut short by the snapshot (MAX_VALUE) is never offered: typing it would rename the product.
const MAX_VALUE = 300;
function nameFixes(view) {
  const out = [];
  for (const e of (view && view.elements) || []) {
    const v = typeof e.value === "string" ? e.value : "";
    if (!e.dlg || !v || v.length >= MAX_VALUE || e.type === "password" || e.type === "search") continue;
    const plain = v.replace(/\s+/g, " ").trim();
    for (const level of [1, 2]) {
      const c = cleanProductName(v, level);
      if (c && c !== plain && !out.includes(c)) out.push(c);
    }
  }
  return out.slice(0, 6);
}
const NAME_STEPS = new Set(["product_name", "product_add"]);

// ---- who can watch the video ---------------------------------------------------------------------
// TikTok remembers the account's last choice, so a post can go out "Only you" without anyone
// touching it (Drew's post, 2026-10-05). Groot sets it to what the creator chose in GoViral, or
// Everyone, before Post (Auto) and before the handoff (Manual), and reads it back. Nothing else in
// the settings is ever touched.
const PRIVACY = {
  everyone: { label: "Everyone", is: "\\b(everyone|public)\\b", opt: "everyone|public" },
  followers: { label: "Followers", is: "\\bfollowers\\b", opt: "followers" },
  friends: { label: "Friends", is: "\\b(mutual )?friends\\b", opt: "(mutual )?friends" },
  only_me: { label: "Only me", is: "\\b(only (me|you)|private)\\b", opt: "only (me|you)|private" },
};
const PRIVACY_VALUES = Object.keys(PRIVACY);
const PRIVACY_ANY = "\\b(everyone|public|followers|friends|only (me|you)|private)\\b";
const PRIVACY_ALIASES = { everyone: "everyone", public: "everyone", followers: "followers", friends: "friends", only_me: "only_me", onlyme: "only_me", only_you: "only_me", private: "only_me", self: "only_me" };
function parsePrivacy(v) {
  if (v === undefined || v === null || v === "") return "everyone";
  const k = String(v).trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PRIVACY_ALIASES[k] || null;
}
// What the control shows, as one of PRIVACY_VALUES (null = can't tell). "Only you" is checked
// before "Everyone" so a label like "Only you (not everyone)" reads right.
function privacyOf(text) {
  const t = String(text || "").toLowerCase();
  for (const k of ["only_me", "friends", "followers", "everyone"]) if (new RegExp(PRIVACY[k].is, "i").test(t)) return k;
  return null;
}
const OPTION_SEL = "[role=option], [role=menuitem], [role=menuitemradio], [role=radio], [role=listbox] li, [role=listbox] div, [role=menu] li, [class*=option i], label";
// The option to press in TikTok's list (the words start the option: "Everyone", "Only you").
function privacyOptionWays(value) {
  const p = PRIVACY[value] || PRIVACY.everyone;
  return [{ text: `^\\s*(${p.opt})\\b`, within: OPTION_SEL, privacyOption: value }];
}

// ---- the scripted steps -------------------------------------------------------------------------
// Each target is a list of ways to find it, tried in order. { css } = a selector; { text } = an
// element whose own words match (a regex source, case-insensitive), within `within` (a selector).
// `hidden: true` finds elements that are not visible (TikTok hides its file input). For lists
// (the product rows) page.rows() returns every match with its words. These follow Drew's walk
// through TikTok Studio (2026-10-04); when one misses, the step asks Groot (the AI fallback).
// More kinds of way (2026-10-06, page.js FIND): `near` (a regex the text AROUND the element must
// match, its label: "Who can watch this video"), `has` (a regex its own words must match), `notIn`
// (a selector it must not be inside), `valueRe` (a regex its value must match: a name field holding
// characters TikTok rejects), and `learned` (a description of an element Groot's AI found before).
const BTN = "button, [role=button], [role=menuitem], [role=option], [role=tab], a, label, div[tabindex], span[tabindex]";
const DLG = "[role=dialog]";
// Buttons and fields "in the dialog": TikTok's own modals too (TUXModal), which may not say
// role=dialog (the name step's Add was missed on Drew's post, 2026-10-05).
const DLG_ANY = `${DLG}, [aria-modal="true"], [class*="TUXModal"]`;
const inDlg = (sel) => DLG_ANY.split(",").flatMap((d) => sel.split(",").map((s) => `${d.trim()} ${s.trim()}`)).join(", ");
const DLG_BTN = inDlg("button, [role=button]");
const NOT_SEARCH = ':not([type=search]):not([placeholder*="search" i])';
const NAME_FIELD = inDlg(`input:not([type])${NOT_SEARCH}, input[type=text]${NOT_SEARCH}, textarea, [contenteditable=true]`);
const WHO = "who can (watch|view|see)";
const TARGETS = {
  // Upload → Videos, when the page did not open on the upload area
  uploadNav: [{ css: '[data-e2e="upload_nav"]' }, { text: "^upload$", within: "nav a, nav button, nav [role=button], aside a, aside button, a, button" }],
  videosTab: [{ css: '[data-e2e="upload_videos_tab"]' }, { text: "^videos?$", within: "[role=tab], button, a" }],
  fileInput: [{ css: 'input[type="file"][accept*="video"]', hidden: true }, { css: 'input[type="file"]', hidden: true }],
  // TikTok's own words when the file is up ("Uploaded", "Uploaded (25.1MB)", "Upload complete", "100%")
  uploaded: [{ css: '[data-e2e="upload_status_text"][data-status="success"]' }, { text: "^((uploaded|upload(ed)? (complete|completed|successful(ly)?))[.!]?(\\s*[(（][^)）]{0,40}[)）])?|100\\s*%)$", within: "div, span, p" }],
  uploadFailed: [{ text: "^(upload failed|couldn.t upload|upload error)", within: "div, span, p" }],
  // still going: "Uploading 45%", "Processing", a bare "45%", a progress bar (read for the log and the bar)
  uploadProgress: [{ text: "^(uploading|processing)\\b", within: "div, span, p" }, { text: "^\\d{1,2}(\\.\\d+)?\\s*%$", within: "div, span, p" }, { css: '[role=progressbar]:not([aria-valuenow="100"])' }],
  captionBox: [{ css: '[data-e2e="caption_container"] [contenteditable="true"]' }, { css: '.public-DraftEditor-content[contenteditable="true"]' }, { css: 'div[contenteditable="true"][role="combobox"]' }, { css: 'div[contenteditable="true"]' }],
  // Add link → Products → Next → search → pick → Next → (the name) → Add
  // TikTok Studio shows "Add link" as a label with a "+ Add" button beside it (Drew's post: the AI
  // pressed "Add" every time, 2026-10-05): an Add button next to the words "Add link".
  addLink: [{ css: '[data-e2e="add_link_button"]' }, { text: "^\\+?\\s*add link$", within: BTN }, { css: "button, [role=button]", has: "^\\+?\\s*add$", near: "\\b(add )?link\\b", notIn: DLG_ANY }],
  productsOption: [{ css: '[data-e2e="link_type_products"]' }, { text: "^((tiktok )?shop )?products?$", within: inDlg("[role=option], [role=tab], [role=radio], button, label, li") }],
  linkNext: [{ text: "^next$", within: DLG_BTN }],
  productSearch: [{ css: 'input[placeholder*="Search product" i]' }, { css: `${DLG} input[type="search"]` }, { css: `${DLG} input[placeholder*="Search" i]` }],
  // The product rows, most specific first. TikTok's showcase is a table with a radio per row; the old
  // last resort (`li`) read the PAGE NUMBERS under it as products ("1", "2", "3", "49": Drew's post,
  // 2026-10-05) and Groot gave up on a product that was there.
  productRows: [{ css: `${DLG} input[type=radio]`, rowOf: true }, { css: `${DLG} [role=radio]`, rowOf: true }, { css: `${DLG} [role=row]` }, { css: `${DLG} tbody tr` }, { priced: DLG }, { css: `${DLG} [role=option]` }],
  // The showcase's pages: numbered items and a next arrow under the table.
  // The showcase's page buttons under the table ("1", "2", "3" ... "49", and arrows with no words).
  productPages: [{ css: `${DLG} [class*="pagination" i] li, ${DLG} [class*="pagination" i] button, ${DLG} [class*="pager" i] li, ${DLG} [class*="pager" i] button` }, { css: `${DLG} li` }],
  productSelected: [{ css: `${DLG} input[type=radio]:checked, ${DLG} [role=radio][aria-checked=true]`, rowOf: true }, { css: `${DLG} [role=option][aria-selected=true], ${DLG} [role=row][aria-selected=true]` }],
  productNoResults: [{ text: "(no (products|results)( found)?|couldn.t find (any|that)|nothing found)", within: `${DLG} div, ${DLG} p, ${DLG} span` }],
  productNext: [{ text: "^next$", within: DLG_BTN }],
  // The link name field. TikTok's real one was missed by the first three (Drew's post, 2026-10-05:
  // "no name step showed", then Add refused a "|"): fields labelled name/title in the dialog, then
  // ANY text field in the dialog holding characters TikTok rejects.
  productNameInput: [
    { css: inDlg('input[name="productName"]') },
    { css: inDlg(`input[placeholder*="name" i]${NOT_SEARCH}, input[aria-label*="name" i]${NOT_SEARCH}, textarea[aria-label*="name" i], [data-e2e*="name" i] input${NOT_SEARCH}`) },
    { css: inDlg(`input[maxlength]${NOT_SEARCH}`) },
    { css: NAME_FIELD, near: "\\b(product|link) (name|title)\\b|^\\s*(name|title)\\b", notIn: "[role=row], tr, [role=listbox]" },
    { css: NAME_FIELD, valueRe: REJECTED_CHARS },
  ],
  productNameError: [{ text: "(invalid|unsupported|special|illegal|not (allowed|supported|valid))\\s*(characters?|symbols?|emojis?)|characters?.{0,40}(not|n.t) (allowed|supported|valid|accepted)|can.?t (contain|include|use)|cannot (contain|include|use)|only (letters|numbers|alphanumeric)|remove (the )?(special|invalid|unsupported)", within: `${inDlg("div, p, span")}, [role=alert], [class*=toast i], [class*=error i]` }],
  productAdd: [{ text: "^(\\+\\s*)?(add|confirm)$", within: DLG_BTN }],
  dialog: [{ css: DLG }],
  postButton: [{ css: 'button[data-e2e="post_video_button"]' }, { text: "^post( now)?$", within: "button" }],
  // a "Post now?" confirmation, only ever inside a dialog (never the page's own button twice)
  postNowDialog: [{ text: "^post now$", within: DLG_BTN }],
  posted: [{ text: "(everyone can see this|(only you|your friends|your followers|followers|friends) can see this|your video (has been|is being|was) (posted|published|uploaded)|video (posted|published)|manage your posts|high[- ]quality (version|upload))", within: "div, span, p, h1, h2, h3" }],
  // "Who can watch this video": TikTok's dropdown showing the choice (Everyone / Friends / Only you).
  privacyControl: [
    { css: '[data-e2e*="visibility" i] [role=combobox], [data-e2e*="visibility" i] button, [data-e2e*="visibility" i] [aria-haspopup], [data-e2e*="privacy" i] [role=combobox], [data-e2e*="privacy" i] button, [data-e2e*="privacy" i] [aria-haspopup]' },
    { css: "[role=combobox], [aria-haspopup], button, [role=button], select, div[tabindex]", has: PRIVACY_ANY, near: WHO, notIn: DLG_ANY },
  ],
  captcha: [{ css: '#captcha-verify-image, .captcha_verify_container, .captcha-verify-container, [class*="captcha_verify"], [id*="captcha-verify"], iframe[src*="captcha"]' }, { text: "(drag the (slider|puzzle)|verify to continue|select 2 objects that are the same shape)", within: "div, span, p" }],
  login: [{ css: '[data-e2e="login-modal"], [data-e2e="login-title"]' }, { text: "^log in to tiktok$", within: "h1, h2, div, span" }],
  // TikTok pushing back on the account (the cloud poster backs off for a day; never retries into a ban)
  spam: [{ text: "(you.re posting too (fast|often)|too many (posts|uploads|attempts|requests)|account (is |was |has been )?(banned|suspended|restricted)|temporarily (restricted|blocked|unable))", within: "div, span, p, h1, h2, h3" }],
};

// The steps of one post. Manual stops on the filled-in page (handoff) and watches for the creator's
// own Post; Auto presses Post now and waits for TikTok's success notice. No product = no product
// steps. Playlist and location are never touched: they stay empty. "Who can watch this video" is
// set (and read back) right before Post or the handoff (privacy, 2026-10-06).
// Speed (2026-10-05): the description and the product go in WHILE TikTok uploads the video (TikTok
// Studio shows the form as soon as the file is chosen). wait_processed comes last, right before
// Post, and checks the description again in case TikTok rewrote it when the upload finished.
const PRODUCT_STEPS = ["product_open", "product_tab", "product_search", "product_pick", "product_next", "product_name", "product_add"];
function planSteps({ mode, product }) {
  const steps = ["open", "upload", "caption"];
  if (product) steps.push(...PRODUCT_STEPS);
  steps.push("wait_processed", "privacy");
  if (mode === "manual") steps.push("handoff");
  else steps.push("post", "confirm_posted");
  return steps;
}

// How long each wait may take before the step asks Groot (the AI fallback) or the creator. Nothing
// waits silently: the upload waits long only while TikTok shows it moving.
const TIMEOUTS = {
  find: 8000,               // a button or box on a loaded page
  results: 6000,            // the showcase search results
  goto: 30000,              // a page load (TikTok Studio keeps loading things: carry on after this)
  processed: 15 * 60 * 1000, // the upload, at most, while TikTok shows it moving
  stall: 25000,             // the upload with nothing recognizable on screen (no progress, no "Uploaded") → Groot looks
  stuck: 3 * 60 * 1000,     // the upload showing the same progress this long → the creator
  posted: 60000,            // TikTok's success notice after Post
  creator: 2 * 60 * 1000,   // a step handed to the creator ("needs you") before this video gives up
  ai: 60000,                // one answer from Groot (Opus 5.5 with a reasoning budget; the platform's route allows 60 s)
  cdp: 15000,               // one page script or DevTools command
  blocker: 15 * 60 * 1000,  // a captcha or log-in the creator is doing
  handoff: 30 * 60 * 1000,  // Manual: the creator's own Post
};

// What the creator does when Groot can't (plain words, in the TikTok window's bar and in the app).
const STEP_HELP = {
  upload: "Groot can't find where to upload. In the TikTok window, open Upload and choose the video yourself.",
  wait_processed: "Groot can't tell if TikTok finished uploading. When the video shows as uploaded in the TikTok window, press Post yourself.",
  caption: "Groot couldn't write the description. In the TikTok window, click the description box and type it yourself.",
  product_open: "Groot can't find Add link. In the TikTok window, press Add link under the description.",
  product_tab: "In the TikTok window, choose Products in the Add link box, then press Next.",
  product_search: "In the TikTok window, search your showcase for the product.",
  product_pick: "In the TikTok window, select the product in the list.",
  product_next: "In the TikTok window, press Next in the product box.",
  product_name: "In the TikTok window, take the symbols (like | or emoji) out of the product name in the product box, then press Add.",
  product_add: "In the TikTok window, press Add in the product box. If TikTok says the name has characters it won't take, delete those characters first.",
  privacy: "In the TikTok window, set \"Who can watch this video\" to the choice you want before you post.",
  post: "Groot can't find the Post button. Press Post in the TikTok window.",
  confirm_posted: "Groot can't tell if it posted. Look at the TikTok window: if Post is still there, press it.",
};

// Which steps may ask Groot (their goals are a fixed table on the platform, STEP_GOALS). The product
// is never the AI's choice (a row it clicks is checked against the creator's words). On the name
// steps the AI may only type a cleaned name (nameFixes: TikTok's title with only the rejected
// characters out), never a name of its own (2026-10-06: Drew had to fix a "|" by hand).
const AI_STEPS = new Set(["upload", "wait_processed", "caption", "product_open", "product_tab", "product_search", "product_pick", "product_next", "product_name", "product_add", "privacy", "post", "confirm_posted"]);
// Steps whose AI fixes are LEARNED (recorded on the platform, tried first next time): presses on
// buttons, fields and options, never the product choice, the description or the upload.
const LEARNABLE = new Set(["product_open", "product_tab", "product_next", "product_name", "product_add", "privacy", "post"]);
const STEP_WORDS = {
  open: "Opening TikTok Studio",
  upload: "Uploading the video",
  wait_processed: "TikTok is processing the video",
  caption: "Writing the description",
  product_open: "Adding the product link",
  product_tab: "Adding the product link",
  product_search: "Finding the product in your showcase",
  product_pick: "Picking the product",
  product_next: "Picking the product",
  product_name: "Checking the product name",
  product_add: "Adding the product",
  privacy: "Checking who can watch",
  handoff: "Ready for you to post",
  post: "Posting",
  confirm_posted: "Checking it posted",
};
const NOT_IN_SHOWCASE = "That product isn't in your TikTok Shop showcase";

// ---- the AI fallback's actions, checked again on this side -----------------------------------
const KEYS = ["Enter", "Tab", "Escape", "Backspace"];
const MAX_AI_PER_STEP = 8;
const MAX_AI_PER_POST = 25;
// ---- what the AI and a learned fix may never press on a TikTok post step (2026-10-06 review) ------
// Drew's hard rule: TikTok's AI-generated and branded-content switches are never touched. Discard
// and Delete are never pressed. Post / Publish only on the post steps (never during Manual, never on
// the privacy or product steps). The same rules are on the platform (src/lib/groot-post.ts
// forbiddenFor) and checked again on a learned fix's element right before it is pressed.
const NEVER_TOUCH = /ai[\s-]*generated|\baigc\b|branded[\s-]*content|paid[\s-]*partnership|content[\s-]*disclosure|disclose|promotional[\s-]*content/i;
const NEVER_PRESS = /^\s*(discard|delete)\b/i;
const POST_WORDS = /^\s*(post( now)?|publish( now)?|schedule)\s*$/i;
const POST_E2E = /post_video_button|publish/i;
const POST_STEPS = new Set(["post", "confirm_posted"]);
function forbiddenFor(el, step) {
  if (!el || typeof el !== "object") return null;
  const own = [el.name, el.label, el.text].filter((t) => typeof t === "string" && t);
  const all = [...own, el.e2e, el.near].filter((t) => typeof t === "string" && t);
  if (all.some((t) => NEVER_TOUCH.test(t))) return "Groot never changes TikTok's AI-generated or branded-content settings.";
  if (own.some((t) => NEVER_PRESS.test(t))) return "Groot never discards or deletes anything.";
  if (!POST_STEPS.has(step) && (own.some((t) => POST_WORDS.test(t)) || POST_E2E.test(el.e2e || ""))) return "Groot only presses Post when it's time to post.";
  return null;
}

// `step` (the TikTok engine's step; trybe and reads leave it out) turns on the post-step rules:
// forbiddenFor on every element pressed, typed into or emptied (and every element under a point
// click), and on the name steps only a cleaned name typed into a field of the dialog, never an
// emptied box or a Backspace (the product's name is never the AI's to change).
function validateAction(a, view, values, step) {
  const stop = (message) => ({ action: "need_user", reason: "other", message });
  if (!a || typeof a !== "object") return stop("Groot couldn't work out the next step.");
  const els = (view && view.elements) || [];
  const has = (ref) => els.some((e) => e.ref === ref);
  const el = (ref) => els.find((e) => e.ref === ref) || null;
  const pw = (ref) => els.some((e) => e.ref === ref && (e.type === "password" || /password/i.test(e.name || "")));
  const nameStep = !!step && NAME_STEPS.has(step);
  const guard = (ref) => (step ? forbiddenFor(el(ref), step) : null);
  switch (a.action) {
    case "click":
      if (Number.isInteger(a.ref)) {
        if (!has(a.ref)) return stop("Groot pointed at something that isn't there.");
        if (pw(a.ref)) return { action: "need_user", reason: "password", message: "TikTok wants your password. Type it yourself." };
        const no = guard(a.ref);
        return no ? stop(no) : { action: "click", ref: a.ref };
      }
      if (Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 0 && a.y >= 0 && a.x <= view.width && a.y <= view.height) {
        if (step) {
          // a point on (or inside) something it may not press is the same as pressing it
          const area = (view.width || 1) * (view.height || 1);
          const under = els.filter((e) => a.x >= e.x && a.x <= e.x + e.w && a.y >= e.y && a.y <= e.y + e.h && e.w * e.h <= area / 4);
          const no = under.map((e) => forbiddenFor(e, step)).find(Boolean);
          if (no) return stop(no);
        }
        return { action: "click", x: a.x, y: a.y };
      }
      return stop("Groot pointed off the page.");
    case "type": {
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (!text || !values.map((v) => (v || "").trim()).filter(Boolean).includes(text)) return stop("Groot tried to type something that isn't this post's.");
      if (a.ref !== null && a.ref !== undefined && (!Number.isInteger(a.ref) || !has(a.ref))) return stop("Groot pointed at something that isn't there.");
      if (Number.isInteger(a.ref) && pw(a.ref)) return { action: "need_user", reason: "password", message: "TikTok wants your password. Type it yourself." };
      if (nameStep) {
        const f = Number.isInteger(a.ref) ? el(a.ref) : null;
        if (!f || !f.dlg || f.type === "search" || f.disabled) return stop("Groot may only fix the product name in its own field.");
      }
      if (Number.isInteger(a.ref) && guard(a.ref)) return stop(guard(a.ref));
      return { action: "type", text, ref: Number.isInteger(a.ref) ? a.ref : null, ...(a.clear === true ? { clear: true } : {}) };
    }
    // empty a box (select all, delete) before typing into it again
    case "clear":
      if (!Number.isInteger(a.ref) || !has(a.ref)) return stop("Groot pointed at something that isn't there.");
      if (pw(a.ref)) return { action: "need_user", reason: "password", message: "TikTok wants your password. Type it yourself." };
      if (nameStep) return stop("Groot never empties the product name.");
      if (guard(a.ref)) return stop(guard(a.ref));
      return { action: "clear", ref: a.ref };
    case "press":
      if (nameStep && a.key === "Backspace") return stop("Groot never deletes from the product name.");
      return KEYS.includes(a.key) ? { action: "press", key: a.key } : stop("Groot tried a key it isn't allowed to press.");
    case "scroll": return Number.isFinite(a.dy) ? { action: "scroll", dy: Math.max(-2000, Math.min(2000, a.dy)) } : stop("Groot couldn't work out the next step.");
    case "wait": return { action: "wait", ms: Math.max(300, Math.min(5000, Number(a.ms) || 1500)) };
    case "done": return { action: "done" };
    case "need_user": return { action: "need_user", reason: ["captcha", "login", "password", "other"].includes(a.reason) ? a.reason : "other", message: str(a.message, 200) || "TikTok needs you for a moment." };
    default: return stop("Groot couldn't work out the next step.");
  }
}

// The text the AI may type on a step: the caption, the product, and on the name steps the cleaned
// names of what TikTok shows in the dialog. The platform allows the same (groot-post.ts).
// On the name steps ONLY the cleaned names (2026-10-06 review: the caption or the product typed with
// clear into the name field would have renamed the product).
function typeValues(step, job, view) {
  if (NAME_STEPS.has(step)) return nameFixes(view);
  return [captionText(job.caption, job.hashtags), job.product || ""];
}
// A plan from the AI: at most this many actions in one answer (the platform caps it too).
const MAX_PLAN = 5;

// ---- learning (2026-10-06) ------------------------------------------------------------------------
// When the AI gets a LEARNABLE step done, what it pressed is kept on the platform (per creator, and
// for everyone without anything personal) as a recipe: [{ do: click | clear | type | press,
// target: an element's description, value?: "clean_name", key? }]. Later posts try the recipe
// FIRST; a recipe that misses is reported and demoted (the platform stops serving it after misses
// in a row), so a stale one is never trusted for long.
// An element as the snapshot saw it → its description: role, tag, its own words or aria-label,
// data-e2e, placeholder, type, in a dialog or not, the words around it. A privacy option's words
// are a VALUE (the job's choice), so they are kept out and marked instead.
const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
function describeElement(e) {
  if (!e || typeof e !== "object") return null;
  const d = { role: clip(e.role, 30), tag: clip(e.tag, 20) };
  const text = clip(e.text, 80);
  const label = clip(e.label, 80);
  if (text && text.length <= 60) d.text = text;
  if (label && label.length <= 60) d.label = label;
  if (e.e2e) d.e2e = clip(e.e2e, 60);
  if (e.ph) d.ph = clip(e.ph, 60);
  if (e.type) d.type = clip(e.type, 20);
  if (e.dlg) d.dlg = true;
  if (e.near) d.near = clip(e.near, 60);
  const pv = new RegExp(PRIVACY_ANY, "i");
  if ((d.text && pv.test(d.text)) || (d.label && pv.test(d.label))) { delete d.text; delete d.label; d.privacy = true; }
  if (d.near && pv.test(d.near) && !new RegExp(WHO, "i").test(d.near)) delete d.near;
  return d.role || d.tag ? d : null;
}
// Before a fix leaves this computer: any words of THIS post (caption, hashtags, product) come out of
// its descriptions (the platform checks again before it keeps anything).
function scrubRecipe(recipe, job) {
  const words = new Set([job && job.caption, ...((job && job.hashtags) || []), job && job.product].filter(Boolean).join(" ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
  const mine = (t) => typeof t === "string" && t.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => words.has(w));
  return recipe.map((a) => {
    if (!a || !a.target) return a;
    const t = { ...a.target };
    for (const k of ["text", "label", "ph", "near"]) if (mine(t[k]) || (typeof t[k] === "string" && /[#@]/.test(t[k]))) delete t[k];
    return { ...a, target: t };
  });
}
const OPTION_ROLES = /^(option|menuitem|menuitemradio|radio|li|label)$/;
// The ways to find a learned target now. A privacy OPTION is found by the job's choice; anything
// else by its description (page.js FIND `learned`).
function learnedWays(target, privacy = "everyone") {
  if (!target || typeof target !== "object") return [];
  if (target.privacy && (OPTION_ROLES.test(target.role || "") || OPTION_ROLES.test(target.tag || ""))) return privacyOptionWays(privacy);
  return [{ learned: target }];
}
// The page variant a fix was found on: the address's path (numbers folded) and the open dialog's
// title, so a fix for the product box is told apart from one for the upload page.
function variantOf(view) {
  let p = "";
  try { p = new URL(view.url).pathname.toLowerCase().replace(/\d+/g, "#").replace(/\/+$/, ""); } catch { p = ""; }
  const d = String((view && view.dialog) || "").toLowerCase().replace(/[^\p{L} ]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return `${p}|${d}`;
}
const RECIPE_DO = new Set(["click", "clear", "type", "press"]);
// A recipe from the platform, checked before it is used: known actions, targets that describe
// something, at most MAX_PLAN + 1 actions. With the step: nothing forbiddenFor (the AI-generated /
// branded-content switches, Discard, Delete, Post off the post steps), and on the name steps no
// emptied box and no Backspace (a learned fix never changes the product name beyond cleaning it).
function isRecipe(r, step) {
  if (!(Array.isArray(r) && r.length > 0 && r.length <= MAX_PLAN + 1 && r.every((a) => a && RECIPE_DO.has(a.do) && (a.do === "press" ? KEYS.includes(a.key) : a.target && typeof a.target === "object" && (a.target.role || a.target.tag)) && (a.do !== "type" || a.value === "clean_name")))) return false;
  // typing and emptying only ever in a dialog's field (never the description box)
  if (r.some((a) => (a.do === "type" || a.do === "clear") && a.target.dlg !== true)) return false;
  if (!step) return true;
  if (NAME_STEPS.has(step) && r.some((a) => a.do === "clear" || (a.do === "press" && a.key === "Backspace"))) return false;
  return !r.some((a) => a.target && forbiddenFor({ ...a.target, name: a.target.text || a.target.label }, step));
}

// ---- human pacing --------------------------------------------------------------------------------
// Never an instant burst: a pause before every click, a key at a time in small chunks while typing.
// `pace` scales everything (the harness runs at 0.15); `rand` is injectable for tests.
// 2026-10-05 (Drew's first real post was "extremely slow"): small pauses, ~0.5-1.2 s around a click,
// 0.3-0.9 s between steps. Polling only reads the page (nothing a person would see), so it is quick:
// a step moves on as soon as TikTok is ready.
const DELAYS = { beforeClick: [300, 700], afterClick: [200, 500], keyChunk: [25, 80], betweenSteps: [300, 900], poll: [250, 450] };
function delay(kind, pace = 1, rand = Math.random) {
  const [lo, hi] = DELAYS[kind] || [300, 600];
  return Math.round((lo + (hi - lo) * rand()) * pace);
}
// Typing goes in chunks of 1 to 4 characters.
function chunks(text, rand = Math.random) {
  const out = [];
  for (let i = 0; i < text.length;) { const n = 1 + Math.floor(rand() * 4); out.push(text.slice(i, i + n)); i += n; }
  return out;
}

module.exports = { isProductRow, SHOWCASE_PAGES,
  TIKTOK_STUDIO_URL, TIKTOK_UPLOAD_URL, PLATFORMS, TARGETS, AI_STEPS, STEP_WORDS, STEP_HELP, TIMEOUTS, PRODUCT_STEPS, KEYS, MAX_AI_PER_STEP, MAX_AI_PER_POST, DELAYS, NOT_IN_SHOWCASE, PICK_AT,
  normCaption, captionParts, showcaseList,
  isAllowedCaller, isVideoUrl, isTikTokUrl, isLoginProviderUrl, parseSource, validatePostRequest, captionText, safeFileName,
  productWords, productScore, pickProduct, searchTerms, cleanProductName, nameFixes, NAME_STEPS, MAX_VALUE, REJECTED_CHARS,
  PRIVACY, PRIVACY_VALUES, parsePrivacy, privacyOf, privacyOptionWays,
  LEARNABLE, MAX_PLAN, typeValues, describeElement, learnedWays, variantOf, isRecipe, scrubRecipe, forbiddenFor,
  planSteps, validateAction, delay, chunks,
};
