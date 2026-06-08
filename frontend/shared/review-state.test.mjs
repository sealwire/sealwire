import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_BLOCKED_BADGE,
  REVIEW_IN_PROGRESS_BADGE,
  reviewStatusBadge,
} from "./review-state.js";

// reviewStatusBadge is the single source of truth for the header "under review" badge
// shared by the local and remote surfaces, so its precedence/scoping must be pinned.

test("reviewStatusBadge returns the in-progress badge for a review on the active thread", () => {
  const session = {
    active_review_jobs: [{ id: "r1", status: "waiting_for_reviewer", parent_thread_id: "t1" }],
  };
  assert.deepEqual(reviewStatusBadge(session, "t1"), REVIEW_IN_PROGRESS_BADGE);
});

test("reviewStatusBadge stays null when the review is on a different thread", () => {
  const session = {
    active_review_jobs: [{ id: "r1", status: "waiting_for_reviewer", parent_thread_id: "t1" }],
  };
  assert.equal(reviewStatusBadge(session, "t2"), null);
});

test("reviewStatusBadge surfaces blocked regardless of which thread is active", () => {
  const session = {
    active_review_jobs: [{ id: "r1", status: "blocked", parent_thread_id: "t1" }],
  };
  // A blocked review needs attention anywhere — even with a different (or no) active thread.
  assert.deepEqual(reviewStatusBadge(session, "t2"), REVIEW_BLOCKED_BADGE);
  assert.deepEqual(reviewStatusBadge(session, null), REVIEW_BLOCKED_BADGE);
});

test("reviewStatusBadge: blocked takes precedence over in-progress", () => {
  const session = {
    active_review_jobs: [
      { id: "r1", status: "waiting_for_reviewer", parent_thread_id: "t1" },
      { id: "r2", status: "blocked", parent_thread_id: "t9" },
    ],
  };
  assert.deepEqual(reviewStatusBadge(session, "t1"), REVIEW_BLOCKED_BADGE);
});

test("reviewStatusBadge ignores terminal reviews", () => {
  const session = {
    active_review_jobs: [{ id: "r1", status: "complete", parent_thread_id: "t1" }],
  };
  assert.equal(reviewStatusBadge(session, "t1"), null);
});

test("reviewStatusBadge returns null with no reviews or no session (never throws)", () => {
  assert.equal(reviewStatusBadge({ active_review_jobs: [] }, "t1"), null);
  assert.equal(reviewStatusBadge(null, "t1"), null);
  assert.equal(reviewStatusBadge(undefined, undefined), null);
});
