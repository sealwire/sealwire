import { transcriptPageIsFromAnotherGeneration } from "../shared/transcript-generation.js";
import { threadActivityFor } from "../shared/thread-activity.js";
import { shouldRefreshViewedThread } from "../shared/viewed-thread-refresh.js";
import { refreshedPinPage } from "./pin-page.js";
import {
  mergeOlderViewOnlyPage,
  resolveViewOnlyPinWasWorking,
  resolveViewOnlyPinWasWorkingAfterFetch,
} from "./view-only-thread.js";

/**
 * Should the Tasks Orchestrator pane refetch its transcript page?
 *
 * Mirrors the view-only pin policy with two Orchestrator-specific guards:
 * - A delta-raised `orchestratorWasWorking` must survive `thread_activity` that
 *   omits the Orchestrator, but must not be mistaken for an observed idle edge
 *   on the first render after the delta lands.
 * - A refused delta's `orchestratorTailGap` must not wait behind an ordinary
 *   page load, but only one tail-gap repair may be in flight at a time.
 */
export function orchestratorTranscriptRefreshDecision(state, session, orchId) {
  const orchIsActive = Boolean(orchId && session?.active_thread_id === orchId);
  const orchWorking = Boolean(threadActivityFor(session, orchId).phase);
  if (!orchId || orchIsActive) {
    return { refresh: false, defer: false, terminal: false, repair: false, orchWorking };
  }

  const lastActivityWorking = Boolean(state.orchestratorLastActivityWorking);
  const activityIdleEdge = lastActivityWorking && !orchWorking;
  const suppressDeltaTerminal =
    Boolean(state.orchestratorDeltaRaisedWorking)
    && !lastActivityWorking
    && !orchWorking;

  const tailGap = Boolean(state.orchestratorTailGap);
  const tailGapRepairing = Boolean(state.orchestratorTailGapRepairing);
  const needsTailGapRepair = tailGap && !tailGapRepairing;

  const terminalRefresh =
    !suppressDeltaTerminal
    && shouldRefreshViewedThread({
      elapsedMs: Date.now() - (state.orchestratorLastRefreshAt || 0),
      loading: Boolean(state.orchestratorEntriesLoading),
      needsRepair: false,
      wasWorking: activityIdleEdge || Boolean(state.orchestratorWasWorking),
      working: orchWorking,
    });

  // An older-history fetch validates its page against `orchestratorLoadGeneration`,
  // and every load bumps that counter — so a refresh firing mid-flight throws the
  // page away, and the sentinel that asked for it has already backed off. Defer
  // instead; the history request hands the decision back when it settles. This
  // cannot live in `shouldRefreshViewedThread`: it takes a `historyLoading`
  // argument and never reads it.
  const wanted = needsTailGapRepair || terminalRefresh;
  const defer = wanted && Boolean(state.orchestratorOlderLoading);
  const refresh = wanted && !defer;
  return {
    refresh,
    defer,
    terminal: refresh && terminalRefresh && !needsTailGapRepair,
    repair: refresh && needsTailGapRepair,
    orchWorking,
  };
}

// Only re-run the deferred decision if the pane is still showing the thread that
// deferred it; a thread switch in the meantime makes it someone else's decision.
export function takeDeferredOrchestratorRefresh(state, latch) {
  const threadId = latch.take();
  return threadId && state.orchestratorEntriesThreadId === threadId ? threadId : null;
}

export function nextOrchestratorWasWorking(state, orchWorking) {
  return resolveViewOnlyPinWasWorking({
    prior: { wasWorking: state.orchestratorWasWorking },
    isWorking: orchWorking,
  });
}

export function nextOrchestratorRefreshObservations(state, orchWorking) {
  return {
    orchestratorLastActivityWorking: orchWorking,
    orchestratorDeltaRaisedWorking: false,
  };
}

export function orchestratorWasWorkingAfterFetch(state, session, threadId, { terminal = false } = {}) {
  const isWorking = Boolean(threadActivityFor(session, threadId).phase);
  return resolveViewOnlyPinWasWorkingAfterFetch({
    prior: {
      wasWorking: state.orchestratorWasWorking,
      deltaDuringFetch: state.orchestratorDeltaDuringFetch,
    },
    isWorking,
    terminal,
  });
}

