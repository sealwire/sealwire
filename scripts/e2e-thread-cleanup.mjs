import { setTimeout as delay } from "node:timers/promises";

function authHeaders(bearerToken) {
  return bearerToken
    ? {
        Authorization: `Bearer ${bearerToken}`,
      }
    : {};
}

function extractErrorMessage(payload, fallback) {
  return (
    payload?.error?.message ||
    payload?.message ||
    (typeof payload?.error === "string" ? payload.error : null) ||
    fallback
  );
}

export async function fetchSession(relayPort, { bearerToken } = {}) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/session`, {
    headers: authHeaders(bearerToken),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || payload?.error || "failed to fetch relay session");
  }
  return payload.data;
}

export async function listThreads(relayPort, { bearerToken, cwd } = {}) {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/threads${query}`, {
    headers: authHeaders(bearerToken),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.ok) {
    throw new Error(
      extractErrorMessage(payload, `failed to list relay threads${cwd ? ` for ${cwd}` : ""}`)
    );
  }
  return payload.data?.threads || [];
}

export async function deleteThreadAndWait(
  relayPort,
  threadId,
  { bearerToken, cwd, timeoutMs = 15000 } = {}
) {
  if (!threadId) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await fetchSession(relayPort, { bearerToken });
    if (session.active_thread_id !== threadId || !session.active_turn_id) {
      break;
    }
    await delay(250);
  }

  let deleted = false;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://127.0.0.1:${relayPort}/api/threads/${encodeURIComponent(threadId)}/delete`,
      {
        method: "POST",
        headers: authHeaders(bearerToken),
      }
    );
    const payload = await response.json();
    if (response.ok && payload?.ok) {
      deleted = true;
      break;
    }
    const errorMessage = extractErrorMessage(
      payload,
      `failed to delete local thread ${threadId}`
    );
    if (errorMessage.includes("Codex is still running")) {
      await delay(250);
      continue;
    }
    throw new Error(errorMessage);
  }

  if (!deleted) {
    throw new Error(`timed out waiting for local thread ${threadId} to become deletable`);
  }

  while (Date.now() < deadline) {
    const threads = await listThreads(relayPort, { bearerToken, cwd });
    if (!threads.some((thread) => thread.id === threadId)) {
      return;
    }
    await delay(250);
  }

  throw new Error(`timed out waiting for deleted thread ${threadId} to disappear from relay list`);
}

export async function deleteThreadsForCwdAndWait(
  relayPort,
  cwd,
  { bearerToken, timeoutMs = 15000 } = {}
) {
  if (!cwd) {
    return [];
  }

  const deletedThreadIds = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const threads = await listThreads(relayPort, { bearerToken, cwd });
    if (threads.length === 0) {
      return deletedThreadIds;
    }

    for (const thread of threads) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      await deleteThreadAndWait(relayPort, thread.id, {
        bearerToken,
        cwd,
        timeoutMs: remainingMs,
      });
      deletedThreadIds.push(thread.id);
    }
  }

  const leftoverThreads = await listThreads(relayPort, { bearerToken, cwd });
  if (leftoverThreads.length > 0) {
    throw new Error(`timed out waiting to delete ${leftoverThreads.length} thread(s) for ${cwd}`);
  }

  return deletedThreadIds;
}
