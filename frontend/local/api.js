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
