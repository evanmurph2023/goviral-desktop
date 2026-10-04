// The creator's own finished videos on this computer (Groot posts finished videos, 2026-10-04).
//
// Only what the creator chose, never anything else:
//   - FOLDERS they picked with the system folder dialog ("TikTok Shop vids"). Groot may look inside
//     those (subfolders too, a few levels down) and nowhere else. A folder is remembered across
//     launches only when the creator says so (remember: true); otherwise it is forgotten on quit.
//   - FILES they dropped on the window (the preload turns each dropped File into its path with
//     webUtils.getPathForFile; a page cannot make one up).
// The page never sees or sends a path to post: every video gets an opaque id ("f_…") and the main
// process turns the id back into the path, checking again that it is still inside a chosen folder
// (or is a dropped file), still a regular file, still a video.
//
// Length: read from the MP4/MOV header (the mvhd box), a few hundred bytes, nothing decoded.
// Thumbnail: the operating system's own (Explorer / Quick Look), via nativeImage; never ffmpeg.
"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const MAX_BYTES = 4 * 1024 ** 3;
const MIN_BYTES = 1000;
const MAX_DEPTH = 4;
const MAX_FOLDERS = 400;
const MAX_VIDEOS = 200;

const isVideoName = (name) => VIDEO_EXT.has(path.extname(String(name || "")).toLowerCase()) && !String(name).startsWith(".");
const skipDir = (name) => name.startsWith(".") || name.startsWith("$") || /^(node_modules|System Volume Information)$/i.test(name);

