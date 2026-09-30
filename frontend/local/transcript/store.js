import {
  buildHydratedTranscriptProgress,
  createClearedTranscriptHydrationPatch,
  createClearedTranscriptHydrationFetchedRevisionPatch,
  createClearedTranscriptHydrationPromisePatch,
  createMergedTranscriptHydrationPagePatch,
  createRecoveredTranscriptRowsPatch,
  prepareTranscriptHydrationState,
  createTranscriptHydrationCompletePatch,
  createOwnedTranscriptHydrationIdlePatch,
  createTranscriptHydrationRevisionPatch,
  createTranscriptHydrationPromisePatch,
  createTranscriptHydrationStatusPatch,
  restoreHydratedTranscriptSnapshot,
  restoreTranscriptHydrationForThread,
  stashTranscriptHydrationForThread,
  clearTranscriptHydrationThreadCache,
  applyTranscriptDeltaToWindow,
  invalidateTranscriptWindowEntryForPatch,
  markTranscriptWindowNeedsRepair,
  renderedTranscriptFromWindow,
  resolveDeltaAppend,
  transcriptWindowIsLoaded,
} from "../../shared/transcript-hydration-store.js";
import {
  adoptSettledTranscript,
  markTranscriptWindowProjectionPending,
  settleTranscriptProjection as settlePendingTranscriptProjection,
} from "../../shared/transcript-projection.js";

function applyLocalTranscriptPatch(state, patch) {
  if (!patch) {
    return;
  }

  Object.assign(state, patch);
}

export function clearTranscriptHydration(state) {
  // Genuine reset (auth loss / session unavailable), not a thread switch — drop
  // the retained per-thread windows too.
  clearTranscriptHydrationThreadCache(state);
  applyLocalTranscriptPatch(state, createClearedTranscriptHydrationPatch());
}

// Thread switch: stash the leaving thread's loaded window and restore the target
// thread's retained window (or a cleared slot when it has none), so switching
// away and back keeps the older history the user scrolled into view instead of
// reloading only the tail.
export function switchTranscriptHydrationThread(state, nextThreadId) {
  stashTranscriptHydrationForThread(state);
  applyLocalTranscriptPatch(state, restoreTranscriptHydrationForThread(state, nextThreadId));
}

/// Append a live transcript delta to the loaded window.
///
/// The rendered transcript is rebuilt from this window on every snapshot, so a delta
/// must land here to survive — see applyTranscriptDeltaToWindow.
export function appendTranscriptDelta(state, delta) {
  return applyTranscriptDeltaToWindow(state, delta);
}

/// A non-delta entry patch can never safely write the window — see
/// invalidateTranscriptWindowEntryForPatch. A no-op unless the window is
/// already loaded for `threadId` and already tracks this item as `full`.
export function applyEntryPatchToWindow(state, threadId, patchedEntry) {
  return invalidateTranscriptWindowEntryForPatch(state, threadId, patchedEntry);
}

/// Mark every loaded entry non-authoritative after a delta gap (a lagged stream).
///
/// Needed because a compacted snapshot cannot repair a short local body on its own: the
/// merge deliberately keeps the LONGER text, so a stale-but-longer cache would win over
/// the authoritative preview forever.
export function invalidateTranscriptWindowForRepair(state) {
  return markTranscriptWindowNeedsRepair(state);
}

/// How much of a delta is genuinely new, given text we already hold. Re-exported so the
/// pre-hydration path reconciles identically to the loaded window.
export { resolveDeltaAppend };

/// Is the hydration window loaded for this thread? Shared with remote — see
/// transcript-hydration-store.js.
export { transcriptWindowIsLoaded };

export function restoreHydratedTranscript(state, snapshot) {
  return restoreHydratedTranscriptSnapshot(state, snapshot);
}

export function prepareTranscriptHydration(state, snapshot) {
  const prepared = prepareTranscriptHydrationState(state, snapshot);
  applyLocalTranscriptPatch(state, prepared.patch);
  return prepared;
}

export function beginTranscriptHydration(state, status = "loading") {
  applyLocalTranscriptPatch(state, createTranscriptHydrationStatusPatch(status));
}

export function setTranscriptHydrationPromise(state, promise) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationPromisePatch(promise));
}

export function clearTranscriptHydrationPromise(state, promise) {
  applyLocalTranscriptPatch(state, createClearedTranscriptHydrationPromisePatch(state, promise));
}

export function setTranscriptHydrationIdle(state, promise) {
  applyLocalTranscriptPatch(state, createOwnedTranscriptHydrationIdlePatch(state, promise));
}

export function clearTranscriptHydrationFetchedRevision(state) {
  applyLocalTranscriptPatch(state, createClearedTranscriptHydrationFetchedRevisionPatch());
}

export function recordTranscriptHydrationRevision(state, fetchedRevision) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationRevisionPatch(fetchedRevision));
}

export function markTranscriptHydrationComplete(state, fetchedRevision) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationCompletePatch(fetchedRevision));
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
  applyLocalTranscriptPatch(
    state,
    createMergedTranscriptHydrationPagePatch(state, page, { prepend })
  );
}

export function mergeRecoveredTranscriptRows(state, page, rowIds, options) {
  applyLocalTranscriptPatch(state, createRecoveredTranscriptRowsPatch(state, page, rowIds, options));
}

export { buildHydratedTranscriptProgress };

// -- Deferred window→array projection ----------------------------------------
//
// Appending a delta to the loaded window (appendTranscriptDelta, above) is
// O(1) — a Map write. Projecting it back onto the rendered array
// (order.map(...).filter(Boolean)) is O(n) in the loaded window, so that step
// is deferred: a delta only raises a pending flag, and settleTranscriptProjection
// does the actual rebuild, once, whenever it is next called. So anything that
// reads or rewrites the array must settle first, or it acts on stale text.

// Test/perf instrumentation, mirroring transcriptFullWindowCopyCount's
// one-counter-many-sites shape (transcript-hydration-store.js:115): every
// site that copies the WHOLE transcript array increments this, whether that
// is this module's deferred window projection or session/stream.js's
// synchronous pre-hydration fallback.
let transcriptFullRebuildCount = 0;

export function __readTranscriptFullRebuildCount() {
  return transcriptFullRebuildCount;
}

export function __resetTranscriptFullRebuildCount() {
  transcriptFullRebuildCount = 0;
}

export function __recordTranscriptFullRebuild() {
  transcriptFullRebuildCount += 1;
}

/// Shared with remote — see transcript-projection.js. Local has one session
/// slot, so the default `sessionKeys` (`["session"]`) apply throughout.
export { markTranscriptWindowProjectionPending, adoptSettledTranscript };

/// Settle onto state.session, recording each actual rebuild on THIS module's
/// counter (transcriptFullRebuildCount) via transcript-projection.js's
/// onRebuild callback — see that module for the shared settle algorithm
/// itself. Local has only one session slot, so this can only ever fire 0 or
/// 1 times per call; driven through the callback anyway so both surfaces
/// count the same way.
export function settleTranscriptProjection(state) {
  return settlePendingTranscriptProjection(state, ["session"], __recordTranscriptFullRebuild);
}
