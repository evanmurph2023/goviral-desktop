// Groot posts to Trybe (jointrybe.com, "like TikTok Shop for UGC ads", Meta whitelisted ads): the
// pure rules (no Electron, no network), so scripts/tiktok-unit.cjs proves them with plain Node and
// the cloud poster (goviral-platform poster/engine) runs the same file.
//
// What we know about Trybe (read from its PUBLIC pages and scripts, 2026-10-05, never signed in):
//   - a Next.js app at https://jointrybe.com; sign-in at /auth/login: Email address + Password
//     (Supabase auth at https://sup.jointrybe.com, signInWithPassword). A new account confirms
//     its email with a code (/auth/verify-email); sign-in itself has no code and no magic link.
//   - the signed-in session lives in the browser's localStorage, key "sb-sup-auth-token" (a JSON
//     with access_token, refresh_token, expires_at, user). No session cookie. Supabase refreshes
//     the access token with the refresh token on load and ROTATES the refresh token, so the
//     saved login must be saved again after every run.
//   - the creator portal: /creator (Home: "My Brands"), a brand at /creator/brands/<id>, and the
//     sidebar's "Create Content" opens /creator/brands/<id>?createContent=true. A submission is
//     an upload (POST /api/creator/submissions/upload-url → { submissionId, uploadUrl }) then
//     .../submissions/<id>/complete with the creator's comment (the caption we write).
// Drew's walk (he has never seen more): sign in → My brands → the brand ("Mad Rabbit") → Create
// content → Single submission → the video → (a caption) → submit. Everything past "My brands" is
// matched by words, and every step falls back to the AI when the page differs.
//
// NEVER: a password, a captcha, the content-rights / terms boxes, a product category, an angle, a
// payment. If Trybe insists on one of those the post stops for the creator (Manual).
"use strict";

const { productWords, productScore, PICK_AT, captionText } = require("./rules");

const TRYBE_ORIGIN = "https://jointrybe.com";
const TRYBE_LOGIN_URL = `${TRYBE_ORIGIN}/auth/login`;
const TRYBE_HOME_URL = `${TRYBE_ORIGIN}/creator`;
const NOT_IN_BRANDS = "That brand isn't in your Trybe brands";

