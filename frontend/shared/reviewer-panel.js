import React from "react";

import { ReviewLauncher } from "./review-panel.js";
import { reviewChipTone, reviewStatusLabel } from "./review-state.js";

const h = React.createElement;

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

function entryText(entry) {
  if (entry?.text && entry.text.trim()) return entry.text.trim();
  // Chunked transcript pages carry text as ordered `parts` instead of a flat
  // `.text`, so join them back together (see shared/transcript-page.js).
  if (Array.isArray(entry?.parts)) {
    const joined = entry.parts
      .slice()
      .sort((a, b) => (a.part_index ?? 0) - (b.part_index ?? 0))
      .map((part) => part.text || "")
      .join("");
    if (joined.trim()) return joined.trim();
  }
  return null;
}

function latestAgentText(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.kind === "agent_text") {
      const text = entryText(entries[i]);
      if (text) return text;
    }
  }
  return null;
}

// Pure-presentational reviewer surface. All data + actions are injected so the
// same component works on the local (apiFetch) and remote (broker) surfaces.
//   reviewJobs:        Vec<ReviewJobView> from session.active_review_jobs
//   reviewModel:       { providerOptions, models, defaultProvider }
//   canRequest:        whether a new review can be started (idle + controller)
//   onRequestReview:   ({reviewerProvider, reviewerModel, instructions}) => void
//   onResolveReview:   () => void                (stop a blocked reviewer)
//   onDismissReview:   (jobId) => void           (drop a terminal review)
//   fetchReviewerTranscript: (threadId) => Promise<entries[]>
export function ReviewerPanel({
  reviewJobs = [],
  reviewModel = {},
  reusableReviewers = [],
  canRequest = false,
  requesting = false,
  onRequestReview,
  onResolveReview,
  onDismissReview,
  fetchReviewerTranscript,
  panelId = "review-panel",
}) {
  const hasJobs = reviewJobs.length > 0;
  const canLaunch = typeof onRequestReview === "function";
  // The launcher is ALWAYS rendered (when wiring exists) so the affordance is
  // discoverable; it's just disabled when a review can't be started right now.
  const launcher = () =>
    h(ReviewLauncher, {
      panelId,
      label: "Request review",
      title: canRequest
        ? "Ask another agent to review the current changes"
        : "Available when the agent is idle and no other device has control",
      providerOptions: reviewModel.providerOptions || [],
      models: reviewModel.models || [],
      defaultProvider: reviewModel.defaultProvider || "",
      reusableReviewers,
      disabled: requesting || !canRequest,
      onSubmit: onRequestReview,
    });

  return h(
    "section",
    { className: "reviewer-panel" },
    h(
      "header",
      { className: "reviewer-panel-header" },
      h("h2", { className: "reviewer-panel-title" }, "Reviewer"),
      // When there are jobs, the launcher lives in the header; the empty state
      // hosts it otherwise (so only one modal mounts for this panelId).
      canLaunch && hasJobs ? launcher() : null
    ),
    hasJobs
      ? h(
          "div",
          { className: "reviewer-panel-list" },
          ...reviewJobs.map((job) =>
            h(ReviewerJobCard, {
              key: job.id,
              job,
              onResolveReview,
              onDismissReview,
              fetchReviewerTranscript,
            })
          )
        )
      : h(
          "div",
          { className: "reviewer-empty" },
          h(
            "p",
            { className: "reviewer-empty-copy" },
            "Ask another agent to review the current changes. The reviewer runs in its own thread and reports back here."
          ),
          canLaunch ? launcher() : null,
          !canRequest
            ? h(
                "p",
                { className: "reviewer-empty-hint" },
                "Available when the agent is idle and no other device has control."
              )
            : null
        )
  );
}

function ReviewerJobCard({ job, onResolveReview, onDismissReview, fetchReviewerTranscript }) {
  const [review, setReview] = React.useState({ status: "idle", text: null, error: null });
  const terminal = TERMINAL.has(job.status);
  const blocked = job.status === "blocked";
  const reviewerThreadId = job.reviewer_thread_id || null;

  // Lazily load the reviewer's latest message once the review has produced one.
  React.useEffect(() => {
    if (!terminal || !reviewerThreadId || typeof fetchReviewerTranscript !== "function") {
      return;
    }
    let cancelled = false;
    setReview({ status: "loading", text: null, error: null });
    Promise.resolve(fetchReviewerTranscript(reviewerThreadId))
      .then((entries) => {
        if (cancelled) return;
        setReview({ status: "loaded", text: latestAgentText(entries), error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setReview({ status: "error", text: null, error: error?.message || String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [terminal, reviewerThreadId, fetchReviewerTranscript]);

  return h(
    "article",
    { className: `reviewer-job reviewer-job-${reviewChipTone(job.status)}` },
    h(
      "div",
      { className: "reviewer-job-head" },
      h("span", { className: "reviewer-job-provider" }, job.reviewer_provider || "reviewer"),
      h(
        "span",
        { className: `reviewer-job-status reviewer-job-status-${reviewChipTone(job.status)}` },
        reviewStatusLabel(job.status)
      )
    ),
    job.error ? h("p", { className: "reviewer-job-error" }, job.error) : null,
    terminal && review.status === "loading"
      ? h("p", { className: "reviewer-job-loading" }, "Loading review…")
      : null,
    terminal && review.status === "error"
      ? h("p", { className: "reviewer-job-error" }, `Couldn't load the review: ${review.error}`)
      : null,
    review.text
      ? h("div", { className: "reviewer-job-review" }, review.text)
      : null,
    h(
      "div",
      { className: "reviewer-job-actions" },
      blocked
        ? h(
            "button",
            {
              type: "button",
              className: "header-button review-resolve-button",
              title:
                "The reviewer turn couldn't be stopped and the workspace is locked. Stop it to unlock.",
              onClick: () => onResolveReview?.(),
            },
            "Stop reviewer & unlock"
          )
        : null,
      h(
        "button",
        {
          type: "button",
          className: "header-button reviewer-dismiss-button",
          disabled: !terminal,
          title: terminal
            ? "Delete this review and its reviewer thread (the findings stay in the conversation)"
            : "Stop the reviewer before deleting it",
          onClick: () => terminal && onDismissReview?.(job.id),
        },
        "Delete"
      )
    )
  );
}
