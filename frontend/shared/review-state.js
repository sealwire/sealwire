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

// Build the model picker payload for the review-request dialog. Shared by the
// local renderer and the remote app so both offer the same reviewer choices.
//   { providerOptions: [{value,label}], models: [...], defaultProvider }
export function selectReviewLaunchModel({ providers = [], providerModels = {}, session = null } = {}) {
  const models = [].concat(
    ...Object.values(providerModels || {}),
    session?.available_models || []
  );
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
