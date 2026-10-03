// electron-builder settings. JavaScript (not YAML) so the signing steps switch on only when their
// secrets exist: with none of them set, the build still works and is simply unsigned.
//
//   Windows, Azure Trusted Signing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (read by
//     the signing tool itself) + AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE,
//     WIN_PUBLISHER_NAME (read here).
//   Windows, a .pfx certificate instead: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (electron-builder
//     reads those itself; CSC_LINK works too on a Windows-only runner).
//   Mac: CSC_LINK + CSC_KEY_PASSWORD (the Developer ID Application .p12, base64), and for
//     notarization APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.
"use strict";

const env = (k) => (process.env[k] || "").trim();

const azure = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SIGN_ENDPOINT", "AZURE_SIGN_ACCOUNT", "AZURE_SIGN_PROFILE", "WIN_PUBLISHER_NAME"].every(env);
// The Developer ID cert: CSC_LINK (CI) or CSC_NAME (a Mac with it in the keychain).
const macCert = !!(env("CSC_LINK") || env("CSC_NAME"));
const winPublisher = env("WIN_PUBLISHER_NAME");
// A .pfx for Windows. publisherName is what the updater checks each update was signed by, so it
// is only set when the build really is signed.
const winCert = !!(env("WIN_CSC_LINK") || (process.platform === "win32" && env("CSC_LINK")));

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "now.govirall.desktop",
  productName: "GoViral",
  copyright: "Copyright 2026 GoViral",
  directories: { output: "dist", buildResources: "build" },
  files: ["src/**/*", "assets/**/*", "package.json"],
  asar: true,
  // Only English: the other ~50 Chromium language packs are ~40 MB of the download.
  electronLanguages: ["en-US"],
  protocols: [{ name: "GoViral", schemes: ["goviral"] }],
  // Lock the Electron binary down: it cannot be reused as a Node runtime, ignores NODE_OPTIONS and
  // --inspect, only runs the app from app.asar, and encrypts its cookies (the sign-in) on disk
  // with the operating system's keys, the way Chrome does.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
  },
  // CI (.github/workflows/release.yml) makes the draft release for the tag, both builds upload
  // into it, and it goes public only when Windows and Mac have both finished.
  publish: [{ provider: "github", owner: "evanmurph2023", repo: "goviral-desktop", releaseType: "draft" }],

  win: {
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    icon: "build/icon.ico",
    // One installer per processor (x64 / arm64), not one with both inside (twice the download).
    // The arch is in the name so the updater, which picks the file whose name has process.arch in
    // it, can never hand an Intel PC the ARM build.
    artifactName: "GoViral-Setup-${version}-${arch}.${ext}",
    ...(azure
      ? {
          azureSignOptions: {
            publisherName: winPublisher,
            endpoint: env("AZURE_SIGN_ENDPOINT"),
            codeSigningAccountName: env("AZURE_SIGN_ACCOUNT"),
            certificateProfileName: env("AZURE_SIGN_PROFILE"),
          },
        }
      : winCert && winPublisher
        ? { signtoolOptions: { publisherName: winPublisher } }
        : {}),
  },
  nsis: {
    // Installs for the current person, no admin prompt, opens when done (like Slack or Discord).
    oneClick: true,
    buildUniversalInstaller: false,
    perMachine: false,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "GoViral",
    deleteAppDataOnUninstall: false,
    installerIcon: "build/icon.ico",
    uninstallerIcon: "build/icon.ico",
    uninstallDisplayName: "GoViral",
  },

  mac: {
    target: [
      { target: "dmg", arch: ["universal"] },
      { target: "zip", arch: ["universal"] }, // the zip is what auto-update downloads on a Mac
    ],
    icon: "build/icon-mac.png",
    category: "public.app-category.video",
    artifactName: "GoViral-${version}-mac.${ext}",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    // No certificate: ad-hoc signed, so it at least opens on Apple Silicon (right-click > Open).
    ...(macCert ? {} : { identity: "-" }),
    extendInfo: {
      NSCameraUsageDescription: "GoViral uses the camera when you record a video.",
      NSMicrophoneUsageDescription: "GoViral uses the microphone when you record a video.",
    },
  },
  dmg: {
    artifactName: "GoViral-${version}.${ext}",
    title: "GoViral",
    window: { width: 540, height: 380 },
    contents: [
      { x: 140, y: 190, type: "file" },
      { x: 400, y: 190, type: "link", path: "/Applications" },
    ],
  },
};
