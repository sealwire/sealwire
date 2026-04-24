import {
  buildExpandedTranscriptDetailEntries,
  cacheTranscriptEntryDetail as cacheTranscriptEntryDetailPatch,
  createClearedTranscriptEntryDetailsPatch,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  setLiveTranscriptEntryDetail as setLiveTranscriptEntryDetailPatch,
  syncLiveTranscriptEntryDetailsFromSnapshot as syncLiveTranscriptEntryDetailsFromSnapshotPatch,
} from "../../shared/transcript-entry-details-state.js";

function applyLocalTranscriptDetailPatch(state, patch) {
  if (!patch) {
    return;
  }

  Object.assign(state, patch);
}

export {
  buildExpandedTranscriptDetailEntries,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
};

export function clearTranscriptEntryDetails(state) {
  applyLocalTranscriptDetailPatch(state, createClearedTranscriptEntryDetailsPatch());
}

export function cacheTranscriptEntryDetail(state, threadId, entry) {
  const result = cacheTranscriptEntryDetailPatch(state, threadId, entry);
  applyLocalTranscriptDetailPatch(state, result.patch);
  return result;
}

export function setLiveTranscriptEntryDetail(state, threadId, entry) {
  const result = setLiveTranscriptEntryDetailPatch(state, threadId, entry);
  applyLocalTranscriptDetailPatch(state, result.patch);
  return result;
}

export function syncLiveTranscriptEntryDetailsFromSnapshot(state, snapshot) {
  const result = syncLiveTranscriptEntryDetailsFromSnapshotPatch(state, snapshot);
  applyLocalTranscriptDetailPatch(state, result.patch);
  return result;
}
