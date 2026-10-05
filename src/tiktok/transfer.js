// Saving a downloaded video to disk (a finished export, or a Google Drive file), with a count of
// the bytes as they arrive (for the log and the app) and a stall guard: no bytes for `stallMs` ends
// the download with plain words instead of waiting forever. Never decodes anything.
"use strict";

const fs = require("fs");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

async function saveBody(body, file, { signal = null, stallMs = 60000, onBytes = () => {} } = {}) {
  const local = new AbortController();
  const onOuter = () => local.abort();
  if (signal) { if (signal.aborted) local.abort(); else signal.addEventListener("abort", onOuter, { once: true }); }
  let bytes = 0;
  let last = Date.now();
  let stalled = false;
  const counter = new Transform({
    transform(chunk, _enc, cb) { bytes += chunk.length; last = Date.now(); try { onBytes(bytes); } catch { /* the caller's problem */ } cb(null, chunk); },
  });
  const guard = setInterval(() => { if (Date.now() - last > stallMs) { stalled = true; local.abort(); } }, Math.min(5000, Math.max(250, Math.floor(stallMs / 4))));
  try {
    await pipeline(Readable.fromWeb(body), counter, fs.createWriteStream(file, { highWaterMark: 1 << 20 }), { signal: local.signal });
  } catch (e) {
    if (stalled && !(signal && signal.aborted)) throw new Error(`The video stopped downloading (nothing came for ${Math.round(stallMs / 1000)} s). Check your internet and try again.`);
    throw e;
  } finally {
    clearInterval(guard);
    if (signal) signal.removeEventListener("abort", onOuter);
  }
  return bytes;
}

module.exports = { saveBody };
