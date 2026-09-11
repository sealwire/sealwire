import { transcriptPageIsFromAnotherGeneration } from "../shared/transcript-generation.js";
import {
  dispatchOrRecover,
  dispatchRemoteActionWithoutReply,
  scheduleClaimRefresh,
} from "./actions.js";
import {
  isCurrentDeviceActiveController,
  isVerboseBrokerLoggingEnabled,
  renderLog,
  renderSession,
} from "./session-surface.js";
import {
  patchRemoteState,
  state,
} from "./state.js";
import {
  appendTranscriptDelta as appendTranscriptDeltaToWindow,
  applyEntryPatchToWindow,
  clearTranscriptHydration,
  invalidateTranscriptWindowForRepair,
  restoreHydratedTranscript,
  switchTranscriptHydrationThread,
  transcriptWindowIsLoaded,
} from "./transcript/store.js";
import {
  adoptSettledTranscript,
  markTranscriptWindowProjectionPending,
  settleTranscriptProjection as settlePendingTranscriptProjection,
} from "../shared/transcript-projection.js";
import {
  hydrateRemoteTranscript,
  loadOlderRemoteTranscript,
} from "./transcript/hydration.js";
import {
  createTranscriptEntryDetailFetcher,
  createTranscriptPageFetcher,
} from "./transcript/api.js";
import { transcriptPageCache } from "./transcript/page-cache-instance.js";
import {
  dispatchWorkspaceRepair,
  readWorkspaceRepair,
  setWorkspaceRepairError,
  setWorkspaceRepairPending,
  workspaceRepairResolved,
} from "./workspace-repair.js";
import { withThreadError } from "../shared/composer-errors.js";
import { createCachingTranscriptPageFetcher } from "../shared/caching-transcript-fetcher.js";
import { providerLabel } from "../shared/provider-labels.js";
import {
  createThreadListQueryOptions,
  createThreadTranscriptPageQueryOptions,
  dropTranscriptPageQueriesFromOtherGenerations,
  fetchThreadListFresh,
} from "../shared/thread-queries.js";
import {
  syncLiveTranscriptEntryDetailsFromSnapshot,
} from "./transcript/details.js";
import { remoteQueryClient } from "./query-client.js";
import { remoteUiRefs } from "./ui-refs.js";
import {
  applyRemoteSurfacePatch,
  createRemoteThreadSearchPatch,
  createRemoteThreadsPatch,
} from "./surface-state.js";
import { isReviewInProgressForThread } from "../shared/review-state.js";
import {
  detectDeferredThreadPromotion,
  shouldRebindPinnedViewOnPromotion,
} from "../shared/thread-promotion.js";
import { resolveOutgoingEffort } from "../shared/reasoning-efforts.js";
import { buildNavigationThreadGroups } from "../shared/thread-groups.js";
import {
  EMPTY_THREAD_SEARCH,
  normalizeThreadSearchQuery,
} from "../shared/thread-search.js";
import { threadAttention } from "../shared/thread-attention.js";
import { forkFieldsToPayload } from "../shared/fork-fields.js";
import { isDocumentForeground, notifyThreadEvents } from "../shared/thread-notify.js";
import { shouldRefreshViewedThread } from "../shared/viewed-thread-refresh.js";
import {
  resolveViewOnlyPinWasWorking,
  resolveViewOnlyPinWasWorkingAfterFetch,
  viewOnlyThreadIsWorking,
} from "../local/view-only-thread.js";
import { sessionViewedWorkspaceKey } from "../shared/viewed-workspace-key.js";
import { createTranscriptFlushScheduler } from "../shared/transcript-flush-scheduler.js";
import {
  selectDisplayedSession,
  serverTimeSeconds,
} from "../shared/session-view-model.js";
import {
  numericRevision,
  reduceTranscriptDeltaEvent,
  reduceTranscriptEntryPatchEvent,
} from "../shared/transcript-event-reducer.js";
import { reconcileAuthoritativeTail } from "../shared/authoritative-tail-merge.js";
import { preserveVisibleTranscriptText } from "../shared/preserve-visible-transcript-text.js";
import { reviewerPreviewEntriesFromPage } from "../shared/reviewer-panel.js";

const fetchTranscriptPageOverBroker = createTranscriptPageFetcher(dispatchOrRecover);
const fetchRawTranscriptPage = fetchTranscriptPageOverBroker;
const fetchTranscriptEntryDetailRequest =
  createTranscriptEntryDetailFetcher(dispatchOrRecover, {
    // Checked per response: the chunk loop can span a relay restart.
    currentGeneration: () => state.session?.transcript_generation || "",
  });

// Persistent, encrypted-at-rest cache for OLDER transcript history pages. Only
// append-stable older pages (before != null) are cached; the live tail always
// hits the network. This makes scroll-up history loads and post-reload backfill
// resolve from disk instead of a per-page network round trip. See
// shared/caching-transcript-fetcher.js for the policy and the streaming red line.
const fetchCachedTranscriptPage = createCachingTranscriptPageFetcher({
  cache: transcriptPageCache,
  fetchPage: fetchRawTranscriptPage,
  getScope: remoteQueryScope,
  // Pages belong to the relay process that minted their item ids: a restart
  // rebuilds threads from provider history and renumbers them. NOT folded into
  // `scope` — that is the relay identity `clearScope` indexes on, and forgetting a
  // relay has to wipe every generation of its cached history.
  getGeneration: () => (state.realSession || state.session)?.transcript_generation || "",
});

// Client-local viewed thread. The relay's live/control snapshot is retained in
// state.realSession while state.session is the rendered projection.
let viewOnlyThreadId = null;
// Which run of the relay minted the ids in the currently pinned view-only transcript.
let viewOnlyRelayGeneration = "";
let viewOnlyNavigationGeneration = 0;
let viewOnlyRefreshInFlight = false;
let viewOnlyLastRefreshAt = 0;
let viewOnlyWasWorking = false;
let viewOnlyDeltaDuringTerminalRefresh = false;
// Last thread-watch set declared to the relay, so a snapshot that changes nothing about
// what is on screen does not become an outbound frame.
let lastDeclaredWatchKey = null;

function remoteViewedThreadIsWorking(threadId, session = state.realSession) {
  return viewOnlyThreadIsWorking(session, threadId);
}

function seedViewOnlyWasWorking(threadId, session = state.realSession) {
  viewOnlyWasWorking = remoteViewedThreadIsWorking(threadId, session);
}

function preserveViewOnlyWasWorkingAfterTerminalFetch(threadId, session = state.realSession) {
  const latchedDuringFetch = viewOnlyDeltaDuringTerminalRefresh;
  viewOnlyDeltaDuringTerminalRefresh = false;
  viewOnlyWasWorking = latchedDuringFetch
    ? resolveViewOnlyPinWasWorking({
        prior: { wasWorking: viewOnlyWasWorking },
        isWorking: remoteViewedThreadIsWorking(threadId, session),
      })
    : resolveViewOnlyPinWasWorkingAfterFetch({
        prior: { wasWorking: viewOnlyWasWorking },
        isWorking: remoteViewedThreadIsWorking(threadId, session),
        terminal: true,
      });
}

function latchViewOnlyWasWorkingFromDelta(threadId) {
  if (viewOnlyThreadId && threadId === viewOnlyThreadId) {
    viewOnlyWasWorking = resolveViewOnlyPinWasWorking({
      prior: { wasWorking: viewOnlyWasWorking },
      isWorking: true,
    });
    if (viewOnlyRefreshInFlight) {
      viewOnlyDeltaDuringTerminalRefresh = true;
    }
  }
}
const transcriptFlushScheduler = createTranscriptFlushScheduler({
  render() {
    settleTranscriptProjection();
    if (state.session) {
      renderSession(state.session);
    }
  },
});

export function flushRemoteTranscriptRenderForTest() {
  transcriptFlushScheduler.flushNow("test");
}

// Deferred window→array projection — see ../shared/transcript-projection.js
// for the algorithm, shared with local (which has one session slot; remote
// has two — see below). Appending a delta to the loaded window
// (appendTranscriptDeltaToWindow) is an O(1) Map write; projecting it back
// onto the rendered array (renderedTranscriptFromWindow) is O(n) in the
// loaded window, so THAT step is deferred: a windowed delta only raises the
// pending flag (markTranscriptWindowProjectionPending), and
// settleTranscriptProjection below does the actual rebuild, once, whenever it
// is next called.

// Counts actual array rebuilds — mirrors local's transcriptFullRebuildCount
// (frontend/local/transcript/store.js). Incremented by settleTranscriptProjection's
// window-derived rebuild and by the synchronous no-window reducer fallback
// alike, so it stays one counter across both
// full-rebuild sites, the same shape as transcriptFullWindowCopyCount
// (frontend/shared/transcript-hydration-store.js).
//
// Driven by transcript-projection.js's onRebuild callback, NOT by whether
// this settle call changed anything: a pinned background thread gives this
// surface two genuinely different session slots (state.realSession,
// state.session), and one settle can rebuild BOTH. Incrementing once per
// call (rather than once per actual renderedTranscriptFromWindow invocation)
// would silently under-count by half in exactly that case — see
// .sealwire/PLAN.md, "The criterion-3 proof is currently unsound".
let transcriptDeltaRebuildCount = 0;

export function __readTranscriptDeltaRebuildCount() {
  return transcriptDeltaRebuildCount;
}

export function __resetTranscriptDeltaRebuildCount() {
  transcriptDeltaRebuildCount = 0;
}

// Remote has two session slots where local has one: state.realSession (the
// relay's live thread) and state.session (the rendered projection — the SAME
// object as realSession unless a background thread is pinned view-only, in
// which case it is a re-projection). The shared settle already handles
// aliasing (rebuilds once, keeps both slots pointing at the same object) and
// checking each slot's own active_thread_id against the window's — this just
// supplies which slots to check and records each actual rebuild on this
// module's own counter.
function settleTranscriptProjection() {
  return settlePendingTranscriptProjection(state, ["realSession", "session"], () => {
    transcriptDeltaRebuildCount += 1;
  });
}

function invalidateViewOnlyNavigation() {
  viewOnlyNavigationGeneration += 1;
  viewOnlyThreadId = null;
  viewOnlyRefreshInFlight = false;
  viewOnlyLastRefreshAt = 0;
  viewOnlyWasWorking = false;
  viewOnlyDeltaDuringTerminalRefresh = false;
  // The relay drops watch sets when the broker connection goes, so the phone must
  // forget what it declared or it would never re-declare after reconnecting.
  lastDeclaredWatchKey = null;
  // Discard rather than settle: called from start/fork/resume, all of which
  // are about to replace the live session with a different thread entirely
  // (and, for the viewed pin being abandoned here, switchTranscriptHydrationThread
  // / clearTranscriptHydration replace the window itself right after). A
  // pending projection at this point would target a thread this navigation is
  // leaving; materialising it into a session about to be superseded is wasted
  // work, and — unlike a bare cancel of the render scheduler — this flag has
  // nothing further to protect once the navigation actually lands.
  state.transcriptWindowProjectionPending = false;
}

function remoteQueryScope() {
  return state.remoteAuth?.relayId || "unpaired";
}

// See the local surface's copy: `gcTime: Infinity` keeps every past run's pages, and
// their in-flight requests, for the life of the tab.
let sweptRemoteGeneration = null;

function fetchTranscriptPage({ threadId, before }) {
  const generation = (state.realSession || state.session)?.transcript_generation || "";
  if (sweptRemoteGeneration !== generation) {
    sweptRemoteGeneration = generation;
    dropTranscriptPageQueriesFromOtherGenerations(remoteQueryClient, generation);
  }
  return remoteQueryClient
    .fetchQuery(
      createThreadTranscriptPageQueryOptions({
        before,
        fetchPage: fetchCachedTranscriptPage,
        // Keyed by the run, so a request made after a restart cannot dedupe onto the
        // identical one still in flight from before it.
        generation: (state.realSession || state.session)?.transcript_generation || "",
        scope: remoteQueryScope(),
        surface: "remote",
        threadId,
      })
    );
}

