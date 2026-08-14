const $ = (selector) => document.querySelector(selector);

const state = { dashboard: null, toastTimer: null, apiKey: sessionStorage.getItem("hydrarecall_api_key") || "", auth: null };

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCount(value) {
  return String(value ?? 0).padStart(2, "0");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 3800);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(state.apiKey ? { "X-API-Key": state.apiKey } : {}), ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function refreshAuthStatus() {
  state.auth = await api("/api/auth/status");
  const button = $("#authButton");
  if (state.auth.enabled && state.auth.authenticated) button.textContent = `API key: ${state.auth.principal.id}`;
  else if (state.auth.enabled) button.textContent = "Connect API key";
  else button.hidden = true;
  return state.auth;
}

function updateGraphStatus(graph) {
  const container = $("#sideStatus");
  const dot = container.querySelector(".status-dot");
  const heading = container.querySelector("b");
  const small = container.querySelector("small");
  const metric = $("#metricGraph");
  const status = graph?.status || "offline";
  dot.className = `status-dot ${status === "connected" ? "" : status === "offline" || status === "not-configured" ? "offline" : "warning"}`;
  heading.textContent = status === "connected" ? "HYDRADB CONNECTED" : status === "degraded" ? "GRAPH DEGRADED" : "DEMO MEMORY";
  small.textContent = graph?.message || "Awaiting graph sync";
  metric.textContent = status === "connected" ? "LIVE" : "LOCAL";
  metric.classList.toggle("orange", status !== "connected");
}

function renderDashboard(dashboard) {
  state.dashboard = dashboard;
  const { stats } = dashboard;
  $("#metricSessions").textContent = formatCount(stats.sessions);
  $("#metricClaims").textContent = formatCount(stats.claims);
  $("#metricVersions").textContent = formatCount(stats.supersededClaims);
  $("#sessionCount").textContent = formatCount(stats.sessions);
  $("#claimCount").textContent = formatCount(stats.claims);
  updateGraphStatus(dashboard.graph);
}

