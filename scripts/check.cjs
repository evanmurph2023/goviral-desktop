// npm run check: what can be proven without opening the app.
//   1. every source file parses
//   2. the link rules: goviral:// targets, which addresses count as the app, what may go to the system
//   3. the builder config loads, and with no secrets it signs nothing
//   4. if a build exists (dist/*-unpacked or dist/mac*/GoViral.app), its app.asar holds the right
//      files, they match the source, and package.json points at src/main.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const bad = (name, e) => { failures++; console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`); };
const test = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name, e); } };

const SOURCES = ["src/main.js", "src/preload.js", "src/links.js", "src/tiktok/index.js", "src/tiktok/poster.js", "src/tiktok/engine.js", "src/tiktok/page.js", "src/tiktok/window.js", "src/tiktok/rules.js", "src/tiktok/trybe.js", "src/tiktok/trybe-engine.js", "src/tiktok/reads.js", "src/tiktok/read-engine.js", "src/tiktok/accounts.js", "src/tiktok/files.js", "src/tiktok/drive.js", "src/tiktok/transfer.js", "src/tiktok/bar-preload.js", "electron-builder.config.js", "scripts/make-icons.cjs", "scripts/tiktok-unit.cjs", "scripts/tiktok-engine-unit.cjs", "scripts/tiktok-harness.cjs"];

