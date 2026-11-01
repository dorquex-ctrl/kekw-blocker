
(function () {
  function createElement(tagName, className, textContent) {
    var element = document.createElement(tagName);
    if (className) element.className = className;
    if (textContent !== undefined && textContent !== null) element.textContent = textContent;
    return element;
  }

  function createStatusRow(label) {
    var row = createElement("div", "status-row");
    var value = createElement("span", "status-value");
    row.appendChild(createElement("span", "status-label", label));
    row.appendChild(value);
    return { row: row, value: value };
  }

  // Built once and then updated in place: rebuilding the content on every
  // refresh would drop keyboard focus from the toggle every two seconds.
  var view = null;

  function buildView(content) {
    content.textContent = "";

    var noChannel = createElement("div", "no-channel", "Navigate to a Twitch stream to see status");
    var statusCard = createElement("div", "status-card");
    var channelRow = createStatusRow("Channel");
    var statusRow = createStatusRow("Status");
    statusCard.appendChild(channelRow.row);
    statusCard.appendChild(statusRow.row);

    var toggleRow = createElement("div", "toggle-row");
    toggleRow.appendChild(createElement("span", "toggle-label", "Ad Blocking"));

    var toggleLabel = createElement("label", "toggle");
    var toggleInput = createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.id = "toggleEnabled";
    toggleInput.setAttribute("aria-label", "Toggle ad blocking");
    toggleInput.addEventListener("change", function () {
      chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: toggleInput.checked });
    });

    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(createElement("span", "toggle-slider"));
    toggleRow.appendChild(toggleLabel);

    content.appendChild(noChannel);
    content.appendChild(statusCard);
    content.appendChild(toggleRow);

    return {
      noChannel: noChannel,
      statusCard: statusCard,
      channelValue: channelRow.value,
      statusValue: statusRow.value,
      toggleInput: toggleInput
    };
  }

  function render(data) {
    var content = document.getElementById("content");
    if (!content) return;
    if (!view) view = buildView(content);

    var hasChannel = !!data.channel;
    view.noChannel.style.display = hasChannel ? "none" : "";
    view.statusCard.style.display = hasChannel ? "" : "none";

    if (hasChannel) {
      var statusText;
      var statusClass;
      if (data.enabled === false) {
        statusText = "Disabled";
        statusClass = "status-disabled";
      } else if (data.adActive) {
        statusText = "Blocking Ads";
        statusClass = "status-blocking";
      } else {
        statusText = "Enabled";
        statusClass = "status-enabled";
      }
      view.channelValue.textContent = data.channel;
      view.statusValue.textContent = statusText;
      view.statusValue.className = "status-value " + statusClass;
    }

    var enabled = data.enabled !== false;
    if (view.toggleInput.checked !== enabled) view.toggleInput.checked = enabled;
  }

  function refreshState() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs[0]) return;
      chrome.runtime.sendMessage({ type: "GET_POPUP_STATE", tabId: tabs[0].id }, function (response) {
        render(response || { channel: null });
      });
    });
  }

  document.getElementById("openSettings").addEventListener("click", function () {
    chrome.runtime.openOptionsPage();
  });

  document.querySelector(".version").textContent = "v" + chrome.runtime.getManifest().version;

  refreshState();

  setInterval(function () {
    refreshState();
  }, 2000);
})();
