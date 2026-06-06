import React from "react";

import { SegmentedControl } from "./session-settings-panel.js";
import { ReviewerPanel } from "./reviewer-panel.js";

const h = React.createElement;

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

function useStoreState(store) {
  return React.useSyncExternalStore(
    React.useCallback((listener) => store.subscribe(() => listener()), [store]),
    () => store.getState(),
    () => store.getState()
  );
}

const EMPTY_REVIEW = { reviewJobs: [], reviewModel: {}, canRequest: false, blocked: false };

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

  // A blocked review needs attention now — pull the user onto the Reviewer tab.
  React.useEffect(() => {
    if (blocked && activeTab !== "reviewer") {
      store.setActiveTab?.("reviewer");
    }
  }, [blocked]);

  const inProgress = (review.reviewJobs || []).filter(
    (job) => !TERMINAL.has(job.status)
  ).length;
  const reviewerLabel = blocked
    ? "Reviewer ⚠"
    : inProgress > 0
    ? "Reviewer •"
    : "Reviewer";

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
          reviewModel: review.reviewModel || {},
          canRequest: Boolean(review.canRequest),
          requesting: Boolean(review.requesting),
          onRequestReview: reviewer.onRequestReview,
          onResolveReview: reviewer.onResolveReview,
          onDismissReview: reviewer.onDismissReview,
          fetchReviewerTranscript: reviewer.fetchReviewerTranscript,
        })
      : changes
  );
}
