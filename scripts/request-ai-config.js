#!/usr/bin/env node
"use strict";

// Asks the model for config candidates after the extraction confirmed stale
// values. The answer is written as-is; apply-ai-config.js validates it.
//
// Usage: node scripts/request-ai-config.js <failure-report.json> <context.txt> <result.json>

const fs = require("fs");
const https = require("https");

const MODEL = "gpt-5-mini";
const REQUEST_TIMEOUT_MS = 120000;

function buildPrompt(failedFields, context) {
  return [
    "You are analyzing Twitch.tv JavaScript bundle context to recover configuration values for a Twitch ad-blocker extension.",
    "",
    "The primary extractor already confirmed that these fields are stale or unrecoverable:",
    "Failed fields: " + failedFields,
    "",
    "You will receive:",
    "- the current signed remote config values",
    "- a summary of locally derived bundle candidates",
    "- explicit snippet windows cut around likely Twitch GraphQL / persisted-query markers",
    "",
    "Important instructions:",
    "- Prefer exact values that are directly supported by the provided snippets.",
    "- If you can recover the full PlaybackAccessToken query text but not the persisted-query hash, return the query and set playbackAccessTokenHash to null. We can derive and validate a candidate hash locally.",
    "- Only return high confidence when the value is directly present in the snippets or clearly reconstructed from the provided AST/query context.",
    "- If the evidence is weak or missing, return nulls and use low confidence.",
    "",
    "Context:",
    context,
    "",
    "Respond ONLY with valid JSON in this exact format (no markdown, no explanation):",
    "{",
    "  \"playbackAccessTokenHash\": \"<64-char hex string or null if not found>\",",
    "  \"playbackAccessTokenQuery\": \"<full PlaybackAccessToken GraphQL query string or null if not found>\",",
    "  \"clientId\": \"<30-32 char alphanumeric string or null if not found>\",",
    "  \"confidence\": \"high|medium|low\",",
    "  \"notes\": \"<brief explanation of where you found the values>\"",
    "}"
  ].join("\n");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  const [reportPath, contextPath, resultPath] = process.argv.slice(2);
  if (!reportPath || !contextPath || !resultPath) {
    fail("Usage: node scripts/request-ai-config.js <failure-report.json> <context.txt> <result.json>");
  }
  if (!process.env.OPENAI_API_KEY) fail("OPENAI_API_KEY is required");

  const failureReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const failedFields = failureReport.failedFields.join(", ");
  const context = fs.readFileSync(contextPath, "utf8");

  const body = JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: buildPrompt(failedFields, context) }],
    max_completion_tokens: 2000,
    response_format: { type: "json_object" }
  });

  const req = https.request({
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    method: "POST",
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.OPENAI_API_KEY
    }
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk; });
    res.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        fail("Failed to parse OpenAI response: " + data);
      }
      const choice = parsed.choices && parsed.choices[0];
      const content = choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content.trim()
        : "";
      if (!content) {
        console.error("OpenAI returned empty content. finish_reason=" + (choice && choice.finish_reason || "unknown"));
        fail(JSON.stringify(parsed, null, 2));
      }
      fs.writeFileSync(resultPath, content);
      console.log("AI response:");
      console.log(content);
    });
  });
  req.on("timeout", () => req.destroy(new Error("No answer after " + REQUEST_TIMEOUT_MS / 1000 + " s")));
  req.on("error", (error) => fail("Request failed: " + error.message));
  req.write(body);
  req.end();
}

main();
