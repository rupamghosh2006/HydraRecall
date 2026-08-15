const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it", "me", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "with", "would", "you", "your",
]);

// BM25 hyper-parameters (Robertson et al.)
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function asText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

export function tokenize(value) {
  return [...new Set(asText(value).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [])].filter((token) => !stopWords.has(token));
}

export function normalizeLongMemEvalRecord(record) {
  if (!record || typeof record !== "object") throw new Error("Each benchmark record must be an object.");
  const sessionIds = Array.isArray(record.haystack_session_ids) ? record.haystack_session_ids : [];
  const sessionDates = Array.isArray(record.haystack_dates) ? record.haystack_dates : [];
  const rawSessions = Array.isArray(record.haystack_sessions) ? record.haystack_sessions : [];
  if (!record.question_id || !record.question || !rawSessions.length) throw new Error("LongMemEval records need question_id, question, and haystack_sessions.");
  if (sessionIds.length !== rawSessions.length || sessionDates.length !== rawSessions.length) {
    throw new Error(`Record ${record.question_id} has mismatched haystack session arrays.`);
  }

  const sessions = rawSessions.map((rawSession, sessionIndex) => {
    if (!Array.isArray(rawSession)) throw new Error(`Record ${record.question_id} session ${sessionIndex} must be an array of turns.`);
    const turns = rawSession.map((turn, turnIndex) => ({
      id: `${sessionIds[sessionIndex]}:${turnIndex}`,
      sessionId: String(sessionIds[sessionIndex]),
      sessionIndex,
      turnIndex,
      occurredAt: String(sessionDates[sessionIndex]),
      role: String(turn?.role || "unknown"),
      content: asText(turn?.content),
      hasAnswer: Boolean(turn?.has_answer),
    })).filter((turn) => turn.content.trim());
    return { id: String(sessionIds[sessionIndex]), occurredAt: String(sessionDates[sessionIndex]), sessionIndex, turns };
  });

  return {
    questionId: String(record.question_id),
    questionType: String(record.question_type || "unknown"),
    question: String(record.question),
    questionDate: record.question_date ? String(record.question_date) : null,
    answerSessionIds: Array.isArray(record.answer_session_ids) ? record.answer_session_ids.map(String) : [],
    sessions,
  };
}

export function normalizeLongMemEvalV2Record(record) {
  if (!record || typeof record !== "object") throw new Error("Each benchmark record must be an object.");
  const rawTrajectories = Array.isArray(record.trajectories) ? record.trajectories : [];
  if (!record.question_id || !record.question || !rawTrajectories.length) throw new Error("LongMemEval V2 records need question_id, question, and trajectories.");

  const sessions = rawTrajectories.map((traj, sessionIndex) => {
    if (!Array.isArray(traj.states)) throw new Error(`Record ${record.question_id} trajectory ${sessionIndex} must have states array.`);
    const turns = traj.states.map((state, turnIndex) => {
      let content = '';
      if (state.url) content += `[URL: ${state.url}]\n`;
      if (state.accessibility_tree) content += `[Observation: ${state.accessibility_tree}]\n`;
      if (state.thought) content += `[Thought: ${state.thought}]\n`;
      if (state.action) content += `[Action: ${state.action}]\n`;
      return {
        id: `${traj.id}:${turnIndex}`,
        sessionId: String(traj.id),
        sessionIndex,
        turnIndex,
        occurredAt: "unknown",
        role: "system",
        content: asText(content).trim(),
        hasAnswer: false,
      };
    }).filter((turn) => turn.content.trim());
    return { id: String(traj.id), occurredAt: "unknown", sessionIndex, turns };
  });

  return {
    questionId: String(record.question_id),
    questionType: String(record.question_type || "unknown"),
    question: String(record.question),
    questionDate: null,
    answerSessionIds: [],
    sessions,
  };
}

// ── BM25 corpus IDF ───────────────────────────────────────────────────────────

