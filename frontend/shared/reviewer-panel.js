import React from "react";

import { formatRelativeTime } from "../remote/utils.js";
import {
  askLedger,
  askedSummary,
  reviewLedger,
  reviewOutcome,
} from "./agents-ledger.js";
import { renderMarkdown } from "./markdown.js";
import { providerMark } from "./provider-mark.js";
import { transcriptPageIsFromAnotherGeneration } from "./transcript-generation.js";
import { ReviewLauncher } from "./review-panel.js";
import { CodeFlowLauncher, WorkflowRunCard } from "./workflow-panel.js";
import { MenuPortal, useAnchoredMenu } from "./use-anchored-menu.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";
import { isTerminalReviewStatus } from "./review-state.js";
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

// `updated_at` is the only clock the relay carries for any of these, so a live row can
// only honestly say how long it has been QUIET — never how long it has been running.
function sinceLabel(at, live) {
  const rel = formatRelativeTime(at);
  if (live) {
    return rel === "now" ? "working" : `working ${rel}`;
  }
  return rel === "now" ? "just now" : `${rel} ago`;
}

function LiveDot() {
  return h("span", { className: "reviewer-live-dot", "aria-hidden": "true" });
}

// A section heading, not a card title: the ledger's rule is that the subject rises out
// of the cards and becomes the thing they are grouped under.
function LedgerHeading({ label, meta = null, metaTitle = null, trailing = null }) {
  return h(
    "div",
    { className: "reviewer-ledger-heading" },
    h("span", { className: "reviewer-ledger-label" }, label),
    // The row truncates, so whatever the ellipsis eats has to survive on the tooltip.
    h("span", { className: "reviewer-ledger-meta", title: metaTitle || meta || undefined }, meta),
    trailing ? h("span", { className: "reviewer-ledger-trailing" }, trailing) : null
  );
}

// Earlier rounds of the same delegation. One line each — a failed attempt gets a row,
// never a second card repeating the same error.
function RoundRows({ rounds }) {
  if (!rounds?.length) {
    return null;
  }
  return h(
    "div",
    { className: "reviewer-rounds" },
    ...rounds.map((round) =>
      h(
        "div",
        { className: "reviewer-round", key: round.id },
        h("span", { className: "reviewer-round-label" }, round.label),
        h("span", { className: "reviewer-round-summary", title: round.summary }, round.summary),
        h("span", { className: "reviewer-round-time" }, formatRelativeTime(round.at))
      )
    )
  );
}

function LedgerMenu({ items, label = "More actions" }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const menuId = React.useId();
  const close = React.useCallback(() => setOpen(false), []);
  useDismissableMenu({ menuRef, onClose: close, open, rootRef });
  const assignMenuRef = useAnchoredMenu({ menuRef, open, triggerRef });

  const usable = (items || []).filter(Boolean);
  if (!usable.length) {
    return null;
  }
  return h(
    "div",
    { className: "reviewer-menu", ref: rootRef },
    h(
      "button",
      {
        type: "button",
        className: "reviewer-menu-button",
        "aria-controls": open ? menuId : undefined,
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-label": label,
        title: label,
        ref: triggerRef,
        onClick: () => setOpen((value) => !value),
      },
      "···"
    ),
    h(
      MenuPortal,
      { anchorRef: triggerRef, open },
      h(
        "div",
        {
          className: "header-overflow-menu reviewer-menu-list",
          id: menuId,
          ref: assignMenuRef,
          role: "menu",
        },
        ...usable.map((item) =>
          h(
            "button",
            {
              className: `overflow-menu-item${item.danger ? " is-danger" : ""}`,
              disabled: Boolean(item.disabled),
              key: item.key,
              onClick: () => {
                close();
                item.onSelect?.();
              },
              role: "menuitem",
              title: item.title,
              type: "button",
            },
            item.label
          )
        )
      )
    )
  );
}

// What this session is working toward.
//
// The wording is load-bearing: "reports complete", never "complete". The relay
// carries the work without reading it, so it cannot tell you the goal is met —
// only that the agent says so.
const GOAL_STATUS_LABEL = {
  active: "Working",
  awaiting_user: "Waiting on you",
  complete_claimed: "Agent reports complete",
  blocked: "Stuck",
  out_of_turns: "Out of turns",
  interrupted: "Interrupted by a restart",
};

