# GoViral for Windows and Mac

The downloadable desktop app: `GoViral-Setup-<version>-x64.exe` (Windows; `-arm64.exe` for ARM PCs)
and `GoViral-<version>.dmg` (Mac, one file for Apple Silicon and Intel).

It is a small Electron shell around **https://app.govirall.now/desktop**, the same app people can
already use in a browser. So:

- **The app updates the moment the website deploys.** Nothing here needs rebuilding for app changes.
- Same sign-in cookie, same `/api`, no server changes.
- This repo only changes when the *shell* changes (window, menu, signing, icons). Shell updates
  reach installed copies by themselves through GitHub Releases (checked at launch and every 4 hours).

## What the shell adds over the browser / installed web app

| | |
|---|---|
| Window | 1440x900 to start, never smaller than 1100x700, remembers size, position and maximized. Dark title strip that matches the app (Mac traffic lights / Windows buttons drawn over it). One copy at a time: opening it again focuses the open one. |
| Links | Other sites (Commas checkout, Google Drive, TikTok, mail) open in the person's normal browser. Pages of app.govirall.now that are not the app open in a GoViral window with the same sign-in. |
| Saving videos | "Save to this computer" goes straight to **Downloads** (never overwriting a file), shows progress on the taskbar / dock icon, then a notification; clicking it shows the file in its folder. |
| Background work | Uploads and exports keep full speed while the window is minimized or behind others (a browser tab slows down). |
| Deep links | `goviral://<path>` opens `app.govirall.now/desktop/<path>` in the app; `goviral://open?url=<an app.govirall.now address>` opens that page. Anything pointing at another site is ignored. |
| Offline | No internet: a GoViral "You're offline" page that reconnects on its own. |
| Menu | Edit (undo, redo, cut, copy, paste, select all, so text fields work on a Mac), View (reload, zoom, full screen), Help (Contact support, check for updates, log file). Right-click menu with spelling suggestions. |
| Security | contextIsolation on, nodeIntegration off, sandbox on. The page gets only `window.goviralDesktop = { version, platform }`, plus `tiktok` on the app's own /desktop pages (Groot posts to TikTok, below). Permissions allowed only for app.govirall.now: camera, microphone, clipboard, HTML fullscreen, persistent storage (so the browser engine never clears the videos kept on the computer). Electron fuses: no run-as-Node, no NODE_OPTIONS / --inspect, app loads only from app.asar, cookies encrypted on disk. |

## Files

```
src/main.js          the shell (window, menu, links, downloads, deep links, permissions, updates)
src/preload.js       window.goviralDesktop + the title strip
src/links.js         which addresses are the app, where goviral:// lands (tested by scripts/check.cjs)
src/offline.html     the offline page
src/tiktok/          Groot posts to TikTok: rules.js (pure rules + selectors), engine.js (scripted steps + AI
                     fallback), page.js (CDP driver), window.js (the TikTok window + bar), poster.js, index.js (IPC)
test/tiktok-mock/    a local mock of TikTok Studio's upload page, for the harness only (never packaged)
assets/logo.png      offline page logo + window icon
build/               icon.ico (Windows), icon-mac.png (Mac, becomes .icns), entitlements.mac.plist
electron-builder.config.js   packaging + signing (signing switches on only when its secrets exist)
.github/workflows/release.yml  CI: builds Windows + Mac on a version tag, publishes to GitHub Releases
scripts/make-icons.cjs   regenerates every icon from the iPhone app's icon
scripts/check.cjs        npm run check: parses, link rules, config, and the packaged app.asar
```

## Commands

```
npm install
npm run check            # no window opens
npm run test:tiktok      # Groot's posting rules, plain Node
npm run harness:tiktok   # the TikTok engine end to end against the local mock (opens windows briefly)
npm start                # run it (if Electron says it is not installed: node node_modules/electron/install.js)
npm run dist:win:x64     # unsigned Windows installer in dist/ (Windows machine)
npm run dist:mac         # Mac dmg + zip (a Mac only)
```

**Releasing:** bump `version` in package.json, commit, `git tag v1.0.1`, `git push && git push --tags`.
CI makes a draft release, builds Windows and Mac into it, and makes it public only when both are done.
A manual run (Actions > Release > Run workflow) builds both and keeps them on the run without publishing.

---

# What Drew needs to provide

Everything is built. Without the items below the app still builds and runs, but **unsigned**:
Windows shows "Windows protected your PC" (people must click *More info > Run anyway*), and the Mac
says it "cannot be opened" (people must go to *System Settings > Privacy & Security > Open Anyway*),
and Mac auto-update does not work until it is signed. Signing removes all of that.

