import React from "react";

import { renderMarkdown } from "./markdown.js";
import { transcriptPageIsFromAnotherGeneration } from "./transcript-generation.js";
import { ReviewLauncher } from "./review-panel.js";
import { CodeFlowLauncher, WorkflowRunCard } from "./workflow-panel.js";
import {
  isTerminalReviewStatus,
  reviewChipTone,
  reviewStatusLabel,
} from "./review-state.js";
import { CODE_FLOW_ENABLED } from "./workflow-state.js";

const h = React.createElement;

/**
 * The one place both surfaces strip a transcript page down to the entries the
 * reviewer preview reads. The page's envelope is what names the run its ids came
 * from, so the strip is where that has to be checked — after it, nothing can.
 */
export function reviewerPreviewEntriesFromPage(session, page) {
  // Thrown, not emptied: the panel's catch keeps the last good preview, and a
  // terminal review fetches once — a stale page would freeze on the card forever.
  if (transcriptPageIsFromAnotherGeneration(session, page)) {
    throw new Error("reviewer preview page is from another relay run");
  }
  return page?.entries || (Array.isArray(page) ? page : []);
}

// While a review is still running, re-fetch the reviewer's latest message on this
// cadence so the user can watch an in-progress (or stuck) reviewer. Terminal reviews
// are fetched once. Kept modest because the remote surface fetches via the broker.
const REVIEWER_PREVIEW_POLL_MS = 6000;

// The verdict is the ONE thing the card exists to tell you, so it carries a mark as
// well as a word. The mark matters beyond decoration: in dark mode `--ok-fg` measures
// 3.86:1 on the card surface — enough for a MARK (>=3:1) but under the 4.5:1 a word
// needs. DESIGN_LANGUAGE.md's rule for that case is "the word renders in text-primary,
// the colour goes on the dot/icon", which is exactly this split. Light mode's `--ok-fg`
// clears 5.52:1 and may colour the word too; the CSS handles that per theme.
const VERDICT_TONE = {
  approve: "ok",
  needs_changes: "warn",
  unsure: "neutral",
};

function verdictTone(verdict) {
  return VERDICT_TONE[verdict] || "neutral";
}

