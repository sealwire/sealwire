import { transcriptPageIsFromAnotherGeneration } from "./transcript-generation.js";
import { fetchOlderPageUntilRead, isTranscriptCursorRejected } from "./transcript-protocol.js";

function createStartableRequest(run) {
  let start;
  const promise = new Promise((resolve, reject) => {
    // Install the owner before running; async callers also turn synchronous
    // adapter failures into rejections on the same cleanup path.
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
    // The backfill's cursor was rejected: the relay rebuilt the thread mid-read.
    onCursorRejected,
    waitBeforeRetry,
    progressBeforeFetch = false,
    minInitialEntries = 0,
    maxInitialPages = 1,
    bridgeTarget = null,
    bridgeProgressPages = 3,
    isBackfillCurrent = () => true,
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

  const hasBridgeTarget = Number.isSafeInteger(bridgeTarget?.orderSeq);
  const { promise: hydrationPromise, start: startHydration } = createStartableRequest(async () => {
    const isBridgeRequestCurrent = () => !bridgeTarget
      || state.transcriptHydrationPromise === hydrationPromise;
    try {
      // A same-thread delta refusal can invalidate this read without changing
      // either its thread id or signature; capture the epoch before fetching.
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
      if (!isBridgeRequestCurrent()) return;

      // A changed thread or signature makes the fetched tail stale. Discard it
      // before merging so the current snapshot can request a fresh tail.
      if (store.getTranscriptHydrationThreadId(state) !== snapshot.active_thread_id) {
        return;
      }
      if (store.getTranscriptHydrationSignature(state) !== signature) {
        store.clearTranscriptHydrationFetchedRevision(state);
        return;
      }

      store.mergeTranscriptHydrationPage(state, withBodyRevision(page, snapshot), { prepend: false });

      let loadedPages = 1;
      let oldestReadOrderSeq = page.entries?.[0]?.order_seq ?? Infinity;
      const needsBridge = () => hasBridgeTarget
        && oldestReadOrderSeq > bridgeTarget.orderSeq;
      const needsInitialHistory = () => state.transcriptHydrationOrder.length < minInitialEntries
        && loadedPages < maxInitialPages;
      // Streamed text can span unread tool rows; row count alone cannot prove
      // the new tail connects to the last server read.
      while (
        state.transcriptHydrationOlderCursor != null &&
        (needsBridge() || needsInitialHistory())
      ) {
        if (!isBackfillCurrent()) return;
        store.beginTranscriptHydration(state, "loading");
        const capturedOlderPageRefusalEpoch = state.transcriptRefusalEpoch;
        const before = state.transcriptHydrationOlderCursor;
        const olderPage = await fetchOlderPageUntilRead(
          () => fetchPage({ threadId: snapshot.active_thread_id, before }),
          {
            isCurrent: () =>
              store.getTranscriptHydrationThreadId(state) === snapshot.active_thread_id
              && store.getTranscriptHydrationCursor(state) === before
              && isBackfillCurrent()
              && isBridgeRequestCurrent(),
            wait: waitBeforeRetry,
          }
        );
        if (!olderPage || olderPage.thread_id !== snapshot.active_thread_id) {
          throw new Error(incompletePageError);
        }
        if (isStaleTranscriptPage(state, olderPage)) {
          return;
        }
        if (isRefusalEpochStale(state, capturedOlderPageRefusalEpoch)) {
          return;
        }
        if (!isBridgeRequestCurrent()) return;
        if (olderPage.prev_cursor === before) {
          throw new Error("transcript history cursor did not advance");
        }
        store.mergeTranscriptHydrationPage(state, withBodyRevision(olderPage, snapshot), { prepend: true });
        loadedPages += 1;
        oldestReadOrderSeq = olderPage.entries?.[0]?.order_seq ?? oldestReadOrderSeq;
        if (store.getTranscriptHydrationThreadId(state) !== snapshot.active_thread_id) {
          return;
        }
        if (needsBridge() && (loadedPages - 1) % bridgeProgressPages === 0) {
          store.beginTranscriptHydration(state, "loading");
          applyTranscriptHydrationProgress(state, store, onProgress);
        }
        // The same running turn may append rows while older pages arrive;
        // their generation and per-row revisions still fence the bridge.
        const isSameRunningTurn = bridgeTarget && snapshot.active_turn_id
          && state.session?.active_turn_id === snapshot.active_turn_id;
        if (store.getTranscriptHydrationSignature(state) !== signature && !isSameRunningTurn) {
          store.clearTranscriptHydrationFetchedRevision(state);
          return;
        }
      }

      // A fresh tail establishes body freshness even if older history remains.
      const completedBridge = hasBridgeTarget && !needsBridge() ? bridgeTarget : null;
      store.recordTranscriptHydrationRevision(
        state,
        snapshot.transcript_revision ?? null,
        completedBridge
      );
      if (page.prev_cursor == null) {
        store.markTranscriptHydrationComplete(state, snapshot.transcript_revision ?? null);
      }

      applyTranscriptHydrationProgress(state, store, onProgress);
    } catch (error) {
      store.setTranscriptHydrationIdle(state, hydrationPromise);
      if (isTranscriptCursorRejected(error) && onCursorRejected) {
        onCursorRejected(error);
        return;
      }
      onError(error);
    } finally {
      // Mid-fetch entries can change the signature; identity-based cleanup
      // avoids leaving a promise that blocks later history reads.
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

// Older-page requests, so a caller can tell one apart from a tail refresh
// holding the same hydration slot.
const olderPageRequests = new WeakSet();

// A streaming reply re-fetches the tail on most revisions, so the slot is busy
// most of the time; a small bound keeps a caller from queueing behind it forever.
const MAX_TAIL_REFRESH_WAITS = 2;

export async function loadOlderTranscript(
  state,
  store,
  {
    fetchPage,
    incompletePageError,
    onError = () => {},
    onProgress = () => {},
    // The relay can no longer read the window's cursor: rebuild it from the latest page.
    onCursorRejected,
    waitBeforeRetry,
  }
) {
  const threadId = state.session?.active_thread_id;
  let before = store.getTranscriptHydrationCursor(state);
  for (let waits = 0; ; waits += 1) {
    if (!threadId || before == null) {
      // No cursor yet (e.g. still hydrating). `null` (not `false`) tells the
      // history loader this is transient — retry on the next poke — rather than
      // a genuine "reached the oldest page" stop.
      return null;
    }
    const inFlight = state.transcriptHydrationPromise;
    if (!inFlight && state.transcriptHydrationStatus !== "loading") {
      break;
    }
    if (!inFlight || olderPageRequests.has(inFlight) || waits >= MAX_TAIL_REFRESH_WAITS) {
      return inFlight;
    }
    // Page after the tail refresh instead of returning its `undefined`, which the
    // history loader reads as "nothing loaded" and parks until some later render.
    await Promise.resolve(inFlight).catch(() => {});
    if (state.session?.active_thread_id !== threadId) {
      return null;
    }
    before = store.getTranscriptHydrationCursor(state);
  }

  store.beginTranscriptHydration(state, "loading");
  const { promise: loadPromise, start: startLoad } = createStartableRequest(async () => {
    try {
      const capturedRefusalEpoch = state.transcriptRefusalEpoch;
      const requestedAt = { transcript_revision: state.session?.transcript_revision ?? null };
      const page = await fetchOlderPageUntilRead(() => fetchPage({ threadId, before }), {
        isCurrent: () =>
          state.session?.active_thread_id === threadId
          && store.getTranscriptHydrationCursor(state) === before,
        wait: waitBeforeRetry,
      });
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

      store.mergeTranscriptHydrationPage(state, withBodyRevision(page, requestedAt), { prepend: true });
      // The history loader uses this tri-state result to decide whether to keep
      // prefetching the next page within the same burst (see
      // createTranscriptHistoryLoader), which avoids the "scroll to the top,
      // nothing loads until you wiggle" stall:
      //   true  → a page loaded and `prev_cursor` says more remain → keep going
      //   false → just prepended the oldest page → stop until something changes
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
      if (isTranscriptCursorRejected(error) && onCursorRejected) {
        onCursorRejected(error);
        return null;
      }
      onError(error);
      // Transient failure — `null` lets a later poke retry instead of wedging.
      return null;
    } finally {
      store.clearTranscriptHydrationPromise(state, loadPromise);
    }
  });

  olderPageRequests.add(loadPromise);
  store.setTranscriptHydrationPromise(state, loadPromise);
  startLoad();
  return loadPromise;
}

// A page read after a snapshot is at least that fresh; a relay that stamps its
// pages says so itself, and this only fills the gap when it does not.
function withBodyRevision(page, snapshot) {
  if (page == null || page.revision != null || snapshot?.transcript_revision == null) {
    return page;
  }
  return { ...page, revision: snapshot.transcript_revision };
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
