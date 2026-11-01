#!/usr/bin/env node
"use strict";

// Loads src/background/remote-config.js as the browser would, with a stubbed
// chrome API, and feeds it configs signed by the CI code (remote-config-v2.js).
// This also checks that a Node signature verifies with WebCrypto.

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { signConfig } = require("./remote-config-v2");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "background", "remote-config.js"), "utf8");
const KEY_ID = "k-test";
const keys = crypto.generateKeyPairSync("ed25519");
const PRIVATE_PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const PUBLIC_PEM = keys.publicKey.export({ type: "spki", format: "pem" });

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const HASH_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH_B = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const QUERY = "query PlaybackAccessToken($login: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\"}) { value signature } }";

function record(value) {
  return { value: value, validatedAt: "2026-11-01T00:00:00.000Z", source: "regex", confidence: "high" };
}

function signedConfig(version, hash) {
  return signConfig({
    _schema: 2,
    _version: version,
    _generatedAt: "2026-11-01T00:00:00.000Z",
    gql: {
      clientId: { active: record(CLIENT_ID), fallbacks: [] },
      playbackAccessToken: {
        hash: { active: record(hash), fallbacks: [] },
        query: { active: record(QUERY) }
      }
    }
  }, PRIVATE_PEM, KEY_ID);
}

function loadRemoteConfig() {
  const responses = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error: console.error },
    TTV_CONFIG: {
      gql: { clientId: "b31o4btkqth5bzbvr9ub2ovr79umhh", playbackAccessTokenHash: HASH_B },
      remoteConfig: {
        defaultUrl: "https://example.test/remote-config.json",
        signing: { alg: "ed25519", keyId: KEY_ID, publicKeys: { [KEY_ID]: PUBLIC_PEM } }
      }
    },
    chrome: {
      storage: {
        local: {
          get(_keys, callback) { callback({}); },
          set(_payload, callback) { if (callback) callback(); },
          remove(_keys, callback) { if (callback) callback(); }
        }
      },
      tabs: { query(_query, callback) { callback([]); }, sendMessage() {} }
    },
    fetch: async () => {
      const body = responses.shift();
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    },
    crypto: globalThis.crypto,
    TextEncoder: TextEncoder,
    atob: atob,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {}
  });
  const remoteConfig = vm.runInContext(SOURCE + "\n;RemoteConfig;", context);
  remoteConfig.init();
  return {
    remoteConfig: remoteConfig,
    async serve(body) {
      responses.push(body);
      await remoteConfig._check("test");
      return remoteConfig.getDebugState();
    }
  };
}

async function testVersionsOnlyMoveForward() {
  const { serve } = loadRemoteConfig();

  let state = await serve(signedConfig(10, HASH_A));
  assert.equal(state.lastRemoteFetch.status, "signed-remote");
  assert.equal(state.effectiveConfig.remoteConfigVersion, 10);
  assert.equal(state.effectiveConfig.playbackAccessTokenHash, HASH_A);

  state = await serve(signedConfig(10, HASH_A));
  assert.equal(state.lastRemoteFetch.status, "signed-remote", "the same version and content is accepted");

  state = await serve(signedConfig(9, HASH_B));
  assert.equal(state.lastRemoteFetch.status, "stale-version", "an older signed version is rejected");
  assert.equal(state.effectiveConfig.playbackAccessTokenHash, HASH_A);

  state = await serve(signedConfig(10, HASH_B));
  assert.equal(state.lastRemoteFetch.status, "stale-version", "another payload under the same version is rejected");
  assert.equal(state.effectiveConfig.playbackAccessTokenHash, HASH_A);

  state = await serve(signedConfig(11, HASH_B));
  assert.equal(state.lastRemoteFetch.status, "signed-remote");
  assert.equal(state.effectiveConfig.playbackAccessTokenHash, HASH_B);
}

async function testSignatureIsRequired() {
  const { serve } = loadRemoteConfig();

  let state = await serve({ _version: 50, clientId: CLIENT_ID, playbackAccessTokenHash: HASH_A });
  assert.equal(state.lastRemoteFetch.status, "invalid-payload", "the unsigned legacy format is rejected");
  assert.equal(state.effectiveConfig.source, "bundled");

  const tampered = signedConfig(12, HASH_A);
  tampered.gql.playbackAccessToken.hash.active.value = HASH_B;
  state = await serve(tampered);
  assert.equal(state.lastRemoteFetch.status, "signature-rejected");
  assert.equal(state.effectiveConfig.source, "bundled");
}

async function main() {
  await testVersionsOnlyMoveForward();
  await testSignatureIsRequired();
  console.log("remote-config extension tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
