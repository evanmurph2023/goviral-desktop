// Groot posts to TikTok: the pure rules (no Electron, no network), so scripts/tiktok-unit.cjs can
// prove them with plain Node.
//   - what the app may ask for (validatePostRequest) and who may ask (isAllowedCaller)
//   - which addresses the TikTok window may show (isTikTokUrl, isLoginProviderUrl)
//   - where a finished export may be downloaded from (isVideoUrl)
//   - the scripted steps for one post (planSteps) and the selectors they try (TARGETS)
//   - the AI fallback's actions, checked again here before anything runs (validateAction)
//   - human pacing (delay)
"use strict";

const TIKTOK_UPLOAD_URL = "https://www.tiktok.com/tiktokstudio/upload";
const MODES = ["auto", "manual"];

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

// The request the app sends for one video. Everything is checked here, in the main process: the
// page can be anything, so nothing it sends is trusted as-is.
function validatePostRequest(raw, { allowLocal = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send one post." };
  const postId = str(raw.postId, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(postId)) return { ok: false, error: "Bad post id." };
  const videoUrl = typeof raw.videoUrl === "string" ? raw.videoUrl.trim() : "";
  if (!isVideoUrl(videoUrl, { allowLocal })) return { ok: false, error: "That video isn't a GoViral export." };
  const mode = MODES.includes(raw.mode) ? raw.mode : null;
  if (!mode) return { ok: false, error: "Pick Auto or Manual." };
  const caption = str(raw.caption, 300).replace(/\s*[—–]\s*/g, ", ");
  const hashtags = Array.isArray(raw.hashtags) ? raw.hashtags.map((h) => str(h, 41).replace(/^#/, "")).filter((h) => HASHTAG.test(h)).slice(0, 5) : [];
  const product = raw.product === null || raw.product === undefined ? null : str(raw.product, 80) || null;
  const name = str(raw.name, 120) || "GoViral video";
  return { ok: true, value: { postId, videoUrl, mode, caption, hashtags, product, name } };
}

// The text that goes into TikTok's caption box: the caption, then the hashtags. The platform builds
// the same string (src/lib/groot-post-db.ts takeAiStep), which is the only text the AI may type.
function captionText(caption, hashtags) {
  return [caption || "", (hashtags || []).map((h) => `#${h}`).join(" ")].filter(Boolean).join(" ").trim();
}

// A file name for the downloaded export (TikTok shows it while uploading).
function safeFileName(name) {
  const base = String(name || "GoViral video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "GoViral video";
  return `${base}.mp4`;
}

// ---- the scripted steps -------------------------------------------------------------------------
// Each target is a list of ways to find it, tried in order. { css } = a selector; { text } = an
// element whose own words match (a regex source, case-insensitive), within `within` (a selector);
// { best: css } = the element among these whose words best match the product name. `hidden: true`
// finds elements that are not visible (TikTok hides its file input). These are best guesses at
// TikTok Studio's upload page; when one misses, the step asks Groot (the AI fallback).
const BTN = "button, [role=button], [role=menuitem], [role=option], [role=tab], a, label, div[tabindex], span[tabindex]";
const TARGETS = {
  fileInput: [{ css: 'input[type="file"][accept*="video"]', hidden: true }, { css: 'input[type="file"]', hidden: true }],
  uploaded: [{ css: '[data-e2e="upload_status_text"][data-status="success"]' }, { text: "^(uploaded|upload complete|100%)$", within: "div, span, p" }],
  uploadFailed: [{ text: "^(upload failed|couldn.t upload|upload error)", within: "div, span, p" }],
  captionBox: [{ css: '[data-e2e="caption_container"] [contenteditable="true"]' }, { css: '.public-DraftEditor-content[contenteditable="true"]' }, { css: 'div[contenteditable="true"][role="combobox"]' }, { css: 'div[contenteditable="true"]' }],
  addLink: [{ css: '[data-e2e="add_link_button"]' }, { text: "^\\+?\\s*add link$", within: BTN }],
  productsOption: [{ css: '[data-e2e="link_type_products"]' }, { text: "^products?$", within: BTN }],
  linkNext: [{ text: "^next$", within: '[role=dialog] button, [role=dialog] [role=button]' }],
  productSearch: [{ css: 'input[placeholder*="Search product" i]' }, { css: '[role=dialog] input[type="search"]' }, { css: '[role=dialog] input[placeholder*="Search" i]' }],
  productRows: [{ best: '[role=dialog] [role=radio], [role=dialog] [role=option], [role=dialog] tr, [role=dialog] li, [role=dialog] label' }],
  productConfirm: [{ text: "^(next|add|confirm|save|done)$", within: '[role=dialog] button, [role=dialog] [role=button]' }],
  dialog: [{ css: '[role=dialog]' }],
  postButton: [{ css: 'button[data-e2e="post_video_button"]' }, { text: "^post$", within: "button" }],
  postNow: [{ text: "^post now$", within: BTN }],
  posted: [{ text: "(your video (has been|is being|was) (posted|published|uploaded)|video published|manage your posts)", within: "div, span, p, h1, h2, h3" }],
  captcha: [{ css: '#captcha-verify-image, .captcha_verify_container, .captcha-verify-container, [class*="captcha_verify"], [id*="captcha-verify"], iframe[src*="captcha"]' }, { text: "(drag the (slider|puzzle)|verify to continue|select 2 objects that are the same shape)", within: "div, span, p" }],
  login: [{ css: '[data-e2e="login-modal"], [data-e2e="login-title"]' }, { text: "^log in to tiktok$", within: "h1, h2, div, span" }],
};

// The steps of one post. Manual stops on the filled-in page (handoff) and watches for the creator's
// own Post; Auto presses Post and confirms it went out. No product = no product steps.
function planSteps({ mode, product }) {
  const steps = ["open", "upload", "wait_processed", "caption"];
  if (product) steps.push("product_open", "product_tab", "product_search", "product_pick", "product_confirm");
  if (mode === "manual") steps.push("handoff");
  else steps.push("post", "confirm_posted");
  return steps;
}

// Which steps may ask Groot (their goals are a fixed table on the platform, STEP_GOALS).
const AI_STEPS = new Set(["upload", "wait_processed", "caption", "product_open", "product_tab", "product_search", "product_pick", "product_confirm", "post", "confirm_posted"]);
const STEP_WORDS = {
  open: "Opening TikTok Studio",
  upload: "Uploading the video",
  wait_processed: "TikTok is processing the video",
  caption: "Writing the caption",
  product_open: "Tagging the product",
  product_tab: "Tagging the product",
  product_search: "Finding the product",
  product_pick: "Picking the product",
  product_confirm: "Adding the product",
  handoff: "Ready for you to post",
  post: "Posting",
  confirm_posted: "Checking it posted",
};

// ---- the AI fallback's actions, checked again on this side -----------------------------------
const KEYS = ["Enter", "Tab", "Escape", "Backspace"];
const MAX_AI_PER_STEP = 8;
const MAX_AI_PER_POST = 25;
function validateAction(a, view, values) {
  const stop = (message) => ({ action: "need_user", reason: "other", message });
  if (!a || typeof a !== "object") return stop("Groot couldn't work out the next step.");
  const els = (view && view.elements) || [];
  const has = (ref) => els.some((e) => e.ref === ref);
  const pw = (ref) => els.some((e) => e.ref === ref && (e.type === "password" || /password/i.test(e.name || "")));
  switch (a.action) {
    case "click":
      if (Number.isInteger(a.ref)) return !has(a.ref) ? stop("Groot pointed at something that isn't there.") : pw(a.ref) ? { action: "need_user", reason: "password", message: "TikTok wants your password. Type it yourself." } : { action: "click", ref: a.ref };
      if (Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 0 && a.y >= 0 && a.x <= view.width && a.y <= view.height) return { action: "click", x: a.x, y: a.y };
      return stop("Groot pointed off the page.");
    case "type": {
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (!text || !values.map((v) => (v || "").trim()).filter(Boolean).includes(text)) return stop("Groot tried to type something that isn't this post's.");
      if (a.ref !== null && a.ref !== undefined && (!Number.isInteger(a.ref) || !has(a.ref))) return stop("Groot pointed at something that isn't there.");
      if (Number.isInteger(a.ref) && pw(a.ref)) return { action: "need_user", reason: "password", message: "TikTok wants your password. Type it yourself." };
      return { action: "type", text, ref: Number.isInteger(a.ref) ? a.ref : null };
    }
    case "press": return KEYS.includes(a.key) ? { action: "press", key: a.key } : stop("Groot tried a key it isn't allowed to press.");
    case "scroll": return Number.isFinite(a.dy) ? { action: "scroll", dy: Math.max(-2000, Math.min(2000, a.dy)) } : stop("Groot couldn't work out the next step.");
    case "wait": return { action: "wait", ms: Math.max(300, Math.min(5000, Number(a.ms) || 1500)) };
    case "done": return { action: "done" };
    case "need_user": return { action: "need_user", reason: ["captcha", "login", "password", "other"].includes(a.reason) ? a.reason : "other", message: str(a.message, 200) || "TikTok needs you for a moment." };
    default: return stop("Groot couldn't work out the next step.");
  }
}

// ---- human pacing --------------------------------------------------------------------------------
// Never an instant burst: a pause before every click, a key at a time in small chunks while typing.
// `pace` scales everything (the harness runs at 0.2); `rand` is injectable for tests.
const DELAYS = { beforeClick: [350, 900], afterClick: [250, 700], keyChunk: [35, 120], betweenSteps: [600, 1400], poll: [900, 1300] };
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

module.exports = {
  TIKTOK_UPLOAD_URL, TARGETS, AI_STEPS, STEP_WORDS, KEYS, MAX_AI_PER_STEP, MAX_AI_PER_POST, DELAYS,
  isAllowedCaller, isVideoUrl, isTikTokUrl, isLoginProviderUrl, validatePostRequest, captionText, safeFileName,
  planSteps, validateAction, delay, chunks,
};
