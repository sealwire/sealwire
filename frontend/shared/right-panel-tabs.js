import React from "react";

import { SegmentedControl } from "./session-settings-panel.js";
import { ReviewerPanel } from "./reviewer-panel.js";
import { isTerminalReviewStatus } from "./review-state.js";

const h = React.createElement;

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

  const inProgress = (review.reviewJobs || []).filter(
    (job) => !isTerminalReviewStatus(job.status)
  ).length;

  // A starting/running review (or a blocked one) is what the user just asked for —
  // pull them onto the Reviewer tab so the reviewer activity is visible instead of
  // running unseen behind the Changes tab. Fires only on the transition into the
  // attention state (dep is the derived flag), so it never fights manual tab use.
  const pullToReviewer = blocked || inProgress > 0;
  React.useEffect(() => {
    if (pullToReviewer && activeTab !== "reviewer") {
      store.setActiveTab?.("reviewer");
    }
  }, [pullToReviewer]);
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
          reusableReviewers: review.reusableReviewers || [],
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
