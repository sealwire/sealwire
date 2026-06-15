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

// Per-thread retention: switching threads used to clear the single live
// hydration slot, so returning reloaded only the tail and lost the older window
// the user had scrolled into view. We instead stash the leaving thread's window
// and restore it on switch-back. The cache lives directly on `state` (a Map) and
// is intentionally NOT part of createClearedTranscriptHydrationPatch, so a clear
// of the live slot does not wipe the retained windows. Bounded by an LRU cap so
// browsing many threads can't retain transcript memory indefinitely.
export const MAX_RETAINED_HYDRATION_THREADS = 10;

function ensureHydrationThreadCache(state) {
  if (!(state.transcriptHydrationThreadCache instanceof Map)) {
    state.transcriptHydrationThreadCache = new Map();
  }
  return state.transcriptHydrationThreadCache;
}

// Drop every retained per-thread window. Called on a genuine session teardown
// (disconnect / unpair / auth loss) — NOT on a thread switch — so stale windows
// from a torn-down session never resurface (and never leak across surfaces that
// reuse one state object).
export function clearTranscriptHydrationThreadCache(state) {
  if (state.transcriptHydrationThreadCache instanceof Map) {
    state.transcriptHydrationThreadCache.clear();
  }
}

// Save the currently-loaded window for the active hydration thread so it can be
// restored on switch-back. No-op when there is nothing loaded yet. `extra` lets
// a caller attach surface-specific state (e.g. a scroll offset) to the stash.
export function stashTranscriptHydrationForThread(state, extra = null) {
  const threadId = state.transcriptHydrationThreadId;
  if (!threadId || !(state.transcriptHydrationOrder?.length > 0)) {
    return;
  }
  const cache = ensureHydrationThreadCache(state);
  // Re-insert to refresh LRU recency (Map preserves insertion order).
  cache.delete(threadId);
  cache.set(threadId, {
    entries: new Map(state.transcriptHydrationEntries),
    order: [...state.transcriptHydrationOrder],
    olderCursor: state.transcriptHydrationOlderCursor ?? null,
    signature: state.transcriptHydrationSignature ?? null,
    tailReady: Boolean(state.transcriptHydrationTailReady),
    ...(extra ? { extra } : {}),
  });
  while (cache.size > MAX_RETAINED_HYDRATION_THREADS) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// Look up (without consuming) a thread's retained stash, if any.
export function peekTranscriptHydrationStash(state, threadId) {
  if (!threadId) {
    return null;
  }
  const cache = ensureHydrationThreadCache(state);
  return cache.get(threadId) || null;
}

// Return a patch that repopulates the live hydration slot from a thread's
// retained window, or a cleared slot when nothing is retained. The next snapshot
// for that thread merges its fresh tail onto the restored window via the normal
// prepareTranscriptHydration path, so retained older history + a live tail
// coexist correctly.
export function restoreTranscriptHydrationForThread(state, threadId) {
  const cache = ensureHydrationThreadCache(state);
  const stash = threadId ? cache.get(threadId) : null;
  if (!stash) {
    return {
      ...createClearedTranscriptHydrationPatch(),
      transcriptHydrationThreadId: threadId ?? null,
    };
  }
  // Refresh LRU recency on access.
  cache.delete(threadId);
  cache.set(threadId, stash);
  return {
    ...createClearedTranscriptHydrationPatch(),
    transcriptHydrationEntries: new Map(stash.entries),
    transcriptHydrationOrder: [...stash.order],
    transcriptHydrationOlderCursor: stash.olderCursor ?? null,
    transcriptHydrationSignature: stash.signature ?? null,
    transcriptHydrationTailReady: Boolean(stash.tailReady),
    transcriptHydrationThreadId: threadId,
    // Leave status idle: the next snapshot's prepareTranscriptHydration recomputes
    // whether the tail still needs a fetch, merging onto the restored window.
    transcriptHydrationStatus: "idle",
  };
}

// Test/perf instrumentation: counts how many times a per-snapshot code path
// materializes a copy of the ENTIRE hydrated window (`new Map(allEntries)` /
// `[...allOrder]`). The freeze investigation
// (markdown/transcript-perf-freeze-analysis.md) found these O(n) copies ran on
// every streaming snapshot. The steady-state per-snapshot path must keep this at
// zero (it should touch only the ~tail); page loads/hydration may still copy.
let transcriptFullWindowCopyCount = 0;

export function __readTranscriptFullWindowCopyCount() {
  return transcriptFullWindowCopyCount;
}

export function __resetTranscriptFullWindowCopyCount() {
  transcriptFullWindowCopyCount = 0;
}

function noteFullWindowCopy() {
  transcriptFullWindowCopyCount += 1;
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

// Explicit per-entry content state from the wire. The relay marks a compacted
// entry `preview` (ellipsis-truncated, still readable) or `omitted` (heavy
// content dropped to an identity shell). Anything else — including a missing
// field or a genuine body that happens to end in "..." — is authoritative
// `full`. This is the ONLY omission signal; string-suffix inference is gone.
const CONTENT_STATE_FULL = "full";
const CONTENT_STATE_PREVIEW = "preview";
const CONTENT_STATE_OMITTED = "omitted";

function contentStateOf(entry) {
  const state = entry?.content_state;
  if (state === CONTENT_STATE_OMITTED || state === CONTENT_STATE_PREVIEW) {
    return state;
  }
  return CONTENT_STATE_FULL;
}

function contentStateRank(state) {
  if (state === CONTENT_STATE_OMITTED) return 0;
  if (state === CONTENT_STATE_PREVIEW) return 1;
  return 2;
}

function rankToContentState(rank) {
  if (rank <= 0) return CONTENT_STATE_OMITTED;
  if (rank === 1) return CONTENT_STATE_PREVIEW;
  return CONTENT_STATE_FULL;
}

function isFullContent(entry) {
  return Boolean(entry) && contentStateOf(entry) === CONTENT_STATE_FULL;
}

// Terminal entry statuses: a `full` body for one of these is FINAL and can be
// trusted as complete. A non-terminal (e.g. running) entry's `full` body is only
// "complete as of this revision" and may still grow, so it must not be treated
// as authoritative when a later snapshot re-describes it as preview/omitted.
const TERMINAL_ENTRY_STATUSES = new Set(["completed", "complete", "failed", "error", "cancelled"]);

function isTerminalEntryStatus(status) {
  return TERMINAL_ENTRY_STATUSES.has(status);
}

// True when the entry's authoritative body has not yet been delivered (it is a
// preview or an omitted shell), so a hydration fetch is still required.
function entryNeedsFullText(entry) {
  return contentStateOf(entry) !== CONTENT_STATE_FULL;
}

// True when the entry's renderable content was dropped to an identity shell. The
// renderer must show a loading placeholder for these — never the clipped shell
// text or an "(empty)" body.
export function transcriptEntryContentOmitted(entry) {
  return contentStateOf(entry) === CONTENT_STATE_OMITTED;
}

// True when the snapshot's tail contains a preview/omitted entry whose
// authoritative body we do not already hold. This is the sole re-hydration gate
// (no signature/shape gate), so a same-id `full -> preview/omitted` transition
// also re-fetches. It is self-terminating:
//   * no full body cached            -> fetch;
//   * preview whose body is LONGER than our cached body (a stale partial)
//                                     -> fetch (the grown server body wins);
//   * omitted whose cached body is non-terminal (still running, provisional)
//                                     -> fetch; once terminal+full it is trusted;
//   * otherwise (cached full+terminal, or a preview no longer than our body)
//                                     -> trusted, no fetch.
function snapshotTailNeedsFullText(state, snapshot) {
  const entries = state.transcriptHydrationEntries;
  for (const entry of snapshot.transcript || []) {
    const incomingState = contentStateOf(entry);
    if (incomingState === CONTENT_STATE_FULL) {
      continue;
    }
    const cached = entries?.get?.(entry.item_id);
    if (!isFullContent(cached)) {
      return true;
    }
    if (incomingState === CONTENT_STATE_PREVIEW) {
      const cachedLen = typeof cached.text === "string" ? cached.text.length : 0;
      const previewLen = typeof entry.text === "string" ? entry.text.length : 0;
      if (cachedLen < previewLen) {
        return true;
      }
      continue;
    }
    // Omitted: the shell text carries no usable length, so trust the cache only
    // when it is a terminal (final) body.
    if (!isTerminalEntryStatus(cached.status)) {
      return true;
    }
  }
  return false;
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
  const sameThread = state.transcriptHydrationThreadId === snapshot.active_thread_id;
  const sameThreadWithVisibleEntries = sameThread && state.transcriptHydrationOrder.length > 0;

  // Re-arm hydration whenever the visible tail still carries a preview/omitted
  // entry whose authoritative body we don't already hold. `snapshotTailNeedsFullText`
  // is the sole gate (NOT a signature/shape change), so:
  //   * a NEW oversized entry joining the tail re-fetches (its body is uncached);
  //   * a same-id entry transitioning `full -> preview/omitted` (it grew past the
  //     budget or was shelled) ALSO re-fetches — the previous shape-change gate
  //     missed this and left the entry frozen on a stale partial body;
  //   * it stays loop-safe because the gate is self-terminating: once we hold the
  //     full terminal body (or a preview no longer than our cache), it returns
  //     false, so repeated snapshots of one turn and pure preview-text shrinks
  //     never re-fetch.
  const reHydrateTail =
    sameThreadWithVisibleEntries && snapshotTailNeedsFullText(state, snapshot);

  let patch = sameThreadWithVisibleEntries
    ? createMergedSnapshotTailPatch(state, snapshot, signature)
    : !sameThread || state.transcriptHydrationSignature !== signature
        ? {
          ...createClearedTranscriptHydrationPatch(),
          transcriptHydrationBaseSnapshot: snapshot,
          transcriptHydrationSignature: signature,
          transcriptHydrationThreadId: snapshot.active_thread_id,
        }
        : {
          transcriptHydrationBaseSnapshot: snapshot,
        };

  if (reHydrateTail) {
    // Keep the already-hydrated entries/order for an instant render, but re-arm
    // the fetch path so the new tail (with full text) is pulled exactly once.
    patch = {
      ...patch,
      transcriptHydrationTailReady: false,
      transcriptHydrationStatus: "idle",
      transcriptHydrationPromise: null,
    };
  }

  return {
    signature,
    shouldHydrate: reHydrateTail || !state.transcriptHydrationTailReady,
    alreadyComplete:
      !reHydrateTail
      && state.transcriptHydrationTailReady
      && state.transcriptHydrationOlderCursor == null,
    existingPromise: reHydrateTail ? null : state.transcriptHydrationPromise,
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
  // A page load (cold hydration / older-history prepend) legitimately
  // materializes the full window. This is user-paced (scroll / initial load),
  // not a per-streaming-snapshot cost, so the O(n) copy here is acceptable.
  noteFullWindowCopy();
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

  const hydrated = buildHydratedTranscriptSnapshot(state, snapshot);
  if (!hydrated) return null;

  if (state.session) {
    return {
      ...state.session,
      transcript: hydrated.transcript,
      transcript_truncated: hydrated.transcript_truncated,
    };
  }

  return hydrated;
}

function buildHydratedTranscriptSnapshot(
  state,
  snapshot,
  {
    overlayEntries = [],
  } = {}
) {
  // Overlay ONLY the (small) snapshot tail — never clone the whole window every
  // snapshot (that O(n) copy is the long-session freeze; see
  // markdown/transcript-perf-freeze-analysis.md). Unchanged older entries are
  // read straight from the live map by reference; genuinely-new item ids are
  // appended to a shallow order copy.
  const baseEntries = state.transcriptHydrationEntries;
  const baseOrder = state.transcriptHydrationOrder;
  let overlay = null;
  let appended = null;

  for (const entry of overlayEntries || []) {
    const itemId = entry?.item_id;
    if (!itemId) {
      continue;
    }
    const existing = baseEntries.get(itemId);
    (overlay ||= new Map()).set(
      itemId,
      mergeTranscriptEntry(existing, prepareSnapshotOverlayEntry(existing, entry))
    );
    // includes() runs only for a genuinely-new tail id (rare), not every entry.
    if (existing === undefined && !baseOrder.includes(itemId)) {
      (appended ||= []).push(itemId);
    }
  }

  const order = appended ? [...baseOrder, ...appended] : baseOrder;
  const transcript = order
    .map((itemId) => (overlay && overlay.has(itemId) ? overlay.get(itemId) : baseEntries.get(itemId)))
    .filter(Boolean);

  if (!transcript.length) {
    return snapshot;
  }

  return {
    ...snapshot,
    transcript,
    transcript_truncated:
      state.transcriptHydrationOlderCursor != null
      || snapshotTailNeedsFullText(state, snapshot),
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
    content_state: contentStateOf(entry),
  };
}

function createMergedSnapshotTailPatch(state, snapshot, signature) {
  // Mutate the live window IN PLACE — do not clone the whole map/array every
  // snapshot (the O(n) copy that froze long sessions; see
  // markdown/transcript-perf-freeze-analysis.md). Safe because the per-thread
  // retention cache copies defensively at switch time
  // (`stashTranscriptHydrationForThread`), so in-place updates here can never
  // corrupt a retained window, and every consumer reads the live state fresh.
  const entries = state.transcriptHydrationEntries;
  const order = state.transcriptHydrationOrder;

  for (const entry of snapshot.transcript || []) {
    const itemId = entry?.item_id;
    if (!itemId) {
      continue;
    }
    const existing = entries.get(itemId);
    const wasPresent = existing !== undefined;
    entries.set(
      itemId,
      mergeTranscriptEntry(existing, prepareSnapshotOverlayEntry(existing, entry))
    );
    // includes() runs only for a genuinely-new tail id (rare), not every entry.
    if (!wasPresent && !order.includes(itemId)) {
      order.push(itemId);
    }
  }

  return {
    transcriptHydrationBaseSnapshot: snapshot,
    transcriptHydrationEntries: entries,
    transcriptHydrationOrder: order,
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

  const existingFull = isFullContent(existing);
  const incomingFull = isFullContent(incoming);
  // The merged content_state is the more-authoritative of the two, because we
  // keep the more complete body below. This is how an authoritative page (full)
  // overlaying a cached omitted/preview shell promotes the entry to full.
  const mergedContentState = rankToContentState(
    Math.max(
      contentStateRank(contentStateOf(existing)),
      contentStateRank(contentStateOf(incoming))
    )
  );

  return {
    ...existing,
    ...incoming,
    text: selectTranscriptText(existing.text, incoming.text, existingFull, incomingFull),
    tool: mergeToolView(existing.tool, incoming.tool, existingFull, incomingFull),
    turn_id: incoming.turn_id || existing.turn_id || null,
    content_state: mergedContentState,
  };
}

// Project a snapshot tail entry for overlay/merge. An `omitted` entry's text is
// the relay's clipped identity shell, which must never be rendered as message
// content. Drop it to `null` (keeping identity + the omitted state) unless we
// already hold the authoritative body — the renderer then shows a unified
// loading placeholder, and hydration replaces it in place.
function prepareSnapshotOverlayEntry(existing, entry) {
  const incoming = toTranscriptEntry(entry);
  // An omitted entry's text is the relay's meaningless clipped identity shell —
  // it must NEVER be merged or rendered. Drop it to null unconditionally; the
  // merge then keeps any authoritative body we already hold, and the renderer
  // falls back to a loading placeholder when none exists. Hydration replaces it.
  if (transcriptEntryContentOmitted(incoming)) {
    return {
      ...incoming,
      text: null,
    };
  }
  return incoming;
}

function selectTranscriptText(existingText, incomingText, existingFull = true, incomingFull = true) {
  if (incomingText == null) {
    return existingText ?? null;
  }
  if (existingText == null) {
    return incomingText;
  }
  // Keep a cached full body over a non-authoritative (preview) incoming body ONLY
  // when our cache is at least as long — i.e. genuinely more complete. A stale
  // partial cache is SHORTER than the grown preview the server now ships, so the
  // longer one must win (otherwise the entry freezes on the partial). No
  // "..."-suffix inference; fullness comes from content_state and length.
  if (existingFull && !incomingFull && existingText.length >= incomingText.length) {
    return existingText;
  }
  return incomingText.length >= existingText.length ? incomingText : existingText;
}

function mergeToolView(existingTool, incomingTool, existingFull = true, incomingFull = true) {
  if (!existingTool) {
    return incomingTool || null;
  }
  if (!incomingTool) {
    return existingTool;
  }

  return {
    ...existingTool,
    ...incomingTool,
    detail: selectTranscriptText(existingTool.detail, incomingTool.detail, existingFull, incomingFull),
    input_preview: selectTranscriptText(
      existingTool.input_preview,
      incomingTool.input_preview,
      existingFull,
      incomingFull
    ),
    result_preview: selectTranscriptText(
      existingTool.result_preview,
      incomingTool.result_preview,
      existingFull,
      incomingFull
    ),
    diff: selectTranscriptText(existingTool.diff, incomingTool.diff, existingFull, incomingFull),
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
