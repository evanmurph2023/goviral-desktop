// Makes the app icons from the iPhone app's icon (goviral-ai assets/icon.png, 1024x1024, full
// bleed: iOS rounds the corners itself, Mac and Windows do not).
//
//   node scripts/make-icons.cjs [source.png]
//
//   build/icon-mac.png  1024, Apple's Big Sur grid: an 824 rounded square centred, transparent
//                       around it. electron-builder turns it into the .icns on the Mac runner.
//   build/icon.ico      Windows: 16-256 px, each a PNG inside the .ico (Vista and later read that).
//   build/icon.png      1024, the Windows shape, for anything that wants a plain PNG.
//   assets/logo.png     256, the offline page's logo.
//
// sharp is not a dependency of this repo (it is only needed when the icon changes): it comes from
// the platform repo's node_modules, or SHARP_FROM=<path to a sharp folder>.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.resolve(process.argv[2] || "C:/dev/goviral-ai-ux/assets/icon.png");
const sharpPath = process.env.SHARP_FROM || "C:/dev/goviral-platform/node_modules/sharp";
const sharp = require(sharpPath);

const roundMask = (size, radius) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);

async function rounded(size, radius) {
  return sharp(SRC).resize(size, size).composite([{ input: roundMask(size, radius), blend: "dest-in" }]).png().toBuffer();
}

// An .ico whose images are PNGs: 6-byte header, 16 bytes per entry, then the PNG bytes.
function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.buf)]);
}

(async () => {
  fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "assets"), { recursive: true });

  // Mac: 824 squircle-ish rounded square (radius 185 on the 824) on a transparent 1024.
  const inner = await rounded(824, 185);
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: inner, left: 100, top: 100 }]).png().toFile(path.join(ROOT, "build", "icon-mac.png"));

  // Windows: the whole square, corners rounded (about 18%), then every size from the 1024.
  const win1024 = await rounded(1024, 184);
  fs.writeFileSync(path.join(ROOT, "build", "icon.png"), win1024);
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const pngs = [];
  for (const size of sizes) pngs.push({ size, buf: await sharp(win1024).resize(size, size, { kernel: "lanczos3" }).png().toBuffer() });
  fs.writeFileSync(path.join(ROOT, "build", "icon.ico"), ico(pngs));

  await sharp(win1024).resize(256, 256).png().toFile(path.join(ROOT, "assets", "logo.png"));
  console.log("icons written: build/icon-mac.png, build/icon.png, build/icon.ico, assets/logo.png");
})().catch((e) => { console.error(e); process.exit(1); });
