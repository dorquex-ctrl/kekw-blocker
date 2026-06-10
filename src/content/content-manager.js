/**
 * Content Manager for Manifest V3
 * Handles main-world injection and bridge logic.
 */
(function() {
  'use strict';

  const nonce = Math.random().toString(36).substring(2, 15);
  document.documentElement.setAttribute('data-ttv-nonce', nonce);

  // Inject the core ad-blocking logic into the Main World.
  // This is required to intercept Workers and Fetch requests.
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/content/page-inject.js');
  
  // Pass configuration/startup data to the page context
  window.__TTV_CONFIG = typeof TTV_CONFIG !== 'undefined' ? TTV_CONFIG : {};
  window.__TTV_NONCE = nonce;

  (document.head || document.documentElement).appendChild(script);
  script.onload = () => {
    script.remove();
  };
})();