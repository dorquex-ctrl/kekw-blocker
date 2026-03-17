// Runs at document_start — hooks Worker and fetch before Twitch's scripts load.
(function () {
  "use strict";
  if (window !== window.top) return; // Only run in the top frame

  // Nonce for event authentication between content scripts and page-inject
  var nonce = Math.random().toString(36).substring(2);
  document.documentElement.setAttribute("data-ttv-nonce", nonce);

  // Bridge config + nonce into page context
  var configScript = document.createElement("script");
  configScript.textContent = "window.__TTV_CONFIG = " + JSON.stringify(TTV_CONFIG) + ";" +
    "window.__TTV_NONCE = " + JSON.stringify(nonce) + ";";
  (document.documentElement || document.head || document.body).appendChild(configScript);
  configScript.remove();

  var script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/page-inject.js");
  (document.documentElement || document.head || document.body).appendChild(script);

  script.onload = function () {
    script.remove();
  };

  chrome.storage.local.get("ttvOptions", function (result) {
    var opts = result && result.ttvOptions || {};
    window.dispatchEvent(new CustomEvent("ttv-" + nonce + "-options", { detail: opts }));
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message) return;
    if (message.type === "OPTIONS_UPDATED") {
      window.dispatchEvent(new CustomEvent("ttv-" + nonce + "-options", { detail: message.options }));
    }
    if (message.type === "SET_ENABLED") {
      window.dispatchEvent(new CustomEvent("ttv-" + nonce + "-enabled", { detail: { enabled: message.enabled } }));
    }
    if (message.type === "REMOTE_CONFIG_UPDATED") {
      window.dispatchEvent(new CustomEvent("ttv-" + nonce + "-config", { detail: message.config }));
    }
  });
})();
