export function createClearedTranscriptHydrationPatch() {
  return {
    transcriptHydrationBaseSnapshot: null,
    transcriptHydrationEntries: new Map(),
    transcriptHydrationLastFetchAt: 0,
    transcriptHydrationOrder: [],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: false,
    transcriptHydrationThreadId: null,
  };
}

export function transcriptHydrationSignature(snapshot) {
  const parts = [
    snapshot.active_thread_id || "",
    snapshot.active_turn_id || "",
    String(snapshot.transcript_revision ?? ""),
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

export function restoreHydratedTranscriptSnapshot(state, snapshot) {
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

export function prepareTranscriptHydrationState(state, snapshot) {
  if (!snapshot?.active_thread_id || !snapshot.transcript_truncated) {
    return {
      signature: null,
      shouldHydrate: false,
      alreadyComplete: false,
      existingPromise: null,
      patch: null,
    };
  }

  const signature = transcriptHydrationSignature(snapshot);
  const patch =
    state.transcriptHydrationThreadId !== snapshot.active_thread_id
      || state.transcriptHydrationSignature !== signature
      ? {
        ...createClearedTranscriptHydrationPatch(),
        transcriptHydrationBaseSnapshot: snapshot,
        transcriptHydrationSignature: signature,
        transcriptHydrationThreadId: snapshot.active_thread_id,
      }
      : {
        transcriptHydrationBaseSnapshot: snapshot,
      };

  return {
    signature,
    shouldHydrate: !state.transcriptHydrationTailReady,
    alreadyComplete:
      state.transcriptHydrationTailReady && state.transcriptHydrationOlderCursor == null,
    existingPromise: state.transcriptHydrationPromise,
    patch,
  };
}

export function createTranscriptHydrationStatusPatch(status = "loading") {
  return {
    transcriptHydrationStatus: status,
  };
}

export function createTranscriptHydrationPromisePatch(promise) {
  return {
    transcriptHydrationPromise: promise,
  };
}

export function createClearedTranscriptHydrationPromisePatch(state, signature) {
  if (state.transcriptHydrationSignature !== signature) {
    return null;
  }

  return {
    transcriptHydrationPromise: null,
  };
}

export function createTranscriptHydrationCompletePatch() {
  return {
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
  };
}

export function createMergedTranscriptHydrationPagePatch(
  state,
  page,
  {
    prepend = false,
    prepareEntry = defaultPrepareTranscriptEntry,
  } = {}
) {
  let workingState = state;
  let accumulatedPatch = null;
  const nextEntries = new Map(state.transcriptHydrationEntries);
  const nextOrder = prepend ? [...state.transcriptHydrationOrder] : [];
  const pageItemIds = [];

  for (const entry of page.entries || []) {
    const itemId = entry?.item_id;
    if (!itemId) {
      continue;
    }

    const prepared = prepareEntry(
      workingState,
      page.thread_id || state.transcriptHydrationThreadId,
      entry
    ) || {};
    if (prepared.patch) {
      accumulatedPatch = {
        ...(accumulatedPatch || {}),
        ...prepared.patch,
      };
      workingState = {
        ...workingState,
        ...prepared.patch,
      };
    }

    nextEntries.set(itemId, toTranscriptEntry(prepared.entry || entry));
    pageItemIds.push(itemId);
  }

  const nextOrderValue = prepend
    ? uniqueItemIds([...pageItemIds, ...nextOrder])
    : uniqueItemIds(pageItemIds);
  const nextStatus =
    page.prev_cursor == null
      ? "complete"
      : state.transcriptHydrationTailReady || !prepend
        ? "idle"
        : "loading";

  return {
    ...(accumulatedPatch || {}),
    transcriptHydrationEntries: nextEntries,
    transcriptHydrationLastFetchAt: Date.now(),
    transcriptHydrationOrder: nextOrderValue,
    transcriptHydrationOlderCursor: page.prev_cursor ?? null,
    transcriptHydrationStatus: nextStatus,
    transcriptHydrationTailReady: nextOrderValue.length > 0,
  };
}

export function buildHydratedTranscriptProgress(state) {
  const snapshot = state.transcriptHydrationBaseSnapshot;
  if (!snapshot || state.session?.active_thread_id !== snapshot.active_thread_id) {
    return null;
  }
  const snapshotRevision = numericRevision(snapshot.transcript_revision);
  const sessionRevision = numericRevision(state.session?.transcript_revision);
  if (
    snapshotRevision != null
    && sessionRevision != null
    && snapshotRevision < sessionRevision
  ) {
    return null;
  }

  return buildHydratedTranscriptSnapshot(state, snapshot);
}

function numericRevision(value) {
  return Number.isSafeInteger(value) ? value : null;
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

function defaultPrepareTranscriptEntry(_state, _threadId, entry) {
  return {
    entry,
    patch: null,
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
