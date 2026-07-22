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

import { isReviewInProgressForThread } from "../shared/review-state.js";
import { isWorkingThreadStatus } from "../shared/thread-status.js";

// Any non-active thread can be viewed read-only. (The active thread is live —
// projecting it would hide approvals/streaming, so it is never eligible.)
export function viewOnlyEligible(session, threadId) {
  return Boolean(
    threadId && session && threadId !== session.active_thread_id
  );
}

export function buildViewOnlyPin({
  threadId,
  page = null,
  generation = 0,
  review = false,
  workflowLocked = false,
  reviewSig = null,
  cwd = null,
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
  priorEntries = [],
  priorOlderCursor = null,
  loading = false,
  error = false,
}) {
  return {
    threadId,
    entries: page ? page.entries || [] : priorEntries,
    olderCursor: page ? page.prev_cursor ?? null : priorOlderCursor,
    generation,
    review,
    workflowLocked,
    reviewSig,
    // The viewed thread's own metadata, from its thread summary. The projection
    // uses these so a cross-workspace saved thread shows ITS workspace/provider
    // rather than the live thread's. The summary carries no model/effort/policy,
    // so the projection blanks those (blank/unknown beats impersonating live).
    cwd,
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
    loading,
    // True when the last load for this pin FAILED (fetch error). Lets the
    // self-heal decision retry it after a backoff instead of treating the empty
    // shell as a settled, complete view forever. See viewOnlySelfHealThreadId.
    error,
  };
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

function settledThreadStatus(status) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  return normalized === "active" || normalized === "running" || normalized === "working"
    ? "idle"
    : status || "idle";
}

function serverTimeSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function snapshotServerTime(session) {
  return serverTimeSeconds(session?.server_time);
}

function pinServerTime(pin) {
  return serverTimeSeconds(pin?.lastRefreshServerTime);
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
  return {
    ...pin,
    entries: [...older, ...(pin.entries || [])],
    olderCursor: page.prev_cursor ?? null,
  };
}

// Read-only projection of the real session for rendering. Mirrors the remote
// surface's view-only shape: the rendered session's active_thread_id IS the
// viewed thread, so every downstream consumer (transcript, details, scroll,
// truncation indicator) works unchanged. transcript_truncated reflects the
// pin's pagination cursor so the scroll-up history loader arms itself.
export function projectViewOnlySession(realSession, { viewThreadId, viewOnlyThread } = {}) {
  if (
    !viewOnlyThread ||
    !realSession ||
    !viewThreadId ||
    viewOnlyThread.threadId !== viewThreadId ||
    viewThreadId === realSession.active_thread_id
  ) {
    return realSession;
  }
  const activity = (realSession.thread_activity || []).find(
    (entry) => entry?.thread_id === viewThreadId
  );
  const explicitTurnId = viewOnlyThread.activeTurnId || null;
  const explicitStatus =
    viewOnlyThread.currentStatus == null ? "" : String(viewOnlyThread.currentStatus).trim();
  const hasExplicitThreadState = Boolean(explicitTurnId || explicitStatus);
  const explicitWorking = Boolean(
    explicitTurnId || (explicitStatus && isWorkingThreadStatus(explicitStatus))
  );
  // The pin's thread_state is fetched independently of the compact live snapshot.
  // If that fetch is newer and says the viewed thread is idle, do not let an
  // older thread_activity row keep the composer stuck in "running" forever.
  const pinTime = pinServerTime(viewOnlyThread);
  const snapshotTime = snapshotServerTime(realSession);
  const activityFreshEnough =
    !pinTime || !snapshotTime || snapshotTime >= pinTime;
  const isWorking = explicitWorking || Boolean(
    activity && (!hasExplicitThreadState || activityFreshEnough)
  );
  const currentPhase = isWorking
    ? viewOnlyThread.currentPhase ?? activity?.phase ?? null
    : null;
  const currentTool = isWorking
    ? viewOnlyThread.currentTool ?? activity?.tool ?? null
    : null;
  const settings = viewOnlyThread.settings || {};
  const pendingApprovals = (realSession.pending_approvals || []).filter(
    (entry) => entry?.thread_id === viewThreadId
  );
  const pendingQuestions = (realSession.pending_ask_user_questions || []).filter(
    (entry) => entry?.thread_id === viewThreadId
  );
  return {
    ...realSession,
    active_thread_id: viewThreadId,
    active_turn_id: explicitTurnId || (isWorking ? `view:${viewThreadId}` : null),
    pending_approvals: pendingApprovals,
    pending_ask_user_questions: pendingQuestions,
    // A sentinel controller id makes canCurrentDeviceWrite() false → read-only.
    active_controller_device_id: "__view_only__",
    transcript: viewOnlyThread.entries || [],
    transcript_truncated: viewOnlyThread.olderCursor != null,
    current_status: viewOnlyThread.currentStatus
      || (isWorking ? "active" : settledThreadStatus(viewOnlyThread.status)),
    current_phase: currentPhase,
    current_tool: currentTool,
    last_progress_at: viewOnlyThread.lastProgressAt ?? null,
    view_only: true,
    // A read-only saved-thread view must never present the LIVE session's
    // metadata as the saved thread's. Use the viewed thread's summary fields
    // (cwd/provider) and BLANK what the summary doesn't carry (model, effort,
    // approval policy, sandbox). Blank/unknown over impersonation — and never
    // fall back to the live cwd.
    current_cwd: viewOnlyThread.cwd ?? "",
    provider: viewOnlyThread.provider ?? "",
    model: settings.model || "",
    reasoning_effort: settings.reasoning_effort || "",
    approval_policy: settings.approval_policy || "",
    sandbox: settings.sandbox || "",
    available_models: viewOnlyThread.availableModels || [],
    review_locked: Boolean(viewOnlyThread.review),
    workflow_locked: Boolean(viewOnlyThread.workflowLocked),
    settings_writable: Boolean(viewOnlyThread.settingsWritable),
  };
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
  if (pin.threadId === session.active_thread_id) {
    return { kind: "release" };
  }
  if (pin.review) {
    if (!isReviewInProgressForThread(session, pin.threadId)) {
      return viewThreadId === pin.threadId ? { kind: "refresh" } : { kind: "release" };
    }
    if (
      !pin.loading &&
      typeof reviewSignature === "function" &&
      pin.reviewSig !== reviewSignature(session, pin.threadId)
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
