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
  reviewSig = null,
  cwd = null,
  provider = null,
  status = null,
  lastRefreshAt = 0,
  wasWorking = false,
  priorEntries = [],
  priorOlderCursor = null,
  loading = false,
}) {
  return {
    threadId,
    entries: page ? page.entries || [] : priorEntries,
    olderCursor: page ? page.prev_cursor ?? null : priorOlderCursor,
    generation,
    review,
    reviewSig,
    // The viewed thread's own metadata, from its thread summary. The projection
    // uses these so a cross-workspace saved thread shows ITS workspace/provider
    // rather than the live thread's. The summary carries no model/effort/policy,
    // so the projection blanks those (blank/unknown beats impersonating live).
    cwd,
    provider,
    status,
    lastRefreshAt,
    wasWorking,
    loading,
  };
}

function settledThreadStatus(status) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  return normalized === "active" || normalized === "running" || normalized === "working"
    ? "idle"
    : status || "idle";
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
  const isWorking = Boolean(activity);
  const pendingApprovals = (realSession.pending_approvals || []).filter(
    (entry) => entry?.thread_id === viewThreadId
  );
  const pendingQuestions = (realSession.pending_ask_user_questions || []).filter(
    (entry) => entry?.thread_id === viewThreadId
  );
  return {
    ...realSession,
    active_thread_id: viewThreadId,
    active_turn_id: isWorking ? `view:${viewThreadId}` : null,
    pending_approvals: pendingApprovals,
    pending_ask_user_questions: pendingQuestions,
    // A sentinel controller id makes canCurrentDeviceWrite() false → read-only.
    active_controller_device_id: "__view_only__",
    transcript: viewOnlyThread.entries || [],
    transcript_truncated: viewOnlyThread.olderCursor != null,
    current_status: isWorking ? "active" : settledThreadStatus(viewOnlyThread.status),
    current_phase: activity?.phase || null,
    current_tool: activity?.tool || null,
    view_only: true,
    // A read-only saved-thread view must never present the LIVE session's
    // metadata as the saved thread's. Use the viewed thread's summary fields
    // (cwd/provider) and BLANK what the summary doesn't carry (model, effort,
    // approval policy, sandbox). Blank/unknown over impersonation — and never
    // fall back to the live cwd.
    current_cwd: viewOnlyThread.cwd ?? "",
    provider: viewOnlyThread.provider ?? "",
    model: "",
    reasoning_effort: "",
    approval_policy: "",
    sandbox: "",
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
