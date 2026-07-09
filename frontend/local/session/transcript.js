import { transcript } from "../dom.js";
import { fetchTranscriptEntryDetailViaRequester } from "../../shared/transcript-entry-detail.js";
import { normalizeThreadTranscriptPage } from "../../shared/transcript-page.js";
import { createThreadTranscriptPageQueryOptions } from "../../shared/thread-queries.js";
import { createCachingTranscriptPageFetcher } from "../../shared/caching-transcript-fetcher.js";
import { localTranscriptPageCache } from "../transcript/page-cache-instance.js";
import { readLocalUiState } from "../ui-store.js";
import {
  cacheTranscriptEntryDetail,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  isOmittedFileChangeDetail,
  setLiveTranscriptEntryDetail,
} from "../transcript/details.js";
import { hydrateLocalTranscript, loadOlderLocalTranscript } from "../transcript/hydration.js";
import { clearTranscriptHydration, restoreHydratedTranscript } from "../transcript/store.js";

export function createTranscriptController(ctx) {
  const {
    state,
    apiFetch,
    queryClient,
    logLine,
    renderSession,
    isViewingConversation,
  } = ctx;
  const loadSession = (...args) => ctx.loadSession(...args);

  async function requestTranscriptEntryDetail(threadId, itemId, { field = null, cursor = null } = {}) {
    const url = new URL(
      `/api/threads/${encodeURIComponent(threadId)}/entries/${encodeURIComponent(itemId)}/detail`,
      window.location.origin
    );
    if (field) {
      url.searchParams.set("field", field);
    }
    if (typeof cursor === "number") {
      url.searchParams.set("cursor", String(cursor));
    }

    const response = await apiFetch(url);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load transcript entry detail");
    }

    return payload.data;
  }

  async function fetchTranscriptEntryDetail(threadId, itemId) {
    return fetchTranscriptEntryDetailViaRequester({
      itemId,
      requestDetail: ({ cursor, field, itemId: requestItemId, threadId: requestThreadId }) =>
        requestTranscriptEntryDetail(requestThreadId, requestItemId, { cursor, field }),
      threadId,
    });
  }

  const fetchRawTranscriptPage = async ({ threadId, before }) => {
    const url = new URL(
      `/api/threads/${encodeURIComponent(threadId)}/transcript`,
      window.location.origin
    );
    if (before != null) {
      url.searchParams.set("before", String(before));
    }

    const response = await apiFetch(url);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load transcript history");
    }

    return normalizeThreadTranscriptPage(payload.data);
  };

  // Same older-page disk cache the remote surface uses: older pages
  // (before != null) are served from IndexedDB before hitting the relay, so
  // scroll-up / thread-switch / reload don't pay a fresh relay round trip (and,
  // for non-active threads, a full provider read_thread re-parse) on every page.
  // The live tail (before == null) always goes to the network — see
  // shared/caching-transcript-fetcher.js for the policy and the streaming red line.
  const fetchCachedTranscriptPage = createCachingTranscriptPageFetcher({
    cache: localTranscriptPageCache,
    fetchPage: fetchRawTranscriptPage,
    getScope: () => "local",
  });

  async function fetchTranscriptPage(threadId, { before = null } = {}) {
    if (!queryClient) {
      return fetchCachedTranscriptPage({ threadId, before });
    }

    return queryClient.fetchQuery(
      createThreadTranscriptPageQueryOptions({
        before,
        fetchPage: fetchCachedTranscriptPage,
        scope: "local",
        surface: "local",
        threadId,
      })
    );
  }

  async function ensureConversationTranscript(session = state.session) {
    if (!session?.active_thread_id || !isViewingConversation(session)) {
      return;
    }

    return hydrateLocalTranscript(state, session, {
      fetchPage: ({ threadId, before }) => fetchTranscriptPage(threadId, { before }),
      onProgress(hydratedSnapshot) {
        renderSession(hydratedSnapshot);
      },
      onError(error) {
        if (state.session) {
          renderSession(restoreHydratedTranscript(state, state.session));
        }
        logLine(`Transcript sync failed: ${error.message}`);
      },
    });
  }

  async function maybeLoadOlderTranscript() {
    // The IntersectionObserver in app.js gates *when* this is called (sentinel
    // approaches the top edge with a 600px rootMargin), so we no longer
    // hand-roll a scrollTop threshold here — the observer's `rootMargin` is
    // already the prefetch trigger. We still bail when there's nothing to
    // load, no active thread, or the user has navigated away.
    if (
      !transcript ||
      !state.session?.active_thread_id ||
      !isViewingConversation(state.session) ||
      state.transcriptHydrationOlderCursor == null
    ) {
      return;
    }

    state.transcriptPreserveScroll = true;

    return loadOlderLocalTranscript(state, {
      fetchPage: ({ threadId, before }) => fetchTranscriptPage(threadId, { before }),
      onProgress(hydratedSnapshot) {
        renderSession(hydratedSnapshot);
        state.transcriptPreserveScroll = false;
      },
      onError(error) {
        state.transcriptPreserveScroll = false;
        if (state.session) {
          renderSession(restoreHydratedTranscript(state, state.session));
        }
        logLine(`Older transcript load failed: ${error.message}`);
      },
    });
  }

  function resetTranscriptHydrationState() {
    clearTranscriptHydration(state);
    state.transcriptPreserveScroll = false;
    state.localTranscriptScrollSnapshot = null;
    state.localTranscriptScrollPositions?.clear?.();
    state.localTranscriptScrollAnchors?.clear?.();
  }

  function toggleTranscriptExpandKey(expandKey) {
    if (!expandKey) {
      return;
    }
    state.localUiStore.getState().toggleTranscriptExpandedItem(expandKey);
    if (state.session) {
      renderSession(state.session);
    }
  }

  // In a read-only view-only projection the displayed transcript is the PINNED
  // thread (state.viewOnlyThread), not the relay's live active thread. Detail
  // expansion / file-diff loading must resolve and fetch against THAT thread —
  // otherwise they query the active thread, the viewed thread's details never
  // load, and an item-id collision could surface another thread's detail.
  function displayedThreadId() {
    return state.viewOnlyThread?.threadId || state.session?.active_thread_id || null;
  }
  function displayedEntries() {
    const pin = state.viewOnlyThread;
    if (pin) {
      return pin.entries || [];
    }
    return restoreHydratedTranscript(state, state.session)?.transcript || [];
  }

  async function toggleTranscriptEntry(itemId) {
    if (!itemId) {
      return;
    }
    const expandKey = `entry:${itemId}`;
    state.localUiStore.getState().toggleTranscriptExpandedItem(expandKey);
    if (state.session) {
      renderSession(state.session);
    }

    const localUi = readLocalUiState(state.localUiStore);
    const threadId = displayedThreadId();
    if (
      !localUi.transcriptExpandedItemIds.has(expandKey)
      || !threadId
      || getCachedTranscriptEntryDetail(state, threadId, itemId)
      || getLiveTranscriptEntryDetail(state, threadId, itemId)
      || localUi.transcriptLoadingItemIds.has(itemId)
    ) {
      return;
    }

    const entry = displayedEntries().find((candidate) => candidate?.item_id === itemId);
    if (!entry || (entry.kind !== "tool_call" && entry.kind !== "command")) {
      return;
    }

    state.localUiStore.getState().startTranscriptDetailLoading(itemId);
    renderSession(state.session);

    try {
      const detail = await fetchTranscriptEntryDetail(threadId, itemId);
      if (!detail || displayedThreadId() !== threadId) {
        return;
      }
      const { cached } = cacheTranscriptEntryDetail(state, threadId, detail);
      if (!cached) {
        setLiveTranscriptEntryDetail(state, threadId, detail);
      }
    } catch (error) {
      logLine(`Transcript detail load failed: ${error.message}`);
    } finally {
      state.localUiStore.getState().finishTranscriptDetailLoading(itemId);
      if (state.session) {
        renderSession(state.session);
      }
    }
  }

  // Opening an individual file section calls this to pull omitted diff bodies.
  // The fetch remains idempotent across repeated open/close interactions.
  async function ensureFileChangeDetail(itemId) {
    const threadId = displayedThreadId();
    if (!itemId || !threadId) {
      return;
    }
    const localUi = readLocalUiState(state.localUiStore);
    // Skip only when we already hold the FULL detail — a stripped summary parked
    // in the live store (running turnDiff) must not block the fetch.
    const cached = getCachedTranscriptEntryDetail(state, threadId, itemId);
    const live = getLiveTranscriptEntryDetail(state, threadId, itemId);
    const hasFullDetail =
      (cached && !isOmittedFileChangeDetail(cached))
      || (live && !isOmittedFileChangeDetail(live));
    if (hasFullDetail || localUi.transcriptLoadingItemIds.has(itemId)) {
      return;
    }

    state.localUiStore.getState().startTranscriptDetailLoading(itemId);
    if (state.session) {
      renderSession(state.session);
    }
    try {
      const detail = await fetchTranscriptEntryDetail(threadId, itemId);
      if (!detail || displayedThreadId() !== threadId) {
        return;
      }
      const { cached } = cacheTranscriptEntryDetail(state, threadId, detail);
      if (!cached) {
        setLiveTranscriptEntryDetail(state, threadId, detail);
      }
    } catch (error) {
      logLine(`File change diff load failed: ${error.message}`);
    } finally {
      state.localUiStore.getState().finishTranscriptDetailLoading(itemId);
      if (state.session) {
        renderSession(state.session);
      }
    }
  }

  async function applyFileChange(itemId, direction) {
    if (!itemId) {
      logLine("No file change selected.");
      return;
    }

    logLine(`${direction === "rollback" ? "Rolling back" : "Reapplying"} file change ${itemId}`);

    try {
      const response = await apiFetch(`/api/file-changes/${encodeURIComponent(itemId)}/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          direction,
          device_id: state.deviceId,
          thread_id: state.viewOnlyThread?.threadId || state.session?.active_thread_id,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message || "File change action failed");
      }

      logLine(payload.data.message);
      await loadSession("post-file-change action");
    } catch (error) {
      logLine(`File change action failed: ${error.message}`);
    }
  }

  return {
    requestTranscriptEntryDetail,
    fetchTranscriptEntryDetail,
    fetchTranscriptPage,
    ensureConversationTranscript,
    maybeLoadOlderTranscript,
    resetTranscriptHydrationState,
    toggleTranscriptExpandKey,
    toggleTranscriptEntry,
    ensureFileChangeDetail,
    applyFileChange,
  };
}