// Is `child` the folder `root` itself or inside it? Case-insensitive on Windows and Mac.
function isInside(root, child, platform = process.platform) {
  const norm = (p) => { const r = path.resolve(p); return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r; };
  const a = norm(root), b = norm(child);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// A folder path relative to its root, always with "/" (what the app shows and sends back).
const toRel = (root, p) => path.relative(root, p).split(path.sep).join("/");
// The app's relative folder → a real path inside the root, or null.
function resolveRel(root, rel) {
  const r = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (r.split("/").some((seg) => seg === "..")) return null;
  const p = path.resolve(root, ...r.split("/").filter(Boolean));
  return isInside(root, p) ? p : null;
}

// ---- the length, from the header ---------------------------------------------------------------
// MP4 / MOV: top-level boxes until moov, its children until mvhd, then timescale + duration.
// Works on a file descriptor reading tiny slices (moov may sit at the very end of the file).
async function mp4Seconds(file) {
  let fh;
  try {
    fh = await fsp.open(file, "r");
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(16);
    const box = async (at) => {
      if (at + 8 > size) return null;
      await fh.read(head, 0, 16, at);
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      let hdr = 8;
      if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; } else if (len === 0) len = size - at;
      if (len < hdr) return null;
      return { at, len, type, hdr };
    };
    let at = 0;
    for (let i = 0; i < 64; i++) {
      const b = await box(at);
      if (!b) return null;
      if (b.type === "moov") {
        let c = b.at + b.hdr;
        const end = b.at + b.len;
        for (let j = 0; j < 64 && c < end; j++) {
          const k = await box(c);
          if (!k) return null;
          if (k.type === "mvhd") {
            const m = Buffer.alloc(32);
            await fh.read(m, 0, 32, k.at + k.hdr);
            const v = m[0];
            const scale = v === 1 ? m.readUInt32BE(20) : m.readUInt32BE(12);
            const dur = v === 1 ? Number(m.readBigUInt64BE(24)) : m.readUInt32BE(16);
            return scale > 0 && dur > 0 ? Math.round((dur / scale) * 10) / 10 : null;
          }
          c += k.len;
        }
        return null;
      }
      at += b.len;
    }
    return null;
  } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

// ---- the registry -------------------------------------------------------------------------------
function createFileRegistry({ storePath, log = () => {}, thumbnailer = null, platform = process.platform } = {}) {
  const roots = new Map();   // id → { id, path, name, remembered }
  const byToken = new Map(); // fileId → { path, rootId | null }
  const byPath = new Map();  // path → fileId
  const id = (n) => crypto.randomBytes(n).toString("base64url");

  // The remembered folders, from the last launch. A folder that is gone stays listed as missing
  // so the app can say so (and forget it).
  function load() {
    if (!storePath) return;
    try {
      const j = JSON.parse(fs.readFileSync(storePath, "utf8"));
      for (const r of Array.isArray(j.roots) ? j.roots : []) {
        if (typeof r.path !== "string" || !path.isAbsolute(r.path)) continue;
        const rid = typeof r.id === "string" && /^r_[A-Za-z0-9_-]{8,40}$/.test(r.id) ? r.id : `r_${id(9)}`;
        roots.set(rid, { id: rid, path: path.resolve(r.path), name: path.basename(r.path) || r.path, remembered: true });
      }
    } catch { /* no file yet */ }
  }
  function save() {
    if (!storePath) return;
    const list = [...roots.values()].filter((r) => r.remembered).map((r) => ({ id: r.id, path: r.path }));
    try { fs.mkdirSync(path.dirname(storePath), { recursive: true }); fs.writeFileSync(storePath, JSON.stringify({ roots: list }, null, 2)); } catch (e) { log("folders save failed", e); }
  }
  const view = (r) => ({ id: r.id, name: r.name, path: r.path, remembered: r.remembered, missing: !fs.existsSync(r.path) });

  function addRoot(p, { remember = false } = {}) {
    const abs = path.resolve(p);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) throw new Error("That isn't a folder.");
    for (const r of roots.values()) if (isInside(r.path, abs, platform) && isInside(abs, r.path, platform)) { if (remember && !r.remembered) { r.remembered = true; save(); } return view(r); }
    const r = { id: `r_${id(9)}`, path: abs, name: path.basename(abs) || abs, remembered: !!remember };
    roots.set(r.id, r);
    if (r.remembered) save();
    return view(r);
  }
  function remember(rootId, on) { const r = roots.get(rootId); if (!r) return false; r.remembered = !!on; save(); return true; }
  function forget(rootId) { const had = roots.delete(rootId); if (had) save(); return had; }
  const list = () => [...roots.values()].map(view);

  function tokenFor(p, rootId) {
    const have = byPath.get(p);
    if (have && byToken.has(have)) return have;
    const t = `f_${id(18)}`;
    byToken.set(t, { path: p, rootId });
    byPath.set(p, t);
    return t;
  }

  // Every folder under a root (the root itself is ""), a few levels down, each with how many
  // videos sit directly in it. Links are not followed.
  async function folders(rootId) {
    const r = roots.get(rootId);
    if (!r) return { ok: false, error: "That folder isn't one you picked." };
    const out = [];
    const walk = async (dir, depth) => {
      if (out.length >= MAX_FOLDERS) return;
      let ents;
      try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      const videos = ents.filter((e) => e.isFile() && isVideoName(e.name)).length;
      const rel = toRel(r.path, dir);
      out.push({ rel, name: rel ? path.basename(dir) : r.name, videos, depth });
      if (depth >= MAX_DEPTH) return;
      for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink() && !skipDir(e.name)) await walk(path.join(dir, e.name), depth + 1);
    };
    await walk(r.path, 0);
    return { ok: true, root: view(r), folders: out };
  }

  async function info(p, rootId, withLength = true) {
    let st;
    try { st = await fsp.lstat(p); } catch { return null; }
    if (!st.isFile() || st.isSymbolicLink() || st.size < MIN_BYTES || st.size > MAX_BYTES || !isVideoName(p)) return null;
    return { fileId: tokenFor(p, rootId), name: path.basename(p), size: st.size, modified: st.mtimeMs, seconds: withLength ? await mp4Seconds(p) : null, folder: rootId ? toRel(roots.get(rootId).path, path.dirname(p)) : null };
  }

  // The videos in one folder of a root (and its subfolders when asked), oldest name first.
  async function videos(rootId, rel, { recursive = false } = {}) {
    const r = roots.get(rootId);
    if (!r) return { ok: false, error: "That folder isn't one you picked." };
    const dir = resolveRel(r.path, rel);
    if (!dir) return { ok: false, error: "That folder isn't inside the one you picked." };
    const found = [];
    const walk = async (d, depth) => {
      let ents;
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (found.length >= MAX_VIDEOS) return;
        if (e.isFile() && isVideoName(e.name)) found.push(path.join(d, e.name));
        else if (recursive && depth < MAX_DEPTH && e.isDirectory() && !e.isSymbolicLink() && !skipDir(e.name)) await walk(path.join(d, e.name), depth + 1);
      }
    };
    await walk(dir, 0);
    found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    const out = [];
    for (const p of found) { const i = await info(p, r.id); if (i) out.push(i); }
    return { ok: true, folder: toRel(r.path, dir), videos: out };
  }

  // Files the creator dropped on the window (paths from webUtils.getPathForFile, in the preload).
  async function addDropped(paths) {
    const videos = [];
    const skipped = [];
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, MAX_VIDEOS)) {
      if (typeof p !== "string" || !path.isAbsolute(p)) continue;
      const i = await info(path.resolve(p), null);
      if (i) videos.push(i); else skipped.push(path.basename(p));
    }
    return { ok: true, videos, skipped };
  }

  // The id → the path to post, checked again right now.
  function pathOf(fileId) {
    const t = byToken.get(fileId);
    if (!t) return null;
    if (t.rootId) {
      const r = roots.get(t.rootId);
      if (!r || !isInside(r.path, t.path, platform)) return null;
    }
    try {
      const st = fs.lstatSync(t.path);
      if (!st.isFile() || st.isSymbolicLink() || st.size < MIN_BYTES || st.size > MAX_BYTES || !isVideoName(t.path)) return null;
    } catch { return null; }
    return t.path;
  }

  async function thumbnail(fileId) {
    const p = pathOf(fileId);
    if (!p || !thumbnailer) return null;
    try { return await Promise.race([thumbnailer(p), new Promise((res) => setTimeout(() => res(null), 4000))]); } catch { return null; }
  }

  load();
  return { list, addRoot, remember, forget, folders, videos, addDropped, pathOf, thumbnail };
}

module.exports = { createFileRegistry, mp4Seconds, isInside, resolveRel, isVideoName, VIDEO_EXT };
