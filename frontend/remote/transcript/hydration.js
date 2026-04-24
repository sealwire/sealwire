import {
  hydrateTranscript,
  loadOlderTranscript,
} from "../../shared/transcript-hydration.js";
import * as store from "./store.js";

export function hydrateRemoteTranscript(state, snapshot, options) {
  return hydrateTranscript(state, snapshot, store, {
    ...options,
    incompletePageError: "remote transcript page response is incomplete",
    missingTailError: "remote transcript page response did not include visible tail entries",
    progressBeforeFetch: true,
  });
}

export function loadOlderRemoteTranscript(state, options) {
  return loadOlderTranscript(state, store, {
    ...options,
    incompletePageError: "remote older transcript page response is incomplete",
  });
}