// Above the review slot, because it outranks it: a review judges one commit, the goal is
// the standing objective every commit — and every review — is in service of.
function GoalSlot({ goal, onStop = null, onResume = null }) {
  const working = goal.status === "active";
  const status = GOAL_STATUS_LABEL[goal.status] || goal.status;
  return h(
    React.Fragment,
    null,
    h(LedgerHeading, {
      label: "Goal",
      meta: working ? `Turn ${goal.turns} of ${goal.max_turns}` : `${goal.turns} turns used`,
      trailing: h(
        "span",
        { className: `reviewer-goal-status${working ? " is-live" : ""}` },
        working ? h(LiveDot) : null,
        status
      ),
    }),
    h(
      "article",
      { className: `reviewer-card reviewer-goal${working ? " is-live" : ""}` },
      h("p", { className: "reviewer-card-title" }, goal.objective),
      goal.outcome ? h("p", { className: "reviewer-card-result" }, goal.outcome) : null,
      working || onResume
        ? h(
            "div",
            { className: "reviewer-card-actions" },
            working && onStop
              ? h(
                  "button",
                  { className: "reviewer-card-button", onClick: () => onStop(), type: "button" },
                  "Stop"
                )
              : null,
            // Everything that is not active can be picked back up — including a
            // completion claim you do not accept.
            !working && onResume
              ? h(
                  "button",
                  {
                    className: "reviewer-card-button",
                    onClick: () => onResume(goal.objective),
                    type: "button",
                  },
                  goal.status === "complete_claimed" ? "Not done — keep going" : "Keep going"
                )
              : null
          )
        : null
    )
  );
}

// A review is a delegation like any other, so it shares the list — but it decides whether
// the work can land, so it gets the permanent slot at the top rather than a place in time.
function ReviewSlot({
  ledger,
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
  onOpenThread,
  fetchReviewerTranscript,
}) {
  const job = ledger.latest;
  const [review, setReview] = React.useState({ status: "idle", text: null, error: null });
  const terminal = isTerminalReviewStatus(job.status);
  const reviewerThreadId = job.reviewer_thread_id || null;
  const outcome = reviewOutcome(job);

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

  // Effort is the quietest fact on the row and the first to cost the model its space,
  // so it rides the tooltip only.
  const meta = [ledger.roundLabel, ledger.provider, job.reviewer_model]
    .filter(Boolean)
    .join(" · ");
  return h(
    React.Fragment,
    null,
    h(LedgerHeading, {
      label: "Review",
      meta,
      metaTitle: job.reviewer_effort ? `${meta} · effort ${job.reviewer_effort}` : meta,
      // Short sha only: the reviewer's own session id is a bare uuid and says nothing
      // about WHAT was reviewed, which is the only identity worth a slot here.
      trailing: ledger.sha
        ? h("span", { className: "reviewer-sha", title: "Reviewed commit" }, ledger.sha)
        : null,
    }),
    h(
      "article",
      { className: `reviewer-card reviewer-review reviewer-tone-${outcome.tone}` },
      h(
        "div",
        { className: "reviewer-review-banner" },
        h("span", { className: "reviewer-review-banner-dot", "aria-hidden": "true" }),
        h("span", { className: "reviewer-review-banner-text" }, outcome.text),
        h(
          "span",
          { className: "reviewer-review-banner-time" },
          sinceLabel(job.updated_at, !terminal)
        )
      ),
      h(
        "div",
        { className: "reviewer-review-body" },
        job.error ? h("p", { className: "reviewer-card-error" }, job.error) : null,
        review.status === "loading" && !review.text
          ? h(
              "p",
              { className: "reviewer-card-note" },
              terminal ? "Loading review…" : "Loading the reviewer's latest message…"
            )
          : null,
        review.status === "error" && !review.text
          ? h(
              "p",
              { className: "reviewer-card-error" },
              `Couldn't load the reviewer's messages: ${review.error}`
            )
          : null,
        review.text
          ? h(
              "div",
              { className: "reviewer-findings message-body" },
              // Labelled only while running, so it is clear this is the reviewer mid-turn
              // rather than the review it will post back.
              !terminal
                ? h("p", { className: "reviewer-card-note" }, "Reviewer's latest message:")
                : null,
              renderReviewerText(review.text)
            )
          : null,
        h(RoundRows, { rounds: ledger.rounds }),
        h(
          "div",
          { className: "reviewer-card-actions" },
          // Re-review stays on the card because this is the only place that says WHICH
          // commit was reviewed; the bar below it is for starting something new.
          terminal && reviewerThreadId && typeof onRequestReview === "function"
            ? h(ReviewLauncher, {
                // Namespaced by the panel mount (rail vs sheet) so the rail's and the
                // sheet's copies don't share a dialog id — otherwise the sheet's button
                // opens the hidden rail's dialog and looks dead on mobile.
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
                parentThreadId: job.parent_thread_id || null,
                // May name a reviewer bound to a tree the work has since left. The dialog
                // falls back to a clean reviewer when the prefill is not on offer, rather
                // than submitting a reuse the relay will refuse.
                initialReviewerThreadId: reviewerThreadId,
                initialProvider: job.reviewer_provider || "",
                disabled: !canRequest,
                onSubmit: onRequestReview,
              })
            : null,
          reviewerThreadId && typeof onOpenThread === "function"
            ? h(
                "button",
                {
                  className: "reviewer-open-link",
                  onClick: () => onOpenThread(reviewerThreadId),
                  title: threadName || "Open the reviewer's session",
                  type: "button",
                },
                "Open review"
              )
            : null,
          h(LedgerMenu, {
            label: "Review actions",
            items: [
              !terminal && onResolveReview
                ? {
                    key: "stop",
                    label: job.status === "blocked" ? "Stop reviewer & unlock" : "Stop review",
                    title:
                      job.status === "blocked"
                        ? "The reviewer turn couldn't be stopped and the workspace is locked. Stop it to unlock."
                        : "Stop this review now and unlock the reviewed session.",
                    onSelect: () => onResolveReview(job.id),
                  }
                : null,
              onDeleteReview
                ? {
                    danger: true,
                    disabled: !terminal,
                    key: "delete",
                    label: "Delete review",
                    title: terminal
                      ? "Delete this review and its reviewer session (the findings stay in the conversation)"
                      : "Stop the reviewer before deleting it",
                    onSelect: () => onDeleteReview(job.id),
                  }
                : null,
            ],
          })
        )
      )
    )
  );
}

