// KEKW Blocker — VAFT-based Worker hook with backup player switching,
// pre-warmed streams, buffering auto-fix, and visibility spoofing.
(function () {
  "use strict";
  if (!/(^|\.)twitch\.tv$/.test(document.location.hostname)) return;

  var _cfg = window.__TTV_CONFIG || {};
  var _nonce = window.__TTV_NONCE || "";
  var _startup = window.__TTV_STARTUP || {};
  try { delete window.__TTV_CONFIG; } catch (e) {}
  try { delete window.__TTV_NONCE; } catch (e) {}
  try { delete window.__TTV_STARTUP; } catch (e) {}
  var _cfgGql = _cfg.gql || {};
  var _cfgHls = _cfg.hls || {};
  var _cfgPlayer = _cfg.player || {};
  var _cfgReact = _cfg.react || {};
  var _startupOptions = _startup.options || {};
  var _startupRemoteConfig = _startup.remoteConfig || {};
  var _startupRuntime = _startup.runtime || {};
  var _startupPlayerTypeRanking = _startup.playerTypeRanking || { global: {}, channels: {} };
  var _adBlockingEnabled = _startup.enabled !== false;

  // Main-thread ad state — used to restore quality after backup stream ads
  var _isBlockingAds = false;
  var _preAdQuality = null;
  var _lsCachedValues = null;
  var _showNotifications = true;
  var _realVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ||
    Object.getOwnPropertyDescriptor(document, "visibilityState");
  var _realHidden = document.__lookupGetter__ ? document.__lookupGetter__("hidden") : null;
  var RECOVERY_STORAGE_KEYS = ["video-quality", "video-muted", "volume", "lowLatencyModeEnabled", "persistenceEnabled"];
  var RECOVERY_ACTIONS = ["seek", "pause", "reload"];
  var RECOVERY_ACTION_INDEX = { seek: 0, pause: 1, reload: 2 };
  var RECOVERY_ACTION_COOLDOWNS = { seek: 10000, pause: 15000, reload: 30000 };
  var RECOVERY_LADDER_RESET_MS = 45000;
  var _recoveryStateByChannel = Object.create(null);

  function persistRuntimeUpdates(updates) {
    if (!updates || !Object.keys(updates).length) return;
    window.dispatchEvent(new CustomEvent("ttv-" + _nonce + "-runtime", { detail: updates }));
  }

  function persistPlayerTypeRankingUpdate(channelName, deltas) {
    if (!channelName || !deltas) return;
    var hasChanges = false;
    for (var key in deltas) {
      if (deltas[key]) {
        hasChanges = true;
        break;
      }
    }
    if (!hasChanges) return;
    window.dispatchEvent(new CustomEvent("ttv-" + _nonce + "-player-rank", {
      detail: {
        channelName: channelName,
        deltas: deltas
      }
    }));
  }

  function persistRemoteConfigCandidate(type, value) {
    if (!type || typeof value !== "string" || !value) return;
    window.dispatchEvent(new CustomEvent("ttv-" + _nonce + "-runtime-candidate", {
      detail: {
        type: type,
        value: value
      }
    }));
  }

  function reportRemoteConfigFailure(type, value, reason) {
    if (!type || typeof value !== "string" || !value) return;
    window.dispatchEvent(new CustomEvent("ttv-" + _nonce + "-remote-config-failure", {
      detail: {
        type: type,
        value: value,
        reason: reason || ""
      }
    }));
  }

  function getCurrentPageChannelName() {
    var parts = window.location.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!parts[0]) return null;
    if (parts[0].toLowerCase() === "popout" && parts[1]) {
      return parts[1].toLowerCase();
    }
    return parts[0].toLowerCase();
  }

  function getStartupPlayerTypeScores(channelName) {
    var ranking = typeof StartupPlayerTypeRanking !== "undefined"
      ? (StartupPlayerTypeRanking || { global: {}, channels: {} })
      : (_startupPlayerTypeRanking || { global: {}, channels: {} });
    var channels = ranking.channels || {};
    var normalizedChannelName = channelName ? channelName.toLowerCase() : "";
    var channelEntry = normalizedChannelName && channels[normalizedChannelName] ? channels[normalizedChannelName] : null;
    return {
      global: ranking.global || {},
      channel: channelEntry && channelEntry.scores || {}
    };
  }

  function getPlayerTypePriorityScore(channelName, playerType, sessionScores) {
    var startupScores = getStartupPlayerTypeScores(channelName);
    var sessionScore = sessionScores && typeof sessionScores[playerType] === "number" ? sessionScores[playerType] : 0;
    var channelScore = typeof startupScores.channel[playerType] === "number" ? startupScores.channel[playerType] : 0;
    var globalScore = typeof startupScores.global[playerType] === "number" ? startupScores.global[playerType] : 0;
    return (sessionScore * 100) + (channelScore * 10) + globalScore;
  }

  function applyPlayerTypeScoreDeltas(scoreMap, deltas) {
    if (!scoreMap || !deltas) return;
    for (var playerType in deltas) {
      if (typeof deltas[playerType] !== "number" || !isFinite(deltas[playerType])) continue;
      var nextValue = (scoreMap[playerType] || 0) + deltas[playerType];
      if (nextValue) scoreMap[playerType] = nextValue;
      else delete scoreMap[playerType];
    }
  }

  function buildRankedPlayerTypeOrder(channelName, sessionScores, preferredPlayerType) {
    var order = BackupPlayerTypes.slice();
    var baseOrder = {};
    for (var i = 0; i < order.length; i++) {
      baseOrder[order[i]] = i;
    }
    order.sort(function (a, b) {
      var diff = getPlayerTypePriorityScore(channelName, b, sessionScores) - getPlayerTypePriorityScore(channelName, a, sessionScores);
      if (diff) return diff;
      return baseOrder[a] - baseOrder[b];
    });
    if (preferredPlayerType) {
      var preferredIdx = order.indexOf(preferredPlayerType);
      if (preferredIdx > 0) {
        order.splice(preferredIdx, 1);
        order.unshift(preferredPlayerType);
      }
    }
    return order;
  }

  function getPreferredPlayerType(channelName) {
    var order = buildRankedPlayerTypeOrder(channelName, null, null);
    return order.length ? order[0] : null;
  }

  // --- Options (shared between main thread and worker via toString injection)

  // declareOptions is stringified into the Worker blob, so it CANNOT reference
  // closure variables like _cfg*. It uses bare defaults. The actual config values
  // are injected into the worker blob via string interpolation (see hookWindowWorker).
  function declareOptions(scope) {
    scope.AdSignifier = "stitched";
    scope.ClientID = "b31o4btkqth5bzbvr9ub2ovr79umhh";
    scope.ClientIDFallbacks = [];
    scope.BackupPlayerTypes = ["embed", "site", "popout", "autoplay"];
    scope.FallbackPlayerType = "embed";
    scope.ForceAccessTokenPlayerType = "popout";
    scope.PlaybackAccessTokenHash = "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
    scope.PlaybackAccessTokenFallbackHashes = [];
    scope.GqlUrl = "https://gql.twitch.tv/gql";
    scope.ReloadPlayerAfterAd = true;
    scope.PlayerReloadMinimalRequestsTime = 500;
    scope.PlayerReloadMinimalRequestsPlayerIndex = 3;
    scope.HasTriggeredPlayerReload = false;
    scope.StreamInfos = Object.create(null);
    scope.StreamInfosByUrl = Object.create(null);
    scope.GQLDeviceID = null;
    scope.ClientIntegrityHeader = null;
    scope.AuthorizationHeader = undefined;
    scope.ClientVersion = null;
    scope.ClientSession = null;
    scope.V2API = false;
    scope.IsAdStrippingEnabled = true;
    scope.AdSegmentCache = new Map();
    scope.AllSegmentsAreAdSegments = false;
    scope.HashFailedOnce = false;
    scope.StartupPlayerTypeRanking = { global: {}, channels: {} };
    scope.RemotePlaybackAccessTokenQuery = "";
    scope.PlaybackAccessTokenQuery = 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';
  }

  var twitchWorkers = [];

  // --- Worker hook — class-based approach matching VAFT

  function getWasmWorkerJs(twitchBlobUrl) {
    var req = new XMLHttpRequest();
    req.open("GET", twitchBlobUrl, false);
    req.overrideMimeType("text/javascript");
    req.send();
    return req.responseText;
  }

  function hookWindowWorker() {
    var OrigWorker = window.Worker;
    var newWorker = class Worker extends OrigWorker {
      constructor(twitchBlobUrl, options) {
        var isTwitchWorker = false;
        try {
          isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith(".twitch.tv");
        } catch (e) {}
        if (!isTwitchWorker) {
          super(twitchBlobUrl, options);
          return;
        }
        console.log("[TTV] Intercepting Worker: " + String(twitchBlobUrl).substring(0, 80));
        var workerSource = getWasmWorkerJs(twitchBlobUrl);
        var newBlobStr = "\
          var pendingFetchRequests = new Map();\
          " + getStartupPlayerTypeScores.toString() + "\
          " + getPlayerTypePriorityScore.toString() + "\
          " + applyPlayerTypeScoreDeltas.toString() + "\
          " + buildRankedPlayerTypeOrder.toString() + "\
          " + getPreferredPlayerType.toString() + "\
          " + stripAdSegments.toString() + "\
          " + getStreamUrlForResolution.toString() + "\
          " + processM3U8.toString() + "\
          " + hookWorkerFetch.toString() + "\
          " + declareOptions.toString() + "\
          " + getAccessToken.toString() + "\
          " + gqlRequest.toString() + "\
          var sendGqlFetch = " + workerSendGqlFetch.toString() + ";\
          var reportRemoteConfigFailure = " + workerReportRemoteConfigFailure.toString() + ";\
          " + parseAttributes.toString() + "\
          " + getServerTimeFromM3u8.toString() + "\
          " + replaceServerTimeInM3u8.toString() + "\
          declareOptions(self);\
          AdSignifier = " + JSON.stringify(AdSignifier) + ";\
          ClientID = " + JSON.stringify(ClientID) + ";\
          ClientIDFallbacks = " + JSON.stringify(typeof ClientIDFallbacks !== "undefined" ? ClientIDFallbacks : []) + ";\
          BackupPlayerTypes = " + JSON.stringify(BackupPlayerTypes) + ";\
          FallbackPlayerType = " + JSON.stringify(FallbackPlayerType) + ";\
          ForceAccessTokenPlayerType = " + JSON.stringify(ForceAccessTokenPlayerType) + ";\
          PlaybackAccessTokenHash = " + JSON.stringify(PlaybackAccessTokenHash) + ";\
          PlaybackAccessTokenFallbackHashes = " + JSON.stringify(typeof PlaybackAccessTokenFallbackHashes !== "undefined" ? PlaybackAccessTokenFallbackHashes : []) + ";\
          RemotePlaybackAccessTokenQuery = " + JSON.stringify(typeof RemotePlaybackAccessTokenQuery !== "undefined" ? RemotePlaybackAccessTokenQuery : "") + ";\
          GqlUrl = " + JSON.stringify(GqlUrl) + ";\
          IsAdStrippingEnabled = " + JSON.stringify(_adBlockingEnabled) + ";\
          StartupPlayerTypeRanking = " + JSON.stringify(_startupPlayerTypeRanking || { global: {}, channels: {} }) + ";\
          GQLDeviceID = " + JSON.stringify(GQLDeviceID || null) + ";\
          AuthorizationHeader = " + JSON.stringify(AuthorizationHeader || null) + ";\
          ClientIntegrityHeader = " + JSON.stringify(ClientIntegrityHeader || null) + ";\
          ClientVersion = " + JSON.stringify(ClientVersion || null) + ";\
          ClientSession = " + JSON.stringify(ClientSession || null) + ";\
          self.addEventListener('message', function(e) {\
            if (e.data.key == 'UpdateClientVersion') ClientVersion = e.data.value;\
            else if (e.data.key == 'UpdateClientSession') ClientSession = e.data.value;\
            else if (e.data.key == 'UpdateClientId') ClientID = e.data.value;\
            else if (e.data.key == 'UpdateClientIdFallbacks') ClientIDFallbacks = Array.isArray(e.data.value) ? e.data.value.slice() : [];\
            else if (e.data.key == 'UpdateDeviceId') GQLDeviceID = e.data.value;\
            else if (e.data.key == 'UpdateClientIntegrityHeader') ClientIntegrityHeader = e.data.value;\
            else if (e.data.key == 'UpdateAuthorizationHeader') AuthorizationHeader = e.data.value;\
            else if (e.data.key == 'UpdatePlaybackAccessTokenHash') { PlaybackAccessTokenHash = e.data.value; HashFailedOnce = false; }\
            else if (e.data.key == 'UpdatePlaybackAccessTokenFallbackHashes') PlaybackAccessTokenFallbackHashes = Array.isArray(e.data.value) ? e.data.value.slice() : [];\
            else if (e.data.key == 'UpdateRemotePlaybackAccessTokenQuery') RemotePlaybackAccessTokenQuery = typeof e.data.value === 'string' ? e.data.value : '';\
            else if (e.data.key == 'FetchResponse') {\
              var responseData = e.data.value;\
              if (pendingFetchRequests.has(responseData.id)) {\
                var p = pendingFetchRequests.get(responseData.id);\
                pendingFetchRequests.delete(responseData.id);\
                if (responseData.error) p.reject(new Error(responseData.error));\
                else p.resolve(new Response(responseData.body, { status: responseData.status, statusText: responseData.statusText, headers: responseData.headers }));\
              }\
            } else if (e.data.key == 'TriggeredPlayerReload') {\
              HasTriggeredPlayerReload = true;\
            } else if (e.data.key == 'SetAdStrippingEnabled') {\
              IsAdStrippingEnabled = !!e.data.value;\
              console.log('[TTV Worker] Ad stripping ' + (IsAdStrippingEnabled ? 'enabled' : 'disabled'));\
            } else if (e.data.key == 'UpdateForceAccessTokenPlayerType') {\
              ForceAccessTokenPlayerType = e.data.value || '';\
            } else if (e.data.key == 'PreWarmCache') {\
              var si = StreamInfos[e.data.channelName];\
              if (si) {\
                si.BackupEncodingsM3U8Cache[e.data.playerType] = e.data.encodingsM3u8;\
              }\
            }\
          });\
          hookWorkerFetch();\
        " + workerSource;
        var blobUrl = URL.createObjectURL(new Blob([newBlobStr]));
        super(blobUrl, options);
        this._blobUrl = blobUrl;
        twitchWorkers.push(this);
        var workerRef = this;
        this.addEventListener("error", function () {
          var idx = twitchWorkers.indexOf(workerRef);
          if (idx !== -1) twitchWorkers.splice(idx, 1);
          URL.revokeObjectURL(blobUrl);
        });
        this.addEventListener("message", function (e) {
          if (e.data.key == "PauseResumePlayer" || e.data.key == "ReloadPlayer") {
            // Only act if the channel matches the current page (prevents wrong-channel reloads)
            if (e.data.channelName) {
              var currentChannelName = getCurrentPageChannelName();
              if (currentChannelName && currentChannelName !== e.data.channelName.toLowerCase()) return;
            }
            requestStreamRecovery({
              channelName: e.data.channelName,
              minimumAction: e.data.key == "PauseResumePlayer" ? "pause" : "reload",
              reason: e.data.key == "PauseResumePlayer" ? "worker-pause-resume" : "worker-reload"
            });
          }
          else if (e.data.key == "SeekToLive") {
            requestStreamRecovery({
              channelName: e.data.channelName,
              minimumAction: "seek",
              reason: "worker-seek-to-live",
              messages: {
                seek: "Syncing stream...",
                pause: "Syncing stream..."
              },
              notes: {
                seek: "Holding the last good frame while the player catches up.",
                pause: "Recovering playback with a quick player resync."
              }
            });
          }
          else if (e.data.key == "StreamInitialized") {
            _isBlockingAds = false;
            _preAdQuality = null;
            preWarmBackupStreams(e.data.channelName, e.data.usherParams, e.data.v2api, workerRef);
          }
          else if (e.data.key == "UpdateAdBlockBanner") {
            handlePreWarmStatusUpdate(e.data);
            if (e.data.hasAds && !_isBlockingAds) {
              // Save pre-ad quality so backup stream transcode tiers don't persist
              if (_lsCachedValues) _preAdQuality = _lsCachedValues.get("video-quality");
            }
            if (e.data.hasAds) {
              showTtvNotification("KEKW Blocker: Ads blocked");
            } else if (!e.data.hasAds && _isBlockingAds) {
              // Restore pre-ad quality if the tier still exists on this stream
              if (_preAdQuality && _lsCachedValues) {
                var shouldRestore = true;
                try {
                  var ps = getPlayerAndState();
                  if (ps && ps.player && ps.player.core && ps.player.core.state &&
                      ps.player.core.state.quality && ps.player.core.state.quality.group) {
                    var savedObj = JSON.parse(_preAdQuality);
                    var savedTier = savedObj && savedObj.default;
                    var currentTier = ps.player.core.state.quality.group;
                    if (savedTier && currentTier && savedTier !== currentTier) {
                      console.log("[TTV] Skipping quality restore: saved=" + savedTier +
                        " current=" + currentTier + " (tier may not be available)");
                      shouldRestore = false;
                    }
                  }
                } catch (_qErr) {}
                if (shouldRestore) {
                  _lsCachedValues.set("video-quality", _preAdQuality);
                }
              }
              _preAdQuality = null;
            }
            _isBlockingAds = !!e.data.hasAds;
            window.dispatchEvent(new CustomEvent("ttv-" + _nonce + "-adblock-status", {
              detail: {
                hasAds: e.data.hasAds,
                isMidroll: e.data.isMidroll,
                isStrippingAdSegments: e.data.isStrippingAdSegments,
                numStrippedAdSegments: e.data.numStrippedAdSegments
              }
            }));
          }
          else if (e.data.key == "RemoteConfigFailure") {
            reportRemoteConfigFailure(e.data.failureType, e.data.failedValue, e.data.reason || "");
          }
        });
        this.addEventListener("message", async function (event) {
          if (event.data.key == "FetchRequest") {
            var fetchRequest = event.data.value;
            var responseData = await handleWorkerFetchRequest(fetchRequest);
            this.postMessage({ key: "FetchResponse", value: responseData });
          }
        }.bind(this));
      }
      terminate() {
        var idx = twitchWorkers.indexOf(this);
        if (idx !== -1) twitchWorkers.splice(idx, 1);
        if (this._blobUrl) URL.revokeObjectURL(this._blobUrl);
        super.terminate();
      }
    };
    var hookedWorker = newWorker;
    Object.defineProperty(window, "Worker", {
      get: function () { return newWorker; },
      // Accepting any value would let a reassignment silently drop the hook.
      // A subclass keeps it, since its constructor still runs ours.
      set: function (value) {
        if (typeof value === "function" && (value === hookedWorker || value.prototype instanceof hookedWorker)) {
          newWorker = value;
        } else {
          console.warn("[TTV] Ignored an attempt to replace window.Worker");
        }
      }
    });
  }

  // --- Functions injected into the worker (stringified)

  function hookWorkerFetch() {
    console.log("[TTV Worker] hookWorkerFetch (v3)");
    var realFetch = fetch;
    fetch = async function (url, options) {
      if (typeof url === "string") {
        if (AdSegmentCache.has(url)) {
          return realFetch("data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA", options);
        }
        url = url.trimEnd();
        if (url.endsWith("m3u8")) {
          // Chain the promises: an error thrown while rewriting the playlist must
          // not leave the player's request pending forever.
          return realFetch(url, options).then(async function (response) {
            if (response.status !== 200) return response;
            var text = await response.text();
            try {
              return new Response(await processM3U8(url, text, realFetch));
            } catch (error) {
              console.warn("[TTV Worker] Failed to process a media playlist: " + (error && error.message));
              return new Response(text);
            }
          });
        } else if (url.includes("/channel/hls/") && !url.includes("picture-by-picture")) {
          V2API = url.includes("/api/v2/");
          var channelNameMatch = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/);
          if (!channelNameMatch) return realFetch(url, options);
          var channelName = channelNameMatch[0];
          if (ForceAccessTokenPlayerType) {
            var tempUrl = new URL(url);
            tempUrl.searchParams.delete("parent_domains");
            url = tempUrl.toString();
          }
          return realFetch(url, options).then(async function (response) {
            if (response.status != 200) return response;
            var encodingsM3u8 = await response.text();
            try {
              var serverTime = getServerTimeFromM3u8(encodingsM3u8);
              var streamInfo = StreamInfos[channelName];
              if (streamInfo != null && streamInfo.EncodingsM3U8 != null) {
                var cachedMediaUrl = streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m);
                if (!cachedMediaUrl || (await realFetch(cachedMediaUrl[0])).status !== 200) streamInfo = null;
              }
              // Reset HEVC state on re-entry to prevent stale codec swapping
              if (streamInfo != null && !streamInfo.IsShowingAd) {
                streamInfo.IsUsingModifiedM3U8 = false;
              }
              if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                // Clean up stale entries from other channels to prevent memory leaks
                for (var oldKey in StreamInfos) {
                  if (oldKey !== channelName) {
                    var oldInfo = StreamInfos[oldKey];
                    if (oldInfo && oldInfo.Urls) {
                      for (var oldUrl in oldInfo.Urls) { delete StreamInfosByUrl[oldUrl]; }
                    }
                    delete StreamInfos[oldKey];
                  }
                }
                StreamInfos[channelName] = streamInfo = {
                  ChannelName: channelName,
                  IsShowingAd: false,
                  LastPlayerReload: 0,
                  EncodingsM3U8: encodingsM3u8,
                  ModifiedM3U8: null,
                  IsUsingModifiedM3U8: false,
                  UsherParams: (new URL(url)).search,
                  RequestedAds: new Set(),
                  Urls: Object.create(null),
                  ResolutionList: [],
                  BackupEncodingsM3U8Cache: Object.create(null),
                  ActiveBackupPlayerType: null,
                  PreferredPlayerType: getPreferredPlayerType(channelName),
                  LastSuccessfulPlayerType: null,
                  LastRankedBackupPlayerType: null,
                  PlayerTypeSessionScores: Object.create(null),
                  IsMidroll: false,
                  IsStrippingAdSegments: false,
                  NumStrippedAdSegments: 0
                };
                var lines = encodingsM3u8.replaceAll("\r", "").split("\n");
                for (var i = 0; i < lines.length - 1; i++) {
                  if (lines[i].startsWith("#EXT-X-STREAM-INF") && lines[i + 1].includes(".m3u8")) {
                    var attributes = parseAttributes(lines[i]);
                    var resolution = attributes["RESOLUTION"];
                    if (resolution) {
                      var resolutionInfo = {
                        Resolution: resolution,
                        FrameRate: attributes["FRAME-RATE"],
                        Codecs: attributes["CODECS"],
                        Url: lines[i + 1]
                      };
                      streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                      streamInfo.ResolutionList.push(resolutionInfo);
                      StreamInfosByUrl[lines[i + 1]] = streamInfo;
                    }
                  }
                }
                // HEVC handling: swap HEVC variants to AVC for player reload compatibility
                var nonHevcList = streamInfo.ResolutionList.filter(function (el) {
                  return el.Codecs.startsWith("avc") || el.Codecs.startsWith("av0");
                });
                var hasHevc = streamInfo.ResolutionList.some(function (el) {
                  return el.Codecs.startsWith("hev") || el.Codecs.startsWith("hvc");
                });
                if (nonHevcList.length > 0 && hasHevc) {
                  for (var i = 0; i < lines.length - 1; i++) {
                    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                      var resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(":") + 1));
                      var codecsKey = "CODECS";
                      if (resSettings[codecsKey] && (resSettings[codecsKey].startsWith("hev") || resSettings[codecsKey].startsWith("hvc"))) {
                        var oldRes = resSettings["RESOLUTION"];
                        var parts = oldRes.split("x").map(Number);
                        var targetW = parts[0], targetH = parts[1];
                        var best = nonHevcList.sort(function (a, b) {
                          var pa = a.Resolution.split("x").map(Number);
                          var pb = b.Resolution.split("x").map(Number);
                          return Math.abs((pa[0] * pa[1]) - (targetW * targetH)) - Math.abs((pb[0] * pb[1]) - (targetW * targetH));
                        })[0];
                        console.log("[TTV Worker] HEVC swap: " + resSettings[codecsKey] + " -> " + best.Codecs + " " + oldRes + " -> " + best.Resolution);
                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, 'CODECS="' + best.Codecs + '"');
                        lines[i + 1] = best.Url + " ".repeat(i + 1);
                      }
                    }
                  }
                  streamInfo.ModifiedM3U8 = lines.join("\n");
                }
              }
              // Notify main thread to pre-warm backup streams
              postMessage({ key: "StreamInitialized", channelName: channelName, usherParams: streamInfo.UsherParams, v2api: V2API });
              streamInfo.LastPlayerReload = Date.now();
              return new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime));
            } catch (error) {
              console.warn("[TTV Worker] Failed to process the master playlist: " + (error && error.message));
              return new Response(encodingsM3u8);
            }
          });
        }
      }
      return realFetch.apply(this, arguments);
    };
  }

  function getServerTimeFromM3u8(encodingsM3u8) {
    if (V2API) {
      var matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
      return matches && matches.length > 1 ? matches[1] : null;
    }
    var matches = encodingsM3u8.match('SERVER-TIME="([0-9.]+)"');
    return matches && matches.length > 1 ? matches[1] : null;
  }

  function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
    if (V2API) {
      return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, "$1" + newServerTime + "$2") : encodingsM3u8;
    }
    return newServerTime ? encodingsM3u8.replace(new RegExp('(SERVER-TIME=")[0-9.]+"'), 'SERVER-TIME="' + newServerTime + '"') : encodingsM3u8;
  }

  function stripAdSegments(textStr, stripAllSegments, streamInfo) {
    var hasStrippedAdSegments = false;
    var lines = textStr.replaceAll("\r", "").split("\n");
    var newAdUrl = "https://twitch.tv";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      line = line
        .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, "$1" + newAdUrl + "$2")
        .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, "$1" + newAdUrl + "$2");
      if (i < lines.length - 1 && line.startsWith("#EXTINF") && (!line.includes(",live") || stripAllSegments || AllSegmentsAreAdSegments)) {
        var segmentUrl = lines[i + 1];
        if (!AdSegmentCache.has(segmentUrl)) {
          streamInfo.NumStrippedAdSegments++;
        }
        AdSegmentCache.set(segmentUrl, Date.now());
        hasStrippedAdSegments = true;
      }
      if (line.includes(AdSignifier)) {
        hasStrippedAdSegments = true;
      }
    }
    if (hasStrippedAdSegments) {
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("#EXT-X-TWITCH-PREFETCH:")) {
          lines[i] = "";
        }
      }
    } else {
      streamInfo.NumStrippedAdSegments = 0;
    }
    streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
    AdSegmentCache.forEach(function (value, key, map) {
      if (value < Date.now() - 120000) map.delete(key);
    });
    return lines.join("\n");
  }

  function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
    var encodingsLines = encodingsM3u8.replaceAll("\r", "").split("\n");
    var parts = resolutionInfo.Resolution.split("x").map(Number);
    var targetWidth = parts[0], targetHeight = parts[1];
    var targetIsHevc = resolutionInfo.Codecs && (resolutionInfo.Codecs.startsWith("hev") || resolutionInfo.Codecs.startsWith("hvc"));
    var matchedResolutionUrl = null;
    var matchedFrameRate = false;
    var matchedCodec = false;
    var closestResolutionUrl = null;
    var closestResolutionDifference = Infinity;
    for (var i = 0; i < encodingsLines.length - 1; i++) {
      if (encodingsLines[i].startsWith("#EXT-X-STREAM-INF") && encodingsLines[i + 1].includes(".m3u8")) {
        var attributes = parseAttributes(encodingsLines[i]);
        var resolution = attributes["RESOLUTION"];
        var frameRate = attributes["FRAME-RATE"];
        var codecs = attributes["CODECS"] || "";
        var isHevc = codecs.startsWith("hev") || codecs.startsWith("hvc");
        var codecMatch = (targetIsHevc === isHevc);
        if (resolution) {
          if (resolution == resolutionInfo.Resolution) {
            // Prefer same codec family, then same frame rate
            var isBetter = !matchedResolutionUrl ||
              (!matchedCodec && codecMatch) ||
              (codecMatch === matchedCodec && !matchedFrameRate && frameRate == resolutionInfo.FrameRate);
            if (isBetter) {
              matchedResolutionUrl = encodingsLines[i + 1];
              matchedFrameRate = frameRate == resolutionInfo.FrameRate;
              matchedCodec = codecMatch;
              if (matchedFrameRate && matchedCodec) return matchedResolutionUrl;
            }
          }
          // For closest-resolution fallback, prefer matching codec family
          var rp = resolution.split("x").map(Number);
          var difference = Math.abs((rp[0] * rp[1]) - (targetWidth * targetHeight));
          if (codecMatch && difference < closestResolutionDifference) {
            closestResolutionUrl = encodingsLines[i + 1];
            closestResolutionDifference = difference;
          } else if (!closestResolutionUrl && difference < closestResolutionDifference) {
            closestResolutionUrl = encodingsLines[i + 1];
            closestResolutionDifference = difference;
          }
        }
      }
    }
    return matchedResolutionUrl || closestResolutionUrl;
  }

  async function processM3U8(url, textStr, realFetch) {
    var streamInfo = StreamInfosByUrl[url];
    if (!streamInfo) return textStr;

    if (HasTriggeredPlayerReload) {
      HasTriggeredPlayerReload = false;
      streamInfo.LastPlayerReload = Date.now();
    }

    var currentResolution = streamInfo.Urls[url] || null;
    if (currentResolution) {
      streamInfo.CurrentResolution = {
        Resolution: currentResolution.Resolution,
        FrameRate: currentResolution.FrameRate,
        Codecs: currentResolution.Codecs
      };
    }

    var haveAdTags = textStr.includes(AdSignifier);
    if (haveAdTags) {
      streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
      var isNewAdSession = !streamInfo.IsShowingAd;
      if (!streamInfo.IsShowingAd) {
        streamInfo.IsShowingAd = true;
        postMessage({
          key: "UpdateAdBlockBanner",
          channelName: streamInfo.ChannelName,
          isMidroll: streamInfo.IsMidroll,
          hasAds: true,
          isStrippingAdSegments: false,
          activeBackupPlayerType: streamInfo.ActiveBackupPlayerType,
          lastSuccessfulPlayerType: streamInfo.LastSuccessfulPlayerType
        });
      }

      // Fetch one ad segment to satisfy server-side accounting
      if (!streamInfo.IsMidroll) {
        var adLines = textStr.replaceAll("\r", "").split("\n");
        for (var i = 0; i < adLines.length; i++) {
          if (adLines[i].startsWith("#EXTINF") && adLines.length > i + 1) {
            if (!adLines[i].includes(",live") && !streamInfo.RequestedAds.has(adLines[i + 1])) {
              streamInfo.RequestedAds.add(adLines[i + 1]);
              fetch(adLines[i + 1]).then(function (r) { r.blob(); });
              break;
            }
          }
        }
      }

      var currentResolution = streamInfo.Urls[url];
      if (!currentResolution) {
        console.log("[TTV Worker] Ads will leak — missing resolution info for " + url);
        return textStr;
      }

      var isHevc = currentResolution.Codecs.startsWith("hev") || currentResolution.Codecs.startsWith("hvc");
      if (isHevc && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
        streamInfo.IsUsingModifiedM3U8 = true;
        streamInfo.LastPlayerReload = Date.now();
        postMessage({ key: "ReloadPlayer" });
      }

      // Try backup player types for ad-free stream
      // Build the try order: last-successful type first, then the rest
      var backupPlayerType = null;
      var backupM3u8 = null;
      var fallbackM3u8 = null;
      var tryOrder = buildRankedPlayerTypeOrder(
        streamInfo.ChannelName,
        streamInfo.PlayerTypeSessionScores,
        streamInfo.LastSuccessfulPlayerType || streamInfo.PreferredPlayerType
      );
      var startIndex = 0;
      var isDoingMinimalRequests = false;
      if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
        startIndex = PlayerReloadMinimalRequestsPlayerIndex;
        isDoingMinimalRequests = true;
      }

      // Fetch all backup player types in parallel for minimum latency
      var candidates = tryOrder.slice(startIndex);
      var fetchPromises = candidates.map(function (playerType) {
        var realPlayerType = playerType.replace("-CACHED", "");
        var encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
        var fetcher;
        if (encodingsM3u8) {
          fetcher = Promise.resolve(encodingsM3u8);
        } else {
          fetcher = getAccessToken(streamInfo.ChannelName, realPlayerType).then(function (resp) {
            if (resp.status !== 200) return null;
            return resp.json().then(function (token) {
              var urlInfo = new URL("https://usher.ttvnw.net/api/" + (V2API ? "v2/" : "") + "channel/hls/" + streamInfo.ChannelName + ".m3u8" + streamInfo.UsherParams);
              urlInfo.searchParams.set("sig", token.data.streamPlaybackAccessToken.signature);
              urlInfo.searchParams.set("token", token.data.streamPlaybackAccessToken.value);
              return realFetch(urlInfo.href).then(function (r) { return r.status === 200 ? r.text() : null; });
            });
          })["catch"](function () { return null; });
        }
        return fetcher.then(function (enc) {
          streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
          if (!enc) return null;
          var m3u8Url = getStreamUrlForResolution(enc, currentResolution);
          if (!m3u8Url) return null;
          return realFetch(m3u8Url).then(function (r) {
            return r.status === 200 ? r.text() : null;
          }).then(function (m3u8Text) {
            if (!m3u8Text) return null;
            return { playerType: playerType, m3u8: m3u8Text, hasAds: m3u8Text.includes(AdSignifier) };
          });
        })["catch"](function () { return null; });
      });
      var results = await Promise.allSettled(fetchPromises);
      var playerTypeScoreDeltas = Object.create(null);
      // Pick first ad-free result in priority order; fall back to fallback type
      for (var ri = 0; ri < results.length; ri++) {
        var r = results[ri].value;
        if (!r) continue;
        if (r.playerType === FallbackPlayerType) fallbackM3u8 = r.m3u8;
        if (!r.hasAds) { backupPlayerType = r.playerType; backupM3u8 = r.m3u8; break; }
      }
      if (!backupM3u8 && !fallbackM3u8) {
        // Last resort: accept the last result even with ads
        for (var ri2 = results.length - 1; ri2 >= 0; ri2--) {
          var r2 = results[ri2].value;
          if (r2) { fallbackM3u8 = r2.m3u8; break; }
        }
      }

      if (!backupM3u8 && fallbackM3u8) {
        backupPlayerType = FallbackPlayerType;
        backupM3u8 = fallbackM3u8;
      }

      var shouldUpdatePlayerTypeScores = isNewAdSession ||
        (!!backupPlayerType && streamInfo.LastRankedBackupPlayerType !== backupPlayerType);
      if (shouldUpdatePlayerTypeScores) {
        for (var sri = 0; sri < candidates.length; sri++) {
          var attemptedPlayerType = candidates[sri];
          var attemptedResult = results[sri] && results[sri].value;
          var delta = 0;
          if (!attemptedResult) delta = -2;
          else if (!attemptedResult.hasAds) delta = attemptedResult.playerType === backupPlayerType ? 4 : 1;
          else delta = -1;
          if (!delta) continue;
          playerTypeScoreDeltas[attemptedPlayerType] = (playerTypeScoreDeltas[attemptedPlayerType] || 0) + delta;
        }
        applyPlayerTypeScoreDeltas(streamInfo.PlayerTypeSessionScores, playerTypeScoreDeltas);
        streamInfo.LastRankedBackupPlayerType = backupPlayerType || streamInfo.LastRankedBackupPlayerType;
      }

      if (backupM3u8) {
        textStr = backupM3u8;
        if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
          streamInfo.ActiveBackupPlayerType = backupPlayerType;
          streamInfo.LastSuccessfulPlayerType = backupPlayerType;
          streamInfo.PreferredPlayerType = backupPlayerType;
          console.log("[TTV Worker] Blocking" + (streamInfo.IsMidroll ? " midroll " : " ") + "ads (" + backupPlayerType + ")");
        }
      }

      var stripHevc = isHevc && streamInfo.ModifiedM3U8;
      if (IsAdStrippingEnabled || stripHevc) {
        textStr = stripAdSegments(textStr, stripHevc, streamInfo);
      }
    } else if (streamInfo.IsShowingAd) {
      console.log("[TTV Worker] Finished blocking ads");
      streamInfo.IsShowingAd = false;
      streamInfo.IsStrippingAdSegments = false;
      streamInfo.NumStrippedAdSegments = 0;
      streamInfo.ActiveBackupPlayerType = null;
      streamInfo.LastRankedBackupPlayerType = null;
      streamInfo.RequestedAds.clear();
      if (streamInfo.IsUsingModifiedM3U8) {
        // HEVC swap requires full reload
        streamInfo.IsUsingModifiedM3U8 = false;
        streamInfo.LastPlayerReload = Date.now();
        postMessage({ key: "ReloadPlayer", channelName: streamInfo.ChannelName });
      } else if (ReloadPlayerAfterAd) {
        // Seek to live edge for clean transition (avoids black screen)
        postMessage({ key: "SeekToLive", channelName: streamInfo.ChannelName });
      } else {
        postMessage({ key: "PauseResumePlayer", channelName: streamInfo.ChannelName });
      }
    }

    postMessage({
      key: "UpdateAdBlockBanner",
      channelName: streamInfo.ChannelName,
      isMidroll: streamInfo.IsMidroll,
      hasAds: streamInfo.IsShowingAd,
      isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
      numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
      activeBackupPlayerType: streamInfo.ActiveBackupPlayerType,
      lastSuccessfulPlayerType: streamInfo.LastSuccessfulPlayerType,
      currentResolution: streamInfo.CurrentResolution || null,
      playerTypeScoreDeltas: Object.keys(playerTypeScoreDeltas || {}).length ? playerTypeScoreDeltas : null
    });
    return textStr;
  }

  function parseAttributes(str) {
    var result = {};
    var parts = str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      var idx = part.indexOf("=");
      if (idx === -1) continue;
      var key = part.substring(0, idx);
      var value = part.substring(idx + 1);
      var num = Number(value);
      result[key] = Number.isNaN(num) ? (value.startsWith('"') ? JSON.parse(value) : value) : num;
    }
    return result;
  }

  // getAccessToken is toString'd into the Worker blob and also runs on the main
  // thread for pre-warm, so every variable it references must be a global in
  // both contexts. PlaybackAccessTokenQuery and HashFailedOnce are declared in
  // declareOptions() for this reason.
  function getAccessToken(channelName, playerType) {
    var variables = {
      isLive: true, login: channelName, isVod: false, vodID: "",
      playerType: playerType,
      platform: playerType == "autoplay" ? "android" : "web"
    };

    function buildHashCandidates() {
      var hashes = [];
      function addHash(value) {
        if (!value || hashes.indexOf(value) !== -1) return;
        hashes.push(value);
      }
      if (!HashFailedOnce) addHash(PlaybackAccessTokenHash);
      var fallbackHashes = Array.isArray(PlaybackAccessTokenFallbackHashes) ? PlaybackAccessTokenFallbackHashes : [];
      for (var i = 0; i < fallbackHashes.length; i++) addHash(fallbackHashes[i]);
      return hashes;
    }

    function reconstructResponse(response, text) {
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    function parseErrors(text) {
      try {
        var data = JSON.parse(text);
        var items = Array.isArray(data) ? data : [data];
        var errors = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i] && Array.isArray(items[i].errors)) errors = errors.concat(items[i].errors);
        }
        return errors;
      } catch (e) {
        return [];
      }
    }

    function hasPersistedQueryNotFound(errors) {
      return errors.some(function (error) {
        return error && typeof error.message === "string" && error.message.indexOf("PersistedQueryNotFound") !== -1;
      });
    }

    function hasGraphqlFailure(errors) {
      return errors.length > 0;
    }

    function requestWithQuery(queryText, isRemoteQuery) {
      return gqlRequest({
        operationName: "PlaybackAccessToken",
        query: queryText,
        variables: variables
      }, playerType).then(function (response) {
        if (!response) return response;
        return response.text().then(function (text) {
          var errors = parseErrors(text);
          if (isRemoteQuery && (response.status >= 400 || hasGraphqlFailure(errors))) {
            reportRemoteConfigFailure(
              "playbackAccessTokenQuery",
              queryText,
              response.status >= 400 ? "remote-query-http-" + response.status : "remote-query-rejected"
            );
            return requestWithQuery(PlaybackAccessTokenQuery, false);
          }
          return reconstructResponse(response, text);
        });
      });
    }

    function requestWithHashes(hashCandidates, index) {
      if (index >= hashCandidates.length) {
        if (RemotePlaybackAccessTokenQuery && RemotePlaybackAccessTokenQuery !== PlaybackAccessTokenQuery) {
          return requestWithQuery(RemotePlaybackAccessTokenQuery, true);
        }
        return requestWithQuery(PlaybackAccessTokenQuery, false);
      }

      var hash = hashCandidates[index];
      return gqlRequest({
        operationName: "PlaybackAccessToken",
        variables: variables,
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: hash
          }
        }
      }, playerType).then(function (response) {
        if (!response || response.status !== 200) return response;
        return response.text().then(function (text) {
          var errors = parseErrors(text);
          if (hasPersistedQueryNotFound(errors)) {
            if (hash === PlaybackAccessTokenHash) {
              HashFailedOnce = true;
              reportRemoteConfigFailure("playbackAccessTokenHash", hash, "PersistedQueryNotFound");
            }
            return requestWithHashes(hashCandidates, index + 1);
          }
          return reconstructResponse(response, text);
        });
      });
    }

    return requestWithHashes(buildHashCandidates(), 0);
  }

  function gqlRequest(body, playerType) {
    if (!GQLDeviceID) {
      GQLDeviceID = "";
      var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      for (var i = 0; i < 32; i++) GQLDeviceID += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    function getClientIdCandidates() {
      var clientIds = [];
      function addClientId(value) {
        if (!value || clientIds.indexOf(value) !== -1) return;
        clientIds.push(value);
      }
      addClientId(ClientID);
      var fallbackIds = Array.isArray(ClientIDFallbacks) ? ClientIDFallbacks : [];
      for (var i = 0; i < fallbackIds.length; i++) addClientId(fallbackIds[i]);
      return clientIds;
    }

    function sendRequestWithClientId(clientId) {
      var headers = {
        "Client-ID": clientId,
        "X-Device-Id": GQLDeviceID
      };
      // Only when Twitch sent one: otherwise the header would read "null" or "undefined".
      if (AuthorizationHeader) headers["Authorization"] = AuthorizationHeader;
      if (ClientIntegrityHeader) headers["Client-Integrity"] = ClientIntegrityHeader;
      if (ClientVersion) headers["Client-Version"] = ClientVersion;
      if (ClientSession) headers["Client-Session-Id"] = ClientSession;

      return sendGqlFetch(GqlUrl, { method: "POST", body: JSON.stringify(body), headers: headers });
    }

    function parseClientIdRejection(response, text) {
      if (!response) return false;
      if (response.status === 400 || response.status === 401 || response.status === 403) return true;
      try {
        var data = JSON.parse(text);
        var items = Array.isArray(data) ? data : [data];
        for (var i = 0; i < items.length; i++) {
          if (!items[i] || !Array.isArray(items[i].errors)) continue;
          for (var j = 0; j < items[i].errors.length; j++) {
            var message = items[i].errors[j] && items[i].errors[j].message;
            if (typeof message === "string" && /client.?id|client-id/i.test(message)) return true;
          }
        }
      } catch (e) {}
      return false;
    }

    function attemptClientIds(clientIds, index) {
      var clientId = clientIds[index];
      return sendRequestWithClientId(clientId).then(function (response) {
        if (!response) return response;
        return response.text().then(function (text) {
          var rejected = parseClientIdRejection(response, text);
          if (rejected && clientId === ClientID) {
            reportRemoteConfigFailure("clientId", clientId, "client-id-rejected");
          }
          if (rejected && index + 1 < clientIds.length) {
            return attemptClientIds(clientIds, index + 1);
          }
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        });
      });
    }

    return attemptClientIds(getClientIdCandidates(), 0);
  }

  // getAccessToken and gqlRequest run both in the Worker and on the main
  // thread (pre-warm). Each context defines its own sendGqlFetch and
  // reportRemoteConfigFailure; these two are the Worker's, injected into the
  // blob as strings. The Worker's GQL requests are sent by the main thread
  // (see handleWorkerFetchRequest).
  function workerSendGqlFetch(url, options) {
    return new Promise(function (resolve, reject) {
      var requestId = Math.random().toString(36).substring(2, 15);
      pendingFetchRequests.set(requestId, { resolve: resolve, reject: reject });
      setTimeout(function () {
        if (pendingFetchRequests.has(requestId)) {
          pendingFetchRequests.delete(requestId);
          reject(new Error("Fetch request timed out"));
        }
      }, 30000);
      postMessage({
        key: "FetchRequest",
        value: { id: requestId, url: url, options: options }
      });
    });
  }

  function workerReportRemoteConfigFailure(type, value, reason) {
    postMessage({ key: "RemoteConfigFailure", failureType: type, failedValue: value, reason: reason || "" });
  }

  function sendGqlFetch(url, options) {
    return (_realFetch || window.fetch)(url, options);
  }

  // --- Main thread: handle worker fetch requests

  async function handleWorkerFetchRequest(fetchRequest) {
    try {
      var response = await _realFetch(fetchRequest.url, fetchRequest.options);
      var responseBody = await response.text();
      return {
        id: fetchRequest.id,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody
      };
    } catch (error) {
      return { id: fetchRequest.id, error: error.message };
    }
  }

  // --- Main thread: pre-warm backup streams
  // Proactively fetches backup master playlists, but adapts the cadence based on
  // recent ad pressure and whether the current live player is actually active.

  var _preWarmStates = Object.create(null);
  var _PRE_WARM_BOOTSTRAP_DELAY_MS = 3000;
  var _PRE_WARM_BOOTSTRAP_JITTER_MS = 2000;
  var _PRE_WARM_MIN_DELAY_MS = 1500;
  var _PRE_WARM_BASE_MS = 5 * 60 * 1000;
  var _PRE_WARM_STABLE_MS = 12 * 60 * 1000;
  var _PRE_WARM_HIDDEN_MS = 15 * 60 * 1000;
  var _PRE_WARM_AGGRESSIVE_MS = 90 * 1000;
  var _PRE_WARM_AGGRESSIVE_JITTER_MS = 15000;
  var _PRE_WARM_STABLE_WINDOW_MS = 10 * 60 * 1000;
  var _PRE_WARM_SIGNAL_BOOST_MS = 4 * 60 * 1000;

  function clearPreWarmState(state) {
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  function disposePreWarmState(channelName) {
    if (!_preWarmStates[channelName]) return;
    clearPreWarmState(_preWarmStates[channelName]);
    delete _preWarmStates[channelName];
  }

  function getActualVisibilityState() {
    try {
      if (_realVisibilityState && typeof _realVisibilityState.get === "function") {
        return _realVisibilityState.get.call(document);
      }
    } catch (e) {}
    try {
      if (_realHidden && _realHidden.apply(document) === true) {
        return "hidden";
      }
    } catch (e) {}
    return "visible";
  }

  function isPreWarmContextActive(channelName) {
    if (getActualVisibilityState() === "hidden") return false;
    if (channelName) {
      var currentChannelName = getCurrentPageChannelName();
      if (currentChannelName && currentChannelName !== channelName.toLowerCase()) return false;
    }
    var ps = getPlayerAndState();
    if (!ps || !ps.player || !ps.state) return true;
    var content = ps.state.props && ps.state.props.content;
    if (content && content.type !== "live") return false;
    if (typeof ps.player.isPaused === "function" && ps.player.isPaused()) return false;
    return true;
  }

  function getAdaptivePreWarmDelay(state) {
    var now = Date.now();
    if (!isPreWarmContextActive(state.channelName)) {
      return _PRE_WARM_HIDDEN_MS + Math.floor(Math.random() * 60000);
    }
    if (state.currentAdActive || state.aggressiveUntil > now) {
      return _PRE_WARM_AGGRESSIVE_MS + Math.floor(Math.random() * _PRE_WARM_AGGRESSIVE_JITTER_MS);
    }
    if (state.stableSince && now - state.stableSince >= _PRE_WARM_STABLE_WINDOW_MS) {
      return _PRE_WARM_STABLE_MS + Math.floor(Math.random() * 60000);
    }
    return _PRE_WARM_BASE_MS + Math.floor(Math.random() * 30000);
  }

  function scheduleNextPreWarm(state, delayMs) {
    if (!state) return;
    clearPreWarmState(state);
    state.timer = setTimeout(function () {
      runAdaptivePreWarm(state.channelName);
    }, Math.max(_PRE_WARM_MIN_DELAY_MS, Math.floor(delayMs || _PRE_WARM_BASE_MS)));
  }

  function nudgePreWarmState(state) {
    if (!state) return;
    if (!isPreWarmContextActive(state.channelName)) {
      scheduleNextPreWarm(state, _PRE_WARM_HIDDEN_MS);
      return;
    }
    scheduleNextPreWarm(state, _PRE_WARM_MIN_DELAY_MS + Math.floor(Math.random() * 1000));
  }

  function buildPreWarmPlayerOrder(state) {
    return buildRankedPlayerTypeOrder(
      state.channelName,
      state.playerTypeSessionScores,
      state.lastSuccessfulPlayerType || state.preferredPlayerType || FallbackPlayerType
    );
  }

  function getPreWarmTargetCount(state) {
    var totalTypes = BackupPlayerTypes.length;
    if (!totalTypes) return 0;
    if (!isPreWarmContextActive(state.channelName)) return 1;
    var now = Date.now();
    if (state.currentAdActive || state.aggressiveUntil > now) {
      return Math.min(3, totalTypes);
    }
    if (state.lastSuccessfulPlayerType || state.preferredPlayerType) {
      return Math.min(2, totalTypes);
    }
    return 1;
  }

  // Same token request as the Worker's backup streams, so pre-warm also tries
  // the fallback hashes, the fallback client IDs and the full query.
  function fetchPreWarmMasterPlaylist(state, playerType, fetchFn) {
    var realPlayerType = playerType.replace("-CACHED", "");
    return getAccessToken(state.channelName, realPlayerType).then(function (response) {
      if (!response || response.status !== 200) return null;
      return response.json().then(function (accessToken) {
        if (!accessToken.data || !accessToken.data.streamPlaybackAccessToken) return null;
        var urlInfo = new URL("https://usher.ttvnw.net/api/" + (state.v2api ? "v2/" : "") + "channel/hls/" + state.channelName + ".m3u8" + state.usherParams);
        urlInfo.searchParams.set("sig", accessToken.data.streamPlaybackAccessToken.signature);
        urlInfo.searchParams.set("token", accessToken.data.streamPlaybackAccessToken.value);
        return fetchFn(urlInfo.href).then(function (m3u8Response) {
          if (m3u8Response.status !== 200) return null;
          return m3u8Response.text().then(function (text) {
            return { playerType: playerType, encodingsM3u8: text };
          });
        });
      });
    })["catch"](function () { return null; });
  }

  function runAdaptivePreWarm(channelName) {
    var state = _preWarmStates[channelName];
    if (!state) return;
    if (twitchWorkers.indexOf(state.workerRef) === -1) {
      disposePreWarmState(channelName);
      return;
    }
    if (state.inFlight) {
      scheduleNextPreWarm(state, _PRE_WARM_MIN_DELAY_MS + Math.floor(Math.random() * 1000));
      return;
    }

    var fetchFn = _realFetch || window.fetch;
    var now = Date.now();
    var targetCount = getPreWarmTargetCount(state);
    var order = buildPreWarmPlayerOrder(state);
    var freshnessWindow = (state.currentAdActive || state.aggressiveUntil > now) ? 60000 : 3 * 60 * 1000;
    var selectedTypes = order.filter(function (playerType) {
      var lastWarmAt = state.lastWarmAtByPlayerType[playerType] || 0;
      return !lastWarmAt || now - lastWarmAt >= freshnessWindow;
    }).slice(0, targetCount);

    if (!selectedTypes.length) {
      scheduleNextPreWarm(state, getAdaptivePreWarmDelay(state));
      return;
    }

    state.inFlight = true;
    state.lastPreWarmAt = now;
    Promise.allSettled(selectedTypes.map(function (playerType) {
      state.lastWarmAtByPlayerType[playerType] = now;
      return fetchPreWarmMasterPlaylist(state, playerType, fetchFn).then(function (result) {
        if (!result || !_preWarmStates[channelName] || _preWarmStates[channelName] !== state) return;
        state.workerRef.postMessage({
          key: "PreWarmCache",
          channelName: channelName,
          playerType: result.playerType,
          encodingsM3u8: result.encodingsM3u8
        });
      });
    })).finally(function () {
      if (!_preWarmStates[channelName] || _preWarmStates[channelName] !== state) return;
      state.inFlight = false;
      scheduleNextPreWarm(state, getAdaptivePreWarmDelay(state));
    });
  }

  function handlePreWarmStatusUpdate(message) {
    if (!message || !message.channelName) return;
    var state = _preWarmStates[message.channelName];
    if (!state) return;

    var now = Date.now();
    if (message.playerTypeScoreDeltas) {
      applyPlayerTypeScoreDeltas(state.playerTypeSessionScores, message.playerTypeScoreDeltas);
      persistPlayerTypeRankingUpdate(message.channelName, message.playerTypeScoreDeltas);
    }
    if (message.currentResolution && message.currentResolution.Resolution) {
      state.currentResolution = {
        Resolution: message.currentResolution.Resolution,
        FrameRate: message.currentResolution.FrameRate,
        Codecs: message.currentResolution.Codecs
      };
    }
    if (message.lastSuccessfulPlayerType) {
      state.lastSuccessfulPlayerType = message.lastSuccessfulPlayerType;
      state.preferredPlayerType = message.lastSuccessfulPlayerType;
    }
    if (message.hasAds) {
      var isNewAd = !state.currentAdActive;
      state.currentAdActive = true;
      state.lastAdSeenAt = now;
      state.stableSince = 0;
      state.aggressiveUntil = Math.max(state.aggressiveUntil || 0, now + _PRE_WARM_SIGNAL_BOOST_MS);
      if (isNewAd) nudgePreWarmState(state);
      return;
    }

    if (state.currentAdActive) {
      state.currentAdActive = false;
      state.stableSince = now;
      state.aggressiveUntil = Math.max(state.aggressiveUntil || 0, now + 2 * 60 * 1000);
      nudgePreWarmState(state);
      return;
    }

    if (!state.stableSince) {
      state.stableSince = now;
    }
  }

  function boostAdaptivePreWarm(channelName) {
    var now = Date.now();
    for (var key in _preWarmStates) {
      if (channelName && key !== channelName) continue;
      var state = _preWarmStates[key];
      state.aggressiveUntil = Math.max(state.aggressiveUntil || 0, now + _PRE_WARM_SIGNAL_BOOST_MS);
      state.stableSince = 0;
      nudgePreWarmState(state);
    }
  }

  function resumeAdaptivePreWarm(channelName) {
    for (var key in _preWarmStates) {
      if (channelName && key !== channelName) continue;
      nudgePreWarmState(_preWarmStates[key]);
    }
  }

  function preWarmBackupStreams(channelName, usherParams, v2api, workerRef) {
    if (!channelName || !usherParams) return;

    for (var key in _preWarmStates) {
      if (key !== channelName) {
        disposePreWarmState(key);
      }
    }

    var state = _preWarmStates[channelName];
    if (!state) {
      state = _preWarmStates[channelName] = {
        channelName: channelName,
        usherParams: usherParams,
        v2api: !!v2api,
        workerRef: workerRef,
        timer: null,
        inFlight: false,
        currentAdActive: false,
        stableSince: Date.now(),
        aggressiveUntil: 0,
        lastAdSeenAt: 0,
        lastPreWarmAt: 0,
        preferredPlayerType: getPreferredPlayerType(channelName),
        lastSuccessfulPlayerType: null,
        playerTypeSessionScores: Object.create(null),
        currentResolution: null,
        lastWarmAtByPlayerType: Object.create(null)
      };
      scheduleNextPreWarm(state, _PRE_WARM_BOOTSTRAP_DELAY_MS + Math.floor(Math.random() * _PRE_WARM_BOOTSTRAP_JITTER_MS));
      return;
    }
    state.usherParams = usherParams;
    state.v2api = !!v2api;
    state.workerRef = workerRef;
    if (state.currentAdActive || state.aggressiveUntil > Date.now()) {
      nudgePreWarmState(state);
    } else if (!state.timer && !state.inFlight) {
      scheduleNextPreWarm(state, getAdaptivePreWarmDelay(state));
    }
  }

  // --- Main thread: hook fetch for auth capture + playerType forcing

  var _realFetch = null;

  function hookFetch() {
    var realFetch = window.fetch;
    _realFetch = realFetch;
    function getHeaderValue(headers, primary, secondary) {
      if (!headers) return null;
      if (typeof headers.get === "function") {
        return headers.get(primary) || (secondary ? headers.get(secondary) : null);
      }
      return headers[primary] || (secondary ? headers[secondary] : null);
    }
    window.fetch = function (url, init) {
      // Fast path: skip all processing for non-GQL requests
      if (typeof url !== "string" || !url.includes("gql") || !init || !init.headers) {
        return realFetch.apply(this, arguments);
      }
      {
          var h = init.headers;
          var runtimeUpdates = {};
          var clientIdHeader = getHeaderValue(h, "Client-ID");
          if (typeof clientIdHeader === "string" && clientIdHeader !== ClientID) {
            persistRemoteConfigCandidate("clientId", clientIdHeader);
          }
          var deviceId = getHeaderValue(h, "X-Device-Id", "Device-ID");
          if (typeof deviceId === "string" && GQLDeviceID != deviceId) {
            GQLDeviceID = deviceId;
            runtimeUpdates.gqlDeviceId = deviceId;
            postTwitchWorkerMessage("UpdateDeviceId", GQLDeviceID);
          }
          var clientVersionHeader = getHeaderValue(h, "Client-Version");
          if (typeof clientVersionHeader === "string" && clientVersionHeader !== ClientVersion) {
            ClientVersion = clientVersionHeader;
            runtimeUpdates.clientVersion = clientVersionHeader;
            postTwitchWorkerMessage("UpdateClientVersion", clientVersionHeader);
          }
          var clientSessionHeader = getHeaderValue(h, "Client-Session-Id");
          if (typeof clientSessionHeader === "string" && clientSessionHeader !== ClientSession) {
            ClientSession = clientSessionHeader;
            runtimeUpdates.clientSession = clientSessionHeader;
            postTwitchWorkerMessage("UpdateClientSession", clientSessionHeader);
          }
          var clientIntegrity = getHeaderValue(h, "Client-Integrity");
          if (typeof clientIntegrity === "string" && clientIntegrity !== ClientIntegrityHeader) {
            ClientIntegrityHeader = clientIntegrity;
            runtimeUpdates.clientIntegrityHeader = clientIntegrity;
            postTwitchWorkerMessage("UpdateClientIntegrityHeader", clientIntegrity);
          }
          var authorization = getHeaderValue(h, "Authorization");
          if (typeof authorization === "string" && authorization !== AuthorizationHeader) {
            AuthorizationHeader = authorization;
            runtimeUpdates.authorizationHeader = authorization;
            postTwitchWorkerMessage("UpdateAuthorizationHeader", authorization);
          }
          persistRuntimeUpdates(runtimeUpdates);
          // Learn GQL hashes at runtime by observing Twitch's own requests
          if (typeof init.body === "string" && init.body.includes("persistedQuery")) {
            try {
              var learnBody = JSON.parse(init.body);
              var learnItems = Array.isArray(learnBody) ? learnBody : [learnBody];
              for (var li = 0; li < learnItems.length; li++) {
                var learnItem = learnItems[li];
                if (learnItem && learnItem.operationName === "PlaybackAccessToken" &&
                    learnItem.extensions && learnItem.extensions.persistedQuery &&
                    learnItem.extensions.persistedQuery.sha256Hash) {
                  var observedHash = learnItem.extensions.persistedQuery.sha256Hash;
                  if (observedHash !== PlaybackAccessTokenHash) {
                    console.log("[TTV] Learned new PlaybackAccessToken hash: " + observedHash);
                    persistRemoteConfigCandidate("playbackAccessTokenHash", observedHash);
                  }
                }
                if (learnItem && learnItem.operationName === "PlaybackAccessToken" &&
                    typeof learnItem.query === "string" && learnItem.query.indexOf("PlaybackAccessToken") !== -1) {
                  if (learnItem.query !== RemotePlaybackAccessTokenQuery && learnItem.query !== PlaybackAccessTokenQuery) {
                    persistRemoteConfigCandidate("playbackAccessTokenQuery", learnItem.query);
                  }
                }
              }
            } catch (e) {}
          }
          // Filter picture-by-picture from PlaybackAccessToken requests
          // (PBP bypasses Worker hooks, leaking ads)
          // NOTE: playerType is NOT forced here — the primary stream should use
          // Twitch's native playerType for full quality. Backup streams handle
          // playerType forcing inside the Worker's getAccessToken.
          if (typeof init.body === "string" && init.body.includes("PlaybackAccessToken")) {
            try {
              var newBody = JSON.parse(init.body);
              var items = Array.isArray(newBody) ? newBody : [newBody];
              var filtered = items.filter(function (item) {
                return !(item && item.variables && item.variables.playerType === "picture-by-picture");
              });
              if (filtered.length !== items.length) {
                if (filtered.length === 0) {
                  return Promise.resolve(new Response('{"data":{"streamPlaybackAccessToken":null}}', { status: 200, headers: { "Content-Type": "application/json" } }));
                }
                init = Object.assign({}, init, {
                  body: JSON.stringify(Array.isArray(newBody) ? filtered : filtered[0])
                });
              }
            } catch (e) {
              console.warn("[TTV] Failed to parse PlaybackAccessToken body:", e);
            }
          }
      }
      return realFetch.call(this, url, init);
    };
  }

  // Listen for reload requests from content script (bridged via CustomEvent)
  window.addEventListener("ttv-" + _nonce + "-reload", function (event) {
    var detail = event && event.detail || {};
    boostAdaptivePreWarm();
    requestStreamRecovery({
      minimumAction: "reload",
      reason: detail.reason || "content-script-reload",
      bypassCooldown: !!detail.bypassCooldown
    });
  });
  window.addEventListener("focus", function () { resumeAdaptivePreWarm(); }, true);
  document.addEventListener("visibilitychange", function () {
    if (getActualVisibilityState() !== "hidden") resumeAdaptivePreWarm();
  }, true);

  // --- Player control (pause/play, reload)

  function getPlayerAndState() {
    function findReactNode(root, constraint) {
      if (root.stateNode && constraint(root.stateNode)) return root.stateNode;
      var node = root.child;
      while (node) {
        var result = findReactNode(node, constraint);
        if (result) return result;
        node = node.sibling;
      }
      return null;
    }
    var rootNode = document.querySelector("#root");
    var reactRootNode = null;
    if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot) {
      reactRootNode = rootNode._reactRootContainer._internalRoot.current;
    }
    var _rContainerPrefix = (_cfgReact && _cfgReact.containerKeyPrefix) || "__reactContainer";
    var _rPlayerActive = (_cfgReact && _cfgReact.playerActiveMethod) || "setPlayerActive";
    var _rMediaPlayer = (_cfgReact && _cfgReact.mediaPlayerProp) || "mediaPlayerInstance";
    var _rSetSrc = (_cfgReact && _cfgReact.setSrcMethod) || "setSrc";
    var _rSetInitial = (_cfgReact && _cfgReact.setInitialPlaybackMethod) || "setInitialPlaybackSettings";
    if (!reactRootNode && rootNode) {
      var containerName = Object.keys(rootNode).find(function (x) { return x.startsWith(_rContainerPrefix); });
      if (containerName) reactRootNode = rootNode[containerName];
    }
    if (!reactRootNode) return null;
    var player = findReactNode(reactRootNode, function (node) {
      return node[_rPlayerActive] && node.props && node.props[_rMediaPlayer];
    });
    player = player && player.props && player.props[_rMediaPlayer] ? player.props[_rMediaPlayer] : null;
    if (player && player.playerInstance) player = player.playerInstance;
    var playerState = findReactNode(reactRootNode, function (node) {
      return node[_rSetSrc] && node[_rSetInitial];
    });
    return { player: player, state: playerState };
  }

  var localStorageHookFailed = false;
  var _recoveryOverlay = {
    root: null,
    frame: null,
    title: null,
    note: null,
    watchTimer: null,
    cleanupTimer: null,
    shownAt: 0,
    lastVideoTime: null
  };

  function clearRecoveryOverlayTimers() {
    if (_recoveryOverlay.watchTimer) {
      clearTimeout(_recoveryOverlay.watchTimer);
      _recoveryOverlay.watchTimer = null;
    }
    if (_recoveryOverlay.cleanupTimer) {
      clearTimeout(_recoveryOverlay.cleanupTimer);
      _recoveryOverlay.cleanupTimer = null;
    }
  }

  function ensureRecoveryOverlayStyles() {
    if (document.getElementById("ttv-kekw-recovery-style")) return;
    var style = document.createElement("style");
    style.id = "ttv-kekw-recovery-style";
    style.textContent =
      "@keyframes ttvKekwRecoveryPulse{" +
      "0%{transform:scale(1);opacity:.72;}" +
      "50%{transform:scale(1.08);opacity:1;}" +
      "100%{transform:scale(1);opacity:.72;}" +
      "}";
    (document.head || document.documentElement).appendChild(style);
  }

  function getRecoveryContainer() {
    return document.querySelector(".persistent-player") ||
      document.querySelector("[data-a-target='video-player']") ||
      document.querySelector(".video-player") ||
      document.querySelector("video");
  }

  function getRecoveryVideoElement() {
    var ps = getPlayerAndState();
    if (ps && ps.player && typeof ps.player.getHTMLVideoElement === "function") {
      var playerVideo = ps.player.getHTMLVideoElement();
      if (playerVideo) return playerVideo;
    }
    return document.querySelector("video");
  }

  function ensureRecoveryOverlay() {
    ensureRecoveryOverlayStyles();
    if (_recoveryOverlay.root && _recoveryOverlay.root.parentNode) return _recoveryOverlay;

    var root = document.createElement("div");
    root.id = "ttv-kekw-recovery";
    root.style.cssText =
      "position:fixed;left:0;top:0;width:0;height:0;opacity:0;display:none;" +
      "pointer-events:none;overflow:hidden;border-radius:10px;z-index:999998;" +
      "box-shadow:0 20px 60px rgba(0,0,0,.28);transition:opacity .28s ease;";

    var frame = document.createElement("canvas");
    frame.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;display:none;" +
      "filter:saturate(.95) brightness(.76);";

    var scrim = document.createElement("div");
    scrim.style.cssText =
      "position:absolute;inset:0;background:" +
      "linear-gradient(180deg,rgba(9,11,15,.08) 0%,rgba(9,11,15,.5) 54%,rgba(9,11,15,.82) 100%);";

    var content = document.createElement("div");
    content.style.cssText =
      "position:absolute;left:18px;right:18px;bottom:18px;display:flex;align-items:center;" +
      "gap:12px;color:#f7f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";

    var pulse = document.createElement("div");
    pulse.style.cssText =
      "width:10px;height:10px;border-radius:999px;background:#ff7a45;flex:0 0 auto;" +
      "box-shadow:0 0 0 6px rgba(255,122,69,.16);animation:ttvKekwRecoveryPulse 1.2s ease-in-out infinite;";

    var textWrap = document.createElement("div");
    textWrap.style.cssText = "min-width:0;display:flex;flex-direction:column;gap:3px;";

    var title = document.createElement("div");
    title.style.cssText = "font-size:15px;font-weight:700;line-height:1.2;";

    var note = document.createElement("div");
    note.style.cssText = "font-size:12px;line-height:1.35;color:rgba(247,248,250,.84);";

    textWrap.appendChild(title);
    textWrap.appendChild(note);
    content.appendChild(pulse);
    content.appendChild(textWrap);
    root.appendChild(frame);
    root.appendChild(scrim);
    root.appendChild(content);
    document.body.appendChild(root);

    _recoveryOverlay.root = root;
    _recoveryOverlay.frame = frame;
    _recoveryOverlay.title = title;
    _recoveryOverlay.note = note;
    return _recoveryOverlay;
  }

  function updateRecoveryOverlayBounds() {
    if (!_recoveryOverlay.root) return;
    var container = getRecoveryContainer();
    var rect = container && typeof container.getBoundingClientRect === "function" ? container.getBoundingClientRect() : null;
    if (!rect || rect.width < 120 || rect.height < 68) {
      _recoveryOverlay.root.style.left = "24px";
      _recoveryOverlay.root.style.top = "24px";
      _recoveryOverlay.root.style.width = Math.max(280, Math.min(window.innerWidth - 48, 560)) + "px";
      _recoveryOverlay.root.style.height = "160px";
      return;
    }
    _recoveryOverlay.root.style.left = Math.max(0, rect.left) + "px";
    _recoveryOverlay.root.style.top = Math.max(0, rect.top) + "px";
    _recoveryOverlay.root.style.width = Math.max(120, rect.width) + "px";
    _recoveryOverlay.root.style.height = Math.max(68, rect.height) + "px";
  }

  function captureRecoveryFrame(video) {
    if (!_recoveryOverlay.frame || !video || !video.videoWidth || !video.videoHeight) return false;
    try {
      var canvas = _recoveryOverlay.frame;
      var ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return false;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.style.display = "block";
      return true;
    } catch (e) {
      _recoveryOverlay.frame.style.display = "none";
      return false;
    }
  }

  function hideRecoveryOverlay() {
    if (!_recoveryOverlay.root) return;
    clearRecoveryOverlayTimers();
    _recoveryOverlay.root.style.opacity = "0";
    _recoveryOverlay.cleanupTimer = setTimeout(function () {
      if (_recoveryOverlay.root) _recoveryOverlay.root.style.display = "none";
    }, 280);
  }

  function watchRecoveryOverlayUntilPlaybackReturns() {
    clearRecoveryOverlayTimers();
    var stableTicks = 0;

    function tick() {
      if (!_recoveryOverlay.root || _recoveryOverlay.root.style.display === "none") return;
      updateRecoveryOverlayBounds();

      var video = getRecoveryVideoElement();
      var elapsed = Date.now() - _recoveryOverlay.shownAt;
      if (video && !video.paused && video.readyState >= 2) {
        var currentTime = video.currentTime;
        var hasProgress = _recoveryOverlay.lastVideoTime !== null && currentTime > _recoveryOverlay.lastVideoTime + 0.05;
        var hasBufferedFrame = video.readyState >= 3 && !video.seeking;
        if (elapsed >= 450 && (hasProgress || hasBufferedFrame)) {
          stableTicks++;
          if (stableTicks >= 2) {
            hideRecoveryOverlay();
            return;
          }
        } else {
          stableTicks = 0;
        }
        _recoveryOverlay.lastVideoTime = currentTime;
      } else {
        stableTicks = 0;
      }

      if (elapsed >= 9000) {
        hideRecoveryOverlay();
        return;
      }

      _recoveryOverlay.watchTimer = setTimeout(tick, 250);
    }

    tick();
  }

  function showRecoveryOverlay(message, note) {
    var overlay = ensureRecoveryOverlay();
    var video = getRecoveryVideoElement();
    clearRecoveryOverlayTimers();
    updateRecoveryOverlayBounds();
    overlay.title.textContent = message || "Syncing stream...";
    overlay.note.textContent = note || "Holding the last good frame while playback catches up.";
    overlay.frame.style.display = "none";
    captureRecoveryFrame(video);
    overlay.root.style.display = "block";
    overlay.root.style.opacity = "0";
    overlay.shownAt = Date.now();
    overlay.lastVideoTime = video && !isNaN(video.currentTime) ? video.currentTime : null;
    requestAnimationFrame(function () {
      updateRecoveryOverlayBounds();
      if (_recoveryOverlay.root) _recoveryOverlay.root.style.opacity = "1";
    });
    watchRecoveryOverlayUntilPlaybackReturns();
  }

  function getRecoveryChannelName(channelName) {
    if (channelName) return String(channelName).toLowerCase();
    if (playerBufferState && playerBufferState.channelName) return String(playerBufferState.channelName).toLowerCase();
    return getCurrentPageChannelName() || "__page__";
  }

  function getRecoveryChannelState(channelName) {
    var key = getRecoveryChannelName(channelName);
    if (!_recoveryStateByChannel[key]) {
      _recoveryStateByChannel[key] = {
        lastAttemptAt: 0,
        lastAction: null,
        nextActionIndex: 0,
        lastActionAt: { seek: 0, pause: 0, reload: 0 }
      };
    }
    return _recoveryStateByChannel[key];
  }

  function getRecoveryActionValue(values, actionName) {
    return values && typeof values[actionName] === "string" ? values[actionName] : null;
  }

  function captureVideoTextTrackState(video) {
    if (!video || !video.textTracks || !video.textTracks.length) return null;
    var tracks = [];
    for (var i = 0; i < video.textTracks.length; i++) {
      var track = video.textTracks[i];
      tracks.push({
        index: i,
        kind: track.kind || "",
        label: track.label || "",
        language: track.language || "",
        mode: track.mode || "disabled"
      });
    }
    return tracks.length ? tracks : null;
  }

  function applyVideoTextTrackState(video, tracks) {
    if (!video || !video.textTracks || !tracks || !tracks.length) return false;
    var applied = false;
    for (var i = 0; i < tracks.length; i++) {
      var targetState = tracks[i];
      var targetTrack = null;
      for (var j = 0; j < video.textTracks.length; j++) {
        var candidate = video.textTracks[j];
        if ((candidate.kind || "") === targetState.kind &&
            (candidate.label || "") === targetState.label &&
            (candidate.language || "") === targetState.language) {
          targetTrack = candidate;
          break;
        }
      }
      if (!targetTrack && video.textTracks[targetState.index]) {
        targetTrack = video.textTracks[targetState.index];
      }
      if (!targetTrack) continue;
      try {
        if (targetTrack.mode !== targetState.mode) {
          targetTrack.mode = targetState.mode;
        }
        applied = true;
      } catch (e) {}
    }
    return applied;
  }

  function captureRecoveryPlayerState(ps) {
    var snapshot = {
      storageValues: Object.create(null),
      muted: null,
      volume: null,
      playbackRate: null,
      textTracks: null
    };
    for (var i = 0; i < RECOVERY_STORAGE_KEYS.length; i++) {
      var storageKey = RECOVERY_STORAGE_KEYS[i];
      try {
        var storageValue = localStorage.getItem(storageKey);
        if (storageValue !== null && storageValue !== undefined) {
          snapshot.storageValues[storageKey] = storageValue;
        }
      } catch (e) {}
    }
    if (localStorageHookFailed && ps && ps.player && ps.player.core && ps.player.core.state) {
      try {
        if (snapshot.storageValues["video-muted"] === undefined) {
          snapshot.storageValues["video-muted"] = JSON.stringify({ default: !!ps.player.core.state.muted });
        }
        if (snapshot.storageValues.volume === undefined && typeof ps.player.core.state.volume === "number") {
          snapshot.storageValues.volume = String(ps.player.core.state.volume);
        }
        if (snapshot.storageValues["video-quality"] === undefined &&
            ps.player.core.state.quality && ps.player.core.state.quality.group) {
          snapshot.storageValues["video-quality"] = JSON.stringify({ default: ps.player.core.state.quality.group });
        }
      } catch (e) {}
    }
    var video = ps && ps.player && typeof ps.player.getHTMLVideoElement === "function"
      ? ps.player.getHTMLVideoElement()
      : null;
    if (video) {
      if (typeof video.muted === "boolean") snapshot.muted = video.muted;
      if (typeof video.volume === "number" && isFinite(video.volume)) snapshot.volume = video.volume;
      if (typeof video.playbackRate === "number" && isFinite(video.playbackRate) && video.playbackRate > 0) {
        snapshot.playbackRate = video.playbackRate;
      }
      snapshot.textTracks = captureVideoTextTrackState(video);
    }
    return snapshot;
  }

  function restoreRecoveryStorageState(snapshot) {
    if (!snapshot || !snapshot.storageValues) return;
    for (var key in snapshot.storageValues) {
      try {
        localStorage.setItem(key, snapshot.storageValues[key]);
      } catch (e) {}
    }
  }

  function applyRecoveryVideoState(snapshot) {
    if (!snapshot) return false;
    var video = getRecoveryVideoElement();
    if (!video) return false;
    try {
      if (snapshot.muted !== null) video.muted = !!snapshot.muted;
      if (typeof snapshot.volume === "number" && isFinite(snapshot.volume)) {
        video.volume = Math.max(0, Math.min(1, snapshot.volume));
      }
      if (typeof snapshot.playbackRate === "number" && isFinite(snapshot.playbackRate) && snapshot.playbackRate > 0) {
        video.playbackRate = snapshot.playbackRate;
        if (typeof video.defaultPlaybackRate === "number") {
          video.defaultPlaybackRate = snapshot.playbackRate;
        }
      }
      applyVideoTextTrackState(video, snapshot.textTracks);
      return true;
    } catch (e) {
      return false;
    }
  }

  function scheduleRecoveryPlayerStateRestore(snapshot) {
    if (!snapshot) return;
    restoreRecoveryStorageState(snapshot);
    var attempts = 0;
    function tryRestore() {
      attempts++;
      if (applyRecoveryVideoState(snapshot)) {
        setTimeout(function () {
          applyRecoveryVideoState(snapshot);
        }, 1200);
        return;
      }
      if (attempts < 10) {
        setTimeout(tryRestore, attempts < 4 ? 250 : 500);
      }
    }
    setTimeout(tryRestore, 450);
  }

  function executeRecoveryAction(actionName, ps, options) {
    var message = getRecoveryActionValue(options.messages, actionName);
    var note = getRecoveryActionValue(options.notes, actionName);
    if (actionName === "seek") {
      playerBufferState.lastFixTime = Date.now();
      playerBufferState.numSame = 0;
      showRecoveryOverlay(
        message || "Syncing stream...",
        note || "Holding the last good frame while playback catches up."
      );
      return seekToLiveEdge(ps.player);
    }
    if (actionName === "pause") {
      return doTwitchPlayerTask(
        true,
        false,
        message || "Syncing stream...",
        note || "Recovering playback with a quick player resync."
      );
    }
    if (actionName === "reload") {
      return doTwitchPlayerTask(
        false,
        true,
        message || "Recovering stream...",
        note || "Refreshing playback while the stream reconnects."
      );
    }
    return false;
  }

  function requestStreamRecovery(options) {
    options = options || {};
    var currentChannelName = getCurrentPageChannelName();
    var requestedChannelName = options.channelName ? String(options.channelName).toLowerCase() : "";
    if (requestedChannelName && currentChannelName && requestedChannelName !== currentChannelName) return false;

    var ps = getPlayerAndState();
    if (!ps || !ps.player || !ps.state) return false;
    if (ps.player.isPaused() || (ps.player.core && ps.player.core.paused)) return false;

    var state = getRecoveryChannelState(requestedChannelName);
    var channelKey = getRecoveryChannelName(requestedChannelName);
    var now = Date.now();
    if (!state.lastAttemptAt || now - state.lastAttemptAt >= RECOVERY_LADDER_RESET_MS) {
      state.nextActionIndex = 0;
      state.lastAction = null;
    }

    var minimumActionIndex = RECOVERY_ACTION_INDEX.hasOwnProperty(options.minimumAction)
      ? RECOVERY_ACTION_INDEX[options.minimumAction]
      : 0;
    var actionIndex = Math.max(minimumActionIndex, state.nextActionIndex || 0);
    while (actionIndex < RECOVERY_ACTIONS.length) {
      var actionName = RECOVERY_ACTIONS[actionIndex];
      if (options.bypassCooldown) break;
      var lastActionAt = state.lastActionAt[actionName] || 0;
      var cooldownMs = RECOVERY_ACTION_COOLDOWNS[actionName] || 0;
      if (!lastActionAt || now - lastActionAt >= cooldownMs) break;
      actionIndex++;
    }
    if (actionIndex >= RECOVERY_ACTIONS.length) return false;

    while (actionIndex < RECOVERY_ACTIONS.length) {
      var selectedAction = RECOVERY_ACTIONS[actionIndex];
      state.lastAttemptAt = now;
      state.lastActionAt[selectedAction] = now;
      state.lastAction = selectedAction;
      state.nextActionIndex = Math.min(actionIndex + 1, RECOVERY_ACTIONS.length - 1);
      if (executeRecoveryAction(selectedAction, ps, options)) {
        var notification = getRecoveryActionValue(options.notifications, selectedAction);
        if (notification) showTtvNotification(notification);
        console.log("[TTV] Recovery ladder: " + selectedAction +
          " channel=" + channelKey +
          (options.reason ? " reason=" + options.reason : ""));
        return true;
      }
      actionIndex++;
    }
    return false;
  }

  function doTwitchPlayerTask(isPausePlay, isReload, recoveryMessage, recoveryNote) {
    var ps = getPlayerAndState();
    if (!ps || !ps.player || !ps.state) return false;
    if (ps.player.isPaused() || (ps.player.core && ps.player.core.paused)) return false;
    playerBufferState.lastFixTime = Date.now();
    playerBufferState.numSame = 0;
    showRecoveryOverlay(
      recoveryMessage || (isReload ? "Recovering stream..." : "Syncing stream..."),
      recoveryNote || (isReload ? "Refreshing playback while the stream reconnects." : "Holding the last good frame while playback catches up.")
    );
    if (isPausePlay) {
      ps.player.pause();
      // Delay + no-op seek to force audio/video decoders to resync.
      // Synchronous pause/play on demuxed HLS can leave tracks at different positions.
      var video = ps.player.getHTMLVideoElement ? ps.player.getHTMLVideoElement() : null;
      setTimeout(function () {
        if (video) video.currentTime = video.currentTime;
        ps.player.play();
      }, 100);
      return true;
    }
    if (isReload) {
      var recoveryStateSnapshot = captureRecoveryPlayerState(ps);
      restoreRecoveryStorageState(recoveryStateSnapshot);
      console.log("[TTV] Reloading Twitch player");
      _notifSuppressUntil = Date.now() + 3000; // Suppress cascading notifications for 3s
      try {
        ps.state.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
        postTwitchWorkerMessage("TriggeredPlayerReload");
        // Delay play() to let setSrc initialize the new player instance.
        // Calling play() synchronously operates on a stale/transitional player.
        setTimeout(function () {
          try {
            var newPs = getPlayerAndState();
            if (newPs && newPs.player) newPs.player.play();
          } catch (e) {}
        }, 500);
        scheduleRecoveryPlayerStateRestore(recoveryStateSnapshot);
      } catch (e) {
        console.warn("[TTV] Player reload failed:", e.message);
        return false;
      }
      return true;
    }
    return false;
  }

  function postTwitchWorkerMessage(key, value) {
    twitchWorkers.forEach(function (worker) {
      worker.postMessage({ key: key, value: value });
    });
  }

  function applyRemoteConfigUpdate(cfg) {
    if (!cfg || typeof cfg !== "object") return;

    if (cfg.playbackAccessTokenHash && cfg.playbackAccessTokenHash !== PlaybackAccessTokenHash) {
      console.log("[TTV] Remote config: Updated PlaybackAccessToken hash");
      PlaybackAccessTokenHash = cfg.playbackAccessTokenHash;
      HashFailedOnce = false;
      postTwitchWorkerMessage("UpdatePlaybackAccessTokenHash", cfg.playbackAccessTokenHash);
    }
    if (Array.isArray(cfg.playbackAccessTokenHashFallbacks)) {
      PlaybackAccessTokenFallbackHashes = cfg.playbackAccessTokenHashFallbacks.slice();
      postTwitchWorkerMessage("UpdatePlaybackAccessTokenFallbackHashes", PlaybackAccessTokenFallbackHashes);
    }
    if (typeof cfg.playbackAccessTokenQuery === "string") {
      RemotePlaybackAccessTokenQuery = cfg.playbackAccessTokenQuery;
      postTwitchWorkerMessage("UpdateRemotePlaybackAccessTokenQuery", RemotePlaybackAccessTokenQuery);
    }
    if (cfg.clientId && cfg.clientId !== ClientID) {
      console.log("[TTV] Remote config: Updated Client-ID");
      ClientID = cfg.clientId;
      postTwitchWorkerMessage("UpdateClientId", cfg.clientId);
    }
    if (Array.isArray(cfg.clientIdFallbacks)) {
      ClientIDFallbacks = cfg.clientIdFallbacks.slice();
      postTwitchWorkerMessage("UpdateClientIdFallbacks", ClientIDFallbacks);
    }
  }

  // --- User notification banner

  var _notifTimeout = null;
  var _notifSuppressUntil = 0;

  function showTtvNotification(message) {
    if (!_showNotifications) return;
    if (Date.now() < _notifSuppressUntil) return;
    var existing = document.getElementById("ttv-kekw-notif");

    // If the same message is already showing, just reset the dismiss timer
    if (existing && existing.textContent === message) {
      if (_notifTimeout) { clearTimeout(_notifTimeout); }
      _notifTimeout = setTimeout(function () {
        existing.style.opacity = "0";
        setTimeout(function () { if (existing.parentNode) existing.remove(); }, 400);
        _notifTimeout = null;
      }, 4000);
      return;
    }

    if (existing) existing.remove();
    if (_notifTimeout) { clearTimeout(_notifTimeout); _notifTimeout = null; }

    var el = document.createElement("div");
    el.id = "ttv-kekw-notif";
    el.textContent = message;
    // Find the player container to anchor inside, fall back to body
    var player = document.querySelector(".persistent-player") ||
                 document.querySelector("[data-a-target='video-player']");
    var useAbsolute = !!player;

    el.style.cssText = "position:" + (useAbsolute ? "absolute" : "fixed") + ";" +
      "top:12px;left:50%;transform:translateX(-50%);height:auto;bottom:auto;" +
      "max-width:90%;width:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" +
      "background:rgba(14,14,16,0.85);color:#efeff1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "font-size:12px;font-weight:500;padding:6px 16px;border-radius:6px;z-index:999999;" +
      "pointer-events:none;opacity:0;transition:opacity 0.3s;";

    (player || document.body).appendChild(el);

    // Fade in
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.style.opacity = "1"; });
    });

    // Fade out after 4 seconds
    _notifTimeout = setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () { if (el.parentNode) el.remove(); }, 400);
      _notifTimeout = null;
    }, 4000);
  }

  // Listen for notification requests from content scripts (player-monitor)
  window.addEventListener("ttv-" + _nonce + "-notify", function (e) {
    if (e.detail && e.detail.message) showTtvNotification(e.detail.message);
  });

  // --- Buffering detection and auto-fix (via React player internals)

  var playerForMonitoringBuffering = null;
  var playerBufferState = {
    channelName: null,
    hasStreamStarted: false,
    position: 0,
    bufferedPosition: 0,
    bufferDuration: 0,
    numSame: 0,
    lastFixTime: 0,
    isLive: true,
    // Loop detection
    backwardJumps: 0,
    loopReloadCount: 0
  };
  var BUFFERING_DELAY = 600;
  var BUFFERING_SAME_STATE_COUNT = 3;
  var BUFFERING_DANGER_ZONE = 1;
  var BUFFERING_MIN_REPEAT_DELAY = 8000;
  var LOOP_BACKWARD_THRESHOLD = 5;    // 5 backward jumps in window = looping

  function seekToLiveEdge(player) {
    try {
      if (typeof player.seekToLiveEdge === "function") {
        player.seekToLiveEdge();
        return true;
      }
      var video = player.getHTMLVideoElement ? player.getHTMLVideoElement() : null;
      if (video && video.buffered && video.buffered.length > 0) {
        var liveEdge = video.buffered.end(video.buffered.length - 1);
        if (liveEdge > video.currentTime + 2) {
          video.currentTime = liveEdge - 0.5;
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // Early buffer recovery via native stalled/waiting events
  var _mediaEventVideo = null;

  function onMediaStallOrWait(evt) {
    if (!_bufferingFixEnabled || !playerForMonitoringBuffering) return;
    var now = Date.now();
    if (now - playerBufferState.lastFixTime < BUFFERING_MIN_REPEAT_DELAY) return;
    try {
      var player = playerForMonitoringBuffering.player;
      if (!player.core || player.isPaused()) return;
      var state = playerForMonitoringBuffering.state;
      if (!state || !state.props || !state.props.content || state.props.content.type !== "live") return;
      if (!playerBufferState.hasStreamStarted) return;
      var bufferDuration = player.getBufferDuration();
      if (!(bufferDuration <= BUFFERING_DANGER_ZONE)) return;
      console.log("[TTV] Media " + evt.type + " — buffer=" + bufferDuration.toFixed(2) + "s, seeking to live");
      requestStreamRecovery({
        channelName: playerBufferState.channelName,
        minimumAction: "seek",
        reason: "media-" + evt.type,
        notifications: {
          seek: "KEKW Blocker: Syncing to live",
          pause: "KEKW Blocker: Recovering stream",
          reload: "KEKW Blocker: Reloading stream"
        }
      });
    } catch (e) {}
  }

  function attachMediaEventListeners(videoEl) {
    if (_mediaEventVideo === videoEl) return;
    detachMediaEventListeners();
    if (!videoEl) return;
    videoEl.addEventListener("stalled", onMediaStallOrWait);
    videoEl.addEventListener("waiting", onMediaStallOrWait);
    _mediaEventVideo = videoEl;
  }

  function detachMediaEventListeners() {
    if (!_mediaEventVideo) return;
    try {
      _mediaEventVideo.removeEventListener("stalled", onMediaStallOrWait);
      _mediaEventVideo.removeEventListener("waiting", onMediaStallOrWait);
    } catch (e) {}
    _mediaEventVideo = null;
  }

  function monitorPlayerBuffering() {
    if (!_bufferingFixEnabled) {
      setTimeout(monitorPlayerBuffering, BUFFERING_DELAY);
      return;
    }
    if (playerForMonitoringBuffering) {
      try {
        var player = playerForMonitoringBuffering.player;
        var state = playerForMonitoringBuffering.state;
        if (!player.core) {
          playerForMonitoringBuffering = null;
          detachMediaEventListeners();
        } else if (state.props && state.props.content && state.props.content.type === "live" &&
                   !player.isPaused() && !(player.getHTMLVideoElement() && player.getHTMLVideoElement().ended) &&
                   playerBufferState.lastFixTime <= Date.now() - BUFFERING_MIN_REPEAT_DELAY) {
          var m3u8Url = player.core.state && player.core.state.path;
          if (m3u8Url) {
            var fileName = new URL(m3u8Url).pathname.split("/").pop();
            if (fileName && fileName.endsWith(".m3u8")) {
              var channelName = fileName.slice(0, -5);
              if (playerBufferState.channelName != channelName) {
                playerBufferState.channelName = channelName;
                playerBufferState.hasStreamStarted = false;
                playerBufferState.numSame = 0;
                playerBufferState.backwardJumps = 0;
                playerBufferState.loopReloadCount = 0;
              }
            }
          }
          if (player.getState() === "Playing") playerBufferState.hasStreamStarted = true;
          var position = player.core.state && player.core.state.position;
          var bufferedPosition = player.core.state && player.core.state.bufferedPosition;
          var bufferDuration = player.getBufferDuration();
          if (position !== undefined && bufferedPosition !== undefined) {
            // --- Loop detection: position jumping backwards repeatedly ---
            if (playerBufferState.hasStreamStarted && position > 0 && playerBufferState.position > 0) {
              if (position < playerBufferState.position - 0.5) {
                playerBufferState.backwardJumps++;
                console.log("[TTV] Loop detect: backward jump #" + playerBufferState.backwardJumps +
                  " (pos " + playerBufferState.position.toFixed(1) + " -> " + position.toFixed(1) + ")");
              } else if (position > playerBufferState.position) {
                // Normal forward progress — decay the counter
                if (playerBufferState.backwardJumps > 0) playerBufferState.backwardJumps--;
              }
              if (playerBufferState.backwardJumps >= LOOP_BACKWARD_THRESHOLD) {
                playerBufferState.backwardJumps = 0;
                playerBufferState.loopReloadCount++;
                requestStreamRecovery({
                  channelName: playerBufferState.channelName,
                  minimumAction: "seek",
                  reason: "loop-detected-" + playerBufferState.loopReloadCount,
                  notifications: {
                    seek: "KEKW Blocker: Syncing to live",
                    pause: "KEKW Blocker: Recovering stream",
                    reload: "KEKW Blocker: Reloading stream"
                  }
                });
              } else if (false) {
                var now = Date.now();
                if (now - playerBufferState.lastSeekToLiveTime > LOOP_SEEK_COOLDOWN) {
                  console.log("[TTV] Loop detected — seeking to live edge");
                  playerBufferState.lastSeekToLiveTime = now;
                  playerBufferState.lastFixTime = now;
                  playerBufferState.backwardJumps = 0;
                  playerBufferState.numSame = 0;
                  if (seekToLiveEdge(player)) {
                    showTtvNotification("KEKW Blocker: Syncing to live");
                  } else {
                    showTtvNotification("KEKW Blocker: Recovering stream");
                    doTwitchPlayerTask(true, false);
                  }
                } else if (now - playerBufferState.lastFixTime > LOOP_RELOAD_COOLDOWN) {
                  playerBufferState.loopReloadCount++;
                  console.log("[TTV] Loop persists — reloading player (attempt " + playerBufferState.loopReloadCount + ")");
                  playerBufferState.lastFixTime = now;
                  playerBufferState.lastSeekToLiveTime = now;
                  playerBufferState.backwardJumps = 0;
                  playerBufferState.numSame = 0;
                  showTtvNotification("KEKW Blocker: Reloading stream");
                  doTwitchPlayerTask(false, true);
                }
              }
            }
            // --- Stall detection: position not advancing ---
            if (playerBufferState.hasStreamStarted &&
                (playerBufferState.position == position || bufferDuration < BUFFERING_DANGER_ZONE) &&
                playerBufferState.bufferedPosition == bufferedPosition &&
                playerBufferState.bufferDuration >= bufferDuration &&
                (position != 0 || bufferedPosition != 0 || bufferDuration != 0)) {
              playerBufferState.numSame++;
              if (playerBufferState.numSame == BUFFERING_SAME_STATE_COUNT) {
                console.log("[TTV] Buffer fix: pos=" + playerBufferState.position + " bufPos=" + playerBufferState.bufferedPosition + " bufDur=" + playerBufferState.bufferDuration);
                requestStreamRecovery({
                  channelName: playerBufferState.channelName,
                  minimumAction: "seek",
                  reason: "buffer-stall",
                  notifications: {
                    seek: "KEKW Blocker: Syncing to live",
                    pause: "KEKW Blocker: Fixing buffering",
                    reload: "KEKW Blocker: Reloading stream"
                  }
                });
                playerBufferState.numSame = 0;
              }
            } else {
              playerBufferState.numSame = 0;
            }
            playerBufferState.position = position;
            playerBufferState.bufferedPosition = bufferedPosition;
            playerBufferState.bufferDuration = bufferDuration;
          } else {
            playerBufferState.numSame = 0;
          }
        }
      } catch (err) {
        playerForMonitoringBuffering = null;
        detachMediaEventListeners();
      }
    }
    if (!playerForMonitoringBuffering) {
      var ps = getPlayerAndState();
      if (ps && ps.player && ps.state) {
        playerForMonitoringBuffering = { player: ps.player, state: ps.state };
        var videoEl = ps.player.getHTMLVideoElement ? ps.player.getHTMLVideoElement() : null;
        attachMediaEventListeners(videoEl);
      }
    }
    setTimeout(monitorPlayerBuffering, BUFFERING_DELAY);
  }

  // --- Visibility spoofing + localStorage hooks + content loaded setup

  function onContentLoaded() {
    // Visibility spoofing — guarded by _visibilitySpoofingEnabled
    var realVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ||
                              Object.getOwnPropertyDescriptor(document, "visibilityState");
    var hidden = document.__lookupGetter__("hidden");

    try {
      Object.defineProperty(document, "visibilityState", {
        get: function () {
          if (!_visibilitySpoofingEnabled) return realVisibilityState ? realVisibilityState.get.call(this) : "visible";
          return "visible";
        }
      });
    } catch (e) {}
    try {
      Object.defineProperty(document, "hidden", {
        get: function () {
          if (!_visibilitySpoofingEnabled) return hidden ? hidden.apply(this) : false;
          return false;
        }
      });
    } catch (e) {}

    var blockEvent = function (e) {
      if (!_visibilitySpoofingEnabled) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    var wasVideoPlaying = true;
    var visibilityHandler = function (e) {
      if (!_visibilitySpoofingEnabled) return;
      var videos = document.getElementsByTagName("video");
      if (videos.length > 0) {
        if (hidden && hidden.apply(document) === true) {
          wasVideoPlaying = !videos[0].paused && !videos[0].ended;
        } else {
          if (!playerBufferState.hasStreamStarted) playerBufferState.hasStreamStarted = true;
          if (wasVideoPlaying && !videos[0].ended && videos[0].paused && videos[0].muted) {
            videos[0].play();
          }
        }
      }
      blockEvent(e);
    };
    document.addEventListener("visibilitychange", visibilityHandler, true);
    document.addEventListener("webkitvisibilitychange", visibilityHandler, true);
    document.addEventListener("hasFocus", blockEvent, true);

    // localStorage hooks — preserve volume/quality across player reloads
    try {
      var keysToCache = RECOVERY_STORAGE_KEYS.slice();
      var cachedValues = new Map();
      for (var i = 0; i < keysToCache.length; i++) {
        cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
      }
      _lsCachedValues = cachedValues;
      // Hook Storage.prototype: assigning localStorage.getItem does not
      // replace the method in Firefox, and stores a "getItem" item in Chromium.
      var storageProto = Object.getPrototypeOf(localStorage);
      var realSetItem = storageProto.setItem;
      var realGetItem = storageProto.getItem;
      storageProto.setItem = function (key, value) {
        if (this === localStorage && cachedValues.has(key)) cachedValues.set(key, value);
        return realSetItem.apply(this, arguments);
      };
      storageProto.getItem = function (key) {
        if (this === localStorage && cachedValues.has(key)) return cachedValues.get(key);
        return realGetItem.apply(this, arguments);
      };
      if (localStorage.getItem === realGetItem) {
        localStorageHookFailed = true;
      }
    } catch (err) {
      console.log("[TTV] localStorage hooks failed: " + err);
      localStorageHookFailed = true;
    }
  }

  // --- Init

  // Option flags — must be declared before onContentLoaded uses them
  var _bufferingFixEnabled = true;
  var _visibilitySpoofingEnabled = true;

  declareOptions(window);

  // Make all declareOptions globals non-enumerable so they don't appear in
  // Object.keys(window) or for...in loops. Prevents page scripts from
  // easily discovering extension internals or detecting the extension.
  ["AdSignifier", "ClientID", "BackupPlayerTypes", "FallbackPlayerType",
   "ForceAccessTokenPlayerType", "PlaybackAccessTokenHash", "ClientIDFallbacks",
   "PlaybackAccessTokenFallbackHashes", "RemotePlaybackAccessTokenQuery", "GqlUrl",
   "ReloadPlayerAfterAd", "PlayerReloadMinimalRequestsTime",
   "PlayerReloadMinimalRequestsPlayerIndex", "HasTriggeredPlayerReload",
   "StreamInfos", "StreamInfosByUrl", "GQLDeviceID", "ClientIntegrityHeader",
   "AuthorizationHeader", "ClientVersion", "ClientSession", "V2API",
   "IsAdStrippingEnabled", "AdSegmentCache", "AllSegmentsAreAdSegments",
   "HashFailedOnce", "StartupPlayerTypeRanking", "PlaybackAccessTokenQuery"].forEach(function (prop) {
    if (prop in window) {
      Object.defineProperty(window, prop, {
        value: window[prop], writable: true, enumerable: false, configurable: true
      });
    }
  });

  // Override defaults with config values (main thread only)
  if (_cfgHls.adSignifier) AdSignifier = _cfgHls.adSignifier;
  if (_cfgGql.clientId) ClientID = _cfgGql.clientId;
  if (_cfgPlayer.backupPlayerTypes) BackupPlayerTypes = _cfgPlayer.backupPlayerTypes.slice();
  if (_cfgPlayer.fallbackPlayerType) FallbackPlayerType = _cfgPlayer.fallbackPlayerType;
  if (_cfgPlayer.forceAccessTokenPlayerType) ForceAccessTokenPlayerType = _cfgPlayer.forceAccessTokenPlayerType;
  if (_cfgGql.playbackAccessTokenHash) PlaybackAccessTokenHash = _cfgGql.playbackAccessTokenHash;
  if (_cfgGql.url) GqlUrl = _cfgGql.url;
  if (_startupRemoteConfig.clientId) ClientID = _startupRemoteConfig.clientId;
  if (Array.isArray(_startupRemoteConfig.clientIdFallbacks)) ClientIDFallbacks = _startupRemoteConfig.clientIdFallbacks.slice();
  if (_startupRemoteConfig.playbackAccessTokenHash) PlaybackAccessTokenHash = _startupRemoteConfig.playbackAccessTokenHash;
  if (Array.isArray(_startupRemoteConfig.playbackAccessTokenHashFallbacks)) PlaybackAccessTokenFallbackHashes = _startupRemoteConfig.playbackAccessTokenHashFallbacks.slice();
  if (_startupRemoteConfig.playbackAccessTokenQuery) RemotePlaybackAccessTokenQuery = _startupRemoteConfig.playbackAccessTokenQuery;
  if (_startupRuntime.gqlDeviceId) GQLDeviceID = _startupRuntime.gqlDeviceId;
  if (_startupRuntime.clientIntegrityHeader) ClientIntegrityHeader = _startupRuntime.clientIntegrityHeader;
  if (_startupRuntime.authorizationHeader) AuthorizationHeader = _startupRuntime.authorizationHeader;
  if (_startupRuntime.clientVersion) ClientVersion = _startupRuntime.clientVersion;
  if (_startupRuntime.clientSession) ClientSession = _startupRuntime.clientSession;
  if (_startupOptions.forcePlayerType !== undefined) ForceAccessTokenPlayerType = _startupOptions.forcePlayerType || "";
  if (_startupOptions.reloadAfterAd !== undefined) ReloadPlayerAfterAd = !!_startupOptions.reloadAfterAd;
  if (_startupOptions.bufferingFix !== undefined) _bufferingFixEnabled = !!_startupOptions.bufferingFix;
  if (_startupOptions.visibilitySpoofing !== undefined) _visibilitySpoofingEnabled = !!_startupOptions.visibilitySpoofing;
  if (_startupOptions.showNotifications !== undefined) _showNotifications = !!_startupOptions.showNotifications;
  IsAdStrippingEnabled = _adBlockingEnabled;

  hookWindowWorker();
  hookFetch();
  monitorPlayerBuffering();

  if (document.readyState === "complete" || document.readyState === "interactive") {
    onContentLoaded();
  } else {
    window.addEventListener("DOMContentLoaded", function () { onContentLoaded(); });
  }

  // Listen for options from the content script
  window.addEventListener("ttv-" + _nonce + "-options", function (e) {
    if (!e.detail) return;
    var opts = e.detail;
    if (opts.forcePlayerType !== undefined) {
      ForceAccessTokenPlayerType = opts.forcePlayerType || "";
      postTwitchWorkerMessage("UpdateForceAccessTokenPlayerType", ForceAccessTokenPlayerType);
      console.log("[TTV] Option: ForceAccessTokenPlayerType = " + (ForceAccessTokenPlayerType || "(disabled)"));
    }
    if (opts.reloadAfterAd !== undefined) {
      ReloadPlayerAfterAd = !!opts.reloadAfterAd;
      console.log("[TTV] Option: ReloadPlayerAfterAd = " + ReloadPlayerAfterAd);
    }
    if (opts.bufferingFix !== undefined) {
      _bufferingFixEnabled = !!opts.bufferingFix;
      console.log("[TTV] Option: BufferingFix = " + _bufferingFixEnabled);
    }
    if (opts.visibilitySpoofing !== undefined) {
      _visibilitySpoofingEnabled = !!opts.visibilitySpoofing;
    }
    if (opts.showNotifications !== undefined) {
      _showNotifications = !!opts.showNotifications;
    }
  });

  // Listen for enable/disable toggle from content script
  window.addEventListener("ttv-" + _nonce + "-enabled", function (e) {
    if (!e.detail) return;
    var enabled = !!e.detail.enabled;
    _adBlockingEnabled = enabled;
    IsAdStrippingEnabled = enabled;
    console.log("[TTV] Ad blocking " + (enabled ? "enabled" : "disabled"));
    // Propagate to all workers
    for (var i = 0; i < twitchWorkers.length; i++) {
      twitchWorkers[i].postMessage({ key: "SetAdStrippingEnabled", value: enabled });
    }
  });

  // Listen for remote config updates (new hashes, client IDs, etc.)
  window.addEventListener("ttv-" + _nonce + "-config", function (e) {
    if (!e.detail) return;
    applyRemoteConfigUpdate(e.detail);
  });

  console.log("[TTV] KEKW Blocker active");
})();
