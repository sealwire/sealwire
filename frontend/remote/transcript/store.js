import {
  buildHydratedTranscriptProgress,
  createClearedTranscriptHydrationPatch,
  createClearedTranscriptHydrationFetchedRevisionPatch,
  createClearedTranscriptHydrationPromisePatch,
  createMergedTranscriptHydrationPagePatch,
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
  createRecoveredTranscriptRowsPatch,
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

/// Append a live transcript delta to the loaded window. Mirrors
/// local/transcript/store.js's appendTranscriptDelta — the rendered
/// transcript is rebuilt from this window at settle time, so a delta must
/// land here to survive.
export function appendTranscriptDelta(state, delta) {
  return applyTranscriptDeltaToWindow(state, delta);
}

/// A non-delta entry patch can never safely write the window — see
/// invalidateTranscriptWindowEntryForPatch. A no-op unless the window is
/// already loaded for `threadId` and already tracks this item as `full`.
export function applyEntryPatchToWindow(state, threadId, patchedEntry) {
  return invalidateTranscriptWindowEntryForPatch(state, threadId, patchedEntry);
}

/// Mark every loaded entry non-authoritative after a delta gap, so the
/// re-hydration gate refetches instead of trusting a body that may now be
/// missing an interior chunk.
export function invalidateTranscriptWindowForRepair(state) {
  return markTranscriptWindowNeedsRepair(state);
}

export { renderedTranscriptFromWindow, resolveDeltaAppend, transcriptWindowIsLoaded };

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

export function setTranscriptHydrationIdle(state, promise) {
  const patch = createOwnedTranscriptHydrationIdlePatch(state, promise);
  if (patch) {
    applyRemoteSurfacePatch(patch);
  }
}

export function clearTranscriptHydrationFetchedRevision() {
  applyRemoteSurfacePatch(createClearedTranscriptHydrationFetchedRevisionPatch());
}

export function recordTranscriptHydrationRevision(state, fetchedRevision) {
  applyRemoteSurfacePatch(createTranscriptHydrationRevisionPatch(fetchedRevision));
}

export function markTranscriptHydrationComplete(_state, fetchedRevision) {
  applyRemoteSurfacePatch(createTranscriptHydrationCompletePatch(fetchedRevision));
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

function prepareRemoteRow(currentState, threadId, entry) {
  const prepared = prepareTranscriptEntryForSurface(currentState, threadId, entry, {
    applyPatch: false,
  });
  return { entry: prepared.entry, patch: prepared.cachePatch };
}

export function mergeRecoveredTranscriptRows(state, page, rowIds, options = {}) {
  applyRemoteSurfacePatch(
    createRecoveredTranscriptRowsPatch(state, page, rowIds, {
      ...options,
      prepareEntry: prepareRemoteRow,
    })
  );
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
