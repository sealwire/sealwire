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
import { prepareTranscriptEntryForSurface } from "./details.js";
import { applyRemoteSurfacePatch } from "../surface-state.js";

export function clearTranscriptHydration(state) {
  // Genuine reset (disconnect / unpair / relay reset), not a thread switch —
  // drop the retained per-thread windows too. The per-thread cache lives on the
  // remote `state` object (the same one patchRemoteState mutates).
  if (state) {
    clearTranscriptHydrationThreadCache(state);
  }
  applyRemoteSurfacePatch(createClearedTranscriptHydrationPatch());
}

// Thread switch (remote view-only navigation): stash the leaving thread's loaded
// window and restore the target thread's retained window, so switching between
// threads and back keeps the older history rather than reloading only the tail.
export function switchTranscriptHydrationThread(state, nextThreadId) {
  stashTranscriptHydrationForThread(state);
  applyRemoteSurfacePatch(restoreTranscriptHydrationForThread(state, nextThreadId));
}

export function restoreHydratedTranscript(state, snapshot) {
  return restoreHydratedTranscriptSnapshot(state, snapshot);
}

export function prepareTranscriptHydration(state, snapshot) {
  const prepared = prepareTranscriptHydrationState(state, snapshot);
  if (prepared.patch) {
    applyRemoteSurfacePatch(prepared.patch);
  }
  return prepared;
}

export function beginTranscriptHydration(_state, status = "loading") {
  applyRemoteSurfacePatch(createTranscriptHydrationStatusPatch(status));
}

export function setTranscriptHydrationPromise(_state, promise) {
  applyRemoteSurfacePatch(createTranscriptHydrationPromisePatch(promise));
}

export function clearTranscriptHydrationPromise(state, promise) {
  const patch = createClearedTranscriptHydrationPromisePatch(state, promise);
  if (patch) {
    applyRemoteSurfacePatch(patch);
  }
}

export function setTranscriptHydrationIdle() {
  applyRemoteSurfacePatch(createTranscriptHydrationStatusPatch("idle"));
}

export function markTranscriptHydrationComplete() {
  applyRemoteSurfacePatch(createTranscriptHydrationCompletePatch());
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
  applyRemoteSurfacePatch(
    createMergedTranscriptHydrationPagePatch(state, page, {
      prepend,
      prepareEntry(currentState, threadId, entry) {
        const prepared = prepareTranscriptEntryForSurface(currentState, threadId, entry, {
          applyPatch: false,
        });
        return {
          entry: prepared.entry,
          patch: prepared.cachePatch,
        };
      },
    })
  );
}

export { buildHydratedTranscriptProgress };