/**
 * Take the flags a load owns, and answer with its generation.
 *
 * The mirror of `applyOrchestratorLoadFinally` below, and deliberately in the
 * same file: `orchestratorTailGapRepairing` has exactly one release, and it runs
 * in the loader's `finally`. Set from anywhere that can return before the `try`
 * — the call site used to — and the latch stays true for the life of the page,
 * which makes `needsTailGapRepair` false forever and strands every later gap.
 *
 * The generation is a counter, not a thread-id compare: two loads for the SAME
 * thread both pass an id check, and then whichever resolves last wins even when
 * it is the older request.
 */
export function beginOrchestratorLoad(state, { repair = false } = {}) {
  state.orchestratorEntriesLoading = true;
  if (repair) {
    state.orchestratorTailGapRepairing = true;
  }
  return (state.orchestratorLoadGeneration = (state.orchestratorLoadGeneration || 0) + 1);
}

/**
 * Settle the flags a completed load owns, success or failure alike.
 *
 * Both answers below read `orchestratorDeltaDuringFetch`, so both are resolved
 * BEFORE any flag is cleared — clearing first made
 * `orchestratorWasWorkingAfterFetch` read its own erasure.
 *
 * The tail gap is settled here and nowhere else. The loader's success branch
 * cannot answer it: the page it merged was built on the server, so a delta the
 * reducer refused after that point is a hole the page never covered. Same rule
 * the view-only pin applies (view-only-refresh-ops.js:139-142) — keep the gap
 * only when this fetch was in flight for the refusal, otherwise clear it, since
 * an uncleared gap re-fetches on every frame (there is no throttle).
 */
export function applyOrchestratorLoadFinally(state, generation, threadId, session, { terminal = false } = {}) {
  if (generation !== state.orchestratorLoadGeneration) {
    return false;
  }
  const wasWorking = orchestratorWasWorkingAfterFetch(state, session, threadId, { terminal });
  const tailGap = Boolean(state.orchestratorTailGap) && Boolean(state.orchestratorDeltaDuringFetch);
  state.orchestratorEntriesLoading = false;
  state.orchestratorTailGapRepairing = false;
  state.orchestratorDeltaDuringFetch = false;
  state.orchestratorTailGap = tailGap;
  state.orchestratorWasWorking = wasWorking;
  return true;
}

// The entries a load owns, the mirror of the flags above. Here rather than
// inline in the render module, which cannot be imported without a browser.

// Null when the pane holds another thread's entries: merging a page into those
// splices two conversations together under one header.
export function orchestratorRefreshPin(state, threadId) {
  if (state.orchestratorEntriesThreadId !== threadId) {
    return null;
  }
  return {
    threadId,
    entries: state.orchestratorEntries || [],
    olderCursor: state.orchestratorOlderCursor ?? null,
    // Without this the merge reads "nobody scrolled up" and answers with the
    // tail page alone, discarding the history the reader just paged in.
    historyExtended: Boolean(state.orchestratorHistoryExtended),
  };
}

// Split from the pin above because the caller takes the pin before its fetch and
// applies the result after it.
export function applyRefreshedOrchestratorPage(state, prior, page, threadId) {
  const refreshed = refreshedPinPage(prior, page, threadId);
  state.orchestratorEntries = refreshed.entries;
  state.orchestratorOlderCursor = refreshed.olderCursor;
  state.orchestratorHistoryExtended = refreshed.historyExtended;
  state.orchestratorEntriesThreadId = threadId;
  // These entries are only mergeable by the run whose ids they carry. Stamped on
  // every write, so a later delta or older page can tell whether it belongs.
  state.orchestratorEntriesGeneration = state.session?.transcript_generation || "";
  return refreshed;
}

export function applyOlderOrchestratorPage(state, threadId, page) {
  // The buffer this prepends to belongs to the run that minted its ids; a page from
  // another run prepends a second copy of every message it overlaps.
  if (
    (state.orchestratorEntriesGeneration || "")
    !== (state.session?.transcript_generation || "")
    || transcriptPageIsFromAnotherGeneration(state.session, page)
  ) {
    return null;
  }
  const merged = mergeOlderViewOnlyPage(
    {
      threadId,
      entries: state.orchestratorEntries || [],
      olderCursor: state.orchestratorOlderCursor,
      // A page the merge declines comes back as this object verbatim, so a field
      // left off here is a field the ignored page silently clears.
      historyExtended: Boolean(state.orchestratorHistoryExtended),
    },
    page
  );
  state.orchestratorEntries = merged.entries;
  state.orchestratorOlderCursor = merged.olderCursor;
  state.orchestratorHistoryExtended = merged.historyExtended;
  return merged;
}
