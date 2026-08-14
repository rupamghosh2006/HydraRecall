import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLongMemEvalMetrics,
  normalizeLongMemEvalRecord,
  renderLongMemEvalReport,
  retrieveLongMemEvidence,
} from "../lib/longmemeval.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(root);

function usage() {
  console.log(`
HydraRecall LongMemEval adapter

Usage:
  node scripts/longmemeval-adapter.mjs --input <dataset.json> [options]

Options:
  --endpoint <url>       HydraRecall API base URL (default: http://127.0.0.1:3000)
  --api-key <key>        API key; prefer HYDRARECALL_API_KEY environment variable
  --output <path>        Official-compatible {question_id,hypothesis} JSONL output
  --evidence-output <path>  Detailed retrieval trace JSONL output
  --report <path>        Markdown retrieval/latency report
  --run-id <id>          Stable benchmark run identifier
  --top-k <n>            Evidence turns per question (default: 8, max: 32)
  --limit <n>            Process only the first n records
  --pace-ms <n>          Minimum delay between live API calls (default: 0)
  --max-retries <n>      Retries for 429/5xx responses (default: 5)
  --resume               Skip question_ids already present in --output
  --sync-hydra           Persist selected proof paths to the private HydraDB graph
  --dry-run              Run local retrieval and reporting without calling the API reader
`);
}

function parseArgs(argv) {
  const options = { endpoint: "http://127.0.0.1:3000", topK: 8, dryRun: false, syncHydra: false, paceMs: 0, maxRetries: 5, resume: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--dry-run") { options.dryRun = true; continue; }
    if (flag === "--sync-hydra") { options.syncHydra = true; continue; }
    if (flag === "--resume") { options.resume = true; continue; }
    if (!flag.startsWith("--")) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    index += 1;
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
  }
  if (!options.input) throw new Error("--input is required.");
  options.topK = Math.min(32, Math.max(1, Number(options.topK || 8)));
  if (!Number.isInteger(options.topK)) throw new Error("--top-k must be an integer.");
  if (options.limit !== undefined && (!Number.isInteger(Number(options.limit)) || Number(options.limit) < 1)) throw new Error("--limit must be a positive integer.");
  options.paceMs = Math.max(0, Number(options.paceMs || 0));
  options.maxRetries = Math.min(20, Math.max(0, Number(options.maxRetries || 5)));
  if (!Number.isInteger(options.paceMs) || !Number.isInteger(options.maxRetries)) throw new Error("--pace-ms and --max-retries must be integers.");
  return options;
}