// One circle, three glyphs — same silhouette so the row's rhythm doesn't shift when a
// re-review flips the verdict. `currentColor` throughout, so the tone class on the
// wrapper is the whole colour story (matching panel-icons.js's convention).
function VerdictMark({ verdict }) {
  const tone = verdictTone(verdict);
  return h(
    "svg",
    {
      "aria-hidden": "true",
      className: "reviewer-job-verdict-mark",
      fill: "none",
      height: "18",
      viewBox: "0 0 18 18",
      width: "18",
      stroke: "currentColor",
      strokeWidth: "1.6",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("circle", { cx: "9", cy: "9", r: "8" }),
    tone === "ok"
      ? h("polyline", { points: "5.5 9.25 8 11.75 12.5 6.5" })
      : tone === "warn"
        ? h(React.Fragment, null, h("path", { d: "M9 5.25v4.5" }), h("path", { d: "M9 12.5h.01" }))
        : h("path", { d: "M6.5 9h5" })
  );
}

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

export function renderReviewerText(text) {
  if (!text) return "";
  return renderMarkdown(text);
}

// Pure-presentational reviewer surface. All data + actions are injected so the
// same component works on the local (apiFetch) and remote (broker) surfaces.
//   reviewJobs:        Vec<ReviewJobView> from session.active_review_jobs
//   workflowRuns:      Vec<WorkflowRunView> from session.active_workflow_runs
//   reviewModel:       { providerOptions, models, defaultProvider }
//   canRequest:        whether a new review can be started (idle + controller)
//   onRequestReview:   ({reviewerProvider, reviewerModel, instructions}) => void
//   onStartWorkflow:   ({taskPrompt, reviewerProvider, reviewerModel}) => void
//   onResolveReview:   (jobId) => void           (stop a review)
//   onResolveWorkflow: (runId) => void           (stop a workflow)
//   onDeleteReview:    (jobId) => void           (delete a terminal review)
//   fetchReviewerTranscript: (threadId) => Promise<entries[]>
// Join a job to its reviewer thread's display name (falling back to the raw
// thread id) so the card can show — and tooltip — the long reviewer-thread name.
function reviewerThreadName(job, reviewerThreads) {
  const id = job?.reviewer_thread_id;
  if (!id) return null;
  const match = (reviewerThreads || []).find((rt) => rt?.reviewer_thread_id === id);
  const name = match?.name && match.name.trim() ? match.name.trim() : null;
  return name || id;
}

export function ReviewerPanel({
  reviewJobs = [],
  workflowRuns = [],
  reviewModel = {},
  workflowModel = {},
  reusableReviewers = [],
  reviewerThreads = [],
  // The thread this panel is showing (the viewed thread). Sent as the review's parent
  // so "Request review" targets the thread in view, not the relay's active thread.
  parentThreadId = null,
  // The working tree that thread's work is in, so the request dialog can show — and
  // let the user correct — what a review is actually about to read.
  workspace = null,
  workspaceBusy = false,
  workspaceError = null,
  onPinWorkspace = null,
  // Local surface only. Threaded through rather than derived here so the review dialog
  // and the Changes tab answer the same way about the same tree.
  onTrustWorkspace = null,
  canRequest = false,
  canStartWorkflow = false,
  requesting = false,
  onRequestReview,
  onStartWorkflow,
  onResolveReview,
  onResolveWorkflow,
  onDeleteReview,
  fetchReviewerTranscript,
  panelId = "review-panel",
}) {
  const hasJobs = reviewJobs.length > 0;
  // Both gated on the feature switch, so a thread that has ONLY hidden workflow runs falls
  // through to the empty state's call to action rather than rendering a populated panel
  // with nothing in it.
  const hasWorkflowRuns = CODE_FLOW_ENABLED && workflowRuns.length > 0;
  const hasCards = hasJobs || hasWorkflowRuns;
  const canLaunch = typeof onRequestReview === "function";
  const canLaunchWorkflow = CODE_FLOW_ENABLED && typeof onStartWorkflow === "function";
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
      providerModelsStatus: reviewModel.providerModelsStatus || {},
      activeProvider: reviewModel.activeProvider || "",
      onEnsureProviderModels: reviewModel.onEnsureProviderModels,
      reusableReviewers,
      parentThreadId,
      workspace,
      workspaceBusy,
      workspaceError,
      onPinWorkspace,
      onTrustWorkspace,
      disabled: requesting || !canRequest,
      onSubmit: onRequestReview,
    });
  const workflowLauncher = () =>
    h(CodeFlowLauncher, {
      panelId: `${panelId}-code-flow`,
      label: "Run code flow",
      title: canStartWorkflow
        ? "Run the author, reviewer, and revise loop"
        : "Available on an idle writable author session with no active review or workflow",
      providerOptions: workflowModel.providerOptions || [],
      models: workflowModel.models || [],
      defaultProvider: workflowModel.defaultProvider || "",
      providerModelsStatus: workflowModel.providerModelsStatus || {},
      activeProvider: workflowModel.activeProvider || "",
      // Author on the VIEWED thread (same parent the review launcher targets).
      parentThreadId,
      onEnsureProviderModels: workflowModel.onEnsureProviderModels,
      disabled: requesting || !canStartWorkflow,
      onSubmit: onStartWorkflow,
    });

  return h(
    "section",
    { className: "reviewer-panel" },
    // The eyebrow + inline launcher only earn their place as a toolbar ABOVE a list
    // of jobs. In the empty state the "Reviewer" eyebrow is redundant with the
    // already-selected "Reviewer" tab and leaves the label hanging to the left of
    // the CTA card (its text sits at the panel edge, the card's copy is inset by the
    // card padding) — so we drop it and let the self-contained card, which carries
    // its own launcher, stand alone. (Exactly one launcher mounts per panelId either
    // way: in the header when populated, inside the card when empty.)
    hasCards
      ? h(
          "header",
          { className: "reviewer-panel-header" },
          h("h2", { className: "reviewer-panel-title" }, "Reviewer"),
          h(
            "div",
            { className: "reviewer-panel-actions" },
            canLaunchWorkflow ? workflowLauncher() : null,
            canLaunch ? launcher() : null
          )
        )
      : null,
    hasCards
      ? h(
          "div",
          { className: "reviewer-panel-list" },
          ...reviewJobs.map((job) =>
            h(ReviewerJobCard, {
              key: job.id,
              job,
              threadName: reviewerThreadName(job, reviewerThreads),
              // Namespace per-card modal ids by THIS panel mount: the reviewer panel
              // renders in BOTH the remote rail and the remote sheet, so a bare
              // `review-card-<id>` would collide and getElementById would open the
              // wrong (hidden) copy — the per-card Re-review button then did nothing
              // on mobile (sheet) while working on desktop (rail).
              panelId,
              reviewModel,
              reusableReviewers,
              workspace,
              workspaceBusy,
              workspaceError,
              onPinWorkspace,
              onTrustWorkspace,
              canRequest,
              onRequestReview,
              onResolveReview,
              onDeleteReview,
              fetchReviewerTranscript,
            })
          ),
          // Runs trail the results, in their own group: a review card answers "what did
          // it conclude", a run answers "what is happening right now". Interleaving them
          // by nothing more than array order made the panel read as one undifferentiated
          // stack where the two questions were indistinguishable.
          hasWorkflowRuns
            ? h(
                "div",
                { className: "reviewer-panel-runs" },
                ...workflowRuns.map((run) =>
                  h(WorkflowRunCard, {
                    key: run.id,
                    run,
                    onResolveWorkflow,
                  })
                )
              )
            : null
        )
      : h(
          "div",
          { className: "reviewer-empty" },
          h(
            "p",
            { className: "reviewer-empty-copy" },
            "Ask another agent to review the current changes. The reviewer runs in its own session and reports back here."
          ),
          h(
            "div",
            { className: "reviewer-panel-actions" },
            canLaunchWorkflow ? workflowLauncher() : null,
            canLaunch ? launcher() : null
          ),
          !canRequest && !canStartWorkflow
            ? h(
                "p",
                { className: "reviewer-empty-hint" },
                canLaunchWorkflow
                  ? "Available when the author session is idle and writable."
                  : "Available when the agent is idle and no other device has control."
              )
            : null
        )
  );
}

