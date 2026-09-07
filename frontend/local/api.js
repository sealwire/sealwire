export function applyCsrfHeader(headers, method) {
  if (method === "GET" || method === "HEAD") {
    return;
  }

  headers.set("X-Agent-Relay-CSRF", "1");
}

function parseEnvelope(payload, fallbackMessage) {
  if (!payload?.ok) {
    throw new Error(payload?.error?.message || fallbackMessage);
  }

  return payload.data;
}

export async function fetchAuthSession({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl("/api/auth/session", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || "Failed to check local auth session");
  }

  return parseEnvelope(payload, "Failed to check local auth session");
}

export async function createAuthSession(token, { fetchImpl = fetch } = {}) {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  applyCsrfHeader(headers, "POST");

  const response = await fetchImpl("/api/auth/session", {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify({ token }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || "Failed to create local auth session");
  }

  return parseEnvelope(payload, "Failed to create local auth session");
}

export async function deleteAuthSession({ fetchImpl = fetch } = {}) {
  const headers = new Headers();
  applyCsrfHeader(headers, "DELETE");

  const response = await fetchImpl("/api/auth/session", {
    method: "DELETE",
    credentials: "same-origin",
    headers,
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || "Failed to clear local auth session");
  }

  return parseEnvelope(payload, "Failed to clear local auth session");
}

// Submit the user's answer to a pending AskUserQuestion. `answers` is a
// {questionText: optionLabel | optionLabel[] | freeText} map matching the
// SDK contract (see claude-worker/ask-user-question.mjs). Returns the
// receipt body on success; throws on error.
export async function submitAskUserAnswer(apiFetch, requestId, answers, deviceId) {
  const response = await apiFetch(
    `/api/ask-user-questions/${encodeURIComponent(requestId)}/answer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers, device_id: deviceId }),
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "AskUserQuestion submission failed");
  }
  return payload.data;
}

// Ask the relay to run a cross-agent review. `input` carries the reviewer
// choice ({ reviewer_provider, reviewer_model?, instructions?, parent_thread_id? }).
// Returns the RequestReviewReceipt on success; throws on error.
export async function requestReview(apiFetch, input, deviceId) {
  const response = await apiFetch("/api/session/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, device_id: deviceId }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to request review");
  }
  return payload.data;
}

// Start the built-in Code Flow: author execute -> reviewer review -> author revise.
// Returns the StartWorkflowReceipt on success; throws on error.
export async function startWorkflow(apiFetch, input, deviceId) {
  const response = await apiFetch("/api/session/workflow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, device_id: deviceId }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to start workflow");
  }
  return payload.data;
}

// Resolve a Blocked review: ask the relay to stop the stuck reviewer and unlock
// the workspace. Returns the receipt on success; throws on error.
export async function resolveReview(apiFetch, reviewJobId, deviceId) {
  const response = await apiFetch("/api/session/review/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ review_job_id: reviewJobId, device_id: deviceId }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to resolve the blocked review");
  }
  return payload.data;
}

// Resolve a Blocked workflow: ask the relay to stop owned author/reviewer turns
// and unlock the workspace. Returns the receipt on success; throws on error.
export async function resolveWorkflow(apiFetch, workflowRunId, deviceId) {
  const response = await apiFetch("/api/session/workflow/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow_run_id: workflowRunId, device_id: deviceId }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to resolve the blocked workflow");
  }
  return payload.data;
}

// Delete a terminal review: archive its reviewer thread and drop the job from
// the snapshot. The relay rejects this while the review is still active.
export async function deleteReview(apiFetch, reviewId, deviceId) {
  const response = await apiFetch(
    `/api/session/reviews/${encodeURIComponent(reviewId)}/delete`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId }),
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to delete the review");
  }
  return payload.data;
}

// List active (and recently finished) review jobs from the dedicated Reviews channel.
export async function getReviews(apiFetch, deviceId) {
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  const response = await apiFetch(`/api/session/reviews${suffix}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to load reviews");
  }
  return payload.data;
}

export async function getWorkflows(apiFetch, deviceId) {
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  const response = await apiFetch(`/api/session/workflows${suffix}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to load workflows");
  }
  return payload.data;
}

export async function getTeams(apiFetch) {
  // No `device_id` suffix: `list_teams` takes none. Local is the operator surface
  // with full access, and a task is scoped by its worktree, not by a device.
  const response = await apiFetch("/api/session/teams", { method: "GET" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to load tasks");
  }
  return payload.data;
}

export async function startTeam(apiFetch, input) {
  // Flat by design: a client filling this in is filling in a form, not assembling
  // a domain object.
  const response = await apiFetch("/api/session/team", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to start the task");
  }
  return payload.data;
}

// The five whole-run actions share one body and one receipt, so they share one
// client. `team_run_id` is optional only while one task runs at a time — send it.
export const TEAM_ACTIONS = Object.freeze(["pause", "stop", "cancel", "resume", "resolve"]);

export async function teamAction(apiFetch, action, { teamRunId, deviceId } = {}) {
  if (!TEAM_ACTIONS.includes(action)) {
    throw new Error(`Unknown task action: ${action}`);
  }
  const response = await apiFetch(`/api/session/team/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ team_run_id: teamRunId || null, device_id: deviceId || null }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `Failed to ${action} the task`);
  }
  return payload.data;
}

