# HydraRecall Benchmark Progress Report

> **Current State**: LongMemEval-S **Completed** · LongMemEval V2 **In Progress / Pending Final Score** · BEAM **Not Started**  
> **Evaluation Window**: 15–16 August 2026  
> **Target Track**: Memory and Context Retrieval / Best Use of HydraDB

---

## Navigation & Table of Contents

- [Executive Summary](#executive-summary)
  - [Overall Benchmark Status](#overall-benchmark-status)
- [1. LongMemEval-S — Completed Results](#1-longmemeval-s--completed-results)
  - [Category Breakdown](#key-findings)
- [2. LongMemEval V2 — Current Status](#2-longmemeval-v2--current-status)
  - [V2 Baseline (27.05% BM25)](#v2-baseline)
  - [V2 Evaluation Pipeline](#v2-evaluation-pipeline)
- [3. HydraDB Write Scaling & Ingestion Engineering](#3-hydradb-write-scaling--ingestion-engineering)
  - [Empirical Concurrency Profiling Table](#empirical-concurrency-profiling)
  - [Ingestion Engineering Conclusions](#ingestion-engineering-conclusions)
- [4. Engineering Fixes Implemented for V2 Ingestion](#4-engineering-fixes-implemented-for-v2-ingestion)
- [5. OpenCypher Integration Constraints](#5-opencypher-integration-constraints)
  - [Supported Syntax](#supported-syntax)
  - [Unsupported Patterns](#unsupported-patterns-discovered--handled)
- [6. V2 Retrieval Disambiguation](#6-v2-retrieval-disambiguation)
- [7. Benchmark Integrity Rules](#7-benchmark-integrity-rules)
- [8. Milestone Roadmap](#8-milestone-roadmap)
- [9. Current Position](#9-current-position)
- [Related Documents: Evaluation Guide (EVALUATION.md)](EVALUATION.md) · [Deployment Guide (DEPLOYMENT.md)](DEPLOYMENT.md)

---

## Executive Summary

HydraRecall is a temporal, proof-carrying memory layer built on **HydraDB**. It structures agent conversation history into a temporal knowledge graph:

```text
Session ───────[:CONTAINS]───────> Turn
Turn ──────────[:SUPPORTS]───────> Claim
newer Claim ───[:SUPERSEDES]─────> older Claim
```

The system retrieves facts according to temporal validity rather than purely lexical or semantic similarity, maintaining end-to-end provenance traces and supporting evidence-bounded abstention.

### Overall Benchmark Status

| Benchmark | Questions | Context Scale | Baseline | HydraRecall | Status |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **LongMemEval-S** | 500 | ~115k tokens / 40 sessions | — | **61.0%** | **COMPLETED** |
| **LongMemEval V2** | 451 | 200 trajectories / 5,095 turns | **27.05%** (BM25) | **Pending** | **IN PROGRESS** |
| **BEAM** | — | Enterprise workflows | — | **Pending** | **NOT STARTED** |

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

---

## 1. LongMemEval-S — Completed Results

All 500 questions across 6 categories in LongMemEval-S were evaluated and officially judged using the Gemini QA Judge.

| Category | Score | Primary Mechanism Evaluated |
| :--- | :---: | :--- |
| **Overall Accuracy** | **61.0%** | **500-question benchmark suite** |
| `single-session-assistant` | **92.86%** | High-precision single-turn recall |
| `knowledge-update` | **87.18%** | **SUPERSEDES** temporal chain resolution |
| `single-session-user` | **80.00%** | Direct assertion and preference recall |
| `temporal-reasoning` | **66.17%** | Time-bounded valid-time retrieval |
| `multi-session` | **27.07%** | Cross-session multi-hop synthesis |
| `single-session-preference` | **16.67%** | Implicit preference extraction |

### Key Findings
- **87.18% on `knowledge-update`** and **66.17% on `temporal-reasoning`** provide strong evidence that explicit temporal claim representation (`validAt` intervals and `SUPERSEDES` edges) effectively resolves changing factual state across long interaction histories.
- HydraRecall does not claim universal superiority over alternative memory architectures without explicit comparative runs; rather, these results validate that graph-structured temporal invalidation resolves memory contradiction.

[↑ Back to Navigation](#navigation--table-of-contents)

---

## 2. LongMemEval V2 — Current Status

LongMemEval V2 tests memory over complex, multi-step web agent trajectories.

| Metric | Target / Specification |
| :--- | :--- |
| **Dataset** | LongMemEval V2 |
| **Required Trajectories** | 200 |
| **Evaluation Questions** | 451 |
| **Total Turns / States** | 5,095 |
| **Total Claims** | 5,095 |
| **Expected Base Graph Edges** | **10,190** (5,095 `CONTAINS` + 5,095 `SUPPORTS`) |
| **Temporal Relations** | `SUPERSEDES` edges connecting invalidating claims |
| **HydraDB Ingestion Pipeline** | Controlled global concurrency (25 workers) |
| **BM25 Fallback Baseline** | **27.05%** |
| **HydraRecall V2 Accuracy** | **Pending** (evaluation and official judging in progress) |

### V2 Baseline
Before enabling temporal graph ingestion, the local BM25 lexical fallback achieved:
$$\mathbf{27.05\% \text{ overall accuracy}}$$

> [!NOTE]
> This is strictly a lexical retrieval baseline, not HydraRecall's graph-backed score. The baseline demonstrates the vulnerability of pure term-matching on dynamic web trajectories where page states mutate frequently.

### V2 Evaluation Pipeline

```text
LongMemEval V2 trajectory
        ↓
Session / Turn / Claim extraction
        ↓
HydraDB temporal graph
        ↓
SUPERSEDES resolution
        ↓
Candidate retrieval (pool size N)
        ↓
Top-k = 8 evidence states
        ↓
Evidence-bounded reader (Gemini Flash)
        ↓
Answer / abstention
        ↓
Gemini QA Judge
```

[↑ Back to Navigation](#navigation--table-of-contents)

---

## 3. HydraDB Write Scaling & Ingestion Engineering

### Empirical Concurrency Profiling
Initial ingestion appeared to hang because pushing 200 trajectories required approximately **10,190 individual HydraDB write requests** across distributed consensus and disk commits.

We performed empirical profiling of HydraDB single-hop `MERGE` write throughput across concurrency levels 1 to 50 (30 queries per level):

| Concurrency Level | Total Time (30 writes) | Throughput | p50 Latency | p95 Latency | Success Rate | Error Rate |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | 206.2 s | **0.15 writes/sec** | 6,749 ms | 8,948 ms | 100% (30/30) | 0% |
| **5** | 54.2 s | **0.55 writes/sec** | 7,906 ms | 12,492 ms | 100% (30/30) | 0% |
| **10** | 46.0 s | **0.65 writes/sec** | 14,841 ms | 15,714 ms | 100% (30/30) | 0% |
| **20** | 20.8 s | **1.44 writes/sec** | 12,117 ms | 13,895 ms | 100% (30/30) | 0% |
| **30** | 21.5 s | **1.39 writes/sec** | 11,276 ms | 20,714 ms | 100% (30/30) | 0% |
| **40** | 21.8 s | **1.37 writes/sec** | 11,487 ms | 21,015 ms | 100% (30/30) | 0% |
| **50** | 23.5 s | **1.27 writes/sec** | 14,636 ms | 22,716 ms | 100% (30/30) | 0% |

### Ingestion Engineering Conclusions
1. **HydraDB Write Ceiling**: HydraDB's effective write throughput on a single-node local store peaks at **~1.4 writes/sec** around concurrency 20–25.
2. **Queueing Behavior**: Increasing concurrency beyond 30 does not improve throughput and causes SlateDB WAL compaction queues to build up, increasing p95 latency from ~13s to >20s.
3. **Controlled Concurrency**: HydraRecall configures a global worker pool of **25 workers** to maximize throughput while avoiding queue saturation.

[↑ Back to Navigation](#navigation--table-of-contents)

---

## 4. Engineering Fixes Implemented for V2 Ingestion

1. **`hydraQuery` Timeout Increased to 45 Seconds**:
   - *Previous*: 6,000ms hardcoded timeout.
   - *Root Cause*: When concurrency increased, HydraDB causal writes took 8–14 seconds to commit, triggering premature client-side aborts (`This operation was aborted`).
   - *Fix*: Raised internal timeout to 45,000ms.
2. **Turn-Bounded Batching**:
   - *Previous*: Fixed 20 trajectories per batch (generating up to 2,400 writes and taking >25 minutes per request, violating adapter timeout limits).
   - *Fix*: Partitioned trajectories dynamically by turn count (~120 turns / ~240 graph writes per batch), guaranteeing each batch finishes in ~2.5 minutes.
3. **Explicit Batch Lifecycle Tracking**:
   - Every batch is assigned a deterministic status: `SUCCESS`, `FAILED`, or `TIMEOUT`.
4. **Fail-Closed Benchmark Gate**:
   - The adapter enforces a zero-tolerance gate:
     $$\text{successful\_batches} == \text{total\_batches} \quad \land \quad \text{failed\_batches} == 0 \quad \land \quad \text{timed\_out\_batches} == 0$$
   - The 451-question evaluation is strictly blocked from starting if any batch fails or times out.
5. **Live Pre-Evaluation Graph Count Verification (`GET /api/benchmark/graph-stats`)**:
   - Before question `[1/451]` begins, the adapter queries HydraDB directly to verify stored edges:
     - `CONTAINS` edges: 5,095
     - `SUPPORTS` edges: 5,095
     - Base edges: **10,190**
   - If HydraDB's internal counts do not match expected totals, execution halts immediately.
6. **Real-Time Write Progress Reporting**:
   - Added live console reporting:
     ```text
     [INGEST] 1,240 / 10,190 writes complete (12.2%) · 1.4 writes/sec · active: 25 · errors: 0
     ```
7. **Retrieval-Source Tracking**:
   - Every question prediction record and evidence trace explicitly logs its retrieval provenance:
     - `graph-backed`: Evidence retrieved and verified through HydraDB's temporal graph.
     - `mixed`: Graph-grounded turns supplemented with fallback evidence.
     - `fallback`: Pure local BM25 fallback.

[↑ Back to Navigation](#navigation--table-of-contents)

---

## 5. OpenCypher Integration Constraints

During integration with HydraDB's query engine, the following grammar and transport constraints were verified:

### Supported Syntax
- Strict single-hop `MERGE` edge patterns:
  ```cypher
  MERGE (source:LabelA {id: 1, ...})-[:RELATION]->(target:LabelB {id: 2, ...})
  ```
- Exact count queries:
  ```cypher
  MATCH (s:BenchmarkSession)-[:CONTAINS]->(t:BenchmarkTurn) RETURN count(*) AS contains_count
  ```

### Unsupported Patterns (Discovered & Handled)
- **Multi-statement Cypher** (`query1; query2`): Returns `HTTP 400: query transport requires exactly one Cypher statement`.
- **Multi-clause MERGE** (`MERGE ... MERGE ...`): Returns `HTTP 400: MERGE with following clauses is not executable in Query engine`.
- **Standalone Node MERGE** (`MERGE (n:Label {id: 1})`): Returns `HTTP 400: only one-hop edge patterns are executable in Query engine MERGE`.
- **Batch query payload arrays**: Returns `HTTP 404 / 422`.

The HydraRecall engine adapts to these constraints by emitting individual one-hop `MERGE` operations through the managed concurrency pool.

[↑ Back to Navigation](#navigation--table-of-contents)

---

## 6. V2 Retrieval Disambiguation

- **Candidate Pool Size ($N$)**: The initial broad candidate retrieval stage collects up to 40 candidate states from the trajectory haystack.
- **Top-$k$ Final Evidence ($\le 8$)**: Only the top $k=8$ evidence states (verified by graph presence and relevance) are passed to the Gemini reader prompt.
- **Clarification**: Earlier logs showed `32 evidence states` because the adapter reported the initial candidate pool size rather than the final top-$k$ reader evidence. Both fields are now cleanly separated in logs and output traces:
  ```text
  [1/451] q_102 · 1420 ms · 8 evidence states (top-k 8, pool 32) · [graph-backed] · answered
  ```

[↑ Back to Navigation](#navigation--table-of-contents)

---

## 7. Benchmark Integrity Rules

HydraRecall enforces rigorous benchmark separation:
1. **Graph-Backed Retrieval**: Provenance-linked to stored turns and claims in HydraDB.
2. **Mixed Retrieval**: Combines graph-backed assertions with supplementary context.
3. **BM25 Fallback**: Lexical retrieval without graph verification.
4. **Deterministic Fallback**: Local baseline when upstream providers are unreachable.
5. **Intentional Abstention**: Model determines evidence is insufficient to answer reliably.

Transport exceptions and provider rate limits (HTTP 429) are handled with explicit backoff cooldowns and are **never** conflated with model abstentions.

The benchmark is **fail-closed**: a partial graph cannot proceed to evaluation or produce an official score.

[↑ Back to Navigation](#navigation--table-of-contents)

---

## 8. Milestone Roadmap

```text
[x] 1. LongMemEval-S Evaluation (500 Q) — COMPLETED (61.0% overall, 87.18% knowledge updates)
[x] 2. LongMemEval V2 Ingestion & Fail-Closed Integrity Pipeline — COMPLETED
[ ] 3. LongMemEval V2 451-Question Evaluation — IN PROGRESS / PENDING
[ ] 4. Official Gemini QA Judging on V2 Hypotheses — PENDING
[ ] 5. Analyze V2 Score vs BM25 27.05% Baseline — PENDING
[ ] 6. Analyze Breakdown by Retrieval Source (graph-backed vs mixed vs fallback) — PENDING
[ ] 7. Analyze Temporal / Knowledge-Update Accuracy on V2 Web Trajectories — PENDING
[ ] 8. Analyze Abstention Precision and Calibration — PENDING
[ ] 9. BEAM Evaluation — PENDING / NOT STARTED
[ ] 10. Targeted Graph Optimizations Based on V2 Failure Analysis — POST-V2
```

[↑ Back to Navigation](#navigation--table-of-contents)

---

## 9. Current Position

All infrastructure, OpenCypher translation rules, controlled concurrency pooling, and fail-closed validation gates are fully operational. The next decisive milestone is completing the clean 451-question LongMemEval V2 evaluation run against the verified 10,190-edge HydraDB temporal graph.

[↑ Back to Navigation](#navigation--table-of-contents)
