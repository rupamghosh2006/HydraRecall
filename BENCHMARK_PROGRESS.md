# HydraRecall Benchmark Progress — LongMemEval-S Complete

> Status: **Completed** · Recorded 15 August 2026 (IST)

HydraRecall is being evaluated as a temporal, proof-carrying memory layer for the **Memory and context retrieval** track.

## Previous Checkpoint (During Gemini Quota Pause)

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

## LongMemEval-S Final Results

We successfully processed all 500 questions in the LongMemEval-S dataset using our Graph RAG / BM25 hybrid fallback architecture, generating evidence-backed hypotheses. These were officially graded using the provided Gemini Judge script.

| Category | Score |
| --- | --- |
| **Overall Accuracy** | **61.0%** |
| `single-session-assistant` | 92.86% |
| `knowledge-update` | 87.18% |
| `single-session-user` | 80.0% |
| `temporal-reasoning` | 66.17% |
| `multi-session` | 27.07% |
| `single-session-preference` | 16.67% |

## HydraRecall's Memory Model

HydraRecall models memory as a temporal graph:

```text
Session ──CONTAINS──> Turn ──SUPPORTS──> Claim
newer Claim ──SUPERSEDES──> older Claim
```

Each claim includes an entity, slot, value, valid time, recorded time, source turn, confidence, and active/superseded state. This supports chronological retrieval, knowledge updates (scoring 87% accuracy!), provenance, and evidence-bounded abstention. The live app verifies graph proof paths against HydraDB.

## Rate-Limit and Fallback Safeguards Added

HydraRecall handles upstream errors (like a Gemini 429) gracefully:
- The API returns HTTP 429 and a `Retry-After` value to the benchmark adapter.
- The local provider client enters cooldown and does not send extra upstream calls during that window.
- The adapter adds a five-second safety margin after a provider retry window.
- If the Graph DB sync falls behind or 404s, HydraRecall safely falls back to a custom local BM25 + Tiebreaker index across the 115k token context without throwing fatal errors.

These safeguards prevent transport/provider failures from being incorrectly counted as memory abstentions.

## Next Benchmark Milestones

1. ~~Resume after the Gemini rate limit resets and replace all historical fallback outputs.~~ **Done**
2. ~~Complete LongMemEval-S and publish the generated evidence/latency report.~~ **Done**
3. ~~Run the Gemini QA judge and publish clearly qualified accuracy results.~~ **Done**
4. ~~Add LongMemEval V2 and BEAM adapters.~~ **LongMemEval V2 Adapter implemented and data downloaded! (BEAM adapter pending)**
5. Extend the graph with canonical entity/alias nodes, conflict edges, and general multi-hop traversal.
