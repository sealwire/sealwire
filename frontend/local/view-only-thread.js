// View-only thread pin for the LOCAL surface: pure state helpers behind the
// read-only projection of a thread the user is looking at while the relay's
// single active thread is something else.
//
// This generalizes what used to be a review-only mechanism. Navigation/viewing
// must never mutate the relay's global active_thread_id (that is what resume
// does, and it moves the active thread for every connected client). So:
//   - viewing any non-active thread renders a read-only projection fed by a
//     "pin" { threadId, entries, olderCursor, ... } loaded over the normal
//     transcript-page API (cache-aware);
//   - scroll-up pagination merges older pages into the pin;
//   - sending is the only action that takes control; viewing never resumes.
//
// The app glue (frontend/app.js) owns fetching/generations; render-session.js
// applies projectViewOnlySession() to the rendered session only — state.session
// always stays the REAL session so heartbeat/lease/controller logic is untouched.

import { absorbWithdrawnById } from "../shared/withdrawn-transcript.js";
import {
  isReviewInProgress,
  isReviewInProgressForThread,
} from "../shared/review-state.js";
import {
  selectDisplayedSession,
  serverTimeSeconds,
} from "../shared/session-view-model.js";
import { reduceTranscriptDeltaEvent } from "../shared/transcript-event-reducer.js";

// Any non-active thread can be viewed read-only. (The active thread is live —
// projecting it would hide approvals/streaming, so it is never eligible.)
export function viewOnlyEligible(session, threadId) {
  return Boolean(
    threadId && session && threadId !== session.active_thread_id
  );
}

export function viewOnlyThreadIsWorking(session, threadId) {
  return Boolean(
    (session?.thread_activity || []).find((entry) => entry?.thread_id === threadId)
  );
}

// `thread_activity` can omit a background thread that is still receiving deltas
// (Cursor is the usual case). The pin reducer sets `wasWorking` when text
// arrives; clobbering that with `thread_activity` alone at fetch start drops
// the working→idle edge `maybeRefreshViewOnly` keys on.
export function resolveViewOnlyPinWasWorking({ prior, isWorking }) {
  return Boolean(isWorking || prior?.wasWorking);
}

// After a non-terminal fetch completes, keep the edge alive until a terminal
// refresh lands. A fetch started from `shouldRefreshViewedThread` has seen the
// edge already and may clear the latch on completion.
export function resolveViewOnlyPinWasWorkingAfterFetch({
  prior,
  isWorking,
  terminal = false,
}) {
  if (terminal && !prior?.deltaDuringFetch) {
    return Boolean(isWorking);
  }
  return resolveViewOnlyPinWasWorking({ prior, isWorking });
}

/**
 * Apply a live transcript delta to a view-only pin.
 *
 * A pinned thread used to be a POLLED snapshot: the relay streamed deltas only for
 * the single globally-active thread, so watching a background thread meant re-fetching
 * a transcript page and watching text arrive in lumps. Now that the relay streams every
 * watched thread, a delta for the pinned thread belongs in the pin's own entries.
 *
 * Pure: returns a NEW pin when the delta applies, or the SAME pin object when it does
 * not, so callers can use identity to decide whether to re-render.
 *
 * @param {object|null} pin
 * @param {object} event transcript_entry_delta payload
 * @returns {object|null}
 */