function defaultPaths(options) {
  const runFolder = path.join(projectRoot, "runs", "longmemeval");
  const runId = options.runId || `hydrarecall-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return {
    ...options,
    runId,
    output: options.output || path.join(runFolder, `${runId}-hypotheses.jsonl`),
    evidenceOutput: options.evidenceOutput || path.join(runFolder, `${runId}-evidence.jsonl`),
    report: options.report || path.join(runFolder, `${runId}-report.md`),
  };
}

function publicRecord(record) {
  return {
    question_id: record.question_id,
    question: record.question,
    question_date: record.question_date,
    haystack_session_ids: record.haystack_session_ids,
    haystack_dates: record.haystack_dates,
    haystack_sessions: record.haystack_sessions.map((session) => session.map(({ role, content }) => ({ role, content }))),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetrySeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

async function readLines(filePath) {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf8");
  return content.split(/\r?\n/).filter(Boolean);
}

async function loadResumeState(outputPath, evidencePath) {
  const completed = new Set();
  const rows = [];
  for (const line of await readLines(outputPath)) {
    try { completed.add(String(JSON.parse(line).question_id)); } catch { /* skip malformed */ }
  }
  for (const line of await readLines(evidencePath)) {
    try {
      const item = JSON.parse(line);
      rows.push({
        questionId: String(item.question_id),
        questionType: item.question_type,
        hypothesis: item.hypothesis,
        latencyMs: item.latency_ms,
        isAbstention: String(item.question_id).endsWith("_abs"),
        retrievedGoldEvidence: Boolean(item.retrieved_gold_evidence),
      });
    } catch { /* skip malformed */ }
  }
  return { completed, rows };
}

async function callReader(options, record, attempt = 1) {
  const endpoint = `${options.endpoint.replace(/\/$/, "")}/api/benchmark/longmemeval${options.syncHydra ? "?syncGraph=true" : ""}`;
  const headers = { "Content-Type": "application/json" };
  const apiKey = options.apiKey || process.env.HYDRARECALL_API_KEY;
  if (apiKey) headers["X-API-Key"] = apiKey;
  const started = performance.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ record: publicRecord(record), topK: options.topK, runId: options.runId, syncGraph: options.syncHydra }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    if (attempt <= options.maxRetries) {
      const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      console.log(`  network retry ${attempt}/${options.maxRetries} for ${record.question_id} in ${delay} ms (${error.message})`);
      await sleep(delay);
      return callReader(options, record, attempt + 1);
    }
    throw new Error(`Reader failed for ${record.question_id}: ${error.message}`);
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) return { ...body, latencyMs: Math.round(performance.now() - started) };
  const retryAfter = parseRetrySeconds(body?.retryAfter ?? response.headers.get("retry-after"));
  const retriable = response.status === 429 || response.status >= 500;
  if (retriable && attempt <= options.maxRetries) {
    // Gemini can report a retry window that ends on a quota boundary. Add a
    // small cushion so the next request is not sent into the same window.
    const delay = retryAfter ? Math.min(300_000, retryAfter * 1_000 + 5_000) : Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    console.log(`  retry ${attempt}/${options.maxRetries} for ${record.question_id} in ${delay} ms (HTTP ${response.status})`);
    await sleep(delay);
    return callReader(options, record, attempt + 1);
  }
  throw new Error(`Reader failed for ${record.question_id}: ${body.error || response.status}`);
}

function goldEvidenceHit(record, evidence) {
  const gold = new Set(Array.isArray(record.answer_session_ids) ? record.answer_session_ids.map(String) : []);
  if (!gold.size) return false;
  return evidence.some((item) => gold.has(String(item.sessionId)));
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) return usage();
  const options = defaultPaths(parsed);
  const dataset = JSON.parse(await readFile(path.resolve(options.input), "utf8"));
  if (!Array.isArray(dataset)) throw new Error("LongMemEval input must be a JSON array.");
  const records = options.limit ? dataset.slice(0, Number(options.limit)) : dataset;
  const summaryRows = [];
  let skipped = 0;
  const outputTarget = path.resolve(options.output);
  const evidenceTarget = path.resolve(options.evidenceOutput);

  if (options.resume) {
    const { completed, rows } = await loadResumeState(outputTarget, evidenceTarget);
    summaryRows.push(...rows);
    const recordsById = new Map();
    for (const record of dataset) recordsById.set(String(record.question_id), record);
    skipped = records.filter((record) => completed.has(String(record.question_id))).length;
    for (const row of summaryRows) {
      const record = recordsById.get(row.questionId);
      if (record) {
        const normalized = normalizeLongMemEvalRecord(record);
        const retrieval = retrieveLongMemEvidence(normalized, { topK: options.topK });
        row.retrievedGoldEvidence = goldEvidenceHit(record, retrieval.evidence);
      }
    }
    if (skipped) console.log(`Resuming: ${skipped} completed question(s) already in ${options.output}`);
  }

  await Promise.all([outputTarget, evidenceTarget].map((target) => mkdir(path.dirname(target), { recursive: true })));

  let processed = 0;
  for (const [index, record] of records.entries()) {
    const normalized = normalizeLongMemEvalRecord(record);
    if (options.resume && summaryRows.some((row) => row.questionId === normalized.questionId)) continue;
    let reader;
    if (options.dryRun) {
      const started = performance.now();
      const retrieval = retrieveLongMemEvidence(normalized, { topK: options.topK });
      reader = {
        hypothesis: "I don't know.",
        abstained: true,
        reader: "dry-run",
        latencyMs: Math.round(performance.now() - started),
        retrieval: { ...retrieval, evidence: retrieval.evidence.map(({ content, ...item }) => ({ ...item, excerpt: content.slice(0, 900) })) },
        graph: { status: "not-requested" },
      };
    } else {
      if (processed > 0 && options.paceMs > 0) await sleep(options.paceMs);
      reader = await callReader(options, record);
      processed += 1;
    }

    const evidence = reader.retrieval?.evidence || [];
    const summaryRow = {
      questionId: normalized.questionId,
      questionType: normalized.questionType,
      hypothesis: reader.hypothesis,
      latencyMs: reader.latencyMs,
      isAbstention: normalized.questionId.endsWith("_abs"),
      retrievedGoldEvidence: goldEvidenceHit(record, evidence),
    };
    summaryRows.push(summaryRow);
    const predictionLine = JSON.stringify({ question_id: normalized.questionId, hypothesis: reader.hypothesis });
    const evidenceLine = JSON.stringify({
      question_id: normalized.questionId,
      question_type: normalized.questionType,
      reader: reader.reader,
      latency_ms: reader.latencyMs,
      abstained: Boolean(reader.abstained),
      hypothesis: reader.hypothesis,
      retrieved_gold_evidence: summaryRow.retrievedGoldEvidence,
      graph: reader.graph,
      evidence,
    });
    await appendFile(outputTarget, `${predictionLine}\n`, "utf8");
    await appendFile(evidenceTarget, `${evidenceLine}\n`, "utf8");
    console.log(`[${index + 1}/${records.length}] ${normalized.questionId} · ${reader.latencyMs} ms · ${evidence.length} evidence turns`);
  }

  const metrics = buildLongMemEvalMetrics(summaryRows, options.topK);
  await mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
  await writeFile(path.resolve(options.report), renderLongMemEvalReport({
    inputPath: options.input,
    outputPath: options.output,
    evidencePath: options.evidenceOutput,
    runId: options.runId,
    endpoint: options.endpoint,
    metrics,
    sampleCount: summaryRows.length,
    dryRun: options.dryRun,
    graphSync: options.syncHydra,
  }), "utf8");
  console.log(`\nWrote ${options.output}\nWrote ${options.evidenceOutput}\nWrote ${options.report}`);
}

run().catch((error) => {
  console.error(`LongMemEval adapter failed: ${error.message}`);
  process.exitCode = 1;
});
