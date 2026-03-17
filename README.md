<p align="center">
  <img src="icons/icon128.png" alt="KEKW Blocker" width="96" height="96">
</p>

<h1 align="center">KEKW Blocker</h1>

<p align="center">
  <strong>Twitch ad blocker that fixes itself.</strong><br>
  Self-healing config. Zero manual upkeep.
</p>

<p align="center">
  <a href="https://ko-fi.com/dorquex"><img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  <img src="https://img.shields.io/badge/version-1.0.2-bf94ff" alt="Version">
  <img src="https://img.shields.io/badge/manifest-v2-333" alt="Manifest V2">
  <img src="https://img.shields.io/badge/chromium%20%7C%20firefox-supported-green" alt="Browsers">
</p>

---

## How It Works

KEKW Blocker hooks Twitch's video player Worker and uses **backup player type switching** to request streams through alternative player types that serve ad-free content. When ads are detected, the extension compares manifests, finds a clean stream, and swaps it in. Backup tokens are **pre-warmed** in the background so the switch is near-instant with no stutter.

If the primary mechanism can't handle it, stitched ad segments are redirected to a silent blank file as a fallback. The extension also blocks ad tracking requests (DoubleClick, Amazon Ads, etc.), hides ad overlay UI elements, and auto-recovers from Twitch's purple "commercial break" screen.

**What makes KEKW Blocker different is that it fixes itself.** Every other Twitch ad blocker breaks when Twitch rotates internal values — and stays broken until someone manually updates it. KEKW Blocker detects and applies those changes automatically.

### Self-Healing Config

Twitch regularly rotates internal values like API hashes and client IDs. When they do, most ad blockers break until the developer manually updates.

KEKW Blocker fixes itself:

1. **Every 6 hours**, a GitHub Actions workflow scrapes Twitch's production JavaScript bundles
2. **Regex extraction** pulls the latest hashes and client IDs
3. If regex fails (Twitch restructured their code), an **AI fallback** (GPT-5-mini) analyzes the minified bundles
4. Updated values are published to a **public config endpoint** via GitHub Pages
5. The extension **fetches new config every hour** and applies it live

If everything fails, a **Discord alert** fires and a **GitHub Issue** is opened automatically.

---

## Installation

### Chromium (Chrome, Brave, Edge, Opera, Vivaldi, Arc)

1. Download or clone this repo
2. Open your browser's extensions page (`chrome://extensions`, `brave://extensions`, `edge://extensions`, etc.)
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the project folder
5. Navigate to any Twitch stream — ads are blocked immediately

### Firefox

1. Run `node scripts/build.js firefox` to generate the Firefox build
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** and select `dist/firefox/manifest.json`

---

## What Gets Blocked

| Target | Method |
|--------|--------|
| Pre-roll ads | Backup player type serves ad-free stream |
| Mid-roll ads | Worker detects ad markers, swaps to clean manifest |
| Stitched ad segments | Redirected to silent `.ts` file |
| Ad overlays & banners | CSS hiding via DOM monitor |
| Purple "commercial break" screen | Auto-detected, triggers player reload |
| Ad tracking requests | URL pattern blocking (DoubleClick, Amazon Ads, etc.) |

---

## Popup

The extension popup shows real-time status:

- **Current channel** and blocking state (Protected / Blocking Ads)
- **Session stats** — ads blocked, time saved, tracking blocked
- **Lifetime stats** — persisted across sessions
- **Quick toggle** to enable/disable blocking
- **Settings gear** to open the options page

---

## Options

Access via the gear icon in the popup or right-click extension icon > Options:

| Setting | Description |
|---------|-------------|
| Stream Request Mode | How backup streams are requested (Recommended / Alternative / Off) |
| Clean Restart After Ads | Seek to live edge when ads end for clean transition |
| Block Ad Tracking | Block requests to ad networks (DoubleClick, Amazon Ads, etc.) |
| Auto-Fix Buffering | Automatically recover when the stream stalls or buffers |
| Prevent Background Pausing | Keep the stream playing when you switch to another tab |
| Auto-Claim Channel Points | Automatically click the bonus channel points button |
| Show Notifications | Display status banners on the stream when blocking ads or recovering |

---

## Building

```bash
# Chromium — load the project folder directly, no build needed

# Firefox
node scripts/build.js firefox

# Firefox (with .zip for distribution)
node scripts/build.js firefox --zip
```

---

## Support

If KEKW Blocker saves you from Twitch ads, consider supporting development:

<a href="https://ko-fi.com/dorquex"><img src="https://img.shields.io/badge/Buy_me_a_coffee-Ko--fi-ff5e5b?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>

---

## License

MIT