export function applyDeltaToViewOnlyPin(pin, event) {
  if (!pin || !event?.item_id || !Array.isArray(pin.entries)) {
    return pin;
  }
  const outcome = reduceTranscriptDeltaEvent({
    session: {
      active_thread_id: pin.threadId,
      transcript: pin.entries,
      transcript_revision: pin.transcriptRevision,
    },
    event,
    currentThreadId: pin.threadId,
    requireEventThreadId: true,
  });

  if (outcome.kind === "noop" || outcome.kind === "duplicate") {
    return pin;
  }

  if (outcome.kind === "needs_repair") {
    // A gap (earlier text missing) or a divergence (same range, different
    // bytes). Splicing either would corrupt the body, so refusing is right --
    // but refusing SILENTLY left the hole for whatever refreshed next, and the
    // thing that used to refresh next was a 300ms poll. Say so instead, exactly
    // as the conversation does (transcript-hydration-store.js:829-835):
    // downgrade the body so it is not treated as authoritative, and raise a
    // flag the refresh decision can act on in this frame rather than at the end
    // of the turn.
    const duringFetch = pin.loading ? { deltaDuringFetch: true } : {};
    if (outcome.entryIndex < 0) {
      // We hold nothing for this item and the chunk does not start at 0, so its
      // opening text never arrived. Nothing to downgrade; the pin still needs a
      // page before it can render this entry at all.
      return { ...pin, tailGap: true, ...duringFetch };
    }
    return {
      ...pin,
      tailGap: true,
      ...duringFetch,
      entries: pin.entries.map((entry, position) =>
        position === outcome.entryIndex ? { ...entry, content_state: "preview" } : entry
      ),
    };
  }

  return {
    ...pin,
    entries: outcome.nextTranscript,
    // A pin carrying live deltas is by definition mid-turn. Without this the
    // projection can report the thread idle while text is still arriving, which is
    // what made a watched background thread look finished when it wasn't.
    activeTurnId: pin.activeTurnId || event.turn_id || null,
    wasWorking: true,
    ...(pin.loading ? { deltaDuringFetch: true } : {}),
  };
}

export function buildViewOnlyPin({
  threadId,
  page = null,
  generation = 0,
  review = false,
  workflowLocked = false,
  reviewSig = null,
  cwd = null,
  threadWorkspaceCwd = null,
  provider = null,
  settings = null,
  settingsWritable = false,
  activeTurnId = null,
  currentStatus = null,
  currentPhase = null,
  currentTool = null,
  lastProgressAt = null,
  availableModels = [],
  status = null,
  lastRefreshAt = 0,
  lastRefreshServerTime = null,
  wasWorking = false,
  reviewerThreads = undefined,
  priorEntries = [],
  priorOlderCursor = null,
  historyExtended = false,
  loading = false,
  error = false,
  relayGeneration = "",
}) {
  const pin = {
    threadId,
    entries: page ? page.entries || [] : priorEntries,
    olderCursor: page ? page.prev_cursor ?? null : priorOlderCursor,
    generation,
    // Which RUN of the relay these item ids came from — distinct from `generation`
    // above, which counts this client's own navigations. A restart renumbers ids, so
    // a pin built under an earlier run describes these messages under names the relay
    // no longer uses.
    relayGeneration,
    review,
    workflowLocked,
    reviewSig,
    // The viewed thread's own metadata, from its thread summary. The projection
    // uses these so a cross-workspace saved thread shows ITS workspace/provider
    // rather than the live thread's. The summary carries no model/effort/policy,
    // so the projection blanks those (blank/unknown beats impersonating live).
    cwd,
    threadWorkspaceCwd,
    provider,
    settings,
    settingsWritable,
    activeTurnId,
    currentStatus,
    currentPhase,
    currentTool,
    lastProgressAt,
    availableModels,
    status,
    lastRefreshAt,
    lastRefreshServerTime,
    wasWorking,
    // True once the top-sentinel loader has prepended at least one older page.
    // Working-tail refreshes must preserve that prefix instead of collapsing
    // the view back to the latest transport page every 300ms.
    historyExtended,
    loading,
    // True when the last load for this pin FAILED (fetch error). Lets the
    // self-heal decision retry it after a backoff instead of treating the empty
    // shell as a settled, complete view forever. See viewOnlySelfHealThreadId.
    error,
  };
  if (reviewerThreads !== undefined) {
    pin.reviewerThreads = Array.isArray(reviewerThreads) ? reviewerThreads : [];
  }
  return pin;
}

// How long to wait before a render re-arms a view-only load that previously
// FAILED. Long enough that a tight failure loop can't form (a failed fetch
// re-renders synchronously), short enough that the next snapshot after the relay
// comes back recovers the view promptly.
export const VIEW_ONLY_LOAD_RETRY_BACKOFF_MS = 1000;

