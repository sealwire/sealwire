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
import { prepareTranscriptEntryForSurface } from "./details.js";
import { applyRemoteSurfacePatch } from "../surface-state.js";

export function clearTranscriptHydration() {
  applyRemoteSurfacePatch(createClearedTranscriptHydrationPatch());
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

export function clearTranscriptHydrationPromise(state, signature) {
  const patch = createClearedTranscriptHydrationPromisePatch(state, signature);
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