// The repair records live on a Map hanging off `state`, so mutating them is invisible to
// `useSyncExternalStore`. Re-publish the same Map through the store to bump the snapshot
// identity and repaint the banner.
function publishWorkspaceRepair() {
  patchRemoteState({ workspaceRepairByThread: state.workspaceRepairByThread || new Map() });
}

/**
 * Ask the relay to make this thread's recorded workspace exist again.
 *
 * Ack-only over the broker and claim-free by design: a phone must be able to un-brick a
 * session it is merely viewing, without stealing the active-controller lease.
 */
export async function repairRemoteWorkspace(threadId) {
  const targetThreadId = threadId || state.session?.active_thread_id || null;
  if (!targetThreadId) {
    renderLog("There is no session whose workspace could be re-created.");
    return false;
  }

  setWorkspaceRepairPending(state, targetThreadId, true);
  publishWorkspaceRepair();

  try {
    await dispatchWorkspaceRepair(dispatchOrRecover, targetThreadId);
    // Clear now rather than waiting for the next tail fetch: the relay has just confirmed
    // the directory exists, and a banner still claiming otherwise would be a lie with a
    // button on it. The refresh below replaces this with the relay's own verdict.
    workspaceRepairResolved(state, targetThreadId);
    publishWorkspaceRepair();
    renderLog(`Re-created the workspace for session ${targetThreadId}.`);
    // No client-side probe cache to invalidate here: the verdict rides
    // `snapshot.workspace_missing` (see shared/workspace-repair.js), so the refresh
    // below is the whole of it. An assignment to a stray `lastWorkspaceVerdictProbeKey`
    // outlived the design that had one, and being inside this try meant the
    // ReferenceError it threw in strict mode was caught below and reported as a failed
    // repair — of a workspace the relay had just rebuilt.
    void fetchRawTranscriptPage({ threadId: targetThreadId, before: null }).catch(() => {});
    return true;
  } catch (error) {
    // The relay's own message, kept whole — "the repository … no longer exists either" is
    // the difference between a user who knows what to do and one who does not.
    setWorkspaceRepairError(
      state,
      targetThreadId,
      error.message || "Failed to re-create the workspace"
    );
    publishWorkspaceRepair();
    renderLog(`Workspace repair failed: ${error.message}`);
    return false;
  }
}

export function applyTranscriptDelta({
  thread_id,
  base_revision,
  revision,
  entry_seq,
  order_seq,
  server_time,
  item_id,
  turn_id,
  delta,
  delta_kind,
  kind,
  text_offset,
}) {
  if (typeof window !== "undefined" && typeof window.__transcriptDeltaCount === "number") {
    window.__transcriptDeltaCount++;
  }
  const liveSession = currentLiveSession();
  if (!liveSession) return;
  const liveThreadId = liveSession.active_thread_id || null;

  // Which session does this delta belong to?
  //
  // The relay now streams every thread this surface has declared it is watching, not
  // just the one globally-active thread. So a delta whose thread isn't the live one is
  // no longer automatically junk — it may be the thread being read view-only, whose
  // transcript lives in the PROJECTED session (`state.session`), not the live one.
  // Dropping it was what made a watched background thread update only when a poll
  // happened to land.
  let currentSession = liveSession;
  let commit = commitLiveSession;
  let currentThreadId = liveThreadId;
  if (thread_id && liveThreadId && thread_id !== liveThreadId) {
    if (viewOnlyThreadId && thread_id === viewOnlyThreadId && state.session?.view_only) {
      currentSession = state.session;
      currentThreadId = viewOnlyThreadId;
      commit = commitViewedSession;
    } else {
      const message = `[transcript-delta] ignored thread=${thread_id} current=${liveThreadId} item=${item_id || "-"} kind=${delta_kind || kind || "-"}`;
      renderLog(message);
      // TODO(remote-monitor-debug): Remove this console mirror once transcript routing is stable.
      console.log(message);
      return;
    }
  }

  const transcript = currentSession.transcript;
  if (!Array.isArray(transcript)) return;
  // The rule: write the window only when it is loaded for THIS delta's own
  // thread — never assume the pin's thread and the window's thread agree
  // (projectRemoteViewedSession resets `transcript` on exactly that
  // mismatch). Otherwise take the array fallback below — an O(n) find/scan
  // over `transcript`, same as local's own unhydrated fallback. This is NOT
  // the per-token hot path this sub-task removes: the window loads (flipping
  // this to the O(1) branch) the moment the relay marks the thread
  // `transcript_truncated`, which it does as soon as the thread's own stored
  // transcript exceeds `max_transcript_entries` (6 remote — see
  // crates/relay-server/src/protocol.rs:467, :846-849) — a bound that, once
  // crossed, never un-crosses, since a thread's history only grows. So this
  // branch's `n` is capped at 6 by construction; see .sealwire/PLAN.md, "Why
  // the window is loaded when it matters" — EXCEPT while a background thread
  // is pinned: the window then follows the PIN, not the live thread, so a
  // live delta takes this array fallback uncapped for as long as the pin
  // lasts. Accepted, not a defect — see .sealwire/PLAN.md, "Decided: the
  // pinned-thread trade-off", and the "pinning a background thread
  // mid-stream" test (session-ops.test.mjs).
  const windowLoaded = transcriptWindowIsLoaded(state, currentThreadId);
  const viewedThreadId = commit === commitViewedSession ? (currentThreadId || thread_id) : null;
  const deltaEvent = {
    thread_id,
    base_revision,
    revision,
    entry_seq,
    order_seq,
    server_time,
    item_id,
    turn_id,
    delta,
    delta_kind: delta_kind || kind,
    kind,
    text_offset,
  };
  const existingWindowEntry = windowLoaded
    ? state.transcriptHydrationEntries.get(item_id)
    : undefined;
  const outcome = reduceTranscriptDeltaEvent({
    session: currentSession,
    event: deltaEvent,
    currentThreadId,
    currentEntry: existingWindowEntry,
    hasCurrentEntry: windowLoaded ? Boolean(existingWindowEntry) : undefined,
    buildTranscript: !windowLoaded,
    rejectStaleRevision: true,
    enforceBaseRevisionWithoutOffset: true,
    useDeltaEventKindFallback: true,
    unknownDeltaKindFallback: "agent_text",
    appendEmptyOffsetlessDelta: true,
  });

  if (outcome.kind === "noop") {
    if (outcome.reason === "stale_revision") {
      const message = `[transcript-delta] ignored stale revision=${outcome.eventRevision} current=${outcome.currentRevision} thread=${thread_id || "-"} item=${item_id || "-"}`;
      renderLog(message);
      console.log(message);
    }
    return;
  }
  if (outcome.kind === "needs_repair") {
    scheduleTranscriptGapRepair(
      currentThreadId || thread_id || null,
      outcome.reason,
      outcome.eventRevision,
      outcome.detail
    );
    return;
  }
  if (outcome.kind === "duplicate") {
    return;
  }
  commitTranscriptDeltaAppend({
    windowLoaded,
    commit,
    currentSession,
    currentThreadId,
    event: deltaEvent,
    outcome,
    server_time,
    viewedThreadId,
  });
}

// Commits a resolved (already gap/mismatch/duplicate-checked) append. When
// the window is loaded for this thread, the write goes through the shared
// applyTranscriptDeltaToWindow (an O(1) Map write, re-run against the raw
// delta rather than the pre-resolved appendText so it makes exactly the same
// decision applyTranscriptDelta already made above) and the array projection
// is deferred to settleTranscriptProjection — adopting local's structure.
// Otherwise the array is rebuilt synchronously, right here, for just this one
// entry — no buffer, no deferral, matching local's own unhydrated fallback.
function commitTranscriptDeltaAppend({
  windowLoaded,
  commit = commitLiveSession,
  currentSession,
  currentThreadId,
  event,
  outcome,
  server_time,
  viewedThreadId = null,
}) {
  let nextSession;
  if (windowLoaded) {
    appendTranscriptDeltaToWindow(state, {
      item_id: outcome.itemId,
      thread_id: currentThreadId,
      delta: event.delta ?? "",
      delta_kind: event.delta_kind,
      turn_id: event.turn_id,
      entry_seq: event.entry_seq,
      // The window places rows by this. Rebuilding the payload by hand is
      // exactly how it went missing; forwarding it is what keeps a live remote
      // thread eligible for the keyed merge at all.
      order_seq: event.order_seq,
      text_offset: event.text_offset,
    });
    markTranscriptWindowProjectionPending(state);
    nextSession = { ...currentSession };
  } else {
    nextSession = outcome.nextSession;
    transcriptDeltaRebuildCount += 1;
  }
  if (outcome.eventRevision != null) {
    nextSession.transcript_revision = outcome.nextRevision;
  }
  if (Number.isSafeInteger(server_time)) {
    nextSession.server_time = server_time;
  }
  commit(nextSession, { chars: outcome.appendText.length, reason: "transcript_entry_delta" });
  if (viewedThreadId) {
    latchViewOnlyWasWorkingFromDelta(viewedThreadId);
  }
}

// Highest target revision we still owe a repair for, per thread. A Map (not a
// Set) so a gap detected *while* a repair is already in flight is not swallowed:
// we remember the newest revision and the loop re-fetches if it is past what the
// in-flight pass covered.
const pendingGapRepairThreads = new Map();

function scheduleTranscriptGapRepair(threadId, reason, targetRevision, detail = {}) {
  if (typeof window !== "undefined" && typeof window.__transcriptGapRepairCount === "number") {
    window.__transcriptGapRepairCount++;
  }
  const detailText = Object.entries(detail)
    .map(([key, value]) => `${key}=${value ?? "-"}`)
    .join(" ");
  const message = `[transcript-delta] gap -> repair thread=${threadId || "-"} reason=${reason} target=${targetRevision ?? "-"} ${detailText}`.trimEnd();
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once gap repair is stable.
  console.log(message);
  if (!threadId) {
    return;
  }
  // Invalidate the moment the gap is DETECTED, not only once a repair fetch
  // succeeds: repairActiveTranscriptTail only invalidates on its own success
  // path, so a failed fetch (or MAX_TRANSCRIPT_REPAIR_FAILURES giving up)
  // used to leave incomplete text trusted as `content_state: full` forever
  // (.sealwire/PLAN.md, "Invalidate; do not write" -> "invalidate when the
  // problem is detected, not when the repair succeeds"). Gated on this
  // thread's window actually being the one loaded — markTranscriptWindowNeedsRepair
  // has no thread param of its own and would otherwise blank whatever OTHER
  // thread's window happens to be loaded.
  if (transcriptWindowIsLoaded(state, threadId)) {
    // Settle FIRST: renderedTranscriptFromWindow treats a non-"full" entry as
    // untrusted and falls back to the ARRAY's current copy (correct for a
    // patch, which always writes its array directly and synchronously — see
    // invalidateTranscriptWindowEntryForPatch). A delta is different: its
    // array lags the window until settle (the whole point of deferring the
    // projection), so downgrading content_state here BEFORE the array has
    // caught up would make that fallback discard the window's own
    // just-buffered text and render the stale pre-delta array instead.
    settleTranscriptProjection();
    invalidateTranscriptWindowForRepair(state);
  }
  const target = numericRevision(targetRevision) ?? 0;
  const existingTarget = pendingGapRepairThreads.get(threadId);
  if (existingTarget != null) {
    if (target > existingTarget) {
      pendingGapRepairThreads.set(threadId, target);
    }
    return;
  }
  pendingGapRepairThreads.set(threadId, target);
  void runTranscriptRepairLoop(threadId);
}

