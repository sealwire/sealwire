import test from "node:test";
import assert from "node:assert/strict";

import {
  countReviewerThreadsForParent,
  reviewerChoiceRequestInit,
} from "./shared/reviewer-threads.js";

test("countReviewerThreadsForParent counts only the matching parent's reviewers", () => {
  const reviewerThreads = [
    { reviewer_thread_id: "r1", parent_thread_id: "parent-A" },
    { reviewer_thread_id: "r2", parent_thread_id: "parent-A" },
    { reviewer_thread_id: "r3", parent_thread_id: "parent-B" },
  ];
  assert.equal(countReviewerThreadsForParent(reviewerThreads, "parent-A"), 2);
  assert.equal(countReviewerThreadsForParent(reviewerThreads, "parent-B"), 1);
  assert.equal(countReviewerThreadsForParent(reviewerThreads, "parent-C"), 0);
});

test("countReviewerThreadsForParent is defensive about missing inputs", () => {
  assert.equal(countReviewerThreadsForParent(undefined, "parent-A"), 0);
  assert.equal(countReviewerThreadsForParent(null, "parent-A"), 0);
  assert.equal(countReviewerThreadsForParent([], "parent-A"), 0);
  // A falsy parent id never matches (don't treat "no thread" as a parent).
  assert.equal(
    countReviewerThreadsForParent([{ parent_thread_id: "parent-A" }], undefined),
    0
  );
  // Tolerates malformed entries without throwing.
  assert.equal(
    countReviewerThreadsForParent([null, {}, { parent_thread_id: "parent-A" }], "parent-A"),
    1
  );
});

test("reviewerChoiceRequestInit omits the body when there is no explicit choice", () => {
  // No reviewers → the prompt never ran → bodyless request, so the backend applies
  // its endpoint default (archive keeps, delete cascades).
  assert.deepEqual(reviewerChoiceRequestInit(undefined), {});
});

test("reviewerChoiceRequestInit sends an explicit delete_reviewers body", () => {
  const yes = reviewerChoiceRequestInit(true);
  assert.deepEqual(yes.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(yes.body), { delete_reviewers: true });

  const no = reviewerChoiceRequestInit(false);
  assert.deepEqual(no.headers, { "Content-Type": "application/json" });
  // The explicit "keep" choice must still be transmitted (false is NOT bodyless),
  // otherwise the backend default would take over and could delete the reviewer.
  assert.deepEqual(JSON.parse(no.body), { delete_reviewers: false });
});
