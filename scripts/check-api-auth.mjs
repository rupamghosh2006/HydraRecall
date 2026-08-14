import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { hashApiKey } from "../lib/security.mjs";

const port = 3217;
const readerKey = "hr_reader_check_key";
const writerKey = "hr_writer_check_key";
const apiKeys = `reader-check:reader:${hashApiKey(readerKey)},writer-check:writer:${hashApiKey(writerKey)}`;
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), AUTH_MODE: "api-key", HYDRARECALL_API_KEY_HASHES: apiKeys, AUTH_RATE_LIMIT_PER_MINUTE: "30", BENCHMARK_READER_MODE: "deterministic" },
  stdio: ["ignore", "ignore", "ignore"],
});

async function request(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      if ((await request("/api/health")).status === 200) { ready = true; break; }
    } catch {}
    await delay(120);
  }
  assert.equal(ready, true, "Server did not start for API auth smoke test.");
  assert.equal((await request("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "What is Alex's current deployment policy?" }) })).status, 401);
  assert.equal((await request("/api/ingest", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": readerKey }, body: JSON.stringify({ text: "reader should not write" }) })).status, 403);
  assert.equal((await request("/api/query", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": readerKey }, body: JSON.stringify({ question: "What is Alex's current deployment policy?" }) })).status, 200);
  assert.equal((await request("/api/dashboard", { headers: { "X-API-Key": writerKey } })).status, 200);
  const benchmark = await request("/api/benchmark/longmemeval", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": writerKey },
    body: JSON.stringify({
      topK: 2,
      record: {
        question_id: "auth-smoke",
        question: "What is the deployment policy?",
        haystack_session_ids: ["s-1"],
        haystack_dates: ["2026-01-01"],
        haystack_sessions: [[{ role: "user", content: "The deployment policy uses canary releases." }]],
      },
    }),
  });
  assert.equal(benchmark.status, 200);
  assert.equal(benchmark.body.retrieval.evidence.length, 1);
  console.log("Production API route authorization checks passed.");
} finally {
  child.kill("SIGTERM");
}
