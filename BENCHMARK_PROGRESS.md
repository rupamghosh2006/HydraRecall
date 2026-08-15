# HydraRecall Benchmark Progress

> Status: **LongMemEval-S Complete · LongMemEval V2 In Progress** · Recorded 15–16 August 2026 (IST)

HydraRecall is evaluated as a temporal, proof-carrying memory layer for the **Memory and context retrieval** track.

```text
                    HydraRecall
                         │
          ┌──────────────┴──────────────┐
          │                             │
   LongMemEval-S                  LongMemEval V2
      500 Q                         451 Q
        │                              │
     61.0%                        BM25: 27.05%
        │                              │
        │                        HydraRecall: Pending
        │                              │
        └──────────────┬───────────────┘
                       ↓
                 BEAM: Pending
```

*61.0% on LongMemEval-S, with particularly strong performance on knowledge updates (87.18%), while V2 is being used to test whether the temporal graph continues to outperform lexical retrieval on larger, web-derived trajectories.*

---

## 1. LongMemEval-S — Completed Results

All 500 questions in the LongMemEval-S dataset (~115k token context / 40 sessions per question) were evaluated and officially graded using the Gemini QA Judge.

| Category | Score | Notes |
| :--- | :--- | :--- |
| **Overall Accuracy** | **61.0%** | Full 500-question evaluation |
| `single-session-assistant` | **92.86%** | High-precision single-turn recall |
| `knowledge-update` | **87.18%** | **SUPERSEDES** temporal chain resolution |
| `single-session-user` | **80.00%** | Direct preference / assertion recall |
| `temporal-reasoning` | **66.17%** | Time-bounded valid-time retrieval |
| `multi-session` | **27.07%** | Cross-session multi-hop synthesis |
| `single-session-preference` | **16.67%** | Implicit preference extraction |

---

## 2. LongMemEval V2 — In Progress

| Item | Status |
| :--- | :--- |
| Dataset | LongMemEval V2 |
| Required trajectories | 200 |
| Evaluation questions | 451 |
| Total turns/states | 5,095 |
| Temporal graph ingestion | **Working** |
| Graph edges | 10,190+ |
| Ingestion failures | 0 |
| HydraDB write strategy | Controlled global concurrency pool |
| Retrieval | HydraDB temporal graph + fallback |
| Top-k evidence states | 8 |
| BM25 fallback baseline | **27.05%** |
| HydraRecall V2 accuracy | **Pending** |

### V2 Baseline

Before enabling the temporal graph ingestion, the BM25 fallback achieved:

**27.05% overall accuracy**

> [!NOTE]
> This is treated strictly as a baseline, not as HydraRecall's final V2 score.
> The baseline highlights the expected weakness of lexical retrieval on changing facts, particularly in dynamic environments.

### V2 Evaluation Goal

The current run evaluates the full HydraRecall pipeline:

```text
LongMemEval trajectory
        ↓
Session / Turn / Claim extraction
        ↓
HydraDB temporal graph
        ↓
SUPERSEDES resolution
        ↓
Top-k evidence retrieval
        ↓
Evidence-bounded answer / abstention
        ↓
Gemini judge
```

The primary comparison:

| System | Overall Accuracy |
| :--- | :--- |
| BM25 fallback (Baseline) | **27.05%** |
| HydraRecall temporal graph | **Pending** |

---

## 3. HydraDB Ingestion Scaling

The initial implementation issued one HydraDB write per graph edge, resulting in approximately 10,190 write operations for the 200 required V2 trajectories. Initial sequential ingestion was not practical at this scale due to distributed consensus round-trips.

We therefore introduced a controlled global concurrency pool while preserving the graph model and temporal relationships.

### Validation

| Trajectories | Turns | Claims | Graph Edges | Result |
| ---: | ---: | ---: | ---: | :--- |
| 0 | 0 | 0 | 0 | **Success** (89ms) |
| 1 | 50 | 50 | 100 | **Success** (26.8s) |
| 5 | 217 | 217 | 434 | **Success** (100.2s) |
| 20 | 638 | 638 | 1,276 | **Success** (~4.6m) |
| 200 | 5,095 | 5,095 | 10,190 | **Success** (Batch ingestion) |

Graph semantics remain:

```text
Session ──CONTAINS──> Turn
Turn ──SUPPORTS──> Claim
newer Claim ──SUPERSEDES──> older Claim
```

---

## 4. Benchmark Integrity

HydraRecall strictly distinguishes between:

- **Graph-backed answers**: Evidence retrieved from HydraDB's temporal graph.
- **Deterministic fallbacks**: Locally generated evidence when the upstream reader/provider is unavailable.
- **BM25 fallback**: Lexical retrieval used when graph synchronization is unavailable.
- **Abstentions**: Answers intentionally withheld when sufficient evidence cannot be established in indexed history.

Fallback outputs are never presented as HydraDB-backed results.

Transport failures and upstream rate limits (such as Gemini 429s) are handled with explicit backoff cooldowns and surfaced with retry windows rather than being silently converted into memory abstentions.

---

## 5. Evaluation Configuration

| Parameter | Value |
| :--- | :--- |
| Datasets | LongMemEval-S (500 Q) / LongMemEval V2 (451 Q) |
| Retrieval top-k | 8 |
| Reader | Gemini Flash (`gemini-3.1-flash-lite` / `gemini-3.5-flash`) |
| Judge | Gemini QA Judge (`scripts/longmemeval-judge-gemini.py`) |
| Memory backend | HydraDB (Docker image `ghcr.io/hydra-db/hydradb:latest`) |
| Consistency mode | `causal` / `strong` |
| Fallback | Local BM25 + deterministic tiebreaker |
| Graph model | `Session → Turn → Claim` |
| Temporal relation | `SUPERSEDES` |
| Adapter scripts | `scripts/longmemeval-adapter.mjs`, `scripts/longmemeval-v2-adapter.mjs` |
| Evaluation dates | 15–16 August 2026 |
