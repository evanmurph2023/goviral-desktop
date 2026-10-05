// Groot READS the creator's accounts (2026-10-05): the pure rules (no Electron, no network), so
// scripts/tiktok-unit.cjs proves them with plain Node and the cloud poster (goviral-platform
// poster/engine) runs the same file. The engine that walks the pages is read-engine.js.
//
// Three reads (the contract with Groot's brain, branch groot-agent):
//   trybe_brands         → [{ id, name, logoUrl?, summary? }]  the creator's brands (My brands / View All)
//   trybe_brand          → { id, name, brief, requirements[], products: [{ name, url? }], examples[],
//                            dos[], donts[], deliverables[], payout, url, text, partial, missing[] }
//                            whatever the brand's page shows (`text` = the page as plain text, for
//                            the brain to read itself when the sections have unusual names)
//   tiktok_recent_posts  → [{ url, caption, postedAt, views? }]  TikTok Studio's posts list, newest first
// params: { brandId?, brand?, limit? }.
//
// Reading NEVER changes anything: navigation and reading only. Nothing that submits, applies, joins,
// accepts, saves, deletes, follows, posts or pays is ever pressed (isSafeToPress, checked on every
// scripted press AND every press the AI asks for), Enter is never pressed (it can submit a form),
// and coordinates are never clicked (only named things on the page). Everything read is HTML
// stripped and capped (cleanText, capReadResult).
"use strict";

const { validateAction, productScore, productWords, PICK_AT } = require("./rules");
const { TRYBE_TARGETS, brandIdOf, pickBrand } = require("./trybe");

const READS = { trybe_brands: "trybe", trybe_brand: "trybe", tiktok_recent_posts: "tiktok" };
const LIMITS = { trybe_brands: { def: 50, max: 100 }, trybe_brand: { def: 1, max: 1 }, tiktok_recent_posts: { def: 20, max: 50 } };
const BRAND_ID = /^[A-Za-z0-9_-]{1,80}$/;
const READ_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RESULT_BYTES = 60000;
const MAX = { name: 120, summary: 300, brief: 4000, item: 300, items: 40, products: 30, examples: 20, payout: 200, caption: 300, url: 500, text: 8000 };
// The AI fallback while reading: fewer tries than a post (nothing is at stake but a partial read).
const MAX_AI_PER_READ_STEP = 4;
const MAX_AI_PER_READ = 8;
const READ_STEPS = { trybe_brands: "read_trybe_brands", trybe_brand: "read_trybe_brand", tiktok_recent_posts: "read_tiktok_posts" };
const READ_STEP_WORDS = {
  read_open: "Opening the page",
  read_trybe_brands: "Reading your Trybe brands",
  read_trybe_brand: "Reading the brand's page",
  read_tiktok_posts: "Reading your recent TikTok posts",
  read_more: "Loading more",
};
// The goals the platform's next-action routes need for the read steps (STEP_GOALS there; README).
const READ_GOALS = {
  read_trybe_brands: "Show the list of the creator's brands on Trybe (My brands, View all, or the Brands page). Navigation only: never press Apply, Join, Accept, Submit, Create content, Save or anything that changes the account. Answer done when the brands (cards or links) are on screen.",
  read_trybe_brand: "Show this brand's campaign details on its Trybe page: the brief, do's and don'ts, deliverables, payout, products and example videos. Open tabs, 'Read more' or sections that hide them. Navigation only: never press Apply, Join, Accept, Submit, Create content, Save or anything that changes the account. Answer done when the details are on screen, or when the page has none.",
  read_tiktok_posts: "Show the creator's posted videos in TikTok Studio (Posts / Content). Navigation only: never edit, delete, post, change privacy or settings. Answer done when the list of posts is on screen.",
};

