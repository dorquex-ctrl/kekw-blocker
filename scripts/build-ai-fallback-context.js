#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const {
  getBundledPlaybackAccessTokenQuery,
  normalizeV2Config
} = require("./remote-config-v2");

const ROOT = path.resolve(__dirname, "..");
const REMOTE_CONFIG_PATH = path.join(ROOT, "remote-config.json");
const TWITCH_URL = "https://www.twitch.tv/";
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15000;
const MAX_BUNDLES = 60;
const MAX_BUNDLE_BYTES = 1500000;
const MAX_SNIPPETS = 24;
const MAX_SNIPPETS_PER_REASON = 3;
const SNIPPET_RADIUS = 700;
const SNIPPET_HARD_LIMIT = 2400;
const MAX_CONTEXT_CHARS = 120000;
const MARKERS = [
  { reason: "PlaybackAccessToken", needle: "PlaybackAccessToken", weight: 8 },
  { reason: "streamPlaybackAccessToken", needle: "streamPlaybackAccessToken", weight: 7 },
  { reason: "videoPlaybackAccessToken", needle: "videoPlaybackAccessToken", weight: 7 },
  { reason: "sha256Hash", needle: "sha256Hash", weight: 6 },
  { reason: "persistedQuery", needle: "persistedQuery", weight: 5 },
  { reason: "value:PlaybackAccessToken", needle: 'value:"PlaybackAccessToken"}', weight: 10 },
  { reason: "Client-ID", needle: "Client-ID", weight: 2 },
  { reason: "clientId", needle: "clientId", weight: 1 },
  { reason: "clientID", needle: "clientID", weight: 1 },
  { reason: "ClientId", needle: "ClientId", weight: 1 }
];

function parseArgs(argv) {
  const args = {
    report: path.resolve("extraction-failure.json"),
    textOut: "",
    jsonOut: ""
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report" && argv[i + 1]) args.report = path.resolve(argv[++i]);
    else if (arg === "--text-out" && argv[i + 1]) args.textOut = path.resolve(argv[++i]);
    else if (arg === "--json-out" && argv[i + 1]) args.jsonOut = path.resolve(argv[++i]);
  }

  return args;
}

function fetchTextCapped(url, maxBytes, redirects) {
  return new Promise((resolve, reject) => {
    const seenRedirects = redirects || 0;
    if (seenRedirects > MAX_REDIRECTS) {
      reject(new Error("Too many redirects fetching " + url));
      return;
    }

    const client = url.startsWith("https://") ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(fetchTextCapped(nextUrl, maxBytes, seenRedirects + 1));
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode + " for " + url));
        return;
      }

      const chunks = [];
      let total = 0;
      let settled = false;

      function finish(buffer) {
        if (settled) return;
        settled = true;
        resolve(buffer.toString("utf8"));
      }

      res.on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (maxBytes && total > maxBytes) {
          const allowed = chunk.slice(0, chunk.length - (total - maxBytes));
          if (allowed.length) chunks.push(allowed);
          finish(Buffer.concat(chunks));
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (settled) return;
        finish(Buffer.concat(chunks));
      });

      res.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });

    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error("Timeout fetching " + url));
    });
  });
}

async function discoverBundleUrls(html) {
  const scriptPattern = /(?:src|href)=["'](https?:\/\/(?:static\.twitchcdn\.net|assets\.twitch\.tv)[^"']+\.js)["']/g;
  const chunkPattern = /["'](https?:\/\/(?:static\.twitchcdn\.net|assets\.twitch\.tv)\/assets\/[^"']+\.js)["']/g;
  const urls = new Set();
  let match;
  while ((match = scriptPattern.exec(html)) !== null) urls.add(match[1]);
  while ((match = chunkPattern.exec(html)) !== null) urls.add(match[1]);
  return Array.from(urls);
}

