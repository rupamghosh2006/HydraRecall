import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import * as readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(root);

function usage() {
  console.log(`
HydraRecall BEAM adapter

Usage:
  node scripts/beam-adapter.mjs [options]

Options:
  --endpoint <url>       HydraRecall API base URL (default: http://127.0.0.1:3000)
  --api-key <key>        API key; prefer HYDRARECALL_API_KEY environment variable
  --dataset <path>       BEAM JSONL (default: data/beam/conversations-128k.jsonl)
  --output <path>        JSONL output
  --evidence-output <path>  Detailed retrieval trace JSONL output
  --run-id <id>          Stable benchmark run identifier
  --top-k <n>            Evidence turns per question (default: 8, max: 32)
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
  const runFolder = path.join(projectRoot, "runs", "beam");
  const runId = options.runId || `beam-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  return {
    ...options,
    runId,
    dataset: options.dataset || path.join(projectRoot, "data", "beam", "conversations-128k.jsonl"),
    output: options.output || path.join(runFolder, `${runId}-hypotheses.jsonl`),
    evidenceOutput: options.evidenceOutput || path.join(runFolder, `${runId}-evidence.jsonl`),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadResumeState(outputPath) {
  const completed = new Set();
  if (existsSync(outputPath)) {
    const content = await readFile(outputPath, "utf8");
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      try { completed.add(String(JSON.parse(line).question_id)); } catch { /* skip */ }
    }
  }
  return completed;
}

async function callReader(options, record, attempt = 1) {
  const endpoint = `${options.endpoint.replace(/\/$/, "")}/api/benchmark/beam${options.syncHydra ? "?syncGraph=true" : ""}`;
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

async function run() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) return usage();
  const options = defaultPaths(parsed);

  if (!existsSync(options.dataset)) {
    console.error(`Dataset not found at ${options.dataset}`);
    process.exit(1);
  }

  const outputTarget = path.resolve(options.output);
  const evidenceTarget = path.resolve(options.evidenceOutput);
  await Promise.all([outputTarget, evidenceTarget].map((target) => mkdir(path.dirname(target), { recursive: true })));

  const completed = options.resume ? await loadResumeState(outputTarget) : new Set();
  if (completed.size) console.log(`Resuming: ${completed.size} completed question(s) already in ${options.output}`);

  const fileStream = createReadStream(options.dataset, { encoding: "utf8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let processed = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    const convId = item.conversation_id;
    const chat = item.chat;
    const probes = item.probing_questions || {};

    for (const [probeType, questions] of Object.entries(probes)) {
      for (const [idx, q] of questions.entries()) {
        if (options.limit && processed >= options.limit) break;
        
        const qId = `${convId}-${probeType}-${idx}`;
        if (options.resume && completed.has(qId)) continue;
        
        const record = {
          question_id: qId,
          question: q.question,
          sessions: chat
        };
        
        let reader;
        if (options.dryRun) {
          console.log(`[${processed + 1}] ${qId} · skipped (dry-run)`);
          processed += 1;
          continue;
        } else {
          if (processed > 0 && options.paceMs > 0) await sleep(options.paceMs);
          reader = await callReader(options, record);
        }

        const evidenceLine = JSON.stringify({
          question_id: qId,
          question_type: probeType,
          latency_ms: reader.latencyMs,
          abstained: Boolean(reader.abstained),
          hypothesis: reader.hypothesis,
          reasoning: reader.reasoning,
          retrieval_mode: reader.retrieval?.retrievalMode || "bm25-local",
          evidence: reader.retrieval?.evidence || [],
        });
        const hypothesisLine = JSON.stringify({ question_id: qId, hypothesis: reader.hypothesis });
        
        await appendFile(outputTarget, `${hypothesisLine}\n`, "utf8");
        await appendFile(evidenceTarget, `${evidenceLine}\n`, "utf8");
        
        console.log(`[${processed + 1}] ${qId} · ${reader.latencyMs} ms`);
        processed += 1;
      }
    }
    if (options.limit && processed >= options.limit) break;
  }
  console.log(`\nDone. Processed ${processed} questions.`);
}

run().catch((error) => {
  console.error(`BEAM adapter failed: ${error.message}`);
  process.exitCode = 1;
});
