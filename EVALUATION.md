# LongMemEval adapter

HydraRecall includes a reproducible adapter for [LongMemEval](https://github.com/xiaowu0162/LongMemEval). It deliberately keeps three concerns separate:

1. **Official hypotheses** — a strict JSONL file containing only `question_id` and `hypothesis`.
2. **Evidence trace** — selected session/turn evidence, retrieval ranks, latency, reader mode, and optional HydraDB proof references.
3. **Local report** — retrieval Recall@k, abstention behavior, and latency. It does **not** mislabel these as judge-scored QA accuracy.

The original benchmark has 500 timestamped evaluation instances. Its `S` split is approximately 115k tokens / 40 history sessions per question; that is the primary target for the adapter.

## 1. Download the dataset

Download the official cleaned JSON release into an ignored directory:

```powershell
New-Item -ItemType Directory -Force data/longmemeval | Out-Null
Invoke-WebRequest https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json -OutFile data/longmemeval/longmemeval_s_cleaned.json
```

Do not commit the benchmark data or generated run files. Both `data/longmemeval/` and `runs/` are ignored.

## 2. Validate the adapter locally

This confirms record validation, time-stamped normalization, lexical candidate retrieval, JSONL generation, and reporting without calling an LLM:

```powershell
npm.cmd run eval:longmem:dry
```

It writes a mini-fixture result under `runs/longmemeval/`.

## 3. Run against HydraRecall

Start the app, configure `GEMINI_API_KEY` for the grounded Gemini Flash reader, then run:

```powershell
npm.cmd run eval:longmem -- --input data/longmemeval/longmemeval_s_cleaned.json --top-k 8 --run-id hydrarecall-lme-s
```

`--pace-ms` inserts a minimum delay between live reader calls, and `--resume` skips `question_id`s already present in the output file so an interrupted run can be restarted without losing progress. Both the hypotheses and evidence files are appended per question, so a killed run never loses completed answers.

Set `BENCHMARK_READER_MODE=deterministic` when you only want to profile retrieval and graph evidence without sending reader calls to Gemini. The report will make any resulting over-abstention visible.

For production `AUTH_MODE=api-key`, provide a **writer** key only through an environment variable:

```powershell
$env:HYDRARECALL_API_KEY = "hr_your_scoped_key"
npm.cmd run eval:longmem -- --input data/longmemeval/longmemeval_s_cleaned.json --top-k 8 --run-id hydrarecall-lme-s
Remove-Item Env:HYDRARECALL_API_KEY
```

The adapter removes the gold answer, gold evidence labels, and `has_answer` markers before sending a query to the reader. Gold labels are used only locally for retrieval Recall@k after the response returns.

### Optional HydraDB proof graph

Add `--sync-hydra` to write only the selected evidence path for each question to the private HydraDB graph:

```powershell
npm.cmd run eval:longmem -- --input data/longmemeval/longmemeval_s_cleaned.json --top-k 8 --run-id hydrarecall-lme-s --sync-hydra
```

Each selected proof is represented as:

```text
(BenchmarkRun)-[:EVALUATES]->(BenchmarkSample)-[:RETRIEVED]->(BenchmarkTurn)
(BenchmarkSession)-[:CONTAINS]->(BenchmarkTurn)
```

This keeps the benchmark retrieval trace inspectable without copying an entire long history into every reader prompt.

## 4. Produce official QA scores

The adapter output is compatible with LongMemEval’s official evaluation format. Follow the upstream evaluator setup, then run its `evaluate_qa.py` against the generated `*-hypotheses.jsonl` file. The official evaluator uses its own configured judge model and writes the judge labels/log.

HydraRecall’s generated report is intentionally limited to evidence retrieval and latency. Cite the official evaluator’s output—not the local report—for final QA accuracy claims.

## 4a. Gemini judge score

The upstream evaluator’s official `gpt-4o` / `gpt-4o-mini` judge requires an `OPENAI_API_KEY`. For a Gemini Flash judge score, HydraRecall includes the same upstream answer-check prompts and aggregation logic with Gemini’s OpenAI-compatible judge endpoint:

```powershell
# Python 3.11+ with: pip install openai tqdm backoff numpy
$env:GEMINI_API_KEY = "your_gemini_key"
python scripts/longmemeval-judge-gemini.py gemini-3.5-flash runs/longmemeval/<run>-hypotheses.jsonl data/longmemeval/longmemeval_s_cleaned.json
```

The script writes per-question labels and prints overall/per-type accuracy. Label this result as a **Gemini-judged score**, not an official OpenAI-judged LongMemEval score.

## Operating-point notes

- Use `--top-k 8` first; evaluate `4`, `8`, `12`, and `16` as separate runs to build an accuracy-latency curve.
- Keep a stable `--run-id` for repeated graph-proof inspection.
- Run an explicit abstention audit: compare `_abs` items in the trace with the returned `hypothesis` before attempting leaderboard claims.
- The current lexical planner is deterministic; the grounded reader is Gemini Flash. Replacing the planner with a graph or learned retriever changes an experiment and should receive a new run ID.
