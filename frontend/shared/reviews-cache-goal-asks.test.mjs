// The panel is per-thread, so both surfaces have to scope the goal and the asks the same
// way. They used to do it with two copies of the filter and only local had one at all.
import test from "node:test";
import assert from "node:assert/strict";
import { agentsPanelSlice, asksForThread, clearRememberedThreadIdentities, goalForThread } from "./reviews-cache.js";

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
  { id: "t1", name: "Mobile surface", provider: "claude_code" },
  { id: "t9", name: "codex", provider: "codex" },
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

// Inbound asks group by the asker session (peer_provider names US), so the logo has to
// come from the asker's own thread. Same stamp as the name: a plain field the store can
// JSON.stringify, not a resolver.
test("the asker is stamped with their provider so an inbound ask can show a real logo", () => {
  const [outbound, inbound] = asksForThread(REVIEWS, "t1", THREADS);
  assert.equal(outbound.id, "a1");
  assert.equal(outbound.asker_provider, "claude_code");
  assert.equal(inbound.id, "a2");
  assert.equal(inbound.asker_provider, "codex");
  const [orphan] = asksForThread(REVIEWS, "t8", THREADS);
  assert.equal(orphan.asker_provider, null);
  assert.equal(JSON.parse(JSON.stringify(inbound)).asker_provider, "codex");
});

test("a wire asker_provider wins over the local thread list", () => {
  // The relay may know a thread the sidebar has dropped; trust the stamp it sent.
  const reviews = {
    asks: [
      {
        id: "a-wire",
        asker_thread_id: "t1",
        peer_thread_id: "t9",
        asker_provider: "codex",
      },
    ],
  };
  const [ask] = asksForThread(reviews, "t1", THREADS);
  assert.equal(ask.asker_provider, "codex", "wire stamp beats THREADS' claude_code");
});

test("an empty peer_provider is filled from the peer's thread so outbound cards keep a logo", () => {
  // Real ask on this machine: peer_thread_id set, peer_provider "". Outbound grouping
  // keys on peer_provider, so the card became "another agent" with no mark.
  const reviews = {
    asks: [
      {
        id: "a-empty-peer",
        asker_thread_id: "t1",
        peer_thread_id: "t9",
        peer_provider: "",
      },
    ],
  };
  const [ask] = asksForThread(reviews, "t1", THREADS);
  assert.equal(ask.peer_provider, "codex");
});

test("a live thread row clears a remembered name rather than keeping the old title", () => {
  // Title reset: the relay sends name: null while the id is still on the page. Memory
  // must not win over an authoritative empty row.
  clearRememberedThreadIdentities();
  asksForThread(
    { asks: [{ id: "a1", asker_thread_id: "t-clear", peer_thread_id: "t9" }] },
    "t-clear",
    [{ id: "t-clear", name: "Old title", provider: "claude_code" }]
  );
  const [ask] = asksForThread(
    { asks: [{ id: "a1", asker_thread_id: "t-clear", peer_thread_id: "t9" }] },
    "t-clear",
    [{ id: "t-clear", name: null, provider: "claude_code" }]
  );
  assert.equal(ask.asker_name, null, "cleared title must not resurrect from memory");
});

test("an id absent from the page still uses memory for the logo", () => {
  clearRememberedThreadIdentities();
  asksForThread(
    { asks: [{ id: "a1", asker_thread_id: "t-gone", peer_thread_id: "t1" }] },
    "t1",
    [{ id: "t-gone", name: "Agent session", provider: "codex" }]
  );
  const asks = asksForThread(
    { asks: [{ id: "a1", asker_thread_id: "t-gone", peer_thread_id: "t1" }] },
    "t1",
    THREADS // t-gone not on this page
  );
  const inbound = asks.find((a) => a.asker_thread_id === "t-gone");
  assert.equal(inbound.asker_provider, "codex");
  assert.equal(inbound.asker_name, "Agent session");
});

test("ask-referenced identities survive past the memory bound", () => {
  // A 120-row page can cycle enough unique ids to hit the 256 cap; a legacy asker's
  // remembered identity must not be evicted while the ask is still retained.
  clearRememberedThreadIdentities();
  const askerId = "legacy-asker";
  const reviews = {
    asks: [{ id: "a1", asker_thread_id: askerId, peer_thread_id: "me" }],
  };
  asksForThread(reviews, "me", [
    { id: askerId, name: "Keep me", provider: "codex" },
    { id: "me", name: "Me", provider: "claude_code" },
  ]);
  for (let i = 0; i < 300; i++) {
    asksForThread(reviews, "me", [
      { id: "me", name: "Me", provider: "claude_code" },
      { id: `churn-${i}`, name: `N${i}`, provider: "codex" },
    ]);
  }
  const [ask] = asksForThread(reviews, "me", [
    { id: "me", name: "Me", provider: "claude_code" },
  ]);
  assert.equal(ask.asker_name, "Keep me");
  assert.equal(ask.asker_provider, "codex");
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
