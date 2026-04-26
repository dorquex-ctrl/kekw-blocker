<p align="center">
  <img src="icons/icon128.png" alt="KEKW Blocker" width="96" height="96">
</p>

<h1 align="center">KEKW Blocker</h1>

<p align="center">
  <strong>Twitch ad blocker that fixes itself.</strong><br>
  Self-healing config. Minimal manual upkeep.
</p>

<p align="center">
  <a href="https://ko-fi.com/dorquex"><img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
  <img src="https://img.shields.io/badge/version-1.2.0-bf94ff" alt="Version">
  <img src="https://img.shields.io/badge/manifest-v3-333" alt="Manifest V3">
  <img src="https://img.shields.io/badge/firefox%20%7C%20chromium-supported-green" alt="Browsers">
</p>

---

## How It Works

KEKW Blocker hooks Twitch's video player Worker and uses **backup player type switching** to request streams through alternative player types that serve ad-free content. When ads are detected, the extension compares manifests, finds a clean stream, and swaps it in. Backup playlists are **pre-warmed adaptively** in the background so the switch is usually near-instant with less unnecessary network churn.

If the primary mechanism cannot handle it, stitched ad segments are redirected to a silent blank file as a fallback. The extension also blocks ad tracking requests (DoubleClick, Amazon Ads, etc.), hides ad overlay UI elements, persists runtime-learned Twitch request values across reloads, and uses a recovery ladder for Twitch's purple "commercial break" screen and buffering stalls.

**What makes KEKW Blocker different is that it fixes itself.** Many Twitch ad blockers break when Twitch rotates internal values and stay broken until someone manually updates them. KEKW Blocker can detect and apply those changes automatically.

### Self-Healing Config

Twitch regularly rotates internal values like API hashes and client IDs. When they do, most ad blockers break until the developer manually updates.

KEKW Blocker fixes itself:

1. **Every 6 hours**, a GitHub Actions workflow scrapes Twitch's production JavaScript bundles
2. **Regex + AST extraction** pull the latest client ID, persisted-query hash, and full `PlaybackAccessToken` query text
3. Candidates are **live-validated against Twitch GQL** before they are promoted
4. If extraction fails, an **AI fallback** (`gpt-5-mini`) proposes candidates, but low-confidence or unvalidated values are not auto-promoted
5. The published config is a **signed schema v2 payload** with active values, validated fallbacks, and a remote query fallback
6. The extension **checks for signed config on startup and then every hour**, verifies the signature locally, and can temporarily promote runtime-learned candidates while accelerated retries run in the background

If both extraction and AI fallback fail, the pipeline sends a **Discord alert** and opens a **GitHub Issue** automatically.

---

## Installation

### Chromium (Chrome, Brave, Edge, Opera, Vivaldi, Arc)

This extension is **Manifest V3**.

1. Download or clone this repo
2. Open your browser's extensions page (`chrome://extensions`, `brave://extensions`, `edge://extensions`, etc.)
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** and select the project folder
5. Navigate to any Twitch stream - ads are blocked immediately

### Firefox

Install from Firefox Add-ons:

- [KEKW Blocker on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/kekw-blocker/)

For local development and testing:

1. Run `npm run build:firefox` to generate the Firefox dev build
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** and select `dist/firefox/manifest.json`

Firefox temporary add-ons are unloaded when the browser restarts, so you need to load it again after each restart unless you package/sign it separately.

---

## What Gets Blocked

| Target | Method |
|--------|--------|
| Pre-roll ads | Backup player type serves ad-free stream |
| Mid-roll ads | Worker detects ad markers, swaps to clean manifest |
| Stitched ad segments | Redirected to silent `.ts` file |
| Ad overlays & banners | CSS hiding via DOM monitor |
| Purple "commercial break" screen | Auto-detected, triggers the recovery ladder |
| Ad tracking requests | URL pattern blocking (DoubleClick, Amazon Ads, etc.) |

---

## Popup

The extension popup shows real-time status:

- **Current channel** and blocking state when you are on a Twitch stream
- **Global ad-blocking toggle** even when you are not currently on a stream
- **Quick toggle** to enable/disable blocking
- **Settings gear** to open the options page

---

## Options

Access via the gear icon in the popup or right-click extension icon > Options:

| Setting | Description |
|---------|-------------|
| Stream Request Mode | How backup streams are requested (Recommended / Alternative / Off) |
| Clean Restart After Ads | Allow a clean player restart after ads when recovery needs it to restore quality |
| Block Ad Tracking | Block requests to ad networks (DoubleClick, Amazon Ads, etc.) |
| Auto-Fix Buffering | Automatically recover when the stream stalls or buffers |
| Prevent Background Pausing | Keep the stream playing when you switch to another tab |
| Auto-Claim Channel Points | Automatically click the bonus channel points button |
| Show Notifications | Display status banners on the stream when blocking ads or recovering |

The options page also includes a **Debug** panel that shows the effective signed config, signature verification state, last fetch result, temporary runtime fallbacks, and reset actions for runtime learning and the signed cache.

---

## Building

```bash
# Chromium - load the project folder directly, no build needed

# Firefox temporary install
npm run build:firefox
```

---

## Support

If KEKW Blocker saves you from Twitch ads, consider supporting development:

<a href="https://ko-fi.com/dorquex"><img src="https://img.shields.io/badge/Buy_me_a_coffee-Ko--fi-ff5e5b?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>

---

## License

MIT
