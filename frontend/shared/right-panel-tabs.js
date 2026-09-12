import React from "react";

import { SegmentedControl } from "./session-settings-panel.js";
import { ReviewerPanel } from "./reviewer-panel.js";
import { isTerminalReviewStatus } from "./review-state.js";
import { CODE_FLOW_ENABLED, isTerminalWorkflowStatus } from "./workflow-state.js";

const h = React.createElement;

function useStoreState(store) {
  return React.useSyncExternalStore(
    React.useCallback((listener) => store.subscribe(() => listener()), [store]),
    () => store.getState(),
    () => store.getState()
  );
}

const EMPTY_REVIEW = {
  reviewJobs: [],
  workflowRuns: [],
  reviewModel: {},
  workflowModel: {},
  canRequest: false,
  canStartWorkflow: false,
  blocked: false,
};

// Composes the existing "Changes" body (passed in as `changes`, since the rail
// and the mobile sheet render it differently) with a "Reviewer" tab. Tab state
// + review data live on the shared workspace-diff store, so the rail and the
// mobile sheet of one surface stay in sync. `reviewer` carries the injected
// action callbacks + transcript fetch; `panelId` namespaces the request modal so
// multiple mounts (rail + sheet) don't collide on a dialog id.
export function RightPanelTabs({ store, changes, reviewer = {}, panelId = "review-panel" }) {
  const state = useStoreState(store);
  const review = state.review || EMPTY_REVIEW;
  const activeTab = state.activeTab === "reviewer" ? "reviewer" : "changes";
  const blocked = Boolean(review.blocked);

  const inProgress = (review.reviewJobs || []).filter(
    (job) => !isTerminalReviewStatus(job.status)
  ).length;
  // Hidden Code Flow must not badge the tab either — a dot on "Reviewer" that leads to a
  // panel showing no running anything is worse than no dot at all.
  const workflowInProgress = CODE_FLOW_ENABLED
    ? (review.workflowRuns || []).filter((run) => !isTerminalWorkflowStatus(run.status)).length
    : 0;
  // An agent brought in by this session counts the same as a review: this tab is
  // now "who else is working on this", and a reviewer is one of those.
  const asksInProgress = (review.asks || []).filter((ask) => ask.status === "working").length;
  // A goal being worked on belongs in the tab's dot too: it is the longest-lived
  // thing this panel shows.
  const goalWorking = review.goal?.status === "active" ? 1 : 0;

  // NEVER auto-switch the tab — the review must not yank the user's view around.
  // A running/blocked review only surfaces PASSIVELY here: the tab label gets a dot
  // ("Reviewer •") or a warning ("Reviewer ⚠"), and the user switches when they want.
  // "Agents", not "Reviewer": a reviewer is just one of the agents this session
  // can bring in, and the panel now lists the others beside it.
  const reviewerLabel = blocked
    ? "Agents ⚠"
    : inProgress > 0 || workflowInProgress > 0 || asksInProgress > 0 || goalWorking > 0
    ? "Agents •"
    : "Agents";

  return h(
    "div",
    { className: "right-panel-tabs" },
    h(
      "div",
      { className: "right-panel-tabs-header" },
      h(SegmentedControl, {
        id: `${panelId}-tabs`,
        value: activeTab,
        onChange: (value) => store.setActiveTab?.(value),
        options: [
          { value: "changes", label: "Changes" },
          { value: "reviewer", label: reviewerLabel },
        ],
      })
    ),
    activeTab === "reviewer"
      ? h(ReviewerPanel, {
          panelId,
          reviewJobs: review.reviewJobs || [],
          asks: review.asks || [],
          goal: review.goal || null,
          onStopGoal: reviewer.onStopGoal || null,
          onResumeGoal: reviewer.onResumeGoal || null,
          onOpenThread: reviewer.onOpenThread || null,
          workflowRuns: review.workflowRuns || [],
          reviewModel: review.reviewModel || {},
          workflowModel: review.workflowModel || {},
          reusableReviewers: review.reusableReviewers || [],
          reviewerThreads: review.reviewerThreads || [],
          parentThreadId: review.parentThreadId || null,
          // The working tree comes off the store, not the review slice: it is the SAME
          // resolved workspace the Changes tab is diffing, so the two tabs can never
          // disagree about which tree the panel is about.
          workspace: state.workspace || null,
          workspaceBusy: Boolean(state.workspacePinning),
          workspaceError: state.workspaceError || null,
          onPinWorkspace: (path) => store.pinWorkspace?.(path),
          onOpenWorkspace: (owner) => store.measureRoots?.(owner),
          onCloseWorkspace: (owner) => store.stopMeasuringRoots?.(owner),
          // Null on a paired device: granting is local-only, so the review dialog there
          // explains the ungranted tree instead of offering to fix it.
          onTrustWorkspace: store.canTrustWorkspace
            ? (path) => void store.trustWorkspace?.(path)
            : null,
          canRequest: Boolean(review.canRequest),
          canStartWorkflow: Boolean(review.canStartWorkflow),
          requesting: Boolean(review.requesting),
          onRequestReview: reviewer.onRequestReview,
          onStartWorkflow: reviewer.onStartWorkflow,
          onResolveReview: reviewer.onResolveReview,
          onResolveWorkflow: reviewer.onResolveWorkflow,
          onDeleteReview: reviewer.onDeleteReview,
          fetchReviewerTranscript: reviewer.fetchReviewerTranscript,
        })
      : changes
  );
}