function renderProof(paths = []) {
  const proofList = $("#proofList");
  proofList.replaceChildren();
  const fallback = ["Entity & slot resolver", "Temporal graph traversal", "Evidence-bounded generation"];
  const entries = paths.length ? paths : fallback;
  entries.slice(0, 4).forEach((path, index) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${String(index + 1).padStart(2, "0")}</span><p>${escapeHtml(path)}</p>`;
    proofList.append(item);
  });
}

function renderTimeline(timeline = []) {
  const container = $("#timelineList");
  container.replaceChildren();
  if (!timeline.length) {
    container.innerHTML = '<div class="timeline-empty">No claim sequence was returned for this question.</div>';
    return;
  }
  timeline.forEach((item) => {
    const card = document.createElement("article");
    card.className = `timeline-card ${item.status === "active" ? "active" : ""}`;
    const session = item.source?.sessionTitle || "Unlinked session";
    const source = item.source?.text || "Source turn unavailable.";
    card.innerHTML = `
      <time class="timeline-date">${escapeHtml(formatDate(item.validAt))}<br />VALID TIME</time>
      <div><div class="timeline-claim">${escapeHtml(item.claim)}</div><div class="timeline-source">${escapeHtml(session)} — ${escapeHtml(source)}</div></div>
      <span class="claim-status ${item.status === "active" ? "active" : ""}">${escapeHtml(item.status)}</span>
    `;
    container.append(card);
  });
}

function renderAnswer(result) {
  const abstention = result.kind === "abstention";
  const answerState = $("#answerState");
  answerState.className = `answer-state ${abstention ? "abstention" : "grounded"}`;
  answerState.innerHTML = `<i></i> ${abstention ? "ABSTAINED" : "GROUNDED"}`;
  $("#latency").textContent = `${result.retrievalMs} ms retrieval`;
  $("#answerTitle").textContent = result.title;
  $("#answerCopy").textContent = result.answer;
  $("#answerDetail").textContent = result.detail;
  $("#coverageRow").innerHTML = `<span>Coverage</span><strong>${escapeHtml(result.coverage?.result || "No coverage information")}</strong>`;
  renderProof(result.paths);
  renderTimeline(result.timeline);
}

async function runQuery(question) {
  const normalized = String(question || "").trim();
  if (!normalized) return;
  const submit = $("#queryForm button");
  submit.disabled = true;
  submit.textContent = "Recalling…";
  try {
    const result = await api("/api/query", { method: "POST", body: JSON.stringify({ question: normalized }) });
    renderAnswer(result);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    submit.disabled = false;
    submit.innerHTML = "Recall <span>↗</span>";
  }
}

async function loadDashboard() {
  try {
    renderDashboard(await api("/api/dashboard"));
  } catch (error) {
    showToast(`Could not load memory: ${error.message}`, true);
  }
}

async function syncGraph() {
  const button = $("#syncButton");
  button.disabled = true;
  button.textContent = "Syncing…";
  try {
    const result = await api("/api/graph/sync", { method: "POST", body: "{}" });
    renderDashboard(result.dashboard);
    showToast(result.graph.message, result.graph.status !== "connected");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Sync HydraDB";
  }
}

function localDateTimeValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function setupEvents() {
  const dialog = $("#ingestDialog");
  const authDialog = $("#authDialog");
  $("#openIngest").addEventListener("click", () => {
    $("#ingestDate").value = localDateTimeValue();
    dialog.showModal();
  });

  $("#queryForm").addEventListener("submit", (event) => {
    event.preventDefault();
    runQuery($("#questionInput").value);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      runQuery($("#questionInput").value);
    }
  });

  document.querySelectorAll("[data-question]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#questionInput").value = button.dataset.question;
      runQuery(button.dataset.question);
    });
  });

  $("#syncButton").addEventListener("click", syncGraph);

  $("#authButton").addEventListener("click", () => {
    $("#apiKeyInput").value = state.apiKey;
    authDialog.showModal();
  });

  $("#authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const candidate = $("#apiKeyInput").value.trim();
    state.apiKey = candidate;
    try {
      const status = await refreshAuthStatus();
      if (status.enabled && !status.authenticated) throw new Error("This API key was not accepted.");
      sessionStorage.setItem("hydrarecall_api_key", candidate);
      authDialog.close();
      await loadDashboard();
      await runQuery($("#questionInput").value);
      showToast("Production API key connected for this browser session.");
    } catch (error) {
      state.apiKey = "";
      sessionStorage.removeItem("hydrarecall_api_key");
      showToast(error.message, true);
    }
  });

  $("#ingestForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("#ingestForm button[type=submit]");
    submit.disabled = true;
    submit.textContent = "Extracting proof…";
    try {
      const result = await api("/api/ingest", {
        method: "POST",
        body: JSON.stringify({
          title: $("#ingestTitle").value,
          occurredAt: $("#ingestDate").value,
          text: $("#ingestText").value,
        }),
      });
      dialog.close();
      $("#ingestForm").reset();
      await loadDashboard();
      const mode = result.extractionMode === "gemini" ? "Gemini extracted" : "Deterministic extraction created";
      showToast(`${mode} ${result.claims.length} claim${result.claims.length === 1 ? "" : "s"}. ${result.graph.message}`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      submit.disabled = false;
      submit.innerHTML = "Ingest to memory <span>↗</span>";
    }
  });

  $("#resetButton").addEventListener("click", async () => {
    if (!window.confirm("Reset the in-memory demo workspace? The HydraDB graph is left untouched.")) return;
    try {
      const dashboard = await api("/api/reset", { method: "POST", body: "{}" });
      renderDashboard(dashboard);
      await runQuery("What is Alex's current deployment policy?");
      showToast("Demo workspace reset.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

async function boot() {
  setupEvents();
  try {
    const auth = await refreshAuthStatus();
    if (auth.enabled && !auth.authenticated) {
      $("#authDialog").showModal();
      return;
    }
  } catch (error) {
    showToast(`Could not check authentication: ${error.message}`, true);
    return;
  }
  await loadDashboard();
  await runQuery($("#questionInput").value);
}

boot();
