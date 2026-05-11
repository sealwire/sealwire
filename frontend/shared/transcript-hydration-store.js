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
    String(snapshot.transcript?.length || 0),
  ];

  for (const entry of snapshot.transcript || []) {
    parts.push(
      entry.item_id || "",
      entry.kind || "",
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
    || !state.transcriptHydrationOrder.length
  ) {
    return snapshot;
  }

  return buildHydratedTranscriptSnapshot(state, snapshot, {
    signature,
    overlayEntries: snapshot.transcript || [],
  });
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
  const sameThreadWithVisibleEntries =
    state.transcriptHydrationThreadId === snapshot.active_thread_id
    && state.transcriptHydrationOrder.length > 0;
  const patch = sameThreadWithVisibleEntries
    ? createMergedSnapshotTailPatch(state, snapshot, signature)
    : state.transcriptHydrationThreadId !== snapshot.active_thread_id
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

    nextEntries.set(
      itemId,
      mergeTranscriptEntry(nextEntries.get(itemId), toTranscriptEntry(prepared.entry || entry))
    );
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

  return buildHydratedTranscriptSnapshot(state, snapshot);
}

function buildHydratedTranscriptSnapshot(
  state,
  snapshot,
  {
    overlayEntries = [],
  } = {}
) {
  const entries = new Map(state.transcriptHydrationEntries);
  const order = [...state.transcriptHydrationOrder];

  for (const entry of overlayEntries || []) {
    const itemId = entry?.item_id;
    if (!itemId) {
      continue;
    }
    entries.set(itemId, mergeTranscriptEntry(entries.get(itemId), toTranscriptEntry(entry)));
    if (!order.includes(itemId)) {
      order.push(itemId);
    }
  }

  const transcript = order.map((itemId) => entries.get(itemId)).filter(Boolean);

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

function createMergedSnapshotTailPatch(state, snapshot, signature) {
  const nextEntries = new Map(state.transcriptHydrationEntries);
  const nextOrder = [...state.transcriptHydrationOrder];

  for (const entry of snapshot.transcript || []) {
    const itemId = entry?.item_id;
    if (!itemId) {
      continue;
    }
    nextEntries.set(itemId, mergeTranscriptEntry(nextEntries.get(itemId), toTranscriptEntry(entry)));
    if (!nextOrder.includes(itemId)) {
      nextOrder.push(itemId);
    }
  }

  return {
    transcriptHydrationBaseSnapshot: snapshot,
    transcriptHydrationEntries: nextEntries,
    transcriptHydrationOrder: nextOrder,
    transcriptHydrationSignature: signature,
    transcriptHydrationThreadId: snapshot.active_thread_id,
  };
}

function mergeTranscriptEntry(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  return {
    ...existing,
    ...incoming,
    text: selectTranscriptText(existing.text, incoming.text),
    tool: mergeToolView(existing.tool, incoming.tool),
    turn_id: incoming.turn_id || existing.turn_id || null,
  };
}

function selectTranscriptText(existingText, incomingText) {
  if (incomingText == null) {
    return existingText ?? null;
  }
  if (existingText == null) {
    return incomingText;
  }
  if (looksTruncated(incomingText) && existingText.length > incomingText.length) {
    return existingText;
  }
  return incomingText.length >= existingText.length ? incomingText : existingText;
}

function mergeToolView(existingTool, incomingTool) {
  if (!existingTool) {
    return incomingTool || null;
  }
  if (!incomingTool) {
    return existingTool;
  }

  return {
    ...existingTool,
    ...incomingTool,
    detail: selectTranscriptText(existingTool.detail, incomingTool.detail),
    input_preview: selectTranscriptText(existingTool.input_preview, incomingTool.input_preview),
    result_preview: selectTranscriptText(existingTool.result_preview, incomingTool.result_preview),
    diff: selectTranscriptText(existingTool.diff, incomingTool.diff),
    file_changes: mergeFileChanges(existingTool.file_changes, incomingTool.file_changes),
  };
}

function mergeFileChanges(existingChanges, incomingChanges) {
  if (!Array.isArray(existingChanges) || !existingChanges.length) {
    return incomingChanges || existingChanges || [];
  }
  if (!Array.isArray(incomingChanges) || !incomingChanges.length) {
    return existingChanges;
  }

  const changesByPath = new Map(existingChanges.map((change) => [change.path, change]));
  const order = existingChanges.map((change) => change.path);
  for (const incoming of incomingChanges) {
    const key = incoming.path;
    const existing = changesByPath.get(key);
    changesByPath.set(key, {
      ...(existing || {}),
      ...incoming,
      diff: selectTranscriptText(existing?.diff, incoming.diff),
    });
    if (!order.includes(key)) {
      order.push(key);
    }
  }

  return order.map((key) => changesByPath.get(key)).filter(Boolean);
}

function looksTruncated(value) {
  return typeof value === "string" && value.endsWith("...");
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
