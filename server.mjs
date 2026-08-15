import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./lib/security.mjs";
import { buildLongMemEvalReaderPrompt, normalizeLongMemEvalRecord, retrieveLongMemEvidence, normalizeLongMemEvalV2Record, buildLongMemEvalV2ReaderPrompt, normalizeBeamRecord, buildBeamReaderPrompt } from "./lib/longmemeval.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const assetDir = path.join(root, "assets");
const seedPath = path.join(root, "data", "demo-memory.json");

function loadLocalEnv() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

const config = {
  port: Number(process.env.PORT || 3000),
  hydraUrl: (process.env.HYDRADB_HTTP_URL || "http://localhost:8443").replace(/\/$/, ""),
  hydraToken: process.env.HYDRADB_AUTH_TOKEN || "",
  graphId: process.env.HYDRADB_GRAPH_ID || "hydrarecall",
  namespace: process.env.HYDRADB_NAMESPACE || "hydrarecall",
  cellId: process.env.HYDRADB_CELL_ID || "cell-0",
  geminiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.5-flash",
  benchmarkReaderMode: (process.env.BENCHMARK_READER_MODE || "auto").toLowerCase(),
  authMode: process.env.AUTH_MODE || "disabled",
  apiKeyHashes: process.env.HYDRARECALL_API_KEY_HASHES || "",
  corsOrigins: process.env.CORS_ORIGINS || "",
  rateLimitPerMinute: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE || 120),
};

const auth = createAuth({
  mode: config.authMode,
  apiKeyHashes: config.apiKeyHashes,
  corsOrigins: config.corsOrigins,
  maxPerMinute: config.rateLimitPerMinute,
});

let memory = freshMemory();
let graphState = { status: "not-configured", lastSyncAt: null, message: "Awaiting local HydraDB." };
let geminiCooldownUntil = 0;

class GeminiRateLimitError extends Error {
  constructor(retryAfter = 60) {
    super("Gemini rate limit reached.");
    this.name = "GeminiRateLimitError";
    this.status = 429;
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}

function freshMemory() {
  return JSON.parse(readFileSync(seedPath, "utf8"));
}

function json(response, statusCode, payload, request) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...auth.headers(request),
  });
  response.end(JSON.stringify(payload));
}

function text(response, statusCode, payload, type = "text/plain; charset=utf-8", request) {
  response.writeHead(statusCode, { "Content-Type": type, ...auth.headers(request) });
  response.end(payload);
}

