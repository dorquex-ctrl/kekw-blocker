"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PAGE_INJECT_PATH = path.join(ROOT, "src", "content", "page-inject.js");
const GQL_URL = "https://gql.twitch.tv/gql";

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const pairs = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof value[key] === "undefined") continue;
    pairs.push(JSON.stringify(key) + ":" + stableStringify(value[key]));
  }
  return "{" + pairs.join(",") + "}";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripSignature(config) {
  const unsigned = cloneJson(config || {});
  delete unsigned.signature;
  return unsigned;
}

function canonicalizeForSignature(config) {
  return stableStringify(stripSignature(config));
}

function isValidHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isValidClientId(value) {
  return typeof value === "string" && /^[a-z0-9]{30,32}$/i.test(value);
}

function isValidQuery(value) {
  return typeof value === "string" &&
    value.length >= 64 &&
    value.length <= 16000 &&
    value.includes("PlaybackAccessToken") &&
    value.includes("streamPlaybackAccessToken");
}

function createValueRecord(value, source, confidence, validatedAt) {
  return {
    value: value,
    validatedAt: validatedAt || new Date().toISOString(),
    source: source || "regex",
    confidence: confidence || "high"
  };
}

function normalizeValueRecord(record, validator) {
  if (!record || typeof record !== "object" || !validator(record.value)) return null;
  return {
    value: record.value,
    validatedAt: typeof record.validatedAt === "string" ? record.validatedAt : new Date().toISOString(),
    source: typeof record.source === "string" ? record.source : "legacy",
    confidence: record.confidence === "medium" ? "medium" : "high"
  };
}

function normalizeEntry(entry, validator, maxFallbacks) {
  const active = normalizeValueRecord(entry && entry.active, validator);
  const seen = Object.create(null);
  if (active) seen[active.value] = true;
  const fallbacks = [];
  const rawFallbacks = entry && Array.isArray(entry.fallbacks) ? entry.fallbacks : [];
  for (let i = 0; i < rawFallbacks.length && fallbacks.length < maxFallbacks; i++) {
    const record = normalizeValueRecord(rawFallbacks[i], validator);
    if (!record || seen[record.value]) continue;
    seen[record.value] = true;
    fallbacks.push(record);
  }
  return {
    active: active,
    fallbacks: fallbacks
  };
}

function mapLegacySource(source) {
  if (typeof source !== "string") return "legacy";
  if (source.indexOf("ai") !== -1) return "ai";
  if (source.indexOf("ast") !== -1) return "ast";
  return "regex";
}

function getBundledPlaybackAccessTokenQuery() {
  const source = fs.readFileSync(PAGE_INJECT_PATH, "utf8");
  const match = source.match(/scope\.PlaybackAccessTokenQuery\s*=\s*('(?:\\.|[^'])*'|"(?:\\.|[^"])*")\s*;/);
  if (!match) {
    throw new Error("Unable to locate bundled PlaybackAccessTokenQuery");
  }
  return Function("\"use strict\"; return (" + match[1] + ");")();
}

