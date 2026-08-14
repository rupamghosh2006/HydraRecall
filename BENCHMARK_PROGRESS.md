# HydraRecall benchmark progress — draft

> Status: **paused for Gemini Free Tier quota recovery** · Recorded 14 August 2026 (IST)

This is a transparent progress report, not a final benchmark result. HydraRecall is being evaluated as a temporal, proof-carrying memory layer for the **Memory and context retrieval** track.

## Current LongMemEval-S checkpoint

| Item | Status |
| --- | --- |
| Dataset | LongMemEval-S (`longmemeval_s_cleaned.json`) |
| Total questions | 500 |
| Prediction/evidence records written | 355 |
| Gemini-grounded reader outputs | 234 |
| Historical deterministic fallbacks | 121 |
| Official abstention items encountered | 18 |
| Untouched questions | 145 |
| LongMemEval V2 | Not started |
| BEAM | Not started |
| Final QA accuracy | Not available |

The 355 prediction records and 355 matching evidence records are checkpointed locally. The adapter resumes by question ID, so completed work is not repeated after a pause.

## Why this is not a score yet

The first benchmark attempt ran into Gemini Free Tier HTTP 429 responses. At that time, an upstream provider error could be converted into a deterministic `I don't know.` fallback. That behavior produced 121 non-model answers and makes the partial output unsuitable for an accuracy or abstention claim.

The benchmark is therefore paused rather than reported selectively. A clean run must:

1. Rerun the 121 fallback question IDs after quota recovery.
2. Complete the remaining 145 questions.
3. Produce the retrieval/latency report from clean evidence traces.
4. Run the Gemini judge using LongMemEval's upstream answer-check prompts.

## Rate-limit safeguards added

HydraRecall now treats a Gemini 429 as a retriable provider state instead of silently turning it into an abstention:

- The API returns HTTP 429 and a `Retry-After` value to the benchmark adapter.
- The local provider client enters cooldown and does not send extra upstream calls during that window.
- The adapter adds a five-second safety margin after a provider retry window.
- The reusable full-run script defaults to a 15-second pace for the Gemini Free Tier.

These safeguards prevent transport/provider failures from being counted as memory abstentions.

## What the final report will measure

The completed LongMemEval report will include:

- Gemini-judged QA accuracy, including per-question-type results.
- Session retrieval Recall@8.
- Correct abstention rate on official unanswerable questions.
- Over-abstention rate on answerable questions.
- End-to-end p50 and p95 latency.
- Evidence/provenance traces: retrieved session, turn, claim, timestamp, and graph proof path.

The Gemini score will be labeled **Gemini-judged**, not an upstream OpenAI-judge score.

## HydraRecall's memory model

HydraRecall models memory as a temporal graph:

```text
Session ──CONTAINS──> Turn ──SUPPORTS──> Claim
newer Claim ──SUPERSEDES──> older Claim
```

Each claim includes an entity, slot, value, valid time, recorded time, source turn, confidence, and active/superseded state. This supports chronological retrieval, knowledge updates, provenance, and evidence-bounded abstention. The live app verifies graph proof paths against HydraDB.

## Next benchmark milestones

1. Resume after the Gemini rate limit resets and replace all historical fallback outputs.
2. Complete LongMemEval-S and publish the generated evidence/latency report.
3. Run the Gemini QA judge and publish clearly qualified accuracy results.
4. Add LongMemEval V2 and BEAM adapters.
5. Extend the graph with canonical entity/alias nodes, conflict edges, and general multi-hop traversal.

Until these milestones are complete, this document should be treated as an implementation and reproducibility checkpoint—not as a leaderboard submission.