const MAX_TRANSCRIPT_REPAIR_FAILURES = 3;

/// Is this thread still one we are actually showing?
///
/// Repair used to test only the LIVE thread, which meant a gap on a background thread
/// being read view-only exited the loop immediately and discarded the pending repair —
/// so the missing text sat there until polling or end-of-turn happened to refill it.
/// Now that a watched background thread streams, it can gap like any other and has to
/// be repairable too.
function isRepairableThread(threadId) {
  return (
    currentLiveSession()?.active_thread_id === threadId
    || (viewOnlyThreadId != null && viewOnlyThreadId === threadId)
  );
}

async function runTranscriptRepairLoop(threadId) {
  let repairedToRevision = -1;
  let consecutiveFailures = 0;
  try {
    while (isRepairableThread(threadId)) {
      const target = pendingGapRepairThreads.get(threadId) ?? 0;
      if (target <= repairedToRevision) {
        break;
      }
      try {
        const outcome = await repairActiveTranscriptTail(threadId, target);
        if (outcome === "retry") {
          // The gap is still open — do NOT advance `repairedToRevision`, or the loop
          // exits believing it healed something it did not. Counted as a failure so a
          // relay that keeps answering from another run cannot spin here forever.
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_TRANSCRIPT_REPAIR_FAILURES) {
            break;
          }
          continue;
        }
        repairedToRevision = target;
        consecutiveFailures = 0;
      } catch (error) {
        // A single failed fetch must NOT abandon the loop: do not advance
        // repairedToRevision, and re-read pendingGapRepairThreads on the next
        // iteration so a higher-revision gap that arrived while this attempt was
        // in flight is still honored instead of being dropped on the failure.
        consecutiveFailures += 1;
        renderLog(
          `[transcript-delta] gap repair attempt failed thread=${threadId} (${consecutiveFailures}/${MAX_TRANSCRIPT_REPAIR_FAILURES}): ${error?.message || error}`
        );
        if (consecutiveFailures >= MAX_TRANSCRIPT_REPAIR_FAILURES) {
          // Give up for now; the next delta or snapshot re-arms repair.
          break;
        }
      }
    }
  } finally {
    pendingGapRepairThreads.delete(threadId);
  }
}

// Pull the authoritative transcript tail and overlay it onto the visible
// transcript. This deliberately bypasses the snapshot-truncation hydration gate
// (`prepareTranscriptHydrationState` no-ops when `transcript_truncated` is
// false, which is exactly the normal live-gap case) and the query cache, so a
// dropped live chunk is actually re-fetched and healed rather than only logged.
/**
 * Returns what actually happened, because "did not throw" is not "repaired":
 *
 *  - "applied"  — the tail was merged; the gap is closed.
 *  - "obsolete" — the thread moved on; there is nothing left to repair.
 *  - "retry"    — this answer cannot close the gap (it came from another run of the
 *                 relay). The gap is still open and must NOT be marked repaired.
 */
async function repairActiveTranscriptTail(threadId, targetRevision) {
  const page = await fetchRawTranscriptPage({ threadId, before: null });
  // Settle before reading the transcript below — otherwise a delta pending
  // before this fetch started (for an item the repair page does not cover)
  // would be carried forward from a stale, pre-projection array and its text
  // would be lost once repair overwrites the session.
  settleTranscriptProjection();
  // Repair whichever session actually holds this thread's transcript: the live one, or
  // the view-only projection when the thread is being read in the background. Writing
  // a background thread's repaired tail into the live session would corrupt the live
  // thread's transcript, so the target is chosen the same way the delta path chooses it.
  const live = currentLiveSession();
  const viewingThisThread =
    viewOnlyThreadId === threadId && state.session?.view_only && threadId != null;
  const liveSession = viewingThisThread ? state.session : live;
  const commit = viewingThisThread ? commitViewedSession : commitLiveSession;
  // The thread may have changed while the fetch was in flight — a legitimate no-op
  // (the user moved on), not a failure to retry.
  if (!liveSession || liveSession.active_thread_id !== threadId) {
    return "obsolete";
  }
  // A missing or wrong-thread page is an incomplete/garbled response: throw so
  // runTranscriptRepairLoop retries instead of silently treating the gap as
  // repaired and advancing past it.
  if (!page || page.thread_id !== threadId) {
    throw new Error("remote transcript repair page response is incomplete");
  }
  if (transcriptPageIsFromAnotherGeneration(state.realSession || state.session, page)) {
    // The relay restarted while this was in flight; the page's ids name these messages
    // differently now (shared/transcript-generation.js). The gap is real but this
    // answer cannot close it — say so, so the loop refetches under the current run
    // instead of recording a repair that never happened.
    return "retry";
  }

  const pageEntries = Array.isArray(page.entries) ? page.entries : [];
  const current = Array.isArray(liveSession.transcript) ? liveSession.transcript : [];
  // The array holds entries with no `item_id` (never addressable) alongside
  // the normal, id-keyed ones — build the id order/lookup the shared
  // primitive expects from the addressable ones, and remember where the rest
  // sat so they can be restitched back in afterward instead of dropped.
  const { order, entries, positionless } = splitTranscriptArrayById(current);

  const result = reconcileAuthoritativeTail({
    order,
    entries,
    pageEntries,
    currentRevision: numericRevision(liveSession.transcript_revision),
    pageRevision: numericRevision(page.revision),
    targetRevision: numericRevision(targetRevision),
    prevCursor: page.prev_cursor,
  });

  const nextSession = {
    ...liveSession,
    transcript: joinTranscriptArrayById(current, positionless, result.order, result.entries),
    transcript_truncated: result.truncated,
  };
  if (result.revision != null) {
    nextSession.transcript_revision = result.revision;
  }
  // The repaired tail replaces the array directly, same as local's tail
  // repair — but if the window happens to be loaded for this same thread,
  // its cached copies are now stale relative to what was just fetched.
  if (transcriptWindowIsLoaded(state, threadId)) {
    // Distrust everything first — covers whatever the bounded tail page did
    // NOT reach (the retained older ids), the same signal a lagged stream raises.
    invalidateTranscriptWindowForRepair(state);
    // Then resync exactly what the repair DID reach — the primitive's own
    // page-ordered overlay. This is freshly fetched, authoritative content —
    // a hydration/snapshot-merge case the plan sanctions writing directly
    // (.sealwire/PLAN.md, "Invalidate; do not write" only bans a PATCH, which
    // carries no body, from writing). Downgrading to preview without ALSO
    // updating the cached text left the window holding the PRE-repair
    // (wrong, shorter) text at `full`-adjacent trust; the next delta's offset
    // check reads that stale length as `have` (applyTranscriptDelta, above),
    // so a delta already valid against the just-repaired array was wrongly
    // reported as a second offset_gap.
    syncTranscriptWindowWithRepairedEntries(state, threadId, result.repaired);
  }
  commit(nextSession);
  return "applied";
}

// Converts a plain transcript array into the id-ordered lookup the shared
// primitive (authoritative-tail-merge.js) expects. `positionless` records
// each non-addressable entry's original index so `joinTranscriptArrayById`
// can restore its place — it cannot join `order`/`entries`, which are keyed
// by `item_id`.
function splitTranscriptArrayById(transcript) {
  const order = [];
  const entries = new Map();
  const positionless = [];
  for (let index = 0; index < transcript.length; index += 1) {
    const entry = transcript[index];
    const itemId = entry?.item_id;
    if (!itemId) {
      positionless.push({ index, entry });
      continue;
    }
    order.push(itemId);
    entries.set(itemId, entry);
  }
  return { order, entries, positionless };
}

// Rebuilds a plain transcript array from the primitive's id order/lookup,
// reinserting each positionless entry immediately before whichever id-bearing
// entry followed it in the ORIGINAL array (or at the end, if none did).
// `mergeTailPageOrder` never drops an id already in `order`, so that anchor
// (when there is one) is always still present in the result.
function joinTranscriptArrayById(originalTranscript, positionless, order, entries) {
  const rebuilt = order.map((itemId) => entries.get(itemId)).filter(Boolean);
  for (const { index, entry } of positionless) {
    const anchorId = nextAddressableItemId(originalTranscript, index + 1);
    const at = anchorId ? rebuilt.findIndex((candidate) => candidate?.item_id === anchorId) : -1;
    if (at < 0) {
      rebuilt.push(entry);
    } else {
      rebuilt.splice(at, 0, entry);
    }
  }
  return rebuilt;
}

function nextAddressableItemId(transcript, fromIndex) {
  for (let index = fromIndex; index < transcript.length; index += 1) {
    const itemId = transcript[index]?.item_id;
    if (itemId) {
      return itemId;
    }
  }
  return null;
}

// Only touches items the window already tracks — never adds a new id or
// mutates `transcriptHydrationOrder`, so a partial Map write here can never
// make an unloaded window look loaded (the same invariant
// invalidateTranscriptWindowEntryForPatch holds for a patch).
// Exposed for the regression that a repaired copy cannot move a placed row or
// poison the window's keyed proof. repairActiveTranscriptTail itself fetches
// through the broker/E2EE stack, which no unit harness stands up; this runs the
// real seam against the real module state, which is where the invariant lives.
export function __syncTranscriptWindowWithRepairedEntriesForTest(threadId, repairedEntries) {
  return syncTranscriptWindowWithRepairedEntries(state, threadId, repairedEntries);
}

function syncTranscriptWindowWithRepairedEntries(state, threadId, repairedEntries) {
  if (state.transcriptHydrationThreadId !== threadId) {
    return;
  }
  const entries = state.transcriptHydrationEntries;
  if (!(entries instanceof Map)) {
    return;
  }
  for (const entry of repairedEntries) {
    const itemId = entry?.item_id;
    if (!itemId || !entries.has(itemId)) {
      continue;
    }
    const held = entries.get(itemId);
    entries.set(itemId, {
      ...held,
      ...entry,
      content_state: "full",
      // First valid birth key wins. A repaired copy is authoritative for CONTENT,
      // never for where a row already sits: rewriting the number here would move
      // nothing and clear nothing, leaving transcriptHydrationKeyed still
      // claiming "numbered and in order" over a window that no longer is.
      ...(Number.isSafeInteger(held?.order_seq) ? { order_seq: held.order_seq } : {}),
      // Absorbing, for the same reason it is everywhere else: a page built before
      // the withdrawal carries withdrawn:false and must not resurrect the row.
      ...(held?.withdrawn === true || entry.withdrawn === true ? { withdrawn: true } : {}),
    });
  }
}

