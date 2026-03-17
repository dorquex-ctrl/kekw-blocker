// KEKW Blocker — VAFT-based Worker hook with backup player switching,
// pre-warmed streams, buffering auto-fix, and visibility spoofing.
(function () {
  "use strict";
  if (!/(^|\.)twitch\.tv$/.test(document.location.hostname)) return;

  var _cfg = window.__TTV_CONFIG || {};
  var _nonce = window.__TTV_NONCE || "";
  try { delete window.__TTV_CONFIG; } catch (e) {}
  try { delete window.__TTV_NONCE; } catch (e) {}
  var _cfgGql = _cfg.gql || {};
  var _cfgHls = _cfg.hls || {};
  var _cfgPlayer = _cfg.player || {};
  var _cfgReact = _cfg.react || {};

  // Main-thread ad state — used to restore quality after backup stream ads
  var _isBlockingAds = false;
  var _preAdQuality = null;
  var _lsCachedValues = null;

  // --- Options (shared between main thread and worker via toString injection)

  // declareOptions is stringified into the Worker blob, so it CANNOT reference
  // closure variables like _cfg*. It uses bare defaults. The actual config values
  // are injected into the worker blob via string interpolation (see hookWindowWorker).
  function declareOptions(scope) {
    scope.AdSignifier = "stitched";
    scope.ClientID = "b31o4btkqth5bzbvr9ub2ovr79umhh";
    scope.BackupPlayerTypes = ["embed", "site", "popout", "autoplay"];
    scope.FallbackPlayerType = "embed";
    scope.ForceAccessTokenPlayerType = "popout";
    scope.PlaybackAccessTokenHash = "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9";
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
        var newBlobStr = "\
          var pendingFetchRequests = new Map();\
          " + stripAdSegments.toString() + "\
          " + getStreamUrlForResolution.toString() + "\
          " + processM3U8.toString() + "\
          " + hookWorkerFetch.toString() + "\
          " + declareOptions.toString() + "\
          " + getAccessToken.toString() + "\
          " + gqlRequest.toString() + "\
          " + parseAttributes.toString() + "\
          " + getWasmWorkerJs.toString() + "\
          " + getServerTimeFromM3u8.toString() + "\
          " + replaceServerTimeInM3u8.toString() + "\
          var workerString = getWasmWorkerJs(" + JSON.stringify(twitchBlobUrl) + ");\
          declareOptions(self);\
          AdSignifier = " + JSON.stringify(_cfgHls.adSignifier || "stitched") + ";\
          ClientID = " + JSON.stringify(_cfgGql.clientId || "b31o4btkqth5bzbvr9ub2ovr79umhh") + ";\
          BackupPlayerTypes = " + JSON.stringify(_cfgPlayer.backupPlayerTypes || ["embed","site","popout","autoplay"]) + ";\
          FallbackPlayerType = " + JSON.stringify(_cfgPlayer.fallbackPlayerType || "embed") + ";\
          ForceAccessTokenPlayerType = " + JSON.stringify(_cfgPlayer.forceAccessTokenPlayerType || "popout") + ";\
          PlaybackAccessTokenHash = " + JSON.stringify(_cfgGql.playbackAccessTokenHash || "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9") + ";\
          GqlUrl = " + JSON.stringify(_cfgGql.url || "https://gql.twitch.tv/gql") + ";\
          GQLDeviceID = " + JSON.stringify(GQLDeviceID || null) + ";\
          AuthorizationHeader = " + JSON.stringify(AuthorizationHeader || null) + ";\
          ClientIntegrityHeader = " + JSON.stringify(ClientIntegrityHeader || null) + ";\
          ClientVersion = " + JSON.stringify(ClientVersion || null) + ";\
          ClientSession = " + JSON.stringify(ClientSession || null) + ";\
          self.addEventListener('message', function(e) {\
            if (e.data.key == 'UpdateClientVersion') ClientVersion = e.data.value;\
            else if (e.data.key == 'UpdateClientSession') ClientSession = e.data.value;\
            else if (e.data.key == 'UpdateClientId') ClientID = e.data.value;\
            else if (e.data.key == 'UpdateDeviceId') GQLDeviceID = e.data.value;\
            else if (e.data.key == 'UpdateClientIntegrityHeader') ClientIntegrityHeader = e.data.value;\
            else if (e.data.key == 'UpdateAuthorizationHeader') AuthorizationHeader = e.data.value;\
            else if (e.data.key == 'UpdatePlaybackAccessTokenHash') { PlaybackAccessTokenHash = e.data.value; HashFailedOnce = false; }\
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
              if (si && !si.IsShowingAd) {\
                si.BackupEncodingsM3U8Cache[e.data.playerType] = e.data.encodingsM3u8;\
              }\
            }\
          });\
          hookWorkerFetch();\
          eval(workerString);\
        ";
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
              var currentPath = window.location.pathname.split("/")[1];
              if (currentPath && currentPath.toLowerCase() !== e.data.channelName.toLowerCase()) return;
            }
            if (e.data.key == "PauseResumePlayer") doTwitchPlayerTask(true, false);
            else doTwitchPlayerTask(false, true);
          }
          else if (e.data.key == "StreamInitialized") {
            _isBlockingAds = false;
            _preAdQuality = null;
            preWarmBackupStreams(e.data.channelName, e.data.usherParams, e.data.v2api, workerRef);
          }
          else if (e.data.key == "UpdateAdBlockBanner") {
            if (e.data.hasAds && !_isBlockingAds) {
              // Save pre-ad quality so backup stream transcode tiers don't persist
              if (_lsCachedValues) _preAdQuality = _lsCachedValues.get("video-quality");
            }
            if (e.data.hasAds) {
              showTtvNotification("KEKW Blocker: Blocking ads — stream quality may be temporarily reduced");
            } else if (!e.data.hasAds && _isBlockingAds) {
              // Restore pre-ad quality
              if (_preAdQuality && _lsCachedValues) {
                _lsCachedValues.set("video-quality", _preAdQuality);
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
    Object.defineProperty(window, "Worker", {
      get: function () { return newWorker; },
      set: function (value) { newWorker = value; }
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
          return new Promise(function (resolve, reject) {
            var processAfter = async function (response) {
              if (response.status === 200) {
                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
              } else {
                resolve(response);
              }
            };
            realFetch(url, options).then(function (response) {
              processAfter(response);
            })["catch"](function (err) { reject(err); });
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
          return new Promise(function (resolve, reject) {
            var processAfter = async function (response) {
              if (response.status == 200) {
                var encodingsM3u8 = await response.text();
                var serverTime = getServerTimeFromM3u8(encodingsM3u8);
                var streamInfo = StreamInfos[channelName];
                if (streamInfo != null && streamInfo.EncodingsM3U8 != null && (await realFetch(streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m)[0])).status !== 200) {
                  streamInfo = null;
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
                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
              } else {
                resolve(response);
              }
            };
            realFetch(url, options).then(function (response) {
              processAfter(response);
            })["catch"](function (err) { reject(err); });
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

    var haveAdTags = textStr.includes(AdSignifier);
    if (haveAdTags) {
      streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
      if (!streamInfo.IsShowingAd) {
        streamInfo.IsShowingAd = true;
        postMessage({ key: "UpdateAdBlockBanner", isMidroll: streamInfo.IsMidroll, hasAds: true, isStrippingAdSegments: false });
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
      var backupPlayerType = null;
      var backupM3u8 = null;
      var fallbackM3u8 = null;
      var startIndex = 0;
      var isDoingMinimalRequests = false;
      if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
        startIndex = PlayerReloadMinimalRequestsPlayerIndex;
        isDoingMinimalRequests = true;
      }

      for (var playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < BackupPlayerTypes.length; playerTypeIndex++) {
        var playerType = BackupPlayerTypes[playerTypeIndex];
        var realPlayerType = playerType.replace("-CACHED", "");
        for (var attempt = 0; attempt < 2; attempt++) {
          var isFreshM3u8 = false;
          var encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
          if (!encodingsM3u8) {
            isFreshM3u8 = true;
            try {
              var accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
              if (accessTokenResponse.status === 200) {
                var accessToken = await accessTokenResponse.json();
                var urlInfo = new URL("https://usher.ttvnw.net/api/" + (V2API ? "v2/" : "") + "channel/hls/" + streamInfo.ChannelName + ".m3u8" + streamInfo.UsherParams);
                urlInfo.searchParams.set("sig", accessToken.data.streamPlaybackAccessToken.signature);
                urlInfo.searchParams.set("token", accessToken.data.streamPlaybackAccessToken.value);
                var encodingsM3u8Response = await realFetch(urlInfo.href);
                if (encodingsM3u8Response.status === 200) {
                  encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                }
              }
            } catch (err) {}
          }
          if (encodingsM3u8) {
            try {
              var streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
              var streamM3u8Response = await realFetch(streamM3u8Url);
              if (streamM3u8Response.status == 200) {
                var m3u8Text = await streamM3u8Response.text();
                if (m3u8Text) {
                  if (playerType == FallbackPlayerType) fallbackM3u8 = m3u8Text;
                  if (!m3u8Text.includes(AdSignifier) || (!fallbackM3u8 && playerTypeIndex >= BackupPlayerTypes.length - 1)) {
                    backupPlayerType = playerType;
                    backupM3u8 = m3u8Text;
                    break;
                  }
                }
              }
            } catch (err) {}
          }
          streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
          if (isFreshM3u8) break;
        }
      }

      if (!backupM3u8 && fallbackM3u8) {
        backupPlayerType = FallbackPlayerType;
        backupM3u8 = fallbackM3u8;
      }

      if (backupM3u8) {
        textStr = backupM3u8;
        if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
          streamInfo.ActiveBackupPlayerType = backupPlayerType;
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
      streamInfo.RequestedAds.clear();
      if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd) {
        streamInfo.IsUsingModifiedM3U8 = false;
        streamInfo.LastPlayerReload = Date.now();
        postMessage({ key: "ReloadPlayer", channelName: streamInfo.ChannelName });
      } else {
        postMessage({ key: "PauseResumePlayer", channelName: streamInfo.ChannelName });
      }
    }

    postMessage({
      key: "UpdateAdBlockBanner",
      isMidroll: streamInfo.IsMidroll,
      hasAds: streamInfo.IsShowingAd,
      isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
      numStrippedAdSegments: streamInfo.NumStrippedAdSegments
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

  // getAccessToken is toString'd into the Worker blob, so all variables it
  // references must be Worker globals. PlaybackAccessTokenQuery and
  // HashFailedOnce are declared in declareOptions() for this reason.
  function getAccessToken(channelName, playerType) {
    var variables = {
      isLive: true, login: channelName, isVod: false, vodID: "",
      playerType: playerType,
      platform: playerType == "autoplay" ? "android" : "web"
    };

    // If the hash has failed before, use full query text instead
    if (HashFailedOnce) {
      return gqlRequest({
        operationName: "PlaybackAccessToken",
        query: PlaybackAccessTokenQuery,
        variables: variables
      }, playerType);
    }

    var body = {
      operationName: "PlaybackAccessToken",
      variables: variables,
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: PlaybackAccessTokenHash
        }
      }
    };
    return gqlRequest(body, playerType).then(function (response) {
      // If the hash is stale, Twitch returns a 200 with PersistedQueryNotFound error.
      // We only need to inspect the body for this specific error — avoid the overhead
      // of cloning and re-parsing on every successful request.
      if (response && response.status === 200) {
        return response.text().then(function (text) {
          try {
            var data = JSON.parse(text);
            if (data.errors && data.errors.some(function (e) { return e.message === "PersistedQueryNotFound"; })) {
              console.log("[TTV Worker] Hash stale — falling back to full query text");
              HashFailedOnce = true;
              return gqlRequest({
                operationName: "PlaybackAccessToken",
                query: PlaybackAccessTokenQuery,
                variables: variables
              }, playerType);
            }
          } catch (e) {}
          // Reconstruct Response since we consumed the body via .text()
          return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
        });
      }
      return response;
    });
  }

  function gqlRequest(body, playerType) {
    if (!GQLDeviceID) {
      GQLDeviceID = "";
      var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      for (var i = 0; i < 32; i++) GQLDeviceID += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    var headers = {
      "Client-ID": ClientID,
      "X-Device-Id": GQLDeviceID,
      "Authorization": AuthorizationHeader
    };
    if (ClientIntegrityHeader) headers["Client-Integrity"] = ClientIntegrityHeader;
    if (ClientVersion) headers["Client-Version"] = ClientVersion;
    if (ClientSession) headers["Client-Session-Id"] = ClientSession;

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
        value: {
          id: requestId,
          url: GqlUrl,
          options: { method: "POST", body: JSON.stringify(body), headers: headers }
        }
      });
    });
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
  // Proactively fetches access tokens + master playlists for all backup player
  // types so that when ads hit, processM3U8 finds cached entries and only needs
  // one media playlist fetch instead of 3 serial requests.

  var _preWarmTimers = Object.create(null);
  var _PRE_WARM_REFRESH_MS = 4 * 60 * 1000;

  function preWarmBackupStreams(channelName, usherParams, v2api, workerRef) {
    if (!channelName || !usherParams) return;

    // Clear any existing timers (including old channels)
    for (var key in _preWarmTimers) {
      if (key !== channelName) {
        clearTimeout(_preWarmTimers[key].initial);
        clearInterval(_preWarmTimers[key].interval);
        delete _preWarmTimers[key];
      }
    }
    if (_preWarmTimers[channelName]) {
      clearTimeout(_preWarmTimers[channelName].initial);
      clearInterval(_preWarmTimers[channelName].interval);
    }

    var fetchFn = _realFetch || window.fetch;

    function makeGqlRequest(playerType) {
      var variables = {
        isLive: true, login: channelName, isVod: false, vodID: "",
        playerType: playerType,
        platform: playerType === "autoplay" ? "android" : "web"
      };
      var body = {
        operationName: "PlaybackAccessToken",
        variables: variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: PlaybackAccessTokenHash } }
      };
      var headers = { "Client-ID": ClientID, "Content-Type": "application/json" };
      if (GQLDeviceID) headers["X-Device-Id"] = GQLDeviceID;
      if (AuthorizationHeader) headers["Authorization"] = AuthorizationHeader;
      if (ClientIntegrityHeader) headers["Client-Integrity"] = ClientIntegrityHeader;

      return fetchFn("https://gql.twitch.tv/gql", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
      });
    }

    function doPreWarm() {
      // Stop if the worker was terminated or replaced
      if (twitchWorkers.indexOf(workerRef) === -1) {
        if (_preWarmTimers[channelName]) {
          clearTimeout(_preWarmTimers[channelName].initial);
          clearInterval(_preWarmTimers[channelName].interval);
        }
        delete _preWarmTimers[channelName];
        return;
      }
      for (var i = 0; i < BackupPlayerTypes.length; i++) {
        (function (playerType) {
          var realPlayerType = playerType.replace("-CACHED", "");
          makeGqlRequest(realPlayerType).then(function (response) {
            if (response.status !== 200) return;
            return response.json().then(function (accessToken) {
              if (!accessToken.data || !accessToken.data.streamPlaybackAccessToken) return;
              var urlInfo = new URL("https://usher.ttvnw.net/api/" + (v2api ? "v2/" : "") + "channel/hls/" + channelName + ".m3u8" + usherParams);
              urlInfo.searchParams.set("sig", accessToken.data.streamPlaybackAccessToken.signature);
              urlInfo.searchParams.set("token", accessToken.data.streamPlaybackAccessToken.value);
              return fetchFn(urlInfo.href).then(function (m3u8Response) {
                if (m3u8Response.status === 200) {
                  return m3u8Response.text().then(function (text) {
                    // Send cached master playlist to Worker
                    workerRef.postMessage({
                      key: "PreWarmCache",
                      channelName: channelName,
                      playerType: playerType,
                      encodingsM3u8: text
                    });
                  });
                }
              });
            });
          })["catch"](function () {});
        })(BackupPlayerTypes[i]);
      }
    }

    var initialId = setTimeout(doPreWarm, 3000 + Math.random() * 2000);
    var jitter = Math.floor(Math.random() * 60000);
    var intervalId = setInterval(doPreWarm, _PRE_WARM_REFRESH_MS + jitter);
    _preWarmTimers[channelName] = { initial: initialId, interval: intervalId };
  }

  // --- Main thread: hook fetch for auth capture + playerType forcing

  var _realFetch = null;

  function hookFetch() {
    var realFetch = window.fetch;
    _realFetch = realFetch;
    window.fetch = function (url, init) {
      // Fast path: skip all processing for non-GQL requests
      if (typeof url !== "string" || !url.includes("gql") || !init || !init.headers) {
        return realFetch.apply(this, arguments);
      }
      {
          var h = init.headers;
          var deviceId = h["X-Device-Id"] || h["Device-ID"];
          if (typeof deviceId === "string" && GQLDeviceID != deviceId) {
            GQLDeviceID = deviceId;
            postTwitchWorkerMessage("UpdateDeviceId", GQLDeviceID);
          }
          if (typeof h["Client-Version"] === "string" && h["Client-Version"] !== ClientVersion) {
            postTwitchWorkerMessage("UpdateClientVersion", ClientVersion = h["Client-Version"]);
          }
          if (typeof h["Client-Session-Id"] === "string" && h["Client-Session-Id"] !== ClientSession) {
            postTwitchWorkerMessage("UpdateClientSession", ClientSession = h["Client-Session-Id"]);
          }
          if (typeof h["Client-Integrity"] === "string" && h["Client-Integrity"] !== ClientIntegrityHeader) {
            postTwitchWorkerMessage("UpdateClientIntegrityHeader", ClientIntegrityHeader = h["Client-Integrity"]);
          }
          if (typeof h["Authorization"] === "string" && h["Authorization"] !== AuthorizationHeader) {
            postTwitchWorkerMessage("UpdateAuthorizationHeader", AuthorizationHeader = h["Authorization"]);
          }
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
                    PlaybackAccessTokenHash = observedHash;
                    postTwitchWorkerMessage("UpdatePlaybackAccessTokenHash", observedHash);
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
  window.addEventListener("ttv-" + _nonce + "-reload", function () { doTwitchPlayerTask(false, true); });

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

  function doTwitchPlayerTask(isPausePlay, isReload) {
    var ps = getPlayerAndState();
    if (!ps || !ps.player || !ps.state) return;
    if (ps.player.isPaused() || (ps.player.core && ps.player.core.paused)) return;
    playerBufferState.lastFixTime = Date.now();
    playerBufferState.numSame = 0;
    if (isPausePlay) {
      ps.player.pause();
      // Delay + no-op seek to force audio/video decoders to resync.
      // Synchronous pause/play on demuxed HLS can leave tracks at different positions.
      var video = ps.player.getHTMLVideoElement ? ps.player.getHTMLVideoElement() : null;
      setTimeout(function () {
        if (video) video.currentTime = video.currentTime;
        ps.player.play();
      }, 100);
      return;
    }
    if (isReload) {
      var lsKeyQuality = "video-quality";
      var lsKeyMuted = "video-muted";
      var lsKeyVolume = "volume";
      var currentQualityLS = null, currentMutedLS = null, currentVolumeLS = null;
      try {
        currentQualityLS = localStorage.getItem(lsKeyQuality);
        currentMutedLS = localStorage.getItem(lsKeyMuted);
        currentVolumeLS = localStorage.getItem(lsKeyVolume);
        if (localStorageHookFailed && ps.player.core && ps.player.core.state) {
          localStorage.setItem(lsKeyMuted, JSON.stringify({ default: ps.player.core.state.muted }));
          localStorage.setItem(lsKeyVolume, ps.player.core.state.volume);
        }
        if (localStorageHookFailed && ps.player.core && ps.player.core.state && ps.player.core.state.quality && ps.player.core.state.quality.group) {
          localStorage.setItem(lsKeyQuality, JSON.stringify({ default: ps.player.core.state.quality.group }));
        }
      } catch (e) {}
      console.log("[TTV] Reloading Twitch player");
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
      } catch (e) {
        console.warn("[TTV] Player reload failed:", e.message);
      }
      // Restore localStorage values after reload
      if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
        setTimeout(function () {
          try {
            if (currentQualityLS) localStorage.setItem(lsKeyQuality, currentQualityLS);
            if (currentMutedLS) localStorage.setItem(lsKeyMuted, currentMutedLS);
            if (currentVolumeLS) localStorage.setItem(lsKeyVolume, currentVolumeLS);
          } catch (e) {}
        }, 3000);
      }
    }
  }

  function postTwitchWorkerMessage(key, value) {
    twitchWorkers.forEach(function (worker) {
      worker.postMessage({ key: key, value: value });
    });
  }

  // --- User notification banner

  var _notifTimeout = null;

  function showTtvNotification(message) {
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
    lastSeekToLiveTime: 0,
    loopReloadCount: 0
  };
  var BUFFERING_DELAY = 600;
  var BUFFERING_SAME_STATE_COUNT = 3;
  var BUFFERING_DANGER_ZONE = 1;
  var BUFFERING_MIN_REPEAT_DELAY = 8000;
  var LOOP_BACKWARD_THRESHOLD = 5;    // 5 backward jumps in window = looping
  var LOOP_SEEK_COOLDOWN = 15000;     // 15s between seek-to-live attempts
  var LOOP_RELOAD_COOLDOWN = 30000;   // 30s between full reload attempts

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
                showTtvNotification("KEKW Blocker: Fixing buffering");
                doTwitchPlayerTask(true, false);
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
      }
    }
    if (!playerForMonitoringBuffering) {
      var ps = getPlayerAndState();
      if (ps && ps.player && ps.state) {
        playerForMonitoringBuffering = { player: ps.player, state: ps.state };
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
      var keysToCache = ["video-quality", "video-muted", "volume", "lowLatencyModeEnabled", "persistenceEnabled"];
      var cachedValues = new Map();
      for (var i = 0; i < keysToCache.length; i++) {
        cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
      }
      _lsCachedValues = cachedValues;
      var realSetItem = localStorage.setItem;
      localStorage.setItem = function (key, value) {
        if (cachedValues.has(key)) cachedValues.set(key, value);
        realSetItem.apply(this, arguments);
      };
      var realGetItem = localStorage.getItem;
      localStorage.getItem = function (key) {
        if (cachedValues.has(key)) return cachedValues.get(key);
        return realGetItem.apply(this, arguments);
      };
      localStorage.getItem._ttvHooked = true;
      if (!localStorage.getItem._ttvHooked) {
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
   "ForceAccessTokenPlayerType", "PlaybackAccessTokenHash", "GqlUrl",
   "ReloadPlayerAfterAd", "PlayerReloadMinimalRequestsTime",
   "PlayerReloadMinimalRequestsPlayerIndex", "HasTriggeredPlayerReload",
   "StreamInfos", "StreamInfosByUrl", "GQLDeviceID", "ClientIntegrityHeader",
   "AuthorizationHeader", "ClientVersion", "ClientSession", "V2API",
   "IsAdStrippingEnabled", "AdSegmentCache", "AllSegmentsAreAdSegments",
   "HashFailedOnce", "PlaybackAccessTokenQuery"].forEach(function (prop) {
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
      console.log("[TTV] Option: VisibilitySpoofing = " + _visibilitySpoofingEnabled);
    }
  });

  // Listen for enable/disable toggle from content script
  window.addEventListener("ttv-" + _nonce + "-enabled", function (e) {
    if (!e.detail) return;
    var enabled = !!e.detail.enabled;
    console.log("[TTV] Ad blocking " + (enabled ? "enabled" : "disabled"));
    // Propagate to all workers
    for (var i = 0; i < twitchWorkers.length; i++) {
      twitchWorkers[i].postMessage({ key: "SetAdStrippingEnabled", value: enabled });
    }
  });

  // Listen for remote config updates (new hashes, client IDs, etc.)
  window.addEventListener("ttv-" + _nonce + "-config", function (e) {
    if (!e.detail) return;
    var cfg = e.detail;
    if (cfg.playbackAccessTokenHash && cfg.playbackAccessTokenHash !== PlaybackAccessTokenHash) {
      console.log("[TTV] Remote config: Updated PlaybackAccessToken hash");
      PlaybackAccessTokenHash = cfg.playbackAccessTokenHash;
      // Worker resets its own HashFailedOnce when it receives UpdatePlaybackAccessTokenHash
      for (var i = 0; i < twitchWorkers.length; i++) {
        twitchWorkers[i].postMessage({ key: "UpdatePlaybackAccessTokenHash", value: cfg.playbackAccessTokenHash });
      }
    }
    if (cfg.clientId && cfg.clientId !== ClientID) {
      console.log("[TTV] Remote config: Updated Client-ID");
      ClientID = cfg.clientId;
      for (var i = 0; i < twitchWorkers.length; i++) {
        twitchWorkers[i].postMessage({ key: "UpdateClientId", value: cfg.clientId });
      }
    }
  });

  console.log("[TTV] KEKW Blocker v1.0 active");
})();
