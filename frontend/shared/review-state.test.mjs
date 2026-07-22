import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_BLOCKED_BADGE,
  REVIEW_IN_PROGRESS_BADGE,
  buildReviewingThreadSet,
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

test("reviewStatusBadge surfaces blocked workflows regardless of active thread", () => {
  const session = {
    active_review_jobs: [],
    active_workflow_runs: [{ id: "wf1", status: "blocked", parent_thread_id: "t1" }],
  };
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

test("buildReviewingThreadSet collects non-terminal review parents only", () => {
  const session = {
    active_review_jobs: [
      { parent_thread_id: "p1", reviewer_thread_id: "r1", status: "waiting_for_reviewer" },
      { parent_thread_id: "p2", reviewer_thread_id: "r2", status: "complete" },
      { parent_thread_id: "p3", reviewer_thread_id: "r3", status: "blocked" },
    ],
  };
  const set = buildReviewingThreadSet(session);
  assert.ok(set.has("p1"), "in-progress parent is reviewing");
  assert.ok(set.has("p3"), "blocked parent is still under review");
  assert.equal(set.has("p2"), false, "a completed review no longer marks its parent");
  // The set is keyed by parent, not the reviewer thread doing the work.
  assert.equal(set.has("r1"), false);
});

test("buildReviewingThreadSet is empty and never throws without jobs", () => {
  assert.equal(buildReviewingThreadSet({ active_review_jobs: [] }).size, 0);
  assert.equal(buildReviewingThreadSet(null).size, 0);
  assert.equal(buildReviewingThreadSet(undefined).size, 0);
  assert.equal(buildReviewingThreadSet({}).size, 0);
});