export function applyTranscriptEvent(event) {
  const eventKind = event?.kind || event?.type || "";
  if (!state.session) {
    return;
  }

  if (eventKind === "transcript_entry_delta") {
    applyTranscriptDelta({
      ...event,
      delta_kind: event.delta_kind || event.entry_kind || event.entry?.kind,
      kind: event.entry_kind || event.entry?.kind,
    });
    return;
  }

  if (eventKind === "transcript_stream_lagged") {
    // Mirrors local's handling (frontend/local/session/stream.js): we may have
    // missed delta frames, so the cached text can no longer be trusted — pull
    // the authoritative tail rather than trust it. Whatever text is already
    // pending must not sit out the coalescing window behind a signal that
    // says the current view may already be stale.
    const laggedThreadId = event.thread_id || currentLiveSession()?.active_thread_id || null;
    scheduleTranscriptGapRepair(
      laggedThreadId,
      "transcript_stream_lagged",
      numericRevision(event.revision ?? event.transcript_revision)
    );
    transcriptFlushScheduler.flushNow("transcript_stream_lagged");
    return;
  }

  if (
    eventKind === "transcript_entry_started"
    || eventKind === "transcript_entry_completed"
    || eventKind === "transcript_entry_patched"
  ) {
    applyTranscriptEntryPatch(event, {
      defaultStatus:
        eventKind === "transcript_entry_completed"
          ? "completed"
          : eventKind === "transcript_entry_started"
            ? "running"
            : null,
      reason: eventKind,
    });
    return;
  }

  if (eventKind === "approval_added") {
    const approval = event.approval || event.request || null;
    if (!approval?.request_id) {
      return;
    }
    const liveSession = currentLiveSession();
    applySessionMetadataPatch({
      pending_approvals: upsertApproval(liveSession?.pending_approvals || [], approval),
    }, "approval_added");
    return;
  }

  if (eventKind === "approval_resolved") {
    const requestId = event.request_id || event.approval?.request_id || null;
    if (!requestId) {
      return;
    }
    const liveSession = currentLiveSession();
    applySessionMetadataPatch({
      pending_approvals: (liveSession?.pending_approvals || [])
        .filter((approval) => approval?.request_id !== requestId),
    }, "approval_resolved");
    return;
  }

  if (eventKind === "session_meta_updated") {
    applySessionMetadataPatch(event.session || event.patch || event, "session_meta_updated");
  }
}

