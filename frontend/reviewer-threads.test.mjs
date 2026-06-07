import test from "node:test";
import assert from "node:assert/strict";

import {
  countReviewerThreadsForParent,
  reviewerChoiceRequestInit,
  selectReusableReviewers,
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

const REVIEWERS = [
  {
    reviewer_thread_id: "rev-codex-old",
    parent_thread_id: "parent-A",
    reviewer_provider: "codex",
    name: "Codex reviewer",
    updated_at: 100,
  },
  {
    reviewer_thread_id: "rev-codex-new",
    parent_thread_id: "parent-A",
    reviewer_provider: "codex",
    name: "Codex reviewer 2",
    updated_at: 200,
  },
  {
    reviewer_thread_id: "rev-claude",
    parent_thread_id: "parent-A",
    reviewer_provider: "claude_code",
    name: "Claude reviewer",
    updated_at: 150,
  },
  {
    reviewer_thread_id: "rev-other-parent",
    parent_thread_id: "parent-B",
    reviewer_provider: "codex",
    name: "Other parent reviewer",
    updated_at: 999,
  },
];

test("selectReusableReviewers filters to the parent and sorts newest-first", () => {
  const result = selectReusableReviewers(REVIEWERS, "parent-A", null);
  // Only parent-A's reviewers, newest updated_at first.
  assert.deepEqual(
    result.map((r) => r.reviewerThreadId),
    ["rev-codex-new", "rev-claude", "rev-codex-old"]
  );
  // Normalized shape with a human label.
  assert.deepEqual(result[0], {
    reviewerThreadId: "rev-codex-new",
    provider: "codex",
    label: "Codex reviewer 2",
  });
});

test("selectReusableReviewers filters by provider but keeps unknown-provider entries", () => {
  const codex = selectReusableReviewers(REVIEWERS, "parent-A", "codex").map(
    (r) => r.reviewerThreadId
  );
  assert.deepEqual(codex, ["rev-codex-new", "rev-codex-old"]);

  // A reviewer whose provider is unknown (null, e.g. after a restart) is still
  // offered for any provider — the backend re-derives it on submit.
  const withGhost = [
    ...REVIEWERS,
    {
      reviewer_thread_id: "rev-ghost",
      parent_thread_id: "parent-A",
      reviewer_provider: null,
      name: null,
      updated_at: 50,
    },
  ];
  const codexWithGhost = selectReusableReviewers(withGhost, "parent-A", "codex").map(
    (r) => r.reviewerThreadId
  );
  assert.ok(codexWithGhost.includes("rev-ghost"), "unknown-provider reviewer is offered");
  // Its label falls back to the id when there's no name.
  const ghost = selectReusableReviewers(withGhost, "parent-A", "codex").find(
    (r) => r.reviewerThreadId === "rev-ghost"
  );
  assert.equal(ghost.label, "rev-ghost");
});

test("selectReusableReviewers is defensive about missing inputs", () => {
  assert.deepEqual(selectReusableReviewers(undefined, "parent-A", null), []);
  assert.deepEqual(selectReusableReviewers(REVIEWERS, undefined, null), []);
  assert.deepEqual(selectReusableReviewers(REVIEWERS, "parent-Z", null), []);
  // Tolerates malformed entries (null / missing id) without throwing.
  const messy = [null, {}, { parent_thread_id: "parent-A" }, REVIEWERS[0]];
  assert.deepEqual(
    selectReusableReviewers(messy, "parent-A", null).map((r) => r.reviewerThreadId),
    ["rev-codex-old"]
  );
});
