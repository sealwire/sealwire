import {
  hydrateTranscript,
  loadOlderTranscript,
} from "../../shared/transcript-hydration.js";
import * as store from "./store.js";

export function hydrateLocalTranscript(state, snapshot, options) {
  return hydrateTranscript(state, snapshot, store, {
    ...options,
    incompletePageError: "local transcript page response is incomplete",
    missingTailError: "local transcript page response did not include visible tail entries",
    progressBeforeFetch: false,
  });
}

export function loadOlderLocalTranscript(state, options) {
  return loadOlderTranscript(state, store, {
    ...options,
    incompletePageError: "local older transcript page response is incomplete",
  });
}