export function applySessionSnapshot(snapshot) {
  if (typeof window !== "undefined" && typeof window.__snapshotCount === "number") {
    window.__snapshotCount++;
  }
  // Settle before any of the merge logic below reads state.realSession/
  // state.session — otherwise preserveVisibleTranscriptText compares the
  // incoming snapshot against a transcript missing whatever streamed in
  // since the last flush.
  settleTranscriptProjection();
  // Captured before the realSession sync below so an INBOUND pending->real
  // promotion (another device sent the first message) is still visible.
  const previousActiveThreadId =
    state.realSession?.active_thread_id || state.session?.active_thread_id || null;
  // Keep the authoritative live snapshot aligned with the rendered session
  // whenever no client-local projection is active. This also preserves live
  // transcript deltas that arrived after the previous full snapshot.
  if (!state.session) {
    state.realSession = null;
    viewOnlyThreadId = null;
  } else if (!state.session.view_only) {
    state.realSession = state.session;
    if (
      viewOnlyThreadId
      && viewOnlyThreadId !== state.session.active_thread_id
    ) {
      viewOnlyThreadId = null;
    }
  }
  if (!shouldAcceptSessionSnapshot(snapshot)) {
    const currentRevision = numericRevision(state.realSession?.transcript_revision);
    const incomingRevision = numericRevision(snapshot?.transcript_revision);
    const message = `[session-snapshot] ignored stale revision=${incomingRevision ?? "-"} current=${currentRevision ?? "-"} thread=${snapshot?.active_thread_id || "-"}`;
    renderLog(message);
    console.log(message);
    return;
  }
  // Deferred-Claude promotion seen from the SNAPSHOT side — this is how every
  // client that didn't send the first message (a second remote observer, or a
  // remote watching while the local UI sends) learns about it. The sender path
  // in sendMessage() handles its own client explicitly.
  const inboundPromotion = detectDeferredThreadPromotion({
    previousThreadId: previousActiveThreadId,
    nextThreadId: snapshot?.active_thread_id || null,
    nextThreadPromotedFrom: snapshot?.active_thread_promoted_from || null,
  });
  if (inboundPromotion) {
    // One-shot scroll-bookkeeping alias for the transcript pane (it clears it
    // after rekeying).
    state.promotedThreadAlias = inboundPromotion;
    if (
      shouldRebindPinnedViewOnPromotion({
        pinnedThreadId: viewOnlyThreadId,
        promotion: inboundPromotion,
      })
    ) {
      // The pending thread ceased to exist; without re-pinning, the
      // projection would keep rendering the stale pending transcript forever.
      viewOnlyNavigationGeneration += 1;
      viewOnlyThreadId = inboundPromotion.to;
      viewOnlyLastRefreshAt = Date.now();
      seedViewOnlyWasWorking(inboundPromotion.to, snapshot);
      clearTranscriptHydration(state);
    }
  }
  const displaySnapshot = stampThreadActivitySnapshotTime(
    preserveVisibleTranscriptText(state.realSession, snapshot)
  );
  state.realSession = displaySnapshot;
  const previousThreadId = state.session?.active_thread_id || "-";
  const viewingLiveThread =
    viewOnlyThreadId && displaySnapshot.active_thread_id === viewOnlyThreadId;
  // The projection SPREADS this snapshot and then injects the previously rendered
  // entries, so it would hand the old array the new run's generation and nothing
  // downstream could tell. Those ids are from a relay run that no longer exists —
  // drop the pin and refetch instead of relabelling it.
  if (
    viewOnlyThreadId
    && !viewingLiveThread
    && viewOnlyRelayGeneration !== (displaySnapshot.transcript_generation || "")
  ) {
    const staleThreadId = viewOnlyThreadId;
    viewOnlyThreadId = null;
    viewOnlyRelayGeneration = displaySnapshot.transcript_generation || "";
    applyRenderedSession(displaySnapshot);
    void viewRemoteThread(staleThreadId);
    return;
  }
  const projectedSnapshot = viewOnlyThreadId && !viewingLiveThread
    ? projectRemoteViewedSession(displaySnapshot, viewOnlyThreadId, state.session)
    : displaySnapshot;
  syncLiveTranscriptEntryDetailsFromSnapshot(state, projectedSnapshot);
  const effectiveSnapshot = viewOnlyThreadId && !viewingLiveThread
    ? projectedSnapshot
    : restoreHydratedTranscript(state, projectedSnapshot);
  // applyRenderedSession cancels the scheduler itself before rendering, so
  // every synchronous render — this one included — clears the pending slot.
  applyRenderedSession(effectiveSnapshot, {
    hydrationSnapshot: displaySnapshot,
    hydrateTranscript: !viewOnlyThreadId || viewingLiveThread,
  });
  maybeRefreshRemoteViewedThread(displaySnapshot);
  // Keep the relay's idea of what this phone is watching in step with what it is
  // actually rendering. Deduped internally, so this is one frame per real change.
  declareWatchedThreads();
  // Derive per-thread attention flags from the snapshot stream and fire browser
  // notifications for threads the user isn't actively watching. Best-effort:
  // never let a notification hiccup break snapshot rendering.
  try {
    const viewedThreadId = viewOnlyThreadId || snapshot?.active_thread_id || null;
    const events = threadAttention.ingest(snapshot, {
      viewedThreadId,
      isForeground: isDocumentForeground(),
    });
    notifyThreadEvents(events);
  } catch (error) {
    renderLog(`[thread-attention] ingest failed: ${error?.message || error}`);
  }
  // Everything below is diagnostics, and it is not cheap: reading `scrollHeight`
  // forces a synchronous layout of the whole transcript subtree, and `renderLog` is a
  // `patchRemoteState` — a full RemoteApp re-render. Both were paid on EVERY snapshot,
  // including the identical idle snapshots a relay repeats for a thread this surface
  // is not even displaying. Behind the flag, a snapshot costs neither.
  if (!isVerboseBrokerLoggingEnabled()) {
    return;
  }
  const scrollTop = remoteUiRefs.remoteTranscript?.scrollTop || 0;
  const scrollHeight = remoteUiRefs.remoteTranscript?.scrollHeight || 0;
  const clientHeight = remoteUiRefs.remoteTranscript?.clientHeight || 0;
  const windowY =
    typeof window.scrollY === "number"
      ? window.scrollY
      : typeof window.pageYOffset === "number"
        ? window.pageYOffset
        : 0;
  const restored =
    effectiveSnapshot !== displaySnapshot
      || (displaySnapshot?.transcript_truncated && !effectiveSnapshot?.transcript_truncated)
      ? "1"
      : "0";
  const message = `[scroll] applySessionSnapshot prev=${previousThreadId} input=${displaySnapshot?.active_thread_id || "-"} effective=${effectiveSnapshot?.active_thread_id || "-"} state=${state.session?.active_thread_id || "-"} in_truncated=${displaySnapshot?.transcript_truncated ? "1" : "0"} out_truncated=${effectiveSnapshot?.transcript_truncated ? "1" : "0"} restored=${restored} hydration=${state.transcriptHydrationStatus} older_cursor=${state.transcriptHydrationOlderCursor ?? "-"} entries=${effectiveSnapshot?.transcript?.length || 0} top=${scrollTop} height=${scrollHeight} client=${clientHeight} winY=${windowY}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once snapshot scroll restoration is stable.
  console.log(message);
}


function shouldAcceptSessionSnapshot(snapshot) {
  if (!snapshot) {
    return false;
  }
  const incomingThreadId = snapshot.active_thread_id || null;
  const currentThreadId = state.realSession?.active_thread_id || null;
  if (!incomingThreadId || incomingThreadId !== currentThreadId) {
    return true;
  }

  const incomingRevision = numericRevision(snapshot.transcript_revision);
  const currentRevision = numericRevision(state.realSession?.transcript_revision);
  return incomingRevision == null || currentRevision == null || incomingRevision >= currentRevision;
}

export function projectRemoteViewedSession(realSession, threadId, currentView) {
  const thread = (state.threads || []).find((candidate) => candidate?.id === threadId);
  const threadState = currentView?.thread_state || currentView || {};
  const viewRefreshTime = viewedRefreshServerTime(currentView);
  const viewMatchesThread = currentView?.active_thread_id === threadId;
  const viewedThread = threadId
    ? {
      threadId,
      entries: viewMatchesThread ? currentView.transcript || [] : [],
      transcriptRevision: viewMatchesThread ? currentView.transcript_revision || 0 : 0,
      transcriptTruncated: viewMatchesThread ? Boolean(currentView.transcript_truncated) : false,
      activeTurnId: threadState.active_turn_id || null,
      currentStatus: threadState.current_status,
      currentPhase: threadState.current_phase ?? null,
      currentTool: threadState.current_tool ?? null,
      lastProgressAt: threadState.last_progress_at ?? null,
      currentCwd: threadState.current_cwd || thread?.cwd || "",
      threadWorkspaceCwd:
        threadState.thread_workspace_cwd
        ?? currentView?.thread_workspace_cwd
        ?? "",
      provider: threadState.provider || thread?.provider || "",
      model: threadState.model || "",
      reasoningEffort: threadState.reasoning_effort || "",
      approvalPolicy: threadState.approval_policy || "",
      sandbox: threadState.sandbox || "",
      availableModels: threadState.available_models || [],
      // The viewed thread's OWN reviewers. The global remote snapshot scopes
      // reviewer_threads to the active parent, so without this a viewed non-active
      // thread shows fewer reviewers than local; the per-thread read supplies them
      // on view entry (currentView.thread_state.reviewers). On a later snapshot /
      // live delta, currentView is the previously-projected session (no thread_state,
      // value already under reviewer_threads), so fall back to that — otherwise the
      // set collapses to [] on the first re-projection.
      reviewerThreads: threadState.reviewers ?? currentView?.reviewer_threads ?? [],
      reviewLocked: Boolean(threadState.review_locked),
      workflowLocked: Boolean(threadState.workflow_locked ?? currentView?.workflow_locked),
      settingsWritable: Boolean(threadState.settings_writable),
      taskReviewer: Boolean(threadState.task_reviewer ?? currentView?.active_thread_task_reviewer),
      status: thread?.status,
      refreshServerTime: viewRefreshTime,
    }
    : null;
  return selectDisplayedSession({
    // Remote can open a saved thread before a live snapshot exists. Preserve the
    // old adapter's empty-object base in that case; Local still passes null through.
    liveSession: realSession || {},
    viewedThreadId: threadId,
    viewedThread,
    liveActivityServerTime: threadActivityServerTime(realSession),
    viewOnlySessionPatch: {
      active_controller_last_seen_at: null,
      active_flags: [],
      controller_lease_expires_at: null,
      view_last_refresh_server_time: viewRefreshTime || null,
    },
  });
}

function snapshotServerTime(session) {
  return serverTimeSeconds(session?.server_time);
}

function threadActivityServerTime(session) {
  return serverTimeSeconds(session?.thread_activity_server_time) || snapshotServerTime(session);
}

function viewedRefreshServerTime(currentView) {
  return serverTimeSeconds(
    currentView?.view_last_refresh_server_time ?? currentView?.server_time
  );
}

function stampThreadActivitySnapshotTime(snapshot) {
  if (!snapshot) {
    return snapshot;
  }
  const snapshotTime = snapshotServerTime(snapshot);
  return snapshotTime
    ? {
      ...snapshot,
      thread_activity_server_time: snapshotTime,
    }
    : snapshot;
}

function applyTranscriptEntryPatch(event, { defaultStatus = null, reason = null } = {}) {
  // This function does its own full-array rebuild below — settle any pending
  // window append into it FIRST, or this rebuild would carry the pre-append
  // text forward into its own new array reference, silently dropping the
  // pending delta once nothing settles it later (see settleTranscriptProjection).
  settleTranscriptProjection();
  const currentSession = currentLiveSession();
  if (!currentSession) {
    return;
  }
  const currentThreadId = currentSession.active_thread_id || null;
  const outcome = reduceTranscriptEntryPatchEvent({
    session: currentSession,
    event,
    currentThreadId,
    defaultStatus,
    rejectStaleRevision: true,
    enforceBaseRevision: true,
    useEventKindFallback: true,
    windowLoaded: transcriptWindowIsLoaded(state, currentThreadId),
  });
  if (outcome.kind === "rejected_patch") {
    if (outcome.reason !== "revision_mismatch") {
      return;
    }
    scheduleTranscriptGapRepair(
      currentThreadId || outcome.eventThreadId,
      "entry_patch_revision_mismatch",
      event.revision ?? event.transcript_revision,
      outcome.repairDetail
    );
    return;
  }
  const entryPatch = outcome.entryPatch;
  // Also invalidate the window's own copy for THIS thread — never assume the
  // window's thread agrees with the live thread a patch always targets (a
  // background thread can be pinned view-only, in which case the window
  // follows the PIN, not the live thread). It can never safely carry this
  // patch's fields itself (see invalidateTranscriptWindowEntryForPatch), so
  // settleTranscriptProjection's later window-derived rebuild must not trust
  // the window's stale copy over the array's fresher one —
  // renderedTranscriptFromWindow reads this thread's array as the fallback
  // source for exactly that reason. A no-op when the window isn't loaded for
  // this thread, or doesn't yet track this item.
  applyEntryPatchToWindow(state, currentThreadId, entryPatch);
  const nextSession = { ...outcome.nextSession };
  if (Number.isSafeInteger(event.server_time)) {
    nextSession.server_time = event.server_time;
  }
  if (outcome.patchIntroducesUntrackedItem) {
    // currentSession (pre-patch), NOT outcome.nextSession: a patch carries no
    // content_state field, so feeding this item's fabricated array entry to
    // hydration's tail merge (createMergedSnapshotTailPatch, run
    // unconditionally by prepareTranscriptHydrationState whenever this
    // thread's window has visible entries) would default the missing field
    // to "full" and poison the window with an empty-but-"full" entry —
    // permanently suppressing the real fetch (transcript-hydration-store.js's
    // contentStateOf; see .sealwire/PLAN.md, "Invalidate; do not write" ->
    // "Never route non-authoritative data through the authoritative path" ->
    // "Invalidate and refetch instead of merging a patch-derived session").
    // currentSession never mentions this item, so the merge can only repair
    // OTHER already-tracked entries — renderedTranscriptFromWindow's own
    // array-fallback already renders this one correctly from outcome.nextTranscript
    // until a genuine snapshot teaches the window about it honestly. Mirrors
    // local's applyLocalTranscriptEntryPatch (local/session/stream.js), which
    // reaches the same place via ensureConversationTranscript(state.session).
    void hydrateActiveTranscript(currentSession);
  }
  // A patch that leaves the entry "running" is a routine update on an
  // in-flight stream and coalesces with the delta path; anything else
  // (completed, failed, cancelled, …) is terminal completion and must paint
  // at once — it is the only signal remote gets for a turn going idle.
  commitLiveSession(nextSession, {
    immediate: outcome.terminal,
    reason: reason || "transcript_entry_patch",
  });
}

function applySessionMetadataPatch(patch, reason = "session_meta_updated") {
  const currentSession = currentLiveSession();
  if (!currentSession || !patch) {
    return;
  }
  const {
    kind: _kind,
    type: _type,
    transcript: _transcript,
    transcript_truncated: _transcriptTruncated,
    ...metadata
  } = patch;
  const nextSession = {
    ...currentSession,
    ...metadata,
    transcript: currentSession.transcript,
    transcript_truncated: currentSession.transcript_truncated,
  };
  if (Object.prototype.hasOwnProperty.call(metadata, "thread_activity")) {
    nextSession.thread_activity_server_time =
      serverTimeSeconds(metadata.server_time) || currentSession.thread_activity_server_time || null;
  }
  // Approvals, ask-user state, and turn/error status all ride this patch, and
  // remote has no separate live event for any of them — always paint at once.
  commitLiveSession(nextSession, { immediate: true, reason });
}

function currentLiveSession() {
  return state.session?.view_only ? state.realSession : state.session;
}

/// Commit a delta into the VIEW-ONLY projection.
///
/// Deliberately does not touch `state.realSession`: the live session still belongs to
/// whatever thread the relay has active, and folding a watched background thread's
/// text into it would corrupt the transcript the user sees on switching back.
// Declaring which threads this phone has on screen, so the relay streams their deltas
// here and nothing else. Without a declaration the relay falls back to "just the active
// thread", which is exactly the pre-subscription behavior — so a stale client degrades
// rather than going silent.
/// Forget the last declaration so the next snapshot re-sends it.
///
/// The relay clears a surface's watch set when the broker connection drops, so a
/// reconnect starts unsubscribed. Without this the phone would consider the set
/// already sent and never re-declare, leaving background threads on polling.
export function resetDeclaredWatchedThreads() {
  lastDeclaredWatchKey = null;
}

export function declareWatchedThreads() {
  const live = state.realSession || state.session;
  const threadIds = [];
  // The phone renders ONE conversation: the pinned thread when reading view-only,
  // otherwise the live thread.
  const viewed = viewOnlyThreadId || live?.active_thread_id || null;
  if (viewed) {
    threadIds.push(viewed);
  }
  // The peer id is part of the key BECAUSE the relay stores watch sets per broker
  // peer and drops them when the connection ends. A reconnect mints a new peer id, so
  // including it makes the identical thread set re-declare automatically — without it
  // the dedupe would suppress the re-send and background threads would silently fall
  // back to polling until the user switched threads.
  const key = `${state.socketPeerId || "-"}|${threadIds.join(" ")}`;
  // Called from the snapshot path, so without this dedupe every snapshot would
  // become an outbound frame.
  if (key === lastDeclaredWatchKey) {
    return false;
  }
  lastDeclaredWatchKey = key;
  // `dispatchRemoteActionWithoutReply` is async, so a socket that is not up yet
  // REJECTS rather than throwing — a try/catch around the call would miss it and
  // leave an unhandled rejection behind.
  dispatchRemoteActionWithoutReply("watch_threads", {
    input: { thread_ids: threadIds },
  }).catch((error) => {
    // Not paired / not connected yet. Forget the key so the next snapshot retries,
    // otherwise this surface would sit on a subscription the relay never received.
    lastDeclaredWatchKey = null;
    renderLog(`[watch-threads] declaration failed: ${error?.message || error}`);
  });
  return true;
}

/// Commit a delta into the VIEW-ONLY projection.
///
/// Deliberately does not touch `state.realSession`: the live session still belongs to
/// whatever thread the relay has active, and folding a watched background thread's
/// text into it would corrupt the transcript the user sees on switching back.
function commitViewedSession(nextViewedSession, { immediate = false, chars = 0, reason } = {}) {
  state.session = nextViewedSession;
  scheduleTranscriptFlush({ immediate, chars, reason });
}

function commitLiveSession(nextLiveSession, { immediate = false, chars = 0, reason } = {}) {
  state.realSession = nextLiveSession;
  let nextRenderedSession = nextLiveSession;
  if (viewOnlyThreadId && viewOnlyThreadId !== nextLiveSession.active_thread_id) {
    // About to read state.session below (for the pinned thread's own
    // transcript, folded into the re-projection) — settle first, or a
    // pending append for the VIEWED thread's window would be published here
    // frozen into a fresh object, stale until the next unrelated settle.
    // Safe against the live delta this call is itself committing: by
    // construction the window only ever tracks the PINNED thread while one
    // is active (switchTranscriptHydrationThread runs synchronously with the
    // pin), so a live-thread delta reaching this branch never just armed the
    // flag this settle would consume.
    settleTranscriptProjection();
    nextRenderedSession = projectRemoteViewedSession(
      nextLiveSession,
      viewOnlyThreadId,
      state.session
    );
  }
  // Advance reducer state synchronously so every delta in this frame appends to
  // the latest text. Subscriber notification and React reconciliation are the
  // expensive part, so those are coalesced by the shared flush scheduler.
  state.session = nextRenderedSession;
  scheduleTranscriptFlush({ immediate, chars, reason });
}

// Single chokepoint from a session commit to the scheduler, so every commit
// site picks "coalesce" vs "paint now" the same way instead of each caller
// juggling queue()/note()/flushNow() itself.
function scheduleTranscriptFlush({ immediate = false, chars = 0, reason } = {}) {
  if (immediate) {
    transcriptFlushScheduler.flushNow(reason);
    return;
  }
  transcriptFlushScheduler.queue(reason);
  if (chars > 0) {
    transcriptFlushScheduler.note(chars);
  }
}

function upsertApproval(approvals, incoming) {
  const existingIndex = approvals.findIndex(
    (approval) => approval?.request_id === incoming.request_id
  );
  if (existingIndex === -1) {
    return [...approvals, incoming];
  }
  return approvals.map((approval, index) =>
    index === existingIndex ? { ...approval, ...incoming } : approval
  );
}

export async function syncRemoteSnapshot(reason, silent = false) {
  if (!silent) {
    renderLog(`Syncing remote session (${reason}).`);
  }

  try {
    await dispatchRemoteActionWithoutReply("heartbeat", {
      input: {},
    });
  } catch (error) {
    renderLog(`Remote heartbeat sync failed: ${error.message}`);
  }

  try {
    await refreshRemoteThreads(reason, { silent: true });
  } catch (error) {
    renderLog(`Remote session sync failed: ${error.message}`);
  }
}

export async function startRemoteSession(sessionDraftOverride = null) {
  // Explicit live action: invalidate pending view fetches and let live snapshots flow.
  invalidateViewOnlyNavigation();
  const sessionDraft = sessionDraftOverride;
  if (!sessionDraft) {
    throw new Error("startRemoteSession requires a session draft");
  }
  const cwd = sessionDraft.cwd.trim();
  if (!cwd) {
    renderLog("Choose a workspace before starting a remote session.");
    return false;
  }

  renderLog(`Starting remote session in ${cwd}.`);

  try {
    await dispatchOrRecover("start_session", {
      input: {
        cwd,
        initial_prompt: sessionDraft.initialPrompt.trim() || null,
        model: sessionDraft.model.trim() || null,
        approval_policy: sessionDraft.approvalPolicy,
        sandbox: sessionDraft.sandbox,
        effort: sessionDraft.effort,
        provider: sessionDraft.provider,
        // Explicit null when unfiled: remote has no second step, its start_session
        // returns no thread id to follow up on.
        project_id: sessionDraft.projectId || null,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote start failed: ${error.message}`);
    return false;
  }
}

