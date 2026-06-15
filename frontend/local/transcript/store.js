import {
  buildHydratedTranscriptProgress,
  createClearedTranscriptHydrationPatch,
  createClearedTranscriptHydrationPromisePatch,
  createMergedTranscriptHydrationPagePatch,
  prepareTranscriptHydrationState,
  createTranscriptHydrationCompletePatch,
  createTranscriptHydrationPromisePatch,
  createTranscriptHydrationStatusPatch,
  restoreHydratedTranscriptSnapshot,
  restoreTranscriptHydrationForThread,
  stashTranscriptHydrationForThread,
  clearTranscriptHydrationThreadCache,
} from "../../shared/transcript-hydration-store.js";

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

export function setTranscriptHydrationIdle(state) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationStatusPatch("idle"));
}

export function markTranscriptHydrationComplete(state) {
  applyLocalTranscriptPatch(state, createTranscriptHydrationCompletePatch());
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

export { buildHydratedTranscriptProgress };
