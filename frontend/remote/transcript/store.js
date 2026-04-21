import {
  applyRemoteSurfacePatch,
  createClearedTranscriptHydrationPatch,
} from "../surface-state.js";
import { prepareTranscriptEntryForSurface } from "./details.js";

export function clearTranscriptHydration(state) {
  applyRemoteSurfacePatch(createClearedTranscriptHydrationPatch());
}

export function restoreHydratedTranscript(state, snapshot) {
  if (!snapshot?.active_thread_id) {
    return snapshot;
  }

  const signature = transcriptHydrationSignature(snapshot);
  if (
    state.transcriptHydrationThreadId !== snapshot.active_thread_id
    || state.transcriptHydrationSignature !== signature
    || !state.transcriptHydrationOrder.length
  ) {
    return snapshot;
  }

  return buildHydratedTranscriptSnapshot(state, snapshot);
}

export function prepareTranscriptHydration(state, snapshot) {
  if (!snapshot?.active_thread_id || !snapshot.transcript_truncated) {
    return {
      signature: null,
      shouldHydrate: false,
      alreadyComplete: false,
      existingPromise: null,
    };
  }

  const signature = transcriptHydrationSignature(snapshot);
  if (
    state.transcriptHydrationThreadId !== snapshot.active_thread_id
    || state.transcriptHydrationSignature !== signature
  ) {
    resetTranscriptHydration(snapshot, signature);
  } else {
    applyRemoteSurfacePatch({
      transcriptHydrationBaseSnapshot: snapshot,
    });
  }

  return {
    signature,
    shouldHydrate: !state.transcriptHydrationTailReady,
    alreadyComplete:
      state.transcriptHydrationTailReady && state.transcriptHydrationOlderCursor == null,
    existingPromise: state.transcriptHydrationPromise,
  };
}

export function beginTranscriptHydration(state, status = "loading") {
  applyRemoteSurfacePatch({
    transcriptHydrationStatus: status,
  });
}

export function setTranscriptHydrationPromise(state, promise) {
  applyRemoteSurfacePatch({
    transcriptHydrationPromise: promise,
  });
}

export function clearTranscriptHydrationPromise(state, signature) {
  if (state.transcriptHydrationSignature === signature) {
    applyRemoteSurfacePatch({
      transcriptHydrationPromise: null,
    });
  }
}

export function setTranscriptHydrationIdle() {
  applyRemoteSurfacePatch({
    transcriptHydrationStatus: "idle",
  });
}

export function markTranscriptHydrationComplete() {
  applyRemoteSurfacePatch({
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
  });
}

export function getTranscriptHydrationThreadId(state) {
  return state.transcriptHydrationThreadId;
}

export function getTranscriptHydrationSignature(state) {
  return state.transcriptHydrationSignature;
}

export function getTranscriptHydrationCursor(state) {
  return state.transcriptHydrationOlderCursor;
}

export function mergeTranscriptHydrationPage(state, page, { prepend = false } = {}) {
  let cacheState = state;
  let pendingCachePatch = null;
  const nextEntries = new Map(state.transcriptHydrationEntries);
  const nextOrder = prepend ? [...state.transcriptHydrationOrder] : [];
  const pageItemIds = [];

  for (const entry of page.entries || []) {
    const itemId = entry?.item_id;
    if (!itemId) {
      continue;
    }
    const preparedEntry = prepareTranscriptEntryForSurface(
      cacheState,
      page.thread_id || state.transcriptHydrationThreadId,
      entry,
      { applyPatch: false }
    );
    const surfaceEntry = preparedEntry.entry;
    if (preparedEntry.cachePatch) {
      pendingCachePatch = preparedEntry.cachePatch;
      cacheState = {
        ...cacheState,
        ...preparedEntry.cachePatch,
      };
    }
    nextEntries.set(itemId, {
      item_id: itemId,
      kind: surfaceEntry.kind,
      text: surfaceEntry.text || null,
      status: surfaceEntry.status,
      turn_id: surfaceEntry.turn_id || null,
      tool: surfaceEntry.tool || null,
    });
    pageItemIds.push(itemId);
  }

  const mergedOrder = prepend
    ? uniqueItemIds([...pageItemIds, ...nextOrder])
    : uniqueItemIds(pageItemIds);
  const nextStatus =
    page.prev_cursor == null
      ? "complete"
      : state.transcriptHydrationTailReady || !prepend
        ? "idle"
        : "loading";

  applyRemoteSurfacePatch({
    ...(pendingCachePatch || {}),
    transcriptHydrationEntries: nextEntries,
    transcriptHydrationOrder: mergedOrder,
    transcriptHydrationOlderCursor: page.prev_cursor ?? null,
    transcriptHydrationStatus: nextStatus,
    transcriptHydrationTailReady: mergedOrder.length > 0,
  });
}

export function buildHydratedTranscriptProgress(state) {
  const snapshot = state.transcriptHydrationBaseSnapshot;
  if (!snapshot || state.session?.active_thread_id !== snapshot.active_thread_id) {
    return null;
  }

  return buildHydratedTranscriptSnapshot(state, snapshot);
}

export function transcriptHydrationSignature(snapshot) {
  const parts = [
    snapshot.active_thread_id || "",
    snapshot.active_turn_id || "",
    String(snapshot.transcript?.length || 0),
  ];

  for (const entry of snapshot.transcript || []) {
    parts.push(
      entry.item_id || "",
      entry.kind || "",
      entry.status || "",
      entry.turn_id || "",
      entry.tool?.item_type || "",
      entry.tool?.name || "",
      entry.tool?.path || "",
      entry.tool?.url || "",
      entry.tool?.command || ""
    );
  }

  return parts.join("|");
}

function resetTranscriptHydration(snapshot, signature) {
  applyRemoteSurfacePatch({
    ...createClearedTranscriptHydrationPatch(),
    transcriptHydrationBaseSnapshot: snapshot,
    transcriptHydrationSignature: signature,
    transcriptHydrationThreadId: snapshot.active_thread_id,
  });
}

function buildHydratedTranscriptSnapshot(state, snapshot) {
  const transcript = state.transcriptHydrationOrder
    .map((itemId) => state.transcriptHydrationEntries.get(itemId))
    .filter(Boolean);

  if (!transcript.length) {
    return snapshot;
  }

  return {
    ...snapshot,
    transcript,
    transcript_truncated: state.transcriptHydrationOlderCursor != null,
  };
}

function uniqueItemIds(itemIds) {
  const seen = new Set();
  const unique = [];
  for (const itemId of itemIds) {
    if (!itemId || seen.has(itemId)) {
      continue;
    }
    seen.add(itemId);
    unique.push(itemId);
  }
  return unique;
}
