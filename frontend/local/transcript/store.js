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
} from "../../shared/transcript-hydration-store.js";

function applyLocalTranscriptPatch(state, patch) {
  if (!patch) {
    return;
  }

  Object.assign(state, patch);
}

export function clearTranscriptHydration(state) {
  applyLocalTranscriptPatch(state, createClearedTranscriptHydrationPatch());
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

export function clearTranscriptHydrationPromise(state, signature) {
  applyLocalTranscriptPatch(state, createClearedTranscriptHydrationPromisePatch(state, signature));
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
