import sys

with open('scripts/longmemeval-v2-adapter.mjs', 'r', encoding='utf-8') as f:
    code = f.read()

target = '''  const trajectoryStore = await loadTrajectoriesIntoMemory(options.trajectories, requiredTrajectoryIds);

  const summaryRows = [];'''

replacement = '''  const trajectoryStore = await loadTrajectoriesIntoMemory(options.trajectories, requiredTrajectoryIds);

  if (!options.dryRun) {
    console.log("Pushing required trajectories to HydraDB ingestion endpoint...");
    const trajArray = Array.from(trajectoryStore.values()).map(t => ({
      id: t.id,
      title: "Trajectory " + t.id,
      turns: (t.states || []).map((s, idx) => ({
        id: t.id + "-" + idx,
        role: "user",
        text: JSON.stringify(s).slice(0, 4000),
        occurredAt: new Date().toISOString() // Or use realistic timestamp
      }))
    }));
    
    // Batch ingest
    for (let i = 0; i < trajArray.length; i += 20) {
      const batch = trajArray.slice(i, i + 20);
      try {
        const headers = { "Content-Type": "application/json" };
        const apiKey = options.apiKey || process.env.HYDRARECALL_API_KEY;
        if (apiKey) headers["X-API-Key"] = apiKey;
        const res = await fetch(options.endpoint.replace(/\\/$/, "") + "/api/benchmark/ingest", {
          method: "POST",
          headers,
          body: JSON.stringify({ dataset: "longmemeval-v2", sessions: batch })
        });
        if (!res.ok) console.error("Ingestion failed:", await res.text());
      } catch (err) {
        console.error("Ingestion network error:", err.message);
      }
    }
  }

  const summaryRows = [];'''

if target in code:
    code = code.replace(target, replacement)
    with open('scripts/longmemeval-v2-adapter.mjs', 'w', encoding='utf-8') as f:
        f.write(code)
    print("Patched adapter successfully.")
else:
    print("Target not found.")
