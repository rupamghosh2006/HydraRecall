# HydraRecall

> Proof-carrying, temporal memory for AI agents — powered by self-hosted HydraDB.

HydraRecall converts conversations into an append-only graph of sessions, turns, claims, and state changes. It answers from source-backed evidence, reconstructs what was true at a requested time, and abstains when the history contains no supporting claim.

![HydraRecall interface](assets/logo.png)

## Why it is graph-native

```text
Session ──CONTAINS──> Turn ──SUPPORTS──> Claim
                                           │
                                  SUPERSEDES│
                                           ▼
                                      prior Claim
```

Every claim retains both its `valid_at` time (when it became true) and `recorded_at` time (when the agent learned it). A change writes a new claim and a `SUPERSEDES` relationship instead of overwriting history.

This gives the agent four useful guarantees:

- **Current state:** resolve the latest supported claim for an entity and slot.
- **Time travel:** resolve the same claim chain as of a past valid time.
- **Change reasoning:** traverse the immutable `SUPERSEDES` sequence and source turns.
- **Safe abstention:** return “not in the indexed history” when no supported claim covers the question.

## Stack

- [HydraDB](https://github.com/hydra-db/hydradb) — self-hosted object-store-native graph database.
- Groq (optional) — extracts durable claims from newly ingested evidence using `openai/gpt-oss-20b`.
- Node.js — small, dependency-free API and polished web experience.
- Docker Compose — one-command demo deployment.

## Run locally

Prerequisites: Docker Desktop running and Node.js 20+.

```powershell
npm.cmd run setup
docker compose up --build --detach
```

Open [http://localhost:3000](http://localhost:3000).

`npm run setup` creates `.hydradb/` plus a strong local HydraDB bearer token and writes any missing settings to `.env`. These are ignored by Git. Never commit `.env` or `.hydradb/`.

The compose stack exposes:

| Service | Address | Purpose |
| --- | --- | --- |
| HydraRecall | `http://localhost:3000` | Web UI + application API |
| HydraDB Bolt | `bolt://localhost:7687` | Neo4j-driver-compatible graph access |
| HydraDB HTTP | `http://localhost:8443` | Graph query API |
| HydraDB admin | `http://localhost:9090/readyz` | Readiness and metrics |

The included demo history works with no external key. To extract structured claims from sessions you add in the UI, set a free Groq key in `.env`:

```env
GROQ_API_KEY=your_groq_key
GROQ_MODEL=openai/gpt-oss-20b
```

Then recreate the app service:

```powershell
docker compose up --build --detach app
```

## Verify the live graph

Once the stack is running, use **Sync HydraDB** in the UI. It writes the memory graph then verifies live paths of this shape:

```text
(Session)-[:CONTAINS]->(Turn)-[:SUPPORTS]->(Claim)
```

The dashboard switches from `DEMO MEMORY` to `HYDRADB CONNECTED` and reports the number of verified proof paths. The app also limits its returned claim set to graph-backed claims when HydraDB is connected.

## Demo script

1. Ask **“What is Alex’s current deployment policy?”**
2. Ask **“What was the deployment policy before April 2026?”**
3. Ask **“When did the deployment policy change?”**
4. Ask **“What is Alex’s favorite JavaScript framework?”**

The fourth query intentionally abstains. This is an explicit product feature, not an error state.

## Deployment

The included `docker-compose.yml` is ideal for a hackathon demo or single VM. Its local mounted object-store directory persists the graph across container restarts.

For an internet-facing or multi-node deployment, use the production Helm chart in [`vendor/hydradb/charts/hydradb`](vendor/hydradb/charts/hydradb) with S3-compatible object storage, TLS, managed secrets, and separate graph-node/indexer scaling. See [DEPLOYMENT.md](DEPLOYMENT.md) for the deployment checklist.

## Useful commands

```powershell
# Static syntax validation
npm.cmd run check

# Start or rebuild the demo stack
docker compose up --build --detach

# Observe services
docker compose ps
docker compose logs --follow

# Stop services without deleting the graph
docker compose down
```

## Repository layout

```text
public/                 HydraDB-inspired UI
server.mjs              API, evidence logic, and HydraDB graph integration
data/demo-memory.json   Deterministic demo sessions and claims
scripts/setup-local.mjs Local token and persistent-store setup
docker-compose.yml      App + self-hosted HydraDB graph node
vendor/hydradb/         Upstream HydraDB Git submodule
```