function ReviewerJobCard({
  job,
  threadName,
  panelId = "review-panel",
  reviewModel = {},
  reusableReviewers = [],
  workspace = null,
  workspaceBusy = false,
  workspaceError = null,
  onPinWorkspace = null,
  onTrustWorkspace = null,
  canRequest = false,
  onRequestReview,
  onResolveReview,
  onDeleteReview,
  fetchReviewerTranscript,
}) {
  const [review, setReview] = React.useState({ status: "idle", text: null, error: null });
  // The reviewer session id is noise in the resting card, so it's collapsed behind a
  // small "i" in the header; this toggles it in/out (default hidden).
  const [showThread, setShowThread] = React.useState(false);
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
      // Left cluster: who's reviewing — provider + (when known) its own model.
      h(
        "div",
        { className: "reviewer-job-identity" },
        h(
          "span",
          {
            className: "reviewer-job-provider",
            // Drives the chip's brand hue in CSS, the same way the session tab's provider
            // mark is keyed. Absent for an unknown provider, which falls back to neutral.
            "data-provider": job.reviewer_provider || undefined,
          },
          job.reviewer_provider || "reviewer"
        ),
        // A reused thread may inherit its model and not carry one on the job.
        job.reviewer_model
          ? h(
              "span",
              { className: "reviewer-job-model", title: job.reviewer_model },
              job.reviewer_model
            )
          : null,
        // Effective reasoning effort for the reviewer's turn(s), when known. Shown
        // next to the model so the card reflects HOW the reviewer was run, not just
        // which model. `null` for a reused thread with no recorded effort anywhere.
        job.reviewer_effort
          ? h(
              "span",
              {
                className: "reviewer-job-effort",
                title: `Reasoning effort: ${job.reviewer_effort}`,
              },
              job.reviewer_effort
            )
          : null,
        // The reviewer session id is long/noisy in the resting card, so keep it
        // collapsed behind a small circled "i": click to reveal (works without hover,
        // i.e. on mobile), full value also lives in the tooltip + aria-label.
        threadName
          ? h(
              "button",
              {
                type: "button",
                className: "reviewer-job-info",
                title: threadName,
                "aria-label": showThread
                  ? `Hide reviewer session id (${threadName})`
                  : `Show reviewer session id (${threadName})`,
                "aria-expanded": showThread,
                onClick: () => setShowThread((v) => !v),
              },
              "i"
            )
          : null
      ),
      // Right cluster: iterative-loop progress only (when a budget was set). The status
      // label used to sit here too, which made "who reviewed" and "how it went" one
      // undifferentiated strip; it now leads the outcome row below, next to the verdict
      // it qualifies.
      job.max_rounds > 1
        ? h(
            "div",
            { className: "reviewer-job-meta" },
            h(
              "span",
              { className: "reviewer-job-round" },
              `Round ${job.round || 0}/${job.max_rounds}`
            )
          )
        : null
    ),
    // Revealed only when the header "i" is toggled on. Still truncated (CSS) with the
    // full value in the tooltip + aria-label so hovering reveals the whole thing.
    showThread && threadName
      ? h(
          "p",
          {
            className: "reviewer-job-thread",
            title: threadName,
            "aria-label": `Reviewer session: ${threadName}`,
          },
          threadName
        )
      : null,
    // The outcome row: what the reviewer concluded, and where that conclusion is in its
    // lifecycle. It renders even without a verdict, because a running review still has a
    // status worth showing — in that case the pill simply sits alone.
    h(
      "div",
      { className: "reviewer-job-outcome" },
      job.verdict && job.verdict !== "unknown"
        ? h(
            "p",
            {
              className: `reviewer-job-verdict reviewer-job-verdict-${verdictTone(job.verdict)}`,
            },
            h(VerdictMark, { verdict: job.verdict }),
            // The visible word drops the "Verdict:" prefix — the panel is already called
            // Reviewer and this is now the card's title, so the label was naming what its
            // own position says. Screen readers keep it.
            h("span", { className: "sr-only" }, "Verdict: "),
            h(
              "span",
              { className: "reviewer-job-verdict-label" },
              String(job.verdict).replace(/_/g, " ")
            )
          )
        : null,
      h(
        "span",
        { className: `reviewer-job-status reviewer-job-status-${reviewChipTone(job.status)}` },
        reviewStatusLabel(job.status)
      )
    ),
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
          h(
            "div",
            { className: "reviewer-job-review message-body" },
            renderReviewerText(review.text)
          )
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
                : "Stop this review now and unlock the reviewed session.",
              onClick: () => onResolveReview?.(job.id),
            },
            blocked ? "Stop reviewer & unlock" : "Stop review"
          )
        : null,
      // Per-card "Re-review": opens the request form PREFILLED to reuse this card's
      // reviewer thread (provider locked, reuse preselected) — so you can re-review
      // with this reviewer without hunting for it in the reuse dropdown. Only on a
      // terminal card with a reviewer thread, and only when this device can request.
      terminal && job.reviewer_thread_id && typeof onRequestReview === "function"
        ? h(ReviewLauncher, {
            // Namespaced by the panel mount (rail vs sheet) so the rail's and the
            // sheet's copies of this card don't share a dialog id — otherwise the
            // sheet's button opens the hidden rail's dialog and looks dead on mobile.
            panelId: `${panelId}-recard-${job.id}`,
            label: "Re-review",
            title: canRequest
              ? "Re-review the current changes with this reviewer (reuse preselected)"
              : "Available when the agent is idle and no other device has control",
            providerOptions: reviewModel.providerOptions || [],
            models: reviewModel.models || [],
            defaultProvider: reviewModel.defaultProvider || "",
            providerModelsStatus: reviewModel.providerModelsStatus || {},
            activeProvider: reviewModel.activeProvider || "",
            onEnsureProviderModels: reviewModel.onEnsureProviderModels,
            reusableReviewers,
            workspace,
            workspaceBusy,
            workspaceError,
            onPinWorkspace,
            onTrustWorkspace,
            // Re-review targets THIS card's own parent thread.
            parentThreadId: job.parent_thread_id || null,
            // May name a reviewer bound to a tree the work has since left. The dialog
            // falls back to a clean reviewer when the prefill is not on offer, rather
            // than submitting a reuse the relay will refuse.
            initialReviewerThreadId: job.reviewer_thread_id,
            initialProvider: job.reviewer_provider || "",
            disabled: !canRequest,
            onSubmit: onRequestReview,
          })
        : null,
      h(
        "button",
        {
          type: "button",
          className: "header-button reviewer-delete-button",
          disabled: !terminal,
          title: terminal
            ? "Delete this review and its reviewer session (the findings stay in the conversation)"
            : "Stop the reviewer before deleting it",
          onClick: () => terminal && onDeleteReview?.(job.id),
        },
        "Delete"
      )
    )
  );
}
