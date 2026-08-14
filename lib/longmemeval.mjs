const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it", "me", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who", "with", "would", "you", "your",
]);

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

export function retrieveLongMemEvidence(record, options = {}) {
  const normalized = record.sessions ? record : normalizeLongMemEvalRecord(record);
  const topK = Math.min(32, Math.max(1, Number(options.topK || 8)));
  const questionTokens = tokenize(normalized.question);
  const questionTokenSet = new Set(questionTokens);
  const scored = [];

  for (const session of normalized.sessions) {
    for (const turn of session.turns) {
      const turnTokens = tokenize(turn.content);
      const overlap = turnTokens.filter((token) => questionTokenSet.has(token));
      const exactPhraseCount = phraseMatches(normalized.question, turn.content);
      const score = overlap.length * 4 + exactPhraseCount * 3 + (turn.role === "assistant" ? 0.15 : 0);
      if (score > 0) scored.push({ ...turn, score: Number(score.toFixed(2)), matchedTerms: overlap.slice(0, 12) });
    }
  }

  scored.sort((left, right) => right.score - left.score || right.sessionIndex - left.sessionIndex || right.turnIndex - left.turnIndex);
  const selected = scored.slice(0, topK);
  return {
    evidence: selected.map((turn, index) => ({ ...turn, rank: index + 1 })),
    totalTurns: record.sessions ? record.sessions.reduce((sum, session) => sum + session.turns.length, 0) : normalized.sessions.reduce((sum, session) => sum + session.turns.length, 0),
    queryTerms: questionTokens,
  };
}

export function buildLongMemEvalReaderPrompt(normalized, evidence) {
  const evidenceText = evidence.map((item) => [
    `[Evidence ${item.rank}] Session ${item.sessionId} · ${item.occurredAt} · ${item.role}`,
    item.content,
  ].join("\n")).join("\n\n");
  return [
    "You answer questions using only the provided conversation evidence.",
    "Preserve chronology: a newer supported update replaces an older state only when it explicitly changes it.",
    "If the evidence does not establish the answer, respond with JSON {\"answer\":\"I don't know.\",\"abstained\":true}.",
    "Otherwise respond with JSON {\"answer\":\"concise answer\",\"abstained\":false}. Do not add explanations or citations outside JSON.",
    `Question date: ${normalized.questionDate || "not provided"}`,
    `Question: ${normalized.question}`,
    "Evidence:",
    evidenceText || "No relevant evidence was retrieved.",
  ].join("\n\n");
}

export function isAbstentionAnswer(answer) {
  return /^(i (do not|don't) know|not found|insufficient (evidence|information)|cannot determine)[.!\s]*$/i.test(String(answer || "").trim());
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]);
}

function blankGroup() {
  return { questions: 0, answerable: 0, abstentionQuestions: 0, retrievedEvidence: 0, appropriateAbstentions: 0, overAbstentions: 0, latencyMs: [] };
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
      if (isAbstentionAnswer(item.hypothesis)) {
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
  const rows = Object.entries(metrics.byQuestionType).map(([type, metric]) => `| ${type} | ${metric.questions} | ${metric.retrievalRecallAtK ?? "n/a"} | ${metric.abstentionResponseRate ?? "n/a"} | ${metric.p50LatencyMs ?? "n/a"} | ${metric.p95LatencyMs ?? "n/a"} |`).join("\n");
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

- Session retrieval Recall@${metrics.topK}: **${overall.retrievalRecallAtK ?? "n/a"}** (official evidence session IDs; abstention items excluded)
- Abstention response rate: **${overall.abstentionResponseRate ?? "n/a"}** (on official abstention items only)
- Over-abstention rate: **${overall.overAbstentionRate ?? "n/a"}** (answerable items answered with abstention)
- End-to-end query latency: p50 **${overall.p50LatencyMs ?? "n/a"} ms**, p95 **${overall.p95LatencyMs ?? "n/a"} ms**

| Question type | Questions | Retrieval Recall@${metrics.topK} | Abstention response | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows || "| none | 0 | n/a | n/a | n/a | n/a |"}

## Correctness evaluation

Run the official LongMemEval evaluator against the hypotheses file to obtain judge-scored QA accuracy. The adapter deliberately does not invent an accuracy number; its local report measures evidence recovery, abstention behavior, and latency only.
`;
}