const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// ---- the request ------------------------------------------------------------------------------------
function validateReadRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send one read." };
  const read = typeof raw.read === "string" ? raw.read.trim() : "";
  if (!Object.prototype.hasOwnProperty.call(READS, read)) return { ok: false, error: "Read what?" };
  let p = raw.params;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  p = p && typeof p === "object" && !Array.isArray(p) ? p : {};
  const L = LIMITS[read];
  const n = Number(p.limit);
  const params = { limit: Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), L.max) : L.def };
  if (read === "trybe_brand") {
    const brandId = typeof p.brandId === "string" ? p.brandId.trim() : Number.isInteger(p.brandId) ? String(p.brandId) : "";
    const brand = str(p.brand, 120).replace(/[<>{}]/g, "").trim();
    if (brandId && !BRAND_ID.test(brandId)) return { ok: false, error: "That isn't a Trybe brand id." };
    if (!brandId && !brand) return { ok: false, error: "Which brand?" };
    if (brandId) params.brandId = brandId;
    if (brand) params.brand = brand;
  }
  const readId = typeof raw.readId === "string" && READ_ID.test(raw.readId) ? raw.readId : null;
  return { ok: true, value: { read, platform: READS[read], params, ...(readId ? { readId } : {}) } };
}

// ---- what is never pressed while reading ---------------------------------------------------------------
// Verbs that change something. "Payouts", "Posts", "Submissions", "Uploads" (nouns, nav) are fine.
const NEVER_PRESS = /\b(apply|applied|join|joined|submit|accept|agree|approve|decline|reject|confirm|send|save|delete|remove|archive|create|new|add|upload|post|repost|publish|request|claim|redeem|withdraw|cash ?out|pay|buy|purchase|checkout|order|subscribe|unsubscribe|follow|unfollow|connect|disconnect|link|unlink|invite|sign ?(out|up|in)|log ?(out|in)|logout|login|leave|cancel|edit|update|change|enable|disable|turn (on|off)|hide|unhide|pin|unpin|boost|promote|report|block|unblock|like|comment|reply|share|duplicate|download|message|chat|contact|book|start|continue|next step|verify|rate|review)\b/i;
// A label may name the brand being read ("Post Malone Merch"): its words don't count as verbs.
function isSafeToPress(label, names = []) {
  let t = String(label || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  for (const n of names || []) {
    if (!n || productScore(n, t) < PICK_AT) continue;
    for (const w of String(n).split(/\s+/).filter(Boolean)) t = t.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), " ");
  }
  return !NEVER_PRESS.test(t.replace(/\s+/g, " "));
}
// The AI's answer while reading, checked again here: the post rules (rules.js validateAction), then
// only named things that read (never a coordinate, a box, a file input or a switch), never Enter.
function validateReadAction(a, view, values = [], names = []) {
  const v = validateAction(a, view, values);
  const stop = (message) => ({ action: "need_user", reason: "other", message });
  if (v.action === "click") {
    if (v.ref === undefined) return stop("Groot only presses named links and tabs while reading.");
    const el = ((view && view.elements) || []).find((e) => e.ref === v.ref) || {};
    if (["file", "checkbox", "radio", "submit", "password"].includes(el.type) || ["checkbox", "switch", "radio"].includes(el.role)) return stop("Reading never ticks or picks anything.");
    if (!isSafeToPress(el.name, names)) return stop("Reading never presses that.");
  }
  if (v.action === "press" && v.key === "Enter") return stop("Reading never presses Enter.");
  return v;
}

