import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import * as readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(root);

function usage() {
  console.log(`
HydraRecall LongMemEval V2 adapter

Usage:
  node scripts/longmemeval-v2-adapter.mjs --questions <questions.jsonl> --trajectories <trajectories.jsonl> --haystack <haystack.json> [options]

Options:
  --endpoint <url>       HydraRecall API base URL (default: http://127.0.0.1:3000)
  --api-key <key>        API key; prefer HYDRARECALL_API_KEY environment variable
  --output <path>        JSONL output
  --evidence-output <path>  Detailed retrieval trace JSONL output
  --report <path>        Markdown retrieval/latency report
  --run-id <id>          Stable benchmark run identifier
  --top-k <n>            Evidence states per question (default: 8, max: 32)
  --limit <n>            Process only the first n records
  --pace-ms <n>          Minimum delay between live API calls (default: 0)
  --max-retries <n>      Retries for 429/5xx responses (default: 5)
  --resume               Skip question_ids already present in --output
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
  options.topK = Math.min(32, Math.max(1, Number(options.topK || 8)));
  if (options.limit) options.limit = Number(options.limit);
  return options;
}

function defaultPaths(options) {
  const runFolder = path.join(projectRoot, "runs", "longmemeval-v2");
  const runId = options.runId || `hydrarecall-v2-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return {
    ...options,
    runId,
    questions: options.questions || path.join(projectRoot, "data", "longmemeval-v2", "questions.jsonl"),
    trajectories: options.trajectories || path.join(projectRoot, "data", "longmemeval-v2", "trajectories.jsonl"),
    haystack: options.haystack || path.join(projectRoot, "data", "longmemeval-v2", "haystacks", "lme_v2_small.json"),
    output: options.output || path.join(runFolder, `${runId}-hypotheses.jsonl`),
    evidenceOutput: options.evidenceOutput || path.join(runFolder, `${runId}-evidence.jsonl`),
    report: options.report || path.join(runFolder, `${runId}-report.md`),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        abstained: typeof item.abstained === "boolean" ? item.abstained : undefined,
        latencyMs: item.latency_ms,
        isAbstention: String(item.question_id).endsWith("_abs"),
        retrievedGoldEvidence: Boolean(item.retrieved_gold_evidence),
        retrievalMode: item.retrieval_mode || "bm25-local",
      });
    } catch { /* skip malformed */ }
  }
  return { completed, rows };
}

async function callReader(options, record, attempt = 1) {
  const endpoint = `${options.endpoint.replace(/\/$/, "")}/api/benchmark/longmemeval-v2${options.syncHydra ? "?syncGraph=true" : ""}`;
  const headers = { "Content-Type": "application/json" };
  const apiKey = options.apiKey || process.env.HYDRARECALL_API_KEY;
  if (apiKey) headers["X-API-Key"] = apiKey;
  const started = performance.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ record, topK: options.topK, runId: options.runId, syncGraph: options.syncHydra }),
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
  
  const retryAfter = Number(body?.retryAfter ?? response.headers.get("retry-after"));
  const retriable = response.status === 429 || response.status >= 500;
  if (retriable && attempt <= options.maxRetries) {
    const delay = retryAfter ? Math.min(300_000, retryAfter * 1_000 + 5_000) : Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    console.log(`  retry ${attempt}/${options.maxRetries} for ${record.question_id} in ${delay} ms (HTTP ${response.status})`);
    await sleep(delay);
    return callReader(options, record, attempt + 1);
  }
  throw new Error(`Reader failed for ${record.question_id}: ${body.error || response.status}`);
}

async function loadTrajectoriesIntoMemory(trajectoriesPath, requiredIds) {
  console.log(`Loading trajectories from ${trajectoriesPath} (this may take a while)...`);
  const trajectories = new Map();
  const fileStream = createReadStream(trajectoriesPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const t = JSON.parse(line);
    if (requiredIds.has(t.id)) {
      // Strip screenshots to save RAM
      if (t.states) {
        t.states = t.states.map(s => {
          delete s.screenshot;
          return s;
        });
      }
      trajectories.set(t.id, t);
    }
    count++;
    if (count % 100 === 0) process.stdout.write(`\rScanned ${count} trajectories...`);
  }
  console.log(`\nLoaded ${trajectories.size} required trajectories into memory.`);
  return trajectories;
}

