// Recover owed transcript rows by relay row id.
//
// A shelled or clipped row used to wait for the latest page to carry it again,
// and with long rows a page holds one or two, so a row that was not the newest
// when the page was read stayed "•••" until a reload. The owed set is kept by the
// snapshot-tail merge (transcript-hydration-store.js); this drains it, one
// request at a time, many ids per request.

import { transcriptPageIsFromAnotherGeneration } from "./transcript-generation.js";
import { noteTranscriptRowsFailed, takeDueTranscriptRows } from "./transcript-hydration-store.js";

export const ROW_RECOVERY_BATCH = 8;
// A fetch has no deadline of its own, and one that never settles would hold the
// single request slot for good.
export const ROW_RECOVERY_TIMEOUT_MS = 20_000;

/**
 * Start one recovery request if none is in flight and any owed row is due.
 * Returns the in-flight promise, or null when nothing was started.
 *
 * `store` supplies getTranscriptHydrationThreadId, mergeRecoveredTranscriptRows
 * and buildHydratedTranscriptProgress. Timers are injectable for tests.
 */
export function recoverTranscriptRows(state, store, options = {}) {
  const {
    fetchRows,
    onProgress = () => {},
    now = () => Date.now(),
    setTimer = (fn, delay) => setTimeout(fn, delay),
    clearTimer = (handle) => clearTimeout(handle),
  } = options;
  if (typeof fetchRows !== "function") {
    return null;
  }
  const kick = () => recoverTranscriptRows(state, store, options);
  // One request at a time per owed set; one for a set already replaced (a
  // switch, a restart) is left to settle on its own.
  if (
    state.transcriptRowRecoveryInFlight
    && state.transcriptRowRecoveryInFlightSet === state.transcriptUnresolvedRows
  ) {
    return state.transcriptRowRecoveryInFlight;
  }
  const threadId = store.getTranscriptHydrationThreadId(state);
  // Only a window that holds rows can owe any. Not gated on the tail read being
  // settled: a failed or pending re-read of the tail must not stall recovery.
  if (!threadId || !(state.transcriptHydrationOrder?.length > 0)) {
    return null;
  }
  const { due, nextRetryAt } = takeDueTranscriptRows(state, now(), ROW_RECOVERY_BATCH);
  if (due.length === 0) {
    scheduleRetry(state, nextRetryAt, { now, setTimer, clearTimer, kick });
    return null;
  }
  const generation = state.transcriptHydrationGeneration || "";
  const owedSet = state.transcriptUnresolvedRows;
  const bodyRevision = state.session?.transcript_revision ?? null;
  let deadline = null;
  // Cancelled on timeout: an abandoned fetch would otherwise keep its connection.
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const request = (async () => {
    try {
      const page = await Promise.race([
        fetchRows({ threadId, rowIds: due, signal: controller?.signal }),
        new Promise((_, reject) => {
          deadline = setTimer(() => {
            controller?.abort();
            reject(new Error("row recovery timed out"));
          }, ROW_RECOVERY_TIMEOUT_MS);
        }),
      ]);
      if (!answerStillApplies(state, store, { threadId, generation, owedSet, page })) {
        // Same set but a foreign answer (another run's page): ask again later.
        if (state.transcriptUnresolvedRows === owedSet) {
          noteTranscriptRowsFailed(state, due, now());
        }
        return;
      }
      store.mergeRecoveredTranscriptRows(state, page, due, { bodyRevision, now: now() });
      const progress = store.buildHydratedTranscriptProgress(state);
      if (progress) {
        onProgress(progress);
      }
    } catch (error) {
      if (state.transcriptUnresolvedRows === owedSet) {
        noteTranscriptRowsFailed(state, due, now());
      }
    } finally {
      if (deadline != null) {
        clearTimer(deadline);
      }
      if (state.transcriptRowRecoveryInFlight === request) {
        state.transcriptRowRecoveryInFlight = null;
        state.transcriptRowRecoveryInFlightSet = null;
      }
      kick();
    }
  })();
  state.transcriptRowRecoveryInFlight = request;
  state.transcriptRowRecoveryInFlightSet = owedSet;
  return request;
}

// A switch or a relay restart replaces the owed set, so its identity is the check.
function answerStillApplies(state, store, { threadId, generation, owedSet, page }) {
  if (store.getTranscriptHydrationThreadId(state) !== threadId) return false;
  if ((state.transcriptHydrationGeneration || "") !== generation) return false;
  if (state.transcriptUnresolvedRows !== owedSet) return false;
  if (page?.thread_id && page.thread_id !== threadId) return false;
  return !transcriptPageIsFromAnotherGeneration(state.session, page);
}

function scheduleRetry(state, retryAt, { now, setTimer, clearTimer, kick }) {
  if (retryAt == null) {
    return;
  }
  if (state.transcriptRowRecoveryTimer && state.transcriptRowRecoveryTimerAt <= retryAt) {
    return;
  }
  if (state.transcriptRowRecoveryTimer) {
    clearTimer(state.transcriptRowRecoveryTimer);
  }
  state.transcriptRowRecoveryTimerAt = retryAt;
  state.transcriptRowRecoveryTimer = setTimer(() => {
    state.transcriptRowRecoveryTimer = null;
    state.transcriptRowRecoveryTimerAt = null;
    kick();
  }, Math.max(0, retryAt - now()));
}
