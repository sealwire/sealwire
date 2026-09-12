import {
  transcriptDeltaIsFromAnotherGeneration,
  transcriptDeltaMatchesGeneration,
  transcriptPageIsFromAnotherGeneration,
} from "../../shared/transcript-generation.js";
import { transcriptRowKey } from "../../shared/transcript-row-key.js";
import { openSessionStream, sessionStreamUrl } from "../../session-stream.js";
import { applyDeltaToViewOnlyPin } from "../view-only-thread.js";
import {
  appendTranscriptDelta,
  applyEntryPatchToWindow,
  invalidateTranscriptWindowForRepair,
  markTranscriptWindowProjectionPending,
  mergeTranscriptHydrationPage,
  settleTranscriptProjection,
  transcriptWindowIsLoaded,
  __recordTranscriptFullRebuild,
  __readTranscriptFullRebuildCount,
  __resetTranscriptFullRebuildCount,
} from "../transcript/store.js";
import {
  normalizeTranscriptDeltaKind,
  reduceTranscriptDeltaEvent,
  reduceTranscriptEntryPatchEvent,
  transcriptEventThreadId,
} from "../../shared/transcript-event-reducer.js";

// Re-exported so existing test imports (`from "./stream.js"`) keep working —
// the counter itself now lives in transcript/store.js, since that is where
// the deferred window-projection rebuild site (settleTranscriptProjection)
// lives. This file's own pre-hydration-fallback rebuild site (below) records
// to the SAME counter via __recordTranscriptFullRebuild, matching
// transcriptFullWindowCopyCount's one-counter-many-sites shape
// (frontend/shared/transcript-hydration-store.js:115).
export { __readTranscriptFullRebuildCount, __resetTranscriptFullRebuildCount };