/** Relabel a finished task to `done` or `cancelled` without reopening it. */
export async function markTeam(apiFetch, status, { teamRunId, deviceId } = {}) {
  if (status !== "done" && status !== "cancelled") {
    throw new Error(`Unknown task mark status: ${status}`);
  }
  const response = await apiFetch("/api/session/team/mark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      team_run_id: teamRunId || null,
      device_id: deviceId || null,
      status,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `Failed to mark the task ${status}`);
  }
  return payload.data;
}

/** Permanently delete one finished task card and the seat threads it owns. */
export async function deleteTeam(apiFetch, { teamRunId, deviceId } = {}) {
  if (!teamRunId) {
    throw new Error("Task id is required");
  }
  const response = await apiFetch("/api/session/team/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      team_run_id: teamRunId,
      device_id: deviceId || null,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to delete the task");
  }
  return payload.data;
}

export async function getDevices(apiFetch) {
  const response = await apiFetch("/api/devices", { method: "GET" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to load devices");
  }
  return payload.data;
}

export function createApiFetch({ getApiToken, onUnauthorized, fetchImpl = fetch }) {
  return async function apiFetch(input, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers || {});
    const apiToken = getApiToken?.();

    if (apiToken) {
      headers.set("Authorization", `Bearer ${apiToken}`);
    }

    applyCsrfHeader(headers, method);

    const response = await fetchImpl(input, {
      ...init,
      method,
      credentials: "same-origin",
      headers,
    });

    if (response.status === 401) {
      onUnauthorized?.("Local authentication is required. Sign in with RELAY_API_TOKEN.");
    }

    return response;
  };
}

/**
 * The usage report.
 *
 * `since`/`until` are unix seconds, half-open — `until` is exclusive, so adjacent
 * windows neither double-count a row nor drop one. `bucket` is
 * `none|hour|day|week|month`; `compare: "previous"` asks the server to add the
 * preceding equal-length window, which is what makes 环比 / "vs the same time
 * yesterday" one round trip.
 *
 * Window arithmetic deliberately lives on ONE side of the wire. Computing the
 * previous window's boundaries in the client as well would put the same
 * off-by-one in two places, and boundaries are exactly where that bug lives.
 *
 * A DEGRADED LEDGER IS NOT AN ERROR. The store is built so that a corrupt or
 * unopenable database costs a number and never the relay, so the route answers
 * 200 with `enabled: false`. Callers must render that as "unavailable" — which is
 * a different state from "no usage yet", and collapsing the two makes a broken
 * ledger look like a quiet day forever.
 */