// Decide whether a render should (re)arm a view-only transcript load for the
// thread the user is looking at. app.js's maybeRefreshViewOnly() calls this and
// fires loadViewOnlyTranscript() for the returned thread id (or does nothing for
// null). Pure so the navigation/self-heal contract is unit-testable.
//
// The viewed thread renders only when a pin projects it (the snapshot carries
// only the ACTIVE thread's transcript), so a non-active viewed thread MUST keep a
// good pin. The old code armed the load "once per navigated thread" and never
// reset that guard, so a single missed/failed load (a rapid-switch race dropped
// it, or the relay was unreachable) left the thread stuck on "Loading session"
// forever. Instead, re-arm whenever there is no good pin and no load is in
// flight — with a backoff on failures so a failing fetch (which re-renders
// synchronously) can't form a tight loop.
export function viewOnlySelfHealThreadId(
  session,
  { viewThreadId, viewOnlyThread, now = 0 } = {}
) {
  if (!viewThreadId || !session || !viewOnlyEligible(session, viewThreadId)) {
    return null;
  }
  const pin = viewOnlyThread;
  const pinMatches = pin?.threadId === viewThreadId;
  // loadViewOnlyTranscript() sets a loading pin synchronously before its fetch,
  // so a matching loading pin means a load is already in flight — don't double-fire.
  if (pinMatches && pin.loading) {
    return null;
  }
  // A settled, non-failed pin already projects the thread — nothing to do.
  if (pinMatches && !pin.error) {
    return null;
  }
  // A failed pin: retry, but only after the backoff elapses.
  if (
    pinMatches &&
    pin.error &&
    now - (pin.lastRefreshAt || 0) < VIEW_ONLY_LOAD_RETRY_BACKOFF_MS
  ) {
    return null;
  }
  // No pin, a stale pin for another thread, or a failed pin past its backoff:
  // (re)arm the load so the viewed thread can finally render.
  return viewThreadId;
}

function snapshotServerTime(session) {
  return serverTimeSeconds(session?.server_time);
}

function pinServerTime(pin) {
  return serverTimeSeconds(pin?.lastRefreshServerTime);
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(Object(object), property);
}

// Prepend an older history page into the pin. Entries already present (by
// item_id) are dropped so an overlapping page can't duplicate; a page for a
// different thread is ignored outright (stale response after navigation).
export function mergeOlderViewOnlyPage(pin, page) {
  if (!pin || !page || page.thread_id !== pin.threadId) {
    return pin;
  }
  const existingIds = new Set(
    (pin.entries || []).map((entry) => entry?.item_id).filter(Boolean)
  );
  const older = (page.entries || []).filter(
    (entry) => !entry?.item_id || !existingIds.has(entry.item_id)
  );
  // A dropped duplicate may carry the tombstone the pin's copy predates.
  const overlapping = (page.entries || []).filter(
    (entry) => entry?.item_id && existingIds.has(entry.item_id)
  );
  return {
    ...pin,
    entries: [...older, ...absorbWithdrawnById(pin.entries || [], overlapping)],
    historyExtended: true,
    olderCursor: page.prev_cursor ?? null,
  };
}

