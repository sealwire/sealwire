import {
  hydrateTranscript,
  loadOlderTranscript,
} from "../../shared/transcript-hydration.js";
import * as store from "./store.js";

const INITIAL_TRANSCRIPT_MIN_ENTRIES = 12;
const INITIAL_TRANSCRIPT_MAX_PAGES = 3;

export function hydrateRemoteTranscript(state, snapshot, options) {
  return hydrateTranscript(state, snapshot, store, {
    ...options,
    incompletePageError: "remote transcript page response is incomplete",
    missingTailError: "remote transcript page response did not include visible tail entries",
    minInitialEntries: INITIAL_TRANSCRIPT_MIN_ENTRIES,
    maxInitialPages: INITIAL_TRANSCRIPT_MAX_PAGES,
    progressBeforeFetch: true,
  });
}

export function loadOlderRemoteTranscript(state, options) {
  return loadOlderTranscript(state, store, {
    ...options,
    incompletePageError: "remote older transcript page response is incomplete",
  });
}