// ---- cleaning ------------------------------------------------------------------------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/g;
const TAGS = (t) => t.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[a-z][^<>]*>/gi, " ");
function cleanText(v, max = 500, { lines = false } = {}) {
  let t = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  t = TAGS(t).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6}|#39);/gi, (m, e) => {
    if (e[0] === "#") { const c = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : " "; }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
  t = TAGS(t).replace(CTRL, "");
  t = lines ? t.split(/\r?\n/).map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim()).filter(Boolean).join("\n") : t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…` : t;
}
// An address to keep: http(s) only, absolute, no login in it.
function safeUrl(u, base) {
  if (!u || typeof u !== "string") return null;
  try {
    const x = new URL(String(u || ""), base || undefined);
    if (!/^https?:$/.test(x.protocol) || x.username || x.password) return null;
    const s = x.toString();
    return s.length <= MAX.url ? s : null;
  } catch { return null; }
}

// ---- Trybe: the brand list ---------------------------------------------------------------------------
// Cards as the page script (read-engine.js BRAND_CARDS) found them: { href, name, lines[], img }.
function brandsFromCards(cards, { base, limit = LIMITS.trybe_brands.def } = {}) {
  const out = [];
  const seen = new Set();
  for (const c of cards || []) {
    const url = safeUrl(c && c.href, base);
    const id = url && brandIdOf(url);
    if (!id || !BRAND_ID.test(id) || /^(new|create)$/i.test(id) || seen.has(id)) continue;
    try { if (new URL(url).searchParams.get("createContent")) continue; } catch { /* checked above */ }
    const lines = ((c && c.lines) || []).map((l) => cleanText(l, MAX.summary)).filter(Boolean);
    const name = cleanText(c.name, MAX.name) || lines[0] || "";
    if (!name) continue;
    seen.add(id);
    const rest = lines.filter((l) => l !== name && !/^(view|open|see)( brand| details)?$/i.test(l));
    const b = { id, name };
    const logo = safeUrl(c.img, base);
    if (logo) b.logoUrl = logo;
    const summary = cleanText(rest.join(" · "), MAX.summary);
    if (summary) b.summary = summary;
    out.push(b);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- Trybe: one brand's page ---------------------------------------------------------------------------
// The page as blocks (read-engine.js DUMP): { t: "h" | "li" | "p", level, text, href? } in reading
// order, from every tab and section Groot opened. Sections are found by their headings' words; a
// heading the rules don't know keeps its lines in `text` for the brain.
const SECTION = [
  ["donts", /\b(don.?ts|donts|do not|avoid|what not to|never|restrictions?|prohibited|not allowed)\b/i],
  ["dos", /\b(do.?s|dos|what to do|must( haves?)?|please do|include|key (points|messages)|talking points|mention)\b/i],
  ["payout", /\b(payouts?|pay|earn(ings)?|compensation|commission|rates?|rewards?|bount(y|ies)|per video|budget|fees?)\b/i],
  ["deliverables", /\b(deliverables?|what (we|you)(.?ll)? need|what to (make|create|deliver|submit|film)|requirements?|specs?|specifications?|formats?|video (length|requirements?|specs?)|content (requirements?|guidelines?)|guidelines?|instructions?)\b/i],
  ["products", /\b(products?|items?|what to feature|featured|skus?|shop)\b/i],
  ["examples", /\b(examples?|inspiration|references?|samples?|top (performing|videos|content)|winning|best (videos|content)|example videos?)\b/i],
  ["skip", /\b(your submissions?|my submissions?|submissions?|submission history|activity|analytics|notifications?)\b/i],
  ["brief", /\b(brief|about|overview|campaign|description|the ask|summary|details|what we.?re looking for|concept|goals?|objective|story|angle|hooks?|messaging)\b/i],
];
const sectionOf = (heading) => { for (const [k, re] of SECTION) if (re.test(heading)) return k; return "other"; };
const DO_MARK = /^(✅|✔️?|☑️?|👍|✓|\+|do:|do\s+-|dos?:)\s*/i;
const DONT_MARK = /^(❌|✖️?|🚫|⛔|👎|✗|x\s|-\s?don.?t|don.?t:?|do not:?|avoid:?|never:?)\s*/i;
const PAYOUT_LINE = /(\$\s?\d[\d,]*(\.\d+)?\s?(k\b)?(\s?(-|to)\s?\$?\s?\d[\d,]*(\.\d+)?)?(\s?(per|\/|a|each)\s?(approved\s)?(video|post|submission|content|piece|clip|month))?|\d{1,3}\s?%\s?(commission|of (sales|revenue)))/i;
const EXAMPLE_URL = /(tiktok\.com\/@[^/]+\/video\/|instagram\.com\/(reel|p)\/|youtube\.com\/(shorts\/|watch)|youtu\.be\/|vimeo\.com\/|\.mp4(\?|$)|drive\.google\.com\/)/i;
const LABEL_LINE = /^([A-Za-z][A-Za-z0-9 '’&/+-]{1,32}):\s+(.{1,600})$/;

function brandFromBlocks(dump, { id, base, name: wantName } = {}) {
  // t: "h" a heading, "b" a bold label (a heading only when its words name a section), "li", "p"
  const blocks = ((dump && dump.blocks) || []).map((b) => ({ t: ["h", "b", "li"].includes(b.t) ? b.t : "p", level: Number(b.level) || 4, text: cleanText(b.text, 1200), href: safeUrl(b.href, base) })).filter((b) => b.text);
  const out = { id: id || null, name: "", url: safeUrl(dump && dump.url, base), brief: "", requirements: [], dos: [], donts: [], deliverables: [], payout: null, products: [], examples: [], text: "" };
  // the name: the page's first big heading (or the creator's words when the page has none)
  const h1 = blocks.find((b) => b.t === "h" && b.level === 1) || blocks.find((b) => b.t === "h" && b.level <= 2);
  out.name = cleanText((h1 && h1.text) || (dump && dump.h1) || wantName || "", MAX.name);
  const brief = [];
  const lists = { dos: [], donts: [], deliverables: [], other: [] };
  const addItem = (list, t) => { const x = cleanText(t.replace(/^[•·\-–*]\s*/, ""), MAX.item); if (x && !list.includes(x) && list.length < MAX.items) list.push(x); };
  const addProduct = (name, url) => {
    const n = cleanText(name, MAX.name);
    if (!n || out.products.length >= MAX.products || out.products.some((p) => p.name === n || (url && p.url === url))) return;
    out.products.push(url ? { name: n, url } : { name: n });
  };
  const addExample = (title, url) => {
    const t = cleanText(title, MAX.item);
    if ((!t && !url) || out.examples.length >= MAX.examples || out.examples.some((e) => (url && e.url === url) || (!url && e.title === t))) return;
    out.examples.push(url ? { title: t || url, url } : { title: t });
  };
  // Before any heading (the tagline under the name, a page with no headings): the brief.
  let section = "brief";
  let sectionLevel = 1;
  const lines = [];
  for (const b of blocks) {
    let text = b.text;
    if (b.t === "h" || b.t === "b") {
      const h = text.replace(/:$/, "");
      const s = /\bdo.?s\b/i.test(h) && /\bdon.?ts\b/i.test(h) ? "dosdonts" : sectionOf(h);
      // A heading the rules don't know, under a section's own heading (a product card's name under
      // "Products"), or a bold line that isn't a section's name: a line of the section it is in.
      const label = LABEL_LINE.test(text);
      if (b !== h1 && s === "other" && (b.t === "b" || b.level > sectionLevel) && section !== "brief") b.t = "p";
      else if (b.t === "b" && (s === "other" || label)) b.t = "p";
      else {
        lines.push(`## ${text}`);
        if (b === h1) { section = "brief"; sectionLevel = 1; continue; }
        section = s;
        sectionLevel = b.t === "h" ? b.level : 6;
        if (section === "payout" && !out.payout && PAYOUT_LINE.test(text)) out.payout = cleanText(text, MAX.payout);
        continue;
      }
    }
    lines.push(b.t === "li" ? `- ${text}` : text);
    // "Payout: $75 per video" in one line: a label and its value
    let here = section;
    const lab = LABEL_LINE.exec(text);
    if (lab && sectionOf(lab[1]) !== "other") { here = sectionOf(lab[1]); text = lab[2]; }
    if (here === "skip") continue;
    if (here === "payout") { if (!out.payout) out.payout = cleanText(text, MAX.payout); continue; }
    if (here === "products") {
      // a product card: its link, or a short name line (never its price or its blurb)
      if (b.href && !EXAMPLE_URL.test(b.href)) addProduct(text, b.href);
      else if (b.t === "li" || (text.length <= 60 && !/^[$€£]?\s?\d/.test(text))) addProduct(text, null);
      else addItem(lists.other, text);
      continue;
    }
    if (here === "examples") { addExample(text, b.href || null); continue; }
    if (here === "dos" || here === "donts" || here === "dosdonts" || here === "deliverables") {
      // each line's own mark decides first (a "Do's & Don'ts" list, a stray "Avoid ..." line)
      if (DONT_MARK.test(text)) addItem(lists.donts, text.replace(DONT_MARK, ""));
      else if (here === "donts") addItem(lists.donts, text);
      else if (DO_MARK.test(text) && here !== "deliverables") addItem(lists.dos, text.replace(DO_MARK, ""));
      else addItem(lists[here === "dosdonts" ? "dos" : here], text);
      continue;
    }
    if (here === "brief") { if (brief.length < 60) brief.push(b.t === "li" ? `- ${text}` : text); continue; }
    addItem(lists.other, text);
  }
  // A payout anywhere on the page ("$75 per approved video") when no section named it.
  if (!out.payout) for (const b of blocks) { const m = PAYOUT_LINE.exec(b.text); if (m && /(per|\/|each|commission|payout|earn|pay)/i.test(b.text)) { out.payout = cleanText(b.text, MAX.payout); break; } }
  // Example videos linked anywhere (a TikTok / Reel / Short) count as examples.
  for (const b of blocks) if (b.href && EXAMPLE_URL.test(b.href)) addExample(b.text, b.href);
  out.brief = cleanText(brief.join("\n"), MAX.brief, { lines: true });
  out.dos = lists.dos;
  out.donts = lists.donts;
  out.deliverables = lists.deliverables;
  out.requirements = [...lists.deliverables, ...lists.dos.map((d) => `Do: ${d}`), ...lists.donts.map((d) => `Don't: ${d}`)].slice(0, MAX.items * 2).map((x) => cleanText(x, MAX.item));
  out.text = cleanText(lines.join("\n"), MAX.text, { lines: true });
  out.missing = ["brief", "requirements", "products", "payout", "examples"].filter((k) => (Array.isArray(out[k]) ? !out[k].length : !out[k]));
  out.partial = ["brief", "requirements", "products"].some((k) => out.missing.includes(k));
  return out;
}
// Nothing worth reading came out of the page (the AI fallback looks for it).
// (A tagline under the name is not a brief.)
const brandIsEmpty = (b) => !b || (b.brief.length < 120 && !b.requirements.length && !b.products.length && !b.payout);
// Two dumps of one page (before and after a tab or "Read more"): the blocks of both, once each.
function mergeDumps(a, b) {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set(a.blocks.map((x) => `${x.t}|${x.text}`));
  return { ...a, blocks: [...a.blocks, ...b.blocks.filter((x) => !seen.has(`${x.t}|${x.text}`))].slice(0, 1500) };
}

