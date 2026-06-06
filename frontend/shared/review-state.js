const REVIEW_STATUS_LABELS = {
  pending_parent_recap: "Recapping changes",
  waiting_for_parent_recap: "Recapping changes",
  starting_reviewer: "Starting reviewer",
  waiting_for_reviewer: "Reviewing",
  waiting_to_post_back: "Posting review back",
  posting_back: "Posting review back",
  interrupting: "Stopping review…",
  blocked: "Review blocked — action needed",
  complete: "Review complete",
  failed: "Review failed",
  cancelled: "Review cancelled",
};

const TERMINAL_REVIEW_STATUSES = new Set(["complete", "failed", "cancelled"]);

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

export function reviewChipTone(status) {
  if (status === "failed") return "alert";
  if (status === "complete") return "ready";
  return "active";
}
