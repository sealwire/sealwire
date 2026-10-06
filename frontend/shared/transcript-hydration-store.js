import { transcriptRowKey } from "./transcript-row-key.js";
import { combineCardBodies } from "./card-body.js";
import {
  normalizeTranscriptDeltaKind,
  resolveDeltaAppend,
} from "./transcript-event-reducer.js";
import {
  reconcileAuthoritativeTail,
  selectTranscriptText,
  uniqueItemIds,
} from "./authoritative-tail-merge.js";
import {
  keyedInsertionIndex,
  mergeWindowRowsInPlace,
  rowHasOrderKey,
  rowsAreOrderKeyed,
  upsertWindowRowInPlace,
  windowIsOrderKeyed,
} from "./transcript-window-reducer.js";

export function createClearedTranscriptHydrationPatch() {
  return {
    transcriptHydrationBaseSnapshot: null,
    transcriptHydrationEntries: new Map(),
    transcriptHydrationFetchedRevision: null,
    transcriptHydrationBodyRevision: null,
    transcriptHydrationLastFetchAt: 0,
    transcriptHydrationOrder: [],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: false,
    transcriptHydrationThreadId: null,
    transcriptHydrationGeneration: null,
    // PROVEN-KEYED invariant: every row numbered AND the order non-decreasing.
    // Cached, not recomputed, because the snapshot and projection paths consult
    // it on every frame and must stay proportional to the tail — an O(window)
    // check there is the freeze this file documents. Established by the
    // user-paced page merges (which already walk the window) and preserved by
    // every cheaper write; anything that cannot preserve it clears it, and the
    // next page merge re-establishes it. An empty window is trivially both.
    transcriptHydrationKeyed: true,
    // Rows whose body we still owe the screen, keyed by row id; see
    // transcript-row-recovery.js. Maintained from the snapshot tail only.
    transcriptUnresolvedRows: new Map(),
    transcriptRowBodyRevisions: new Map(),
    transcriptRowSeenRevisions: new Map(),
    // A tail shell was seen since the last tail fetch; see prepareTranscriptHydrationState.
    transcriptTailSawShells: false,
    transcriptHydrationNeedsTailRepair: false,
    transcriptHydrationBridgeTarget: null,
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
    generation: state.transcriptHydrationGeneration ?? null,
    keyed: state.transcriptHydrationKeyed === true,
    // Owed rows and what the thread knew about each row travel with the window,
    // or a restored thread would re-ask nothing and accept copies it had outgrown.
    unresolved: [...unresolvedRowsOf(state).keys()],
    bodyRevisions: new Map(rowBodyRevisionsOf(state)),
    seenRevisions: new Map(rowSeenRevisionsOf(state)),
    bridgeTarget: state.transcriptHydrationBridgeTarget ?? null,
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
    transcriptHydrationGeneration: stash.generation ?? null,
    // A restored window keeps the proof it was stashed with; a stash written
    // before this field existed restores as unproven, not as trusted.
    transcriptHydrationKeyed: stash.keyed === true,
    transcriptUnresolvedRows: new Map(
      (stash.unresolved || []).map((rowId) => [rowId, freshUnresolvedRow()])
    ),
    transcriptRowBodyRevisions: new Map(stash.bodyRevisions || []),
    transcriptRowSeenRevisions: new Map(stash.seenRevisions || []),
    transcriptHydrationBridgeTarget: stash.bridgeTarget ?? null,
    transcriptHydrationNeedsTailRepair: stash.bridgeTarget != null,
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

// Test/perf instrumentation: counts array entries VISITED while
// renderedTranscriptFromWindow builds its array-fallback lookup map (one
// linear pass over the CURRENT array — see that function's own doc). Must
// total exactly (calls * array length), proving the array is scanned once
// per call, not once per WINDOW entry per call: a regression back to a
// per-window-entry `.find()` against the array would instead total
// (calls * array length * window length), which is exactly what the perf
// test's assertion on this counter would catch — a `.find()` visits the
// whole array too, so only the multiplier (window length) reveals it.
let transcriptArrayFallbackLookupBuildCount = 0;

export function __readTranscriptArrayFallbackLookupBuildCount() {
  return transcriptArrayFallbackLookupBuildCount;
}

export function __resetTranscriptArrayFallbackLookupBuildCount() {
  transcriptArrayFallbackLookupBuildCount = 0;
}

export function transcriptHydrationSignature(snapshot) {
  const parts = [
    snapshot.active_thread_id || "",
    snapshot.active_turn_id || "",
    String(snapshot.transcript?.length || 0),
  ];

  for (const entry of snapshot.transcript || []) {
    parts.push(
      transcriptRowKey(entry) || "",
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
    // Ids from a previous relay process name these messages differently; overlaying
    // that window would paint each of them twice until the next prepare clears it.
    || (state.transcriptHydrationGeneration || "") !== (snapshot.transcript_generation || "")
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

/**
 * Has the transcript advanced past the revision we last fetched at, with no
 * turn still running? Then a cached body predates the final text.
 */
function turnSettledSinceHydration(state, snapshot) {
  if (snapshot.active_turn_id) {
    return false;
  }
  const revision = snapshot.transcript_revision;
  if (revision == null || state.transcriptHydrationBodyRevision == null) {
    // Never hydrated at a known revision, so there is nothing to compare and
    // the cold-boot path already fetches unconditionally.
    return false;
  }
  return revision !== state.transcriptHydrationBodyRevision;
}

// A running row we can only see by reading it is re-read at most this often.
export const RUNNING_ROW_REFRESH_MS = 1_500;

// Retry spacing for a row whose recovery failed; doubles per attempt.
export const ROW_RECOVERY_RETRY_BASE_MS = 1_000;
export const ROW_RECOVERY_RETRY_MAX_MS = 30_000;

function freshUnresolvedRow() {
  return { attempts: 0, retryAt: 0, inFlight: false };
}

function unresolvedRowsOf(state) {
  if (!(state.transcriptUnresolvedRows instanceof Map)) {
    state.transcriptUnresolvedRows = new Map();
  }
  return state.transcriptUnresolvedRows;
}

// `{ revision, at, terminal }` for each row whose held body came from a read (a
// page or a recovery). A merge overwrites the held row's status, so whether the
// body was read after the row finished lives here. Deltas never set it.
function rowBodyRevisionsOf(state) {
  if (!(state.transcriptRowBodyRevisions instanceof Map)) {
    state.transcriptRowBodyRevisions = new Map();
  }
  return state.transcriptRowBodyRevisions;
}

// Authoritative rows (a page, a recovery) settle whatever we owed for them.
function resolveRowsCarriedBy(state, rows, bodyRevision = null) {
  const unresolved = unresolvedRowsOf(state);
  const revisions = rowBodyRevisionsOf(state);
  for (const row of rows) {
    const rowId = transcriptRowKey(row);
    if (!rowId) {
      continue;
    }
    unresolved.delete(rowId);
    if (bodyRevision != null) {
      revisions.set(rowId, {
        revision: bodyRevision,
        at: Date.now(),
        terminal: isTerminalEntryStatus(row.status),
      });
    }
  }
}

// The newest transcript revision at which we learned something about each row: a
// page or recovery (a full copy), or a snapshot that changed what we hold. A copy
// older than that is refused everywhere, so an answer that was slow to arrive can
// never undo a newer status, body or apply state. A snapshot that only repeats a
// row does not count, or every streamed chunk would outdate every answer in flight.
function rowSeenRevisionsOf(state) {
  if (!(state.transcriptRowSeenRevisions instanceof Map)) {
    state.transcriptRowSeenRevisions = new Map();
  }
  return state.transcriptRowSeenRevisions;
}

function noteRowSeen(state, rowId, revision) {
  if (revision == null) {
    return;
  }
  const seen = rowSeenRevisionsOf(state);
  const prior = seen.get(rowId);
  if (prior == null || revision > prior) {
    seen.set(rowId, revision);
  }
}

function isStaleCopy(state, rowId, revision) {
  if (revision == null) {
    return false;
  }
  const seen = rowSeenRevisionsOf(state).get(rowId);
  return seen != null && revision < seen;
}

// A page row that the window already holds a newer copy of.
function isStaleHeldRow(state, row, revision) {
  const rowId = transcriptRowKey(row);
  return state.transcriptHydrationEntries.has(rowId) && isStaleCopy(state, rowId, revision ?? null);
}

/** For reconcileAuthoritativeTail's `isStale`: is a page read at `revision` older than what we hold? */
export function staleTranscriptRowGuard(state, revision) {
  return (_existing, incoming) => isStaleCopy(state, transcriptRowKey(incoming), revision);
}

/** Record authoritative rows a caller merged itself (Remote's gap repair). */
export function noteTranscriptRowsSeen(state, rows, revision) {
  for (const row of rows || []) {
    const rowId = transcriptRowKey(row);
    if (rowId) {
      noteRowSeen(state, rowId, revision);
    }
  }
}

/**
 * Merge one snapshot-tail row into `entries` and keep the owed set in step.
 * The one place a snapshot row lands, whether the render overlay or the
 * hydration merge gets there first, so "is it owed" is always judged against
 * the row as held before this snapshot touched it.
 */
function mergeSnapshotTailRow(state, entries, itemId, entry, snapshot) {
  const existing = entries.get(itemId);
  const revision = snapshot.transcript_revision ?? null;
  if (existing !== undefined && isStaleCopy(state, itemId, revision)) {
    return existing;
  }
  const incoming = prepareSnapshotOverlayEntry(existing, entry);
  if (snapshotRowTellsSomethingNew(existing, incoming)) {
    noteRowSeen(state, itemId, revision);
  }
  const unresolved = unresolvedRowsOf(state);
  if (rowNeedsRecovery(existing, incoming, snapshot, rowBodyRevisionsOf(state))) {
    oweRow(unresolved, itemId);
  } else if (contentStateOf(incoming) === CONTENT_STATE_FULL || incoming.withdrawn === true) {
    // Only an authoritative body settles a row; a frame that merely stops
    // asking (its status was just overwritten) does not.
    unresolved.delete(itemId);
  }
  if (contentStateOf(incoming) !== CONTENT_STATE_FULL) {
    state.transcriptTailSawShells = true;
  }
  return mergeTranscriptEntry(existing, incoming);
}

// A status or withdrawal change, or a full copy that differs from ours (its text,
// or its tool, apply state included). Tail rows only, so the compare stays small.
function snapshotRowTellsSomethingNew(existing, incoming) {
  if (existing === undefined) {
    return true;
  }
  if (existing.status !== incoming.status || (existing.withdrawn === true) !== (incoming.withdrawn === true)) {
    return true;
  }
  // Compaction clips text and diffs but keeps these as they are, so a clipped
  // row can still report them changed.
  if (
    (existing.tool?.apply_state ?? null) !== (incoming.tool?.apply_state ?? null)
    || (existing.tool?.can_apply ?? null) !== (incoming.tool?.can_apply ?? null)
  ) {
    return true;
  }
  if (JSON.stringify(existing.injection ?? null) !== JSON.stringify(incoming.injection ?? null)) {
    return true;
  }
  if (contentStateOf(incoming) !== CONTENT_STATE_FULL) {
    return false;
  }
  return (
    existing.text !== incoming.text
    || JSON.stringify(existing.tool ?? null) !== JSON.stringify(incoming.tool ?? null)
  );
}

// Owed rows the relay keeps failing on are kept to this many, newest first.
export const MAX_OWED_ROWS = 128;

function oweRow(unresolved, rowId) {
  if (unresolved.has(rowId)) {
    return;
  }
  unresolved.set(rowId, freshUnresolvedRow());
  if (unresolved.size <= MAX_OWED_ROWS) {
    return;
  }
  for (const [oldestId, record] of unresolved) {
    if (unresolved.size <= MAX_OWED_ROWS) {
      break;
    }
    if (!record.inFlight && oldestId !== rowId) {
      unresolved.delete(oldestId);
    }
  }
}

/**
 * Do we owe the screen this row's body, given the copy held BEFORE this
 * snapshot is merged (the merge overwrites its status)?
 *
 * A running row is owed when nothing readable is held. After that its growth is
 * the delta stream's; only a shell whose body we could get by reading alone is
 * re-read as the revision moves, and no more often than RUNNING_ROW_REFRESH_MS.
 * A finished row is owed until we hold a full body that was read after it
 * finished. A preview is clipped to a fixed length, so length cannot prove a
 * held body is final: once the turn settles, a preview row is owed once more
 * unless its body was read at or after this revision.
 */
function rowNeedsRecovery(existing, incoming, snapshot, bodyRevisions, now = Date.now()) {
  if (incoming.withdrawn === true || existing?.withdrawn === true) {
    return false;
  }
  const incomingState = contentStateOf(incoming);
  if (incomingState === CONTENT_STATE_FULL) {
    return false;
  }
  const read = bodyRevisions.get(transcriptRowKey(incoming));
  if (!isTerminalEntryStatus(incoming.status)) {
    if (!existing || contentStateOf(existing) === CONTENT_STATE_OMITTED) {
      return true;
    }
    return (
      incomingState === CONTENT_STATE_OMITTED
      && read != null
      && snapshot.transcript_revision != null
      && read.revision < snapshot.transcript_revision
      && now - read.at >= RUNNING_ROW_REFRESH_MS
    );
  }
  if (!isFullContent(existing) || !isTerminalEntryStatus(existing.status)) {
    return true;
  }
  if (read?.terminal === false) {
    return true;
  }
  if (incomingState !== CONTENT_STATE_PREVIEW) {
    return false;
  }
  const heldLen = typeof existing.text === "string" ? existing.text.length : 0;
  const previewLen = typeof incoming.text === "string" ? incoming.text.length : 0;
  if (heldLen < previewLen) {
    return true;
  }
  const revision = snapshot.transcript_revision;
  if (snapshot.active_turn_id || revision == null) {
    return false;
  }
  return read == null || read.revision < revision;
}

/**
 * Take up to `max` owed rows that are not in flight and whose retry time has
 * come, marking them in flight. `nextRetryAt` is the earliest pending retry.
 */
export function takeDueTranscriptRows(state, now, max) {
  const due = [];
  let nextRetryAt = null;
  for (const [rowId, record] of unresolvedRowsOf(state)) {
    if (record.inFlight) {
      continue;
    }
    if (record.retryAt > now) {
      nextRetryAt = nextRetryAt == null ? record.retryAt : Math.min(nextRetryAt, record.retryAt);
      continue;
    }
    if (due.length < max) {
      record.inFlight = true;
      due.push(rowId);
    }
  }
  return { due, nextRetryAt };
}

export function noteTranscriptRowsFailed(state, rowIds, now) {
  const unresolved = unresolvedRowsOf(state);
  for (const rowId of rowIds) {
    const record = unresolved.get(rowId);
    if (!record) {
      continue;
    }
    record.attempts += 1;
    record.inFlight = false;
    record.retryAt =
      now + Math.min(ROW_RECOVERY_RETRY_MAX_MS, ROW_RECOVERY_RETRY_BASE_MS * 2 ** (record.attempts - 1));
  }
}

/**
 * Merge recovered rows into the rows the window already holds; never adds a
 * row. `bodyRevision` is the snapshot revision the request was made at.
 */
export function createRecoveredTranscriptRowsPatch(
  state,
  page,
  requestedIds,
  { prepareEntry = defaultPrepareTranscriptEntry, bodyRevision = null, now = Date.now() } = {}
) {
  const entries = state.transcriptHydrationEntries;
  const unresolved = unresolvedRowsOf(state);
  const revisions = rowBodyRevisionsOf(state);
  // The relay stamps the revision it read at; the request-time snapshot is the fallback.
  const answerRevision = page?.revision ?? bodyRevision;
  let workingState = state;
  let accumulatedPatch = null;
  const answered = new Set();
  for (const entry of page?.entries || []) {
    const rowId = transcriptRowKey(entry);
    if (!rowId) {
      continue;
    }
    answered.add(rowId);
    const existing = entries.get(rowId);
    if (existing === undefined) {
      continue;
    }
    const read = revisions.get(rowId);
    // A newer copy was already seen, or the answer was read before the row
    // finished (rows never reopen): keep what we have and ask again.
    const stale =
      isStaleCopy(state, rowId, answerRevision)
      || (read != null && answerRevision != null && read.revision > answerRevision);
    const predatesFinish =
      isTerminalEntryStatus(existing.status) && !isTerminalEntryStatus(entry.status);
    if (stale || predatesFinish) {
      continue;
    }
    const prepared = prepareEntry(
      workingState,
      page.thread_id || state.transcriptHydrationThreadId,
      entry
    ) || {};
    if (prepared.patch) {
      accumulatedPatch = { ...(accumulatedPatch || {}), ...prepared.patch };
      workingState = { ...workingState, ...prepared.patch };
    }
    entries.set(rowId, mergeTranscriptEntry(existing, toTranscriptEntry(prepared.entry || entry)));
    unresolved.delete(rowId);
    noteRowSeen(state, rowId, answerRevision);
    if (answerRevision != null) {
      revisions.set(rowId, {
        revision: answerRevision,
        at: now,
        terminal: isTerminalEntryStatus(entry.status),
      });
    }
  }
  for (const rowId of page?.missing_rows || []) {
    answered.add(rowId);
    unresolved.delete(rowId);
  }
  // Deferred rows only lost the byte budget: ask again at once. Anything else
  // still owed (left out, or a refused stale answer) backs off, so a relay that
  // keeps answering stale cannot spin this.
  const deferred = new Set(page?.deferred_rows || []);
  const retry = [];
  for (const rowId of requestedIds) {
    const record = unresolved.get(rowId);
    if (!record) {
      continue;
    }
    if (deferred.has(rowId)) {
      record.inFlight = false;
      record.retryAt = 0;
    } else {
      retry.push(rowId);
    }
  }
  noteTranscriptRowsFailed(state, retry, now);
  return {
    ...(accumulatedPatch || {}),
    transcriptHydrationEntries: entries,
    transcriptUnresolvedRows: unresolved,
  };
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
  // A window may only be merged into while it still holds ids from the SAME relay
  // process. A restart rebuilds threads from provider history and renumbers item
  // ids, so merging across that boundary keeps both names for one message and
  // renders it twice. Treating it as a different thread rebuilds the window instead.
  const sameGeneration =
    (state.transcriptHydrationGeneration || "") === (snapshot.transcript_generation || "");
  const sameThread =
    sameGeneration && state.transcriptHydrationThreadId === snapshot.active_thread_id;
  const sameThreadWithVisibleEntries = sameThread && state.transcriptHydrationOrder.length > 0;

  // A re-hydration fetch is actually running iff status is "loading". Re-arming
  // during that window is what froze the tab: the re-arm patch (below) nulls the
  // in-flight promise and forces shouldHydrate, so hydrateTranscript's "reuse the
  // existing promise" short-circuit is bypassed and it starts ANOTHER fetch +
  // synchronously re-fires onProgress. Since the snapshot stays
  // `transcript_truncated` until the fetch RESOLVES (the cached tail entry is
  // still preview/omitted), onProgress -> renderSession ->
  // ensureConversationTranscript re-enters and re-arms again, without bound ->
  // synchronous infinite recursion (see markdown/transcript-perf-freeze-analysis.md).
  // Suppress re-arming while a fetch is pending; the next snapshot after it
  // settles re-evaluates the tail and re-fetches then if it still needs full text.
  //
  // Gate on status ONLY, never on `transcriptHydrationPromise != null`: status is
  // set to "loading" before onProgress fires (so the freeze guard still holds for
  // the synchronous re-entry). The promise is the REQUEST OWNER used to make
  // settle cleanup conditional; it is not the policy gate. A re-arm or thread
  // switch may replace that owner while an older request is still resolving, and
  // the older request must then leave the newer request's loading state alone.
  const hydrationInFlight = state.transcriptHydrationStatus === "loading";

  // candidate #3 — cap the omitted/preview re-fetch to once per revision. The
  // settle of one tail fetch re-fires onProgress -> renderSession ->
  // ensureConversationTranscript at the SAME revision (no new server data, just a
  // round-trip later), and status-only snapshots re-describe the same omitted tail
  // — both would re-arm an identical, useless fetch, an RTT-paced storm against the
  // relay. A genuine transcript change ALWAYS bumps transcript_revision
  // (bump_thread_transcript_revision fires on every delta/tool/status write), so
  // only re-fetch when the revision advances past the one we last fetched at — that
  // still pulls the latest partial body live, just not redundantly within a
  // revision. Inert when the snapshot carries no revision (older/test fixtures):
  // the `!= null` guard falls back to the previous always-re-arm behavior.
  const alreadyFetchedThisRevision =
    snapshot.transcript_revision != null
    && snapshot.transcript_revision === state.transcriptHydrationFetchedRevision;

  // Bodies are owed and recovered row by row (transcript-row-recovery.js), never
  // by re-reading the latest page, which with long rows holds only one or two.
  // The tail page is read once more only when a turn settles after shells were
  // seen, to place rows a skipped snapshot never named.
  const reHydrateTail =
    sameThreadWithVisibleEntries
    && !hydrationInFlight
    && (
      state.transcriptHydrationNeedsTailRepair === true
      || (
        !alreadyFetchedThisRevision
        && state.transcriptTailSawShells === true
        && turnSettledSinceHydration(state, snapshot)
      )
    );

  let patch = sameThreadWithVisibleEntries
    ? createMergedSnapshotTailPatch(state, snapshot, signature)
    : !sameThread || state.transcriptHydrationSignature !== signature
        ? {
          ...createClearedTranscriptHydrationPatch(),
          transcriptHydrationBaseSnapshot: snapshot,
          transcriptHydrationSignature: signature,
          transcriptHydrationThreadId: snapshot.active_thread_id,
          transcriptHydrationGeneration: snapshot.transcript_generation || "",
        }
        : {
          transcriptHydrationBaseSnapshot: snapshot,
        };

  if (reHydrateTail) {
    // Keep the already-hydrated entries/order for an instant render, but re-arm
    // the fetch path so the new tail (with full text) is pulled exactly once.
    // Record the revision we're fetching at so same-revision settles/status-only
    // snapshots don't re-fetch (the candidate #3 gate above reads it back).
    patch = {
      ...patch,
      transcriptHydrationTailReady: false,
      transcriptHydrationStatus: "idle",
      transcriptHydrationPromise: null,
      transcriptHydrationFetchedRevision: snapshot.transcript_revision ?? null,
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

function ownsTranscriptHydrationRequest(state, promise) {
  return state.transcriptHydrationPromise === promise;
}

export function createOwnedTranscriptHydrationIdlePatch(state, promise) {
  // Status and promise describe one request. An older request may settle after
  // a re-arm or thread switch has installed a newer promise; only the promise
  // currently stored on state owns the right to release "loading".
  if (
    !ownsTranscriptHydrationRequest(state, promise)
    || state.transcriptHydrationStatus !== "loading"
  ) {
    return null;
  }

  return createTranscriptHydrationStatusPatch("idle");
}

export function createClearedTranscriptHydrationFetchedRevisionPatch() {
  return {
    transcriptHydrationFetchedRevision: null,
  };
}

export function createClearedTranscriptHydrationPromisePatch(state, promise) {
  // Release the request by IDENTITY, not by signature. A new entry joining the
  // tail mid-fetch re-keys the signature (createMergedSnapshotTailPatch), while a
  // re-arm or thread switch can replace the promise entirely. Identity is the
  // ownership boundary: clear iff `state` still holds the promise this fetch set;
  // if a newer fetch overwrote it, that fetch owns BOTH promise and status cleanup.
  if (!ownsTranscriptHydrationRequest(state, promise)) {
    return null;
  }

  return {
    transcriptHydrationPromise: null,
    // Every early-return path reaches finally. If no merge/error path selected a
    // settled status, release loading here so a failed repair can be retried. Do
    // not downgrade an already-idle or complete result.
    ...(state.transcriptHydrationStatus === "loading"
      ? { transcriptHydrationStatus: "idle" }
      : {}),
  };
}

// Body freshness is independent of fetch scheduling and history completeness.
// Restore the adopted cursor only after fresh pages have connected to it.
export function createTranscriptHydrationRevisionPatch(bodyRevision, completedBridge = null) {
  return {
    transcriptHydrationBodyRevision: bodyRevision ?? null,
    transcriptTailSawShells: false,
    transcriptHydrationNeedsTailRepair: false,
    transcriptHydrationBridgeTarget: null,
    ...(completedBridge ? {
      transcriptHydrationOlderCursor: completedBridge.olderCursor,
      transcriptHydrationStatus: completedBridge.olderCursor == null ? "complete" : "idle",
    } : {}),
  };
}

/**
 * @param {number|null} [fetchedRevision] gates the once-per-revision re-arm, so
 *   a settle at the same revision does not start an identical fetch an RTT
 *   later. Answers "did we already fetch at this revision", NOT "which revision
 *   are the bodies from" — see createTranscriptHydrationRevisionPatch.
 */
export function createTranscriptHydrationCompletePatch(fetchedRevision = undefined) {
  return {
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
    ...(fetchedRevision === undefined
      ? {}
      : { transcriptHydrationFetchedRevision: fetchedRevision }),
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
  if (!prepend) {
    return createMergedTailPagePatch(state, page, prepareEntry);
  }

  let workingState = state;
  let accumulatedPatch = null;
  // A page load (older-history prepend) legitimately materializes the full
  // window. This is user-paced (scroll-up), not a per-streaming-snapshot
  // cost, so the O(n) copy here is acceptable.
  noteFullWindowCopy();
  const nextEntries = new Map(state.transcriptHydrationEntries);
  const nextOrder = [...state.transcriptHydrationOrder];
  const pageItemIds = [];
  const preparedPageRows = [];
  const isStale = staleTranscriptRowGuard(state, page.revision ?? null);
  const mergeFreshRow = (existing, incoming) =>
    (existing !== undefined && isStale(existing, incoming) ? existing : mergeTranscriptEntry(existing, incoming));

  for (const entry of page.entries || []) {
    const itemId = transcriptRowKey(entry);
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

    preparedPageRows.push(toTranscriptEntry(prepared.entry || entry));
    pageItemIds.push(itemId);
  }

  // Numbered on both sides: place every page row against the window's own
  // numbers. The legacy concat below outranks every held row by position alone,
  // which is only right when the page is strictly older than everything held.
  let nextOrderValue;
  let nextKeyed = false;
  if (
    rowsAreOrderKeyed(preparedPageRows)
    && windowIsOrderKeyed(state.transcriptHydrationOrder, state.transcriptHydrationEntries)
  ) {
    const draft = { order: nextOrder, entries: nextEntries };
    mergeWindowRowsInPlace(draft, preparedPageRows, { mergeRow: mergeFreshRow });
    nextOrderValue = draft.order;
    nextKeyed = true;
  } else {
    for (const pageRow of preparedPageRows) {
      nextEntries.set(
        transcriptRowKey(pageRow),
        mergeFreshRow(nextEntries.get(transcriptRowKey(pageRow)), pageRow)
      );
    }
    nextOrderValue = uniqueItemIds([...pageItemIds, ...nextOrder]);
  }
  const freshRows = preparedPageRows.filter((row) => !isStaleHeldRow(state, row, page.revision));
  resolveRowsCarriedBy(state, freshRows, page.revision ?? null);
  noteTranscriptRowsSeen(state, freshRows, page.revision ?? null);
  const nextStatus =
    page.prev_cursor == null
      ? "complete"
      : state.transcriptHydrationTailReady
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
    // A page merge is user-paced and already walks the window, so it is the one
    // cheap place to (re-)establish the proof the per-frame paths depend on.
    transcriptHydrationKeyed: nextKeyed,
  };
}

// The non-prepend (tail-refresh) path delegates its order and never-shorten
// merge policy to the shared primitive (authoritative-tail-merge.js) — the
// same one Remote's session-ops.js uses for its own tail repair. This keeps
// only what is genuinely store state: the `prepareEntry` hook (entry
// normalization + any surface-specific cache patch) and the
// status/tailReady/lastFetchAt fields.
function createMergedTailPagePatch(state, page, prepareEntry) {
  let workingState = state;
  let accumulatedPatch = null;
  // A page load (cold hydration / a client-detected gap repair) legitimately
  // materializes the full window. This is user-paced, not a
  // per-streaming-snapshot cost, so the O(n) copy here is acceptable.
  noteFullWindowCopy();

  const preparedPageEntries = [];
  for (const entry of page.entries || []) {
    const itemId = transcriptRowKey(entry);
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
    preparedPageEntries.push(toTranscriptEntry(prepared.entry || entry));
  }

  // Ordering — keyed by order_seq when both sides allow it, legacy splice
  // otherwise — belongs to the shared primitive, which Remote's tail repair
  // uses too. This layer keeps only what is genuinely store state.
  const result = reconcileAuthoritativeTail({
    order: state.transcriptHydrationOrder,
    entries: state.transcriptHydrationEntries,
    pageEntries: preparedPageEntries,
    // This layer does not own the session revision (that lives on the
    // rendered session, not the hydration window) — no revision inputs are
    // supplied, and `result.revision` below is deliberately ignored; that is
    // not a dropped result.
    prevCursor: page.prev_cursor,
    mergeEntry: mergeTranscriptEntry,
    isStale: staleTranscriptRowGuard(state, page.revision ?? null),
  });
  const nextEntries = result.entries;
  const nextOrder = result.order;
  const freshRows = preparedPageEntries.filter((row) => !isStaleHeldRow(state, row, page.revision));
  resolveRowsCarriedBy(state, freshRows, page.revision ?? null);
  noteTranscriptRowsSeen(state, freshRows, page.revision ?? null);

  const nextStatus = page.prev_cursor == null ? "complete" : "idle";

  return {
    ...(accumulatedPatch || {}),
    transcriptHydrationEntries: nextEntries,
    transcriptHydrationLastFetchAt: Date.now(),
    transcriptHydrationOrder: nextOrder,
    // Always the page's own cursor, on both paths — reconcileAuthoritativeTail
    // returns exactly this and the keyed branch must not diverge from it.
    transcriptHydrationOlderCursor: page.prev_cursor ?? null,
    transcriptHydrationStatus: nextStatus,
    transcriptHydrationTailReady: nextOrder.length > 0,
    transcriptHydrationKeyed: result.keyed === true,
  };
}

// Merge an ORDERED run of ids — a snapshot tail, which arrives in the server's
// true conversation order — into the window's order array, placing ids that are
// not ordered yet where the run says they go rather than at the end.
//
// This is what keeps a late-settling user message above the reply it triggered.
// The delta stream and the snapshot stream are independent, so an agent_text
// delta can append the reply BEFORE any snapshot carries the user_text that
// caused it; appending the user message at the tail renders the turn upside-down.
//
// `unorderedIds` is "ids we did not already hold an entry for" — an id we have
// never seen cannot be in the order, so the common case (a genuinely-new tail
// entry) skips the lookup entirely. Located ids are found with `lastIndexOf`, a
// BACKWARD scan, so a tail id costs its distance from the end of the window
// rather than a full traversal: the per-snapshot path must not become O(window)
// (see markdown/transcript-perf-freeze-analysis.md).
//
// With `copyOnWrite`, `order` is never mutated — a copy is taken lazily, and only
// if something actually has to be inserted. Returns the array to use.
/**
 * Place new ids into a window's order, by NUMBER when the window is proven keyed
 * and every incoming row carries one, and positionally (placeOrderedTailIds)
 * otherwise. `rowFor` resolves an id to the row the number lives on.
 *
 * Cost is the same shape as the positional path it replaces: ids already in the
 * order are skipped entirely, and a new row costs its distance from the tail —
 * so the steady-state snapshot (nothing new) touches nothing, and a new tail row
 * is O(1). Neither branch scans or copies the whole window; `copyOnWrite` keeps
 * the untouched case returning `order` itself.
 */
function newTailIdsAreNumbered(tailIds, unorderedIds, rowFor) {
  // Only the ids being PLACED need a number; ids already in the order are not
  // moved, so their rows are irrelevant here. Bounded by the tail, not the window.
  for (const itemId of tailIds) {
    if (unorderedIds.has(itemId) && !rowHasOrderKey(rowFor(itemId))) {
      return false;
    }
  }
  return true;
}

function placeTailIds(order, tailIds, unorderedIds, rowFor, options = {}) {
  if (options.keyed !== true) {
    return placeOrderedTailIds(order, tailIds, unorderedIds, options);
  }
  // Neighbours resolve through the SAME resolver as the row being placed, and
  // there is deliberately no second lookup to pass. Every caller merges its rows
  // somewhere the window map does not see yet (an overlay, the session array),
  // so a separate `entries` argument only ever meant "the id placed one
  // iteration ago reads back as unnumbered, and the next row walks over it".
  const neighbours = { get: rowFor };
  const { copyOnWrite = false } = options;
  let working = order;
  for (const itemId of tailIds) {
    if (!unorderedIds.has(itemId)) {
      continue;
    }
    const at = keyedInsertionIndex(working, neighbours, rowFor(itemId));
    if (copyOnWrite && working === order) {
      working = [...order];
    }
    if (at >= working.length) {
      working.push(itemId);
    } else {
      working.splice(at, 0, itemId);
    }
  }
  return working;
}

function placeOrderedTailIds(order, tailIds, unorderedIds, { copyOnWrite = false } = {}) {
  let working = order;
  // Index in `working` of the last tail id we located or placed.
  let anchorIndex = -1;

  for (let index = 0; index < tailIds.length; index += 1) {
    const itemId = tailIds[index];
    const at = unorderedIds.has(itemId) ? -1 : working.lastIndexOf(itemId);
    if (at >= 0) {
      anchorIndex = at;
      continue;
    }

    if (copyOnWrite && working === order) {
      working = [...order];
    }
    let insertAt = anchorIndex >= 0
      ? anchorIndex + 1
      // No id before this one in the tail is in the window — the compacted tail
      // (8 local / 6 remote entries, protocol.rs) can open on a brand-new entry.
      // Anchor on the RIGHT instead: land just before the first later tail id we
      // can locate.
      //
      // With NO anchor on either side, append. That is deliberately the opposite
      // default from `mergeTailPageOrder`, and the asymmetry is load-bearing:
      //   * A tail PAGE is fetched for the tail the window already holds, so an
      //     empty intersection means the leftover cannot be older history — it is
      //     a live delta, and belongs BELOW the page.
      //   * A snapshot TAIL is just the last N entries. An empty intersection is
      //     the ordinary "a burst of new entries pushed the whole window out of
      //     the tail" case, where the window really is older and the tail really
      //     does belong at the end.
      : locateLaterTailId(working, tailIds, index + 1, unorderedIds);
    if (insertAt < 0 || insertAt >= working.length) {
      working.push(itemId);
      insertAt = working.length - 1;
    } else {
      working.splice(insertAt, 0, itemId);
    }
    anchorIndex = insertAt;
  }

  return working;
}

// Order position of the first tail id at or after `from` that the window already
// holds, or -1. Runs at most once per merge: the insert it feeds sets an anchor,
// so every later unordered id chains off that instead.
function locateLaterTailId(order, tailIds, from, unorderedIds) {
  for (let index = from; index < tailIds.length; index += 1) {
    const itemId = tailIds[index];
    if (unorderedIds.has(itemId)) {
      continue;
    }
    const at = order.lastIndexOf(itemId);
    if (at >= 0) {
      return at;
    }
  }
  return -1;
}

/// Renders progress while a hydration fetch is in flight (onProgress). Uses
/// renderedTranscriptFromWindow — not buildHydratedTranscriptSnapshot's own
/// bespoke projection below — for the SAME array-fallback treatment settle
/// gets: an entry a patch invalidated (or one the window has never tracked
/// at all) must not republish the window's stale/absent copy over what the
/// live session already shows for it. See invalidateTranscriptWindowEntryForPatch.
export function buildHydratedTranscriptProgress(state) {
  const snapshot = state.transcriptHydrationBaseSnapshot;
  if (!snapshot || state.session?.active_thread_id !== snapshot.active_thread_id) {
    return null;
  }

  if (!state.transcriptHydrationOrder?.length) {
    // Nothing has merged into the window yet (the fetch this progress call
    // precedes hasn't landed). Trust the snapshot's own transcript_truncated
    // rather than computeSnapshotTranscriptTruncated: that reads per-entry
    // content_state, which a caller may not set explicitly on its OWN
    // truncated preview (relying on the snapshot-level flag instead) — an
    // empty window would then read as "not truncated" before hydration ever
    // ran, the same trap buildHydratedTranscriptSnapshot's own early return
    // (below) avoids for exactly this reason.
    return { ...state.session, transcript: snapshot.transcript, transcript_truncated: snapshot.transcript_truncated };
  }

  return {
    ...state.session,
    transcript: renderedTranscriptFromWindow(state, state.session),
    transcript_truncated: computeSnapshotTranscriptTruncated(state, snapshot),
  };
}

// Shared by buildHydratedTranscriptSnapshot and buildHydratedTranscriptProgress
// — both project the same window, and neither should compute this
// independently and risk drifting.
function computeSnapshotTranscriptTruncated(state, snapshot) {
  return (
    state.transcriptHydrationOlderCursor != null
    || unresolvedRowsOf(state).size > 0
    || snapshotTailOwesRows(state, snapshot)
  );
}

// The render can run before this snapshot's tail is merged; judge its rows the
// same way the merge will, without recording anything.
function snapshotTailOwesRows(state, snapshot) {
  const entries = state.transcriptHydrationEntries;
  const bodyRevisions = rowBodyRevisionsOf(state);
  for (const entry of snapshot?.transcript || []) {
    const existing = entries?.get?.(transcriptRowKey(entry));
    if (rowNeedsRecovery(existing, prepareSnapshotOverlayEntry(existing, entry), snapshot, bodyRevisions)) {
      return true;
    }
  }
  return false;
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
  const tailIds = [];
  const unorderedIds = new Set();

  for (const entry of overlayEntries || []) {
    const itemId = transcriptRowKey(entry);
    if (!itemId) {
      continue;
    }
    const existing = baseEntries.get(itemId);
    (overlay ||= new Map()).set(
      itemId,
      mergeSnapshotTailRow(state, baseEntries, itemId, entry, snapshot)
    );
    if (existing === undefined) {
      unorderedIds.add(itemId);
    }
    tailIds.push(itemId);
  }

  // Copy-on-write: the steady-state snapshot (every tail id already ordered)
  // returns `baseOrder` untouched, so no per-snapshot full-window copy.
  //
  // Same numbered placement as the window merge below — this is the projection
  // half of the same snapshot and would otherwise report a different order than
  // the window it writes into.
  const overlayRowFor = (itemId) =>
    (overlay && overlay.has(itemId) ? overlay.get(itemId) : baseEntries.get(itemId));
  const placeKeyed = state.transcriptHydrationKeyed === true
    && newTailIdsAreNumbered(tailIds, unorderedIds, overlayRowFor);
  // Neighbours must be resolved through the overlay too. `baseEntries` does not
  // receive this snapshot's rows until the write-back below, so looking a
  // neighbour up there returns undefined for a row placed moments earlier in
  // this same loop — which reads as "unnumbered", gets walked over, and lets the
  // SECOND row of a pair land above the first. That is how an answered ask-user
  // card ended up below the message the relay published alongside it.
  const order = placeTailIds(baseOrder, tailIds, unorderedIds, overlayRowFor, {
    copyOnWrite: true,
    keyed: placeKeyed,
  });
  const transcript = order
    .map((itemId) => (overlay && overlay.has(itemId) ? overlay.get(itemId) : baseEntries.get(itemId)))
    .filter(Boolean);

  if (!transcript.length) {
    return snapshot;
  }

  const result = {
    ...snapshot,
    transcript,
    transcript_truncated: computeSnapshotTranscriptTruncated(state, snapshot),
  };

  // Also write the merge into the canonical window (not just `result`), or a
  // delta landing on one of these items before the next flush reads the
  // pre-merge cache and settle later clobbers this snapshot's text with it —
  // see .sealwire/PLAN.md / lifecycle.js's applySessionSnapshot review.
  //
  // Reuses the SAME merge already computed above for `transcript`, so this
  // can neither spin up a window from an unloaded one (`overlay` is only
  // non-empty when the caller already found one loaded) nor force
  // content_state to "full" (mergeTranscriptEntry's rank-based merge is what
  // lands here) — the two ways a prior attempt at this regressed.
  if (overlay) {
    for (const [itemId, mergedEntry] of overlay) {
      baseEntries.set(itemId, mergedEntry);
    }
    if (order !== baseOrder) {
      state.transcriptHydrationOrder = order;
      // This write is the window's order now, so the proof has to track the
      // placement that produced it or the next frame trusts a stale answer.
      state.transcriptHydrationKeyed = placeKeyed;
    }
  }

  return result;
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
    text: entry.text ?? null,
    status: entry.status,
    turn_id: entry.turn_id || null,
    tool: entry.tool || null,
    content_state: contentStateOf(entry),
    // An explicit field list DROPS what it does not name. These three carry the
    // identity, ordering and withdrawal contracts — losing them here silently
    // un-keys, un-numbers and resurrects rows arriving via pages.
    //
    // `row_id` is the relay's own name for the row and the only one a client may
    // key on. A relay too old to send it leaves this absent, and `transcriptRowKey`
    // falls back to `item_id` — which is what makes that relay still work.
    ...(typeof entry.row_id === "string" && entry.row_id ? { row_id: entry.row_id } : {}),
    ...(Number.isSafeInteger(entry.order_seq) ? { order_seq: entry.order_seq } : {}),
    ...(entry.withdrawn === true ? { withdrawn: true } : {}),
    // Which injected prompt this row is; without it the row renders as a user bubble.
    ...(entry.injection ? { injection: entry.injection } : {}),
  };
}

export { resolveDeltaAppend };

/// Mark every entry in the loaded window as a preview, so the re-hydration gate treats
/// our copies as non-authoritative and refetches them.
///
/// Used after the delta stream reports dropped frames: any cached body may now be
/// missing an interior chunk, and length-based merge rules cannot detect that.
export function markTranscriptWindowNeedsRepair(state) {
  const entries = state.transcriptHydrationEntries;
  if (!(entries instanceof Map) || entries.size === 0) {
    return false;
  }
  for (const [itemId, entry] of entries) {
    if (contentStateOf(entry) === CONTENT_STATE_FULL) {
      entries.set(itemId, { ...entry, content_state: CONTENT_STATE_PREVIEW });
    }
  }
  // Frames were dropped, so rows may be missing too: read the tail page again.
  state.transcriptHydrationNeedsTailRepair = true;
  return true;
}

/// Apply a live transcript delta to the loaded window, IN PLACE.
///
/// This has to write here, not into the rendered session object: the rendered
/// transcript is rebuilt from this window on every snapshot
/// (`buildHydratedTranscriptSnapshot`), so a delta applied anywhere else is erased by
/// the next snapshot. That is not a cosmetic race — the relay compacts the local
/// snapshot's entries to a bounded preview, so the erased text would visibly snap back
/// to the cap until a hydration fetch landed.
///
/// The grown body is marked `full` so `selectTranscriptText` keeps it over the
/// compacted `preview` the next snapshot carries.
///
/// Returns true when the window changed.
export function applyTranscriptDeltaToWindow(state, delta) {
  const itemId = transcriptRowKey(delta);
  if (!itemId) {
    return false;
  }
  // The window holds exactly one thread. A delta for any other thread would splice a
  // second conversation into the one on screen.
  const threadId = state.transcriptHydrationThreadId;
  if (!threadId || (delta.thread_id && delta.thread_id !== threadId)) {
    return false;
  }
  const entries = state.transcriptHydrationEntries;
  const order = state.transcriptHydrationOrder;
  if (!(entries instanceof Map) || !Array.isArray(order)) {
    return false;
  }

  const deltaText = delta.delta ?? "";
  const kind = normalizeTranscriptDeltaKind(delta.delta_kind);
  const existing = entries.get(itemId);
  if (existing) {
    const haveText = existing.text ?? "";
    const appendText = resolveDeltaAppend(haveText, deltaText, delta.text_offset);
    // Refused: a gap (earlier text missing) or a divergence (same range, different
    // bytes). Appending either would corrupt the message, and because a delta marks the
    // body `full`, an authoritative page could never take it back — selectTranscriptText
    // keeps the longer text. Leave it alone so hydration can repair it.
    if (appendText == null) {
      // Downgrade to `preview` so the existing re-hydration gate treats our copy as
      // non-authoritative and refetches. Leaving it `full` is what let a single dropped
      // frame freeze the entry forever: the merge would keep our longer-but-stale body,
      // clear transcript_truncated, and hydration would never run again.
      entries.set(itemId, { ...existing, content_state: CONTENT_STATE_PREVIEW });
      return false;
    }
    if (appendText === "") {
      // Pure re-delivery of text we already hold. Idempotent no-op.
      return false;
    }
    entries.set(itemId, {
      ...existing,
      kind: existing.kind || kind,
      status: "running",
      text: `${haveText}${appendText}`,
      turn_id: existing.turn_id || delta.turn_id || null,
      // First valid entry_seq wins and is never overwritten by a later one —
      // mirrors the array-fallback merge (session/stream.js, session-ops.js).
      entry_seq: Number.isSafeInteger(delta.entry_seq) && !Number.isSafeInteger(existing.entry_seq)
        ? delta.entry_seq
        : existing.entry_seq,
      // Same first-wins rule, and it heals a row some other path created without
      // one: recording the number keeps the window eligible for the keyed merge.
      // Position is NOT revisited — a row's slot is decided when it is placed.
      ...(Number.isSafeInteger(delta.order_seq) && !Number.isSafeInteger(existing.order_seq)
        ? { order_seq: delta.order_seq }
        : {}),
      content_state: CONTENT_STATE_FULL,
    });
    return true;
  }
  const appendText = deltaText;

  // A first delta for an unknown item must start at offset 0. A non-zero offset means
  // the entry's opening text went missing, so storing this tail as a `full` body would
  // present a truncated message as complete. Record the identity as a preview instead so
  // hydration fetches the real body.
  const startsAtZero =
    delta.text_offset == null
    || (Number.isSafeInteger(delta.text_offset) && delta.text_offset === 0);
  // Placed by its birth number, not by arrival: two rows can stream at once, and
  // the earlier-born one may emit its first delta second. An unnumbered delta
  // still appends, so an old relay degrades to arrival order instead of breaking.
  //
  // Still O(1) for the ordinary case this path exists for — a genuinely-new tail
  // row stops at the first neighbour it is compared against, so the per-token
  // delta path does not become O(window) (markdown/transcript-perf-freeze-analysis.md).
  // An unnumbered row breaks the proof: the window still has an order, but it is
  // no longer derivable from the numbers, so the per-frame paths must go back to
  // positional placement until a page merge re-establishes it. A NUMBERED row
  // preserves it — the reducer inserts at the sorted slot, so a sorted window
  // stays sorted. (A keyed window never back-fills a number onto a held row
  // either: every row already has one, so that branch cannot fire.)
  if (!Number.isSafeInteger(delta.order_seq)) {
    state.transcriptHydrationKeyed = false;
  }
  upsertWindowRowInPlace(
    { entries, order },
    {
      // The relay's key for this row, when it sent one. A row born here without
      // it keys on `item_id`, and the page copy that follows keys on `row_id` —
      // the same message, twice, in one window.
      ...(typeof delta.row_id === "string" && delta.row_id ? { row_id: delta.row_id } : {}),
      item_id: itemId,
      kind,
      text: startsAtZero ? appendText : "",
      status: "running",
      turn_id: delta.turn_id || null,
      tool: null,
      entry_seq: Number.isSafeInteger(delta.entry_seq) ? delta.entry_seq : null,
      ...(Number.isSafeInteger(delta.order_seq) ? { order_seq: delta.order_seq } : {}),
      content_state: startsAtZero ? CONTENT_STATE_FULL : CONTENT_STATE_PREVIEW,
    }
  );
  return startsAtZero;
}

/// A non-delta entry patch (started/completed/patched: status, tool, or a
/// text REPLACEMENT) can never safely land IN the window, in any form: a
/// patch carries no `text_offset`, so writing its body there would silently
/// break a LATER delta's offset math against it — see .sealwire/PLAN.md,
/// "Invalidate; do not write". This replaced a `transcriptPatchOverlay` side
/// store (a second write target the window's own cached entry was merged
/// with at projection time), banned after it repeatedly reintroduced the
/// exact P1s this rule exists to prevent: a text replacement silently
/// discarded by the next delta for the same item (the delta reconciled
/// against the window's untouched pre-patch body, then cleared the overlay
/// as "stale now"), and a completed status republished as running by
/// hydration progress rendering, which never applied the overlay at all.
///
/// Instead: downgrade the cached entry's content_state so hydration's
/// re-fetch gate runs again, AND so it is no longer trusted as authoritative
/// at projection time (renderedTranscriptFromWindow, below) — which is what
/// lets that function fall back to whatever the caller's own transcript
/// array already shows for this item instead. The caller (session-ops.js /
/// stream.js) always writes a patch's fields into its array directly and
/// synchronously, patch or no patch, so that fallback is never empty-handed.
///
/// Also clears the cached TEXT (not just content_state): a patch may have
/// replaced the array's body with something the delta stream's own
/// text_offset accounting knows nothing about, so the cached text can no
/// longer be trusted as "how much of this item has actually streamed so
/// far" either. A blank cache makes the next delta's own gap check
/// (resolveDeltaAppend) do the enforcement: a non-zero offset against "" is
/// a gap and is correctly refused instead of silently appended onto stale
/// pre-patch text (the overlay this replaces got exactly this case wrong —
/// its delta path reconciled against the untouched pre-patch body); a zero
/// offset is a genuine fresh restart of the stream and correctly starts
/// clean.
///
/// A no-op unless the window is already loaded for `threadId` and already
/// tracks this item — an unhydrated window must never be created by a patch
/// alone, and there is nothing to invalidate for an item the window has
/// never seen: that is exactly the case renderedTranscriptFromWindow's own
/// array-fallback for a window-missing item covers, without any write here.
///
/// Blanks the cached text regardless of the entry's CURRENT content_state —
/// including preview/omitted, not just full. Gating this on "already full"
/// (a prior version of this function did) leaves a preview entry's stale,
/// truncated text sitting in the window; that text is still what
/// applyTranscriptDeltaToWindow's merge branch reads as `have` for the next
/// delta, so a later delta whose offset happens to match the stale length is
/// accepted as a contiguous append and the merge promotes the result to
/// `full` — silently making the truncated preview authoritative and
/// permanently suppressing the real hydration fetch. A no-op is only correct
/// once the cache is ALREADY blank (nothing left to protect).
export function invalidateTranscriptWindowEntryForPatch(state, threadId, patchedEntry) {
  const itemId = transcriptRowKey(patchedEntry);
  if (!itemId || !transcriptWindowIsLoaded(state, threadId)) {
    return false;
  }
  const entries = state.transcriptHydrationEntries;
  const existing = entries.get(itemId);
  if (!existing || (!existing.text && contentStateOf(existing) !== CONTENT_STATE_FULL)) {
    return false;
  }
  entries.set(itemId, { ...existing, text: "", content_state: CONTENT_STATE_PREVIEW });
  return true;
}

/// Is the hydration window loaded for this thread? Shared by local and
/// remote — both track the SAME window shape (transcriptHydrationEntries /
/// Order / ThreadId) on their own `state` object, and both must agree on
/// this check: writing a delta or patch into a window loaded for the WRONG
/// thread would splice one conversation into another.
/**
 * Whether the window may be written to or projected for this thread.
 *
 * Ownership, not just presence. `prepareTranscriptHydrationState` rebuilds the window
 * when the generation changes, but the snapshot that carries the new generation lands
 * on `state.session` BEFORE that runs (local renders coalesce frames). In that gap the
 * window still holds the previous run's ids, and every caller of this — the delta
 * writer and the render projection — would happily use it: a new-run delta appends a
 * second row for a message the window already has under its old name.
 */
export function transcriptWindowIsLoaded(state, threadId) {
  return Boolean(
    threadId
    && state.transcriptHydrationThreadId === threadId
    && (state.transcriptHydrationGeneration || "")
      === (state.session?.transcript_generation || "")
    && state.transcriptHydrationEntries instanceof Map
    && Array.isArray(state.transcriptHydrationOrder)
    && state.transcriptHydrationOrder.length
  );
}

/// Project the hydration window onto a rendered transcript array. Falls back
/// to the session's own transcript when the window is not loaded for this
/// thread (a delta can arrive before the first hydration), so the live tail
/// still shows rather than blanking.
///
/// Two narrower fallbacks to the SAME array, per window entry:
///   - untrusted (content_state != full — never fully hydrated yet, or a
///     patch invalidated it via invalidateTranscriptWindowEntryForPatch):
///     the array's current entry is preferred, since a patch always writes
///     its caller's array directly and synchronously.
///   - absent (the window has never tracked this item at all — a patch
///     introduced it with no delta/hydration page ever seeding the window):
///     same fallback, folded into the projected order via a tail-merge
///     rather than dropped.
/// Both exist so a non-delta patch can never safely write the window (see
/// invalidateTranscriptWindowEntryForPatch's own doc) without silently
/// losing or stalling that patch's content the next time this runs.
export function renderedTranscriptFromWindow(state, session) {
  const entries = state.transcriptHydrationEntries;
  const windowOrder = state.transcriptHydrationOrder;
  if (
    state.transcriptHydrationThreadId !== session?.active_thread_id
    || !(entries instanceof Map)
    || !Array.isArray(windowOrder)
    || !windowOrder.length
  ) {
    return session?.transcript || [];
  }

  // One O(n) pass over the CURRENT array, not a per-window-entry .find() —
  // that would turn every settle into O(n^2) in a long transcript. The
  // counter increments PER ENTRY VISITED here (not once per call), so a
  // regression back to a per-window-entry .find() against the array — which
  // would visit far fewer or far more entries depending on match position,
  // never staying at (calls * array length) — changes the counter's value,
  // not just whether this comment is still true.
  const arrayEntries = Array.isArray(session?.transcript) ? session.transcript : [];
  const arrayByItemId = new Map();
  const arrayOnlyIds = [];
  for (const entry of arrayEntries) {
    transcriptArrayFallbackLookupBuildCount += 1;
    const itemId = transcriptRowKey(entry);
    if (!itemId) {
      continue;
    }
    arrayByItemId.set(itemId, entry);
    if (!entries.has(itemId)) {
      arrayOnlyIds.push(itemId);
    }
  }

  // Union the window's own order with any array-only ids — same tail-merge
  // shape a snapshot's tail uses to join the window (placeOrderedTailIds),
  // so a patch-introduced item lands in a sensible position instead of
  // always at the very end. copyOnWrite: the common case (no array-only
  // ids) returns `windowOrder` itself, untouched.
  // An entry patch for an item the window has never tracked stays array-only by
  // design (transcript-event-reducer.js, "invalidate; do not write"), so this is
  // where such a row gets its position — and it must come from the number when
  // there is one, exactly like every other placement.
  let order = windowOrder;
  if (arrayOnlyIds.length) {
    const arrayOnly = new Set(arrayOnlyIds);
    // Resolves BOTH sides: the array rows being placed, and the window rows they
    // are placed against. Either alone leaves half the neighbours invisible.
    const rowFor = (itemId) => arrayByItemId.get(itemId) || entries.get(itemId);
    order = placeTailIds(windowOrder, arrayOnlyIds, arrayOnly, rowFor, {
      copyOnWrite: true,
      keyed: state.transcriptHydrationKeyed === true
        && newTailIdsAreNumbered(arrayOnlyIds, arrayOnly, rowFor),
    });
  }

  return order
    .map((itemId) => {
      const windowEntry = entries.get(itemId);
      if (windowEntry && contentStateOf(windowEntry) === CONTENT_STATE_FULL) {
        return windowEntry;
      }
      // Untrusted or absent — prefer the array's current entry; the
      // untrusted/absent window entry is the last resort (nothing to show
      // for a genuinely new item neither side has ever seen).
      return arrayByItemId.get(itemId) || windowEntry || null;
    })
    .filter(Boolean);
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

  // Collect the tail (and which ids are new to us) BEFORE placing anything: the
  // merge below writes into `entries`, so "did we already hold this?" has to be
  // answered while that is still true.
  const tailIds = [];
  const unorderedIds = new Set();
  for (const entry of snapshot.transcript || []) {
    const itemId = transcriptRowKey(entry);
    if (!itemId) {
      continue;
    }
    if (!entries.has(itemId)) {
      unorderedIds.add(itemId);
    }
    entries.set(itemId, mergeSnapshotTailRow(state, entries, itemId, entry, snapshot));
    tailIds.push(itemId);
  }
  // In place: an id that is not ordered yet — genuinely new, or orphaned out of
  // the order by an older build — goes where its NUMBER says, or where this
  // snapshot's own run of ids says when the numbers are not all there.
  const rowFor = (itemId) => entries.get(itemId);
  const keyed = state.transcriptHydrationKeyed === true
    && newTailIdsAreNumbered(tailIds, unorderedIds, rowFor);
  const placed = placeTailIds(order, tailIds, unorderedIds, rowFor, { keyed });

  return {
    transcriptHydrationBaseSnapshot: snapshot,
    transcriptHydrationEntries: entries,
    transcriptHydrationOrder: placed,
    transcriptHydrationSignature: signature,
    transcriptHydrationThreadId: snapshot.active_thread_id,
    // Numbered placement into a proven window leaves it proven; a positional
    // placement — taken whenever any new id arrived unnumbered — does not.
    transcriptHydrationKeyed: keyed,
    transcriptUnresolvedRows: unresolvedRowsOf(state),
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

  const text = selectTranscriptText(existing.text, incoming.text, existingFull, incomingFull);
  // A push cuts a card's bodies shorter than a page, or empties them with the row.
  let injection = incoming.injection
    ? combineCardBodies(incoming.injection, existing.injection)
    : null;
  // Whether the text is short belongs to the copy the text was kept from.
  if (injection && text === existing.text && text !== incoming.text) {
    injection = { ...injection, text_clipped: Boolean(existing.injection?.text_clipped) };
  }

  return {
    ...existing,
    ...incoming,
    text,
    tool: mergeToolView(existing.tool, incoming.tool, existingFull, incomingFull),
    ...(injection ? { injection } : {}),
    turn_id: incoming.turn_id || existing.turn_id || null,
    content_state: mergedContentState,
    // Absorbing: a copy serialized before the withdrawal must not resurrect the row.
    ...(existing.withdrawn === true || incoming.withdrawn === true ? { withdrawn: true } : {}),
    // First order key wins, the same rule the shared reducer enforces. Without
    // it a copy numbered by another runtime rewrites the number of a row that
    // keeps its position — leaving a window whose cached proof still says
    // "sorted" while the numbers no longer agree with the order.
    ...(Number.isSafeInteger(existing.order_seq) ? { order_seq: existing.order_seq } : {}),
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
