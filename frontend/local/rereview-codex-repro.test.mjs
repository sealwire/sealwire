import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  selectReusableReviewers,
  selectReusableReviewersForView,
} from "../shared/reviewer-threads.js";
import { ReviewPanel } from "../shared/review-panel.js";

const h = React.createElement;

// Regression guard (local bug #1): "re-reviewing an existing codex reviewer can't
// select the known codex reviewer in the reuse dropdown".
//
// Shape mirrors the LIVE /api/session snapshot observed in the running relay:
//   - active_thread_id is some OTHER thread (a second session held the active slot),
//   - you are VIEWING a non-active thread that has a completed codex review, so its
//     terminal review card (with the "Re-review" button) renders,
//   - reviewer_threads carry reviewer_provider: null (the reviewer threads are not
//     in-process, so the backend's provider/name joins return null).
const VIEWED_THREAD = "62b5239b-viewed";
const ACTIVE_THREAD = "289f0a8d-active"; // a different session's live thread (no reviews)
const CODEX_REVIEWER = "019ecb24-codex-reviewer";

const session = {
  active_thread_id: ACTIVE_THREAD,
  active_review_jobs: [
    {
      id: "review-1",
      parent_thread_id: VIEWED_THREAD,
      status: "complete",
      reviewer_provider: "codex",
      reviewer_thread_id: CODEX_REVIEWER,
    },
  ],
  reviewer_threads: [
    {
      reviewer_thread_id: CODEX_REVIEWER,
      parent_thread_id: VIEWED_THREAD,
      reviewer_provider: null,
      name: null,
      updated_at: null,
    },
  ],
};

// render-session.js scopes the review JOB cards (and their per-card Re-review
// launchers) to the VIEWED thread; the reuse list must use the SAME scope.
const viewedThreadId = VIEWED_THREAD || session.active_thread_id || null;
const threadReviewJobs = (session.active_review_jobs || []).filter(
  (job) => job.parent_thread_id === viewedThreadId
);

test("the reuse picker is scoped to the viewed thread, like the re-review cards", () => {
  // The viewed thread's codex review card IS shown, so the user can click "Re-review".
  assert.equal(threadReviewJobs.length, 1);
  const job = threadReviewJobs[0];
  assert.equal(job.reviewer_thread_id, CODEX_REVIEWER);

  // This is how render-session.js now builds the reuse list (scoped to the viewed
  // thread, not active_thread_id).
  const offered = selectReusableReviewersForView(session, VIEWED_THREAD, null).map(
    (entry) => entry.reviewerThreadId
  );
  assert.ok(
    offered.includes(job.reviewer_thread_id),
    `re-review card references reviewer ${job.reviewer_thread_id}; the reuse list must ` +
      `offer it (got [${offered.join(", ")}])`
  );

  // Documents the original bug: scoping to active_thread_id offered nothing here.
  const scopedToActive = selectReusableReviewers(
    session.reviewer_threads,
    session.active_thread_id,
    null
  ).map((entry) => entry.reviewerThreadId);
  assert.ok(
    !scopedToActive.includes(CODEX_REVIEWER),
    "scoping the reuse list to active_thread_id is the old bug — it must not be used"
  );
});

test("ReviewPanel prefilled for the viewed thread's codex reviewer renders its Reuse option", () => {
  const reusableReviewers = selectReusableReviewersForView(session, VIEWED_THREAD, null);

  const html = renderToStaticMarkup(
    h(ReviewPanel, {
      providerOptions: [{ label: "Codex", value: "codex" }],
      models: [],
      defaultProvider: "claude_code",
      reusableReviewers,
      initialReviewerThreadId: CODEX_REVIEWER,
      initialProvider: "codex",
    })
  );

  assert.match(
    html,
    new RegExp(`value="${CODEX_REVIEWER}"`),
    "the codex reviewer must be offered as a Reuse option in the re-review dropdown"
  );
});