/**
 * Compute per-token IDF over all turns in the record (Robertson IDF variant).
 * IDF(t) = log((N - df + 0.5) / (df + 0.5) + 1)
 */
function buildCorpusIdf(sessions) {
  const documentFreq = new Map();
  let totalTurns = 0;
  let totalLen = 0;
  for (const session of sessions) {
    for (const turn of session.turns) {
      totalTurns += 1;
      const tokens = tokenize(turn.content);
      totalLen += tokens.length;
      for (const token of new Set(tokens)) documentFreq.set(token, (documentFreq.get(token) || 0) + 1);
    }
  }
  const avgLen = totalTurns > 0 ? totalLen / totalTurns : 1;
  const idf = new Map();
  for (const [token, df] of documentFreq) {
    idf.set(token, Math.log((totalTurns - df + 0.5) / (df + 0.5) + 1));
  }
  return { idf, avgLen };
}

/** BM25 score for one turn against the query token list. */
function bm25Score(turnTokens, queryTokens, idf, avgLen) {
  const turnLen = turnTokens.length;
  const termFreq = new Map();
  for (const token of turnTokens) termFreq.set(token, (termFreq.get(token) || 0) + 1);
  let score = 0;
  const matched = [];
  for (const token of queryTokens) {
    const tf = termFreq.get(token) || 0;
    if (tf === 0 || !idf.has(token)) continue;
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (turnLen / avgLen));
    score += idf.get(token) * (numerator / denominator);
    matched.push(token);
  }
  return { score, matched };
}

// ── Phrase-match bonus (secondary signal) ─────────────────────────────────────

function phraseMatches(question, text) {
  const normalizedQuestion = question.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
  const normalizedText = text.toLowerCase();
  const words = normalizedQuestion.split(/\s+/).filter((word) => word.length >= 5 && !stopWords.has(word));
  let matches = 0;
  for (let index = 0; index < words.length - 1; index += 1) {
    if (normalizedText.includes(`${words[index]} ${words[index + 1]}`)) matches += 1;
  }
  return matches;
}

// ── Main retrieval function ───────────────────────────────────────────────────

export function retrieveLongMemEvidence(record, options = {}) {
  const normalized = record.sessions ? record : normalizeLongMemEvalRecord(record);
  const topK = Math.min(32, Math.max(1, Number(options.topK || 8)));
  // candidateFilter: Set<turnId> from HydraDB temporal Cypher; null = consider all turns.
  const candidateFilter = options.candidateFilter instanceof Set ? options.candidateFilter : null;
  const retrievalMode = options.retrievalMode || "bm25-local";

  const questionTokens = tokenize(normalized.question);
  const { idf, avgLen } = buildCorpusIdf(normalized.sessions);
  const scored = [];

  for (const session of normalized.sessions) {
    for (const turn of session.turns) {
      if (candidateFilter && !candidateFilter.has(turn.id)) continue;
      const turnTokens = tokenize(turn.content);
      const { score: bm25, matched } = bm25Score(turnTokens, questionTokens, idf, avgLen);
      const phraseBonus = phraseMatches(normalized.question, turn.content) * 0.5;
      const roleBonus = turn.role === "assistant" ? 0.1 : 0;
      const totalScore = bm25 + phraseBonus + roleBonus;
      if (totalScore > 0) scored.push({ ...turn, score: Number(totalScore.toFixed(4)), matchedTerms: matched.slice(0, 12) });
    }
  }

  scored.sort((left, right) => right.score - left.score || right.sessionIndex - left.sessionIndex || right.turnIndex - left.turnIndex);
  const selected = scored.slice(0, topK);
  return {
    evidence: selected.map((turn, index) => ({ ...turn, rank: index + 1 })),
    totalTurns: normalized.sessions.reduce((sum, session) => sum + session.turns.length, 0),
    queryTerms: questionTokens,
    retrievalMode,
  };
}

