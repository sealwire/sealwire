import { providerOptions } from "./provider-settings.js";

const REVIEW_STATUS_LABELS = {
  pending_parent_recap: "Recapping changes",
  waiting_for_parent_recap: "Recapping changes",
  starting_reviewer: "Starting reviewer",
  waiting_for_reviewer: "Reviewing",
  waiting_to_post_back: "Posting review back",
  posting_back: "Posting review back",
  interrupting: "Stopping review…",
  addressing_findings: "Author addressing findings…",
  blocked: "Review blocked — action needed",
  complete: "Review complete",
  failed: "Review failed",
  escalated: "Reviewer still has concerns — over to you",
  cancelled: "Review cancelled",
};

const TERMINAL_REVIEW_STATUSES = new Set([
  "complete",
  "failed",
  "escalated",
  "cancelled",
]);

// Single source of truth for "this review is finished" — used by the panel, the
// tab label, and the chip so they can never drift (e.g. `escalated` being terminal
// in one place but not another).
export function isTerminalReviewStatus(status) {
  return TERMINAL_REVIEW_STATUSES.has(status);
}

export function reviewStatusLabel(status) {
  return REVIEW_STATUS_LABELS[status] || status || "Reviewing";
}

export function isReviewInProgress(session) {
  return (session?.active_review_jobs || []).some(
    (job) => !TERMINAL_REVIEW_STATUSES.has(job.status)
  );
}

export function isReviewBlocked(session) {
  return (session?.active_review_jobs || []).some((job) => job.status === "blocked");
}

// True when a non-terminal review is reviewing `threadId` as its parent. During
// that window the reviewer briefly owns the active thread, so the parent's
// conversation page should show a calm "review in progress" state rather than a
// "this session isn't active" message.
export function isReviewInProgressForThread(session, threadId) {
  if (!threadId) return false;
  return (session?.active_review_jobs || []).some(
    (job) =>
      job.parent_thread_id === threadId && !TERMINAL_REVIEW_STATUSES.has(job.status)
  );
}

export function reviewChipTone(status) {
  if (status === "failed" || status === "escalated") return "alert";
  if (status === "complete") return "ready";
  return "active";
}

// Header status-badge summary for the active thread's review state, or null when there's
// nothing review-related to surface. Single source of truth so the LOCAL and REMOTE
// surfaces render the SAME wording/tone — the "under review" state must look identical on
// both (the remote surface used to only freeze the composer and showed no status).
export const REVIEW_BLOCKED_BADGE = { label: "Review blocked — action needed", tone: "alert" };
export const REVIEW_IN_PROGRESS_BADGE = { label: "Review in progress", tone: "alert" };

export function reviewStatusBadge(session, activeThreadId) {
  // A blocked review locks the workspace until the user stops the reviewer — surface it
  // regardless of which thread is active. An in-progress review only badges the thread the
  // user is actually viewing (a background review on another thread leaves this one live).
  if (isReviewBlocked(session)) return REVIEW_BLOCKED_BADGE;
  if (isReviewInProgressForThread(session, activeThreadId)) return REVIEW_IN_PROGRESS_BADGE;
  return null;
}

// Read-only "view projection" for the local app. While a review runs on a thread
// that is NOT the active one, the user can click back to it — but resume is rejected
// (it's review-locked and mutating). This projects the real session so the viewed
// parent renders read-only: its own transcript, a frozen composer, the conversation
// layout (not the console home). The REAL session is untouched by the caller — only
// the projection is rendered — so heartbeat / lease / controller keep working.
// Returns `realSession` unchanged unless the viewed thread is a non-active,
// review-locked parent that has a loaded transcript (`viewOnlyThread`).
export function projectReviewReadOnlySession(
  realSession,
  { viewThreadId, viewOnlyThread } = {}
) {
  if (
    !viewOnlyThread ||
    !realSession ||
    !viewThreadId ||
    viewOnlyThread.threadId !== viewThreadId ||
    viewThreadId === realSession.active_thread_id ||
    !isReviewInProgressForThread(realSession, viewThreadId)
  ) {
    return realSession;
  }
  return {
    ...realSession,
    active_thread_id: viewThreadId,
    active_turn_id: null,
    pending_approvals: [],
    pending_ask_user_questions: [],
    // A sentinel controller id makes canCurrentDeviceWrite() false → read-only.
    active_controller_device_id: "__view_only__",
    transcript: viewOnlyThread.entries || [],
    transcript_truncated: false,
    current_status: "viewing",
    view_only: true,
  };
}

// Build the model picker payload for the review-request dialog. Shared by the
// local renderer and the remote app so both offer the same reviewer choices.
//   { providerOptions: [{value,label}], models: [...], defaultProvider }
export function selectReviewLaunchModel({ providers = [], providerModels = {}, session = null } = {}) {
  // Stamp every model with the provider it belongs to so the request dialog can
  // filter the catalog by the SELECTED reviewer provider. `providerModels` is keyed
  // by provider (the source of truth for ownership), but some providers — Codex —
  // return models with an EMPTY `provider` field. A bare flatten therefore lets
  // those models slip through the dialog's `!model.provider` clause and show under
  // every reviewer (e.g. GPT models appearing when Claude is selected). Re-stamp
  // from the map key, and dedupe by provider+model so the active session's models
  // (also surfaced via available_models) don't double up.
  const seen = new Set();
  const models = [];
  const push = (model, provider) => {
    if (!model?.model) return;
    const key = `${provider} ${model.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    models.push({ ...model, provider });
  };
  for (const [provider, list] of Object.entries(providerModels || {})) {
    for (const model of list || []) push(model, provider);
  }
  // The active session's own models belong to `session.provider` (the relay
  // provider KEY, e.g. "claude_code"). The per-model `provider` field is a VENDOR
  // label ("anthropic") that does NOT match the reviewer provider, so prefer the
  // session key — otherwise these models never pass the dialog's per-provider filter.
  for (const model of session?.available_models || []) {
    push(model, session?.provider || model.provider || "");
  }
  const defaultProvider =
    providers.find((provider) => provider !== session?.provider) ||
    providers[0] ||
    session?.provider ||
    "";
  return {
    providerOptions: providerOptions(providers),
    models,
    defaultProvider,
  };
}

// Whether THIS device may start a new review right now. Mirrors the backend
// request_review gate: the device must be able to drive the session (control is
// unclaimed OR held by this device — same as can_device_send_message), the agent
// must be idle with no pending approvals, and no review may already be running.
// Used for the Reviewer-tab CTA + idle nudge.
export function canRequestReview(session, deviceId) {
  if (!session?.active_thread_id) return false;
  const controller = session.active_controller_device_id;
  if (controller && controller !== deviceId) return false;
  if (session.active_turn_id) return false;
  if (Array.isArray(session.pending_approvals) && session.pending_approvals.length > 0) {
    return false;
  }
  if (isReviewInProgress(session)) return false;
  return session.current_status === "idle";
}
