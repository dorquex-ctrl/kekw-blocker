// Player monitor — ad overlay detection, purple screen recovery, channel points claim.

(function () {
  "use strict";

  var AD_SELECTORS = TTV_CONFIG.selectors.adOverlay;
  var PURPLE_SCREEN_SELECTORS = TTV_CONFIG.selectors.purpleScreen;
  var _adSelectorJoined = AD_SELECTORS.join(",");
  var _purpleSelectorJoined = PURPLE_SCREEN_SELECTORS.join(",");

  var adBlockingEnabled = true;
  var adDetected = false;
  var purpleScreenCount = 0;
  var lastPurpleScreenReload = 0;
  var PURPLE_SCREEN_RELOAD_COOLDOWN = 5000;
  var PURPLE_SCREEN_RELOAD_THRESHOLD = 3; // reload after seeing purple screen for this many checks

  // Read nonce once at load, then clear from DOM to reduce exposure window
  var _ttvNonce = document.documentElement.getAttribute("data-ttv-nonce") || "";
  document.documentElement.removeAttribute("data-ttv-nonce");

  var _cachedChannel = null;
  var _cachedPathname = null;

  function getChannelName() {
    var pathname = window.location.pathname;
    if (pathname === _cachedPathname) return _cachedChannel;
    _cachedPathname = pathname;
    var match = pathname.match(/^\/([a-zA-Z0-9_]+)/);
    var reserved = TTV_CONFIG.routing.reservedPaths;
    if (match && reserved.indexOf(match[1]) === -1) {
      _cachedChannel = match[1].toLowerCase();
    } else {
      _cachedChannel = null;
    }
    return _cachedChannel;
  }

  function checkForAds() {
    if (!adBlockingEnabled) return;
    var channel = getChannelName();
    if (!channel) return;

    var adOverlay = !!document.querySelector(_adSelectorJoined);
    var purpleScreen = !!document.querySelector(_purpleSelectorJoined);

    if (purpleScreen) {
      purpleScreenCount++;
      // Auto-recover: if purple screen persists, reload the player
      if (purpleScreenCount >= PURPLE_SCREEN_RELOAD_THRESHOLD &&
          Date.now() - lastPurpleScreenReload > PURPLE_SCREEN_RELOAD_COOLDOWN) {
        console.log("[TTV] Content: Purple screen persisted — triggering player reload");
        lastPurpleScreenReload = Date.now();
        purpleScreenCount = 0;
        adDetected = true; // Prevent duplicate message from the ad detection block below
        // Bridge to page context via CustomEvent (content scripts can't call page globals directly)
        window.dispatchEvent(new CustomEvent("ttv-" + _ttvNonce + "-notify", {
          detail: { message: "KEKW Blocker: Recovering from commercial break" }
        }));
        window.dispatchEvent(new CustomEvent("ttv-" + _ttvNonce + "-reload"));
        // Also notify background
        chrome.runtime.sendMessage({
          type: "PURPLE_SCREEN_DETECTED",
          channel: channel
        });
      }
    } else {
      purpleScreenCount = 0;
    }

    if ((adOverlay || purpleScreen) && !adDetected) {
      adDetected = true;
      console.log("[TTV] Content: Ad detected on " + channel);

      chrome.runtime.sendMessage({
        type: purpleScreen ? "PURPLE_SCREEN_DETECTED" : "AD_DETECTED",
        channel: channel
      });

      hideAdElements();
    } else if (!adOverlay && !purpleScreen && adDetected) {
      adDetected = false;
      restoreVideo();
      console.log("[TTV] Content: Ad ended on " + channel);
      chrome.runtime.sendMessage({ type: "AD_ENDED", channel: channel });
    }
  }

  function hideAdElements() {
    var selectors = AD_SELECTORS.concat(PURPLE_SCREEN_SELECTORS);
    for (var i = 0; i < selectors.length; i++) {
      var els = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        els[j].style.display = "none";
      }
    }

    var video = document.querySelector("video");
    if (video && !video._ttvMuted) {
      video._ttvOrigVolume = video.volume;
      video._ttvOrigMuted = video.muted;
      video._ttvMuted = true;
      video.muted = true;
    }
  }

  function restoreVideo() {
    var video = document.querySelector("video");
    if (video && video._ttvMuted) {
      video.muted = video._ttvOrigMuted || false;
      video.volume = video._ttvOrigVolume || 1;
      video._ttvMuted = false;
    }
  }

  // --- Channel Points Auto-Claim ---

  var CLAIM_INTERVAL_MS = 2000;
  var autoClaimEnabled = true;

  // Load option from storage
  chrome.storage.local.get("ttvOptions", function (result) {
    if (result && result.ttvOptions && result.ttvOptions.autoClaimPoints !== undefined) {
      autoClaimEnabled = !!result.ttvOptions.autoClaimPoints;
    }
  });

  function claimChannelPoints() {
    if (!autoClaimEnabled) return;
    try {
      // Only target the actual bonus claim button — it uses a specific test selector
      // that only appears when the bonus is ready to claim
      var claimSelectors = TTV_CONFIG.selectors.channelPointsClaim;
      var claimBtn = null;
      for (var ci = 0; ci < claimSelectors.length && !claimBtn; ci++) {
        claimBtn = document.querySelector(claimSelectors[ci]);
      }
      if (claimBtn) {
        claimBtn.click();
        console.log("[TTV] Content: Auto-claimed channel points");
      }
    } catch (e) {}
  }

  // --- Listen for ad-block stats from page-inject (via custom event) ---

  var lastAdBlockStatus = false;

  window.addEventListener("ttv-" + _ttvNonce + "-adblock-status", function (e) {
    if (!e.detail) return;
    var channel = getChannelName();
    if (!channel) return;

    if (e.detail.hasAds && !lastAdBlockStatus) {
      lastAdBlockStatus = true;
      chrome.runtime.sendMessage({
        type: "AD_DETECTED",
        channel: channel,
        source: "worker"
      });
    } else if (!e.detail.hasAds && lastAdBlockStatus) {
      lastAdBlockStatus = false;
      chrome.runtime.sendMessage({
        type: "AD_ENDED",
        channel: channel,
        source: "worker"
      });
    }
  });

  // --- Message listener ---

  chrome.runtime.onMessage.addListener(function(message) {
    if (!message || !message.type) return;
    if (message.type === "OPTIONS_UPDATED" && message.options) {
      if (message.options.autoClaimPoints !== undefined) {
        autoClaimEnabled = !!message.options.autoClaimPoints;
      }
    }
    if (message.type === "SET_ENABLED") {
      adBlockingEnabled = !!message.enabled;
    }
  });

  // --- Init ---

  function init() {
    // Debounced ad check — coalesces rapid MutationObserver callbacks
    var adCheckPending = false;
    function scheduleAdCheck() {
      if (adCheckPending) return;
      adCheckPending = true;
      requestAnimationFrame(function() {
        adCheckPending = false;
        checkForAds();
      });
    }

    // MutationObserver scoped to the player container when possible
    var playerContainer = document.querySelector(".persistent-player") ||
                          document.querySelector("[data-a-target='video-player']") ||
                          document.querySelector(".video-player") ||
                          document.body;
    var observer = new MutationObserver(scheduleAdCheck);
    observer.observe(playerContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "data-a-target"]
    });

    // If we scoped to a player container, re-scope to body if the player
    // gets removed (SPA navigation). Also serves as a fallback poll.
    setInterval(function() {
      // Fallback ad check (in case observer misses something)
      checkForAds();
      // Re-scope observer if player container was removed from DOM
      if (playerContainer !== document.body && !document.contains(playerContainer)) {
        var newContainer = document.querySelector(".persistent-player") ||
                           document.querySelector("[data-a-target='video-player']") ||
                           document.querySelector(".video-player");
        if (newContainer) {
          observer.disconnect();
          playerContainer = newContainer;
          observer.observe(playerContainer, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "data-a-target"]
          });
        }
      }
    }, 2000);

    // Channel points auto-claim
    setInterval(claimChannelPoints, CLAIM_INTERVAL_MS);

    console.log("[TTV] Content script initialized (with purple screen recovery + auto-claim)");
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
