import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_BLOCKED_BADGE,
  REVIEW_IN_PROGRESS_BADGE,
  buildReviewingThreadSet,
  canRequestReview,
  offersReviewNudge,
  isReviewBlocked,
  isReviewInProgress,
  isReviewInProgressForThread,
  isThreadReviewLocked,
  reviewStatusBadge,
} from "./review-state.js";

test("review activity projection is authoritative over the legacy full-card field", () => {
  const session = {
    review_activity: [{ id: "live", status: "blocked", parent_thread_id: "t1" }],
    active_review_jobs: [{ id: "legacy", status: "complete", parent_thread_id: "t1" }],
  };
  assert.equal(isReviewInProgress(session), true);
  assert.equal(isReviewBlocked(session), true);
  assert.equal(isReviewInProgressForThread(session, "t1"), true);
});

test("a capped review projection uses global summaries and the viewed thread's exact lock bit", () => {
  const session = {
    active_thread_id: "parent-outside-cap",
    current_status: "idle",
    review_activity_total: 64,
    review_blocked: true,
    review_locked: true,
    review_activity: [
      {
        id: "inside-cap",
        status: "waiting_for_reviewer",
        parent_thread_id: "other-parent",
        reviewer_thread_id: "other-reviewer",
      },
    ],
    workflow_activity: [],
    pending_approvals: [],
  };

  assert.equal(isReviewInProgress(session), true);
  assert.equal(isReviewBlocked(session), true);
  assert.equal(isReviewInProgressForThread(session, "parent-outside-cap"), true);
  assert.equal(isThreadReviewLocked(session, "parent-outside-cap"), true);
  assert.equal(canRequestReview(session, "device-1", "parent-outside-cap"), false);
  assert.equal(
    canRequestReview(
      { ...session, active_thread_id: "unrelated", review_locked: false },
      "device-1",
      "unrelated"
    ),
    true,
    "concurrent reviews on other threads must not globally disable the review CTA"
  );
});

test("the dedicated reviews payload supplies the complete reviewing-thread set", () => {
  const set = buildReviewingThreadSet(
    {
      review_activity_total: 64,
      review_activity: [
        { parent_thread_id: "inside-cap", status: "waiting_for_reviewer" },
      ],
    },
    {
      review_jobs: [
        { parent_thread_id: "inside-cap", status: "waiting_for_reviewer" },
        { parent_thread_id: "outside-cap", status: "blocked" },
      ],
    }
  );

  assert.ok(set.has("inside-cap"));
  assert.ok(set.has("outside-cap"));
});

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

const userRow = (id, injection = null) => ({
  item_id: id,
  kind: "user_text",
  text: id,
  ...(injection ? { injection: { kind: injection } } : {}),
});
const agentRow = (id) => ({ item_id: id, kind: "agent_text", text: id });

test("the review nudge is not offered in a reviewer's own thread", () => {
  const session = { transcript: [userRow("u1"), agentRow("a1")] };
  const reviews = { reviewer_threads: [{ reviewer_thread_id: "rev", parent_thread_id: "p" }] };
  assert.equal(offersReviewNudge(session, reviews, "rev"), false);
  assert.equal(offersReviewNudge(session, reviews, "p"), true);
  // Before the reviews channel loads, the snapshot's own list is enough.
  const early = { ...session, reviewer_threads: reviews.reviewer_threads };
  assert.equal(offersReviewNudge(early, null, "rev"), false);
});

test("the review nudge waits while a thread is doing another agent's task", () => {
  for (const kind of ["delegate_task", "delegate_nudge"]) {
    const working = { transcript: [userRow("u1"), userRow("task", kind), agentRow("a1")] };
    assert.equal(offersReviewNudge(working, null, "t"), false, kind);
  }
  const reported = {
    transcript: [
      userRow("task", "delegate_task"),
      agentRow("a1"),
      { ...agentRow("r"), injection: { kind: "delegate_reported" } },
    ],
  };
  assert.equal(offersReviewNudge(reported, null, "t"), false, "still the other agent's round");
  const withdrawn = {
    transcript: [userRow("task", "delegate_task"), { ...userRow("mine"), withdrawn: true }],
  };
  assert.equal(offersReviewNudge(withdrawn, null, "t"), false, "a rejected send never happened");
  const reviewedSince = {
    transcript: [userRow("task", "delegate_task"), agentRow("a1"), userRow("result", "review_result"), agentRow("a2")],
  };
  assert.equal(offersReviewNudge(reviewedSince, null, "t"), false, "only the person's own words end it");
});

test("the review nudge comes back once the person speaks in the thread again", () => {
  const session = {
    transcript: [userRow("task", "delegate_task"), agentRow("a1"), userRow("mine"), agentRow("a2")],
  };
  assert.equal(offersReviewNudge(session, null, "t"), true);
  const asker = {
    transcript: [userRow("mine"), userRow("answer", "delegate_answer"), agentRow("a")],
  };
  assert.equal(offersReviewNudge(asker, null, "t"), true, "an answer coming back is the asker's own work");
});
