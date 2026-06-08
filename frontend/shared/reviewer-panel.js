import React from "react";

import { ReviewLauncher } from "./review-panel.js";
import {
  isTerminalReviewStatus,
  reviewChipTone,
  reviewStatusLabel,
} from "./review-state.js";

const h = React.createElement;

// While a review is still running, re-fetch the reviewer's latest message on this
// cadence so the user can watch an in-progress (or stuck) reviewer. Terminal reviews
// are fetched once. Kept modest because the remote surface fetches via the broker.
const REVIEWER_PREVIEW_POLL_MS = 6000;

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
  const terminal = isTerminalReviewStatus(job.status);
  const blocked = job.status === "blocked";
  const reviewerThreadId = job.reviewer_thread_id || null;

  // Surface the reviewer's latest message for ANY review with a reviewer thread —
  // not just terminal ones — so the user can see what an in-progress or stuck
  // reviewer is doing (the whole point of "let me see inside the review"). While the
  // review is still running we poll, so the preview keeps up with the reviewer.
  React.useEffect(() => {
    if (!reviewerThreadId || typeof fetchReviewerTranscript !== "function") {
      return undefined;
    }
    let cancelled = false;
    // Monotonic request ids so an out-of-order poll (a slow fetch resolving after a
    // newer one) can't overwrite the newer message with stale text.
    let applied = 0;
    let nextRequest = 0;
    const load = () => {
      const requestId = (nextRequest += 1);
      Promise.resolve(fetchReviewerTranscript(reviewerThreadId))
        .then((entries) => {
          if (cancelled || requestId <= applied) return;
          applied = requestId;
          setReview({ status: "loaded", text: latestAgentText(entries), error: null });
        })
        .catch((error) => {
          if (cancelled || requestId <= applied) return;
          applied = requestId;
          // Keep any message we already showed; only surface an error if we have none.
          setReview((prev) =>
            prev.text
              ? prev
              : { status: "error", text: null, error: error?.message || String(error) }
          );
        });
    };
    setReview((prev) => (prev.text ? prev : { status: "loading", text: null, error: null }));
    load();
    // Poll while the review runs so the preview tracks the reviewer, but pause when the
    // tab is hidden — nobody's watching, so there's no point spending a broker round-trip.
    const timer = terminal
      ? null
      : setInterval(() => {
          if (typeof document !== "undefined" && document.hidden) return;
          load();
        }, REVIEWER_PREVIEW_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
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
      ),
      // Iterative review loop progress (only meaningful when a budget was set).
      job.max_rounds > 1
        ? h(
            "span",
            { className: "reviewer-job-round" },
            `Round ${job.round || 0}/${job.max_rounds}`
          )
        : null
    ),
    job.verdict && job.verdict !== "unknown"
      ? h("p", { className: "reviewer-job-verdict" }, `Verdict: ${job.verdict}`)
      : null,
    job.error ? h("p", { className: "reviewer-job-error" }, job.error) : null,
    review.status === "loading" && !review.text
      ? h(
          "p",
          { className: "reviewer-job-loading" },
          terminal ? "Loading review…" : "Loading the reviewer's latest message…"
        )
      : null,
    review.status === "error" && !review.text
      ? h(
          "p",
          { className: "reviewer-job-error" },
          `Couldn't load the reviewer's messages: ${review.error}`
        )
      : null,
    review.text
      ? h(
          React.Fragment,
          null,
          // For a running review, label the preview so it's clear this is the
          // reviewer's latest message in flight, not the final posted-back review.
          !terminal
            ? h(
                "p",
                { className: "reviewer-job-review-label" },
                "Reviewer's latest message (review not final):"
              )
            : null,
          h("div", { className: "reviewer-job-review" }, review.text)
        )
      : null,
    h(
      "div",
      { className: "reviewer-job-actions" },
      // A Stop button is available for ANY in-progress review (not just the
      // cleanup-failed `blocked` state) so a stuck/hung review can always be
      // cancelled and its threads unlocked.
      !terminal
        ? h(
            "button",
            {
              type: "button",
              className: "header-button review-resolve-button",
              title: blocked
                ? "The reviewer turn couldn't be stopped and the workspace is locked. Stop it to unlock."
                : "Stop this review now and unlock the reviewed thread.",
              onClick: () => onResolveReview?.(),
            },
            blocked ? "Stop reviewer & unlock" : "Stop review"
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
