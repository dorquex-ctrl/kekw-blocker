// Orchestrator — coordinates layers and handles message passing.

const Orchestrator = {
  _enabled: true,
  _runtimeStateKey: 'ttvRuntimeState',
  _playerTypeRankingKey: 'ttvPlayerTypeRanking',
  _playerTypeRankingTtlMs: 30 * 24 * 60 * 60 * 1000,
  _playerTypeRankingMaxChannels: 50,
  _options: {
    forcePlayerType: "popout",
    reloadAfterAd: true,
    blockTracking: true,
    bufferingFix: true,
    visibilitySpoofing: true,
    autoClaimPoints: true,
    showNotifications: true,
  },
  _runtimeState: {
    updatedAt: 0,
    updatedAtByKey: {},
    values: {}
  },
  _playerTypeRanking: {
    updatedAt: 0,
    global: {},
    channels: {}
  },
  _auxStateSaveInFlight: false,
  _auxStateSaveDirty: false,

  init() {
    this._loadPersistedState(() => {
      Badge.init();
      SegmentSub.init();
      this._initTriggerBlocker();

      chrome.runtime.onMessage.addListener(this._onMessage.bind(this));

      RemoteConfig.init();
      this._broadcastStartupState();

      console.log('[TTV] Orchestrator initialized');
    });
  },

  _loadPersistedState(callback) {
    chrome.storage.local.get(['ttvOptions', 'ttvEnabled', this._runtimeStateKey, this._playerTypeRankingKey], (result) => {
      if (result && result.ttvOptions) {
        Object.assign(this._options, result.ttvOptions);
        console.log('[TTV] Options loaded:', this._options);
      }
      if (result && typeof result.ttvEnabled === 'boolean') {
        this._enabled = result.ttvEnabled;
        console.log('[TTV] Enabled state loaded:', this._enabled);
      }
      this._runtimeState = this._normalizeRuntimeState(result && result[this._runtimeStateKey]);
      this._playerTypeRanking = this._normalizePlayerTypeRanking(result && result[this._playerTypeRankingKey]);
      if (typeof callback === 'function') {
        callback();
      }
    });
  },

  _normalizeRuntimeState(runtimeState) {
    var normalized = {
      updatedAt: 0,
      updatedAtByKey: {},
      values: {}
    };
    if (!runtimeState || typeof runtimeState !== 'object') return normalized;
    normalized.updatedAt = typeof runtimeState.updatedAt === 'number' ? runtimeState.updatedAt : 0;
    normalized.updatedAtByKey = Object.assign({}, runtimeState.updatedAtByKey || {});
    normalized.values = Object.assign({}, runtimeState.values || {});
    return normalized;
  },

  _getAllowedPlayerTypes() {
    var configured = TTV_CONFIG && TTV_CONFIG.player && TTV_CONFIG.player.backupPlayerTypes;
    return Array.isArray(configured) && configured.length ? configured : ['embed', 'site', 'popout', 'autoplay'];
  },

  _clampPlayerTypeScore(score) {
    return Math.max(-20, Math.min(40, Math.round(score)));
  },

  _sanitizePlayerTypeScores(scores) {
    var clean = {};
    var allowed = this._getAllowedPlayerTypes();
    if (!scores || typeof scores !== 'object') return clean;
    for (var i = 0; i < allowed.length; i++) {
      var playerType = allowed[i];
      if (typeof scores[playerType] !== 'number' || !isFinite(scores[playerType])) continue;
      var value = this._clampPlayerTypeScore(scores[playerType]);
      if (value !== 0) clean[playerType] = value;
    }
    return clean;
  },

  _isValidChannelName(value) {
    return typeof value === 'string' && /^[a-z0-9_]{1,50}$/i.test(value.trim());
  },

  _normalizePlayerTypeRanking(ranking) {
    var clean = { updatedAt: 0, global: {}, channels: {} };
    if (!ranking || typeof ranking !== 'object') return clean;

    clean.updatedAt = typeof ranking.updatedAt === 'number' ? ranking.updatedAt : 0;
    clean.global = this._sanitizePlayerTypeScores(ranking.global);

    var channels = ranking.channels || {};
    var now = Date.now();
    var kept = [];
    for (var name in channels) {
      if (!this._isValidChannelName(name)) continue;
      var entry = channels[name];
      if (!entry || typeof entry !== 'object') continue;
      var updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
      if (!updatedAt || now - updatedAt > this._playerTypeRankingTtlMs) continue;
      var scores = this._sanitizePlayerTypeScores(entry.scores);
      if (!Object.keys(scores).length) continue;
      kept.push({
        name: name.trim().toLowerCase(),
        updatedAt: updatedAt,
        scores: scores
      });
    }
    kept.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    for (var i = 0; i < kept.length && i < this._playerTypeRankingMaxChannels; i++) {
      clean.channels[kept[i].name] = {
        updatedAt: kept[i].updatedAt,
        scores: kept[i].scores
      };
    }
    return clean;
  },

  _applyPlayerTypeScoreDeltas(target, deltas) {
    var allowed = this._getAllowedPlayerTypes();
    for (var i = 0; i < allowed.length; i++) {
      var playerType = allowed[i];
      if (typeof deltas[playerType] !== 'number' || !isFinite(deltas[playerType])) continue;
      var nextValue = this._clampPlayerTypeScore((target[playerType] || 0) + deltas[playerType]);
      if (nextValue !== 0) target[playerType] = nextValue;
      else delete target[playerType];
    }
  },

  _flushAuxStateSave() {
    if (!this._auxStateSaveDirty || this._auxStateSaveInFlight) return;
    this._auxStateSaveDirty = false;
    this._auxStateSaveInFlight = true;
    var payload = {};
    payload[this._runtimeStateKey] = this._runtimeState;
    payload[this._playerTypeRankingKey] = this._playerTypeRanking;
    chrome.storage.local.set(payload, () => {
      this._auxStateSaveInFlight = false;
      if (this._auxStateSaveDirty) {
        this._flushAuxStateSave();
      }
    });
  },

  _scheduleAuxStateSave() {
    this._auxStateSaveDirty = true;
    this._flushAuxStateSave();
  },

  _persistRuntimeStatePatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    var now = Date.now();
    var hasChanges = false;
    for (var key in patch) {
      if (typeof patch[key] !== 'string') continue;
      if (this._runtimeState.values[key] !== patch[key]) {
        this._runtimeState.values[key] = patch[key];
        hasChanges = true;
      }
      this._runtimeState.updatedAtByKey[key] = now;
      hasChanges = true;
    }
    if (!hasChanges) return;
    this._runtimeState.updatedAt = now;
    this._scheduleAuxStateSave();
  },

  _persistPlayerTypeRankingPatch(patch) {
    if (!patch || typeof patch !== 'object' || !patch.deltas) return;
    var cleanDeltas = this._sanitizePlayerTypeScores(patch.deltas);
    if (!Object.keys(cleanDeltas).length) return;

    var now = Date.now();
    this._applyPlayerTypeScoreDeltas(this._playerTypeRanking.global, cleanDeltas);
    if (this._isValidChannelName(patch.channelName)) {
      var channelName = patch.channelName.trim().toLowerCase();
      var entry = this._playerTypeRanking.channels[channelName] || { updatedAt: 0, scores: {} };
      entry.updatedAt = now;
      this._applyPlayerTypeScoreDeltas(entry.scores, cleanDeltas);
      if (Object.keys(entry.scores).length) {
        this._playerTypeRanking.channels[channelName] = entry;
      } else {
        delete this._playerTypeRanking.channels[channelName];
      }
    }
    this._playerTypeRanking.updatedAt = now;
    this._playerTypeRanking = this._normalizePlayerTypeRanking(this._playerTypeRanking);
    this._scheduleAuxStateSave();
  },

  _broadcastOptions() {
    // Send to all Twitch tabs so content scripts + page-inject get updated
    chrome.tabs.query({ url: '*://*.twitch.tv/*' }, (tabs) => {
      for (let tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'OPTIONS_UPDATED',
          options: this._options
        }).catch(() => {
          // Silence "Could not establish connection" errors for tabs
          // that haven't finished loading the content script yet.
        });
      }
    });
  },

  _broadcastEnabled() {
    chrome.tabs.query({ url: '*://*.twitch.tv/*' }, (tabs) => {
      for (var i = 0; i < tabs.length; i++) {
        chrome.tabs.sendMessage(tabs[i].id, {
          type: 'SET_ENABLED',
          enabled: this._enabled
        }).catch(() => {
          // Tab not ready yet
        });
      }
    });
  },

  _broadcastStartupState() {
    this._broadcastEnabled();
    this._broadcastOptions();
  },

  _initTriggerBlocker() {
    const shouldBlock = this._enabled && this._options.blockTracking;
    
    // Toggle the DNR ruleset based on settings
    chrome.declarativeNetRequest.updateEnabledRulesets({
      [shouldBlock ? 'enableRulesetIds' : 'disableRulesetIds']: ['ruleset_1']
    });

    // Listen for rule matches to update the badge (replaces the old webRequest callback)
    if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
      chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
        if (info.rule.rulesetId === 'ruleset_1') {
          Badge.recordBlock('tracking');
        }
      });
    }
    console.log(`[TTV] DNR Tracking blocker ${shouldBlock ? 'active' : 'disabled'}`);
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
          if (!ch.adActive) {
            ch.adsBlocked = (ch.adsBlocked || 0) + 1;
          }
          ch.adActive = true;
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
        this._initTriggerBlocker();
        chrome.storage.local.set({ ttvEnabled: this._enabled });
        this._broadcastEnabled();
        break;

      case 'PERSIST_RUNTIME_STATE':
        this._persistRuntimeStatePatch(message.patch);
        break;

      case 'PERSIST_PLAYER_TYPE_RANKING':
        this._persistPlayerTypeRankingPatch(message.patch);
        break;

      case 'REMOTE_CONFIG_RUNTIME_CANDIDATE':
        if (message.candidate && message.candidate.type && typeof message.candidate.value === 'string') {
          RemoteConfig.recordRuntimeCandidate(message.candidate.type, message.candidate.value);
        }
        break;

      case 'REMOTE_CONFIG_FAILURE':
        if (message.failure && message.failure.type && typeof message.failure.value === 'string') {
          RemoteConfig.recordFailure(message.failure.type, message.failure.value, message.failure.reason || '');
        }
        break;

      case 'GET_REMOTE_CONFIG_DEBUG_STATE':
        sendResponse(RemoteConfig.getDebugState());
        return true;

      case 'RESET_RUNTIME_LEARNED_STATE': {
        this._runtimeState = this._normalizeRuntimeState();
        var runtimePayload = {};
        runtimePayload[this._runtimeStateKey] = this._runtimeState;
        chrome.storage.local.set(runtimePayload, () => {
          RemoteConfig.resetTemporaryRuntimeState(() => {
            sendResponse({ ok: true, debug: RemoteConfig.getDebugState() });
          });
        });
        return true;
      }

      case 'RESET_REMOTE_CONFIG_CACHE':
        RemoteConfig.resetSignedCache(() => {
          sendResponse({ ok: true, debug: RemoteConfig.getDebugState() });
        });
        return true;

      case 'OPTIONS_UPDATED':
        if (message.options) {
          Object.assign(this._options, message.options);
          console.log('[TTV] Options updated:', this._options);
          this._initTriggerBlocker();
          this._broadcastOptions();
        }
        break;
    }
  },
};
