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

      // Freshness gate BEFORE the (order-resetting) merge. A non-prepend tail merge
      // RESETS the order to the page's ids (createMergedTranscriptHydrationPagePatch),
      // so merging a page fetched against a now-stale tail would DROP a
      // concurrently-joined entry from the order — orphaning it in the entries map,
      // where a later same-id merge never re-adds it (and once it arrives `full`,
      // `snapshotTailNeedsFullText` is false so nothing re-fetches → permanently
      // missing). If the thread or signature changed while this fetch was in flight,
      // the page is stale: release the loading gate and discard it so a fresh fetch,
      // re-armed at the new revision, rebuilds the tail. (The older-page loop below
      // prepends, which never resets the order, so its post-merge checks are safe.)
      if (
        store.getTranscriptHydrationThreadId(state) !== snapshot.active_thread_id ||
        store.getTranscriptHydrationSignature(state) !== signature
      ) {
        store.setTranscriptHydrationIdle(state);
        return;
      }

      store.mergeTranscriptHydrationPage(state, page, { prepend: false });

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
      // Clear by promise identity, not signature: a new entry joining mid-fetch
      // re-keys the signature, and a signature gate would leak this promise (which
      // then blocks loadOlderTranscript / scroll-up).
      store.clearTranscriptHydrationPromise(state, hydrationPromise);
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
      store.clearTranscriptHydrationPromise(state, loadPromise);
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