function normalizeV2Config(config, bundledQuery) {
  const queryValue = isValidQuery(bundledQuery) ? bundledQuery : "";
  if (config && config._schema === 2) {
    return {
      _schema: 2,
      _version: typeof config._version === "number" && config._version > 0 ? config._version : 1,
      _generatedAt: typeof config._generatedAt === "string" ? config._generatedAt : new Date().toISOString(),
      gql: {
        clientId: normalizeEntry(config.gql && config.gql.clientId, isValidClientId, 1),
        playbackAccessToken: {
          hash: normalizeEntry(config.gql && config.gql.playbackAccessToken && config.gql.playbackAccessToken.hash, isValidHash, 2),
          query: {
            active: normalizeValueRecord(config.gql && config.gql.playbackAccessToken && config.gql.playbackAccessToken.query && config.gql.playbackAccessToken.query.active, isValidQuery) ||
              (queryValue ? createValueRecord(queryValue, "ast", "high", new Date().toISOString()) : null)
          }
        }
      }
    };
  }

  const legacySource = mapLegacySource(config && config._lastUpdateSource);
  return {
    _schema: 2,
    _version: config && typeof config._version === "number" && config._version > 0 ? config._version : 1,
    _generatedAt: config && typeof config._lastChecked === "string" ? config._lastChecked : new Date().toISOString(),
    gql: {
      clientId: {
        active: isValidClientId(config && config.clientId) ? createValueRecord(config.clientId, legacySource, "high", typeof config._lastChecked === "string" ? config._lastChecked : new Date().toISOString()) : null,
        fallbacks: []
      },
      playbackAccessToken: {
        hash: {
          active: isValidHash(config && config.playbackAccessTokenHash) ? createValueRecord(config.playbackAccessTokenHash, legacySource, "high", typeof config._lastChecked === "string" ? config._lastChecked : new Date().toISOString()) : null,
          fallbacks: []
        },
        query: {
          active: queryValue ? createValueRecord(queryValue, "ast", "high", new Date().toISOString()) : null
        }
      }
    }
  };
}

function promoteEntry(entry, candidateRecord, maxFallbacks, validator) {
  const normalizedEntry = normalizeEntry(entry, validator, maxFallbacks);
  const candidate = normalizeValueRecord(candidateRecord, validator);
  if (!candidate) {
    return { entry: normalizedEntry, changed: false };
  }
  if (normalizedEntry.active && normalizedEntry.active.value === candidate.value) {
    return { entry: normalizedEntry, changed: false };
  }

  const nextFallbacks = [];
  const seen = Object.create(null);
  seen[candidate.value] = true;
  if (normalizedEntry.active && !seen[normalizedEntry.active.value]) {
    nextFallbacks.push(normalizedEntry.active);
    seen[normalizedEntry.active.value] = true;
  }
  for (let i = 0; i < normalizedEntry.fallbacks.length && nextFallbacks.length < maxFallbacks; i++) {
    const record = normalizedEntry.fallbacks[i];
    if (!record || seen[record.value]) continue;
    nextFallbacks.push(record);
    seen[record.value] = true;
  }

  normalizedEntry.active = candidate;
  normalizedEntry.fallbacks = nextFallbacks;
  return { entry: normalizedEntry, changed: true };
}

function applyCandidates(currentConfig, candidates, bundledQuery) {
  const migrated = !currentConfig || currentConfig._schema !== 2;
  const normalized = normalizeV2Config(currentConfig, bundledQuery);
  let changed = migrated;

  const nextConfig = cloneJson(normalized);

  const clientResult = promoteEntry(
    nextConfig.gql.clientId,
    candidates && candidates.clientId,
    1,
    isValidClientId
  );
  nextConfig.gql.clientId = clientResult.entry;
  changed = changed || clientResult.changed;

  const hashResult = promoteEntry(
    nextConfig.gql.playbackAccessToken.hash,
    candidates && candidates.playbackAccessTokenHash,
    2,
    isValidHash
  );
  nextConfig.gql.playbackAccessToken.hash = hashResult.entry;
  changed = changed || hashResult.changed;

  const normalizedQuery = normalizeValueRecord(candidates && candidates.playbackAccessTokenQuery, isValidQuery);
  if (normalizedQuery) {
    const currentQuery = nextConfig.gql.playbackAccessToken.query.active;
    if (!currentQuery || currentQuery.value !== normalizedQuery.value) {
      nextConfig.gql.playbackAccessToken.query.active = normalizedQuery;
      changed = true;
    }
  }

  if (changed) {
    nextConfig._version = (normalized._version || 0) + 1;
    nextConfig._generatedAt = new Date().toISOString();
  }

  return {
    config: nextConfig,
    changed: changed
  };
}

function pemToPublicKey(pem) {
  return crypto.createPublicKey(pem);
}