// One delegation subject. Repeat follow-ups to the same agent session are rounds INSIDE
// it, so the panel stops printing the same subject once per turn.
function AskThreadCard({ thread, onOpen = null }) {
  const live = thread.state === "working";
  const open = onOpen && thread.otherThreadId ? () => onOpen(thread.otherThreadId) : null;
  return h(
    "article",
    {
      className: `reviewer-card reviewer-ask${live ? " is-live" : ""}${open ? " is-openable" : ""}`,
      onClick: open || undefined,
      onKeyDown: open
        ? (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          }
        : undefined,
      role: open ? "button" : undefined,
      tabIndex: open ? 0 : undefined,
    },
    h(
      "div",
      { className: "reviewer-ask-head" },
      // The prompt itself never renders — the title carries the intent, the tooltip
      // carries the wording, and the session behind the card carries the rest.
      h("h3", { className: "reviewer-card-title", title: thread.prompt || undefined }, thread.title),
      h(
        "span",
        { className: `reviewer-ask-state is-${live ? "live" : thread.state.replace(/\s+/g, "-")}` },
        live ? h(LiveDot) : null,
        live ? formatRelativeTime(thread.updatedAt) : thread.state
      )
    ),
    // Which way round the delegation runs is not in the title any more, so it rides here.
    thread.inbound ? h("p", { className: "reviewer-ask-inbound" }, "asked you") : null,
    thread.result ? h("p", { className: "reviewer-card-result" }, thread.result) : null,
    h(RoundRows, { rounds: thread.rounds })
  );
}

function AgentGroup({ group, onOpen = null }) {
  const mark = providerMark(group.provider, "reviewer-agent-mark");
  return h(
    "section",
    { className: "reviewer-agent" },
    h(
      "div",
      { className: "reviewer-agent-head" },
      mark ||
        h(
          "span",
          { className: "reviewer-agent-mark is-letter", "aria-hidden": "true" },
          group.name.slice(0, 1).toLowerCase()
        ),
      h("span", { className: "reviewer-agent-name" }, group.name),
      group.model ? h("span", { className: "reviewer-agent-model" }, group.model) : null,
      h(
        "span",
        { className: `reviewer-agent-state${group.working ? " is-live" : ""}` },
        group.working ? h(LiveDot) : null,
        group.working ? sinceLabel(group.updatedAt, true) : "idle"
      )
    ),
    ...group.threads.map((thread) => h(AskThreadCard, { key: thread.key, onOpen, thread }))
  );
}

