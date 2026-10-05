// What the desktop knows about the creator's TikTok and Trybe windows WITHOUT opening them
// (2026-10-05, for the desktop UI and Groot's brain):
//   tiktokStatus()  → { signedIn, handle? }  TikTok's session cookie in the TikTok window's own
//                     session (persist:tiktok); the handle from the last posts Groot read.
//   trybeStatus()   → { signedIn, handle? }  Trybe's Supabase session ("sb-*-auth-token" in
//                     localStorage, Trybe's origin, persist:trybe): read from the open Trybe window
//                     (an isolated world, nothing of Trybe's runs it), else from the partition's
//                     Local Storage files on disk (read only, never a window, never Trybe itself),
//                     else what it was last time. The handle is the Trybe login's email.
//   remember(read, result) / lastBrands()  the last "My brands" Groot read, kept on disk
//                     (<userData>/groot-reads.json) so the UI can offer the brands as quick replies.
// Nothing here navigates, signs in or out, or touches a password.
"use strict";

const fs = require("fs");
const path = require("path");
const { TRYBE_ORIGIN, SESSION_KEY } = require("./trybe");
const { POST_URL } = require("./reads");

// ---- Trybe's session in Chromium's Local Storage files (LevelDB) ---------------------------------------
// A write in the log is: tag (1 = put, 0 = delete), the key's length (a varint), the key
// ("_" + origin + "\0\x01" + name), then for a put the value's length and the value (a first byte 1
// = Latin-1, 0 = UTF-16). The newest record for the key wins. Compressed table files may hide a
// record: then this answers null and the caller falls back to what it knew.
function trybeSessionFromStorage(buffers, origin = TRYBE_ORIGIN) {
  const prefix = Buffer.from(`_${origin}\x00\x01`, "latin1");
  let last = null;
  for (const buf of buffers || []) {
    for (let i = buf.indexOf(prefix); i !== -1; i = buf.indexOf(prefix, i + 1)) {
      const name = /^sb-[a-z0-9-]+-auth-token/i.exec(buf.toString("latin1", i + prefix.length, i + prefix.length + 80));
      if (!name || !SESSION_KEY.test(name[0])) continue;
      const keyLen = prefix.length + name[0].length;
      if (i < 2 || buf[i - 1] !== keyLen || (buf[i - 2] !== 0 && buf[i - 2] !== 1)) continue;
      if (buf[i - 2] === 0) { last = { deleted: true }; continue; }
      let p = i + keyLen;
      let len = 0;
      let shift = 0;
      let b;
      do { b = buf[p++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && shift < 35 && p < buf.length);
      if (!len || p + len > buf.length) continue;
      const raw = buf.subarray(p, p + len);
      last = { value: raw[0] === 0 ? raw.subarray(1).toString("utf16le") : raw.subarray(1).toString("latin1") };
    }
  }
  if (!last || last.deleted) return last ? { signedIn: false } : null;
  try {
    const v = JSON.parse(last.value);
    const s = v && v.currentSession ? v.currentSession : v;
    if (s && typeof s.refresh_token === "string" && s.refresh_token) return { signedIn: true, handle: (s.user && typeof s.user.email === "string" && s.user.email.toLowerCase()) || undefined };
    return { signedIn: false };
  } catch { return null; }
}

// Runs in an isolated world of the open Trybe window: is Trybe's session there, and whose.
const TRYBE_CHECK = `(() => { try {
  const k = Object.keys(localStorage).find((x) => /^sb-[a-z0-9-]+-auth-token$/i.test(x));
  if (!k) return { signedIn: false };
  const v = JSON.parse(localStorage.getItem(k) || "null"); const s = v && v.currentSession ? v.currentSession : v;
  return s && s.refresh_token ? { signedIn: true, handle: (s.user && s.user.email) || null } : { signedIn: false };
} catch (e) { return null; } })()`;

function createAccounts({ electron, userData, windowOf = () => null, partitions = { tiktok: "persist:tiktok", trybe: "persist:trybe" }, trybeOrigin = TRYBE_ORIGIN, log = () => {}, now = () => Date.now() }) {
  const file = path.join(userData, "groot-reads.json");
  const load = () => { try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; } };
  const save = (j) => { try { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(j)); fs.renameSync(tmp, file); } catch (e) { log("reads cache not saved", e && e.message); } };
  const update = (fn) => { const j = load(); fn(j); save(j); };
  const clean = (o) => (o && o.signedIn ? { signedIn: true, ...(o.handle ? { handle: String(o.handle).slice(0, 120) } : {}) } : { signedIn: false });

  async function tiktokStatus() {
    try {
      const ses = electron.session.fromPartition(partitions.tiktok);
      const cookies = await ses.cookies.get({ name: "sessionid" });
      const t = now() / 1000;
      const live = cookies.some((c) => c.value && /(^|\.)tiktok\.com$|^127\.0\.0\.1$/.test(String(c.domain || "").replace(/^\./, "")) && (!c.expirationDate || c.expirationDate > t));
      const handle = load().tiktokHandle;
      return clean({ signedIn: live, handle });
    } catch (e) { log("tiktok status", e && e.message); return { signedIn: false }; }
  }

  async function trybeStatus() {
    let got = null;
    // 1. the Trybe window, when it is open on Trybe
    const w = windowOf("trybe");
    if (w && !w.isClosed() && !w.contents.isDestroyed()) {
      try {
        if (new URL(w.contents.getURL()).origin === new URL(trybeOrigin).origin) got = await w.contents.executeJavaScriptInIsolatedWorld(1717, [{ code: TRYBE_CHECK }]);
      } catch { got = null; }
    }
    // 2. the partition's Local Storage files (read only)
    if (!got) {
      try {
        const dir = path.join(userData, "Partitions", partitions.trybe.replace(/^persist:/, ""), "Local Storage", "leveldb");
        const files = fs.readdirSync(dir).filter((f) => /\.(log|ldb)$/.test(f)).map((f) => path.join(dir, f)).map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => a.t - b.t).slice(-12);
        got = trybeSessionFromStorage(files.map((x) => fs.readFileSync(x.f)), new URL(trybeOrigin).origin);
      } catch { got = null; }
    }
    // 3. what it was last time
    if (got) { const c = clean(got); update((j) => { j.trybe = { ...c, at: new Date(now()).toISOString() }; }); return c; }
    return clean(load().trybe);
  }

  return {
    tiktokStatus,
    trybeStatus,
    // After a read: the brands for quick replies, the TikTok handle from the posts' addresses.
    remember(read, result) {
      if (read === "trybe_brands" && Array.isArray(result)) update((j) => { j.trybeBrands = { at: new Date(now()).toISOString(), brands: result.slice(0, 100) }; });
      if (read === "tiktok_recent_posts" && Array.isArray(result)) { const m = result.length && POST_URL.exec(result[0].url || ""); if (m) update((j) => { j.tiktokHandle = m[2]; }); }
    },
    lastBrands() { const b = load().trybeBrands; return b && Array.isArray(b.brands) ? { at: b.at || null, brands: b.brands } : null; },
  };
}

module.exports = { createAccounts, trybeSessionFromStorage, TRYBE_CHECK };
