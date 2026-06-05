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

  // Prefer whichever side actually carries per-file diff bodies (a side is
  // "full" only when it has file_changes AND isn't a stripped summary). Without
  // this, a running turnDiff re-synced each snapshot would re-stamp the entry
  // back to a summary and force an endless re-fetch.
  const incomingHasFullFileChanges =
    !incoming.file_changes_omitted
    && Array.isArray(incoming.file_changes)
    && incoming.file_changes.some((change) => Boolean(change?.diff));
  const existingHasFullFileChanges =
    !existing.file_changes_omitted
    && Array.isArray(existing.file_changes)
    && existing.file_changes.some((change) => Boolean(change?.diff));
  const mergedFileChanges = incomingHasFullFileChanges
    ? incoming.file_changes
    : existingHasFullFileChanges
      ? existing.file_changes
      : Array.isArray(incoming.file_changes) && incoming.file_changes.length
        ? incoming.file_changes
        : existing.file_changes || [];
  const mergedDiff = selectLongerString(existing.diff, incoming.diff);
  // Decide "omitted" from actual CONTENT, not just the flag: a flagless-but-empty
  // side must not be mistaken for a full detail. The merged entry stays a summary
  // only when it still has no real diff content and at least one source was one.
  const mergedHasDiffContent =
    Boolean(mergedDiff) || mergedFileChanges.some((change) => Boolean(change?.diff));
  const eitherOmitted =
    Boolean(existing.file_changes_omitted) || Boolean(incoming.file_changes_omitted);

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
    diff: mergedDiff,
    file_changes: mergedFileChanges,
    file_changes_omitted: mergedHasDiffContent ? false : eitherOmitted,
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

// A detail record that is itself just a stripped file-change summary
// (file_changes_omitted) — NOT the fetched full diff. A running turnDiff summary
// can be parked in the live-detail store, so callers must not treat it as a
// resolved full detail (else they'd block the fetch and stay on "Loading diff…").
export function isOmittedFileChangeDetail(entry) {
  return Boolean(entry?.tool?.file_changes_omitted);
}

// Visible file-change entries whose snapshot only carries the summary
// (file_changes_omitted). They have no expand control, so their fetched full
// detail must be folded into the detail map regardless of expansion — otherwise
// the renderer keeps showing the summary and the UI stays on "Loading diff…".
export function collectFileChangeDetailItemIds(transcript) {
  const itemIds = [];
  for (const entry of transcript || []) {
    const tool = entry?.tool;
    if (!entry?.item_id || !tool) {
      continue;
    }
    const isFileChange = tool.item_type === "fileChange" || tool.item_type === "turnDiff";
    if (isFileChange && tool.file_changes_omitted) {
      itemIds.push(entry.item_id);
    }
  }
  return itemIds;
}

export function buildExpandedTranscriptDetailEntries(
  state,
  {
    expandedItemIds,
    threadId,
    transientDetails = null,
    autoDetailItemIds = null,
  } = {}
) {
  const detailEntries = new Map();
  // `requireFull` is for the auto (file-change summary) pass: a stripped summary
  // parked in the live/cache store is NOT the fetched full diff, so skip it and
  // keep looking — if only a summary exists, set nothing so the renderer's
  // effect keeps fetching.
  const pickDetail = (itemId, { requireFull = false } = {}) => {
    const candidates = [
      transientDetails?.get?.(itemId) || null,
      getLiveTranscriptEntryDetail(state, threadId, itemId),
      getCachedTranscriptEntryDetail(state, threadId, itemId),
    ];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      if (requireFull && isOmittedFileChangeDetail(candidate)) {
        continue;
      }
      return candidate;
    }
    return null;
  };
  const resolveInto = (itemId, opts) => {
    if (!itemId || detailEntries.has(itemId)) {
      return;
    }
    const detail = pickDetail(itemId, opts);
    if (detail) {
      detailEntries.set(itemId, detail);
    }
  };

  for (const expandedKey of expandedItemIds || []) {
    if (!String(expandedKey || "").startsWith("entry:")) {
      continue;
    }
    resolveInto(String(expandedKey).slice("entry:".length));
  }
  // File-change entries that were stripped to a summary auto-load their detail
  // even without an expand toggle; fold in only the fetched FULL detail.
  for (const itemId of autoDetailItemIds || []) {
    resolveInto(itemId, { requireFull: true });
  }

  return detailEntries;
}

export {
  TRANSCRIPT_ENTRY_DETAIL_CACHE_MAX_BYTES,
  TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES,
};
