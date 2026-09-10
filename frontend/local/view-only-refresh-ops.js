import { transcriptPageIsFromAnotherGeneration } from "../shared/transcript-generation.js";
import { refreshedPinPage } from "./pin-page.js";
import {
  buildViewOnlyPin,
  mergeOlderViewOnlyPage,
  resolveViewOnlyPinWasWorking,
  resolveViewOnlyPinWasWorkingAfterFetch,
  viewOnlyEligible,
  viewOnlyPinNextAction,
  viewOnlySelfHealThreadId,
  viewOnlyThreadIsWorking,
} from "./view-only-thread.js";
import {
  createViewedThreadRefreshLatch,
  shouldRefreshViewedThread,
} from "../shared/viewed-thread-refresh.js";

function pinForGeneration(state, threadId, generation, fallback = null) {
  const pin = state.viewOnlyThread;
  if (pin?.threadId === threadId && pin?.generation === generation) {
    return pin;
  }
  return fallback;
}

export function createViewOnlyRefreshOps({
  getState,
  fetchTranscriptPage,
  renderSession,
  logLine = () => {},
  findVisible = () => null,
  reviewSignature = () => null,
  syncWatchedThreads = () => {},
  getOrchestratorWatchIds = () => [],
  isReviewInProgressForThread = () => false,
  isWorkflowInProgressForThread = () => false,
}) {
  let viewOnlyOlderLoading = false;
  const viewOnlyRefreshLatch = createViewedThreadRefreshLatch();

  async function loadViewOnlyTranscript(threadId, { terminal = false } = {}) {
    const state = getState();
    const session = state.session;
    if (!viewOnlyEligible(session, threadId)) {
      if (state.viewOnlyThread) {
        state.viewOnlyThread = null;
        if (state.session) renderSession(state.session);
      }
      return;
    }

    const review = isReviewInProgressForThread(session, threadId);
    const workflowLocked = isWorkflowInProgressForThread(session, threadId);
    const generation = (state.viewOnlyGeneration = (state.viewOnlyGeneration || 0) + 1);
    const reviewSig = review ? reviewSignature(session, threadId) : null;
    const summary = findVisible(threadId);
    const cwd = summary?.cwd ?? null;
    const provider = summary?.provider ?? null;
    const liveGeneration = session?.transcript_generation || "";
    const sameThreadPin =
      state.viewOnlyThread?.threadId === threadId ? state.viewOnlyThread : null;
    // A pin from another run of the relay is not a starting point to refresh FROM: its
    // ids name these messages differently, so carrying its entries forward under this
    // run's label is just relabelling stale data. Drop it and load the thread cold.
    const prior =
      sameThreadPin && (sameThreadPin.relayGeneration || "") !== liveGeneration
        ? null
        : sameThreadPin;
    const isWorking = viewOnlyThreadIsWorking(session, threadId);
    const status = !isWorking && prior?.wasWorking ? "idle" : summary?.status ?? null;
    const loadingPin = buildViewOnlyPin({
      relayGeneration: liveGeneration,
      threadId,
      generation,
      review,
      workflowLocked,
      reviewSig,
      cwd,
      threadWorkspaceCwd: prior?.threadWorkspaceCwd ?? null,
      provider,
      status,
      activeTurnId: prior?.activeTurnId || null,
      currentStatus: prior?.currentStatus || null,
      currentPhase: prior?.currentPhase || null,
      currentTool: prior?.currentTool || null,
      lastProgressAt: prior?.lastProgressAt ?? null,
      settings: prior?.settings || null,
      settingsWritable: Boolean(prior?.settingsWritable),
      availableModels: prior?.availableModels || [],
      lastRefreshAt: Date.now(),
      lastRefreshServerTime: prior?.lastRefreshServerTime ?? null,
      wasWorking: resolveViewOnlyPinWasWorking({ prior, isWorking }),
      priorEntries: prior?.entries || [],
      priorOlderCursor: prior?.olderCursor ?? null,
      historyExtended: Boolean(prior?.historyExtended),
      loading: true,
    });
    state.viewOnlyThread = prior?.tailGap ? { ...loadingPin, tailGap: true } : loadingPin;
    if (state.session) renderSession(state.session);

    try {
      const page = await fetchTranscriptPage(threadId, {});
      if (generation !== state.viewOnlyGeneration) return;
      if (transcriptPageIsFromAnotherGeneration(session, page)) {
        // The relay restarted mid-fetch: these ids are from the previous run. Settle
        // through the error path rather than returning — a bare return leaves
        // `loading: true`, and the self-heal reads that as "a request is still in
        // flight" and refuses to retry, so the pin would stay blank for good.
        throw new Error("transcript page came from another relay generation");
      }
      const livePin = pinForGeneration(state, threadId, generation, prior);
      const { page: normalized, ...refreshed } = refreshedPinPage(livePin, page, threadId);
      const exactReview = Boolean(normalized.thread_state?.review_locked ?? review);
      const isWorkingNow = viewOnlyThreadIsWorking(session, threadId);
      const built = buildViewOnlyPin({
        relayGeneration: liveGeneration,
        threadId,
        page: {
          ...normalized,
          entries: refreshed.entries,
          prev_cursor: refreshed.olderCursor,
        },
        generation,
        review: exactReview,
        workflowLocked: Boolean(normalized.thread_state?.workflow_locked ?? workflowLocked),
        reviewSig: exactReview ? reviewSignature(session, threadId) : reviewSig,
        cwd: normalized.thread_state?.current_cwd ?? cwd,
        threadWorkspaceCwd:
          normalized.thread_state?.thread_workspace_cwd
          ?? livePin?.threadWorkspaceCwd
          ?? null,
        provider: normalized.thread_state?.provider ?? provider,
        status,
        activeTurnId: normalized.thread_state?.active_turn_id || null,
        currentStatus: normalized.thread_state?.current_status || null,
        currentPhase: normalized.thread_state?.current_phase || null,
        currentTool: normalized.thread_state?.current_tool || null,
        lastProgressAt: normalized.thread_state?.last_progress_at ?? null,
        settings: normalized.thread_state
          ? {
            approval_policy: normalized.thread_state.approval_policy || "",
            sandbox: normalized.thread_state.sandbox || "",
            reasoning_effort: normalized.thread_state.reasoning_effort || "",
            model: normalized.thread_state.model || "",
          }
          : null,
        settingsWritable: Boolean(normalized.thread_state?.settings_writable),
        taskReviewer: Boolean(normalized.thread_state?.task_reviewer),
        availableModels: normalized.thread_state?.available_models || [],
        lastRefreshAt: Date.now(),
        lastRefreshServerTime: normalized.server_time ?? null,
        wasWorking: resolveViewOnlyPinWasWorkingAfterFetch({
          prior: livePin,
          isWorking: isWorkingNow,
          terminal,
        }),
        historyExtended: refreshed.historyExtended,
      });
      state.viewOnlyThread =
        livePin?.tailGap && livePin?.deltaDuringFetch
          ? { ...built, tailGap: true }
          : built;
    } catch (error) {
      if (generation !== state.viewOnlyGeneration) return;
      const livePin = pinForGeneration(state, threadId, generation, prior);
      const isWorkingNow = viewOnlyThreadIsWorking(session, threadId);
      const built = buildViewOnlyPin({
        relayGeneration: liveGeneration,
        threadId,
        generation,
        review,
        workflowLocked,
        reviewSig,
        cwd,
        threadWorkspaceCwd: livePin?.threadWorkspaceCwd ?? null,
        provider,
        status,
        activeTurnId: livePin?.activeTurnId || null,
        currentStatus: livePin?.currentStatus || null,
        currentPhase: livePin?.currentPhase || null,
        currentTool: livePin?.currentTool || null,
        lastProgressAt: livePin?.lastProgressAt ?? null,
        settings: livePin?.settings || null,
        settingsWritable: Boolean(livePin?.settingsWritable),
        availableModels: livePin?.availableModels || [],
        lastRefreshAt: Date.now(),
        lastRefreshServerTime: livePin?.lastRefreshServerTime ?? null,
        wasWorking: resolveViewOnlyPinWasWorkingAfterFetch({
          prior: livePin,
          isWorking: isWorkingNow,
          terminal,
        }),
        priorEntries: livePin?.entries || [],
        priorOlderCursor: livePin?.olderCursor ?? null,
        historyExtended: Boolean(livePin?.historyExtended),
        error: true,
      });
      state.viewOnlyThread =
        livePin?.tailGap && livePin?.deltaDuringFetch
          ? { ...built, tailGap: true }
          : built;
      logLine(`Couldn't load the read-only session view: ${error.message}`);
    }
    if (state.session) renderSession(state.session);
  }

  function maybeRefreshViewOnly(session) {
    const state = getState();
    void syncWatchedThreads(session, state.viewThreadId, getOrchestratorWatchIds());
    const pin = state.viewOnlyThread;
    if (pin && session) {
      const action = viewOnlyPinNextAction(session, pin, {
        viewThreadId: state.viewThreadId,
        reviewSignature,
      });
      if (action.kind === "release") {
        state.viewOnlyThread = null;
      } else if (action.kind === "refresh") {
        void loadViewOnlyTranscript(pin.threadId);
      } else {
        const working = viewOnlyThreadIsWorking(session, pin.threadId);
        if (shouldRefreshViewedThread({
          elapsedMs: Date.now() - (pin.lastRefreshAt || 0),
          historyLoading: viewOnlyOlderLoading,
          loading: pin.loading,
          needsRepair: Boolean(pin.tailGap),
          wasWorking: pin.wasWorking,
          working,
        })) {
          if (viewOnlyOlderLoading) {
            viewOnlyRefreshLatch.defer(pin.threadId);
          } else {
            void loadViewOnlyTranscript(pin.threadId, { terminal: true });
          }
        }
      }
    }

    const metaPin = state.viewOnlyThread;
    if (metaPin && (metaPin.cwd == null || metaPin.provider == null)) {
      const summary = findVisible(metaPin.threadId);
      if (summary && (summary.cwd != null || summary.provider != null)) {
        state.viewOnlyThread = {
          ...metaPin,
          cwd: metaPin.cwd ?? summary.cwd ?? null,
          provider: metaPin.provider ?? summary.provider ?? null,
        };
      }
    }

    const selfHeal = viewOnlySelfHealThreadId(session, {
      viewThreadId: state.viewThreadId,
      viewOnlyThread: state.viewOnlyThread,
      now: Date.now(),
    });
    if (selfHeal) {
      void loadViewOnlyTranscript(selfHeal);
    }
  }

  async function loadOlderViewOnlyTranscript() {
    const state = getState();
    const pin = state.viewOnlyThread;
    if (!pin || state.viewThreadId !== pin.threadId) {
      return null;
    }
    if (pin.olderCursor == null) {
      return false;
    }
    if (pin.loading || viewOnlyOlderLoading) {
      return null;
    }
    const generation = pin.generation;
    viewOnlyOlderLoading = true;
    try {
      const page = await fetchTranscriptPage(pin.threadId, { before: pin.olderCursor });
      const current = state.viewOnlyThread;
      if (!current || current.generation !== generation || current.threadId !== pin.threadId) {
        return null;
      }
      // `mergeOlderViewOnlyPage` dedupes by item id alone, so it cannot tell that a
      // page and a pin describe the same messages under two runs' names — it just
      // prepends. Both sides have to be from the live run: the pin (the relay may have
      // restarted since it was built) and the page (it may have been answered by the
      // new run before this client saw its first snapshot).
      const liveGeneration = state.session?.transcript_generation || "";
      if (
        (current.relayGeneration || "") !== liveGeneration
        || transcriptPageIsFromAnotherGeneration(state.session, page)
      ) {
        return null;
      }
      state.viewOnlyThread = mergeOlderViewOnlyPage(current, page);
      if (state.session) renderSession(state.session);
      return state.viewOnlyThread?.olderCursor != null;
    } catch (error) {
      logLine(`Couldn't load older messages for the read-only view: ${error.message}`);
      return null;
    } finally {
      viewOnlyOlderLoading = false;
      const deferredThreadId = viewOnlyRefreshLatch.take();
      if (
        deferredThreadId
        && state.viewThreadId === deferredThreadId
        && state.viewOnlyThread?.threadId === deferredThreadId
      ) {
        maybeRefreshViewOnly(state.session);
      }
    }
  }

  return {
    maybeRefreshViewOnly,
    loadViewOnlyTranscript,
    loadOlderViewOnlyTranscript,
  };
}
