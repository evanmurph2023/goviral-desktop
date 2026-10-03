// CI only: passes electron-builder's output straight through, and turns its milestones (signing,
// notarization, targets, upload) into GitHub annotations with the minutes since the start, so a
// slow or stuck build shows where it is on the run's summary page.
//   npx electron-builder ... 2>&1 | node scripts/ci-progress.cjs
"use strict";

const readline = require("readline");

const start = Date.now();
const seen = new Set();
let notices = 0;
const MAX_NOTICES = 9; // GitHub keeps 10 annotations of each kind per step

const milestones = [
  [/\bsigning\b.*\bfile=/, () => "signing started"],
  [/zipping application/, () => "notarization: zipping the app"],
  [/attempting to upload/, () => "notarization: uploading to Apple, waiting for Apple's verdict"],
  [/notarization success \(id: ([0-9a-f-]+)\)/i, (m) => `notarization: Apple accepted it (submission ${m[1]})`],
  [/staple succeeded/, () => "notarization: ticket stapled"],
  [/building\s+target=(\S+)/, (m) => `building ${m[1]}`],
  [/\buploading\b.*\bfile=/, () => "uploading the files to the release"],
];

function notice(text) {
  if (notices >= MAX_NOTICES) return;
  notices++;
  const min = ((Date.now() - start) / 60000).toFixed(1);
  console.log(`::notice title=Build progress::+${min} min: ${text}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  console.log(line);
  for (const [re, label] of milestones) {
    const m = line.match(re);
    if (!m) continue;
    const text = label(m);
    if (seen.has(text)) continue;
    seen.add(text);
    notice(text);
  }
});
