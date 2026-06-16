import test from "node:test";
import assert from "node:assert/strict";

import {
  createReviewsCache,
  reviewCardsForViewedThread,
  reusableReviewersFromReviews,
} from "./reviews-cache.js";

test("createReviewsCache fetches only when the snapshot reviews_revision changes", async () => {
  let calls = 0;
  const cache = createReviewsCache();
  const fetchReviews = async () => {
    calls += 1;
    return {
      reviews_revision: 7,
      review_jobs: [{ id: "r1", parent_thread_id: "B", status: "complete" }],
      reviewer_threads: [{ reviewer_thread_id: "rev-1", parent_thread_id: "B" }],
    };
  };

  // First sight of revision 7 → fetch.
  await cache.sync(7, fetchReviews);
  assert.equal(calls, 1);
  assert.equal(cache.current().review_jobs.length, 1);

  // Same revision → cached, no refetch (the "don't keep fetching" guarantee).
  await cache.sync(7, fetchReviews);
  await cache.sync(7, fetchReviews);
  assert.equal(calls, 1);

  // A new revision → refetch.
  await cache.sync(8, async () => {
    calls += 1;
    return { reviews_revision: 8, review_jobs: [], reviewer_threads: [] };
  });
  assert.equal(calls, 2);
});

test("createReviewsCache does not refetch the same snapshot revision when the response revision lags", async () => {
  // Lag window: the relay state moved after the snapshot was sent, so the dedicated channel
  // returns a DIFFERENT reviews_revision than the snapshot we synced against. The cache must
  // still treat that snapshot revision as handled — otherwise re-render → sync → fetch loops
  // (bounded but wasteful) until the snapshot is redelivered.
  let calls = 0;
  const cache = createReviewsCache();
  const fetchLagging = async () => {
    calls += 1;
    return { reviews_revision: 99, review_jobs: [], reviewer_threads: [] };
  };
  await cache.sync(7, fetchLagging);
  await cache.sync(7, fetchLagging); // same snapshot revision → must NOT refetch
  await cache.sync(7, fetchLagging);
  assert.equal(calls, 1, "a snapshot revision is fetched at most once, even if the response lags");

  // A genuinely new snapshot revision still refetches.
  await cache.sync(8, fetchLagging);
  assert.equal(calls, 2);
});

test("createReviewsCache keeps the prior cache on fetch error and ignores null revision", async () => {
  const cache = createReviewsCache();
  await cache.sync(3, async () => ({
    reviews_revision: 3,
    review_jobs: [{ id: "r1", parent_thread_id: "B", status: "complete" }],
    reviewer_threads: [],
  }));
  assert.equal(cache.hasData(), true);

  // A later failed fetch must not wipe the cache.
  await cache.sync(4, async () => {
    throw new Error("network");
  });
  assert.equal(cache.current().review_jobs.length, 1, "prior cache survives a failed refetch");

  // A null revision (no snapshot value) is a no-op.
  let called = false;
  await cache.sync(null, async () => {
    called = true;
    return { reviews_revision: 0, review_jobs: [], reviewer_threads: [] };
  });
  assert.equal(called, false);
});

test("reviewCardsForViewedThread scopes cards to the viewed thread (the bug: empty snapshot, full cache)", () => {
  // This is the exact failure: the snapshot's active_review_jobs was drained empty under a
  // live turn, but the dedicated channel's cards are full. The panel must read the cache.
  const reviews = {
    review_jobs: [
      { id: "r1", parent_thread_id: "B", status: "complete", reviewer_thread_id: "rev-b" },
      { id: "r2", parent_thread_id: "A", status: "complete", reviewer_thread_id: "rev-a" },
    ],
    reviewer_threads: [],
  };
  assert.deepEqual(
    reviewCardsForViewedThread(reviews, "B").map((j) => j.id),
    ["r1"]
  );
  assert.deepEqual(reviewCardsForViewedThread(reviews, "A").map((j) => j.id), ["r2"]);
  assert.deepEqual(reviewCardsForViewedThread(reviews, "C"), []);
});

test("reusableReviewersFromReviews offers the viewed thread's reviewer threads", () => {
  const reviews = {
    review_jobs: [],
    reviewer_threads: [
      { reviewer_thread_id: "rev-b", parent_thread_id: "B", reviewer_provider: "codex" },
      { reviewer_thread_id: "rev-a", parent_thread_id: "A", reviewer_provider: "claude_code" },
    ],
  };
  assert.deepEqual(
    reusableReviewersFromReviews(reviews, "B").map((e) => e.reviewerThreadId),
    ["rev-b"]
  );
});
