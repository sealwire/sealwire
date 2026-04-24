const TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES = 64 * 1024;
const TRANSCRIPT_ENTRY_DETAIL_CACHE_MAX_BYTES = 256 * 1024;
const COMMAND_PREVIEW_CHAR_THRESHOLD = 140;

function transcriptEntryCacheKey(threadId, itemId) {
  return `${threadId || "-"}:${itemId || "-"}`;
}

function truncateCommandPreview(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= COMMAND_PREVIEW_CHAR_THRESHOLD) {
    return normalized;
  }

  return `${normalized.slice(0, COMMAND_PREVIEW_CHAR_THRESHOLD - 1).trimEnd()}…`;
}

function estimateTranscriptEntryDetailBytes(entry) {
  try {
    return new TextEncoder().encode(JSON.stringify(entry || null)).length;
  } catch {
    return JSON.stringify(entry || null)?.length || 0;
  }
}

function supportsTranscriptEntryDetail(entry) {
  return Boolean(
    entry?.item_id
      && (entry.kind === "command" || entry.kind === "tool_call")
  );
}

function shouldInlineCacheTranscriptEntry(entry) {
  return supportsTranscriptEntryDetail(entry) && entry.status === "completed";
}

function shouldRetainLiveTranscriptEntry(entry) {
  return supportsTranscriptEntryDetail(entry) && entry.status !== "completed";
}

function buildPreviewEntry(entry) {
  if (entry?.kind !== "command") {
    return entry;
  }

  return {
    ...entry,
    text: truncateCommandPreview(entry.text || ""),
  };
}

function mergeToolDetail(existing, incoming) {
  if (!existing) {
    return incoming || null;
  }
  if (!incoming) {
    return existing;
  }

  return {
    ...existing,
    ...incoming,
    name: incoming.name || existing.name,
    title: selectLongerString(existing.title, incoming.title),
    detail: selectLongerString(existing.detail, incoming.detail),
    query: selectLongerString(existing.query, incoming.query),
    path: selectLongerString(existing.path, incoming.path),
    url: selectLongerString(existing.url, incoming.url),
    command: selectLongerString(existing.command, incoming.command),
    input_preview: selectLongerString(existing.input_preview, incoming.input_preview),
    result_preview: selectLongerString(existing.result_preview, incoming.result_preview),
    diff: selectLongerString(existing.diff, incoming.diff),
    file_changes: Array.isArray(incoming.file_changes) && incoming.file_changes.length
      ? incoming.file_changes
      : (existing.file_changes || []),
  };
}

function mergeTranscriptEntryDetail(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  return {
    ...existing,
    ...incoming,
    text: selectLongerString(existing.text, incoming.text),
    status: incoming.status || existing.status,
    turn_id: incoming.turn_id || existing.turn_id || null,
    tool: mergeToolDetail(existing.tool, incoming.tool),
  };
}

function selectLongerString(existing, incoming) {
  const existingValue = typeof existing === "string" ? existing : "";
  const incomingValue = typeof incoming === "string" ? incoming : "";
  if (!incomingValue) {
    return existing ?? null;
  }
  if (!existingValue) {
    return incoming;
  }
  return incomingValue.length >= existingValue.length ? incoming : existing;
}

export function createClearedTranscriptEntryDetailsPatch() {
  return {
    transcriptEntryDetailCache: new Map(),
    transcriptEntryDetailOrder: [],
    transcriptLiveEntryDetails: new Map(),
    transcriptLiveEntryThreadId: null,
  };
}

export function getCachedTranscriptEntryDetail(state, threadId, itemId) {
  if (!threadId || !itemId) {
    return null;
  }

  const key = transcriptEntryCacheKey(threadId, itemId);
  return state.transcriptEntryDetailCache.get(key)?.entry || null;
}

export function getLiveTranscriptEntryDetail(state, threadId, itemId) {
  if (!threadId || !itemId || state.transcriptLiveEntryThreadId !== threadId) {
    return null;
  }

  return state.transcriptLiveEntryDetails.get(itemId) || null;
}