export function buildLongMemEvalReaderPrompt(normalized, evidence) {
  const evidenceText = evidence.map((item) => [
    `[Evidence ${item.rank}] Session ${item.sessionId} · ${item.occurredAt} · ${item.role}`,
    item.content,
  ].join("\n")).join("\n\n");
  return [
    "You answer questions using only the provided conversation evidence.",
    "Chronology and supersession rules:",
    "  1. Evidence items are shown with session dates. Treat the date as when the fact became valid.",
    "  2. If two evidence items cover the same topic but different dates, the LATER one supersedes the EARLIER one — this mirrors a SUPERSEDES relationship in the underlying knowledge graph.",
    "  3. EXCEPTION: if the question asks about a specific past date or time window, apply only evidence valid on or before that date. Do not leak later facts into a historical answer.",
    "  4. If no evidence covers the topic at all, or all covering evidence postdates the requested time, respond with the abstention JSON.",
    "  5. Never invent facts. Never use outside knowledge.",
    "Respond ONLY with valid JSON — no explanations or citations outside JSON.",
    "Abstain: {\"answer\":\"I don't know.\",\"abstained\":true}",
    "Answer: {\"answer\":\"concise answer\",\"abstained\":false}",
    `Question date: ${normalized.questionDate || "not provided"}`,
    `Question: ${normalized.question}`,
    "Evidence:",
    evidenceText || "No relevant evidence was retrieved.",
  ].join("\n\n");
}

export function buildLongMemEvalV2ReaderPrompt(normalized, evidence) {
  const evidenceText = evidence.map((item) => [
    `[Evidence ${item.rank}] Trajectory ${item.sessionId} · State ${item.turnIndex}`,
    item.content,
  ].join("\n")).join("\n\n");
  return [
    "You answer questions using only the provided web trajectory evidence.",
    "Each piece of evidence contains a URL, an Observation (accessibility tree), an Agent Thought, and an Action.",
    "Never invent facts. Never use outside knowledge.",
    "Respond ONLY with valid JSON — no explanations or citations outside JSON.",
    "Abstain: {\"answer\":\"I don't know.\",\"abstained\":true}",
    "Answer: {\"answer\":\"concise answer\",\"abstained\":false}",
    `Question: ${normalized.question}`,
    "Evidence:",
    evidenceText || "No relevant evidence was retrieved.",
  ].join("\n\n");
}


/**
 * Determine whether a response is an abstention.
 * Primary signal: explicit `abstainedFlag` boolean from the Gemini JSON response.
 * Fallback: regex over answer text for legacy/dry-run records that predate the flag.
 */
export function isAbstentionAnswer(answer, abstainedFlag) {
  if (typeof abstainedFlag === "boolean") return abstainedFlag;
  return /^(i (do not|don't) know|not found|insufficient (evidence|information)|cannot determine|the information is not (available|present)|based on the (provided|available) evidence[^.]*cannot)[.!\s]*$/i.test(String(answer || "").trim());
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]);
}

function blankGroup() {
  return { questions: 0, answerable: 0, abstentionQuestions: 0, retrievedEvidence: 0, appropriateAbstentions: 0, overAbstentions: 0, latencyMs: [], hydradbRetrievals: 0 };
}

function summarizeGroup(group) {
  const retrievalDenominator = group.answerable;
  return {
    questions: group.questions,
    answerable: group.answerable,
    abstentionQuestions: group.abstentionQuestions,
    retrievalRecallAtK: retrievalDenominator ? Number((group.retrievedEvidence / retrievalDenominator).toFixed(4)) : null,
    abstentionResponseRate: group.abstentionQuestions ? Number((group.appropriateAbstentions / group.abstentionQuestions).toFixed(4)) : null,
    overAbstentionRate: group.answerable ? Number((group.overAbstentions / group.answerable).toFixed(4)) : null,
    hydradbRetrievalRate: group.questions ? Number((group.hydradbRetrievals / group.questions).toFixed(4)) : null,
    meanLatencyMs: group.latencyMs.length ? Math.round(group.latencyMs.reduce((sum, item) => sum + item, 0) / group.latencyMs.length) : null,
    p50LatencyMs: percentile(group.latencyMs, 0.5),
    p95LatencyMs: percentile(group.latencyMs, 0.95),
  };
}