// Reconcile a freshly fetched working-thread tail with history that the reader
// already paged in above it. Transcript transport pages are byte-sized, while
// dozens of adjacent tool calls collapse into one visual row; replacing the pin
// with only the fresh tail can therefore turn a scrollable transcript back into
// two or three rows on every 300ms refresh.
//
// Preserve the older prefix only after pagination actually extended the pin.
// This keeps the normal live-tail window bounded for readers who never loaded
// history, while retaining the reader's loaded context once they did.
export function mergeRefreshedViewOnlyPage(pin, page) {
  if (pin && page && page.thread_id !== pin.threadId) {
    // A stale response must never be relabeled as the requested thread. Keep
    // the current pin intact; the caller can reject/retry the mismatched load.
    return {
      entries: Array.isArray(pin.entries) ? pin.entries : [],
      historyExtended: Boolean(pin.historyExtended),
      olderCursor: pin.olderCursor ?? null,
    };
  }

  const freshEntries = Array.isArray(page?.entries) ? page.entries : [];
  const priorEntries = Array.isArray(pin?.entries) ? pin.entries : [];
  const historyExtended = Boolean(pin?.historyExtended);

  // Nothing authoritative arrived. Keeping the pin is the only safe move: this
  // used to return the empty page and wipe the conversation.
  if (!page || freshEntries.length === 0) {
    return {
      entries: priorEntries,
      historyExtended,
      olderCursor: pin?.olderCursor ?? page?.prev_cursor ?? null,
    };
  }
  if (priorEntries.length === 0) {
    // Nothing retained, so no history is being held open any more.
    return { entries: freshEntries, historyExtended: false, olderCursor: page.prev_cursor ?? null };
  }
  // The page's copies replace the pin's; a tombstone only the pin knows must ride along.
  const freshAbsorbed = absorbWithdrawnById(freshEntries, priorEntries);

  // Split what the pin holds around the window this page covers. The page is
  // authoritative INSIDE its window and says nothing outside it, so entries the
  // delta stream appended after the page was built are still ours to keep.
  const freshIds = new Set(freshEntries.map((entry) => entry?.item_id).filter(Boolean));
  let firstOverlap = -1;
  let lastOverlap = -1;
  priorEntries.forEach((entry, index) => {
    if (entry?.item_id && freshIds.has(entry.item_id)) {
      if (firstOverlap === -1) firstOverlap = index;
      lastOverlap = index;
    }
  });

  let prefix;
  let tail;
  if (lastOverlap === -1) {
    // No shared entry, so item ids cannot localize the page. `entry_seq` is
    // monotonic per thread, so use it to say which side of the window the pin's
    // entries fall on; without it, decline to guess and take the page alone.
    const freshMaxSeq = maxEntrySeq(freshEntries);
    const freshMinSeq = minEntrySeq(freshEntries);
    if (freshMaxSeq == null) {
      // Cannot prove where the pin's entries sit relative to this page, so take
      // the authoritative tail alone and let the top loader rebuild history
      // from its cursor. Nothing is retained, so history is no longer extended.
      return {
        entries: freshAbsorbed,
        historyExtended: false,
        olderCursor: page.prev_cursor ?? null,
      };
    }
    prefix = priorEntries.filter((entry) => entrySeq(entry) != null && entrySeq(entry) < freshMinSeq);
    tail = priorEntries.filter((entry) => entrySeq(entry) != null && entrySeq(entry) > freshMaxSeq);
  } else {
    prefix = priorEntries
      .slice(0, firstOverlap)
      .filter((entry) => !entry?.item_id || !freshIds.has(entry.item_id));
    tail = priorEntries
      .slice(lastOverlap + 1)
      .filter((entry) => !entry?.item_id || !freshIds.has(entry.item_id));
  }

  // The bound the `historyExtended` gate was always for: transport pages are
  // byte-sized while dozens of adjacent tool calls collapse into one visual row,
  // so retaining every older page forever would grow the window without limit
  // for a reader who never scrolled. It is the OLD end that has to be trimmed.
  // Trimming the new end instead is what dropped the reader's own message: the
  // tail is exactly what the stream appended since this page was built.
  return {
    entries: [...(historyExtended ? prefix : []), ...freshAbsorbed, ...tail],
    historyExtended: historyExtended && prefix.length > 0,
    olderCursor: historyExtended ? pin?.olderCursor ?? null : page.prev_cursor ?? null,
  };
}

function entrySeq(entry) {
  return Number.isSafeInteger(entry?.entry_seq) ? entry.entry_seq : null;
}

function minEntrySeq(entries) {
  const seqs = entries.map(entrySeq).filter((seq) => seq != null);
  return seqs.length ? Math.min(...seqs) : null;
}

function maxEntrySeq(entries) {
  const seqs = entries.map(entrySeq).filter((seq) => seq != null);
  return seqs.length ? Math.max(...seqs) : null;
}

