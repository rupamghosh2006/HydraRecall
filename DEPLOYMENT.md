# HydraRecall deployment checklist

## 1. Demo / single-VM deployment

Use the included Compose stack on a host with Docker installed:

```powershell
npm.cmd run setup
docker compose up --build --detach
```

Put a TLS reverse proxy in front of port `3000`. Expose only the app publicly. Keep ports `7687`, `8443`, and `9090` private to the host or private network.

Persist the `.hydradb/` directory using durable host storage or a managed volume. It is the durable local object-store directory for the demo profile.

## 2. Production topology

For production use a managed, versioned object store and the upstream HydraDB Helm chart in `vendor/hydradb/charts/hydradb`:

```text
Internet → TLS ingress → HydraRecall app
                         │
                         └→ private HydraDB graph-node fleet
                                      │
                                      └→ S3-compatible object store
                                            ↑
                                      graph-indexer workers
```

Create a chart values file from `vendor/hydradb/charts/hydradb/examples/values-eks.yaml`. Configure:

- a dedicated bucket and workload identity for HydraDB;
- public TLS plus private service-to-service connectivity;
- a secret manager entry for the HydraDB bearer token;
- an application secret for `GROQ_API_KEY` only if automatic claim extraction is enabled;
- persistent dashboards/alerts for the graph node’s `/metrics` endpoint.

Keep the HydraDB HTTP and Bolt endpoints private. HydraRecall’s backend is the sole caller and attaches the bearer token; browsers never receive either database or Groq credentials.

## 3. Required secrets

| Secret | Used by | Notes |
| --- | --- | --- |
| `HYDRADB_AUTH_TOKEN` | HydraRecall backend + HydraDB | Generate at least 32 random bytes; rotate on exposure. |
| `GROQ_API_KEY` | HydraRecall backend only | Optional; enables AI extraction for UI-ingested sessions. |
| Object-store credentials | HydraDB only | Use workload identity / IAM roles rather than static keys whenever possible. |

Do not pass these to the frontend build, client-side JavaScript, screenshots, Git, or public logs. If a secret appears in a terminal transcript, CI log, or chat export, rotate it immediately.

## 4. Post-deploy smoke test

1. Request `GET /api/health` through the app service.
2. Call **Sync HydraDB** from the UI and confirm it reports live proof paths.
3. Run the four-question demo sequence from `README.md`.
4. Restart the app and graph-node services; verify history still resolves.
5. In production, verify the graph node’s readiness endpoint and object-store access after an app redeploy.