console.log("1. parse");
for (const f of SOURCES) {
  test(f, () => {
    const r = spawnSync(process.execPath, ["--check", path.join(ROOT, f)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr.trim());
  });
}
test("src/offline.html inline script", () => {
  const html = fs.readFileSync(path.join(ROOT, "src/offline.html"), "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(m, "no script");
  new Function(m[1]); // eslint-disable-line no-new-func
});

console.log("2. links");
const { makeLinks, isSafeExternal } = require(path.join(ROOT, "src/links.js"));
const L = makeLinks("https://app.govirall.now");
test("goviral:// opens the app home", () => assert.strictEqual(L.deepLinkTarget("goviral://"), "https://app.govirall.now/desktop"));
test("goviral://video/abc?x=1 -> /desktop/video/abc?x=1", () => assert.strictEqual(L.deepLinkTarget("goviral://video/abc?x=1"), "https://app.govirall.now/desktop/video/abc?x=1"));
test("goviral://open?url=<app page>", () => assert.strictEqual(L.deepLinkTarget("goviral://open?url=" + encodeURIComponent("https://app.govirall.now/creator/upload")), "https://app.govirall.now/creator/upload"));
test("goviral://open?url=<other site> is dropped", () => assert.strictEqual(L.deepLinkTarget("goviral://open?url=" + encodeURIComponent("https://evil.example/")), null));
test("goviral://@evil.example stays on the app", () => assert.strictEqual(new URL(L.deepLinkTarget("goviral://@evil.example/x") || "https://app.govirall.now").origin, "https://app.govirall.now"));
test("other schemes are not deep links", () => { assert.strictEqual(L.deepLinkTarget("https://app.govirall.now/desktop"), null); assert.strictEqual(L.deepLinkTarget("javascript:alert(1)"), null); });
test("argv pick-up (Windows passes the link as an argument)", () => assert.strictEqual(L.deepLinkIn(["GoViral.exe", "--flag", "goviral://home"]), "goviral://home"));
test("app urls", () => {
  assert(L.isAppUrl("https://app.govirall.now/desktop/x"));
  assert(!L.isAppUrl("https://app.govirall.now.evil.example/"));
  assert(!L.isAppUrl("http://app.govirall.now/"));
  assert(!L.isAppUrl("https://govirall.now/"));
});
test("external: http/https/mailto only", () => {
  assert(isSafeExternal("https://checkout.commas.example/pay"));
  assert(isSafeExternal("mailto:hello@govirall.now"));
  assert(!isSafeExternal("file:///C:/Windows/system32/calc.exe"));
  assert(!isSafeExternal("javascript:alert(1)"));
  assert(!isSafeExternal("ms-settings:"));
});

console.log("3. builder config");
const SECRET_KEYS = ["CSC_LINK", "CSC_NAME", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SIGN_ENDPOINT", "AZURE_SIGN_ACCOUNT", "AZURE_SIGN_PROFILE", "WIN_PUBLISHER_NAME"];
const loadConfig = (env) => {
  const saved = {};
  for (const k of SECRET_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const p = require.resolve(path.join(ROOT, "electron-builder.config.js"));
  delete require.cache[p];
  try { return require(p); } finally {
    for (const k of SECRET_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
};
test("no secrets: unsigned Windows, ad-hoc Mac", () => {
  const c = loadConfig({});
  assert.strictEqual(c.appId, "now.govirall.desktop");
  assert.strictEqual(c.productName, "GoViral");
  assert(!c.win.azureSignOptions, "azure on without secrets");
  assert.strictEqual(c.mac.identity, "-");
  assert.strictEqual(c.win.artifactName, "GoViral-Setup-${version}-${arch}.${ext}");
  assert.strictEqual(c.nsis.buildUniversalInstaller, false);
  assert.strictEqual(c.dmg.artifactName, "GoViral-${version}.${ext}");
});
test("Azure secrets: Trusted Signing on", () => {
  const c = loadConfig({ AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s", AZURE_SIGN_ENDPOINT: "https://eus.codesigning.azure.net", AZURE_SIGN_ACCOUNT: "a", AZURE_SIGN_PROFILE: "p", WIN_PUBLISHER_NAME: "GoViral LLC" });
  assert.strictEqual(c.win.azureSignOptions.codeSigningAccountName, "a");
  assert.strictEqual(c.win.azureSignOptions.publisherName, "GoViral LLC");
});
test("Mac cert: real identity lookup", () => {
  const c = loadConfig({ CSC_LINK: "base64..." });
  assert.strictEqual(c.mac.identity, undefined);
});
test("required build resources exist", () => {
  for (const f of ["build/icon.ico", "build/icon-mac.png", "build/entitlements.mac.plist", "assets/logo.png", "src/offline.html"]) assert(fs.existsSync(path.join(ROOT, f)), `${f} missing`);
});

console.log("4. packaged app");
const asarFiles = [];
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  for (const d of fs.readdirSync(dist)) {
    const win = path.join(dist, d, "resources", "app.asar");
    const mac = path.join(dist, d, "GoViral.app", "Contents", "Resources", "app.asar");
    if (fs.existsSync(win)) asarFiles.push(win);
    if (fs.existsSync(mac)) asarFiles.push(mac);
  }
}
if (!asarFiles.length) console.log("  (no build in dist/, skipped)");
const asar = asarFiles.length ? require("@electron/asar") : null;
for (const file of asarFiles) {
  const rel = path.relative(ROOT, file);
  test(`${rel}: has the app files`, () => {
    const list = asar.listPackage(file).map((p) => p.replace(/\\/g, "/"));
    for (const need of ["/package.json", "/src/main.js", "/src/preload.js", "/src/links.js", "/src/offline.html", "/src/tiktok/index.js", "/src/tiktok/files.js", "/src/tiktok/drive.js", "/src/tiktok/transfer.js", "/src/tiktok/bar.html", "/src/tiktok/bar-preload.js", "/assets/logo.png", "/node_modules/electron-updater/package.json"]) {
      assert(list.includes(need), `${need} not in app.asar`);
    }
    for (const never of ["/build/icon.ico", "/scripts/check.cjs", "/test/tiktok-mock/upload.html", "/node_modules/electron/package.json", "/node_modules/electron-builder/package.json"]) {
      assert(!list.includes(never), `${never} should not be packaged`);
    }
  });
  test(`${rel}: package.json main is src/main.js`, () => {
    const pkg = JSON.parse(asar.extractFile(file, "package.json").toString("utf8"));
    assert.strictEqual(pkg.main, "src/main.js");
  });
  test(`${rel}: packaged sources match and parse`, () => {
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "gvd-check-"));
    for (const f of ["src/main.js", "src/preload.js", "src/links.js"]) {
      const packed = asar.extractFile(file, f);
      assert(packed.equals(fs.readFileSync(path.join(ROOT, f))), `${f} differs from the source`);
      const out = path.join(tmp, path.basename(f));
      fs.writeFileSync(out, packed);
      const r = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr.trim());
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