// Read-only projection of the real session for rendering. Mirrors the remote
// surface's view-only shape: the rendered session's active_thread_id IS the
// viewed thread, so every downstream consumer (transcript, details, scroll,
// truncation indicator) works unchanged. transcript_truncated reflects the
// pin's pagination cursor so the scroll-up history loader arms itself.
export function projectViewOnlySession(realSession, { viewThreadId, viewOnlyThread } = {}) {
  return selectDisplayedSession({
    liveSession: realSession,
    viewedThreadId: viewThreadId,
    viewedThread: viewOnlyThread
      ? (() => {
        const settings = viewOnlyThread.settings || {};
        const viewedThread = {
          threadId: viewOnlyThread.threadId,
          entries: viewOnlyThread.entries || [],
          olderCursor: viewOnlyThread.olderCursor,
          activeTurnId: viewOnlyThread.activeTurnId || null,
          currentStatus: viewOnlyThread.currentStatus,
          currentPhase: viewOnlyThread.currentPhase ?? null,
          currentTool: viewOnlyThread.currentTool ?? null,
          lastProgressAt: viewOnlyThread.lastProgressAt ?? null,
          currentCwd: viewOnlyThread.cwd ?? "",
          threadWorkspaceCwd: viewOnlyThread.threadWorkspaceCwd ?? "",
          provider: viewOnlyThread.provider ?? "",
          model: settings.model || "",
          reasoningEffort: settings.reasoning_effort || "",
          approvalPolicy: settings.approval_policy || "",
          sandbox: settings.sandbox || "",
          availableModels: viewOnlyThread.availableModels || [],
          reviewLocked: Boolean(viewOnlyThread.review),
          workflowLocked: Boolean(viewOnlyThread.workflowLocked),
          settingsWritable: Boolean(viewOnlyThread.settingsWritable),
          status: viewOnlyThread.status,
          refreshServerTime: pinServerTime(viewOnlyThread),
        };
        if (hasOwn(viewOnlyThread, "reviewerThreads")) {
          viewedThread.reviewerThreads = Array.isArray(viewOnlyThread.reviewerThreads)
            ? viewOnlyThread.reviewerThreads
            : [];
        }
        return viewedThread;
      })()
      : null,
    liveActivityServerTime: snapshotServerTime(realSession),
  });
}

// Decide what to do with the pin on each render. Returns { kind }:
//   "none"    — keep the pin as is
//   "release" — drop the pin (thread became active, or user navigated away)
//   "refresh" — re-fetch the pinned transcript (review advanced)
//
// CRITICAL: a general (non-review) pin never resolves to "resume". Auto-resuming
// would mutate the relay's global active thread as a side effect of merely
// looking at a thread — the exact cross-client coupling this feature removes.
export function viewOnlyPinNextAction(session, pin, { viewThreadId, reviewSignature } = {}) {
  if (!pin || !session) {
    return { kind: "none" };
  }
  // Built under a different run of the relay: its ids name these messages differently
  // now, so refetch rather than keep merging into it. Checked before everything below,
  // because a stale pin is stale whatever else is true of it.
  //
  // Strict, like the page rule — including "one side has a value and the other does
  // not", which is the old-relay-to-new-relay upgrade. It terminates: the refresh it
  // asks for rebuilds the pin stamped with the live generation, and that pin matches.
  if ((pin.relayGeneration || "") !== (session.transcript_generation || "")) {
    return viewThreadId === pin.threadId ? { kind: "refresh" } : { kind: "release" };
  }
  if (pin.threadId === session.active_thread_id) {
    return { kind: "release" };
  }
  if (pin.review) {
    const signature =
      typeof reviewSignature === "function"
        ? reviewSignature(session, pin.threadId)
        : null;
    const dedicatedReviewKnown = signature != null;
    const dedicatedReviewActive = dedicatedReviewKnown && signature !== "none";
    const reviewStillActive =
      isReviewInProgress(session)
      && (
        isReviewInProgressForThread(session, pin.threadId)
        || dedicatedReviewActive
        || (!dedicatedReviewKnown && pin.review)
      );
    if (!reviewStillActive) {
      return viewThreadId === pin.threadId ? { kind: "refresh" } : { kind: "release" };
    }
    if (
      !pin.loading &&
      dedicatedReviewActive &&
      pin.reviewSig !== signature
    ) {
      return { kind: "refresh" };
    }
    return { kind: "none" };
  }
  if (viewThreadId !== pin.threadId) {
    return { kind: "release" };
  }
  return { kind: "none" };
}

// NOTE: the composer's send path is now a single atomic, thread-targeted request
// (see app.js runComposerSubmit → lifecycle.js sendMessage(text, threadId)). The
// relay sends directly to the target thread and moves control after success, so
// the old front-end "resume → verify → send" coordinator (viewOnlySubmitAction /
// runViewOnlyComposerSubmit) is no longer needed and was removed.