export function cacheTranscriptEntryDetail(state, threadId, entry) {
  const itemId = entry?.item_id;
  if (!threadId || !itemId || !shouldInlineCacheTranscriptEntry(entry)) {
    return { cached: false, patch: null };
  }

  const size = estimateTranscriptEntryDetailBytes(entry);
  if (size > TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES) {
    return { cached: false, patch: null };
  }

  const key = transcriptEntryCacheKey(threadId, itemId);
  const nextCache = new Map(state.transcriptEntryDetailCache);
  const nextOrder = state.transcriptEntryDetailOrder.filter((value) => value !== key);
  nextCache.set(key, {
    entry,
    size,
    threadId,
  });
  nextOrder.push(key);

  let totalBytes = 0;
  for (const value of nextCache.values()) {
    totalBytes += value.size || 0;
  }

  while (totalBytes > TRANSCRIPT_ENTRY_DETAIL_CACHE_MAX_BYTES && nextOrder.length > 0) {
    const oldestKey = nextOrder.shift();
    const removed = nextCache.get(oldestKey);
    nextCache.delete(oldestKey);
    totalBytes -= removed?.size || 0;
  }

  return {
    cached: true,
    patch: {
      transcriptEntryDetailCache: nextCache,
      transcriptEntryDetailOrder: nextOrder,
    },
  };
}

export function setLiveTranscriptEntryDetail(state, threadId, entry) {
  const itemId = entry?.item_id;
  if (!threadId || !itemId || !supportsTranscriptEntryDetail(entry)) {
    return { stored: false, patch: null };
  }

  const nextDetails = state.transcriptLiveEntryThreadId === threadId
    ? new Map(state.transcriptLiveEntryDetails)
    : new Map();
  const previousEntry = nextDetails.get(itemId);
  nextDetails.set(itemId, mergeTranscriptEntryDetail(previousEntry, entry));

  return {
    stored: true,
    patch: {
      transcriptLiveEntryDetails: nextDetails,
      transcriptLiveEntryThreadId: threadId,
    },
  };
}

export function syncLiveTranscriptEntryDetailsFromSnapshot(state, snapshot) {
  const threadId = snapshot?.active_thread_id || null;
  if (!threadId) {
    return { changed: false, patch: null };
  }

  let changed = state.transcriptLiveEntryThreadId !== threadId;
  const nextDetails = state.transcriptLiveEntryThreadId === threadId
    ? new Map(state.transcriptLiveEntryDetails)
    : new Map();

  for (const entry of snapshot.transcript || []) {
    if (!shouldRetainLiveTranscriptEntry(entry)) {
      continue;
    }
    const itemId = entry.item_id;
    const previousEntry = nextDetails.get(itemId);
    const mergedEntry = mergeTranscriptEntryDetail(previousEntry, entry);
    if (!previousEntry || JSON.stringify(previousEntry) !== JSON.stringify(mergedEntry)) {
      changed = true;
    }
    nextDetails.set(itemId, mergedEntry);
  }

  if (!changed) {
    return { changed: false, patch: null };
  }

  return {
    changed: true,
    patch: {
      transcriptLiveEntryDetails: nextDetails,
      transcriptLiveEntryThreadId: threadId,
    },
  };
}

export function prepareTranscriptEntryForSurface(state, threadId, entry) {
  if (!entry?.item_id || !supportsTranscriptEntryDetail(entry)) {
    return {
      cachePatch: null,
      entry,
    };
  }

  const { patch } = shouldInlineCacheTranscriptEntry(entry)
    ? cacheTranscriptEntryDetail(state, threadId, entry)
    : { patch: null };
  return {
    cachePatch: patch,
    entry: buildPreviewEntry(entry),
  };
}

export function buildExpandedTranscriptDetailEntries(
  state,
  {
    expandedItemIds,
    threadId,
    transientDetails = null,
  } = {}
) {
  const detailEntries = new Map();
  for (const expandedKey of expandedItemIds || []) {
    if (!String(expandedKey || "").startsWith("entry:")) {
      continue;
    }
    const itemId = String(expandedKey).slice("entry:".length);
    const transientDetail = transientDetails?.get?.(itemId) || null;
    const liveDetail = getLiveTranscriptEntryDetail(state, threadId, itemId);
    if (transientDetail) {
      detailEntries.set(itemId, transientDetail);
      continue;
    }
    if (liveDetail) {
      detailEntries.set(itemId, liveDetail);
      continue;
    }

    const cachedDetail = getCachedTranscriptEntryDetail(state, threadId, itemId);
    if (cachedDetail) {
      detailEntries.set(itemId, cachedDetail);
    }
  }

  return detailEntries;
}

export {
  TRANSCRIPT_ENTRY_DETAIL_CACHE_MAX_BYTES,
  TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES,
};
