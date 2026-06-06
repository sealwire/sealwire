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

// Resolve a Blocked review: ask the relay to stop the stuck reviewer and unlock
// the workspace. Returns the receipt on success; throws on error.
export async function resolveReview(apiFetch, deviceId) {
  const response = await apiFetch("/api/session/review/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to resolve the blocked review");
  }
  return payload.data;
}

// List active (and recently finished) review jobs. The same data also rides the
// session snapshot as `active_review_jobs`; this endpoint is a direct poll.
export async function getReviews(apiFetch, deviceId) {
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  const response = await apiFetch(`/api/session/reviews${suffix}`, { method: "GET" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || "Failed to load reviews");
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
