import {
  beginTranscriptHydration,
  buildHydratedTranscriptProgress,
  clearTranscriptHydrationPromise,
  getTranscriptHydrationCursor,
  getTranscriptHydrationSignature,
  getTranscriptHydrationThreadId,
  markTranscriptHydrationComplete,
  mergeTranscriptHydrationPage,
  prepareTranscriptHydration,
  setTranscriptHydrationIdle,
  setTranscriptHydrationPromise,
} from "./store.js";

export async function hydrateLocalTranscript(
  state,
  snapshot,
  {
    fetchPage,
    onProgress = () => {},
    onError = () => {},
  }
) {
  const { signature, shouldHydrate, alreadyComplete, existingPromise } = prepareTranscriptHydration(
    state,
    snapshot
  );

  if (!shouldHydrate || alreadyComplete) {
    return existingPromise;
  }

  if (existingPromise) {
    return existingPromise;
  }

  beginTranscriptHydration(state, "loading");
  const hydrationPromise = (async () => {
    try {
      const page = await fetchPage({
        threadId: snapshot.active_thread_id,
        before: null,
      });

      if (!page || page.thread_id !== snapshot.active_thread_id) {
        throw new Error("local transcript page response is incomplete");
      }
      if ((snapshot.transcript || []).length > 0 && (page.entries || []).length === 0) {
        throw new Error("local transcript page response did not include visible tail entries");
      }

      mergeTranscriptHydrationPage(state, page, { prepend: false });
      if (getTranscriptHydrationThreadId(state) !== snapshot.active_thread_id) {
        return;
      }
      if (getTranscriptHydrationSignature(state) !== signature) {
        return;
      }
      if (page.prev_cursor == null) {
        markTranscriptHydrationComplete(state);
      }

      applyTranscriptHydrationProgress(state, onProgress);
    } catch (error) {
      setTranscriptHydrationIdle(state);
      onError(error);
    } finally {
      clearTranscriptHydrationPromise(state, signature);
    }
  })();

  setTranscriptHydrationPromise(state, hydrationPromise);
  applyTranscriptHydrationProgress(state, onProgress);
  return hydrationPromise;
}

export async function loadOlderLocalTranscript(
  state,
  {
    fetchPage,
    onProgress = () => {},
    onError = () => {},
  }
) {
  const threadId = state.session?.active_thread_id;
  const before = getTranscriptHydrationCursor(state);
  if (!threadId || before == null) {
    return null;
  }
  if (state.transcriptHydrationPromise || state.transcriptHydrationStatus === "loading") {
    return state.transcriptHydrationPromise;
  }

  const signature = getTranscriptHydrationSignature(state);
  beginTranscriptHydration(state, "loading");
  const loadPromise = (async () => {
    try {
      const page = await fetchPage({ threadId, before });
      if (!page || page.thread_id !== threadId) {
        throw new Error("local older transcript page response is incomplete");
      }

      mergeTranscriptHydrationPage(state, page, { prepend: true });
      if (page.prev_cursor == null) {
        markTranscriptHydrationComplete(state);
      } else {
        setTranscriptHydrationIdle(state);
      }
      applyTranscriptHydrationProgress(state, onProgress);
    } catch (error) {
      setTranscriptHydrationIdle(state);
      onError(error);
    } finally {
      clearTranscriptHydrationPromise(state, signature);
    }
  })();

  setTranscriptHydrationPromise(state, loadPromise);
  return loadPromise;
}

function applyTranscriptHydrationProgress(state, onProgress) {
  const snapshot = buildHydratedTranscriptProgress(state);
  if (!snapshot) {
    return;
  }

  onProgress(snapshot);
}
