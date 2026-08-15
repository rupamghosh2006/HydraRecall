/**
 * rerun-fallbacks.mjs
 *
 * Strips all "deterministic-fallback" and "deterministic-abstention" records
 * from the hypotheses and evidence JSONL files so that --resume will re-queue
 * them for a clean Gemini-grounded pass.
 *
 * Usage:
 *   node scripts/rerun-fallbacks.mjs \
 *     --hypotheses runs/longmemeval/hydrarecall-gemini-lme-s-hypotheses.jsonl \
 *     --evidence   runs/longmemeval/hydrarecall-gemini-lme-s-evidence.jsonl
 *
 * After running this, execute the standard adapter --resume command to
 * reprocess only the stripped question IDs.
 */

import { readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--hypotheses") opts.hypotheses = argv[++i];
    else if (argv[i] === "--evidence") opts.evidence = argv[++i];
    else if (argv[i] === "--dry-run") opts.dryRun = true;
  }
  if (!opts.hypotheses || !opts.evidence) {
    console.error("Usage: node scripts/rerun-fallbacks.mjs --hypotheses <file> --evidence <file> [--dry-run]");
    process.exit(1);
  }
  return opts;
}

async function readJsonlLines(filePath) {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf8");
  return content.split(/\r?\n/).filter(Boolean);
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const hypPath  = path.resolve(opts.hypotheses);
  const evPath   = path.resolve(opts.evidence);
  const dryRun   = Boolean(opts.dryRun);

  // --- Read evidence file, identify fallback question IDs ---
  const evLines = await readJsonlLines(evPath);
  const fallbackIds = new Set();
  for (const line of evLines) {
    try {
      const item = JSON.parse(line);
      const reader = String(item.reader || "");
      if (reader === "deterministic-fallback" || reader === "deterministic-abstention") {
        fallbackIds.add(String(item.question_id));
      }
    } catch { /* skip malformed */ }
  }

  if (!fallbackIds.size) {
    console.log("✅ No deterministic-fallback or deterministic-abstention records found. Nothing to rerun.");
    return;
  }

  console.log(`\n📋 Found ${fallbackIds.size} fallback question(s) to rerun:\n`);
  for (const id of [...fallbackIds].slice(0, 10)) console.log(`   ${id}`);
  if (fallbackIds.size > 10) console.log(`   … and ${fallbackIds.size - 10} more`);

  if (dryRun) {
    console.log("\n[dry-run] Would strip these IDs from both JSONL files. Re-run without --dry-run to apply.");
    return;
  }

  // --- Back up originals ---
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(hypPath, `${hypPath}.bak-${ts}`);
  await copyFile(evPath,  `${evPath}.bak-${ts}`);
  console.log(`\n💾 Backed up originals with timestamp ${ts}`);

  // --- Strip fallback lines from hypotheses ---
  const hypLines   = await readJsonlLines(hypPath);
  const hypKept    = hypLines.filter((line) => {
    try { return !fallbackIds.has(String(JSON.parse(line).question_id)); }
    catch { return true; }
  });
  await writeFile(hypPath, hypKept.join("\n") + (hypKept.length ? "\n" : ""), "utf8");
  console.log(`✂️  Hypotheses: removed ${hypLines.length - hypKept.length} lines (${hypKept.length} kept)`);

  // --- Strip fallback lines from evidence ---
  const evKept = evLines.filter((line) => {
    try { return !fallbackIds.has(String(JSON.parse(line).question_id)); }
    catch { return true; }
  });
  await writeFile(evPath, evKept.join("\n") + (evKept.length ? "\n" : ""), "utf8");
  console.log(`✂️  Evidence:   removed ${evLines.length - evKept.length} lines (${evKept.length} kept)`);

  console.log(`\n✅ Done. ${fallbackIds.size} question(s) stripped and ready for --resume.\n`);
  console.log("▶  Resume command:\n");
  console.log(`node scripts/longmemeval-adapter.mjs \\`);
  console.log(`  --input data/longmemeval/longmemeval_s_cleaned.json \\`);
  console.log(`  --top-k 8 --run-id hydrarecall-gemini-lme-s --resume \\`);
  console.log(`  --pace-ms 15000 --max-retries 20 \\`);
  console.log(`  --output ${path.relative(root, hypPath).replace(/\\/g, "/")} \\`);
  console.log(`  --evidence-output ${path.relative(root, evPath).replace(/\\/g, "/")} \\`);
  console.log(`  --report runs/longmemeval/hydrarecall-gemini-lme-s-report.md`);
}

run().catch((err) => { console.error(`rerun-fallbacks failed: ${err.message}`); process.exitCode = 1; });
