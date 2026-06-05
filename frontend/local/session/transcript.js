import { transcript } from "../dom.js";
import { fetchTranscriptEntryDetailViaRequester } from "../../shared/transcript-entry-detail.js";
import { normalizeThreadTranscriptPage } from "../../shared/transcript-page.js";
import { createThreadTranscriptPageQueryOptions } from "../../shared/thread-queries.js";
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

  async function fetchTranscriptPage(threadId, { before = null } = {}) {
    const fetchPage = async () => {
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

    if (!queryClient) {
      return fetchPage();
    }

    return queryClient.fetchQuery(
      createThreadTranscriptPageQueryOptions({
        before,
        fetchPage,
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
    if (
      !localUi.transcriptExpandedItemIds.has(expandKey)
      || !state.session?.active_thread_id
      || getCachedTranscriptEntryDetail(state, state.session.active_thread_id, itemId)
      || getLiveTranscriptEntryDetail(state, state.session.active_thread_id, itemId)
      || localUi.transcriptLoadingItemIds.has(itemId)
    ) {
      return;
    }

    const snapshot = restoreHydratedTranscript(state, state.session);
    const entry = (snapshot?.transcript || []).find((candidate) => candidate?.item_id === itemId);
    if (!entry || (entry.kind !== "tool_call" && entry.kind !== "command")) {
      return;
    }

    state.localUiStore.getState().startTranscriptDetailLoading(itemId);
    renderSession(state.session);

    try {
      const detailThreadId = state.session.active_thread_id;
      const detail = await fetchTranscriptEntryDetail(detailThreadId, itemId);
      if (!detail || state.session?.active_thread_id !== detailThreadId) {
        return;
      }
      const { cached } = cacheTranscriptEntryDetail(state, detailThreadId, detail);
      if (!cached) {
        setLiveTranscriptEntryDetail(state, detailThreadId, detail);
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

  // File-change entries render diffs inline and have no expand control, so when
  // the snapshot only carries the file-change summary (file_changes_omitted) the
  // shared renderer calls this to pull the full diffs on demand. Idempotent.
  async function ensureFileChangeDetail(itemId) {
    if (!itemId || !state.session?.active_thread_id) {
      return;
    }
    const threadId = state.session.active_thread_id;
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
      if (!detail || state.session?.active_thread_id !== threadId) {
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