// ---- where the Trybe window may go --------------------------------------------------------------
// Trybe itself and its Supabase auth host (an email link lands there first). Nothing else.
const TRYBE_HOST = /^(www\.)?jointrybe\.com$|^sup\.jointrybe\.com$/i;
function isTrybeUrl(url, { allowLocal = false } = {}) {
  try {
    const u = new URL(url);
    if (allowLocal && u.protocol === "http:" && u.hostname === "127.0.0.1") return true;
    return u.protocol === "https:" && TRYBE_HOST.test(u.hostname);
  } catch { return false; }
}
// Trybe's sign-in / sign-up / verify pages: a logged-out state.
const LOGIN_PATH = /\/auth\/(login|signup|sign-up|verify-email|forgot-password|reset-password)\b/i;
const isTrybeLoginUrl = (url) => { try { return LOGIN_PATH.test(new URL(url).pathname); } catch { return false; } };
// A brand page: /creator/brands/<id>
const BRAND_PAGE = /\/creator\/brands\/([^/?#]+)/i;
const brandIdOf = (url) => { try { const m = BRAND_PAGE.exec(new URL(url).pathname); return m ? decodeURIComponent(m[1]) : null; } catch { return null; } };

// ---- the saved login ------------------------------------------------------------------------------
// A Playwright storageState that can still be signed in: Trybe's Supabase session in localStorage
// with a refresh token (the access token may be expired: Trybe refreshes it on load).
const SESSION_KEY = /^sb-[a-z0-9-]+-auth-token$/i;
function trybeSessionOf(state, origin = TRYBE_ORIGIN) {
  const origins = state && Array.isArray(state.origins) ? state.origins : [];
  const want = (() => { try { return new URL(origin).origin; } catch { return origin; } })();
  for (const o of origins) {
    if (!o || o.origin !== want || !Array.isArray(o.localStorage)) continue;
    for (const kv of o.localStorage) {
      if (!kv || !SESSION_KEY.test(kv.name || "")) continue;
      try {
        const v = JSON.parse(kv.value);
        const s = v && v.currentSession ? v.currentSession : v; // older supabase-js wrapped it
        if (s && typeof s.refresh_token === "string" && s.refresh_token) return { key: kv.name, refreshToken: s.refresh_token, expiresAt: Number(s.expires_at) || null, email: (s.user && typeof s.user.email === "string" && s.user.email) || null, userId: (s.user && s.user.id) || null };
      } catch { /* not a session */ }
    }
  }
  return null;
}
const hasTrybeSession = (state, origin) => !!trybeSessionOf(state, origin);
// What the phone may hand over (the platform keeps only this): Trybe's own origin, its session key.
function pickTrybeState(raw, origin = TRYBE_ORIGIN) {
  const s = trybeSessionOf(raw, origin);
  if (!s) return null;
  const o = raw.origins.find((x) => x.origin === new URL(origin).origin);
  const kv = o.localStorage.find((x) => x.name === s.key);
  return { cookies: [], origins: [{ origin: o.origin, localStorage: [{ name: kv.name, value: String(kv.value).slice(0, 20000) }] }] };
}

// ---- the brand ------------------------------------------------------------------------------------
// The brand is the creator's pick ("Mad Rabbit"); the page has Trybe's name for it ("Mad Rabbit
// Tattoo"). Words, as for the TikTok product: every one of the creator's words (3 in 4 for longer
// names), the closest title wins. Nothing good enough = not their brand: Groot never posts to another.
function pickBrand(want, rows) {
  let best = null;
  for (const r of rows || []) {
    const score = productScore(want, r.text);
    if (score < PICK_AT) continue;
    const extra = productWords(r.text).length;
    if (!best || score > best.score || (score === best.score && extra < best.extra)) best = { ...r, score, extra };
  }
  return best;
}
const brandMatches = (want, text) => productScore(want, text) >= PICK_AT;

// The submission's id when the page shows one: an address (/submissions/<id>), a link, or words
// ("Submission ID: abc123").
const SUBMISSION_URL = /\/submissions?\/([A-Za-z0-9_-]{6,80})(?:[/?#]|$)/i;
const SUBMISSION_TEXT = /submission\s*(?:id|#|no\.?|number)\s*[:#]?\s*([A-Za-z0-9_-]{4,80})/i;
function submissionIdFrom({ url, links, text } = {}) {
  for (const u of [url, ...(links || [])]) {
    if (!u) continue;
    try { const m = SUBMISSION_URL.exec(new URL(u, TRYBE_ORIGIN).pathname + "/"); if (m && !/^(list|pending|new|create)$/i.test(m[1])) return m[1]; } catch { /* not a url */ }
  }
  const m = SUBMISSION_TEXT.exec(String(text || ""));
  return m ? m[1] : null;
}

// ---- the scripted steps ---------------------------------------------------------------------------
const BTN = "button, [role=button], [role=menuitem], [role=option], [role=tab], [role=radio], a, label, div[tabindex], span[tabindex]";
const DLG = "[role=dialog]";
const TARGETS = {
  // logged out: Trybe's sign-in form (a password box anywhere), its heading
  login: [{ css: 'input[type="password"]' }, { text: "^sign in to your account$", within: "h1, h2, h3, div, p" }],
  captcha: [
    { css: 'iframe[src*="challenges.cloudflare.com"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"], .cf-turnstile, .h-captcha, .g-recaptcha, [id*="captcha" i], [class*="captcha" i]' },
    { text: "(verify (that )?you are (a )?human|i.m not a robot|complete the (security )?check|are you a robot)", within: "div, span, p, h1, h2, label" },
  ],
  rateLimit: [{ text: "(too many (requests|attempts|submissions|uploads)|rate.?limit(ed)?|slow down|you.ve reached (the|your) (daily |weekly |submission |upload )?limit|account (is |has been )?(suspended|restricted|banned))", within: "div, span, p, h1, h2, h3, [role=alert]" }],
  // My brands: every brand the creator works with is a link to its page
  brandLinks: [{ css: 'a[href*="/creator/brands/"]' }],
  brandsNav: [{ css: 'a[href$="/creator/brands"]' }, { text: "^(my )?brands$", within: "nav a, aside a, nav button, aside button, a, button, [role=tab]" }],
  viewAllBrands: [{ text: "^(view|see) all( brands)?$", within: BTN }],
  brandSearch: [{ css: `${DLG} input[placeholder*="Search" i]` }, { css: 'input[placeholder*="Search brand" i]' }, { css: 'input[type="search"]' }],
  brandNoResults: [{ text: "(no brands found|no results found|couldn.t find any brands|you (don.t|do not) have any brands|no brands yet)", within: "div, p, span, h2, h3" }],
  // the brand's own page names it
  brandTitle: [{ best: "h1, h2, h3, header, [class*=brand i], [data-brand-name]" }],
  // Create content (the brand page's button; the sidebar's opens the same thing)
  createContent: [{ css: '[data-testid*="create-content" i]' }, { text: "^\\+?\\s*create (new )?content$", within: BTN }],
  // Single submission (vs Bulk): a card, a button or a radio
  singleSubmission: [{ css: '[data-testid*="single" i]' }, { text: "^single( submission| upload| video)?\\b", within: `${DLG} button, ${DLG} [role=button], ${DLG} [role=radio], ${DLG} [role=option], ${DLG} [role=tab], ${DLG} label, ${DLG} a, ${DLG} div, ${BTN}` }],
  choiceNext: [{ text: "^(next|continue)$", within: `${DLG} button, ${DLG} [role=button]` }],
  // the form's own file input first (a profile photo input elsewhere on the page is never it)
  fileInput: [{ css: `${DLG} input[type="file"][accept*="video"]`, hidden: true }, { css: `${DLG} input[type="file"]`, hidden: true }, { css: 'input[type="file"][accept*="video"]', hidden: true }],
  uploading: [{ text: "^(uploading|processing|preparing)\\b", within: "div, span, p" }, { text: "^(?!100)\\d{1,2}\\s?%$", within: "div, span, p" }],
  uploaded: [{ css: '[data-upload-status="done"], [data-status="uploaded"]' }, { text: "^(uploaded|upload complete|ready to submit|100\\s?%)$", within: "div, span, p" }, { css: `${DLG} video` }],
  uploadFailed: [{ text: "^(upload failed|couldn.t upload|upload error|failed to upload)", within: "div, span, p, [role=alert]" }],
  captionBox: [
    { css: 'textarea[placeholder*="caption" i], textarea[name*="caption" i]' },
    { css: 'textarea[placeholder*="description" i], textarea[name*="description" i], textarea[name*="comment" i], textarea[placeholder*="comment" i], textarea[placeholder*="note" i]' },
    { css: `${DLG} textarea` }, { css: "textarea" }, { css: `${DLG} [contenteditable="true"]` },
  ],
  submitButton: [{ css: '[data-testid*="submit" i]' }, { text: "^(submit|submit (content|video|submission|for review)|send( to (the )?brand)?)$", within: "button, [role=button]" }],
  // the content-rights / terms box Groot never ticks
  terms: [{ text: "(i (agree|accept)|content (rights|usage)|usage rights|terms (of|and) (service|conditions|use))", within: "label, [role=checkbox], [role=switch]" }],
  // a field Trybe says is required (a category, an angle): the creator's choice, never Groot's
  required: [{ text: "^(this field is required|required|please (select|choose|pick)\\b.*|select (a|at least one) (category|angle|product)\\b.*)$", within: "div, span, p, [role=alert]" }],
  // "Submit this video?" after Submit, only inside a dialog (never Submit twice)
  confirmDialog: [{ text: "^(confirm|yes(,? submit( it)?)?)$", within: `${DLG} button, ${DLG} [role=button]` }],
  submitted: [{ text: "(submission (received|submitted|sent|created|complete)|submitted( successfully)?!?$|successfully submitted|thanks for (your )?submi|we.ll (review|let you know)|(under|pending|in) review|sent to (the )?brand)", within: "div, span, p, h1, h2, h3, [role=status], [role=alert]" }],
  submissionLinks: [{ css: 'a[href*="/submissions/"], a[href*="/submission/"]' }],
  dialog: [{ css: DLG }],
};

// The steps of one Trybe post. Manual stops on the filled-in form (handoff) and watches for the
// creator's own Submit; Auto presses Submit and waits for Trybe's confirmation.
function planTrybeSteps({ mode }) {
  const steps = ["trybe_open", "trybe_brand", "trybe_create", "trybe_single", "trybe_upload", "trybe_wait", "trybe_caption"];
  if (mode === "manual") steps.push("handoff");
  else steps.push("trybe_submit", "trybe_confirm");
  return steps;
}
// Which steps may ask Groot (the platform's STEP_GOALS has a goal for each). Never trybe_open.
// A brand the AI opens is still held to the creator's words (CHECK.trybe_brand).
const TRYBE_AI_STEPS = new Set(["trybe_brand", "trybe_create", "trybe_single", "trybe_upload", "trybe_wait", "trybe_caption", "trybe_submit", "trybe_confirm"]);
const TRYBE_STEP_WORDS = {
  trybe_open: "Opening Trybe",
  trybe_brand: "Opening the brand in My brands",
  trybe_create: "Opening Create content",
  trybe_single: "Choosing Single submission",
  trybe_upload: "Adding the video",
  trybe_wait: "Trybe is uploading the video",
  trybe_caption: "Writing the caption",
  handoff: "Ready for you to submit",
  trybe_submit: "Submitting",
  trybe_confirm: "Checking Trybe got it",
};
// The text Groot types into Trybe's caption box: the same string the platform lets the AI type
// (src/lib/groot-cloud-db.ts takeCloudAiStep): the caption, then the hashtags.
const trybeCaption = (caption, hashtags) => captionText(caption, hashtags);
// What to type into a brand search: the brand as said, then its first word.
function brandSearchTerms(brand) {
  const full = String(brand || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const first = full.split(" ").find((w) => w.length > 1);
  return [full, first].filter((t, i, a) => t && a.indexOf(t) === i);
}

module.exports = {
  TRYBE_ORIGIN, TRYBE_LOGIN_URL, TRYBE_HOME_URL, NOT_IN_BRANDS, TRYBE_TARGETS: TARGETS, TRYBE_AI_STEPS, TRYBE_STEP_WORDS, SESSION_KEY,
  isTrybeUrl, isTrybeLoginUrl, brandIdOf, trybeSessionOf, hasTrybeSession, pickTrybeState, pickBrand, brandMatches, submissionIdFrom, planTrybeSteps, trybeCaption, brandSearchTerms,
};
