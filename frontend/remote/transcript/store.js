import {
  applyRemoteSurfacePatch,
  createClearedTranscriptHydrationPatch,
} from "../surface-state.js";

export function clearTranscriptHydration(state) {
  applyRemoteSurfacePatch(createClearedTranscriptHydrationPatch());
}

export function restoreHydratedTranscript(state, snapshot) {
  if (!snapshot?.active_thread_id || !snapshot.transcript_truncated) {
    return snapshot;
  }

  const signature = transcriptHydrationSignature(snapshot);
  if (
    state.transcriptHydrationThreadId !== snapshot.active_thread_id
    || state.transcriptHydrationSignature !== signature
    || !state.transcriptHydrationEntries.size
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
    applyRemoteSurfacePatch({
      transcriptHydrationBaseSnapshot: snapshot,
    });
  }

  return {
    signature,
    shouldHydrate: true,
    alreadyComplete: state.transcriptHydrationStatus === "complete",
    existingPromise: state.transcriptHydrationPromise,
  };
}

export function beginTranscriptHydration(state) {
  applyRemoteSurfacePatch({
    transcriptHydrationStatus: "loading",
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

export function setTranscriptHydrationIdle(state) {
  applyRemoteSurfacePatch({
    transcriptHydrationStatus: "idle",
  });
}

export function markTranscriptHydrationComplete(state) {
  applyRemoteSurfacePatch({
    transcriptHydrationStatus: "complete",
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

export function setTranscriptHydrationFetchAt(state, timestamp) {
  applyRemoteSurfacePatch({
    transcriptHydrationLastFetchAt: timestamp,
  });
}

export function getTranscriptHydrationLastFetchAt(state) {
  return state.transcriptHydrationLastFetchAt;
}

export function mergeTranscriptHydrationPage(state, page) {
  const nextEntries = new Map(state.transcriptHydrationEntries);
  for (const entryPage of page.entries || []) {
    if (!nextEntries.has(entryPage.entry_index)) {
      nextEntries.set(entryPage.entry_index, {
        item_id: entryPage.item_id,
        kind: entryPage.kind,
        status: entryPage.status,
        turn_id: entryPage.turn_id || null,
        tool: entryPage.tool || null,
        parts: new Array(entryPage.part_count),
      });
    }

    const entry = nextEntries.get(entryPage.entry_index);
    entry.item_id = entryPage.item_id;
    entry.kind = entryPage.kind;
    entry.status = entryPage.status;
    entry.turn_id = entryPage.turn_id || null;
    entry.tool = entryPage.tool || null;
    if (entryPage.part_count > entry.parts.length) {
      entry.parts.length = entryPage.part_count;
    }

    for (const part of entryPage.parts || []) {
      if (part.part_index >= entry.parts.length) {
        entry.parts.length = entryPage.part_count;
      }
      entry.parts[part.part_index] = part.text || "";
    }
  }

  applyRemoteSurfacePatch({
    transcriptHydrationEntries: nextEntries,
    transcriptHydrationOlderCursor: page.prev_cursor ?? null,
    transcriptHydrationStatus: page.prev_cursor == null ? "complete" : "loading",
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

function resetTranscriptHydration(state, snapshot, signature) {
  applyRemoteSurfacePatch({
    ...createClearedTranscriptHydrationPatch(),
    transcriptHydrationBaseSnapshot: snapshot,
    transcriptHydrationSignature: signature,
    transcriptHydrationThreadId: snapshot.active_thread_id,
  });
}

function buildHydratedTranscriptSnapshot(state, snapshot) {
  const loadedEntries = buildHydratedTranscriptEntries(state);
  const resolvedTailEntries = new Map(
    loadedEntries
      .filter((entry) => entry.complete && entry.item_id)
      .map((entry) => [entry.item_id, entry])
  );
  const tailEntries = (snapshot.transcript || []).map((entry) => {
    const resolved = entry.item_id ? resolvedTailEntries.get(entry.item_id) : null;
    if (!resolved) {
      return entry;
    }

    const { complete, ...nextEntry } = resolved;
    return nextEntry;
  });
  const tailItemIds = new Set(
    (snapshot.transcript || []).map((entry) => entry.item_id).filter(Boolean)
  );
  const olderLoadedEntries = loadedEntries
    .filter((entry) => !tailItemIds.has(entry.item_id))
    .map(({ complete, ...entry }) => entry);

  return {
    ...snapshot,
    transcript: [...olderLoadedEntries, ...tailEntries],
    transcript_truncated: state.transcriptHydrationStatus !== "complete",
  };
}

function buildHydratedTranscriptEntries(state) {
  return [...state.transcriptHydrationEntries.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => {
      let complete = true;
      let text = "";
      for (const part of entry.parts) {
        if (typeof part !== "string") {
          complete = false;
          continue;
        }
        text += part;
      }

      return {
        item_id: entry.item_id,
        kind: entry.kind,
        text: text || null,
        status: entry.status,
        turn_id: entry.turn_id,
        tool: entry.tool,
        complete,
      };
    });
}
