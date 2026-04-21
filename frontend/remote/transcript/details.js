import { applyRemoteSurfacePatch } from "../surface-state.js";

export const TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES = 64 * 1024;
export const TRANSCRIPT_ENTRY_DETAIL_CACHE_MAX_BYTES = 256 * 1024;
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

function buildPreviewEntry(entry) {
  if (entry?.kind !== "command" || entry?.status !== "completed") {
    return entry;
  }

  return {
    ...entry,
    text: truncateCommandPreview(entry.text || ""),
  };
}

export function getCachedTranscriptEntryDetail(state, threadId, itemId) {
  if (!threadId || !itemId) {
    return null;
  }

  const key = transcriptEntryCacheKey(threadId, itemId);
  return state.transcriptEntryDetailCache.get(key)?.entry || null;
}

export function cacheTranscriptEntryDetail(state, threadId, entry, { applyPatch = true } = {}) {
  const itemId = entry?.item_id;
  if (!threadId || !itemId) {
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

  const patch = {
    transcriptEntryDetailCache: nextCache,
    transcriptEntryDetailOrder: nextOrder,
  };
  if (applyPatch) {
    applyRemoteSurfacePatch(patch);
  }
  return {
    cached: true,
    patch,
  };
}

export function prepareTranscriptEntryForSurface(
  state,
  threadId,
  entry,
  { applyPatch = true } = {}
) {
  if (!entry?.item_id || entry.kind !== "command" || entry.status !== "completed") {
    return {
      cachePatch: null,
      entry,
    };
  }

  const { patch } = cacheTranscriptEntryDetail(state, threadId, entry, {
    applyPatch,
  });
  return {
    cachePatch: patch,
    entry: buildPreviewEntry(entry),
  };
}
