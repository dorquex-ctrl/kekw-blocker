// Badge: green=clean, orange=blocking, red=leaking. Stats persisted to storage.

const Badge = {
  _tabChannels: new Map(),  // tabId -> channelName
  _stats: {
    totalAdsBlocked: 0,
    segmentsRedirected: 0,
    trackingBlocked: 0,
    timeSavedMs: 0,
  },
  _lifetime: {
    totalAdsBlocked: 0,
    segmentsRedirected: 0,
    trackingBlocked: 0,
    timeSavedMs: 0,
    sessionsCount: 0,
    firstInstalled: null,
  },
  _saveTimer: null,

  _setBadge(tabId, text, color) {
    try {
      var api = chrome.browserAction || chrome.action;
      if (!api) return;
      api.setBadgeText({ text: text, tabId: tabId });
      api.setBadgeBackgroundColor({ color: color, tabId: tabId });
    } catch (e) {}
  },

  setIdle(tabId) {
    this._setBadge(tabId, '', '#4CAF50');
  },

  setBlocking(tabId, count) {
    this._setBadge(tabId, String(count), '#FF9800');
  },

  setLeaking(tabId) {
    this._setBadge(tabId, '!', '#F44336');
  },

  recordBlock(type, channelName) {
    this._stats.totalAdsBlocked++;
    this._lifetime.totalAdsBlocked++;
    if (type === 'segment') {
      this._stats.segmentsRedirected++; this._lifetime.segmentsRedirected++;
      this._stats.timeSavedMs += 5000; this._lifetime.timeSavedMs += 5000; // ~5s per segment
    }
    else if (type === 'tracking') { this._stats.trackingBlocked++; this._lifetime.trackingBlocked++; }

    if (channelName) {
      const ch = findChannel(channelName);
      if (ch) {
        if (!ch.adsBlocked) ch.adsBlocked = 0;
        ch.adsBlocked++;
      }
    }

    this._updateAllTabs();
    this._debounceSave();
  },

  setTabChannel(tabId, channelName) {
    if (channelName) {
      this._tabChannels.set(tabId, channelName);
    } else {
      this._tabChannels.delete(tabId);
    }
    this.updateTab(tabId);
  },

  updateTab(tabId) {
    const channelName = this._tabChannels.get(tabId);
    if (!channelName) {
      this.setIdle(tabId);
      return;
    }
    const ch = findChannel(channelName);
    if (!ch) {
      this.setIdle(tabId);
      return;
    }
    if (ch.adActive) {
      this.setBlocking(tabId, ch.adsBlocked || 0);
    } else if (ch.adsBlocked > 0) {
      this._setBadge(tabId, String(ch.adsBlocked), '#4CAF50');
    } else {
      this.setIdle(tabId);
    }
  },

  _updateAllTabs() {
    for (const [tabId] of this._tabChannels) {
      this.updateTab(tabId);
    }
  },

  getStats() {
    return { ...this._stats };
  },

  getLifetimeStats() {
    return { ...this._lifetime };
  },

  getTabChannel(tabId) {
    return this._tabChannels.get(tabId) || null;
  },

  _debounceSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveLifetime();
    }, 5000);
  },

  _saveLifetime() {
    try {
      chrome.storage.local.set({ ttvLifetimeStats: this._lifetime });
    } catch (e) {}
  },

  _loadLifetime() {
    try {
      chrome.storage.local.get('ttvLifetimeStats', (result) => {
        if (result && result.ttvLifetimeStats) {
          Object.assign(this._lifetime, result.ttvLifetimeStats);
        }
        if (!this._lifetime.firstInstalled) {
          this._lifetime.firstInstalled = Date.now();
        }
        this._lifetime.sessionsCount++;
        this._saveLifetime();
        console.log('[TTV] Lifetime stats loaded: ' + this._lifetime.totalAdsBlocked + ' total ads blocked');
      });
    } catch (e) {}
  },

  init() {
    this._loadLifetime();

    chrome.tabs.onRemoved.addListener((tabId) => {
      this._tabChannels.delete(tabId);
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url || changeInfo.status === 'complete') {
        const url = changeInfo.url || (tab && tab.url);
        if (url && url.includes('twitch.tv/')) {
          const match = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
          const reserved = TTV_CONFIG.routing.reservedPaths;
          if (match && reserved.indexOf(match[1].toLowerCase()) === -1) {
            this.setTabChannel(tabId, match[1].toLowerCase());
          } else {
            this.setTabChannel(tabId, null);
          }
        } else if (url && this._tabChannels.has(tabId)) {
          this.setTabChannel(tabId, null);
        }
      }
    });

    console.log('[TTV] Badge system initialized (with persistent stats)');
  }
};