/**
 * Change the daily token budget.
 *
 * PATCH-shaped: send only what changed. The cap and the policy are two separate
 * controls on one screen, and making each restate the other's value is what
 * makes two open tabs overwrite each other.
 */
export async function setUsageBudget(apiFetch, patch) {
  const response = await apiFetch("/api/usage/budget", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to save the budget");
  }
  return payload.data;
}

export async function getUsage(apiFetch, { since, until, bucket = "day", compare } = {}) {
  const query = new URLSearchParams({ since: String(since), until: String(until), bucket });
  if (compare) query.set("compare", compare);
  const response = await apiFetch(`/api/usage?${query}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to load usage");
  }
  return payload.data;
}

/**
 * The Teams library catalog — definitions a run pins, not live TeamRuns.
 *
 * Distinct from `/api/session/teams`. A degraded ledger answers 200 with
 * `enabled: false` and still includes the builtin Default.
 */
export async function getTeamCatalog(apiFetch) {
  const response = await apiFetch("/api/teams", { method: "GET" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to load teams");
  }
  return payload.data;
}

/**
 * Create-or-return the Tasks Orchestrator thread id.
 *
 * Idempotent on the relay: a live pin is reused. Opening Tasks does not steal
 * the user's active conversation (background start).
 */
export async function ensureOrchestrator(apiFetch, deviceId) {
  const response = await apiFetch("/api/orchestrator/ensure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId || null }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to open the Orchestrator");
  }
  return payload.data;
}

/**
 * Retire the pinned Orchestrator and open a fresh one.
 *
 * Not the same as `ensureOrchestrator`, which is idempotent and reuses a live
 * pin. This is the way out of a pin the relay cannot tell is dead: the thread
 * still resolves, so nothing self-heals, but its provider-side session is gone
 * and every turn fails. The old thread is kept; only the pin moves.
 */
export async function resetOrchestrator(apiFetch, deviceId) {
  const response = await apiFetch("/api/orchestrator/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId || null }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to restart the Orchestrator");
  }
  return payload.data;
}

/**
 * What a task team changed, against one of the bases the relay offers.
 *
 * `base` is a key from a previous response's `bases`, never a ref or a commit:
 * the relay refuses anything it did not itself name, so a caller cannot hand
 * git an argument.
 */
export async function getTeamDiff(apiFetch, teamRunId, base, deviceId) {
  const params = new URLSearchParams({ team_run_id: teamRunId });
  if (base) params.set("base", base);
  if (deviceId) params.set("device_id", deviceId);
  const response = await apiFetch(`/api/session/team/diff?${params}`);
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to load the task's changes");
  }
  return payload.data;
}

export async function proposeOrchestratorTask(apiFetch, body) {
  const response = await apiFetch("/api/orchestrator/proposals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to create proposal");
  }
  return payload.data;
}

export async function confirmOrchestratorProposal(apiFetch, proposalId, deviceId) {
  const response = await apiFetch(
    `/api/orchestrator/proposals/${encodeURIComponent(proposalId)}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId || null }),
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to confirm proposal");
  }
  return payload.data;
}

// Edit a staged card without starting it. Absent fields leave the staged value
// alone, so `updates` carries only what changed.
export async function reviseOrchestratorProposal(apiFetch, proposalId, updates, deviceId) {
  const response = await apiFetch(
    `/api/orchestrator/proposals/${encodeURIComponent(proposalId)}/revise`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(updates || {}), device_id: deviceId || null }),
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to update proposal");
  }
  return payload.data;
}

export async function dismissOrchestratorProposal(apiFetch, proposalId, deviceId) {
  const response = await apiFetch(
    `/api/orchestrator/proposals/${encodeURIComponent(proposalId)}/dismiss`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId || null }),
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to dismiss proposal");
  }
  return payload.data;
}

export {
  listLineComments,
  createLineComment,
  resolveLineComment,
  handBackLineComment,
  listReviewTicks,
  tickReviewFile,
  teamRunCommentScope,
} from "../shared/line-comments-api.js";
