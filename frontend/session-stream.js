function sessionStreamHeaders(apiToken) {
  const headers = new Headers({
    Accept: "text/event-stream",
    "Cache-Control": "no-store",
  });
  if (apiToken) {
    headers.set("Authorization", `Bearer ${apiToken}`);
  }
  return headers;
}

export function sessionStreamUrl(baseOrigin = window.location.origin) {
  return new URL("/api/stream", baseOrigin).toString();
}

export function openSessionStream({
  apiToken,
  url = sessionStreamUrl(),
  fetchImpl = globalThis.fetch,
  onOpen = () => {},
  onSession = () => {},
  onEvent = () => {},
  onError = () => {},
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is unavailable");
  }
  if (typeof AbortController === "undefined") {
    throw new Error("AbortController is unavailable");
  }

  let closed = false;
  const controller = new AbortController();

  const ready = (async () => {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        headers: sessionStreamHeaders(apiToken),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`session stream request failed (${response.status})`);
        if (response.status === 401) {
          error.code = "unauthorized";
        }
        throw error;
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error("streaming response body is unavailable");
      }

      onOpen();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = dispatchBufferedEvents(buffer, { onEvent, onSession });
      }

      if (!closed) {
        buffer += decoder.decode();
        dispatchBufferedEvents(`${buffer}\n\n`, { onEvent, onSession });
        throw new Error("session stream connection ended");
      }
    } catch (error) {
      if (closed || error?.name === "AbortError") {
        return;
      }
      onError(error);
    }
  })();

  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      controller.abort();
    },
    ready,
  };
}

function dispatchBufferedEvents(buffer, handlers) {
  const normalized = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let cursor = 0;

  while (true) {
    const separatorIndex = normalized.indexOf("\n\n", cursor);
    if (separatorIndex === -1) {
      return normalized.slice(cursor);
    }

    const rawEvent = normalized.slice(cursor, separatorIndex);
    cursor = separatorIndex + 2;
    dispatchEvent(rawEvent, handlers);
  }
}

function dispatchEvent(rawEvent, { onEvent, onSession }) {
  if (!rawEvent.trim()) {
    return;
  }

  let eventType = "message";
  const dataLines = [];
  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (!dataLines.length) {
    return;
  }

  const data = dataLines.join("\n");
  if (eventType === "session") {
    onSession(data);
    return;
  }
  onEvent({ data, type: eventType });
}