export function buildLongMemEvalMetrics(results, topK) {
  const overall = blankGroup();
  const byQuestionType = new Map();
  for (const item of results) {
    const group = byQuestionType.get(item.questionType) || blankGroup();
    byQuestionType.set(item.questionType, group);
    for (const target of [overall, group]) {
      target.questions += 1;
      target.latencyMs.push(Number(item.latencyMs || 0));
      if (item.isAbstention) target.abstentionQuestions += 1;
      else target.answerable += 1;
      if (item.retrievedGoldEvidence) target.retrievedEvidence += 1;
      if (item.retrievalMode === "hydradb-temporal") target.hydradbRetrievals += 1;
      // Pass explicit abstained flag so the boolean from the reader JSON takes precedence.
      if (isAbstentionAnswer(item.hypothesis, item.abstained)) {
        if (item.isAbstention) target.appropriateAbstentions += 1;
        else target.overAbstentions += 1;
      }
    }
  }
  return {
    topK,
    overall: summarizeGroup(overall),
    byQuestionType: Object.fromEntries([...byQuestionType.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, group]) => [type, summarizeGroup(group)])),
  };
}

export function renderLongMemEvalReport({ inputPath, outputPath, evidencePath, runId, endpoint, metrics, sampleCount, dryRun, graphSync }) {
  const rows = Object.entries(metrics.byQuestionType).map(([type, metric]) => `| ${type} | ${metric.questions} | ${metric.retrievalRecallAtK ?? "n/a"} | ${metric.abstentionResponseRate ?? "n/a"} | ${metric.hydradbRetrievalRate ?? "n/a"} | ${metric.p50LatencyMs ?? "n/a"} | ${metric.p95LatencyMs ?? "n/a"} |`).join("\n");
  const overall = metrics.overall;
  return `# HydraRecall LongMemEval adapter report

> Generated ${new Date().toISOString()}. This is a retrieval and latency report, not an official LongMemEval QA score.

## Run

| Field | Value |
| --- | --- |
| Run ID | ${runId} |
| Input | \`${inputPath}\` |
| Hypotheses | \`${outputPath}\` |
| Evidence trace | \`${evidencePath}\` |
| Endpoint | ${endpoint} |
| Questions processed | ${sampleCount} |
| Retrieval top-k | ${metrics.topK} |
| Dry run | ${dryRun ? "yes" : "no"} |
| HydraDB proof sync | ${graphSync ? "requested" : "off"} |

## Adapter metrics

- Session retrieval Recall@${metrics.topK} (BM25): **${overall.retrievalRecallAtK ?? "n/a"}** (official evidence session IDs; abstention items excluded)
- Abstention response rate: **${overall.abstentionResponseRate ?? "n/a"}** (on official abstention items only)
- Over-abstention rate: **${overall.overAbstentionRate ?? "n/a"}** (answerable items answered with abstention)
- HydraDB temporal retrieval rate: **${overall.hydradbRetrievalRate ?? "n/a"}** (questions served via graph-bounded candidate pool)
- End-to-end query latency: p50 **${overall.p50LatencyMs ?? "n/a"} ms**, p95 **${overall.p95LatencyMs ?? "n/a"} ms**

| Question type | Questions | Recall@${metrics.topK} | Abstention rate | HydraDB retrieval | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows || "| none | 0 | n/a | n/a | n/a | n/a | n/a |"}

## Correctness evaluation

Run the official LongMemEval evaluator against the hypotheses file to obtain judge-scored QA accuracy. The adapter deliberately does not invent an accuracy number; its local report measures evidence recovery, abstention behavior, HydraDB retrieval rate, and latency only.
`;
}
