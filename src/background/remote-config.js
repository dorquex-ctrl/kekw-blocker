// Remote config - signed schema v2 with runtime-learned temporary fallbacks.
// URL overridable via chrome.storage.local key 'ttvRemoteConfigUrl'.

const RemoteConfig = {
  _defaultUrl: TTV_CONFIG.remoteConfig && TTV_CONFIG.remoteConfig.defaultUrl || "https://dorquex-ctrl.github.io/kekw-blocker/remote-config.json",
  _url: "",
  _checkIntervalMs: TTV_CONFIG.remoteConfig && TTV_CONFIG.remoteConfig.pollIntervalMs || 60 * 60 * 1000,
  _acceleratedRetryMs: TTV_CONFIG.remoteConfig && TTV_CONFIG.remoteConfig.acceleratedRetryMs || [5 * 60 * 1000, 15 * 60 * 1000],
  _runtimeCandidateWindowMs: TTV_CONFIG.remoteConfig && TTV_CONFIG.remoteConfig.runtimeCandidateWindowMs || 6 * 60 * 60 * 1000,
  _runtimeCandidateThreshold: TTV_CONFIG.remoteConfig && TTV_CONFIG.remoteConfig.runtimeCandidateThreshold || 3,
  _temporaryFallbackTtlMs: TTV_CONFIG.remoteConfig && TTV_CONFIG.remoteConfig.temporaryFallbackTtlMs || 24 * 60 * 60 * 1000,
  _intervalId: null,
  _acceleratedRetryTimers: [],
  _lastVersion: 0,
  _effectiveCache: null,
  _legacyEffectiveCache: null,
  _lastKnownGoodSignedConfig: null,
  _runtimeCandidates: null,
  _temporaryRuntimeFallback: null,
  _debugState: null,
  _storageKeys: {
    url: "ttvRemoteConfigUrl",
    cache: "ttvRemoteConfigCache",
    version: "ttvRemoteConfigVersion",
    lastKnownGood: "ttvLastKnownGoodSignedConfig",
    runtimeCandidates: "ttvRuntimeCandidates",
    temporaryFallback: "ttvRuntimeTemporaryFallback",
    debug: "ttvRemoteConfigDebugState"
  },

  init() {
    var keys = [
      this._storageKeys.url,
      this._storageKeys.cache,
      this._storageKeys.version,
      this._storageKeys.lastKnownGood,
      this._storageKeys.runtimeCandidates,
      this._storageKeys.temporaryFallback,
      this._storageKeys.debug
    ];
    chrome.storage.local.get(keys, (result) => {
      this._url = this._sanitizeUrl(result && result[this._storageKeys.url] || this._defaultUrl);
      this._lastKnownGoodSignedConfig = this._normalizeSignedConfig(result && result[this._storageKeys.lastKnownGood]);
      this._runtimeCandidates = this._normalizeRuntimeCandidates(result && result[this._storageKeys.runtimeCandidates]);
      this._temporaryRuntimeFallback = this._normalizeTemporaryRuntimeFallback(result && result[this._storageKeys.temporaryFallback]);
      this._debugState = this._normalizeDebugState(result && result[this._storageKeys.debug]);
      this._lastVersion = this._getSignedVersion(this._lastKnownGoodSignedConfig) || (result && result[this._storageKeys.version] || 0);
      var cachedEffectiveCache = this._normalizeEffectiveCache(result && result[this._storageKeys.cache]);
      this._legacyEffectiveCache = cachedEffectiveCache && cachedEffectiveCache.source === "legacy-remote" ? cachedEffectiveCache : null;
      this._pruneVolatileState();

      if (this._lastKnownGoodSignedConfig) this._effectiveCache = this._buildEffectiveCacheFromSignedConfig("cached-signed-remote");
      else if (this._legacyEffectiveCache) this._effectiveCache = this._legacyEffectiveCache;
      else this._effectiveCache = this._buildBundledCache();

      this._persistDebugState();
      this._persistVolatileState();
      this._persistEffectiveCache(this._effectiveCache);
      this._broadcastUpdates(this._effectiveCache);

      if (!this._url) {
        console.log("[TTV] Remote config: No URL configured");
        return;
      }

      console.log("[TTV] Remote config: URL = " + this._url);
      setTimeout(() => this._check("startup"), 10000);
      this._intervalId = setInterval(() => this._check("scheduled"), this._checkIntervalMs);
    });
  },

  _sanitizeUrl(candidateUrl) {
    var trustedDomains = ["dorquex-ctrl.github.io", "raw.githubusercontent.com"];
    var url = candidateUrl || this._defaultUrl;
    if (!url || typeof url !== "string" || !url.startsWith("https://")) {
      console.warn("[TTV] Remote config: Rejecting non-HTTPS URL");
      url = this._defaultUrl;
    }
    try {
      var host = new URL(url).hostname;
      if (!trustedDomains.some(function (domain) { return host === domain || host.endsWith("." + domain); })) {
        console.warn("[TTV] Remote config: Rejecting untrusted URL domain: " + host);
        url = this._defaultUrl;
      }
    } catch (e) {
      url = this._defaultUrl;
    }
    return url;
  },

  _stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(this._stableStringify.bind(this)).join(",") + "]";
    var keys = Object.keys(value).sort();
    var pairs = [];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (typeof value[key] === "undefined") continue;
      pairs.push(JSON.stringify(key) + ":" + this._stableStringify(value[key]));
    }
    return "{" + pairs.join(",") + "}";
  },

  _stripSignature(config) {
    var unsigned = JSON.parse(JSON.stringify(config || {}));
    delete unsigned.signature;
    return unsigned;
  },

  _canonicalizeForSignature(config) {
    return this._stableStringify(this._stripSignature(config));
  },

  _isValidHash(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  },

  _isValidClientId(value) {
    return typeof value === "string" && /^[a-z0-9]{30,32}$/i.test(value);
  },

  _isValidQuery(value) {
    return typeof value === "string" &&
      value.length >= 64 &&
      value.length <= 16000 &&
      value.indexOf("PlaybackAccessToken") !== -1 &&
      value.indexOf("streamPlaybackAccessToken") !== -1;
  },

  _normalizeValueRecord(record, validator) {
    if (!record || typeof record !== "object" || !validator.call(this, record.value)) return null;
    return {
      value: record.value,
      validatedAt: typeof record.validatedAt === "string" ? record.validatedAt : new Date().toISOString(),
      source: typeof record.source === "string" ? record.source : "legacy",
      confidence: record.confidence === "medium" ? "medium" : "high"
    };
  },

  _normalizeEntry(entry, validator, maxFallbacks) {
    var active = this._normalizeValueRecord(entry && entry.active, validator);
    var fallbacks = [];
    var seen = Object.create(null);
    if (active) seen[active.value] = true;
    var rawFallbacks = entry && Array.isArray(entry.fallbacks) ? entry.fallbacks : [];
    for (var i = 0; i < rawFallbacks.length && fallbacks.length < maxFallbacks; i++) {
      var record = this._normalizeValueRecord(rawFallbacks[i], validator);
      if (!record || seen[record.value]) continue;
      seen[record.value] = true;
      fallbacks.push(record);
    }
    return {
      active: active,
      fallbacks: fallbacks
    };
  },

  _normalizeSignedConfig(config) {
    if (!config || config._schema !== 2) return null;
    var normalized = {
      _schema: 2,
      _version: typeof config._version === "number" && config._version > 0 ? config._version : 1,
      _generatedAt: typeof config._generatedAt === "string" ? config._generatedAt : new Date().toISOString(),
      gql: {
        clientId: this._normalizeEntry(config.gql && config.gql.clientId, this._isValidClientId, 1),
        playbackAccessToken: {
          hash: this._normalizeEntry(config.gql && config.gql.playbackAccessToken && config.gql.playbackAccessToken.hash, this._isValidHash, 2),
          query: {
            active: this._normalizeValueRecord(
              config.gql && config.gql.playbackAccessToken && config.gql.playbackAccessToken.query && config.gql.playbackAccessToken.query.active,
              this._isValidQuery
            )
          }
        }
      },
      signature: {
        alg: config.signature && config.signature.alg,
        keyId: config.signature && config.signature.keyId,
        value: config.signature && config.signature.value
      }
    };
    if (!normalized.gql.clientId.active || !normalized.gql.playbackAccessToken.hash.active || !normalized.gql.playbackAccessToken.query.active) return null;
    if (!normalized.signature.alg || !normalized.signature.keyId || !normalized.signature.value) return null;
    return normalized;
  },

  _normalizeEffectiveCache(cache) {
    if (!cache || typeof cache !== "object") return null;
    var normalized = Object.assign({}, cache);
    if (!this._isValidClientId(normalized.clientId) || !this._isValidHash(normalized.playbackAccessTokenHash)) return null;
    if (normalized.playbackAccessTokenQuery && !this._isValidQuery(normalized.playbackAccessTokenQuery)) normalized.playbackAccessTokenQuery = "";
    normalized.clientIdFallbacks = Array.isArray(normalized.clientIdFallbacks) ? normalized.clientIdFallbacks.filter(this._isValidClientId.bind(this)) : [];
    normalized.playbackAccessTokenHashFallbacks = Array.isArray(normalized.playbackAccessTokenHashFallbacks) ? normalized.playbackAccessTokenHashFallbacks.filter(this._isValidHash.bind(this)) : [];
    normalized.temporaryFallbacks = normalized.temporaryFallbacks && typeof normalized.temporaryFallbacks === "object" ? normalized.temporaryFallbacks : {};
    return normalized;
  },

  _normalizeRuntimeCandidates(runtimeCandidates) {
    var normalized = {
      clientId: [],
      playbackAccessTokenHash: [],
      playbackAccessTokenQuery: []
    };
    if (!runtimeCandidates || typeof runtimeCandidates !== "object") return normalized;
    normalized.clientId = this._normalizeRuntimeCandidateArray(runtimeCandidates.clientId, "clientId");
    normalized.playbackAccessTokenHash = this._normalizeRuntimeCandidateArray(runtimeCandidates.playbackAccessTokenHash, "playbackAccessTokenHash");
    normalized.playbackAccessTokenQuery = this._normalizeRuntimeCandidateArray(runtimeCandidates.playbackAccessTokenQuery, "playbackAccessTokenQuery");
    return normalized;
  },

  _normalizeRuntimeCandidateArray(entries, type) {
    var normalized = [];
    if (!Array.isArray(entries)) return normalized;
    var validator = this._getTypeValidator(type);
    var now = Date.now();
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || typeof entry !== "object" || !validator.call(this, entry.value)) continue;
      var timestamps = Array.isArray(entry.successTimestamps) ? entry.successTimestamps.filter(function (value) {
        return typeof value === "number" && isFinite(value);
      }) : [];
      timestamps = timestamps.filter((timestamp) => now - timestamp <= this._runtimeCandidateWindowMs);
      var normalizedEntry = {
        id: typeof entry.id === "string" ? entry.id : this._candidateId(type, entry.value),
        value: entry.value,
        source: "runtime",
        firstSeenAt: typeof entry.firstSeenAt === "number" ? entry.firstSeenAt : now,
        lastSeenAt: typeof entry.lastSeenAt === "number" ? entry.lastSeenAt : now,
        successTimestamps: timestamps,
        successCount: timestamps.length
      };
      if (now - normalizedEntry.lastSeenAt > this._temporaryFallbackTtlMs) continue;
      normalized.push(normalizedEntry);
    }
    normalized.sort(function (a, b) { return b.lastSeenAt - a.lastSeenAt; });
    return normalized.slice(0, 20);
  },

  _normalizeTemporaryRuntimeFallback(fallbacks) {
    var normalized = {};
    if (!fallbacks || typeof fallbacks !== "object") return normalized;
    var now = Date.now();
    var types = ["clientId", "playbackAccessTokenHash", "playbackAccessTokenQuery"];
    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var entry = fallbacks[type];
      if (!entry || typeof entry !== "object" || !(this._getTypeValidator(type)).call(this, entry.value)) continue;
      if (typeof entry.expiresAt !== "number" || entry.expiresAt <= now) continue;
      normalized[type] = {
        value: entry.value,
        source: "runtime",
        activatedAt: typeof entry.activatedAt === "number" ? entry.activatedAt : now,
        expiresAt: entry.expiresAt,
        successCount: typeof entry.successCount === "number" ? entry.successCount : 0
      };
    }
    return normalized;
  },

  _normalizeDebugState(debugState) {
    var normalized = {
      lastRemoteFetchAt: 0,
      lastRemoteFetchResult: { status: "idle", source: "", message: "", httpStatus: 0 },
      signature: { verified: false, keyId: "", alg: "", supported: true, message: "" },
      recentFailures: {},
      lastKnownGood: { version: 0, generatedAt: "" },
      lastAppliedSource: "",
      lastAppliedAt: 0
    };
    if (!debugState || typeof debugState !== "object") return normalized;
    if (typeof debugState.lastRemoteFetchAt === "number") normalized.lastRemoteFetchAt = debugState.lastRemoteFetchAt;
    if (debugState.lastRemoteFetchResult && typeof debugState.lastRemoteFetchResult === "object") {
      normalized.lastRemoteFetchResult.status = debugState.lastRemoteFetchResult.status || normalized.lastRemoteFetchResult.status;
      normalized.lastRemoteFetchResult.source = debugState.lastRemoteFetchResult.source || "";
      normalized.lastRemoteFetchResult.message = debugState.lastRemoteFetchResult.message || "";
      normalized.lastRemoteFetchResult.httpStatus = debugState.lastRemoteFetchResult.httpStatus || 0;
    }
    if (debugState.signature && typeof debugState.signature === "object") {
      normalized.signature.verified = !!debugState.signature.verified;
      normalized.signature.keyId = debugState.signature.keyId || "";
      normalized.signature.alg = debugState.signature.alg || "";
      normalized.signature.supported = debugState.signature.supported !== false;
      normalized.signature.message = debugState.signature.message || "";
    }
    if (typeof debugState.lastAppliedSource === "string") normalized.lastAppliedSource = debugState.lastAppliedSource;
    if (typeof debugState.lastAppliedAt === "number") normalized.lastAppliedAt = debugState.lastAppliedAt;
    if (debugState.lastKnownGood && typeof debugState.lastKnownGood === "object") {
      normalized.lastKnownGood.version = debugState.lastKnownGood.version || 0;
      normalized.lastKnownGood.generatedAt = debugState.lastKnownGood.generatedAt || "";
    }
    var types = ["clientId", "playbackAccessTokenHash", "playbackAccessTokenQuery"];
    for (var j = 0; j < types.length; j++) {
      var type = types[j];
      var failure = debugState.recentFailures && debugState.recentFailures[type];
      if (!failure || typeof failure.detectedAt !== "number") continue;
      if (Date.now() - failure.detectedAt > this._runtimeCandidateWindowMs) continue;
      normalized.recentFailures[type] = {
        failedValue: typeof failure.failedValue === "string" ? failure.failedValue : "",
        reason: typeof failure.reason === "string" ? failure.reason : "",
        detectedAt: failure.detectedAt
      };
    }
    return normalized;
  },

  _getSignedVersion(config) {
    return config && typeof config._version === "number" ? config._version : 0;
  },

  _persistEffectiveCache(cache, callback) {
    var payload = {};
    payload[this._storageKeys.cache] = cache;
    payload[this._storageKeys.version] = cache && cache.remoteConfigVersion || this._lastVersion || 0;
    chrome.storage.local.set(payload, callback || function () {});
  },

  _persistSignedConfig(callback) {
    var payload = {};
    payload[this._storageKeys.lastKnownGood] = this._lastKnownGoodSignedConfig;
    chrome.storage.local.set(payload, callback || function () {});
  },

  _persistVolatileState(callback) {
    var payload = {};
    payload[this._storageKeys.runtimeCandidates] = this._runtimeCandidates;
    payload[this._storageKeys.temporaryFallback] = this._temporaryRuntimeFallback;
    chrome.storage.local.set(payload, callback || function () {});
  },

  _persistDebugState(callback) {
    var payload = {};
    payload[this._storageKeys.debug] = this._debugState;
    chrome.storage.local.set(payload, callback || function () {});
  },

  _broadcastUpdates(config) {
    chrome.tabs.query({ url: "*://*.twitch.tv/*" }, (tabs) => {
      for (var i = 0; i < tabs.length; i++) {
        chrome.tabs.sendMessage(tabs[i].id, {
          type: "REMOTE_CONFIG_UPDATED",
          config: config
        }).catch(() => {
          // Silence "Could not establish connection" errors for tabs not yet ready
        });
      }
    });
  },

  _buildBundledCache() {
    return {
      schema: 0,
      remoteConfigVersion: 0,
      source: "bundled",
      signatureVerified: false,
      signatureKeyId: "",
      signatureAlg: "",
      lastKnownGoodAt: "",
      lastRemoteFetchAt: this._debugState && this._debugState.lastRemoteFetchAt || 0,
      lastRemoteFetchResult: this._debugState && this._debugState.lastRemoteFetchResult || {},
      clientId: TTV_CONFIG.gql.clientId,
      clientIdFallbacks: [],
      playbackAccessTokenHash: TTV_CONFIG.gql.playbackAccessTokenHash,
      playbackAccessTokenHashFallbacks: [],
      playbackAccessTokenQuery: "",
      activeClientIdSource: "bundled",
      activeHashSource: "bundled",
      activeQuerySource: "bundled",
      temporaryFallbacks: {}
    };
  },

  _buildEffectiveCacheFromSignedConfig(sourceLabel) {
    var config = this._lastKnownGoodSignedConfig;
    if (!config) return this._buildBundledCache();

    var clientId = config.gql.clientId.active.value;
    var clientIdFallbacks = [];
    var hash = config.gql.playbackAccessToken.hash.active.value;
    var hashFallbacks = [];
    var query = config.gql.playbackAccessToken.query.active.value;
    var activeClientIdSource = config.gql.clientId.active.source;
    var activeHashSource = config.gql.playbackAccessToken.hash.active.source;
    var activeQuerySource = config.gql.playbackAccessToken.query.active.source;
    var temporaryFallbacks = {};

    var tempClientId = this._temporaryRuntimeFallback.clientId;
    if (tempClientId && tempClientId.value !== clientId) {
      clientIdFallbacks.push(clientId);
      temporaryFallbacks.clientId = tempClientId;
      clientId = tempClientId.value;
      activeClientIdSource = "runtime-temporary";
    }
    for (var i = 0; i < config.gql.clientId.fallbacks.length; i++) {
      var fallbackClientId = config.gql.clientId.fallbacks[i].value;
      if (fallbackClientId !== clientId && clientIdFallbacks.indexOf(fallbackClientId) === -1) clientIdFallbacks.push(fallbackClientId);
    }

    var tempHash = this._temporaryRuntimeFallback.playbackAccessTokenHash;
    if (tempHash && tempHash.value !== hash) {
      hashFallbacks.push(hash);
      temporaryFallbacks.playbackAccessTokenHash = tempHash;
      hash = tempHash.value;
      activeHashSource = "runtime-temporary";
    }
    for (var j = 0; j < config.gql.playbackAccessToken.hash.fallbacks.length; j++) {
      var fallbackHash = config.gql.playbackAccessToken.hash.fallbacks[j].value;
      if (fallbackHash !== hash && hashFallbacks.indexOf(fallbackHash) === -1) hashFallbacks.push(fallbackHash);
    }

    var tempQuery = this._temporaryRuntimeFallback.playbackAccessTokenQuery;
    if (tempQuery && tempQuery.value !== query) {
      temporaryFallbacks.playbackAccessTokenQuery = tempQuery;
      query = tempQuery.value;
      activeQuerySource = "runtime-temporary";
    }

    return {
      schema: 2,
      remoteConfigVersion: config._version,
      source: Object.keys(temporaryFallbacks).length ? "signed-remote+runtime-fallback" : (sourceLabel || "signed-remote"),
      signatureVerified: true,
      signatureKeyId: config.signature.keyId,
      signatureAlg: config.signature.alg,
      lastKnownGoodAt: config._generatedAt,
      lastRemoteFetchAt: this._debugState.lastRemoteFetchAt,
      lastRemoteFetchResult: this._debugState.lastRemoteFetchResult,
      clientId: clientId,
      clientIdFallbacks: clientIdFallbacks,
      playbackAccessTokenHash: hash,
      playbackAccessTokenHashFallbacks: hashFallbacks,
      playbackAccessTokenQuery: query,
      activeClientIdSource: activeClientIdSource,
      activeHashSource: activeHashSource,
      activeQuerySource: activeQuerySource,
      temporaryFallbacks: temporaryFallbacks
    };
  },

  _buildLegacyCache(config) {
    var cache = this._buildBundledCache();
    cache.schema = 1;
    cache.remoteConfigVersion = typeof config._version === "number" ? config._version : 0;
    cache.source = "legacy-remote";
    cache.clientId = config.clientId;
    cache.playbackAccessTokenHash = config.playbackAccessTokenHash;
    cache.activeClientIdSource = "legacy-remote";
    cache.activeHashSource = "legacy-remote";
    return cache;
  },

  _applyEffectiveCache(cache, callback) {
    this._effectiveCache = cache;
    this._debugState.lastAppliedSource = cache && cache.source || "";
    this._debugState.lastAppliedAt = Date.now();
    if (this._lastKnownGoodSignedConfig) {
      this._debugState.lastKnownGood.version = this._lastKnownGoodSignedConfig._version;
      this._debugState.lastKnownGood.generatedAt = this._lastKnownGoodSignedConfig._generatedAt;
    } else {
      this._debugState.lastKnownGood.version = 0;
      this._debugState.lastKnownGood.generatedAt = "";
    }
    this._persistDebugState();
    this._persistEffectiveCache(cache, () => {
      this._broadcastUpdates(cache);
      if (typeof callback === "function") callback();
    });
  },

  _recordFetchResult(status, message, httpStatus, source) {
    this._debugState.lastRemoteFetchAt = Date.now();
    this._debugState.lastRemoteFetchResult = {
      status: status,
      source: source || "",
      message: message || "",
      httpStatus: httpStatus || 0
    };
    this._persistDebugState();
  },

  _getTypeValidator(type) {
    if (type === "clientId") return this._isValidClientId;
    if (type === "playbackAccessTokenHash") return this._isValidHash;
    if (type === "playbackAccessTokenQuery") return this._isValidQuery;
    return null;
  },

  _candidateId(type, value) {
    if (type !== "playbackAccessTokenQuery") return value;
    var hash = 0;
    for (var i = 0; i < value.length; i++) {
      hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return "query:" + Math.abs(hash);
  },

  _pruneVolatileState() {
    var now = Date.now();
    this._runtimeCandidates = this._normalizeRuntimeCandidates(this._runtimeCandidates);
    this._temporaryRuntimeFallback = this._normalizeTemporaryRuntimeFallback(this._temporaryRuntimeFallback);
    this._debugState = this._normalizeDebugState(this._debugState);
    var types = ["clientId", "playbackAccessTokenHash", "playbackAccessTokenQuery"];
    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var failure = this._debugState.recentFailures[type];
      if (failure && now - failure.detectedAt > this._runtimeCandidateWindowMs) {
        delete this._debugState.recentFailures[type];
      }
    }
  },

  _base64ToBytes(base64) {
    try {
      var binary = atob(base64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (e) {
      return null;
    }
  },

  _pemToArrayBuffer(pem) {
    var cleaned = String(pem || "")
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "");
    return this._base64ToBytes(cleaned);
  },

  async _importVerifyKey(pem) {
    var keyBytes = this._pemToArrayBuffer(pem);
    if (!keyBytes || !crypto || !crypto.subtle) return null;
    try {
      return await crypto.subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    } catch (firstError) {
      try {
        return await crypto.subtle.importKey("spki", keyBytes, "Ed25519", false, ["verify"]);
      } catch (secondError) {
        return null;
      }
    }
  },

  async _verifySignedConfig(config) {
    var signing = TTV_CONFIG.remoteConfig && TTV_CONFIG.remoteConfig.signing || {};
    var signature = config && config.signature || {};
    var keyId = signature.keyId || signing.keyId || "";
    var alg = signature.alg || "";
    var pem = signing.publicKeys && signing.publicKeys[keyId];
    if (!pem) return { ok: false, keyId: keyId, alg: alg, supported: true, message: "Unknown signing key" };
    if (!crypto || !crypto.subtle) return { ok: false, keyId: keyId, alg: alg, supported: false, message: "WebCrypto unavailable" };
    var key = await this._importVerifyKey(pem);
    if (!key) return { ok: false, keyId: keyId, alg: alg, supported: false, message: "Ed25519 verification unavailable" };
    var signatureBytes = this._base64ToBytes(signature.value || "");
    if (!signatureBytes) return { ok: false, keyId: keyId, alg: alg, supported: true, message: "Invalid signature encoding" };
    var data = new TextEncoder().encode(this._canonicalizeForSignature(config));
    try {
      var verified = await crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, data);
      return { ok: verified, keyId: keyId, alg: alg, supported: true, message: verified ? "" : "Signature mismatch" };
    } catch (firstError) {
      try {
        var fallbackVerified = await crypto.subtle.verify("Ed25519", key, signatureBytes, data);
        return { ok: fallbackVerified, keyId: keyId, alg: alg, supported: true, message: fallbackVerified ? "" : "Signature mismatch" };
      } catch (secondError) {
        return { ok: false, keyId: keyId, alg: alg, supported: false, message: secondError.message || firstError.message || "Verification failed" };
      }
    }
  },

  async _check(reason) {
    if (!this._url) return;
    try {
      var response = await fetch(this._url, {
        cache: "no-cache",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        this._recordFetchResult("http-error", "HTTP " + response.status, response.status, reason);
        return;
      }

      var config = await response.json();
      if (config && config._schema === 2) {
        var normalized = this._normalizeSignedConfig(config);
        if (!normalized) {
          this._debugState.signature = { verified: false, keyId: config.signature && config.signature.keyId || "", alg: config.signature && config.signature.alg || "", supported: true, message: "Invalid schema v2 payload" };
          this._recordFetchResult("invalid-payload", "Invalid schema v2 payload", response.status, reason);
          this._persistDebugState();
          return;
        }

        var verification = await this._verifySignedConfig(config);
        this._debugState.signature = {
          verified: !!verification.ok,
          keyId: verification.keyId || "",
          alg: verification.alg || "",
          supported: verification.supported !== false,
          message: verification.message || ""
        };
        if (!verification.ok) {
          this._recordFetchResult("signature-rejected", verification.message || "Signature rejected", response.status, reason);
          this._persistDebugState();
          return;
        }

        this._recordFetchResult("signed-remote", "Signed config accepted", response.status, reason);
        var currentUnsigned = this._lastKnownGoodSignedConfig ? this._canonicalizeForSignature(this._lastKnownGoodSignedConfig) : "";
        var nextUnsigned = this._canonicalizeForSignature(normalized);
        if (nextUnsigned !== currentUnsigned) {
          this._lastKnownGoodSignedConfig = normalized;
          this._lastVersion = normalized._version;
          this._temporaryRuntimeFallback = {};
          this._legacyEffectiveCache = null;
          this._persistSignedConfig();
          this._persistVolatileState();
        }
        this._applyEffectiveCache(this._buildEffectiveCacheFromSignedConfig("signed-remote"));
        return;
      }

      if (config && this._isValidHash(config.playbackAccessTokenHash) && this._isValidClientId(config.clientId) && !this._lastKnownGoodSignedConfig) {
        var legacyCache = this._buildLegacyCache(config);
        this._legacyEffectiveCache = legacyCache;
        this._recordFetchResult("legacy-remote", "Accepted legacy config", response.status, reason);
        this._applyEffectiveCache(legacyCache);
        return;
      }

      this._recordFetchResult("invalid-payload", "Unsupported remote config payload", response.status, reason);
    } catch (e) {
      this._recordFetchResult("fetch-error", e.message, 0, reason);
    }
  },

  _scheduleAcceleratedRefetch() {
    while (this._acceleratedRetryTimers.length) clearTimeout(this._acceleratedRetryTimers.pop());
    for (var i = 0; i < this._acceleratedRetryMs.length; i++) {
      this._acceleratedRetryTimers.push(setTimeout(() => this._check("accelerated-retry"), this._acceleratedRetryMs[i]));
    }
  },

  _getSignedActiveValue(type) {
    if (!this._lastKnownGoodSignedConfig) return "";
    if (type === "clientId") return this._lastKnownGoodSignedConfig.gql.clientId.active.value;
    if (type === "playbackAccessTokenHash") return this._lastKnownGoodSignedConfig.gql.playbackAccessToken.hash.active.value;
    return this._lastKnownGoodSignedConfig.gql.playbackAccessToken.query.active.value;
  },

  _activateTemporaryFallback(type, candidate) {
    var now = Date.now();
    this._temporaryRuntimeFallback[type] = {
      value: candidate.value,
      source: "runtime",
      activatedAt: now,
      expiresAt: now + this._temporaryFallbackTtlMs,
      successCount: candidate.successCount || 0
    };
    this._persistVolatileState();
    this._applyEffectiveCache(this._buildEffectiveCacheFromSignedConfig("signed-remote+runtime-fallback"));
    this._scheduleAcceleratedRefetch();
  },

  _evaluateTemporaryFallback(type) {
    if (!this._lastKnownGoodSignedConfig) return;
    this._pruneVolatileState();

    var failure = this._debugState.recentFailures[type];
    if (!failure || Date.now() - failure.detectedAt > this._runtimeCandidateWindowMs) return;

    var remoteActiveValue = this._getSignedActiveValue(type);
    if (!remoteActiveValue || failure.failedValue !== remoteActiveValue) return;

    var candidates = this._runtimeCandidates[type] || [];
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate || candidate.value === remoteActiveValue || candidate.successCount < this._runtimeCandidateThreshold) continue;
      if (!best || candidate.successCount > best.successCount || candidate.lastSeenAt > best.lastSeenAt) best = candidate;
    }
    if (!best) return;

    var existing = this._temporaryRuntimeFallback[type];
    if (existing && existing.value === best.value && existing.expiresAt > Date.now()) return;
    this._activateTemporaryFallback(type, best);
  },

  recordRuntimeCandidate(type, value) {
    var validator = this._getTypeValidator(type);
    if (!validator || !validator.call(this, value)) return;

    this._pruneVolatileState();
    var candidates = this._runtimeCandidates[type] || [];
    var candidateId = this._candidateId(type, value);
    var now = Date.now();
    var entry = null;

    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].id === candidateId) {
        entry = candidates[i];
        break;
      }
    }
    if (!entry) {
      entry = { id: candidateId, value: value, source: "runtime", firstSeenAt: now, lastSeenAt: now, successTimestamps: [], successCount: 0 };
      candidates.push(entry);
    }

    entry.lastSeenAt = now;
    entry.successTimestamps.push(now);
    entry.successTimestamps = entry.successTimestamps.filter((timestamp) => now - timestamp <= this._runtimeCandidateWindowMs);
    entry.successCount = entry.successTimestamps.length;
    candidates.sort(function (a, b) { return b.lastSeenAt - a.lastSeenAt; });
    this._runtimeCandidates[type] = candidates.slice(0, 20);
    this._persistVolatileState();
    this._evaluateTemporaryFallback(type);
  },

  recordFailure(type, failedValue, reason) {
    if (!this._getTypeValidator(type) || typeof failedValue !== "string") return;
    this._pruneVolatileState();
    this._debugState.recentFailures[type] = {
      failedValue: failedValue,
      reason: typeof reason === "string" ? reason : "",
      detectedAt: Date.now()
    };
    this._persistDebugState();
    this._evaluateTemporaryFallback(type);
  },

  getDebugState() {
    this._pruneVolatileState();
    var effective = this._effectiveCache || this._buildBundledCache();
    return {
      effectiveConfig: effective,
      signature: this._debugState.signature,
      lastRemoteFetch: this._debugState.lastRemoteFetchResult,
      lastRemoteFetchAt: this._debugState.lastRemoteFetchAt,
      lastKnownGood: this._debugState.lastKnownGood,
      recentFailures: this._debugState.recentFailures,
      runtimeCandidates: this._runtimeCandidates,
      temporaryRuntimeFallback: this._temporaryRuntimeFallback,
      raw: {
        effectiveConfig: effective,
        lastKnownGoodSignedConfig: this._lastKnownGoodSignedConfig,
        runtimeCandidates: this._runtimeCandidates,
        temporaryRuntimeFallback: this._temporaryRuntimeFallback,
        debugState: this._debugState
      }
    };
  },

  resetTemporaryRuntimeState(callback) {
    this._runtimeCandidates = this._normalizeRuntimeCandidates();
    this._temporaryRuntimeFallback = {};
    this._debugState.recentFailures = {};
    this._persistVolatileState();
    this._persistDebugState();
    if (this._lastKnownGoodSignedConfig) this._applyEffectiveCache(this._buildEffectiveCacheFromSignedConfig("cached-signed-remote"), callback);
    else if (this._legacyEffectiveCache) this._applyEffectiveCache(this._legacyEffectiveCache, callback);
    else this._applyEffectiveCache(this._buildBundledCache(), callback);
  },

  resetSignedCache(callback) {
    this._lastKnownGoodSignedConfig = null;
    this._lastVersion = 0;
    this._temporaryRuntimeFallback = {};
    this._debugState.signature = { verified: false, keyId: "", alg: "", supported: true, message: "" };
    chrome.storage.local.remove([this._storageKeys.lastKnownGood, this._storageKeys.version], () => {
      this._persistVolatileState();
      this._persistDebugState();
      this._applyEffectiveCache(this._legacyEffectiveCache || this._buildBundledCache(), () => {
        this._check("reset-signed-cache");
        if (typeof callback === "function") callback();
      });
    });
  }
};
