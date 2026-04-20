import {
  beginTranscriptHydration,
  buildHydratedTranscriptProgress,
  clearTranscriptHydrationPromise,
  getTranscriptHydrationCursor,
  getTranscriptHydrationLastFetchAt,
  getTranscriptHydrationSignature,
  getTranscriptHydrationThreadId,
  hasIncompleteTailHydrationEntries,
  markTranscriptHydrationComplete,
  mergeTranscriptHydrationPage,
  pauseTranscriptHydrationAfterTailReady,
  prepareTranscriptHydration,
  setTranscriptHydrationFetchAt,
  setTranscriptHydrationIdle,
  setTranscriptHydrationPromise,
} from "./store.js";

export async function hydrateRemoteTranscript(
  state,
  snapshot,
  {
    fetchPage,
    fetchIntervalMs,
    now = () => Date.now(),
    wait = (delayMs) =>
      new Promise((resolve) => {
        window.setTimeout(resolve, delayMs);
      }),
    onProgress = () => {},
    onError = () => {},
  }
) {
  const preparation = prepareTranscriptHydration(state, snapshot);
  if (!preparation.shouldHydrate) {
    return;
  }
  const { signature, alreadyComplete, existingPromise } = preparation;
  if (alreadyComplete) {
    return;
  }
  if (existingPromise) {
    return existingPromise;
  }

  beginTranscriptHydration(state);
  applyTranscriptHydrationProgress(state, onProgress);
  const hydrationPromise = (async () => {
    try {
      await hydrateRemoteTranscriptPages(state, snapshot.active_thread_id, signature, {
        fetchPage,
        fetchIntervalMs,
        now,
        wait,
        onProgress,
      });
    } catch (error) {
      setTranscriptHydrationIdle(state);
      onError(error);
    } finally {
      clearTranscriptHydrationPromise(state, signature);
    }
  })();
  setTranscriptHydrationPromise(state, hydrationPromise);

  return hydrationPromise;
}

async function hydrateRemoteTranscriptPages(
  state,
  threadId,
  signature,
  { fetchPage, fetchIntervalMs, now, wait, onProgress }
) {
  while (getTranscriptHydrationThreadId(state) === threadId) {
    if (state.transcriptHydrationStatus === "complete") {
      markTranscriptHydrationComplete(state);
      applyTranscriptHydrationProgress(state, onProgress);
      return;
    }

    await waitForTranscriptFetchWindow(
      state,
      fetchIntervalMs,
      now,
      wait,
      hasIncompleteTailHydrationEntries(state)
    );

    const page = await fetchPage({
      threadId,
      before: getTranscriptHydrationCursor(state),
    });
    setTranscriptHydrationFetchAt(state, now());

    if (!page || page.thread_id !== threadId) {
      throw new Error("remote transcript response is incomplete");
    }

    mergeTranscriptHydrationPage(state, page);
    applyTranscriptHydrationProgress(state, onProgress);

    if (!hasIncompleteTailHydrationEntries(state)) {
      if (state.transcriptHydrationStatus === "complete") {
        markTranscriptHydrationComplete(state);
        applyTranscriptHydrationProgress(state, onProgress);
        return;
      }
      pauseTranscriptHydrationAfterTailReady(state);
      return;
    }

    if (getTranscriptHydrationSignature(state) !== signature) {
      return;
    }
  }
}

function applyTranscriptHydrationProgress(state, onProgress) {
  const snapshot = buildHydratedTranscriptProgress(state);
  if (!snapshot) {
    return;
  }

  onProgress(snapshot);
}

async function waitForTranscriptFetchWindow(
  state,
  fetchIntervalMs,
  now,
  wait,
  prioritizeTailCompletion = false
) {
  if (prioritizeTailCompletion) {
    return;
  }

  const elapsedMs = now() - getTranscriptHydrationLastFetchAt(state);
  const delayMs = Math.max(0, fetchIntervalMs - elapsedMs);
  if (delayMs <= 0) {
    return;
  }

  await wait(delayMs);
}
