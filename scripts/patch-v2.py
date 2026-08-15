import sys

with open('server.mjs', 'r', encoding='utf-8') as f:
    lines = f.readlines()

start_idx = None
end_idx = None
for i, line in enumerate(lines):
    if line.strip().startswith('async function answerLongMemEvalV2'):
        start_idx = i
    if start_idx is not None and i > start_idx and line.strip() == '}':
        end_idx = i
        break

if start_idx is None or end_idx is None:
    print(f"Not found: start={start_idx}, end={end_idx}")
    sys.exit(1)

print(f"Replacing lines {start_idx+1} to {end_idx+1}")

new_func = '''async function answerLongMemEvalV2(record, { topK = 8, runId = "longmemeval-v2", syncGraph = false } = {}) {
  const normalized = normalizeLongMemEvalV2Record(record);
  const retrievalMode = "bm25-local";
  const retrieval = retrieveLongMemEvidence(normalized, { topK, candidateFilter: null, retrievalMode });

  let answer = "I don't know.";
  let abstained = true;
  let reader = "deterministic-abstention";
  let reasoning = "";

  if (config.benchmarkReaderMode !== "deterministic" && config.geminiKey && retrieval.evidence.length) {
    try {
      const body = await geminiJsonCompletion({
        system: "You are a rigorous long-term memory reader. Follow the user instructions exactly and return valid JSON only.",
        user: buildLongMemEvalV2ReaderPrompt(normalized, retrieval.evidence),
        maxTokens: 900,
      });
      const parsed = JSON.parse(geminiText(body) || "{}");
      if (typeof parsed.answer === "string" && parsed.answer.trim()) {
        answer = parsed.answer.trim().slice(0, 4_000);
        abstained = Boolean(parsed.abstained);
        reasoning = parsed.reasoning || "";
        reader = "gemini-grounded-reader";
      }
    } catch (error) {
      if (error instanceof GeminiRateLimitError) throw error;
      reader = "deterministic-fallback";
    }
  }

  const graph = syncGraph ? await syncBenchmarkEvidence(runId, normalized.questionId, normalized.question, retrieval.evidence) : { status: "not-requested" };
  return {
    hypothesis: abstained ? "I don't know." : answer,
    abstained,
    reasoning,
    reader,
    retrieval: {
      totalTurns: retrieval.totalTurns,
      queryTerms: retrieval.queryTerms,
      retrievalMode: retrieval.retrievalMode,
      evidence: retrieval.evidence.map(({ content, ...item }) => ({ ...item, excerpt: content.slice(0, 900) })),
    },
    graph,
  };
}
'''

new_lines = lines[:start_idx] + [new_func + '\n'] + lines[end_idx+1:]

with open('server.mjs', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print("Done.")