export function createStreamController(ctx) {
  const {
    state,
    logLine,
    seedDefaults,
    renderSession,
    handleUnauthorized,
  } = ctx;
  const applySessionSnapshot = (...args) => ctx.applySessionSnapshot(...args);
  // Resolved lazily: the controller is built before the transcript controller exists.
  const ensureConversationTranscript = (...args) =>
    ctx.ensureConversationTranscript?.(...args);
  const fetchFreshTranscriptPage = (...args) => ctx.fetchFreshTranscriptPage?.(...args);
  const cancelSessionPoll = (...args) => ctx.cancelSessionPoll(...args);
  const cancelStreamReconnect = (...args) => ctx.cancelStreamReconnect(...args);
  const scheduleSessionPoll = (...args) => ctx.scheduleSessionPoll(...args);
  const scheduleStreamReconnect = (...args) => ctx.scheduleStreamReconnect(...args);
  const transcriptFlushScheduler = ctx.transcriptFlushScheduler;

  function queueTranscriptRender(nextSession, chars = 0) {
    // State advances synchronously so another delta arriving in this same frame
    // appends to the latest text instead of the last painted snapshot. Only the
    // expensive render is coalesced, by the scheduler shared with the snapshot
    // path (session-controller.js builds it; see applySessionSnapshot).
    state.session = nextSession;
    // queue() first: note()'s early-flush check only fires while a render is
    // already pending, so it must never be the thing that starts one.
    transcriptFlushScheduler.queue("transcript_entry_delta");
    if (chars > 0) {
      transcriptFlushScheduler.note(chars);
    }
  }

  /// Pull the authoritative transcript tail directly, bypassing the
  /// snapshot-truncation hydration gate. `ensureConversationTranscript`
  /// (session/transcript.js) is the WRONG tool for a per-item refusal: its
  /// gate (`prepareTranscriptHydrationState`, shared/transcript-hydration-
  /// store.js) fires off `snapshot.transcript_truncated` and the wire
  /// snapshot's own per-entry `content_state` — both server-computed
  /// signals a CLIENT-detected gap/mismatch/missing-head never touches, since
  /// it only downgrades this window's own cached copy. Worse,
  /// `selectHydrationSnapshot` (transcript/hydration.js) prefers the raw wire
  /// snapshot over the merged session whenever the thread matches, so even a
  /// hand-patched session passed in would be ignored. The refused item reads
  /// back `full` (or is entirely absent from the last snapshot) and
  /// `ensureConversationTranscript` silently no-ops — no fetch, ever, for
  /// this signal. Mirrors remote's repairActiveTranscriptTail
  /// (session-ops.js:697), which documents and bypasses the identical gate
  /// for the identical reason — including starting its fetch
  /// UNCONDITIONALLY, with no "is the user currently viewing this
  /// conversation" check of its own. This used to gate on
  /// `isViewingConversation`, which silently suppressed the repair whenever
  /// the active thread's own conversation route wasn't the screen on
  /// screen (e.g. the Tasks screen, or a different session) — the entry
  /// stayed downgraded forever, since nothing else ever retries a
  /// client-detected gap (P1 review).
  ///
  /// Uses fetchFreshTranscriptPage (session/transcript.js), NOT
  /// fetchTranscriptPage — the latter wraps every call in
  /// queryClient.fetchQuery, which deduplicates onto an in-flight request
  /// for the same key. A tail fetch that began BEFORE the gap can then
  /// satisfy this repair and hand back pre-gap data, with no post-gap
  /// request ever issued. fetchFreshTranscriptPage
  /// (shared/thread-queries.js's fetchThreadTranscriptPageFresh) evicts that
  /// exact query-cache key before fetching and re-seeds it with the fresh
  /// result afterward — eviction ALONE is not enough: a LATER hydration
  /// re-arm racing this repair would otherwise dedupe onto the very request
  /// this repair is trying to supersede, receive its pre-gap answer under
  /// an epoch captured AFTER the bump (so isRefusalEpochStale never catches
  /// it), and re-promote that stale body to `full` (P1 review).
  async function repairActiveTranscriptTail(threadId) {
    if (!threadId) {
      return;
    }
    // Captured BEFORE the fetch, same as the shared hydration driver's own
    // guard (shared/transcript-hydration.js's isRefusalEpochStale) — but
    // this repair's merge never goes through that driver, so it needs its
    // own capture+check. Two refusals for the same item in quick succession
    // each launch their own repair; without this, an OLDER repair resolving
    // AFTER a newer one could still overwrite the newer repair's already-
    // authoritative text via the merge's length tie-break (P1 review).
    const capturedRefusalEpoch = state.transcriptRefusalEpoch;
    let page;
    try {
      page = await fetchFreshTranscriptPage(threadId, { before: null });
    } catch (error) {
      logLine(`Transcript repair failed: ${error.message}`);
      return;
    }
    if (!page || page.thread_id !== threadId) {
      logLine("Transcript repair page response was incomplete.");
      return;
    }
    // The thread may have moved on while the fetch was in flight — a
    // legitimate no-op, not a failure to retry. NOT gated on
    // transcriptWindowIsLoaded: an unloaded window here is exactly the
    // cold-hydration case this repair also serves (deltas can arrive before
    // the first hydration ever loads a window) — the merge below bootstraps
    // the window from empty, the same way the very first hydration ever
    // does, and the flush after it settles that bootstrapped window onto
    // state.session.transcript. Discarding the fetch here instead left a
    // cold thread's gap permanently unrepaired: the fresh page was already
    // in hand and thrown away (P1 review).
    if (state.session?.active_thread_id !== threadId) {
      return;
    }
    if (capturedRefusalEpoch !== state.transcriptRefusalEpoch) {
      // A newer refusal (and its own repair) started while this fetch was in
      // flight. That repair is the authoritative one; this response predates
      // it and must not be allowed to win the merge's length tie-break.
      return;
    }
    if (transcriptPageIsFromAnotherGeneration(state.session, page)) {
      // The relay restarted while this was in flight; the page's ids name these
      // messages differently now (shared/transcript-generation.js). Merging it would
      // add a second row for each of them. The refusal that triggered this repair
      // stands, and the next one refetches under the current run.
      return;
    }
    // The SAME merge the gated hydration path itself uses for a tail
    // re-fetch (shared/transcript-hydration.js's hydrateTranscript) — this
    // only bypasses the decision of WHETHER to fetch, not how a fetched page
    // is reconciled into the window.
    mergeTranscriptHydrationPage(state, page, { prepend: false });
    markTranscriptWindowProjectionPending(state);
    transcriptFlushScheduler.flushNow("transcript_entry_delta_refused_repair");
  }

  function connectSessionStream() {
    if (state.authRequired && !state.authenticated) {
      return;
    }

    if (typeof fetch !== "function" || typeof AbortController === "undefined") {
      logLine("Fetch streaming is unavailable. Falling back to polling.");
      state.streamConnected = false;
      scheduleSessionPoll();
      return;
    }

    if (state.sessionStream) {
      state.sessionStream.close();
    }

    // A monotonic per-connection id. Wall-clock rather than a counter so it keeps
    // increasing across a page reload — a reset counter could not distinguish a reloaded
    // page from the one it replaced.
    state.surfaceGeneration = Date.now();
    const stream = openSessionStream({
      url: sessionStreamUrl(window.location.origin, {
        deviceId: state.deviceId,
        surfaceId: state.surfaceId,
        surfaceGeneration: state.surfaceGeneration,
      }),
      apiToken: state.apiToken,
      onSession(data) {
        try {
          const snapshot = JSON.parse(data);
          state.streamConnected = true;
          cancelSessionPoll();
          seedDefaults(snapshot);
          // Attention + notifications are handled inside applySessionSnapshot
          // (the chokepoint shared with the polling fallback).
          applySessionSnapshot(snapshot);
        } catch (error) {
          logLine(`Stream payload failed: ${error.message}`);
        }
      },
      onEvent({ data, type }) {
        try {
          applySessionStreamEvent(type, JSON.parse(data));
        } catch (error) {
          logLine(`Stream event failed: ${error.message}`);
        }
      },
      onOpen() {
        if (!state.streamConnected) {
          logLine("Session stream connected.");
        }
        // The relay drops a surface's watch set when its stream ends, so a reconnect
        // starts with no subscription. Forget what we think we declared, or the
        // dedupe would suppress the re-declaration and this tab's background threads
        // would silently fall back to polling.
        state.resetWatchedThreadsDeclaration?.();
        state.streamConnected = true;
        cancelSessionPoll();
        cancelStreamReconnect();
      },
      onError(error) {
        if (state.sessionStream !== stream) {
          return;
        }

        if (error?.code === "unauthorized") {
          state.sessionStream = null;
          handleUnauthorized("Local auth session expired. Sign in again.");
          return;
        }

        logLine("Session stream disconnected. Falling back to polling.");
        state.streamConnected = false;
        state.sessionStream = null;
        // Reflect the dropped stream in the sidebar footer status promptly, rather
        // than waiting for the next successful poll to re-render.
        if (state.session) {
          renderSession(state.session);
        }
        scheduleSessionPoll();
        scheduleStreamReconnect();
      },
    });
    state.sessionStream = stream;
  }

  function applySessionStreamEvent(type, event) {
    if (!state.session) {
      return;
    }
    const kind = event?.kind || type;
    if (kind === "transcript_stream_lagged") {
      // We missed delta frames. Our cached bodies may be short, and a compacted
      // snapshot cannot fix that on its own (the merge keeps the longer local body
      // over a shorter preview).
      //
      // Marking the window dirty is NOT enough: the re-hydration gate only fires on a
      // later render whose snapshot still says truncated, and snapshot/delta frames are
      // merged with `stream::select` — so the newest snapshot can arrive BEFORE this
      // notice. With no further state change afterwards, nothing would ever refetch.
      // Drive the fetch directly instead.
      //
      // Settle FIRST: renderedTranscriptFromWindow treats a non-"full" entry as
      // untrusted and falls back to the array's copy, which for a still-pending
      // delta is the stale pre-delta text — invalidating before that delta
      // settles paints a rollback. Mirrors remote's scheduleTranscriptGapRepair
      // (session-ops.js:619-630).
      settleTranscriptProjection(state);
      invalidateTranscriptWindowForRepair(state);
      void ensureConversationTranscript?.(state.session);
      // Whatever text is already pending must not sit out the coalescing
      // window behind a signal that says the current view may already be
      // stale — bring it forward now, same as the plan's other immediate
      // classes.
      transcriptFlushScheduler.flushNow("transcript_stream_lagged");
      return;
    }
    if (kind === "session_meta_updated") {
      const { transcript: _transcript, transcript_truncated: _truncated, ...metadata } =
        event.session || event.patch || event;
      renderSession({
        ...state.session,
        ...metadata,
        transcript: state.session.transcript,
        transcript_truncated: state.session.transcript_truncated,
      });
      return;
    }
    if (kind === "approval_added" && event.approval?.request_id) {
      const approvals = state.session.pending_approvals || [];
      const nextApprovals = approvals.some((approval) => approval?.request_id === event.approval.request_id)
        ? approvals.map((approval) =>
            approval?.request_id === event.approval.request_id
              ? { ...approval, ...event.approval }
              : approval
          )
        : [...approvals, event.approval];
      renderSession({ ...state.session, pending_approvals: nextApprovals });
      return;
    }
    if (kind === "approval_resolved") {
      const requestId = event.request_id || event.approval?.request_id || null;
      if (requestId) {
        renderSession({
          ...state.session,
          pending_approvals: (state.session.pending_approvals || [])
            .filter((approval) => approval?.request_id !== requestId),
        });
      }
      return;
    }
    if (
      kind === "transcript_entry_started"
      || kind === "transcript_entry_delta"
      || kind === "transcript_entry_completed"
      || kind === "transcript_entry_patched"
    ) {
      if (kind === "transcript_entry_delta") {
        applyLocalTranscriptEntryDelta(event);
      } else {
        applyLocalTranscriptEntryPatch(event, {
          defaultStatus:
            kind === "transcript_entry_completed"
              ? "completed"
              : kind === "transcript_entry_started"
                ? "running"
                : null,
        });
      }
    }
  }

  /**
   * The Tasks screen's Orchestrator transcript, which is a view-only pin in all
   * but name: a thread id plus the entries drawn for it.
   *
   * Borrowing the pin reducer rather than writing a second one is deliberate.
   * The hard parts of applying a delta are not the append — they are refusing a
   * re-delivered chunk by `text_offset`, refusing a first delta that does not
   * start at 0 (its opening text never arrived, so the body would render
   * truncated as if whole), and refusing an unlabeled delta that might belong to
   * another thread. A second copy of that would drift, and the failure mode of
   * drift here is corrupted text with nothing to notice it by.
   *
   * @returns {boolean} whether the entries changed
   */
  function applyDeltaToOrchestratorEntries(event) {
    const threadId = state.orchestratorEntriesThreadId;
    if (!threadId || !Array.isArray(state.orchestratorEntries)) {
      return false;
    }
    // These entries belong to the run that minted their ids. A delta from a newer run
    // names its target differently, so applying it here either misses (harmless) or
    // appends a second row for a message already in this buffer. Checked against the
    // DELTA's own stamp as well as the live session's, so a delta that crosses a
    // restart is refused even while the session still reads as the old run.
    if (
      (state.orchestratorEntriesGeneration || "")
      !== (state.session?.transcript_generation || "")
    ) {
      return false;
    }
    if (
      !transcriptDeltaMatchesGeneration(
        state.orchestratorEntriesGeneration,
        event?.transcript_generation
      )
    ) {
      return false;
    }
    // The reducer returns the SAME object when the delta does not apply — which
    // includes "this delta is for another thread", so no id check is needed here.
    const pin = { threadId, entries: state.orchestratorEntries };
    const next = applyDeltaToViewOnlyPin(pin, event);
    if (next === pin) {
      return false;
    }
    state.orchestratorEntries = next.entries;
    // The reducer also reports that this thread is mid-turn, and that is the
    // more reliable signal: `thread_activity` can omit the Orchestrator, or the
    // Tasks screen can miss the frame that carried the phase. Dropping it left
    // the working->idle refresh unable to fire, so the last entry stayed
    // rendered as streaming forever.
    if (next.wasWorking) {
      state.orchestratorWasWorking = true;
      // The next render must not treat a fresh delta as an observed idle edge
      // when `thread_activity` omits the Orchestrator.
      state.orchestratorDeltaRaisedWorking = true;
      if (state.orchestratorEntriesLoading) {
        state.orchestratorDeltaDuringFetch = true;
      }
    }
    // Same signal, different slot: the Orchestrator's entries are scalars rather
    // than a pin object, so the reducer's `tailGap` is carried here.
    if (next.tailGap) {
      state.orchestratorTailGap = true;
      if (state.orchestratorEntriesLoading) {
        state.orchestratorDeltaDuringFetch = true;
      }
    }
    return true;
  }

  function observeAppliedActiveThreadDelta(observation) {
    const sink = globalThis.__appliedLocalTranscriptDeltas;
    if (!Array.isArray(sink) || !observation?.itemId) {
      return;
    }
    if (
      !(Number.isSafeInteger(observation.textLengthBefore) && observation.textLengthBefore >= 0)
      || !(Number.isSafeInteger(observation.textLengthAfter) && observation.textLengthAfter >= 0)
      || observation.textLengthAfter <= observation.textLengthBefore
    ) {
      return;
    }
    sink.push({
      itemId: observation.itemId,
      threadId: observation.threadId || null,
      turnId: observation.turnId || null,
      textLengthBefore: observation.textLengthBefore,
      textLengthAfter: observation.textLengthAfter,
    });
  }

  function applyLocalTranscriptEntryDelta(event) {
    if (!transcriptRowKey(event) || !Array.isArray(state.session?.transcript)) {
      return;
    }
    const currentThreadId = state.session.active_thread_id || null;
    if (event.thread_id && currentThreadId && event.thread_id !== currentThreadId) {
      // Not the active thread — but this surface may be drawing it anyway, in one
      // of two places. Route it instead of dropping it: dropping is what made a
      // background thread's transcript update only when a poll happened to land.
      // Both destinations run the SAME reducer; only the slot they live in differs.
      let changed = false;
      const pin = state.viewOnlyThread;
      const nextPin = applyDeltaToViewOnlyPin(pin, event);
      if (nextPin !== pin) {
        state.viewOnlyThread = nextPin;
        changed = true;
      }
      if (applyDeltaToOrchestratorEntries(event)) {
        changed = true;
      }
      if (changed) {
        queueTranscriptRender(state.session, (event.delta ?? "").length);
      }
      return;
    }

    // The hydration window, when loaded, is the ONE place the delta is reconciled: it
    // owns the text_offset bookkeeping that makes re-delivery idempotent — and it is
    // already O(1) per delta (a Map write). Projecting it back to the rendered array
    // (order.map(...).filter(Boolean)) is O(n) in the loaded window, so that step is
    // deferred to settleTranscriptProjection() and runs once per render instead
    // of once per token — this call only bumps transcript_revision.
    // state.session.transcript trails the window by up to one render until then;
    // every reader that needs the newest text reads the window directly.
    // The active session is this delta's destination now, so it is the generation
    // that must match. Refusing costs nothing to recover from: the next snapshot
    // for this thread carries the whole tail, so there is nothing to schedule.
    if (transcriptDeltaIsFromAnotherGeneration(state.session, event)) {
      return;
    }
    if (transcriptWindowIsLoaded(state, currentThreadId)) {
      // O(1): the row key straight into the window map.
      const existingWindowEntry = state.transcriptHydrationEntries.get(transcriptRowKey(event));
      const outcome = reduceTranscriptDeltaEvent({
        session: state.session,
        event,
        currentThreadId,
        currentEntry: existingWindowEntry,
        hasCurrentEntry: Boolean(existingWindowEntry),
        buildTranscript: false,
        appendEmptyOffsetlessDelta: true,
      });
      if (outcome.kind === "noop") {
        return;
      }
      const textLengthBefore = outcome.textLengthBefore ?? (existingWindowEntry?.text ?? "").length;
      // The reducer says whether this delta will be refused before the existing
      // window mutator downgrades content_state in place.
      // Settle FIRST when it will: an earlier valid append for this thread
      // may still be pending only in the window (queueTranscriptRender below
      // defers the array projection), and downgrading before that settles
      // makes the projection's non-"full" fallback read the stale pre-append
      // array — the same rollback transcript_stream_lagged had, just reached
      // through an ordinary per-item gap instead of a bulk notice.
      //
      // An item the window has never tracked at all is a SECOND refusal shape
      // the existing-entry offset check never sees: applyTranscriptDeltaToWindow's own
      // "unknown item" branch stores a nonzero-offset first delta as an empty
      // preview (the opening text went missing), never `full` — functionally
      // identical to a refused append, just reached with no existing text.
      if (outcome.kind === "needs_repair") {
        settleTranscriptProjection(state);
        // Bumped BEFORE the repair fetch below starts, so a hydration fetch
        // already in flight for this thread (captured its epoch earlier, in
        // shared/transcript-hydration.js) reads back stale when it resolves —
        // see isStaleTranscriptPage's epoch check for why a thread-id check
        // alone lets that race repromote this exact item to `full`.
        state.transcriptRefusalEpoch = (state.transcriptRefusalEpoch || 0) + 1;
      }
      let applied = appendTranscriptDelta(state, event);
      if (!applied) {
        applied = applyAcceptedEmptyOffsetlessDeltaToWindow(event, outcome);
      }
      const textLengthAfter =
        (state.transcriptHydrationEntries.get(transcriptRowKey(event))?.text ?? "").length;
      if (applied) {
        observeAppliedActiveThreadDelta({
          itemId: transcriptRowKey(event),
          threadId: currentThreadId,
          turnId: event.turn_id || null,
          textLengthBefore,
          textLengthAfter,
        });
      }
      const nextSession = { ...state.session };
      if (outcome.eventRevision != null) {
        nextSession.transcript_revision = outcome.nextRevision;
      }
      if (outcome.kind === "needs_repair") {
        // A true refusal, not a duplicate — this item's window entry was just
        // downgraded to preview IN PLACE above (or, for a brand-new item,
        // created directly as one), so there is nothing left to project for
        // it here. Bring the ALREADY-KNOWN-GOOD text forward immediately
        // instead of letting it sit out the coalescing window, same immediate
        // tail as transcript_stream_lagged (settle, above, already ran) —
        // minus that path's window-wide invalidation, which would wrongly
        // downgrade every OTHER entry over one bad chunk.
        state.session = nextSession;
        // NOT ensureConversationTranscript — see repairActiveTranscriptTail's
        // own doc for why that gate never fires for this signal. This is a
        // second, later render once the authoritative page lands; the
        // flushNow below is the immediate one for the text already in hand.
        void repairActiveTranscriptTail(currentThreadId);
        transcriptFlushScheduler.flushNow("transcript_entry_delta_refused");
        return;
      }
      markTranscriptWindowProjectionPending(state);
      queueTranscriptRender(nextSession, Math.max(0, textLengthAfter - textLengthBefore));
      return;
    }

    // No window yet (deltas can arrive before the first hydration). Reconcile against
    // the rendered transcript directly, with the SAME offset rules — otherwise the live
    // tail would either vanish before hydration or double-append on re-delivery.
    const outcome = reduceTranscriptDeltaEvent({
      session: state.session,
      event,
      currentThreadId,
    });
    if (outcome.kind === "noop" || outcome.kind === "duplicate") {
      // Duplicate — idempotent no-op, same as the loaded-window path's
      // resolvedAppend === "" case. Hydration is authoritative for the real
      // text; splicing a re-delivered chunk here would corrupt it.
      return;
    }
    if (outcome.kind === "needs_repair") {
      // A true refusal (a gap/mismatch, or a missing head for a brand-new
      // item) — NOT a duplicate. This branch used to treat both the same and
      // silently return, on the assumption hydration is "authoritative" and
      // will reconcile it later — but nothing here made that true: a
      // hydration fetch already in flight when this gap happens (armed by
      // the very first snapshot, before any window ever loaded) captured its
      // epoch before the gap and would sail past isRefusalEpochStale
      // (shared/transcript-hydration.js) with the epoch never having moved,
      // landing its pre-gap content as `full` — the exact race the
      // loaded-window path's epoch bump (above) exists to close, just
      // reached through the one call site that skipped it (P1 review).
      state.transcriptRefusalEpoch = (state.transcriptRefusalEpoch || 0) + 1;
      state.session = { ...state.session };
      if (outcome.eventRevision != null) {
        state.session.transcript_revision = outcome.nextRevision;
      }
      // Same repair the loaded-window path fires. Its merge bootstraps the
      // window from empty if it's still unloaded when the fetch resolves —
      // this IS how a cold thread's gap actually gets repaired, not a
      // best-effort extra.
      void repairActiveTranscriptTail(currentThreadId);
      transcriptFlushScheduler.flushNow("transcript_entry_delta_refused");
      return;
    }

    // Same full-rebuild shape as the deferred window projection
    // (settleTranscriptProjection), just bounded (max_transcript_entries: 8)
    // rather than deferred — counted for the same reason: visibility into
    // every site that copies the whole array.
    __recordTranscriptFullRebuild();
    observeAppliedActiveThreadDelta({
      itemId: transcriptRowKey(event),
      threadId: currentThreadId,
      turnId: event.turn_id || null,
      textLengthBefore: outcome.textLengthBefore,
      textLengthAfter: outcome.textLengthAfter,
    });
    queueTranscriptRender(outcome.nextSession, outcome.appendText.length);
  }

  function applyAcceptedEmptyOffsetlessDeltaToWindow(event, outcome) {
    if (
      outcome.kind !== "append"
      || outcome.appendText !== ""
      || (event?.delta ?? "") !== ""
      || event?.text_offset != null
    ) {
      return false;
    }
    const itemId = outcome.itemId || transcriptRowKey(event);
    const entries = state.transcriptHydrationEntries;
    const order = state.transcriptHydrationOrder;
    if (!itemId || !(entries instanceof Map) || !Array.isArray(order)) {
      return false;
    }
    const existing = entries.get(itemId);
    const nextEntry = {
      // Only for a row this window does not already hold — an existing one
      // brings its own key through the spread below.
      ...(typeof event?.row_id === "string" && event.row_id ? { row_id: event.row_id } : {}),
      item_id: itemId,
      text: "",
      tool: null,
      ...existing,
      ...outcome.entryPatch,
    };
    entries.set(itemId, nextEntry);
    if (!existing) {
      // Unreachable for the keyed proof, and deliberately left as a backstop.
      // This runs only when appendTranscriptDelta above returned false, and for
      // an item the window does not hold that call returns `startsAtZero` —
      // which this function's own guard has already pinned true by requiring
      // text_offset == null. So a row that is NEW here has always just been
      // created (and placed by its birth key, and had the proof revoked if it
      // had none) by the store's own writer. There is no path by which this
      // push adds an unnumbered row to a window still claiming to be keyed.
      order.push(itemId);
    }
    return true;
  }

  function normalizeLocalDeltaKind(kind) {
    return normalizeTranscriptDeltaKind(kind);
  }

  function applyLocalTranscriptEntryPatch(event, { defaultStatus = null } = {}) {
    // Validate BEFORE settling: background threads are watched, so an
    // off-thread patch here is routine, not exceptional, and the early
    // returns below drop it without ever touching state.session.transcript.
    // Settling is an O(n) window projection — paying for it on a patch we
    // are about to discard defeats the whole point of deferring it to the
    // flush.
    const currentThreadId = state.session?.active_thread_id || null;
    const eventThreadId = transcriptEventThreadId(event);
    if (eventThreadId && currentThreadId && eventThreadId !== currentThreadId) {
      return;
    }
    if (!state.session || !Array.isArray(state.session.transcript)) {
      return;
    }
    if (!(transcriptRowKey(event.entry) || transcriptRowKey(event))) {
      return;
    }
    // Only now is this function committed to reading state.session.transcript
    // and rebuilding it (below) — settle any pending window append into it
    // FIRST, or that rebuild would carry the pre-append text forward into its
    // own new array reference, silently dropping the pending delta (see
    // settleTranscriptProjection's doc). Once settled here, the render
    // chokepoint's own settle is a no-op — this rebuild's array already
    // carries both the delta and this patch.
    settleTranscriptProjection(state);
    const outcome = reduceTranscriptEntryPatchEvent({
      session: state.session,
      event,
      currentThreadId,
      defaultStatus,
      windowLoaded: transcriptWindowIsLoaded(state, currentThreadId),
    });
    if (outcome.kind !== "accepted_patch") {
      return;
    }
    const patchedEntry = outcome.entryPatch;
    // Also invalidate the window's own copy, not just rebuild the array
    // below: it can never safely carry this patch's fields itself (see
    // invalidateTranscriptWindowEntryForPatch), so a later delta re-arming
    // the pending projection must not settle by trusting the window's stale
    // copy over the array's fresher one — renderedTranscriptFromWindow reads
    // this thread's array as the fallback source for exactly that reason. A
    // no-op when the window isn't loaded yet, or doesn't yet track this item.
    applyEntryPatchToWindow(state, currentThreadId, patchedEntry);
    if (outcome.patchIntroducesUntrackedItem) {
      // state.session (still pre-patch here), NOT outcome.nextSession: a patch has no
      // content_state field, so exposing this item's fabricated array entry to
      // hydration's tail merge would default the missing field to "full" and
      // poison the window with an empty-but-"full" entry — permanently
      // suppressing the real fetch (transcript-hydration-store.js's
      // contentStateOf; see .sealwire/PLAN.md, "Invalidate; do not write" ->
      // "Never route non-authoritative data through the authoritative path" ->
      // "Invalidate and refetch instead of merging a patch-derived session").
      // state.session never mentions this item, so the merge can only repair
      // OTHER already-tracked entries — a real snapshot later teaches the
      // window about this one honestly.
      void ensureConversationTranscript(state.session);
    }
    // Completion, failure, error and cancellation are terminal, and a patch is
    // the ONLY way local ever learns of them for an entry with no dedicated
    // snapshot turn-state change — so this must paint at once, not wait out
    // the coalescing window (.sealwire/PLAN.md). Mirrors remote's
    // commitLiveSession(nextSession, { immediate: entryPatch.status !== "running" }).
    if (outcome.terminal) {
      state.session = outcome.nextSession;
      transcriptFlushScheduler.flushNow("transcript_entry_patch");
    } else {
      queueTranscriptRender(outcome.nextSession);
    }
  }

  return {
    connectSessionStream,
    applySessionStreamEvent,
    applyLocalTranscriptEntryDelta,
    normalizeLocalDeltaKind,
    applyLocalTranscriptEntryPatch,
  };
}
