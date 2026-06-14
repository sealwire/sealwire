export async function hydrateTranscript(
  state,
  snapshot,
  store,
  {
    fetchPage,
    incompletePageError,
    missingTailError,
    onError = () => {},
    onProgress = () => {},
    progressBeforeFetch = false,
    minInitialEntries = 0,
    maxInitialPages = 1,
  }
) {
  const { signature, shouldHydrate, alreadyComplete, existingPromise } = store.prepareTranscriptHydration(
    state,
    snapshot
  );

  if (!shouldHydrate || alreadyComplete) {
    if (progressBeforeFetch) {
      applyTranscriptHydrationProgress(state, store, onProgress);
    }
    return existingPromise;
  }

  if (existingPromise) {
    return existingPromise;
  }

  store.beginTranscriptHydration(state, "loading");
  if (progressBeforeFetch) {
    applyTranscriptHydrationProgress(state, store, onProgress);
  }

  const hydrationPromise = (async () => {
    try {
      const page = await fetchPage({
        threadId: snapshot.active_thread_id,
        before: null,
      });

      if (!page || page.thread_id !== snapshot.active_thread_id) {
        throw new Error(incompletePageError);
      }
      if ((snapshot.transcript || []).length > 0 && (page.entries || []).length === 0) {
        throw new Error(missingTailError);
      }
      if (isStaleTranscriptPage(state, page)) {
        return;
      }

      store.mergeTranscriptHydrationPage(state, page, { prepend: false });
      if (store.getTranscriptHydrationThreadId(state) !== snapshot.active_thread_id) {
        return;
      }
      if (store.getTranscriptHydrationSignature(state) !== signature) {
        return;
      }

      let loadedPages = 1;
      while (
        state.transcriptHydrationOrder.length < minInitialEntries &&
        state.transcriptHydrationOlderCursor != null &&
        loadedPages < maxInitialPages
      ) {
        const olderPage = await fetchPage({
          threadId: snapshot.active_thread_id,
          before: state.transcriptHydrationOlderCursor,
        });
        if (!olderPage || olderPage.thread_id !== snapshot.active_thread_id) {
          throw new Error(incompletePageError);
        }
        if (isStaleTranscriptPage(state, olderPage)) {
          return;
        }
        store.mergeTranscriptHydrationPage(state, olderPage, { prepend: true });
        loadedPages += 1;
        if (store.getTranscriptHydrationThreadId(state) !== snapshot.active_thread_id) {
          return;
        }
        if (store.getTranscriptHydrationSignature(state) !== signature) {
          return;
        }
      }

      if (page.prev_cursor == null) {
        store.markTranscriptHydrationComplete(state);
      }

      applyTranscriptHydrationProgress(state, store, onProgress);
    } catch (error) {
      store.setTranscriptHydrationIdle(state);
      onError(error);
    } finally {
      store.clearTranscriptHydrationPromise(state, signature);
    }
  })();

  store.setTranscriptHydrationPromise(state, hydrationPromise);
  if (!progressBeforeFetch) {
    applyTranscriptHydrationProgress(state, store, onProgress);
  }
  return hydrationPromise;
}

export async function loadOlderTranscript(
  state,
  store,
  {
    fetchPage,
    incompletePageError,
    onError = () => {},
    onProgress = () => {},
  }
) {
  const threadId = state.session?.active_thread_id;
  const before = store.getTranscriptHydrationCursor(state);
  if (!threadId || before == null) {
    // No cursor yet (e.g. still hydrating). `null` (not `false`) tells the
    // history loader this is transient — retry on the next poke — rather than
    // a genuine "reached the oldest page" stop.
    return null;
  }
  if (state.transcriptHydrationPromise || state.transcriptHydrationStatus === "loading") {
    return state.transcriptHydrationPromise;
  }

  const signature = store.getTranscriptHydrationSignature(state);
  store.beginTranscriptHydration(state, "loading");
  const loadPromise = (async () => {
    try {
      const page = await fetchPage({ threadId, before });
      if (!page || page.thread_id !== threadId) {
        throw new Error(incompletePageError);
      }
      if (isStaleTranscriptPage(state, page)) {
        return null;
      }

      store.mergeTranscriptHydrationPage(state, page, { prepend: true });
      // The history loader uses this tri-state result to decide whether to keep
      // prefetching the next page within the same burst (see
      // createTranscriptHistoryLoader), which avoids the "scroll to the top,
      // nothing loads until you wiggle" stall:
      //   true  → a page loaded and `prev_cursor` says more remain → keep going
      //   false → just prepended the oldest page → stop for good (reached top)
      const hasMore = page.prev_cursor != null;
      if (hasMore) {
        store.setTranscriptHydrationIdle(state);
      } else {
        store.markTranscriptHydrationComplete(state);
      }
      applyTranscriptHydrationProgress(state, store, onProgress);
      return hasMore;
    } catch (error) {
      store.setTranscriptHydrationIdle(state);
      onError(error);
      // Transient failure — `null` lets a later poke retry instead of wedging.
      return null;
    } finally {
      store.clearTranscriptHydrationPromise(state, signature);
    }
  })();

  store.setTranscriptHydrationPromise(state, loadPromise);
  return loadPromise;
}

function applyTranscriptHydrationProgress(state, store, onProgress) {
  const snapshot = store.buildHydratedTranscriptProgress(state);
  if (!snapshot) {
    return;
  }

  onProgress(snapshot);
}

function isStaleTranscriptPage(state, page) {
  return Boolean(
    page?.thread_id
      && state.session?.active_thread_id
      && page.thread_id !== state.session.active_thread_id
  );
}
