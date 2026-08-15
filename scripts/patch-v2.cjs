const fs = require('fs');
let code = fs.readFileSync('server.mjs', 'utf8');

const targetRegex = /async function answerLongMemEvalV2\(record.*?return \{\n.*?hypothesis: abstained.*?graph,\n\s+\};\n\}/s;

const replacement = `async function answerLongMemEvalV2(record, { topK = 8, runId = "longmemeval-v2", syncGraph = false } = {}) {
  const normalized = normalizeLongMemEvalV2Record(record);
  const dataset = "longmemeval-v2";

  // Temporal Graph Retrieval (Cypher)
  // 1. Find claims that match question terms
  const terms = normalized.question.toLowerCase().split(/\\s+/).filter(w => w.length > 3).slice(0, 10);
  let cypherQuery = \`MATCH (s:BenchmarkSession {dataset: \${quoteCypher(dataset)}})-[:CONTAINS]->(t:BenchmarkTurn)-[:SUPPORTS]->(c:BenchmarkClaim) WHERE c.value IS NOT NULL\`;
  if (terms.length) {
    cypherQuery += \` AND (\` + terms.map(term => \`toLower(c.value) CONTAINS \${quoteCypher(term)} OR toLower(c.entity) CONTAINS \${quoteCypher(term)}\`).join(" OR ") + \`)\`;
  }
  // 2. Traverse SUPERSEDES to get the active chain
  cypherQuery += \`
    OPTIONAL MATCH (c)-[:SUPERSEDES*]->(older:BenchmarkClaim)
    RETURN c.external_id AS claim_id, c.entity AS entity, c.value AS value, c.valid_at AS timestamp, t.external_id AS turn_id, collect(older.external_id) AS superseded_claims
    ORDER BY c.valid_at DESC
    LIMIT \${topK}
  \`;
  
  let candidateClaims = [];
  try {
    const payload = await hydraQuery(cypherQuery);
    candidateClaims = hydraRows(payload);
  } catch (e) {
    console.error("HydraDB query failed", e);
  }

  // Format into evidence packet
  const evidencePacket = candidateClaims.map(c => ({
    id: c.claim_id,
    claim: c.value,
    entity: c.entity,
    timestamp: c.timestamp,
    turnId: c.turn_id,
    supersededClaims: Array.isArray(c.superseded_claims) ? c.superseded_claims : []
  }));

  let answer = "I don't know based on the available memory.";
  let abstained = true;
  let confidence = "low";
  let reasoning = "";
  let reader = "deterministic-abstention";
  let supportingClaimIds = [];

  if (config.benchmarkReaderMode !== "deterministic" && config.geminiKey && evidencePacket.length) {
    try {
      const prompt = \`You are evaluating an agent's memory capability.
Answer the following question strictly based on the provided temporal evidence claims.
Do NOT use outside knowledge. If the claims are insufficient, you MUST set "abstained": true.

[QUESTION]
\${normalized.question}
[END QUESTION]

[EVIDENCE CLAIMS]
\${evidencePacket.map(e => \`Claim ID: \${e.id}\\nClaim: \${e.claim}\\nEntity: \${e.entity}\\nTimestamp: \${e.timestamp}\\nSource Turn: \${e.turnId}\\nSupersedes: \${e.supersededClaims.join(", ")}\`).join("\\n\\n")}
[END EVIDENCE]

Output valid JSON with keys: "abstained" (boolean), "answer" (string), "confidence" (string: high/medium/low), "reasoning" (string), "supporting_claim_ids" (array of strings).\`;

      const body = await geminiJsonCompletion({
        system: "You are a rigorous temporal memory reasoning model.",
        user: prompt,
        maxTokens: 1500,
      });
      const parsed = JSON.parse(geminiText(body) || "{}");
      if (typeof parsed.answer === "string" && parsed.answer.trim()) {
        answer = parsed.answer.trim();
        abstained = Boolean(parsed.abstained);
        confidence = parsed.confidence || "medium";
        reasoning = parsed.reasoning || "";
        reader = "gemini-temporal-reader";
        if (Array.isArray(parsed.supporting_claim_ids)) {
           supportingClaimIds = parsed.supporting_claim_ids;
        }
      }
    } catch (error) {
      if (error instanceof GeminiRateLimitError) throw error;
      reader = "deterministic-fallback";
    }
  }

  return {
    question_id: normalized.questionId,
    answer,
    abstained,
    confidence,
    retrieved_claim_ids: evidencePacket.map(e => e.id),
    supporting_claim_ids: supportingClaimIds,
    source_turns: evidencePacket.map(e => e.turnId),
    temporal_resolution: {
      query_time: "latest",
      selected_state: "latest active claims",
      superseded_claims: evidencePacket.flatMap(e => e.supersededClaims)
    },
    evidence_sufficient: !abstained,
    retrieval_count: evidencePacket.length,
    evidence_tokens: 0,
    final_input_tokens: 0,
    reader
  };
}`;

if (targetRegex.test(code)) {
    code = code.replace(targetRegex, replacement);
    fs.writeFileSync('server.mjs', code, 'utf8');
    console.log("Successfully replaced answerLongMemEvalV2");
} else {
    console.error("Regex did not match");
}
