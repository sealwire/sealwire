import { transcriptPageIsFromAnotherGeneration } from "./transcript-generation.js";

function createStartableRequest(run) {
  let start;
  const promise = new Promise((resolve, reject) => {
    // Both callers provide an async function, so even an adapter that throws
    // synchronously is surfaced as a rejected promise here. The important
    // ordering is that the owner promise exists and is stored before run starts.
    start = () => run().then(resolve, reject);
  });
  return { promise, start };
}

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

  // Install the promise owner before invoking fetchPage. Most fetchers return a
  // rejected promise on failure, but an injected adapter may throw before it can
  // return one. Starting through this deferred handle keeps that synchronous
  // failure on the same ownership-safe catch/finally path instead of referencing
  // `hydrationPromise` while its declaration is still being initialized.
  const { promise: hydrationPromise, start: startHydration } = createStartableRequest(async () => {
    try {
      // Captured BEFORE the fetch, not after: a same-thread per-item delta
      // refusal (session/stream.js) bumps this while this fetch is in flight,
      // and neither the thread id nor the signature checks below notice that —
      // see isRefusalEpochStale.
      const capturedRefusalEpoch = state.transcriptRefusalEpoch;
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
      if (isRefusalEpochStale(state, capturedRefusalEpoch)) {
        return;
      }

      // Freshness gate before the merge. A non-prepend tail merge used to RESET
      // the order to the page's ids, orphaning anything the page did not carry
      // (older scrolled-in history, or an id a live SSE delta had just
      // appended) — still present in `entries`, never rendered again, and
      // unrecoverable, since a later same-id merge only re-adds an id that is
      // new to `entries`. `createMergedTranscriptHydrationPagePatch`'s
      // non-prepend branch now delegates to `mergeTailPageOrder`
      // (shared/authoritative-tail-merge.js) instead, which keeps anything the
      // page does not carry above or below it rather than dropping it — see
      // "a tail page merges into the loaded window instead of replacing its
      // order" (transcript-hydration-store.test.mjs). That closed the
      // order-loss failure mode this gate was originally written against, but
      // the gate itself still earns its keep independently: the thread-id and
      // signature checks below are a basic identity/freshness check on the
      // page's own content, not a workaround for the merge. If the thread or
      // signature changed while this fetch was in flight, the page is stale:
      // release the loading gate and discard it so a fresh fetch, re-armed at
      // the new revision, rebuilds the tail.
      if (store.getTranscriptHydrationThreadId(state) !== snapshot.active_thread_id) {
        return;
      }
      if (store.getTranscriptHydrationSignature(state) !== signature) {
        store.clearTranscriptHydrationFetchedRevision(state);
        return;
      }

      store.mergeTranscriptHydrationPage(state, page, { prepend: false });

      let loadedPages = 1;
      while (
        state.transcriptHydrationOrder.length < minInitialEntries &&
        state.transcriptHydrationOlderCursor != null &&
        loadedPages < maxInitialPages
      ) {
        const capturedOlderPageRefusalEpoch = state.transcriptRefusalEpoch;
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
        if (isRefusalEpochStale(state, capturedOlderPageRefusalEpoch)) {
          return;
        }
        store.mergeTranscriptHydrationPage(state, olderPage, { prepend: true });
        loadedPages += 1;
        if (store.getTranscriptHydrationThreadId(state) !== snapshot.active_thread_id) {
          return;
        }
        if (store.getTranscriptHydrationSignature(state) !== signature) {
          store.clearTranscriptHydrationFetchedRevision(state);
          return;
        }
      }

      // Two different questions, and folding them together is what made the
      // settled-tail repair skip exactly the long transcripts it exists for.
      //
      // "Which revision are these bodies from" is answered by having merged the
      // tail at all, so it is recorded unconditionally. "Have we reached the top
      // of history" is what `prev_cursor == null` answers, and that is what
      // decides whether the window is COMPLETE.
      store.recordTranscriptHydrationRevision(state, snapshot.transcript_revision ?? null);
      if (page.prev_cursor == null) {
        store.markTranscriptHydrationComplete(state, snapshot.transcript_revision ?? null);
      }

      applyTranscriptHydrationProgress(state, store, onProgress);
    } catch (error) {
      store.setTranscriptHydrationIdle(state, hydrationPromise);
      onError(error);
    } finally {
      // Clear by promise identity, not signature: a new entry joining mid-fetch
      // re-keys the signature, and a signature gate would leak this promise (which
      // then blocks loadOlderTranscript / scroll-up).
      store.clearTranscriptHydrationPromise(state, hydrationPromise);
    }
  });

  store.setTranscriptHydrationPromise(state, hydrationPromise);
  startHydration();
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
  const { promise: loadPromise, start: startLoad } = createStartableRequest(async () => {
    try {
      const capturedRefusalEpoch = state.transcriptRefusalEpoch;
      const page = await fetchPage({ threadId, before });
      if (!page || page.thread_id !== threadId) {
        throw new Error(incompletePageError);
      }
      if (isStaleTranscriptPage(state, page)) {
        return null;
      }
      if (isRefusalEpochStale(state, capturedRefusalEpoch)) {
        store.setTranscriptHydrationIdle(state, loadPromise);
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
        store.setTranscriptHydrationIdle(state, loadPromise);
      } else {
        // No revision: reaching the TOP of history says nothing about whether
        // the tail's cached bodies are current, and claiming otherwise would
        // suppress the settled-turn re-check.
        store.markTranscriptHydrationComplete(state);
      }
      applyTranscriptHydrationProgress(state, store, onProgress);
      return hasMore;
    } catch (error) {
      store.setTranscriptHydrationIdle(state, loadPromise);
      onError(error);
      // Transient failure — `null` lets a later poke retry instead of wedging.
      return null;
    } finally {
      store.clearTranscriptHydrationPromise(state, loadPromise);
    }
  });

  store.setTranscriptHydrationPromise(state, loadPromise);
  startLoad();
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
  if (
    page?.thread_id
    && state.session?.active_thread_id
    && page.thread_id !== state.session.active_thread_id
  ) {
    return true;
  }
  // A page requested before a relay restart can land after it — see
  // shared/transcript-generation.js for the rule.
  return transcriptPageIsFromAnotherGeneration(state.session, page);
}

// `capturedRefusalEpoch` is read back from `state.transcriptRefusalEpoch`
// immediately before the fetch this page answers (see each call site above),
// and compared here against its CURRENT value. A same-thread per-item delta
// refusal (local/session/stream.js) bumps that counter while a fetch is in
// flight, and neither isStaleTranscriptPage's thread-id check nor the
// caller's own signature check notices that — the refusal changes neither.
// `undefined` on both sides (remote never bumps this field) compares equal,
// so this is a no-op there; do not fork the check per surface.
//
// Deliberately not a revision floor: `page.revision ?? null`
// (shared/transcript-page.js) is nullable, and a null would force a coin flip
// exactly when this guard matters.
//
// Both stale-page shapes return before merging. Their enclosing `finally`
// releases `loading` only when this request's promise still owns the hydration
// slot; if a re-arm or thread switch installed another request, the old settle
// cannot clobber that newer request's status.
function isRefusalEpochStale(state, capturedRefusalEpoch) {
  return capturedRefusalEpoch !== state.transcriptRefusalEpoch;
}
