// Orchestrator — coordinates layers and handles message passing.

const Orchestrator = {
  _enabled: true,
  _options: {
    forcePlayerType: "popout",
    reloadAfterAd: true,
    blockTracking: true,
    bufferingFix: true,
    visibilitySpoofing: true,
    autoClaimPoints: true,
    showNotifications: true,
  },

  init() {
    Badge.init();
    SegmentSub.init();

    this._loadOptions();
    this._initTriggerBlocker();

    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));

    RemoteConfig.init();

    console.log('[TTV] Orchestrator initialized');
  },

  _loadOptions() {
    chrome.storage.local.get('ttvOptions', (result) => {
      if (result && result.ttvOptions) {
        Object.assign(this._options, result.ttvOptions);
        console.log('[TTV] Options loaded:', this._options);
      }
    });
  },

  _broadcastOptions() {
    // Send to all Twitch tabs so content scripts + page-inject get updated
    chrome.tabs.query({ url: '*://*.twitch.tv/*' }, (tabs) => {
      for (var i = 0; i < tabs.length; i++) {
        chrome.tabs.sendMessage(tabs[i].id, {
          type: 'OPTIONS_UPDATED',
          options: this._options
        });
      }
    });
  },

  _initTriggerBlocker() {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        if (!this._enabled || !this._options.blockTracking) return {};
        Badge.recordBlock('tracking');
        return { cancel: true };
      },
      {
        urls: TTV_CONFIG.tracking.blockedUrlPatterns.slice()
      },
      ['blocking']
    );
    console.log('[TTV] Trigger/tracking URL blocker active');
  },

  _onMessage(message, sender, sendResponse) {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'LAYER_FAILURE':
        recordFailure(message.channel);
        break;

      case 'GET_STATE': {
        const ch = findChannel(message.channel);
        sendResponse({
          state: ch ? ch.state : ChannelState.IDLE,
          adActive: ch ? ch.adActive : false,
        });
        return true;
      }

      case 'PURPLE_SCREEN_DETECTED':
        console.log(`[TTV] Purple screen detected on ${message.channel}`);
        recordFailure(message.channel);
        if (sender.tab) Badge.setLeaking(sender.tab.id);
        break;

      case 'AD_DETECTED': {
        const channelName = message.channel;
        const ch = getChannel(channelName);
        if (ch) {
          ch.adActive = true;
          ch.adsBlocked = (ch.adsBlocked || 0) + 1;
          // Only escalate when ads leak to the DOM (source !== 'worker').
          // Worker-sourced AD_DETECTED means the worker saw and handled ads —
          // that's success, not failure.
          if (message.source !== 'worker') {
            recordFailure(channelName);
          }
        }
        if (sender.tab) Badge.updateTab(sender.tab.id);
        break;
      }

      case 'AD_ENDED': {
        const channelName = message.channel;
        const ch = findChannel(channelName);
        if (ch) {
          ch.adActive = false;
          deescalate(channelName);
        }
        if (sender.tab) Badge.updateTab(sender.tab.id);
        break;
      }

      case 'GET_POPUP_STATE': {
        const tabId = message.tabId;
        const channelName = Badge.getTabChannel(tabId);
        const ch = channelName ? findChannel(channelName) : null;
        sendResponse({
          channel: channelName,
          state: ch ? ch.state : ChannelState.IDLE,
          adActive: ch ? ch.adActive : false,
          channelAdsBlocked: ch ? (ch.adsBlocked || 0) : 0,
          stats: Badge.getStats(),
          lifetime: Badge.getLifetimeStats(),
          enabled: this._enabled,
        });
        return true;
      }

      case 'SET_ENABLED':
        this._enabled = !!message.enabled;
        console.log(`[TTV] Ad blocking ${this._enabled ? 'enabled' : 'disabled'}`);
        // Notify all Twitch tabs so content scripts can disable too
        chrome.tabs.query({ url: '*://*.twitch.tv/*' }, (tabs) => {
          for (var i = 0; i < tabs.length; i++) {
            chrome.tabs.sendMessage(tabs[i].id, {
              type: 'SET_ENABLED',
              enabled: this._enabled
            });
          }
        });
        break;

      case 'OPTIONS_UPDATED':
        if (message.options) {
          Object.assign(this._options, message.options);
          console.log('[TTV] Options updated:', this._options);
          this._broadcastOptions();
        }
        break;
    }
  },
};