// ---- TikTok Studio: the posts list ----------------------------------------------------------------
const POST_URL = /^https:\/\/(www\.)?tiktok\.com\/@([A-Za-z0-9._-]{1,40})\/video\/(\d{6,25})/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const COUNT = /^(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s?([KMB])?$/i;
const PRIVACY = /^(everyone|public|friends|only me|private|followers|draft|scheduled|under review|processing)$/i;
function parseCount(t) {
  const m = COUNT.exec(String(t || "").replace(/\s*(views?|plays?)$/i, "").replace(/^[^\d]+/, "").trim());
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || "").toLowerCase()] || 1;
  const n = m[2] ? parseFloat(m[1].replace(/,/g, "")) : parseFloat(m[1].replace(/[,.](?=\d{3}\b)/g, ""));
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}
// A date as TikTok Studio shows it → ISO (UTC), or null. "Oct 3, 4:12 PM", "Oct 3, 2025", "3 Oct 2025",
// "2025-10-03", "10-03", "10/03/2025", "2h ago", "Yesterday".
// strict: the whole text must be the date (a caption that starts "Oct 5 haul" is not a date).
function parseStudioDate(text, now = Date.now(), { strict = false } = {}) {
  const t = String(text || "").trim().toLowerCase().replace(/^(posted|published|uploaded)\s+(on\s+)?/, "");
  if (!t || t.length > 60) return null;
  const nowD = new Date(now);
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(t)) { const ms = Date.parse(t.toUpperCase()); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
  const rel = /^(\d{1,3})\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?|mo|months?|y|yr|years?)\s*ago$/.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2];
    const ms = /^s/.test(u) ? 1e3 : /^(m|min|mins|minutes?)$/.test(u) ? 6e4 : /^h/.test(u) ? 36e5 : /^d/.test(u) ? 864e5 : /^w/.test(u) ? 6048e5 : /^mo/.test(u) ? 2592e6 : 31536e6;
    return new Date(now - n * ms).toISOString();
  }
  if (/^(just now|now)$/.test(t)) return nowD.toISOString();
  if (/^today\b/.test(t)) return new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate())).toISOString();
  if (/^yesterday\b/.test(t)) return new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() - 1)).toISOString();
  const time = /(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(t);
  let hh = 0; let mm = 0;
  if (time) { hh = Number(time[1]) % 24; mm = Number(time[2]); if (time[3] === "pm" && hh < 12) hh += 12; if (time[3] === "am" && hh === 12) hh = 0; }
  let m = null;
  const make = (y, mo, d, guessYear) => {
    if (!(mo >= 0 && mo < 12 && d >= 1 && d <= 31)) return null;
    if (strict && t.replace(m[0], "").replace(/(\d{1,2}):(\d{2})(:\d{2})?\s*(am|pm)?/, "").replace(/\b(at|on)\b|[,·|]/g, "").trim()) return null;
    let yy = y;
    if (guessYear) { yy = nowD.getUTCFullYear(); if (Date.UTC(yy, mo, d, hh, mm) > now + 864e5) yy -= 1; }
    const ms = Date.UTC(yy, mo, d, hh, mm);
    return Number.isFinite(ms) && yy > 2000 && yy < 2100 ? new Date(ms).toISOString() : null;
  };
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t);
  if (m) return make(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})[/](\d{1,2})[/](\d{4})\b/.exec(t);
  if (m) return make(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  m = /^(\d{1,2})-(\d{1,2})(?:\s|$)/.exec(t);
  if (m) return make(0, Number(m[1]) - 1, Number(m[2]), true);
  m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/.exec(t);
  if (m && MONTHS.includes(m[1].slice(0, 3))) return make(m[3] ? Number(m[3]) : 0, MONTHS.indexOf(m[1].slice(0, 3)), Number(m[2]), !m[3]);
  m = /^(\d{1,2})\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/.exec(t);
  if (m && MONTHS.includes(m[2].slice(0, 3))) return make(m[3] ? Number(m[3]) : 0, MONTHS.indexOf(m[2].slice(0, 3)), Number(m[1]), !m[3]);
  return null;
}
const isDateLine = (l, now) => l.length <= 40 && !!parseStudioDate(l, now, { strict: true });
// Rows as the page script (read-engine.js POST_ROWS) found them: { href, linkText, caption, lines[],
// views, date }. Newest first, as the list shows them.
function postsFromRows(rows, { now = Date.now(), limit = LIMITS.tiktok_recent_posts.def } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const m = POST_URL.exec(String((r && r.href) || ""));
    if (!m) continue;
    const url = `https://www.tiktok.com/@${m[2]}/video/${m[3]}`;
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    // "Oct 3, 4:12 PM · Everyone": each part on its own
    const lines = (r.lines || []).flatMap((l) => String(l).split(/\s[·•|]\s/)).map((l) => cleanText(l, 400)).filter(Boolean);
    const own = cleanText(r.date, 80);
    const dateLine = (own && parseStudioDate(own, now) ? own : "") || lines.find((l) => isDateLine(l, now)) || "";
    const postedAt = parseStudioDate(dateLine, now);
    let views = parseCount(r.views);
    if (views === null) { const first = lines.find((l) => l !== dateLine && COUNT.test(l.replace(/\s*(views?|plays?)$/i, ""))); views = first ? parseCount(first) : null; }
    const plain = (l) => l && l !== dateLine && !COUNT.test(l.replace(/\s*(views?|plays?)$/i, "")) && !PRIVACY.test(l) && !isDateLine(l, now) && !/^(edit|delete|more|share|comments?|likes?|views?|pinned|public|\d+:\d{2})$/i.test(l);
    const link = cleanText(r.linkText, MAX.caption);
    const caption = cleanText(r.caption, MAX.caption) || (plain(link) ? link : "") || [...lines].filter(plain).sort((a, b) => b.length - a.length)[0] || "";
    const p = { url, caption: cleanText(caption, MAX.caption), postedAt: postedAt || null };
    if (views !== null) p.views = views;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// ---- the result's size -------------------------------------------------------------------------------
const sizeOf = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");
// At most MAX_RESULT_BYTES: the page text goes first, then the longest lists are shortened.
function capReadResult(read, result) {
  if (result === null || result === undefined) return null;
  let r = JSON.parse(JSON.stringify(result));
  if (sizeOf(r) <= MAX_RESULT_BYTES) return r;
  if (Array.isArray(r)) {
    while (r.length && sizeOf(r) > MAX_RESULT_BYTES) r = r.slice(0, Math.max(0, Math.floor(r.length * 0.8)));
    return r;
  }
  if (typeof r.text === "string") { r.text = cleanText(r.text, Math.max(500, r.text.length - (sizeOf(r) - MAX_RESULT_BYTES) - 200), { lines: true }); }
  for (const k of ["examples", "products", "requirements", "deliverables", "dos", "donts"]) {
    while (Array.isArray(r[k]) && r[k].length > 3 && sizeOf(r) > MAX_RESULT_BYTES) r[k] = r[k].slice(0, r[k].length - 1);
  }
  if (sizeOf(r) > MAX_RESULT_BYTES) { r.text = ""; r.brief = cleanText(r.brief, 2000, { lines: true }); }
  return r;
}

// ---- the targets while reading ----------------------------------------------------------------------
const BTN = "button, [role=button], a, [role=link], span[tabindex], div[tabindex]";
const READ_TARGETS = {
  brandLinks: TRYBE_TARGETS.brandLinks,
  viewAll: TRYBE_TARGETS.viewAllBrands,
  noBrands: TRYBE_TARGETS.brandNoResults,
  loadMore: [{ text: "^(load|show|see|view) more( brands| posts| videos| results)?$", within: BTN }],
  nextPage: [
    { css: '[aria-label="Next page" i], [aria-label="Go to next page" i], [aria-label="Next" i], a[rel="next"], [data-testid*="next-page" i]' },
    { text: "^(next( page)?|›|»|>|→)$", within: "nav button, nav a, [class*=paginat i] button, [class*=paginat i] a, [role=navigation] button, [role=navigation] a, [aria-label*=paginat i] button" },
  ],
  expanders: [{ text: "^(read|show|see|view) (more|details|full( brief| details)?)$|^expand( all)?$", within: "button, [role=button], a, span[tabindex], div[tabindex], summary" }],
  tabs: [{ css: "[role=tab]" }],
  notFound: [{ text: "^(brand not found|page not found|404|not found|this page (could not|couldn.t) be found|campaign not found)", within: "h1, h2, h3, p" }],
  postLinks: [{ css: 'a[href*="/video/"]' }],
  postsTab: [{ text: "^(posts|videos|content|manage posts)$", within: "[role=tab], nav a, aside a, nav button, aside button, a, button" }],
  noPosts: [{ text: "(no (posts|videos|content)( yet)?|you haven.t (posted|uploaded)|nothing (posted|here) yet|upload your first video)", within: "div, p, span, h2, h3" }],
};

// The brand the creator named ("Mad Rabbit") among the cards: the same words rule as posting.
const pickBrandCard = (want, brands) => { const best = pickBrand(want, (brands || []).map((b) => ({ ...b, text: b.name }))); return best ? (brands || []).find((b) => b.id === best.id) || null : null; };

module.exports = {
  READS, LIMITS, MAX, MAX_RESULT_BYTES, MAX_AI_PER_READ_STEP, MAX_AI_PER_READ, READ_STEPS, READ_STEP_WORDS, READ_GOALS, READ_TARGETS, NEVER_PRESS, POST_URL,
  validateReadRequest, isSafeToPress, validateReadAction, cleanText, safeUrl,
  brandsFromCards, brandFromBlocks, brandIsEmpty, mergeDumps, sectionOf, pickBrandCard,
  parseCount, parseStudioDate, postsFromRows, capReadResult, productWords,
};
