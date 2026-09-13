// The panel is per-thread, so both surfaces have to scope the goal and the asks the same
// way. They used to do it with two copies of the filter and only local had one at all.
import test from "node:test";
import assert from "node:assert/strict";
import { agentsPanelSlice, asksForThread, goalForThread } from "./reviews-cache.js";

const REVIEWS = {
  goals: [
    { thread_id: "t1", objective: "Ship it", status: "active" },
    { thread_id: "t2", objective: "Something else", status: "blocked" },
  ],
  asks: [
    { id: "a1", asker_thread_id: "t1", peer_thread_id: "t9" },
    { id: "a2", asker_thread_id: "t9", peer_thread_id: "t1" },
    { id: "a3", asker_thread_id: "t2", peer_thread_id: "t8" },
  ],
};

const THREADS = [
  { id: "t1", name: "Mobile surface" },
  { id: "t9", name: "codex" },
];

test("the goal shown is the viewed thread's, and nothing when no thread is in view", () => {
  assert.equal(goalForThread(REVIEWS, "t1").objective, "Ship it");
  assert.equal(goalForThread(REVIEWS, "t3"), null);
  assert.equal(goalForThread(REVIEWS, null), null);
  assert.equal(goalForThread(null, "t1"), null);
});

test("asks show on both ends of the conversation, never on a third thread's panel", () => {
  assert.deepEqual(
    asksForThread(REVIEWS, "t1", THREADS).map((ask) => ask.id),
    ["a1", "a2"]
  );
  assert.deepEqual(asksForThread(REVIEWS, "t8", THREADS).map((ask) => ask.id), ["a3"]);
  assert.deepEqual(asksForThread(REVIEWS, null, THREADS), []);
});

// Names, not a resolver: the panel's store diffs slices with JSON.stringify, which drops
// functions — a resolver would make every neighbouring change look unchanged.
test("both sides are stamped with plain names, null when the thread is unknown", () => {
  const [ask] = asksForThread(REVIEWS, "t1", THREADS);
  assert.equal(ask.asker_name, "Mobile surface");
  assert.equal(ask.peer_name, "codex");
  const [orphan] = asksForThread(REVIEWS, "t8", THREADS);
  assert.equal(orphan.asker_name, null);
  assert.equal(orphan.peer_name, null);
  assert.equal(JSON.parse(JSON.stringify(ask)).peer_name, "codex");
});

// One call rather than five keys assembled by hand on each surface: remote picked up the
// review cards and silently missed the goal and the asks for a release. The key set is
// pinned because the store MERGES patches — a key this stops returning is not blank, it is
// whichever thread you were looking at before.
test("the panel slice carries every thread-scoped thing the panel renders", () => {
  const slice = agentsPanelSlice(
    { ...REVIEWS, review_jobs: [{ id: "j1", parent_thread_id: "t1" }], reviewer_threads: [{ id: "rt1" }] },
    "t1",
    THREADS
  );
  assert.deepEqual(Object.keys(slice).sort(), [
    "asks",
    "goal",
    "parentThreadId",
    "reviewJobs",
    "reviewerThreads",
  ]);
  assert.deepEqual(slice.reviewJobs.map((job) => job.id), ["j1"]);
  assert.equal(slice.goal.objective, "Ship it");
  assert.deepEqual(slice.asks.map((ask) => ask.id), ["a1", "a2"]);
  assert.deepEqual(slice.reviewerThreads.map((thread) => thread.id), ["rt1"]);
  assert.equal(slice.parentThreadId, "t1");

  // A thread with nothing still overwrites all five, or the panel keeps the last one's.
  const empty = agentsPanelSlice({}, "t-empty", THREADS);
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(slice).sort());
  assert.deepEqual(empty.reviewJobs, []);
  assert.equal(empty.goal, null);
  assert.deepEqual(empty.asks, []);
});
