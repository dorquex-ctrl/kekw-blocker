(function () {
  var DEFAULTS = {
    forcePlayerType: "popout",
    reloadAfterAd: true,
    blockTracking: true,
    bufferingFix: true,
    visibilitySpoofing: true,
    autoClaimPoints: true,
    showNotifications: true,
  };

  var KEYS = Object.keys(DEFAULTS);

  function load() {
    chrome.storage.local.get("ttvOptions", function (result) {
      var opts = Object.assign({}, DEFAULTS, result && result.ttvOptions || {});
      for (var i = 0; i < KEYS.length; i++) {
        var el = document.getElementById(KEYS[i]);
        if (!el) continue;
        if (el.type === "checkbox") {
          el.checked = !!opts[KEYS[i]];
        } else {
          el.value = opts[KEYS[i]];
        }
      }
    });
  }

  function save() {
    var opts = {};
    for (var i = 0; i < KEYS.length; i++) {
      var el = document.getElementById(KEYS[i]);
      if (!el) continue;
      if (el.type === "checkbox") {
        opts[KEYS[i]] = el.checked;
      } else {
        opts[KEYS[i]] = el.value;
      }
    }
    chrome.storage.local.set({ ttvOptions: opts });
    chrome.runtime.sendMessage({ type: "OPTIONS_UPDATED", options: opts });
  }

  document.addEventListener("change", function (e) {
    if (KEYS.indexOf(e.target.id) !== -1) save();
  });

  load();
})();