function signConfig(config, privateKeyPem, keyId) {
  if (!privateKeyPem) {
    throw new Error("Missing Ed25519 private key");
  }
  const unsigned = stripSignature(config);
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalizeForSignature(unsigned)),
    crypto.createPrivateKey(privateKeyPem)
  ).toString("base64");
  unsigned.signature = {
    alg: "ed25519",
    keyId: keyId || "k1",
    value: signature
  };
  return unsigned;
}

function verifyConfig(config, publicKeys) {
  if (!config || !config.signature || config.signature.alg !== "ed25519") return false;
  const keys = publicKeys || {};
  const keyId = config.signature.keyId;
  const pem = typeof keys === "string" ? keys : keys[keyId];
  if (!pem) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalizeForSignature(config)),
      pemToPublicKey(pem),
      Buffer.from(config.signature.value, "base64")
    );
  } catch {
    return false;
  }
}

function fetchText(url, maxRedirects) {
  const redirects = typeof maxRedirects === "number" ? maxRedirects : 5;
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("Too many redirects"));
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        resolve(fetchText(redirectUrl, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error("HTTP " + res.statusCode + " for " + url));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout: " + url));
    });
  });
}

function probeGql(body, clientId) {
  return new Promise((resolve) => {
    if (!clientId) {
      resolve({ ok: false, status: 0, body: null });
      return;
    }

    const req = https.request({
      hostname: "gql.twitch.tv",
      path: "/gql",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-ID": clientId
      },
      timeout: 10000
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: parsed
        });
      });
    });
    req.on("error", () => resolve({ ok: false, status: 0, body: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: null });
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function getGraphqlItems(body) {
  if (!body) return [];
  return Array.isArray(body) ? body : [body];
}

function hasAnyGraphqlErrors(body) {
  const items = getGraphqlItems(body);
  for (let i = 0; i < items.length; i++) {
    if (items[i] && Array.isArray(items[i].errors) && items[i].errors.length) return true;
  }
  return false;
}

function hasPersistedQueryNotFound(body) {
  const items = getGraphqlItems(body);
  for (let i = 0; i < items.length; i++) {
    const errors = items[i] && items[i].errors;
    if (!Array.isArray(errors)) continue;
    for (let j = 0; j < errors.length; j++) {
      const message = errors[j] && errors[j].message;
      if (typeof message === "string" && message.indexOf("PersistedQueryNotFound") !== -1) {
        return true;
      }
    }
  }
  return false;
}

async function validateHash(hash, clientId) {
  if (!isValidHash(hash) || !isValidClientId(clientId)) return false;
  const response = await probeGql({
    operationName: "PlaybackAccessToken",
    variables: {
      isLive: true,
      login: "twitch",
      isVod: false,
      vodID: "",
      playerType: "site",
      platform: "web"
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: hash
      }
    }
  }, clientId);
  if (!response.ok || !response.body) return false;
  if (hasPersistedQueryNotFound(response.body)) return false;
  return !hasAnyGraphqlErrors(response.body);
}

async function validateQuery(query, clientId) {
  if (!isValidQuery(query) || !isValidClientId(clientId)) return false;
  const response = await probeGql({
    operationName: "PlaybackAccessToken",
    query: query,
    variables: {
      isLive: true,
      login: "twitch",
      isVod: false,
      vodID: "",
      playerType: "site",
      platform: "web"
    }
  }, clientId);
  if (!response.ok || !response.body) return false;
  return !hasAnyGraphqlErrors(response.body);
}

async function validateClientId(clientId, hash, query) {
  if (!isValidClientId(clientId)) return false;
  if (isValidHash(hash) && await validateHash(hash, clientId)) {
    return true;
  }
  if (isValidQuery(query) && await validateQuery(query, clientId)) {
    return true;
  }
  return false;
}

module.exports = {
  GQL_URL,
  applyCandidates,
  canonicalizeForSignature,
  createValueRecord,
  fetchText,
  getBundledPlaybackAccessTokenQuery,
  isValidClientId,
  isValidHash,
  isValidQuery,
  normalizeV2Config,
  promoteEntry,
  signConfig,
  stableStringify,
  stripSignature,
  validateClientId,
  validateHash,
  validateQuery,
  verifyConfig
};