async function readJson(request, maxBytes = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function quoteCypher(value) {
  return `'${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")}'`;
}

function graphNodeId(kind, externalId) {
  let hash = 2166136261;
  const input = `${kind}:${externalId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return 1_000_000_000 + (hash >>> 0);
}

function isoDate(value) {
  return new Date(value).toISOString();
}

function relativeDate(value) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function sessionByTurn(turnId) {
  return memory.sessions.find((session) => session.turns.some((turn) => turn.id === turnId));
}

function turnById(turnId) {
  for (const session of memory.sessions) {
    const turn = session.turns.find((item) => item.id === turnId);
    if (turn) return turn;
  }
  return null;
}

function sortedClaims(slot) {
  return memory.claims
    .filter((claim) => claim.slot === slot)
    .sort((a, b) => new Date(a.validAt) - new Date(b.validAt));
}

function evidenceFor(claim) {
  const turn = turnById(claim.sourceTurnId);
  const session = sessionByTurn(claim.sourceTurnId);
  return {
    claimId: claim.id,
    claim: claim.value,
    status: claim.status,
    confidence: claim.confidence,
    validAt: claim.validAt,
    source: {
      sessionId: session?.id,
      sessionNumber: session?.number,
      sessionTitle: session?.title,
      turnId: turn?.id,
      speaker: turn?.role || "user",
      text: turn?.text || "Source turn unavailable.",
    },
  };
}

function findCutoff(question) {
  const match = question.match(/(?:as of|before|in)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})?(?:,?\s*(20\d{2}))?/i);
  if (!match) return null;
  const month = new Date(`${match[1]} 1, 2026`).getMonth();
  const day = match[2] ? Number(match[2]) : 1;
  const year = match[3] ? Number(match[3]) : 2026;
  return new Date(Date.UTC(year, month, day, 23, 59, 59));
}

function selectSlot(question) {
  if (/deploy|release|canary|rollback|payment/.test(question)) return "deployment-policy";
  if (/database|postgres|mongo|data store/.test(question)) return "primary-database";
  if (/accessib|contrast|dashboard/.test(question)) return "accessibility-preference";
  if (/response|summary|concise|writing style/.test(question)) return "response-preference";
  return null;
}

async function answerQuestion(question) {
  const started = performance.now();
  const normalized = question.toLowerCase().trim();
  const slot = selectSlot(normalized);

  if (!slot) {
    return {
      kind: "abstention",
      title: "No evidence found",
      answer: "I can’t determine that from the indexed conversation history.",
      detail: "HydraRecall checked the available claim slots, entity aliases, and evidence paths. No supported claim matches this question, so it abstained instead of guessing.",
      evidence: [],
      timeline: [],
      paths: ["Question → entity & slot resolver → coverage check → no supported Claim"],
      coverage: { checked: ["deployment policy", "primary database", "accessibility preference", "response preference"], result: "No qualifying evidence" },
      retrievalMs: Math.max(1, Math.round(performance.now() - started)),
    };
  }

  const graphClaims = await graphClaimsForSlot(slot);
  const graphClaimIds = graphClaims ? new Set(graphClaims.map((claim) => String(claim.claim_id))) : null;
  const claims = sortedClaims(slot).filter((claim) => !graphClaimIds || graphClaimIds.has(claim.id));
  const cutoff = findCutoff(normalized);
  const historical = cutoff ? claims.filter((claim) => new Date(claim.validAt) <= cutoff) : claims;
  const selected = historical.at(-1);

  if (!selected) {
    return {
      kind: "abstention",
      title: "No evidence at that point in time",
      answer: `I have no supported ${slot.replace(/-/g, " ")} claim before ${relativeDate(cutoff)}.`,
      detail: "The timeline was checked with a valid-time boundary. HydraRecall did not substitute a later fact for a historical answer.",
      evidence: [],
      timeline: claims.map(evidenceFor),
      paths: [`Question → ${slot} → valid_at ≤ ${cutoff.toISOString()} → no Claim`],
      coverage: { checked: [slot], result: "No evidence before requested date" },
      retrievalMs: Math.max(1, Math.round(performance.now() - started)),
    };
  }

  const wantsTimeline = /when|change|history|evolve|timeline/.test(normalized);
  const wantsWhy = /why|reason|because/.test(normalized);
  const evidence = wantsTimeline ? claims.map(evidenceFor) : [evidenceFor(selected)];
  const historicalPrefix = cutoff ? `As of ${relativeDate(cutoff)}, ` : "";
  const reason = selected.reason ? ` This was adopted because ${selected.reason.charAt(0).toLowerCase()}${selected.reason.slice(1)}` : "";

  let answer = `${historicalPrefix}${selected.value}`;
  if (wantsWhy && selected.reason) answer += reason;
  if (wantsTimeline && claims.length > 1) answer += ` It changed ${claims.length - 1} time${claims.length === 2 ? "" : "s"} in the indexed history.`;

  const claimPath = claims
    .filter((claim) => claim.id === selected.id || (wantsTimeline && claim.entity === selected.entity))
    .map((claim) => `${sessionByTurn(claim.sourceTurnId)?.title || "Session"} → Turn → Claim ${claim.id}`);

  if (graphClaims) claimPath.unshift(`HydraDB MATCH (Turn)-[:SUPPORTS]->(Claim) → ${claims.length} version${claims.length === 1 ? "" : "s"}`);

  return {
    kind: "grounded",
    title: cutoff ? "Historical state resolved" : wantsTimeline ? "Version history resolved" : "Grounded answer",
    answer,
    detail: cutoff
      ? "Resolved against valid time, not merely the newest record."
      : "Answer generated only from an evidence-backed claim and its source turn.",
    evidence,
    timeline: claims.map(evidenceFor),
    paths: [...claimPath, selected.supersedes ? `Claim ${selected.id} —SUPERSEDES→ Claim ${selected.supersedes}` : "Claim is currently active"],
    coverage: {
      checked: [slot, selected.entity],
      result: `${claims.length} version${claims.length === 1 ? "" : "s"} with source provenance${graphClaims ? " · live HydraDB graph" : ""}`,
    },
    retrievalMs: Math.max(1, Math.round(performance.now() - started)),
  };
}

async function hydraQuery(query) {
  if (!config.hydraToken) throw new Error("HYDRADB_AUTH_TOKEN is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${config.hydraUrl}/v1/graphs/${encodeURIComponent(config.graphId)}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.hydraToken}`,
        "Content-Type": "application/json",
        "X-Graph-Namespace": config.namespace,
      },
      body: JSON.stringify({ cell_id: config.cellId, consistency: "causal", query }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HydraDB ${response.status}: ${body.slice(0, 180)}`);
    return body ? JSON.parse(body) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function hydraValue(value) {
  if (value && typeof value === "object" && "value" in value) return value.value;
  return value;
}

function hydraRows(payload) {
  const columns = payload?.columns || [];
  return (payload?.rows || []).map((row) => Object.fromEntries(columns.map((column, index) => [column, hydraValue(row[index])])))
}

async function graphClaimsForSlot(slot) {
  if (graphState.status !== "connected") return null;
  try {
    const payload = await hydraQuery(
      `MATCH (t:Turn)-[:SUPPORTS]->(c:Claim) WHERE c.slot = ${quoteCypher(slot)}
       OPTIONAL MATCH (c)-[:SUPERSEDES*]->(older:Claim)
       RETURN c.external_id AS claim_id, c.valid_at AS valid_at, c.status AS status,
              collect(older.external_id) AS supersedes_chain
       ORDER BY valid_at`,
    );
    return hydraRows(payload);
  } catch {
    return null;
  }
}

async function checkHydra() {
  if (!config.hydraToken) return { connected: false, message: "Local token has not been configured yet." };
  try {
    const response = await fetch(`${config.hydraUrl}/healthz`, { signal: AbortSignal.timeout(2_500) });
    return { connected: response.ok, message: response.ok ? "HydraDB graph node is reachable." : `HydraDB returned ${response.status}.` };
  } catch {
    return { connected: false, message: "HydraDB is not reachable yet. Start the Docker stack or use demo mode." };
  }
}

function graphWritesForSession(session) {
  const writes = [];
  const sessionId = graphNodeId("session", session.id);
  for (const turn of session.turns) {
    const turnId = graphNodeId("turn", turn.id);
    writes.push(
      `MERGE (s:Session {id: ${sessionId}, external_id: ${quoteCypher(session.id)}, sequence: ${session.number}, title: ${quoteCypher(session.title)}, occurred_at: ${quoteCypher(session.occurredAt)}})-[:CONTAINS]->(t:Turn {id: ${turnId}, external_id: ${quoteCypher(turn.id)}, role: ${quoteCypher(turn.role)}, text: ${quoteCypher(turn.text)}})`,
    );
    for (const claimId of turn.claims) {
      const claim = memory.claims.find((item) => item.id === claimId);
      if (!claim) continue;
      const claimNodeId = graphNodeId("claim", claim.id);
      writes.push(
        `MERGE (t:Turn {id: ${turnId}})-[:SUPPORTS]->(c:Claim {id: ${claimNodeId}, external_id: ${quoteCypher(claim.id)}, entity: ${quoteCypher(claim.entity)}, slot: ${quoteCypher(claim.slot)}, value: ${quoteCypher(claim.value)}, valid_at: ${quoteCypher(claim.validAt)}, recorded_at: ${quoteCypher(claim.recordedAt)}, status: ${quoteCypher(claim.status)}, confidence: ${Number(claim.confidence || 0)}})`,
      );
      if (claim.supersedes) {
        writes.push(
          `MERGE (newer:Claim {id: ${claimNodeId}})-[:SUPERSEDES]->(older:Claim {id: ${graphNodeId("claim", claim.supersedes)}})`,
        );
      }
    }
  }
  return writes;
}

async function syncMemoryToHydra() {
  const availability = await checkHydra();
  if (!availability.connected) {
    graphState = { status: "offline", lastSyncAt: null, message: availability.message };
    return graphState;
  }

  try {
    let syncedSessions = 0;
    for (const session of memory.sessions) {
      const existing = await hydraQuery(`MATCH (s:Session {external_id: ${quoteCypher(session.id)}}) RETURN s.external_id AS external_id LIMIT 1`);
      if (!existing.rows?.length) {
        for (const query of graphWritesForSession(session)) await hydraQuery(query);
        syncedSessions += 1;
      }
    }
    for (const claim of memory.claims) {
      await hydraQuery(`MATCH (c:Claim {id: ${graphNodeId("claim", claim.id)}}) SET c.status = ${quoteCypher(claim.status)}`);
    }
    const verification = await hydraQuery("MATCH (s:Session)-[:CONTAINS]->(t:Turn)-[:SUPPORTS]->(c:Claim) RETURN s.external_id AS session, t.external_id AS turn, c.external_id AS claim LIMIT 3");
    graphState = {
      status: "connected",
      lastSyncAt: new Date().toISOString(),
      message: `HydraDB verified ${verification.rows?.length || 0} proof paths from the live graph${syncedSessions ? `; synchronized ${syncedSessions} session${syncedSessions === 1 ? "" : "s"}` : ""}.`,
    };
    return graphState;
  } catch (error) {
    graphState = { status: "degraded", lastSyncAt: null, message: error.message };
    return graphState;
  }
}

function fallbackClaim(text, occurredAt, turnId) {
  const normalized = text.toLowerCase();
  let slot = "observed-memory";
  let entity = "conversation";
  if (/deploy|release|canary|rollback/.test(normalized)) {
    slot = "deployment-policy";
    entity = "release-policy";
  } else if (/database|postgres|mongo/.test(normalized)) {
    slot = "primary-database";
    entity = "application-data";
  } else if (/prefer|concise|summary/.test(normalized)) {
    slot = "response-preference";
    entity = memory.person.id;
  }
  return {
    id: `c-${randomUUID().slice(0, 8)}`,
    entity,
    slot,
    value: text.trim(),
    validAt: occurredAt,
    recordedAt: new Date().toISOString(),
    status: "active",
    sourceTurnId: turnId,
    confidence: 0.66,
  };
}

async function extractClaims(text, occurredAt, turnId) {
  if (!config.geminiKey) return { claims: [fallbackClaim(text, occurredAt, turnId)], mode: "deterministic" };
  try {
    const result = await geminiJsonCompletion({
      system: "Extract durable, user-supported memory claims. Return JSON only: {\"claims\":[{\"entity\":string,\"slot\":string,\"value\":string,\"confidence\":number}]}. Do not invent facts. Return an empty list when no durable claim exists.",
      user: text,
      maxTokens: 600,
    });
    const parsed = JSON.parse(geminiText(result) || "{}");
    const claims = (Array.isArray(parsed.claims) ? parsed.claims : [])
      .filter((claim) => claim?.entity && claim?.slot && claim?.value)
      .slice(0, 4)
      .map((claim) => ({
        id: `c-${randomUUID().slice(0, 8)}`,
        entity: String(claim.entity).slice(0, 80),
        slot: String(claim.slot).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80),
        value: String(claim.value).slice(0, 600),
        validAt: occurredAt,
        recordedAt: new Date().toISOString(),
        status: "active",
        sourceTurnId: turnId,
        confidence: Math.min(1, Math.max(0, Number(claim.confidence) || 0.75)),
      }));
    return { claims: claims.length ? claims : [fallbackClaim(text, occurredAt, turnId)], mode: "gemini" };
  } catch {
    return { claims: [fallbackClaim(text, occurredAt, turnId)], mode: "deterministic-fallback" };
  }
}

function geminiText(payload) {
  return (payload?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || "").join("\n").trim();
}

function geminiRetryAfter(response, payload) {
  const headerSeconds = Number(response.headers.get("retry-after"));
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) return headerSeconds;
  const detail = Array.isArray(payload?.error?.details)
    ? payload.error.details.find((item) => typeof item?.retryDelay === "string")
    : null;
  const delaySeconds = Number.parseFloat(detail?.retryDelay || "");
  return Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds : 60;
}

async function geminiJsonCompletion({ system, user, maxTokens }) {
  const attempts = 3;
  let lastError = null;
  const cooldownMs = geminiCooldownUntil - Date.now();
  if (cooldownMs > 0) throw new GeminiRateLimitError(cooldownMs / 1_000);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": config.geminiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.ok) return response.json();
      const payload = await response.json().catch(() => null);
      if (response.status === 429) {
        const retryAfter = geminiRetryAfter(response, payload);
        geminiCooldownUntil = Math.max(geminiCooldownUntil, Date.now() + retryAfter * 1_000);
        throw new GeminiRateLimitError(retryAfter);
      }
      lastError = new Error(`Gemini returned ${response.status}`);
      if (response.status < 500) break;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
      }
      continue;
    } catch (error) {
      if (error instanceof GeminiRateLimitError) throw error;
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 1_000 * 2 ** attempt)));
    }
  }
  throw lastError || new Error("Gemini request failed");
}

/**
 * Query HydraDB for turns that belong to sessions occurring on or before `questionDate`.
 * Returns a Set<turnId> to use as a candidate filter for BM25 re-ranking, or null when
 * the graph is offline or no questionDate is provided.
 *
 * Cypher strategy:
 *   MATCH (s:BenchmarkSession)-[:CONTAINS]->(t:BenchmarkTurn)
 *   WHERE s.occurred_at <= $questionDate
 *   Returns the bounded candidate pool for this question's temporal context.
 */
async function hydraTemporalCandidates(normalized) {
  if (graphState.status !== "connected" || !normalized.questionDate) return null;
  try {
    const quotedDate = quoteCypher(normalized.questionDate);
    const payload = await hydraQuery(
      `MATCH (s:BenchmarkSession)-[:CONTAINS]->(t:BenchmarkTurn) WHERE s.occurred_at <= ${quotedDate} RETURN t.source_session_id AS sessionId, t.external_id AS turnExternalId, s.occurred_at AS occurredAt ORDER BY s.occurred_at DESC LIMIT 500`,
    );
    const rows = hydraRows(payload);
    if (!rows.length) return null;
    // Build a Set of canonical turn IDs matching the normalized record's session structure.
    const candidateSet = new Set();
    for (const row of rows) {
      for (const session of normalized.sessions) {
        if (String(session.id) === String(row.sessionId)) {
          for (const turn of session.turns) candidateSet.add(turn.id);
        }
      }
    }
    return candidateSet.size > 0 ? candidateSet : null;
  } catch {
    return null;
  }
}

async function answerLongMemEval(record, { topK = 8, runId = "longmemeval", syncGraph = false } = {}) {
  const normalized = normalizeLongMemEvalRecord(record);

  // Phase 3: attempt HydraDB temporal candidate pool for questions with a date anchor.
  // Falls back transparently to pure BM25 when the graph is offline.
  const candidateFilter = await hydraTemporalCandidates(normalized);
  const retrievalMode = candidateFilter ? "hydradb-temporal" : "bm25-local";

  const retrieval = retrieveLongMemEvidence(normalized, { topK, candidateFilter, retrievalMode });
  let answer = "I don't know.";
  let abstained = true;
  let reader = "deterministic-abstention";

  if (config.benchmarkReaderMode !== "deterministic" && config.geminiKey && retrieval.evidence.length) {
    try {
      const body = await geminiJsonCompletion({
        system: "You are a rigorous long-term memory reader. Follow the user instructions exactly and return valid JSON only.",
        user: buildLongMemEvalReaderPrompt(normalized, retrieval.evidence),
        maxTokens: 900,
      });
      const parsed = JSON.parse(geminiText(body) || "{}");
      if (typeof parsed.answer === "string" && parsed.answer.trim()) {
        answer = parsed.answer.trim().slice(0, 4_000);
        abstained = Boolean(parsed.abstained);
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

async function answerLongMemEvalV2(record, { topK = 8, runId = "longmemeval-v2", syncGraph = false } = {}) {
  const normalized = normalizeLongMemEvalV2Record(record);
  
  // 1. First, fetch wide candidate set using BM25
  const retrievalMode = "bm25-local";
  const retrieval = retrieveLongMemEvidence(normalized, { topK: 40, candidateFilter: null, retrievalMode });
  
  let finalEvidence = retrieval.evidence.slice(0, topK);
  
  // 2. If HydraDB is online, apply temporal graph resolution using stored turn metadata
  const availability = await checkHydra();
  if (availability.connected && config.geminiKey) {
    try {
      const sessionIds = (normalized.sessions || []).map(s => s.id);
      let allClaims = [];

      for (const sessionId of sessionIds) {
        // Fetch claims stored for this session — using single-hop queries only
        const claimsRes = await hydraQuery(
          `MATCH (c:BenchmarkClaim) WHERE c.external_id STARTS WITH ${quoteCypher(sessionId + ":")} RETURN c.id AS claim_id, c.value AS value, c.valid_at AS timestamp, c.turn_id AS turn_node_id, c.slot AS slot`
        );
        if (claimsRes.rows) allClaims.push(...claimsRes.rows);
      }

      // No supersedes edges yet (ingestion doesn't create them), so just use stored claims
      // to validate that the retrieved turn ids are actually in HydraDB
      const storedTurnIds = new Set(allClaims.map(c => String(c.turn_node_id)));
      
      if (storedTurnIds.size > 0) {
        const filtered = retrieval.evidence.filter(e => {
          const turnId = graphNodeId("benchmark-turn", `${e.sessionId}:${e.turnIndex}`);
          return storedTurnIds.has(String(turnId));
        });
        if (filtered.length > 0) {
          finalEvidence = filtered.slice(0, topK);
        }
      }
    } catch (e) {
      console.error("HydraDB temporal graph resolution failed, falling back to BM25", e);
    }
  }

  let answer = "I don't know.";
  let abstained = true;
  let reader = "deterministic-abstention";
  let reasoning = "";

  if (config.benchmarkReaderMode !== "deterministic" && config.geminiKey && finalEvidence.length) {
    try {
      const body = await geminiJsonCompletion({
        system: "You are a rigorous long-term memory reader. Follow the user instructions exactly and return valid JSON only.",
        user: buildLongMemEvalV2ReaderPrompt(normalized, finalEvidence),
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

async function answerBeam(record, { topK = 8, runId = "beam", syncGraph = false } = {}) {
  const normalized = normalizeBeamRecord(record);
  const retrievalMode = "bm25-local";
  const retrieval = retrieveLongMemEvidence(normalized, { topK, candidateFilter: null, retrievalMode });
  
  let answer = "I don't know.";
  let abstained = true;
  let reader = "deterministic-abstention";
  let reasoning = "";

  if (config.benchmarkReaderMode !== "deterministic" && config.geminiKey && retrieval.evidence.length) {
    try {
      const body = await geminiJsonCompletion({
        system: "You are a rigorous reader model evaluating multi-hop agent memory.",
        user: buildBeamReaderPrompt(normalized, retrieval.evidence),
        maxTokens: 1000,
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

async function syncBenchmarkIngestion(dataset, sessions) {
  const started = performance.now();
  const availability = await checkHydra();
  if (!availability.connected) return { status: "offline", message: availability.message };

  let totalClaims = 0;
  const allWrites = [];

  for (const session of sessions) {
    const sessionId = graphNodeId("benchmark-session", session.id);

    for (const turn of session.turns) {
      const turnId = graphNodeId("benchmark-turn", turn.id);
      const text = (turn.text || turn.content || "").slice(0, 4000);
      
      // Session -> CONTAINS -> Turn
      allWrites.push(
        `MERGE (s:BenchmarkSession {id: ${sessionId}, external_id: ${quoteCypher(session.id)}, dataset: ${quoteCypher(dataset)}})-[:CONTAINS]->(t:BenchmarkTurn {id: ${turnId}, external_id: ${quoteCypher(turn.id)}, role: ${quoteCypher(turn.role)}, occurred_at: ${quoteCypher(turn.occurredAt || turn.createdAt)}})`
      );

      // Use claims pre-extracted by adapter; fall back to simple text chunk
      let claims = turn.claims || [];
      if (!claims.length) {
        claims = [{
          id: `c-fall-${turn.id}`,
          entity: "user",
          slot: "content",
          value: text.slice(0, 500),
          validAt: turn.occurredAt || turn.createdAt,
          confidence: 0.8
        }];
      }
      for (const claim of claims) {
        const claimNodeId = graphNodeId("benchmark-claim", claim.id);
        // Turn -> SUPPORTS -> Claim
        allWrites.push(
          `MERGE (t:BenchmarkTurn {id: ${turnId}})-[:SUPPORTS]->(c:BenchmarkClaim {id: ${claimNodeId}, external_id: ${quoteCypher(claim.id)}, entity: ${quoteCypher(String(claim.entity || "").slice(0, 200))}, slot: ${quoteCypher(String(claim.slot || "").slice(0, 200))}, value: ${quoteCypher(String(claim.value || "").slice(0, 500))}, valid_at: ${quoteCypher(String(claim.validAt || ""))}})`
        );
        totalClaims += 1;
        
        // Claim A -> SUPERSEDES -> Claim B (preserving temporal relationships)
        if (claim.supersedes) {
          const olderClaimNodeId = graphNodeId("benchmark-claim", claim.supersedes);
          allWrites.push(
            `MERGE (newer:BenchmarkClaim {id: ${claimNodeId}})-[:SUPERSEDES]->(older:BenchmarkClaim {id: ${olderClaimNodeId}})`
          );
        }
      }
    }
  }

  // Execute all graph writes concurrently with a controlled worker pool of 30
  const CONCURRENCY = 30;
  for (let i = 0; i < allWrites.length; i += CONCURRENCY) {
    const chunk = allWrites.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map((query) => hydraQuery(query).catch(() => null)));
  }

  const elapsedMs = Math.round(performance.now() - started);
  console.log(`[INGEST] Ingested ${sessions.length} sessions (${totalClaims} claims, ${allWrites.length} edges) in ${elapsedMs}ms`);

  return {
    status: "success",
    sessions: sessions.length,
    claims: totalClaims,
    edges: allWrites.length,
    elapsedMs
  };
}

async function syncBenchmarkEvidence(runId, questionId, question, evidence) {
  const availability = await checkHydra();
  if (!availability.connected) return { status: "offline", message: availability.message, proofs: 0 };
  try {
    const sampleExternalId = `${runId}:${questionId}`;
    const sampleId = graphNodeId("benchmark-sample", sampleExternalId);
    const runNodeId = graphNodeId("benchmark-run", runId);
    await hydraQuery(
      `MERGE (r:BenchmarkRun {id: ${runNodeId}, external_id: ${quoteCypher(runId)}})-[:EVALUATES]->(s:BenchmarkSample {id: ${sampleId}, external_id: ${quoteCypher(sampleExternalId)}, question: ${quoteCypher(question.slice(0, 2_000))}})`
    );
    for (const item of evidence) {
      const sessionExternalId = `${sampleExternalId}:session:${item.sessionId}`;
      const turnExternalId = `${sampleExternalId}:turn:${item.sessionId}:${item.turnIndex}`;
      const sessionId = graphNodeId("benchmark-session", sessionExternalId);
      const turnId = graphNodeId("benchmark-turn", turnExternalId);
      await hydraQuery(
        `MERGE (s:BenchmarkSession {id: ${sessionId}, external_id: ${quoteCypher(sessionExternalId)}, source_session_id: ${quoteCypher(item.sessionId)}, occurred_at: ${quoteCypher(item.occurredAt)}})-[:CONTAINS]->(t:BenchmarkTurn {id: ${turnId}, external_id: ${quoteCypher(turnExternalId)}, role: ${quoteCypher(item.role)}, text: ${quoteCypher(item.content)}, rank: ${item.rank}, score: ${Number(item.score)}})`
      );
      await hydraQuery(
        `MERGE (sample:BenchmarkSample {id: ${sampleId}})-[:RETRIEVED]->(turn:BenchmarkTurn {id: ${turnId}})`
      );
    }
    const verification = await hydraQuery(`MATCH (s:BenchmarkSample {id: ${sampleId}})-[:RETRIEVED]->(t:BenchmarkTurn) RETURN t.external_id AS turn LIMIT 32`);
    return { status: "connected", proofs: verification.rows?.length || 0, sample: sampleExternalId };
  } catch (error) {
    return { status: "degraded", message: "HydraDB proof sync failed.", proofs: 0 };
  }
}

async function ingestSession({ text: rawText, occurredAt: rawDate, title: rawTitle }) {
  const textValue = String(rawText || "").trim();
  if (textValue.length < 8) throw new Error("Add a meaningful session message before ingesting.");
  const occurredAt = rawDate ? isoDate(rawDate) : new Date().toISOString();
  const sessionId = `s-${randomUUID().slice(0, 8)}`;
  const turnId = `t-${randomUUID().slice(0, 8)}`;
  const session = {
    id: sessionId,
    number: memory.sessions.length + 1,
    occurredAt,
    title: String(rawTitle || "New memory event").slice(0, 100),
    turns: [{ id: turnId, role: "user", text: textValue, claims: [] }],
  };
  const extraction = await extractClaims(textValue, occurredAt, turnId);
  for (const claim of extraction.claims) {
    const older = sortedClaims(claim.slot).filter((item) => item.status === "active").at(-1);
    if (older && older.value !== claim.value) {
      older.status = "superseded";
      claim.supersedes = older.id;
    }
    session.turns[0].claims.push(claim.id);
    memory.claims.push(claim);
  }
  memory.sessions.push(session);
  const graph = await syncMemoryToHydra();
  return { session, claims: extraction.claims, extractionMode: extraction.mode, graph };
}

function dashboardSnapshot() {
  return {
    person: memory.person,
    sessions: memory.sessions.map((session) => ({
      id: session.id,
      number: session.number,
      title: session.title,
      occurredAt: session.occurredAt,
      turns: session.turns.length,
    })),
    graph: graphState,
    stats: {
      sessions: memory.sessions.length,
      turns: memory.sessions.reduce((sum, session) => sum + session.turns.length, 0),
      claims: memory.claims.length,
      activeClaims: memory.claims.filter((claim) => claim.status === "active").length,
      supersededClaims: memory.claims.filter((claim) => claim.status === "superseded").length,
    },
  };
}

function requireRole(request, response, role) {
  const decision = auth.authorize(request, role);
  if (decision.ok) return decision.principal;
  if (decision.retryAfter) response.setHeader("Retry-After", String(decision.retryAfter));
  json(response, decision.status, { error: decision.message, code: decision.code }, request);
  return null;
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(request, response, pathname) {
  const isAsset = pathname.startsWith("/assets/");
  const baseDir = isAsset ? assetDir : publicDir;
  const target = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "").replace(/^assets\//, "");
  const resolved = path.resolve(baseDir, target);
  if (!resolved.startsWith(`${baseDir}${path.sep}`) && resolved !== path.join(baseDir, "index.html")) {
    text(response, 403, "Forbidden", "text/plain; charset=utf-8", request);
    return;
  }
  try {
    const details = await stat(resolved);
    if (!details.isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": types[path.extname(resolved)] || "application/octet-stream", ...auth.headers(request) });
    response.end(await readFile(resolved));
  } catch {
    if (!existsSync(path.join(publicDir, "index.html"))) return text(response, 500, "Frontend missing.", "text/plain; charset=utf-8", request);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...auth.headers(request) });
    response.end(await readFile(path.join(publicDir, "index.html")));
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, auth.headers(request));
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      const hydra = await checkHydra();
      return json(response, 200, { ok: true, hydra, geminiConfigured: Boolean(config.geminiKey), geminiModel: config.geminiModel, graph: graphState, auth: auth.publicStatus() }, request);
    }
    if (request.method === "GET" && url.pathname === "/api/auth/status") {
      const decision = auth.authenticate(request);
      return json(response, 200, { ...auth.publicStatus(), authenticated: decision.ok, principal: decision.ok ? { id: decision.principal.id, roles: [...decision.principal.roles] } : null }, request);
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      if (!requireRole(request, response, "reader")) return;
      return json(response, 200, dashboardSnapshot(), request);
    }
    if (request.method === "POST" && url.pathname === "/api/query") {
      if (!requireRole(request, response, "reader")) return;
      const body = await readJson(request);
      return json(response, 200, await answerQuestion(String(body.question || "")), request);
    }
    if (request.method === "POST" && url.pathname === "/api/graph/sync") {
      if (!requireRole(request, response, "writer")) return;
      const graph = await syncMemoryToHydra();
      return json(response, 200, { graph, dashboard: dashboardSnapshot() }, request);
    }
    if (request.method === "POST" && url.pathname === "/api/ingest") {
      if (!requireRole(request, response, "writer")) return;
      const body = await readJson(request);
      return json(response, 201, await ingestSession(body), request);
    }
    if (request.method === "POST" && url.pathname === "/api/reset") {
      if (!requireRole(request, response, "admin")) return;
      memory = freshMemory();
      graphState = { status: "not-configured", lastSyncAt: null, message: "Demo memory reset. Sync when the graph node is ready." };
      return json(response, 200, dashboardSnapshot(), request);
    }
    if (request.method === "GET" && url.pathname === "/api/benchmark/status") {
      if (!requireRole(request, response, "reader")) return;
      try {
        const runDir = path.join(root, "runs", "longmemeval");
        // Find the most recently modified evidence file.
        let latestEvidence = null;
        let latestMtime = 0;
        if (existsSync(runDir)) {
          const { readdir } = await import("node:fs/promises");
          for (const name of await readdir(runDir)) {
            if (!name.endsWith("-evidence.jsonl")) continue;
            const filePath = path.join(runDir, name);
            const details = await stat(filePath).catch(() => null);
            if (details && details.mtimeMs > latestMtime) { latestMtime = details.mtimeMs; latestEvidence = filePath; }
          }
        }
        if (!latestEvidence) return json(response, 200, { available: false, message: "No benchmark run found in runs/longmemeval/." }, request);
        const lines = (await readFile(latestEvidence, "utf8")).split(/\r?\n/).filter(Boolean);
        let total = 0, goldHits = 0, abstentionQs = 0, correctAbstentions = 0, overAbstentions = 0, hydradbCount = 0;
        const readerCounts = {};
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            total += 1;
            if (item.retrieved_gold_evidence) goldHits += 1;
            if (item.retrieval_mode === "hydradb-temporal") hydradbCount += 1;
            const r = item.reader || "unknown";
            readerCounts[r] = (readerCounts[r] || 0) + 1;
            const isAbstQ = String(item.question_id).endsWith("_abs");
            const answered = item.abstained === false || (!item.abstained && !/i don't know/i.test(String(item.hypothesis || "")));
            if (isAbstQ) { abstentionQs += 1; if (!answered) correctAbstentions += 1; }
            else if (!answered) overAbstentions += 1;
          } catch { /* skip */ }
        }
        const answerableTotal = total - abstentionQs;
        return json(response, 200, {
          available: true,
          runFile: path.basename(latestEvidence),
          total,
          recallAtK: answerableTotal ? Number((goldHits / answerableTotal).toFixed(4)) : null,
          abstentionRate: abstentionQs ? Number((correctAbstentions / abstentionQs).toFixed(4)) : null,
          overAbstentionRate: answerableTotal ? Number((overAbstentions / answerableTotal).toFixed(4)) : null,
          hydradbRetrievalRate: total ? Number((hydradbCount / total).toFixed(4)) : null,
          readerBreakdown: readerCounts,
        }, request);
      } catch (err) {
        return json(response, 500, { error: "Could not read benchmark status." }, request);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/benchmark/ingest") {
      if (!requireRole(request, response, "writer")) return;
      const body = await readJson(request, 500_000_000); // Massive dataset support
      const result = await syncBenchmarkIngestion(body.dataset || "default", body.sessions || []);
      return json(response, 200, result, request);
    }
    if (request.method === "POST" && url.pathname === "/api/benchmark/longmemeval") {
      const requestedGraphSync = url.searchParams.get("syncGraph") === "true";
      if (!requireRole(request, response, "writer")) return;
      const body = await readJson(request, 20_000_000);
      const result = await answerLongMemEval(body.record || body, {
        topK: body.topK,
        runId: body.runId,
        syncGraph: requestedGraphSync || Boolean(body.syncGraph),
      });
      return json(response, 200, result, request);
    }
    if (request.method === "POST" && url.pathname === "/api/benchmark/longmemeval-v2") {
      const requestedGraphSync = url.searchParams.get("syncGraph") === "true";
      if (!requireRole(request, response, "writer")) return;
      const body = await readJson(request, 250_000_000); // 250MB for heavy web trajectories
      const result = await answerLongMemEvalV2(body.record || body, {
        topK: body.topK,
        runId: body.runId,
        syncGraph: requestedGraphSync || Boolean(body.syncGraph),
      });
      return json(response, 200, result, request);
    }
    return serveStatic(request, response, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error("SERVER ERROR:", error);
    const rateLimited = error instanceof GeminiRateLimitError;
    if (rateLimited) response.setHeader("Retry-After", String(error.retryAfter));
    const status = rateLimited ? 429 : (error instanceof SyntaxError || /must be an object|need question_id|mismatched haystack|must be an array/i.test(error.message || "") ? 400 : 500);
    return json(response, status, { error: status === 400 ? error.message : rateLimited ? "Gemini capacity is temporarily exhausted. Retry after the supplied delay." : "Unexpected server error." }, request);
  }
});

server.listen(config.port, () => {
  console.log(`HydraRecall is running at http://localhost:${config.port}`);
});