async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) return usage();
  const options = defaultPaths(parsed);

  const questions = [];
  for (const line of await readLines(options.questions)) {
    questions.push(JSON.parse(line));
  }
  
  let records = options.limit ? questions.slice(0, Number(options.limit)) : questions;
  
  const haystackMapping = JSON.parse(await readFile(options.haystack, "utf8"));
  
  // Figure out which trajectories we actually need
  const requiredTrajectoryIds = new Set();
  for (const q of records) {
    const ids = haystackMapping[q.id] || [];
    for (const tid of ids) requiredTrajectoryIds.add(tid);
  }

  const trajectoryStore = await loadTrajectoriesIntoMemory(options.trajectories, requiredTrajectoryIds);

  if (!options.dryRun) {
    console.log("Pushing required trajectories to HydraDB ingestion endpoint...");
    const trajArray = Array.from(trajectoryStore.values()).map(t => ({
      id: t.id,
      title: "Trajectory " + t.id,
      turns: (t.states || []).map((s, idx) => ({
        id: t.id + "-" + idx,
        role: "user",
        text: JSON.stringify(s).slice(0, 4000),
        occurredAt: new Date().toISOString()
      }))
    }));
    
    // Batch ingest
    for (let i = 0; i < trajArray.length; i += 20) {
      const batch = trajArray.slice(i, i + 20);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000); // 5 minute timeout
      try {
        const headers = { "Content-Type": "application/json" };
        const apiKey = options.apiKey || process.env.HYDRARECALL_API_KEY;
        if (apiKey) headers["X-API-Key"] = apiKey;
        const res = await fetch(options.endpoint.replace(/\/$/, "") + "/api/benchmark/ingest", {
          method: "POST",
          headers,
          body: JSON.stringify({ dataset: "longmemeval-v2", sessions: batch }),
          signal: controller.signal
        });
        if (!res.ok) {
          console.error(`Ingestion batch failed (HTTP ${res.status}):`, await res.text());
        } else {
          console.log(`  Ingested trajectories ${Math.min(i + 20, trajArray.length)}/${trajArray.length}`);
        }
      } catch (err) {
        if (err.name === "AbortError") {
          console.error(`Ingestion timeout: batch ${i / 20 + 1} exceeded 5 minutes limit.`);
        } else {
          console.error("Ingestion network error:", err.message);
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  const summaryRows = [];
  let skipped = 0;
  const outputTarget = path.resolve(options.output);
  const evidenceTarget = path.resolve(options.evidenceOutput);

  if (options.resume) {
    const { completed, rows } = await loadResumeState(outputTarget, evidenceTarget);
    summaryRows.push(...rows);
    skipped = records.filter((record) => completed.has(String(record.id))).length;
    if (skipped) console.log(`Resuming: ${skipped} completed question(s) already in ${options.output}`);
  }

  await Promise.all([outputTarget, evidenceTarget].map((target) => mkdir(path.dirname(target), { recursive: true })));

  let processed = 0;
  for (const [index, q] of records.entries()) {
    if (options.resume && summaryRows.some((row) => row.questionId === String(q.id))) continue;

    const trajIds = haystackMapping[q.id] || [];
    const record = {
      question_id: q.id,
      question: q.question,
      question_type: q.question_type,
      trajectories: trajIds.map(tid => trajectoryStore.get(tid)).filter(Boolean)
    };

    let reader;
    if (options.dryRun) {
      // Not calling API, we don't have retrieveLongMemEvidence locally accessible inside this isolated script
      // because it expects the API. But wait, `dry-run` could call API with `--dry-run` or we just skip it.
      // Wait, in V2 we let the API handle the logic, even dry-run? No, dry-run in V1 just did local BM25.
      // We can't do local BM25 without importing the lib. So for V2 adapter dry-run we just stub it, or import the lib.
      console.log(`[${index + 1}/${records.length}] ${q.id} · skipped (dry-run not fully implemented for local BM25 in this script)`);
      continue;
    } else {
      if (processed > 0 && options.paceMs > 0) await sleep(options.paceMs);
      reader = await callReader(options, record);
      processed += 1;
    }

    const evidence = reader.retrieval?.evidence || [];
    const hypothesis = reader.hypothesis ?? reader.answer ?? "I don't know.";
    const summaryRow = {
      questionId: record.question_id,
      questionType: record.question_type,
      hypothesis,
      abstained: typeof reader.abstained === "boolean" ? reader.abstained : undefined,
      latencyMs: reader.latencyMs,
      isAbstention: String(record.question_id).endsWith("_abs"),
      retrievedGoldEvidence: false,
      retrievalMode: reader.retrieval?.retrievalMode || "bm25-local",
    };
    summaryRows.push(summaryRow);
    const predictionLine = JSON.stringify({ question_id: record.question_id, hypothesis });
    const evidenceLine = JSON.stringify({
      question_id: record.question_id,
      question_type: record.question_type,
      reader: reader.reader,
      latency_ms: reader.latencyMs,
      abstained: Boolean(reader.abstained),
      hypothesis,
      retrieved_gold_evidence: summaryRow.retrievedGoldEvidence,
      retrieval_mode: reader.retrieval?.retrievalMode || "bm25-local",
      graph: reader.graph,
      evidence,
    });
    await appendFile(outputTarget, `${predictionLine}\n`, "utf8");
    await appendFile(evidenceTarget, `${evidenceLine}\n`, "utf8");
    console.log(`[${index + 1}/${records.length}] ${record.question_id} · ${reader.latencyMs} ms · ${evidence.length} evidence states · ${reader.abstained ? 'abstained' : 'answered'}`);
  }

  console.log(`\nWrote ${options.output}\nWrote ${options.evidenceOutput}`);
}

run().catch((error) => {
  console.error(`LongMemEval V2 adapter failed: ${error.message}`);
  process.exitCode = 1;
});