export async function forkRemoteSession(forkDraft = null) {
  invalidateViewOnlyNavigation();
  if (!forkDraft?.sourceThreadId) {
    return { ok: false, error: "Choose a session to fork." };
  }
  const cwd = String(forkDraft.cwd || "").trim();
  if (!cwd) {
    return { ok: false, error: "Choose a workspace before forking a remote session." };
  }

  renderLog(`Forking remote session ${forkDraft.sourceThreadId}.`);

  try {
    // Untouched settings go out as null so the relay inherits them from the
    // SOURCE thread rather than from whatever session is open here.
    await dispatchOrRecover("fork_session", {
      input: forkFieldsToPayload({ ...forkDraft, cwd }),
    });
    return { ok: true };
  } catch (error) {
    renderLog(`Remote fork failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

export async function fetchRemoteProviders() {
  if (!state.remoteAuth) {
    return [];
  }
  const result = await dispatchOrRecover("list_providers", {});
  return result.providers || [];
}

export async function fetchRemoteProviderModels(provider) {
  if (!state.remoteAuth || !provider) {
    return [];
  }
  const result = await dispatchOrRecover("list_provider_models", {
    provider,
  });
  return result.models || [];
}

// Generation counter for the remote list. Bypassing de-duplication means two list
// requests can be in flight at once with no ordering guarantee, so the OLDER one must not
// land on top of the newer one's data — after a rename, the stale answer is precisely the
// one that predates it.
let remoteThreadsGeneration = 0;

export async function refreshRemoteThreads(reason, options = {}) {
  // `fresh` bypasses the query cache's in-flight de-duplication — see
  // `fetchThreadListFresh`. Used when the refresh answers a KNOWN mutation (a rename,
  // here or on another device) rather than a poll.
  const { silent = false, fresh = false } = options;
  const generation = ++remoteThreadsGeneration;

  if (!silent) {
    renderLog(`Fetching remote session list (${reason}).`);
  }

  try {
    const queryOptions = {
      fetchThreads: fetchRemoteThreads,
      limit: 80,
      scope: remoteQueryScope(),
      surface: "remote",
    };
    const threads = fresh
      ? await fetchThreadListFresh({ ...queryOptions, queryClient: remoteQueryClient })
      : await remoteQueryClient.fetchQuery(createThreadListQueryOptions(queryOptions));
    // Superseded by a newer refresh while this one was in flight — its result is the
    // older view of the list, so applying it would undo the newer one.
    if (generation !== remoteThreadsGeneration) {
      return threads;
    }
    applyRemoteSurfacePatch(createRemoteThreadsPatch(threads));
    return threads;
  } catch (error) {
    // A superseded refresh did not fail — it was overtaken, and a fresh fetch CANCELS the
    // request it replaced (evicting the query destroys its retryer). Reporting that as
    // "Remote session refresh failed" would put an error banner on the screen every time
    // a rename overtook the 12s poll, for a refresh whose result was going to be thrown
    // away regardless. Swallow it; the newer request owns the repaint.
    if (generation !== remoteThreadsGeneration) {
      return [];
    }
    if (!silent) {
      renderLog(`Remote session refresh failed: ${error.message}`);
    }
    throw error;
  } finally {
    // Re-arm the recurring poll on every refresh — the same chokepoint pattern
    // local uses (loadThreads()'s finally schedules the next scheduleThreadsPoll).
    // Recovery's initial refresh starts the loop; manual refreshes just reset the
    // 12s clock. Without this, remote's left list would freeze between manual
    // refreshes while local's keeps its timestamps and ordering live.
    scheduleRemoteThreadsPoll();
  }
}

// Cadence matches the local surface's thread poll (frontend/local/session/polling.js)
// so the remote sidebar refreshes its timestamps and reorders on the same beat.
const REMOTE_THREADS_POLL_INTERVAL_MS = 12_000;

export function scheduleRemoteThreadsPoll() {
  if (typeof window === "undefined") {
    return;
  }
  // Unpaired surfaces have nothing to poll; clearing here means teardown paths
  // that drop remoteAuth (return home / forget device) stop the loop for free.
  if (!state.remoteAuth) {
    cancelRemoteThreadsPoll();
    return;
  }
  if (state.remoteThreadsPollTimer) {
    window.clearTimeout(state.remoteThreadsPollTimer);
  }
  state.remoteThreadsPollTimer = window.setTimeout(
    runRemoteThreadsPoll,
    REMOTE_THREADS_POLL_INTERVAL_MS
  );
}

export function cancelRemoteThreadsPoll() {
  if (!state.remoteThreadsPollTimer) {
    return;
  }
  window.clearTimeout(state.remoteThreadsPollTimer);
  state.remoteThreadsPollTimer = null;
}

function runRemoteThreadsPoll() {
  state.remoteThreadsPollTimer = null;
  if (!state.remoteAuth) {
    return;
  }
  if (!state.socketConnected) {
    // Broker is down: skip the round trip (it would only time out) but keep the
    // loop alive so polling resumes the moment the socket reconnects.
    scheduleRemoteThreadsPoll();
    return;
  }
  // refreshRemoteThreads re-arms the next poll from its finally block.
  void refreshRemoteThreads("poll", { silent: true }).catch(() => {});
}

/**
 * The raw page, including which providers could not be listed.
 *
 * A failed provider is dropped from the merge and the action still succeeds, so "zero
 * threads" and "half the providers were unreachable" arrive identically unless the
 * caller reads this. It only matters for search — where an empty answer reads as "that
 * session does not exist" — but it rides both paths so there is one shape.
 */
export async function fetchRemoteThreadPage({ limit = 80, q = "", ids = null } = {}) {
  if (!state.remoteAuth) {
    return { threads: [], unavailableProviders: [] };
  }

  const query = { limit };
  if (q) {
    query.q = q;
  }
  // Ask about specific sessions instead of for a page. The relay scans as deeply as a
  // search for these and does not truncate to `limit`, so absence from the answer means
  // it genuinely could not resolve the id — the one thing a page cannot tell you, because
  // its bound applies to the provider scan too. See `ThreadsQuery.ids`.
  if (Array.isArray(ids) && ids.length) {
    query.ids = ids;
  }
  const result = await dispatchOrRecover("list_threads", { query });
  return {
    threads: result.threads?.threads || [],
    unavailableProviders: result.threads?.unavailable_providers || [],
  };
}

export async function fetchRemoteThreads(options = {}) {
  return (await fetchRemoteThreadPage(options)).threads;
}

/**
 * Ask the relay which of these sessions it can still resolve.
 *
 * Deliberately NOT routed through the thread-list query cache. That cache is keyed by the
 * resting list, and a probe is a different question with a different answer shape —
 * seeding it would let a narrow probe answer a later request for the whole page.
 */
export async function probeRemoteThreadsExist(threadIds) {
  const ids = [...new Set((threadIds || []).filter(Boolean))];
  if (!ids.length) {
    return { threads: [], unavailableProviders: [] };
  }
  return fetchRemoteThreadPage({ limit: ids.length, ids });
}

let remoteThreadSearchGeneration = 0;
let remoteThreadSearchTimer = null;
let remoteThreadSearchCancelToken = 0;

/**
 * Debounce a query. The timer lives HERE, not in the component, so that every path that
 * tears the surface down cancels it along with the request — a timer owned by React is
 * invisible to `createResetRemoteSurfaceStatePatch` and can fire against whatever
 * connection replaced the one it was typed into.
 */
export function queueRemoteThreadSearch(rawQuery, delayMs = 180) {
  window.clearTimeout(remoteThreadSearchTimer);
  remoteThreadSearchTimer = null;
  if (!normalizeThreadSearchQuery(rawQuery)) {
    // Clearing is not a fetch — apply it at once so the list snaps back rather than
    // sitting on stale matches for another debounce window.
    void searchRemoteThreads("");
    return;
  }
  remoteThreadSearchTimer = window.setTimeout(() => {
    remoteThreadSearchTimer = null;
    void searchRemoteThreads(rawQuery);
  }, delayMs);
}

/**
 * Abandon everything a search owns: the pending keystroke timer, any answer still in
 * flight, and the results on screen.
 *
 * Bumping the generation is what makes an in-flight answer land nowhere. Relay identity
 * alone is not enough — re-pairing tears the surface down while KEEPING the current
 * relay id, so a rejected request would otherwise pass the identity check and write its
 * error back over state that was just cleared.
 */
export function cancelRemoteThreadSearch() {
  window.clearTimeout(remoteThreadSearchTimer);
  remoteThreadSearchTimer = null;
  remoteThreadSearchGeneration += 1;
  remoteThreadSearchCancelToken += 1;
  applyRemoteSurfacePatch({
    threadSearch: { ...EMPTY_THREAD_SEARCH },
    // Lets the component drop the text still in its field. The draft is React's, and a
    // reset has no other way to reach it.
    threadSearchCancelToken: remoteThreadSearchCancelToken,
  });
}

/**
 * Run a title search, or clear one when `rawQuery` is blank.
 *
 * Deliberately NOT through the query cache. `threadListQueryKey` keys on `{limit}` only
 * and `createThreadListQueryOptions` hardcodes `queryFn: () => fetchThreads({limit})`,
 * so a cached search would share a key with the 12s poll — each would serve the other's
 * answer. Local sidesteps it the same way.
 *
 * Results land in `state.threadSearch` and NOWHERE else: `state.threads` stays the
 * authoritative list that the poll, the render model and every id lookup read.
 */
export async function searchRemoteThreads(rawQuery) {
  const query = normalizeThreadSearchQuery(rawQuery);
  const generation = ++remoteThreadSearchGeneration;
  // Captured, not read at completion: a relay switch mid-flight must invalidate the
  // answer even if the generation happened to line up.
  const relayId = state.remoteAuth?.relayId || null;
  const stillCurrent = () =>
    generation === remoteThreadSearchGeneration && (state.remoteAuth?.relayId || null) === relayId;

  if (!query) {
    // Clearing is not a fetch — snap back rather than flashing stale matches.
    applyRemoteSurfacePatch(createRemoteThreadSearchPatch({ ...EMPTY_THREAD_SEARCH }));
    return;
  }

  applyRemoteSurfacePatch(
    createRemoteThreadSearchPatch({
      ...state.threadSearch,
      query,
      loading: true,
      error: null,
    })
  );

  try {
    // 80, not local's 120: the remote surface's response budget caps the list at 80
    // (THREADS_RESPONSE_REMOTE_SURFACE_BUDGET) and reduces further under byte pressure,
    // so asking for more would be silently trimmed and the count line would lie.
    const { threads, unavailableProviders } = await fetchRemoteThreadPage({ limit: 80, q: query });
    if (!stillCurrent()) {
      return;
    }
    applyRemoteSurfacePatch(
      createRemoteThreadSearchPatch({
        query,
        groups: buildNavigationThreadGroups(threads),
        loading: false,
        error: null,
        unavailableProviders,
      })
    );
  } catch (error) {
    if (!stillCurrent()) {
      return;
    }
    applyRemoteSurfacePatch(
      createRemoteThreadSearchPatch({
        query,
        groups: [],
        loading: false,
        error: error.message || "Search failed",
        unavailableProviders: [],
      })
    );
  }
}

export async function resumeRemoteSession(threadId, _sessionDraftOverride = null) {
  if (!threadId) {
    return;
  }
  // Explicit live action: invalidate pending view fetches and let live snapshots flow.
  invalidateViewOnlyNavigation();

  renderLog(`Resuming remote session ${threadId}.`);

  try {
    await dispatchOrRecover("resume_session", {
      input: {
        thread_id: threadId,
      },
    });
    return true;
  } catch (error) {
    renderLog(`Remote resume failed: ${error.message}`);
    return false;
  }
}

export async function updateRemoteSessionSettings({ approval_policy, sandbox, effort, model } = {}) {
  if (!state.session?.active_thread_id) {
    return false;
  }
  const input = { thread_id: state.session.active_thread_id };
  if (typeof approval_policy === "string" && approval_policy) {
    input.approval_policy = approval_policy;
  }
  if (typeof sandbox === "string" && sandbox) {
    input.sandbox = sandbox;
  }
  if (typeof effort === "string" && effort) {
    input.effort = effort;
  }
  if (typeof model === "string" && model) {
    input.model = model;
  }
  if (
    !("approval_policy" in input)
    && !("sandbox" in input)
    && !("effort" in input)
    && !("model" in input)
  ) {
    return false;
  }

  try {
    await dispatchOrRecover("update_session_settings", { input });
    const parts = [];
    if (input.approval_policy) parts.push(`approval=${input.approval_policy}`);
    if (input.sandbox) parts.push(`sandbox=${input.sandbox}`);
    if (input.effort) parts.push(`effort=${input.effort}`);
    if (input.model) parts.push(`model=${input.model}`);
    renderLog(`Updated remote session settings: ${parts.join(", ")}`);
    if (state.session?.view_only && state.session.active_thread_id === input.thread_id) {
      applyRenderedSession(
        {
          ...state.session,
          approval_policy: input.approval_policy || state.session.approval_policy,
          sandbox: input.sandbox || state.session.sandbox,
          reasoning_effort: input.effort || state.session.reasoning_effort,
          model: input.model || state.session.model,
        },
        { hydrateTranscript: false }
      );
    }
    return true;
  } catch (error) {
    renderLog(`Remote settings update failed: ${error.message}`);
    return false;
  }
}

export async function viewRemoteThread(threadId) {
  if (!threadId) {
    return false;
  }

  const navigationGeneration = ++viewOnlyNavigationGeneration;
  renderLog(`Viewing remote session ${threadId}.`);
  if (state.realSession?.active_thread_id === threadId) {
    viewOnlyThreadId = threadId;
    viewOnlyRelayGeneration = state.realSession?.transcript_generation || "";
    viewOnlyLastRefreshAt = Date.now();
    seedViewOnlyWasWorking(threadId);
    applyRenderedSession(state.realSession);
    return true;
  }

  try {
    const viewOnlyGeneration = (state.realSession || state.session)?.transcript_generation || "";
    const page = await fetchTranscriptPage({
      before: null,
      threadId,
    });
    // A newer view, resume, start, or relay reset won while this fetch was in
    // flight. Do not let this stale response restore an old read-only projection.
    if (navigationGeneration !== viewOnlyNavigationGeneration) {
      return false;
    }
    if (!page || page.thread_id !== threadId) {
      throw new Error("remote transcript page response is incomplete");
    }
    // The relay restarted while this was in flight, or has since — either way these
    // ids are not the ones the current run uses, and projecting them would show every
    // message twice once live content arrives beside them.
    if (
      viewOnlyGeneration !== ((state.realSession || state.session)?.transcript_generation || "")
      || transcriptPageIsFromAnotherGeneration(state.realSession || state.session, page)
    ) {
      return false;
    }
    viewOnlyRelayGeneration = viewOnlyGeneration;

    // Settle whatever is still pending for the OUTGOING window's thread
    // first: settleTranscriptProjection can only rebuild a session that
    // matches the window's CURRENT thread, so once switchTranscriptHydrationThread
    // below repoints transcriptHydrationThreadId at the newly-pinned thread,
    // a pending live delta would become permanently unreachable — left
    // stale in state.realSession until something else happens to touch the
    // OLD thread's window again, which pinning a different thread does not.
    settleTranscriptProjection();
    // Retain the leaving thread's loaded window and restore the target thread's
    // retained window (if any) instead of clearing — so switching between remote
    // threads and back keeps the older history scrolled into view. The page fetch
    // above still refreshes the tail; hydration merges it onto the restored
    // window, and scroll-up reuses the retained older pages without a refetch.
    switchTranscriptHydrationThread(state, threadId);
    // Pin this thread so incoming live snapshots update state.realSession while
    // leaving the user's local view in place.
    viewOnlyThreadId = threadId;
    viewOnlyLastRefreshAt = Date.now();
    if (viewOnlyRefreshInFlight) {
      preserveViewOnlyWasWorkingAfterTerminalFetch(threadId);
    } else {
      seedViewOnlyWasWorking(threadId);
    }
    applyRenderedSession(
      projectRemoteViewedSession(
        state.realSession || state.session,
        threadId,
        {
          active_thread_id: threadId,
          transcript: page.entries || [],
          transcript_revision: page.revision || 0,
          transcript_truncated: page.prev_cursor != null,
          thread_state: page.thread_state || null,
          view_last_refresh_server_time: page.server_time ?? null,
        }
      ),
      {
        hydrateTranscript: true,
      }
    );
    return true;
  } catch (error) {
    renderLog(`Remote session view failed: ${error.message}`);
    return false;
  }
}

function maybeRefreshRemoteViewedThread(realSession) {
  if (!viewOnlyThreadId || viewOnlyRefreshInFlight) {
    return;
  }
  const working = remoteViewedThreadIsWorking(viewOnlyThreadId, realSession);
  const shouldRefresh = shouldRefreshViewedThread({
    elapsedMs: Date.now() - viewOnlyLastRefreshAt,
    wasWorking: viewOnlyWasWorking,
    working,
  });
  if (!shouldRefresh) {
    viewOnlyWasWorking = resolveViewOnlyPinWasWorking({
      prior: { wasWorking: viewOnlyWasWorking },
      isWorking: working,
    });
    return;
  }
  const threadId = viewOnlyThreadId;
  viewOnlyWasWorking = working;
  viewOnlyRefreshInFlight = true;
  viewOnlyDeltaDuringTerminalRefresh = false;
  viewOnlyLastRefreshAt = Date.now();
  void viewRemoteThread(threadId).finally(() => {
    viewOnlyRefreshInFlight = false;
    maybeRefreshRemoteViewedThread(state.realSession);
  });
}

export async function sendMessage(messageDraft, effort, model = "") {
  if (typeof messageDraft !== "string" || typeof effort !== "string") {
    throw new Error("sendMessage requires a draft and effort");
  }
  const text = messageDraft.trim();
  if (!text) {
    renderLog("Message is empty.");
    return false;
  }
  const threadId = state.session?.active_thread_id;
  if (!threadId) {
    renderLog("No session is selected.");
    return false;
  }
  // A new attempt supersedes the last failure ON THIS THREAD only. Patched
  // (not assigned) so the composer re-renders on both the clear and the set.
  setComposerError(threadId, "");

  // Clamp the effort to the target model's supported set so a stale/foreign
  // value (e.g. a Claude-only "max" left on a codex thread) is never forwarded
  // and rejected with a 400 — the same guard the local composer applies.
  const outgoingEffort = resolveOutgoingEffort({
    override: effort,
    models: state.session?.available_models || [],
    model: model || state.session?.model || "",
  });

  try {
    await dispatchOrRecover("send_message", {
      input: {
        text,
        model,
        effort: outgoingEffort,
        thread_id: threadId,
      },
    });
    // Claude's first send promotes a synthetic pending id to the real SDK
    // session id. The action snapshot arrives while the old id is still pinned,
    // so it is initially projected back onto that stale id. Rebind the client-
    // local view after the successful targeted send and hydrate the real thread.
    const promotedThreadId = state.realSession?.active_thread_id || null;
    if (
      threadId.startsWith("claude-pending-")
      && viewOnlyThreadId === threadId
      && promotedThreadId
      && promotedThreadId !== threadId
    ) {
      viewOnlyNavigationGeneration += 1;
      viewOnlyThreadId = promotedThreadId;
      viewOnlyLastRefreshAt = Date.now();
      seedViewOnlyWasWorking(promotedThreadId);
      // One-shot alias for the transcript pane: it keeps per-thread scroll
      // bookkeeping keyed by thread id, and must rekey it (same logical
      // thread, new public id) instead of treating the promotion as a thread
      // switch — which would jump-bottom and briefly re-enable live follow on
      // top of the freshly send-anchored message. Only this send path KNOWS
      // it's a promotion; a pending→other-id transition seen by the pane alone
      // could also be the user switching threads.
      state.promotedThreadAlias = { from: threadId, to: promotedThreadId };
      clearTranscriptHydration(state);
      applyRenderedSession(state.realSession);
    }
    return true;
  } catch (error) {
    renderLog(`Remote send failed: ${error.message}`);
    // Filed against the thread this send targeted (captured above), not the
    // live one: the user can switch sessions while the request is in flight,
    // and the reader only renders it while that thread is on screen.
    setComposerError(threadId, error.message);
    return false;
  }
}

/**
 * Publish (or clear, with an empty message) one thread's composer failure. The
 * relay's own message is kept verbatim — it names the thread and the reason,
 * which is the entire value of showing it at all. Keyed by thread so a request
 * settling late can only ever affect the thread it was aimed at; see
 * shared/composer-errors.js.
 */
function setComposerError(threadId, message) {
  patchRemoteState({
    composerErrors: withThreadError(state.composerErrors, threadId, message),
  });
}

export async function stopActiveTurn() {
  // Name the active thread's own provider — never a hardcoded "Codex".
  const agentName = providerLabel(state.session?.provider) || "agent";
  if (!state.session?.active_thread_id || !state.session.active_turn_id) {
    renderLog(`There is no running ${agentName} turn to stop.`);
    return false;
  }

  try {
    await dispatchOrRecover("stop_turn", {
      input: {
        thread_id: state.session.active_thread_id,
      },
    });
    renderLog(`Remote stop request sent to ${agentName}.`);
    return true;
  } catch (error) {
    renderLog(`Remote stop failed: ${error.message}`);
    return false;
  }
}

export async function takeOverControl() {
  const threadId = state.session?.active_thread_id || null;
  if (!threadId) {
    renderLog("There is no session to take over.");
    return false;
  }
  try {
    await dispatchOrRecover("take_over", {
      input: { thread_id: threadId },
    });
    return true;
  } catch (error) {
    renderLog(`Take over failed: ${error.message}`);
    return false;
  }
}

export async function submitDecision(decision, scope) {
  if (!state.currentApprovalId) {
    renderLog("No pending approval to submit.");
    return;
  }

  try {
    await dispatchOrRecover("decide_approval", {
      request_id: state.currentApprovalId,
      input: {
        decision,
        scope,
      },
    });
  } catch (error) {
    renderLog(`Approval failed: ${error.message}`);
  }
}

// Submit the user's answer to a pending AskUserQuestion via the broker
// remote_action channel. `answers` is the {questionText: label | label[] | freeText}
// map the SDK expects in updatedInput.answers.
export async function submitAskUserAnswer(requestId, answers) {
  if (!requestId) {
    renderLog("No pending AskUserQuestion to answer.");
    return;
  }
  try {
    await dispatchOrRecover("submit_ask_user_answer", {
      request_id: requestId,
      input: { answers },
    });
  } catch (error) {
    renderLog(`AskUserQuestion submit failed: ${error.message}`);
    throw error;
  }
}

export async function fetchAskUserQuestionDetail(requestId) {
  if (!requestId) {
    return null;
  }
  const result = await dispatchOrRecover("fetch_ask_user_question_detail", {
    request_id: requestId,
  });
  return result.ask_user_question_detail?.request || null;
}

export async function applyFileChange(itemId, direction) {
  if (!itemId) {
    renderLog("No file change selected.");
    return;
  }
  const threadId = state.session?.active_thread_id;
  if (!threadId) {
    renderLog("No session is selected.");
    return;
  }

  renderLog(`${direction === "rollback" ? "Rolling back" : "Reapplying"} file change ${itemId}`);

  try {
    await dispatchOrRecover("apply_file_change", {
      item_id: itemId,
      input: {
        direction,
        thread_id: threadId,
      },
    });
  } catch (error) {
    renderLog(`File change action failed: ${error.message}`);
  }
}

// The session this remote surface is currently viewing (a view-only pin, else the
// active thread). Shared so the diff request and its refetch-trigger key agree.
export function getRemoteViewedThreadId() {
  return viewOnlyThreadId || state.session?.active_thread_id || null;
}

// Identity of the viewed workspace (thread + birth cwd + remembered tree).
export function getRemoteViewedWorkspaceKey() {
  return sessionViewedWorkspaceKey(state.session, getRemoteViewedThreadId());
}

export async function fetchRemoteWorkspaceDiff({ viewRoot = null } = {}) {
  const threadId = getRemoteViewedThreadId();
  const payload = {};
  if (threadId) payload.thread_id = threadId;
  // Diff preview only — never a session pin.
  if (viewRoot) payload.view_root = viewRoot;
  const result = await dispatchOrRecover("fetch_workspace_diff", payload);
  return result.workspace_diff;
}

// Not claim-gated: a paired device must see where a session is without taking control.
// `rootsStatus` costs the relay a `git status` per worktree, so only the open picker —
// the one thing that displays those counts — asks for it.
export async function fetchRemoteThreadWorkspace(threadId, options = null) {
  if (!threadId) return null;
  const result = await dispatchOrRecover("fetch_thread_workspace", {
    thread_id: threadId,
    roots_status: Boolean(options?.rootsStatus),
  });
  return result.thread_workspace || null;
}

// Pin (`cwd`) or unpin (`null`). No session claim: relay-owned, like rename_thread.
export async function setRemoteThreadWorkspace(threadId, cwd) {
  if (!threadId) return null;
  const result = await dispatchOrRecover("set_thread_workspace", {
    thread_id: threadId,
    cwd: cwd || null,
  });
  return result.thread_workspace || null;
}

// Cross-agent review actions over the broker. Each ack carries no snapshot, so
// we follow up with syncRemoteSnapshot to refresh review_activity/revisions.
export async function requestRemoteReview({
  reviewerProvider,
  reviewerModel,
  reviewerEffort,
  instructions,
  reviewerThreadId,
  parentThreadId,
  maxRounds,
  recapSource,
} = {}) {
  if (!reviewerProvider) {
    renderLog("Pick a reviewer provider before starting a review.");
    return false;
  }
  renderLog(
    reviewerThreadId
      ? `Requesting ${reviewerProvider} re-review.`
      : `Requesting ${reviewerProvider} review.`
  );
  try {
    await dispatchOrRecover("request_review", {
      input: {
        reviewer_provider: reviewerProvider,
        reviewer_model: reviewerModel || null,
        // Optional reasoning-effort override (clean or reuse).
        reviewer_effort: reviewerEffort || null,
        instructions: instructions || null,
        // Phase 3: reuse an existing reviewer thread when chosen.
        reviewer_thread_id: reviewerThreadId || null,
        // The thread to review (the viewed thread). null defaults to the active thread.
        parent_thread_id: parentThreadId || null,
        // How to brief the reviewer ("last_message" default vs "recap").
        recap_source: recapSource || "last_message",
        // Phase 5: round budget for the iterative reviewer↔author loop.
        max_rounds: maxRounds || 1,
      },
    });
    await syncRemoteSnapshot("post-review-request", true);
    return true;
  } catch (error) {
    // Log AND re-raise so the request modal can show the relay's reason inline
    // (mirrors the local lifecycle path); a rejected review is no longer a silent
    // no-op the user only finds in the activity log.
    renderLog(`Remote review request failed: ${error.message}`);
    throw error;
  }
}

export async function startRemoteWorkflow({
  taskPrompt,
  reviewerProvider,
  reviewerModel,
  reviewerInstructions,
  maxRounds,
  anchorItemId,
  parentThreadId,
} = {}) {
  if (!taskPrompt?.trim()) {
    renderLog("Enter a task before starting Code Flow.");
    return false;
  }
  if (!reviewerProvider) {
    renderLog("Pick a reviewer provider before starting Code Flow.");
    return false;
  }
  renderLog(`Starting Code Flow with ${reviewerProvider} reviewer.`);
  try {
    await dispatchOrRecover("start_workflow", {
      input: {
        workflow_id: "code_flow",
        task_prompt: taskPrompt.trim(),
        reviewer_provider: reviewerProvider,
        reviewer_model: reviewerModel || null,
        reviewer_instructions: reviewerInstructions || null,
        max_rounds: maxRounds || 2,
        anchor_item_id: anchorItemId || null,
        parent_thread_id: parentThreadId || null,
      },
    });
    await syncRemoteSnapshot("post-workflow-start", true);
    return true;
  } catch (error) {
    renderLog(`Remote Code Flow start failed: ${error.message}`);
    throw error;
  }
}

// Fetch the reviewer panel's dedicated, UNCOMPACTED data (review cards + reviewer threads
// + revision) over the broker `fetch_reviews` action — decoupled from the byte-budgeted
// snapshot so the panel survives live-turn compaction. Read-only; no session claim.
export async function fetchRemoteReviews() {
  const result = await dispatchOrRecover("fetch_reviews", {});
  return result?.reviews || null;
}

export async function fetchRemoteWorkflows() {
  const result = await dispatchOrRecover("fetch_workflows", {});
  return result?.workflows || null;
}

export async function fetchRemoteDevices() {
  const result = await dispatchOrRecover("fetch_devices", {});
  return result?.devices || null;
}

export async function resolveRemoteReview(reviewJobId) {
  renderLog("Stopping the blocked reviewer…");
  try {
    await dispatchOrRecover("resolve_review", { review_job_id: reviewJobId });
    await syncRemoteSnapshot("post-review-resolve", true);
    return true;
  } catch (error) {
    renderLog(`Remote resolve failed: ${error.message}`);
    return false;
  }
}

export async function resolveRemoteWorkflow(workflowRunId) {
  renderLog("Stopping the blocked Code Flow…");
  try {
    await dispatchOrRecover("resolve_workflow", { workflow_run_id: workflowRunId });
    await syncRemoteSnapshot("post-workflow-resolve", true);
    return true;
  } catch (error) {
    renderLog(`Remote Code Flow resolve failed: ${error.message}`);
    return false;
  }
}

export async function deleteRemoteReview(reviewId) {
  if (!reviewId) {
    renderLog("No review to delete.");
    return false;
  }
  renderLog("Deleting review…");
  try {
    await dispatchOrRecover("delete_review", { review_id: reviewId });
    await syncRemoteSnapshot("post-review-delete", true);
    return true;
  } catch (error) {
    renderLog(`Remote delete failed: ${error.message}`);
    return false;
  }
}

// Load a reviewer thread's transcript so the Reviewer tab can show its findings.
// Reuses the standard transcript page fetch (fetch_thread_transcript).
export async function fetchRemoteThreadTranscript(threadId) {
  if (!threadId) {
    return [];
  }
  const page = await fetchTranscriptPage({ threadId, before: null });
  return reviewerPreviewEntriesFromPage(state.session, page);
}

export function clearSessionRuntime() {
  // Discards any pending window projection too (invalidateViewOnlyNavigation
  // clears transcriptWindowProjectionPending) — a genuine reset, not a thread
  // switch, so there is nothing left worth materialising it into.
  invalidateViewOnlyNavigation();
  state.realSession = null;
  clearTranscriptHydration(state);
  // Thread ids are only unique within one relay, so a repair marked in flight (or failed)
  // against thread X here would attach itself to a different relay's thread X after a
  // switch or a re-pair — a button stuck spinning, or someone else's error under it.
  // The verdict itself needs no clearing: it rides the snapshot, so the new relay's first
  // one replaces it.
  state.workspaceRepairByThread = new Map();
  publishWorkspaceRepair();
}

async function sendHeartbeat() {
  const liveSession = state.session?.view_only ? state.realSession : state.session;
  if (
    !liveSession?.active_thread_id
    || !isCurrentDeviceActiveController(liveSession)
  ) {
    return;
  }

  try {
    await dispatchRemoteActionWithoutReply("heartbeat", {
      input: {},
    });
  } catch (error) {
    renderLog(`Remote heartbeat failed: ${error.message}`);
  }
}

async function hydrateActiveTranscript(snapshot) {
  return hydrateRemoteTranscript(state, snapshot, {
    fetchPage: fetchTranscriptPage,
    onProgress(hydratedSnapshot) {
      applyRenderedSession(hydratedSnapshot, {
        hydrateTranscript: false,
      });
    },
    onError(error) {
      renderLog(`Remote full transcript sync failed: ${error.message}`);
    },
  });
}

export async function maybeLoadOlderTranscriptHistory() {
  // The IntersectionObserver in react-app.js fires when the sentinel comes
  // within ~600px of the top edge, so we drop the manual scrollTop check
  // here — the observer's rootMargin is the prefetch trigger.
  const transcript = remoteUiRefs.remoteTranscript;
  if (!transcript) {
    return null;
  }

  return loadOlderRemoteTranscript(state, {
    fetchPage: fetchTranscriptPage,
    onProgress(hydratedSnapshot) {
      applyRenderedSession(hydratedSnapshot, {
        hydrateTranscript: false,
      });
    },
    onError(error) {
      renderLog(`Remote older transcript sync failed: ${error.message}`);
    },
  });
}

export async function fetchTranscriptEntryDetail(threadId, itemId) {
  return fetchTranscriptEntryDetailRequest({
    itemId,
    threadId,
  });
}

function applyRenderedSession(
  session,
  { hydrateTranscript = true, hydrationSnapshot = session } = {}
) {
  const previousThreadId = state.session?.active_thread_id || "-";
  // Every call here is a direct, synchronous render — the same "render now,
  // nothing pending after" invariant the scheduler exists to keep. Without
  // this, a delta timer left over from before a thread switch, a hydration
  // progress step, a promotion, or a settings update fires later and renders
  // a second time on top of what this call already painted.
  //
  // settleTranscriptProjection materialises into state.realSession/state.session,
  // not necessarily into THIS `session` — many callers build a fresh
  // `{...state.session, overrides}` copy (updateRemoteSessionSettings) captured
  // BEFORE the settle below runs, carrying its stale pre-projection array
  // through the spread. adoptSettledTranscript recognises "the same thread
  // settle just rebuilt" by id, not by array identity (a rebuilt array is not
  // a reliable "still pending" signal — see settleTranscriptProjection's own
  // doc), and adopts the freshly-settled transcript into it. Checks
  // state.realSession before state.session, same order as the old inline check.
  const settled = settleTranscriptProjection();
  const flushedSession = adoptSettledTranscript(state, session, settled, ["realSession", "session"]);
  transcriptFlushScheduler.cancel();
  renderSession(flushedSession);
  const message = `[session-state] renderSession prev=${previousThreadId} next=${flushedSession?.active_thread_id || "-"} state=${state.session?.active_thread_id || "-"} entries=${flushedSession?.transcript?.length || 0} hydrate=${hydrateTranscript ? "1" : "0"} hydration_input=${hydrationSnapshot?.active_thread_id || "-"}`;
  renderLog(message);
  // TODO(remote-monitor-debug): Remove this console mirror once session rendering is stable.
  console.log(message);
  scheduleClaimRefresh();
  if (hydrateTranscript) {
    void hydrateActiveTranscript(hydrationSnapshot);
  }
}

export { sendHeartbeat };