// Join a job to its reviewer thread's display name so "Open review" can name where it goes.
function reviewerThreadName(job, reviewerThreads) {
  const id = job?.reviewer_thread_id;
  if (!id) return null;
  const match = (reviewerThreads || []).find((rt) => rt?.reviewer_thread_id === id);
  const name = match?.name && match.name.trim() ? match.name.trim() : null;
  return name || null;
}

// Pure-presentational reviewer surface. All data + actions are injected so the
// same component works on the local (apiFetch) and remote (broker) surfaces.
//   reviewJobs:        Vec<ReviewJobView> from the reviews channel
//   workflowRuns:      Vec<WorkflowRunView> from session.active_workflow_runs
//   reviewModel:       { providerOptions, models, defaultProvider }
//   canRequest:        whether a new review can be started (idle + controller)
//   onRequestReview:   ({reviewerProvider, reviewerModel, instructions}) => void
//   onStartWorkflow:   ({taskPrompt, reviewerProvider, reviewerModel}) => void
//   onResolveReview:   (jobId) => void           (stop a review)
//   onResolveWorkflow: (runId) => void           (stop a workflow)
//   onDeleteReview:    (jobId) => void           (delete a terminal review)
//   fetchReviewerTranscript: (threadId) => Promise<entries[]>
export function ReviewerPanel({
  reviewJobs = [],
  asks = [],
  goal = null,
  onStopGoal = null,
  onResumeGoal = null,
  onOpenThread = null,
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
  const review = reviewLedger(reviewJobs);
  const agents = askLedger(asks, parentThreadId);
  // Both gated on the feature switch, so a thread that has ONLY hidden workflow runs falls
  // through to the empty state's call to action rather than rendering a populated panel
  // with nothing in it.
  const hasWorkflowRuns = CODE_FLOW_ENABLED && workflowRuns.length > 0;
  const hasCards = Boolean(review) || agents.length > 0 || hasWorkflowRuns || Boolean(goal);
  const canLaunch = typeof onRequestReview === "function";
  const canLaunchWorkflow = CODE_FLOW_ENABLED && typeof onStartWorkflow === "function";

  return h(
    "section",
    { className: "reviewer-panel" },
    h(
      "div",
      { className: "reviewer-panel-body" },
      goal ? h(GoalSlot, { goal, onResume: onResumeGoal, onStop: onStopGoal }) : null,
      review
        ? h(ReviewSlot, {
            ledger: review,
            threadName: reviewerThreadName(review.latest, reviewerThreads),
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
            onOpenThread,
            fetchReviewerTranscript,
          })
        : null,
      review && agents.length ? h("hr", { className: "reviewer-ledger-rule" }) : null,
      agents.length
        ? h(LedgerHeading, { label: "Asked", meta: askedSummary(agents) })
        : null,
      ...agents.map((group) => h(AgentGroup, { group, key: group.key, onOpen: onOpenThread })),
      // Runs trail the results: a review card answers "what did it conclude", a run
      // answers "what is happening right now".
      hasWorkflowRuns
        ? h(
            "div",
            { className: "reviewer-panel-runs" },
            ...workflowRuns.map((run) => h(WorkflowRunCard, { key: run.id, onResolveWorkflow, run }))
          )
        : null,
      hasCards
        ? null
        : h(
            "div",
            { className: "reviewer-empty" },
            h(
              "p",
              { className: "reviewer-empty-copy" },
              "Other agents working on this appear here — one you asked for help, or one reviewing the current changes. Each runs in its own session you can open and take over."
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
    ),
    // One bar, always there, whether or not the ledger has anything in it — so the
    // affordance is discoverable, and exactly ONE launcher mounts per panelId.
    canLaunch || canLaunchWorkflow
      ? h(
          "div",
          { className: "reviewer-panel-bar" },
          canLaunch
            ? h(ReviewLauncher, {
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
              })
            : null,
          canLaunchWorkflow
            ? h(CodeFlowLauncher, {
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
              })
            : null
        )
      : null
  );
}
