#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const https = require("https");
const {
  applyCandidates,
  canonicalizeForSignature,
  createValueRecord,
  normalizeV2Config,
  signConfig,
  validateHash,
  verifyConfig
} = require("./remote-config-v2");

// Replaces https.request with scripted answers: a number is an HTTP status
// with an empty GraphQL success body, "error" is a network error.
function stubGql(answers) {
  const realRequest = https.request;
  const calls = [];
  https.request = (options, onResponse) => {
    const answer = answers[calls.length];
    calls.push(options);
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      if (answer === "error") {
        req.emit("error", new Error("socket hang up"));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = answer;
      onResponse(res);
      res.emit("data", Buffer.from(JSON.stringify(answer === 200 ? { data: {} } : { errors: [{ message: "nope" }] })));
      res.emit("end");
    });
    return req;
  };
  return { calls: calls, restore: () => { https.request = realRequest; } };
}

async function testProbeRetries() {
  const hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const clientId = "kimne78kx3ncx6brgo4mv6wki5h1ko";
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const transient = stubGql(["error", 200]);
    assert.equal(await validateHash(hash, clientId), true, "a network error is retried");
    assert.equal(transient.calls.length, 2);
    transient.restore();

    const rejected = stubGql([400, 200]);
    assert.equal(await validateHash(hash, clientId), false, "a 4xx is not retried");
    assert.equal(rejected.calls.length, 1);
    rejected.restore();
  } finally {
    console.warn = realWarn;
  }
}

function testQueryWhitespace(stableConfig, bundledQuery) {
  const trailingNewline = Object.assign({}, stableConfig, {
    gql: Object.assign({}, stableConfig.gql, {
      playbackAccessToken: Object.assign({}, stableConfig.gql.playbackAccessToken, {
        query: { active: Object.assign({}, stableConfig.gql.playbackAccessToken.query.active, { value: bundledQuery + "\n" }) }
      })
    })
  });
  const sameQueryWithoutNewline = applyCandidates(trailingNewline, {
    playbackAccessTokenQuery: createValueRecord(bundledQuery, "ai", "medium")
  }, bundledQuery);
  assert.equal(sameQueryWithoutNewline.changed, false, "a trailing newline is not a change");

  const sameQueryWithNewline = applyCandidates(stableConfig, {
    playbackAccessTokenQuery: createValueRecord(bundledQuery + "\n", "ast", "high")
  }, bundledQuery);
  assert.equal(sameQueryWithNewline.changed, false, "a trailing newline is not a change");

  const newQuery = bundledQuery.replace("__typename } }", "__typename authorization { isForbidden } } }");
  const changedQuery = applyCandidates(trailingNewline, {
    playbackAccessTokenQuery: createValueRecord(newQuery + "\n", "ast", "high")
  }, bundledQuery);
  assert.equal(changedQuery.changed, true);
  assert.equal(changedQuery.config.gql.playbackAccessToken.query.active.value, newQuery, "queries are stored trimmed");
}

async function main() {
  const bundledQuery = 'query PlaybackAccessToken($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }';
  const legacyConfig = {
    _version: 3,
    _lastChecked: "2026-03-16T04:16:57.440Z",
    playbackAccessTokenHash: "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9",
    clientId: "b31o4btkqth5bzbvr9ub2ovr79umhh",
    _lastUpdateSource: "regex-extraction"
  };

  const normalized = normalizeV2Config(legacyConfig, bundledQuery);
  assert.equal(normalized._schema, 2);
  assert.equal(normalized.gql.clientId.active.value, legacyConfig.clientId);
  assert.equal(normalized.gql.playbackAccessToken.hash.active.value, legacyConfig.playbackAccessTokenHash);
  assert.equal(normalized.gql.playbackAccessToken.query.active.value, bundledQuery);

  const stableConfig = {
    _schema: 2,
    _version: 6,
    _generatedAt: "2026-03-19T03:55:24.464Z",
    gql: {
      clientId: {
        active: {
          value: legacyConfig.clientId,
          validatedAt: "2026-03-19T03:55:24.318Z",
          source: "regex",
          confidence: "high"
        },
        fallbacks: []
      },
      playbackAccessToken: {
        hash: {
          active: {
            value: legacyConfig.playbackAccessTokenHash,
            validatedAt: "2026-03-16T04:16:57.440Z",
            source: "regex",
            confidence: "high"
          },
          fallbacks: []
        },
        query: {
          active: {
            value: bundledQuery,
            validatedAt: "2026-03-19T03:55:24.464Z",
            source: "ast",
            confidence: "high"
          }
        }
      }
    }
  };
  const metadataOnly = applyCandidates(stableConfig, {
    clientId: createValueRecord(legacyConfig.clientId, "regex", "high", "2026-03-20T00:00:00.000Z"),
    playbackAccessTokenHash: createValueRecord(legacyConfig.playbackAccessTokenHash, "regex", "high", "2026-03-20T00:00:00.000Z"),
    playbackAccessTokenQuery: createValueRecord(bundledQuery, "ast", "high", "2026-03-20T00:00:00.000Z")
  }, bundledQuery);
  assert.equal(metadataOnly.changed, false);
  assert.deepEqual(metadataOnly.config, stableConfig);

  const applied = applyCandidates(legacyConfig, {
    clientId: createValueRecord("kimne78kx3ncx6brgo4mv6wki5h1ko", "ai", "medium", "2026-03-18T00:00:00.000Z"),
    playbackAccessTokenHash: createValueRecord("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "ai", "medium", "2026-03-18T00:00:00.000Z"),
    playbackAccessTokenQuery: createValueRecord(bundledQuery + " ", "ai", "medium", "2026-03-18T00:00:00.000Z")
  }, bundledQuery);
  assert.equal(applied.changed, true);
  assert.equal(applied.config.gql.clientId.active.value, "kimne78kx3ncx6brgo4mv6wki5h1ko");
  assert.equal(applied.config.gql.clientId.fallbacks[0].value, legacyConfig.clientId);
  assert.equal(applied.config.gql.playbackAccessToken.hash.fallbacks[0].value, legacyConfig.playbackAccessTokenHash);

  const keys = crypto.generateKeyPairSync("ed25519");
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
  const signed = signConfig(applied.config, privatePem, "k-test");

  assert.ok(verifyConfig(signed, { "k-test": publicPem }));
  assert.equal(verifyConfig(signed, { other: publicPem }), false);
  assert.equal(canonicalizeForSignature(signed).indexOf("\"signature\""), -1);

  testQueryWhitespace(stableConfig, bundledQuery);
  await testProbeRetries();

  console.log("remote-config-v2 tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
