import { applyRemoteSurfacePatch } from "../surface-state.js";
import {
  buildExpandedTranscriptDetailEntries,
  cacheTranscriptEntryDetail as cacheTranscriptEntryDetailPatch,
  createClearedTranscriptEntryDetailsPatch,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  prepareTranscriptEntryForSurface as prepareTranscriptEntryForSurfacePatch,
  setLiveTranscriptEntryDetail as setLiveTranscriptEntryDetailPatch,
  syncLiveTranscriptEntryDetailsFromSnapshot as syncLiveTranscriptEntryDetailsFromSnapshotPatch,
  TRANSCRIPT_ENTRY_DETAIL_CACHE_MAX_BYTES,
  TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES,
} from "../../shared/transcript-entry-details-state.js";

export {
  buildExpandedTranscriptDetailEntries,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  TRANSCRIPT_ENTRY_DETAIL_CACHE_MAX_BYTES,
  TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES,
};

export function clearTranscriptEntryDetails() {
  applyRemoteSurfacePatch(createClearedTranscriptEntryDetailsPatch());
}

export function cacheTranscriptEntryDetail(state, threadId, entry, { applyPatch = true } = {}) {
  const result = cacheTranscriptEntryDetailPatch(state, threadId, entry);
  if (applyPatch && result.patch) {
    applyRemoteSurfacePatch(result.patch);
  }
  return result;
}

export function setLiveTranscriptEntryDetail(state, threadId, entry, { applyPatch = true } = {}) {
  const result = setLiveTranscriptEntryDetailPatch(state, threadId, entry);
  if (applyPatch && result.patch) {
    applyRemoteSurfacePatch(result.patch);
  }

  return result;
}

export function syncLiveTranscriptEntryDetailsFromSnapshot(
  state,
  snapshot,
  { applyPatch = true } = {}
) {
  const result = syncLiveTranscriptEntryDetailsFromSnapshotPatch(state, snapshot);
  if (applyPatch && result.patch) {
    applyRemoteSurfacePatch(result.patch);
  }
  return result;
}

export function prepareTranscriptEntryForSurface(
  state,
  threadId,
  entry,
  { applyPatch = true } = {}
) {
  const result = prepareTranscriptEntryForSurfacePatch(state, threadId, entry);
  if (applyPatch && result.cachePatch) {
    applyRemoteSurfacePatch(result.cachePatch);
  }
  return result;
}