function extractPlaybackAccessTokenHash(bundleText) {
  const patterns = [
    /PlaybackAccessToken[^}]{0,500}sha256Hash\s*:\s*["']([a-f0-9]{64})["']/,
    /sha256Hash\s*:\s*["']([a-f0-9]{64})["'][^}]{0,500}PlaybackAccessToken/,
    /["']PlaybackAccessToken["']\s*[,:]\s*[^}]*?["']([a-f0-9]{64})["']/,
    /operationName\s*:\s*["']PlaybackAccessToken["'][^}]{0,800}sha256Hash\s*:\s*["']([a-f0-9]{64})["']/
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = bundleText.match(patterns[i]);
    if (match) return match[1];
  }
  return null;
}

function extractClientId(bundleText) {
  const patterns = [
    /["']Client-ID["']\s*[,:]\s*["']([a-z0-9]{30,32})["']/i,
    /clientId\s*[=:]\s*["']([a-z0-9]{30,32})["']/,
    /CLIENT_ID\s*[=:]\s*["']([a-z0-9]{30,32})["']/
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = bundleText.match(patterns[i]);
    if (match) return match[1];
  }
  return null;
}

function extractPlaybackAccessTokenDocument(bundleText) {
  const anchor = 'value:"PlaybackAccessToken"}';
  const anchorIndex = bundleText.indexOf(anchor);
  if (anchorIndex === -1) return null;

  const start = bundleText.lastIndexOf('{kind:"Document"', anchorIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = start; i < bundleText.length; i++) {
    const ch = bundleText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return bundleText.slice(start, i + 1);
    }
  }

  return null;
}

function joinPrinted(parts, separator) {
  return (parts || []).filter(Boolean).join(separator || "") || "";
}

function wrapPrinted(prefix, value, suffix) {
  return value != null && value !== "" ? prefix + value + (suffix || "") : "";
}

function indentPrinted(value) {
  return wrapPrinted("  ", value.replace(/\n/g, "\n  "));
}

function blockPrinted(parts) {
  return wrapPrinted("{\n", indentPrinted(joinPrinted(parts, "\n")), "\n}");
}

function hasMultiline(parts) {
  return parts != null && parts.some((part) => typeof part === "string" && part.includes("\n"));
}

function printGraphqlNode(node) {
  switch (node.kind) {
    case "Name":
      return node.value;
    case "Variable":
      return "$" + printGraphqlNode(node.name);
    case "Document":
      return joinPrinted(node.definitions.map(printGraphqlNode), "\n\n") + "\n";
    case "OperationDefinition": {
      const op = node.operation;
      const name = node.name ? printGraphqlNode(node.name) : "";
      const vars = wrapPrinted("(", joinPrinted((node.variableDefinitions || []).map(printGraphqlNode), ", "), ")");
      const directives = joinPrinted((node.directives || []).map(printGraphqlNode), " ");
      const selectionSet = printGraphqlNode(node.selectionSet);
      return name || directives || vars || op !== "query"
        ? joinPrinted([op, joinPrinted([name, vars]), directives, selectionSet], " ")
        : selectionSet;
    }
    case "VariableDefinition":
      return printGraphqlNode(node.variable) + ": " + printGraphqlNode(node.type) +
        wrapPrinted(" = ", node.defaultValue ? printGraphqlNode(node.defaultValue) : "") +
        wrapPrinted(" ", joinPrinted((node.directives || []).map(printGraphqlNode), " "));
    case "SelectionSet":
      return blockPrinted((node.selections || []).map(printGraphqlNode));
    case "Field": {
      const alias = node.alias ? printGraphqlNode(node.alias) + ": " : "";
      const name = printGraphqlNode(node.name);
      const args = (node.arguments || []).map(printGraphqlNode);
      const directives = joinPrinted((node.directives || []).map(printGraphqlNode), " ");
      let head = alias + name + wrapPrinted("(", joinPrinted(args, ", "), ")");
      if (head.length > 80 || hasMultiline(args)) {
        head = alias + name + wrapPrinted("(\n", indentPrinted(joinPrinted(args, "\n")), "\n)");
      }
      return joinPrinted([head, directives, node.selectionSet ? printGraphqlNode(node.selectionSet) : ""], " ");
    }
    case "Argument":
      return printGraphqlNode(node.name) + ": " + printGraphqlNode(node.value);
    case "Directive":
      return "@" + printGraphqlNode(node.name) +
        wrapPrinted("(", joinPrinted((node.arguments || []).map(printGraphqlNode), ", "), ")");
    case "NamedType":
      return printGraphqlNode(node.name);
    case "ListType":
      return "[" + printGraphqlNode(node.type) + "]";
    case "NonNullType":
      return printGraphqlNode(node.type) + "!";
    case "StringValue":
      return JSON.stringify(node.value);
    case "BooleanValue":
      return node.value ? "true" : "false";
    case "NullValue":
      return "null";
    case "EnumValue":
      return node.value;
    case "IntValue":
    case "FloatValue":
      return node.value;
    case "ListValue":
      return "[" + joinPrinted((node.values || []).map(printGraphqlNode), ", ") + "]";
    case "ObjectValue":
      return "{" + joinPrinted((node.fields || []).map(printGraphqlNode), ", ") + "}";
    case "ObjectField":
      return printGraphqlNode(node.name) + ": " + printGraphqlNode(node.value);
    default:
      throw new Error("Unsupported AST node kind: " + node.kind);
  }
}

function derivePlaybackAccessTokenQuery(bundleText) {
  try {
    const documentLiteral = extractPlaybackAccessTokenDocument(bundleText);
    if (!documentLiteral) return null;
    const documentAst = Function('"use strict"; return (' + documentLiteral + ");")();
    if (!documentAst || documentAst.kind !== "Document") return null;
    return printGraphqlNode(documentAst);
  } catch {
    return null;
  }
}

function normalizeSnippetText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function buildSnippet(text, start, end) {
  const prefix = start > 0 ? "... " : "";
  const suffix = end < text.length ? " ..." : "";
  let snippet = normalizeSnippetText(text.slice(start, end));
  if (snippet.length > SNIPPET_HARD_LIMIT) {
    snippet = snippet.slice(0, SNIPPET_HARD_LIMIT - 4).trimEnd() + " ...";
  }
  return prefix + snippet + suffix;
}

function collectMarkerSnippets(text, url) {
  const snippets = [];
  const seen = new Set();
  const countsByReason = Object.create(null);

  function addSnippet(reason, index, length) {
    const nextCount = countsByReason[reason] || 0;
    if (nextCount >= MAX_SNIPPETS_PER_REASON || snippets.length >= MAX_SNIPPETS) return;
    const start = Math.max(0, index - SNIPPET_RADIUS);
    const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
    const excerpt = buildSnippet(text, start, end);
    const dedupeKey = reason + "::" + excerpt;
    if (!excerpt || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    countsByReason[reason] = nextCount + 1;
    snippets.push({
      reason: reason,
      sourceUrl: url,
      excerpt: excerpt
    });
  }

  for (let i = 0; i < MARKERS.length; i++) {
    const marker = MARKERS[i];
    let fromIndex = 0;
    while (snippets.length < MAX_SNIPPETS && (countsByReason[marker.reason] || 0) < MAX_SNIPPETS_PER_REASON) {
      const index = text.indexOf(marker.needle, fromIndex);
      if (index === -1) break;
      addSnippet(marker.reason, index, marker.needle.length);
      fromIndex = index + marker.needle.length;
    }
  }

  const directHash = extractPlaybackAccessTokenHash(text);
  if (directHash) {
    const hashIndex = text.indexOf(directHash);
    if (hashIndex !== -1) addSnippet("direct-hash-candidate", hashIndex, directHash.length);
  }

  const clientId = extractClientId(text);
  if (clientId) {
    const clientIndex = text.indexOf(clientId);
    if (clientIndex !== -1) addSnippet("client-id-candidate", clientIndex, clientId.length);
  }

  const derivedQuery = derivePlaybackAccessTokenQuery(text);
  if (derivedQuery) {
    snippets.push({
      reason: "derived-playback-query",
      sourceUrl: url,
      excerpt: derivedQuery.length > SNIPPET_HARD_LIMIT
        ? derivedQuery.slice(0, SNIPPET_HARD_LIMIT - 4).trimEnd() + " ..."
        : derivedQuery
    });
  }

  return snippets.slice(0, MAX_SNIPPETS);
}

function analyzeBundle(url, text, index) {
  const counts = {};
  let score = 0;
  for (let i = 0; i < MARKERS.length; i++) {
    const marker = MARKERS[i];
    let count = 0;
    let fromIndex = 0;
    while (true) {
      const found = text.indexOf(marker.needle, fromIndex);
      if (found === -1) break;
      count++;
      fromIndex = found + marker.needle.length;
    }
    counts[marker.reason] = count;
    score += Math.min(count, 3) * marker.weight;
  }

  const directHash = extractPlaybackAccessTokenHash(text);
  const derivedQuery = derivePlaybackAccessTokenQuery(text);
  const clientId = extractClientId(text);
  const snippets = collectMarkerSnippets(text, url);
  if (directHash) score += 20;
  if (derivedQuery) score += 30;
  if (clientId) score += 5;
  if (snippets.length) score += Math.min(snippets.length, 6);

  return {
    index: index,
    url: url,
    bytes: text.length,
    score: score,
    counts: counts,
    directHash: directHash,
    clientId: clientId,
    derivedQuery: derivedQuery,
    derivedHash: derivedQuery ? crypto.createHash("sha256").update(derivedQuery).digest("hex") : null,
    snippets: snippets,
    prefix: buildSnippet(text, 0, Math.min(text.length, 1800))
  };
}

function loadFailureReport(reportPath) {
  try {
    return JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}

function loadCurrentConfig() {
  const bundledQuery = getBundledPlaybackAccessTokenQuery();
  const currentRaw = JSON.parse(fs.readFileSync(REMOTE_CONFIG_PATH, "utf8"));
  return {
    bundledQuery: bundledQuery,
    normalized: normalizeV2Config(currentRaw, bundledQuery)
  };
}

function buildContextText(failureReport, currentConfig, bundleAnalyses) {
  const currentClientId = currentConfig.normalized.gql.clientId.active && currentConfig.normalized.gql.clientId.active.value || "";
  const currentHash = currentConfig.normalized.gql.playbackAccessToken.hash.active && currentConfig.normalized.gql.playbackAccessToken.hash.active.value || "";
  const currentQuery = currentConfig.normalized.gql.playbackAccessToken.query.active && currentConfig.normalized.gql.playbackAccessToken.query.active.value || currentConfig.bundledQuery;
  const parts = [];

  parts.push("Failure report:");
  if (failureReport) {
    parts.push("- failedFields: " + ((failureReport.failedFields || []).join(", ") || "unknown"));
    parts.push("- message: " + (failureReport.message || ""));
    parts.push("- bundleCountSeenByExtractor: " + (failureReport.bundleCount || 0));
  } else {
    parts.push("- failedFields: unknown");
  }

  parts.push("");
  parts.push("Current signed remote config:");
  parts.push("- currentClientId: " + currentClientId);
  parts.push("- currentPlaybackAccessTokenHash: " + currentHash);
  parts.push("- currentPlaybackAccessTokenQueryLength: " + currentQuery.length);
  parts.push("- bundledPlaybackAccessTokenQueryLength: " + currentConfig.bundledQuery.length);

  parts.push("");
  parts.push("Downloaded bundle analysis summary:");
  const relevantBundles = bundleAnalyses
    .filter((analysis) => analysis.score > 0 || analysis.directHash || analysis.derivedQuery || analysis.clientId)
    .slice(0, 10);
  const bundlesForSummary = relevantBundles.length ? relevantBundles : bundleAnalyses.slice(0, 5);
  for (let i = 0; i < bundlesForSummary.length; i++) {
    const analysis = bundlesForSummary[i];
    parts.push(
      "- bundle#" + (analysis.index + 1) +
      " score=" + analysis.score +
      " bytes=" + analysis.bytes +
      " directHash=" + (analysis.directHash || "none") +
      " derivedQuery=" + (analysis.derivedQuery ? "yes" : "no") +
      " clientId=" + (analysis.clientId || "none")
    );
    parts.push("  url: " + analysis.url);
  }

  const snippets = [];
  for (let i = 0; i < bundleAnalyses.length && snippets.length < MAX_SNIPPETS; i++) {
    const analysis = bundleAnalyses[i];
    for (let j = 0; j < analysis.snippets.length && snippets.length < MAX_SNIPPETS; j++) {
      snippets.push(analysis.snippets[j]);
    }
  }

  if (!snippets.length) {
    for (let i = 0; i < Math.min(bundleAnalyses.length, 3) && snippets.length < 3; i++) {
      snippets.push({
        reason: "bundle-prefix-fallback",
        sourceUrl: bundleAnalyses[i].url,
        excerpt: bundleAnalyses[i].prefix
      });
    }
  }

  parts.push("");
  parts.push("Relevant Twitch JS bundle snippets:");
  let contextChars = parts.join("\n").length;
  for (let i = 0; i < snippets.length; i++) {
    const snippet = snippets[i];
    const block =
      "[snippet " + (i + 1) + " | reason=" + snippet.reason + "]\n" +
      "source=" + snippet.sourceUrl + "\n" +
      snippet.excerpt + "\n";
    if (contextChars + block.length > MAX_CONTEXT_CHARS) break;
    parts.push(block);
    contextChars += block.length;
  }

  return parts.join("\n").trim() + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const failureReport = loadFailureReport(args.report);
  const currentConfig = loadCurrentConfig();

  console.log("[ai-context] Fetching twitch.tv...");
  const html = await fetchTextCapped(TWITCH_URL, 2 * 1024 * 1024, 0);
  const bundleUrls = await discoverBundleUrls(html);
  console.log("[ai-context] Found " + bundleUrls.length + " bundle URL(s)");

  const selectedUrls = bundleUrls.slice(0, MAX_BUNDLES);
  const analyses = [];
  for (let i = 0; i < selectedUrls.length; i++) {
    const url = selectedUrls[i];
    try {
      console.log("[ai-context] Fetching bundle " + (i + 1) + "/" + selectedUrls.length);
      const text = await fetchTextCapped(url, MAX_BUNDLE_BYTES, 0);
      analyses.push(analyzeBundle(url, text, i));
    } catch (error) {
      console.warn("[ai-context] Failed to fetch " + url + ": " + error.message);
    }
  }

  analyses.sort((a, b) => b.score - a.score || b.snippets.length - a.snippets.length || a.index - b.index);
  const contextText = buildContextText(failureReport, currentConfig, analyses);
  const contextJson = {
    generatedAt: new Date().toISOString(),
    failureReport: failureReport,
    currentConfig: {
      clientId: currentConfig.normalized.gql.clientId.active && currentConfig.normalized.gql.clientId.active.value || "",
      playbackAccessTokenHash: currentConfig.normalized.gql.playbackAccessToken.hash.active && currentConfig.normalized.gql.playbackAccessToken.hash.active.value || "",
      playbackAccessTokenQueryLength: (currentConfig.normalized.gql.playbackAccessToken.query.active && currentConfig.normalized.gql.playbackAccessToken.query.active.value || currentConfig.bundledQuery).length
    },
    bundlesAnalyzed: analyses.map((analysis) => ({
      index: analysis.index,
      url: analysis.url,
      bytes: analysis.bytes,
      score: analysis.score,
      directHash: analysis.directHash,
      clientId: analysis.clientId,
      derivedHash: analysis.derivedHash,
      hasDerivedQuery: !!analysis.derivedQuery,
      snippetCount: analysis.snippets.length,
      counts: analysis.counts
    }))
  };

  if (args.textOut) fs.writeFileSync(args.textOut, contextText);
  if (args.jsonOut) fs.writeFileSync(args.jsonOut, JSON.stringify(contextJson, null, 2) + "\n");

  console.log("[ai-context] Analyzed " + analyses.length + " bundle(s)");
  console.log("[ai-context] Context length: " + contextText.length + " char(s)");
  if (analyses[0]) {
    console.log("[ai-context] Top bundle score: " + analyses[0].score + " (" + analyses[0].url + ")");
  }
}

main().catch((error) => {
  console.error("[ai-context] Fatal error:", error.message);
  process.exit(1);
});
