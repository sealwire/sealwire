export function clearTranscriptHydration(state) {
  state.transcriptHydrationBaseSnapshot = null;
  state.transcriptHydrationEntries = new Map();
  state.transcriptHydrationOrder = [];
  state.transcriptHydrationOlderCursor = null;
  state.transcriptHydrationPromise = null;
  state.transcriptHydrationSignature = null;
  state.transcriptHydrationStatus = "idle";
  state.transcriptHydrationTailReady = false;
  state.transcriptHydrationThreadId = null;
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
    resetTranscriptHydration(state, snapshot, signature);
  } else {
    state.transcriptHydrationBaseSnapshot = snapshot;
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
  state.transcriptHydrationStatus = status;
}

export function setTranscriptHydrationPromise(state, promise) {
  state.transcriptHydrationPromise = promise;
}

export function clearTranscriptHydrationPromise(state, signature) {
  if (state.transcriptHydrationSignature === signature) {
    state.transcriptHydrationPromise = null;
  }
}

export function setTranscriptHydrationIdle(state) {
  state.transcriptHydrationStatus = "idle";
}

export function markTranscriptHydrationComplete(state) {
  state.transcriptHydrationStatus = "complete";
  state.transcriptHydrationTailReady = true;
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
  const nextEntries = new Map(state.transcriptHydrationEntries);
  const nextOrder = prepend ? [...state.transcriptHydrationOrder] : [];
  const pageItemIds = [];

  for (const entry of page.entries || []) {
    const itemId = entry?.item_id;
    if (!itemId) {
      continue;
    }

    nextEntries.set(itemId, toTranscriptEntry(entry));
    pageItemIds.push(itemId);
  }

  state.transcriptHydrationEntries = nextEntries;
  state.transcriptHydrationOrder = prepend
    ? uniqueItemIds([...pageItemIds, ...nextOrder])
    : uniqueItemIds(pageItemIds);
  state.transcriptHydrationOlderCursor = page.prev_cursor ?? null;
  state.transcriptHydrationStatus = page.prev_cursor == null
    ? "complete"
    : state.transcriptHydrationTailReady || !prepend
      ? "idle"
      : "loading";
  state.transcriptHydrationTailReady = state.transcriptHydrationOrder.length > 0;
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

function resetTranscriptHydration(state, snapshot, signature) {
  clearTranscriptHydration(state);
  state.transcriptHydrationBaseSnapshot = snapshot;
  state.transcriptHydrationSignature = signature;
  state.transcriptHydrationThreadId = snapshot.active_thread_id;
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

function toTranscriptEntry(entry) {
  return {
    item_id: entry.item_id,
    kind: entry.kind,
    text: entry.text ?? collapseEntryParts(entry.parts),
    status: entry.status,
    turn_id: entry.turn_id || null,
    tool: entry.tool || null,
  };
}

function collapseEntryParts(parts) {
  if (!Array.isArray(parts) || !parts.length) {
    return null;
  }

  return [...parts]
    .sort((left, right) => (left?.part_index ?? 0) - (right?.part_index ?? 0))
    .map((part) => part?.text || "")
    .join("") || null;
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
