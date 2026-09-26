import {
  hydrateTranscript,
  loadOlderTranscript,
} from "../../shared/transcript-hydration.js";
import { recoverTranscriptRows } from "../../shared/transcript-row-recovery.js";
import * as store from "./store.js";

const INITIAL_TRANSCRIPT_MIN_ENTRIES = 12;
const INITIAL_TRANSCRIPT_MAX_PAGES = 3;

// The merge can promote a clipped tail entry to `full`, hiding it from the gate
// below — prefer the raw wire snapshot, guarded by thread id.
export function selectHydrationSnapshot(state, session) {
  const raw = state.rawSessionSnapshot;
  return raw && raw.active_thread_id === session?.active_thread_id ? raw : session;
}

export function hydrateLocalTranscript(state, snapshot, options) {
  const hydration = hydrateTranscript(state, selectHydrationSnapshot(state, snapshot), store, {
    ...options,
    incompletePageError: "local transcript page response is incomplete",
    missingTailError: "local transcript page response did not include visible tail entries",
    minInitialEntries: INITIAL_TRANSCRIPT_MIN_ENTRIES,
    maxInitialPages: INITIAL_TRANSCRIPT_MAX_PAGES,
    progressBeforeFetch: false,
  });
  return kickRowRecovery(state, hydration, options);
}

// Owed rows are recovered once any tail read in flight has landed.
function kickRowRecovery(state, hydration, options) {
  const kick = () => recoverTranscriptRows(state, store, options);
  kick();
  if (hydration && typeof hydration.then === "function") {
    hydration.then(kick, kick);
  }
  return hydration;
}

export function loadOlderLocalTranscript(state, options) {
  return loadOlderTranscript(state, store, {
    ...options,
    incompletePageError: "local older transcript page response is incomplete",
  });
}
