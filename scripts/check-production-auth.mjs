import assert from "node:assert/strict";
import { createAuth, hashApiKey, parseApiKeyEntries } from "../lib/security.mjs";

const apiKey = "hr_test_key_for_local_validation";
const auth = createAuth({
  mode: "api-key",
  apiKeyHashes: `test-client:reader+writer:${hashApiKey(apiKey)}`,
  corsOrigins: "https://app.example.com",
  maxPerMinute: 10,
});

assert.equal(parseApiKeyEntries(`test-client:reader:${hashApiKey(apiKey)}`).length, 1);
assert.equal(auth.authorize({ headers: { "x-api-key": apiKey }, socket: {} }, "reader").ok, true);
assert.equal(auth.authorize({ headers: { "x-api-key": apiKey }, socket: {} }, "writer").ok, true);
assert.equal(auth.authorize({ headers: { "x-api-key": apiKey }, socket: {} }, "admin").status, 403);
assert.equal(auth.authorize({ headers: { "x-api-key": "wrong" }, socket: {} }, "reader").status, 401);
assert.equal(auth.headers({ headers: { origin: "https://app.example.com" }, socket: {} })["Access-Control-Allow-Origin"], "https://app.example.com");
console.log("Production API-key auth checks passed.");
