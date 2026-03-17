
(function () {
  function render(data) {
    var content = document.getElementById("content");

    if (!data.channel) {
      content.innerHTML = '<div class="no-channel">Navigate to a Twitch stream to see status</div>' +
        renderLifetimeStats(data.lifetime || data.stats);
      return;
    }

    var dotClass = "dot-green";
    var statusText = "Protected";
    if (data.adActive) {
      dotClass = "dot-orange";
      statusText = "Blocking Ads";
    }

    var html = '<div class="status-card">' +
      '<div class="status-row">' +
        '<span class="status-label">Channel</span>' +
        '<span class="status-value">' + escapeHtml(data.channel) + '</span>' +
      '</div>' +
      '<div class="status-row">' +
        '<span class="status-label">Status</span>' +
        '<span class="status-value"><span class="dot ' + dotClass + '"></span>' + statusText + '</span>' +
      '</div>' +
    '</div>';

    // Session stats
    html += '<div class="section-label">This Session</div>';
    html += '<div class="stats-grid">' +
      statBox(data.channelAdsBlocked || 0, "Ads Blocked") +
      statBox(formatTime(data.stats.timeSavedMs || 0), "Time Saved") +
      statBox(data.stats.trackingBlocked || 0, "Tracking") +
    '</div>';

    // Lifetime stats
    if (data.lifetime) {
      html += '<div class="section-label">Lifetime</div>';
      html += '<div class="stats-grid">' +
        statBox(data.lifetime.totalAdsBlocked || 0, "Total Blocked") +
        statBox(data.lifetime.sessionsCount || 0, "Sessions") +
      '</div>';
    }

    html += '<div class="toggle-row">' +
      '<span class="toggle-label">Ad Blocking</span>' +
      '<label class="toggle"><input type="checkbox" id="toggleEnabled" aria-label="Toggle ad blocking" ' + (data.enabled !== false ? 'checked' : '') + '><span class="toggle-slider"></span></label>' +
    '</div>';

    content.innerHTML = html;

    var toggle = document.getElementById("toggleEnabled");
    if (toggle) {
      toggle.addEventListener("change", function () {
        chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: toggle.checked });
      });
    }
  }

  document.getElementById("openSettings").addEventListener("click", function () {
    chrome.runtime.openOptionsPage();
  });

  document.querySelector(".version").textContent = "v" + chrome.runtime.getManifest().version;

  function renderLifetimeStats(stats) {
    return '<div class="section-label" style="margin-top:12px">Lifetime Stats</div>' +
      '<div class="stats-grid">' +
      statBox(stats.totalAdsBlocked || 0, "Total Blocked") +
      statBox(stats.trackingBlocked || 0, "Tracking") +
    '</div>';
  }

  function statBox(num, label) {
    return '<div class="stat-box"><div class="stat-number">' + formatNum(num) + '</div><div class="stat-label">' + label + '</div></div>';
  }

  function formatNum(n) {
    if (typeof n === "string") return n;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "K";
    return String(n);
  }

  function formatTime(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs[0]) return;
    chrome.runtime.sendMessage({ type: "GET_POPUP_STATE", tabId: tabs[0].id }, function (response) {
      if (response) {
        render(response);
      } else {
        render({ channel: null, stats: { totalAdsBlocked: 0 }, lifetime: { totalAdsBlocked: 0 } });
      }
    });
  });

  // Auto-refresh every 2s while popup is open
  setInterval(function () {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) return;
      chrome.runtime.sendMessage({ type: "GET_POPUP_STATE", tabId: tabs[0].id }, function (response) {
        if (response) render(response);
      });
    });
  }, 2000);
})();
