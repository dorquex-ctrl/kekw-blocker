/**
 * Centralized config — all Twitch-specific values that change with updates.
 * Loaded as a global in background, content scripts, and page context.
 */

// eslint-disable-next-line no-unused-vars
var TTV_CONFIG = Object.freeze({

  // Version — bump when you change this file
  _configVersion: "2026-03-19.1",

  // GQL
  gql: Object.freeze({
    _updated: "2026-03-19",

    url: "https://gql.twitch.tv/gql",
    clientId: "b31o4btkqth5bzbvr9ub2ovr79umhh",
    playbackAccessTokenHash: "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9",
  }),

  remoteConfig: Object.freeze({
    _updated: "2026-03-19",

    defaultUrl: "https://dorquex-ctrl.github.io/kekw-blocker/remote-config.json",
    pollIntervalMs: 60 * 60 * 1000,
    acceleratedRetryMs: Object.freeze([
      5 * 60 * 1000,
      15 * 60 * 1000,
    ]),
    runtimeCandidateWindowMs: 6 * 60 * 60 * 1000,
    runtimeCandidateThreshold: 3,
    temporaryFallbackTtlMs: 24 * 60 * 60 * 1000,
    signing: Object.freeze({
      alg: "ed25519",
      keyId: "k1",
      publicKeys: Object.freeze({
        k1: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAns72CwR/avbSL01iGZN1/7rHERqzP2DLu0Q7DYQF3pk=\n-----END PUBLIC KEY-----\n",
      }),
    }),
  }),

  // HLS
  hls: Object.freeze({
    _updated: "2026-03-15",

    adSignifier: "stitched",            // String Twitch uses in m3u8 to mark ad content
    adSegmentUrlPattern: "\\/stitched-ad\\/",
    segmentUrlPatterns: Object.freeze([
      "*://*.hls.ttvnw.net/*.ts*",
      "*://*.ttvnw.net/*.ts*",
      "*://*.cloudfront.net/*.ts*",
    ]),
  }),

  // Player types — backup streams for ad-free content
  player: Object.freeze({
    _updated: "2026-03-15",

    // Tried in order; first ad-free m3u8 wins
    backupPlayerTypes: Object.freeze([
      "embed",
      "site",
      "popout",
      "autoplay",
    ]),

    fallbackPlayerType: "embed",              // Last resort (may still have ads)
    forceAccessTokenPlayerType: "popout",     // Used by Worker for backup token requests

  }),

  // CSS selectors — update when Twitch redesigns
  selectors: Object.freeze({
    _updated: "2026-03-15",

    adOverlay: Object.freeze([
      '[data-a-target="player-ad-overlay"]',
      ".ad-banner",
      ".video-ad",
      '[class*="ad-overlay"]',
      '[data-test-selector="ad-banner-default-id"]',
    ]),

    purpleScreen: Object.freeze([
      '[data-a-target="player-overlay-commercial-break"]',
      ".commercial-break",
      '[class*="commercial"]',
      '[data-test-selector="ads-overlay"]',
    ]),

    channelPointsClaim: Object.freeze([
      "button[aria-label='Claim Bonus']",
      "[data-test-selector='community-points-summary'] .claimable-bonus__icon",
    ]),
  }),

  // React internals — fiber tree node names
  react: Object.freeze({
    _updated: "2026-03-15",

    playerActiveMethod: "setPlayerActive",
    mediaPlayerProp: "mediaPlayerInstance",
    setSrcMethod: "setSrc",
    setInitialPlaybackMethod: "setInitialPlaybackSettings",
    containerKeyPrefix: "__reactContainer",
  }),

  // Tracking / ad network URLs — blocked via webRequest
  tracking: Object.freeze({
    _updated: "2026-03-15",

    // Keep manifest.json permissions in sync if domains change
    blockedUrlPatterns: Object.freeze([
      // Twitch internal tracking
      "*://spade.twitch.tv/*",
      "*://countess.twitch.tv/*",
      "*://*.twitch.tv/ads/*",
      "*://ads.twitch.tv/*",
      // Google ad network
      "*://ad.doubleclick.net/*",
      "*://imasdk.googleapis.com/*",
      "*://pubads.g.doubleclick.net/*",
      "*://www.googleadservices.com/*",
      "*://video-ad-stats.googlesyndication.com/*",
      "*://pagead2.googlesyndication.com/*",
      "*://securepubads.g.doubleclick.net/*",
      // Amazon ad network
      "*://*.amazon-adsystem.com/*",
      "*://aax.amazon-adsystem.com/*",
    ]),
  }),

  // URL routing
  routing: Object.freeze({
    _updated: "2026-03-15",

    reservedPaths: Object.freeze([
      "directory", "videos", "settings", "subscriptions",
      "inventory", "drops", "u", "moderator", "downloads",
      "turbo", "store", "jobs", "p",
    ]),
  }),
});