Do them in this order. Total: about 1 hour of clicking, plus waiting for Microsoft to verify the business.

## 1. A GitHub repo for the downloads (5 minutes, free)

1. On github.com (account `evanmurph2023`): **New repository**, name `goviral-desktop`, **Public**.
   Public matters: installed apps download updates from it without a password, and the download
   buttons link straight to its files. (Only this shell's code is in it; no secrets, no app code.)
   If it has to be another name or account, change `owner` / `repo` in `electron-builder.config.js`.
2. Push this folder to it (`git remote add origin https://github.com/evanmurph2023/goviral-desktop.git`,
   `git push -u origin main`). CI needs nothing else: it uses GitHub's own token to publish.

## 2. Mac: Developer ID certificate (about 20 minutes, $0: included in the $99/year Apple Developer membership you already have)

Must be done by the **Account Holder** of the Apple Developer account (only that role can make a
Developer ID certificate). Done on Windows with the `openssl` that comes with Git
(`C:\Program Files\Git\usr\bin\openssl.exe`, or just `openssl` in Git Bash).

**a. Make the request (CSR)** in an empty folder:

```
openssl genrsa -out devid.key 2048
openssl req -new -key devid.key -out devid.csr -subj "/emailAddress=YOUR_APPLE_ID_EMAIL/CN=GoViral/C=US"
```

**b. Get the certificate:** developer.apple.com/account > **Certificates, IDs & Profiles** >
Certificates > **+** > **Developer ID Application** > Profile Type **G2 Sub-CA** > upload
`devid.csr` > **Download** (you get `developerID_application.cer`). Also download Apple's
intermediate: https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer

**c. Turn them into a .p12** (pick a strong password when asked, you need it below):

```
openssl x509 -inform DER -in developerID_application.cer -out devid.pem
openssl x509 -inform DER -in DeveloperIDG2CA.cer -out g2ca.pem
openssl pkcs12 -export -inkey devid.key -in devid.pem -certfile g2ca.pem -out GoViral-DeveloperID.p12 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
openssl base64 -A -in GoViral-DeveloperID.p12 -out GoViral-DeveloperID.p12.base64.txt
```

(The `PBE-SHA1-3DES` / `sha1` options matter: macOS cannot import a .p12 made with OpenSSL 3's defaults.)

**d. App-specific password** (lets CI notarize, i.e. have Apple scan and approve each build):
account.apple.com > **Sign-In and Security** > **App-Specific Passwords** > **+**, name it
"GoViral notarize". Copy the `xxxx-xxxx-xxxx-xxxx` password.

**e. Team ID:** developer.apple.com/account > **Membership details** > Team ID (10 characters).

**f. Add these GitHub secrets** (repo > Settings > Secrets and variables > Actions > New repository secret):

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | the whole contents of `GoViral-DeveloperID.p12.base64.txt` |
| `MAC_CSC_KEY_PASSWORD` | the .p12 password from step c |
| `APPLE_ID` | the Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the password from step d |
| `APPLE_TEAM_ID` | the Team ID from step e |

Then delete `devid.key`, the .p12 and the .txt from the computer (or keep them in a password manager;
the .p12 is the only copy of the private key, and the certificate is valid for 5 years).

## 3. Windows: code signing (choose A; B only if A is not available)

### A. Azure Trusted Signing (recommended): $9.99/month, about 1 hour of setup + 1 to 10 business days of verification

Microsoft's own signing service (it may appear as **Artifact Signing** in the Azure portal). No USB
token, works from CI, and Windows SmartScreen builds trust in it the fastest.
Who qualifies: a business registered in the US, Canada, EU or UK with **3+ years of history**
(it checks public records and may ask for documents), or an individual developer in the US/Canada.

1. portal.azure.com: sign up / sign in, make sure there is a **pay-as-you-go subscription**.
2. Subscriptions > your subscription > **Resource providers** > register **Microsoft.CodeSigning**.
3. Create a **Trusted Signing Account** (Basic plan, $9.99/month). Pick region **East US**; note the
   account name. The endpoint for East US is `https://eus.codesigning.azure.net`
   (West US 2: `https://wus2.codesigning.azure.net`, West Europe: `https://weu.codesigning.azure.net`).
4. Give yourself the role **Trusted Signing Identity Verifier** on that account (Access control (IAM) > Add role assignment).
5. In the account: **Identity validation** > New > **Public Trust** > Organization, with the
   company's exact legal name and details. Wait for **Completed** (1 to 10 business days).
6. **Certificate profiles** > Create > **Public Trust**, pick the validated identity, name it
   e.g. `goviral`. The certificate's name (its CN) is the validated legal name, e.g. `GoViral LLC`.
7. Microsoft Entra ID > **App registrations** > New registration, name `goviral-desktop-ci` >
   note the **Application (client) ID** and **Directory (tenant) ID** > Certificates & secrets >
   **New client secret** (24 months) > copy its **Value**.
8. Back on the Trusted Signing account > Access control (IAM) > Add role assignment >
   **Trusted Signing Certificate Profile Signer** > assign to `goviral-desktop-ci`.
9. GitHub secrets:

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_CLIENT_ID` | Application (client) ID |
| `AZURE_CLIENT_SECRET` | the client secret's Value |
| `AZURE_SIGN_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGN_ACCOUNT` | the Trusted Signing account name |
| `AZURE_SIGN_PROFILE` | the certificate profile name |
| `WIN_PUBLISHER_NAME` | the certificate's name exactly, e.g. `GoViral LLC` |

The client secret expires (24 months); put a reminder to renew it.

### B. A bought OV/EV certificate: about $200 to $600/year, 1 to 7 days of verification

From Sectigo, DigiCert, SSL.com etc. Since 2023 these keys must live on a hardware token or a cloud
HSM, so a plain .pfx file is rarely possible any more; to sign in CI you need the vendor's cloud
signing (e.g. SSL.com eSigner, DigiCert KeyLocker), which needs its own setup step in the workflow.
If you do get an exportable .pfx: secrets `WIN_CSC_LINK` (base64 of the .pfx, made with
`openssl base64 -A -in cert.pfx -out cert.txt`), `WIN_CSC_KEY_PASSWORD`, and `WIN_PUBLISHER_NAME`
(the certificate's CN). EV no longer skips the SmartScreen warning on its own (Microsoft changed
that in 2024), so A is better value.

## 4. Release

Bump `version` in package.json, commit, tag `v<version>`, push the tag. CI takes ~15 minutes
(notarization adds 2 to 10). The build log says "signing with Azure Trusted Signing" /
"notarizing", or warns that it built unsigned.

## 5. The /download page (platform repo, not done yet)

The buttons should point at short links on the site that always resolve to the newest release,
because the file names carry the version:

- `app.govirall.now/download/windows`  -> newest `GoViral-Setup-*-x64.exe`
- `app.govirall.now/download/windows-arm` -> newest `GoViral-Setup-*-arm64.exe`
- `app.govirall.now/download/mac` -> newest `GoViral-*.dmg`

Each is a small route that reads `https://api.github.com/repos/evanmurph2023/goviral-desktop/releases/latest`
(cached 5 minutes), finds the matching file, and redirects to its `browser_download_url`; if GitHub
fails or there is no release yet, it redirects to `/desktop?install=1` (the current install-from-browser
flow). The page shows "Download for Windows" or "Download for Mac" first depending on the visitor's
computer, the other one under it, and keeps "Or install from your browser" as the third option.
Inside the desktop app, `window.goviralDesktop` exists, so the app's own "Install GoViral" card
should hide itself there.

---

# Groot posts to TikTok (2026-10-03)

The app asks `window.goviralDesktop.tiktok.post({ postId, videoUrl, name, product, caption, hashtags, mode })`
for one finished cut at a time (the app queues the rest). The main process checks the caller (only
`<app>/desktop` pages) and every field, downloads the export to a temp file, and drives the real
TikTok Studio upload page in a window of its own:

- **The TikTok window**: a bar on top (what Groot is doing, **Stop**, and in Manual **Done, next video**)
  over TikTok in its own persistent session `persist:tiktok`: the creator logs in once. No permissions,
  no downloads, only TikTok and its log-in providers. Nothing is injected into TikTok's page.
- **Scripted steps first** (src/tiktok/rules.js TARGETS): open, upload (DOM.setFileInputFiles), wait for
  processing, caption (select all, delete, type), Add link, Products, search, pick, confirm, Post,
  Post now, confirm it posted. Real mouse moves and clicks, typing in small chunks, pauses between.
- **AI fallback**: when a step cannot find its target, the visible elements and a screenshot go to
  `POST /api/groot-post/next-action` (Claude on the platform, the key never leaves the server); one
  action comes back and is checked twice (platform and here). Capped per step and per post.
- **Never**: solves a captcha or types a password. Either pauses everything until the creator does it.
- **Manual** stops on the filled-in page and watches for the creator's own Post.

The selectors are best guesses at TikTok Studio's page (built against the local mock, never against
tiktok.com). The first real run will show which ones TikTok uses; the AI fallback covers the rest.
