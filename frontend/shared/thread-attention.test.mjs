import test from "node:test";
import assert from "node:assert/strict";

import {
  ThreadAttentionTracker,
  computeThreadStates,
  statusIsWorking,
} from "./thread-attention.js";

function snapshot(overrides = {}) {
  return {
    active_thread_id: null,
    active_turn_id: null,
    current_status: "idle",
    current_phase: null,
    active_flags: [],
    thread_activity: [],
    pending_approvals: [],
    pending_ask_user_questions: [],
    ...overrides,
  };
}

test("statusIsWorking treats idle/viewing/empty as not working", () => {
  assert.equal(statusIsWorking("active"), true);
  assert.equal(statusIsWorking("thinking"), true);
  assert.equal(statusIsWorking("idle"), false);
  assert.equal(statusIsWorking("viewing"), false);
  assert.equal(statusIsWorking(""), false);
  assert.equal(statusIsWorking(null), false);
});

test("computeThreadStates derives working from active turn and thread_activity", () => {
  const states = computeThreadStates(
    snapshot({
      active_thread_id: "a",
      active_turn_id: "turn-1",
      current_status: "active",
      thread_activity: [{ thread_id: "b", phase: "thinking", tool: null }],
    })
  );
  assert.equal(states.get("a").working, true);
  assert.equal(states.get("b").working, true);
});

test("computeThreadStates attributes ask-user to its thread and approvals to active", () => {
  const states = computeThreadStates(
    snapshot({
      active_thread_id: "a",
      pending_approvals: [{ request_id: "r1" }],
      pending_ask_user_questions: [{ request_id: "q1", thread_id: "b" }],
    })
  );
  assert.equal(states.get("a").needsInput, true);
  assert.equal(states.get("b").needsInput, true);
});

test("computeThreadStates honors waiting flags without populated arrays", () => {
  const states = computeThreadStates(
    snapshot({ active_thread_id: "a", active_flags: ["waitingOnApproval"] })
  );
  assert.equal(states.get("a").needsInput, true);
});

test("first snapshot establishes baseline without events", () => {
  const tracker = new ThreadAttentionTracker();
  const events = tracker.ingest(
    snapshot({ active_thread_id: "a", active_turn_id: "t1", current_status: "active" })
  );
  assert.deepEqual(events, []);
  assert.equal(tracker.kindFor("a"), null);
});

test("completion of a background thread flags attention + notify", () => {
  const tracker = new ThreadAttentionTracker();
  // a is being viewed in foreground; b works in the background.
  tracker.ingest(
    snapshot({
      active_thread_id: "a",
      thread_activity: [{ thread_id: "b" }],
    }),
    { viewedThreadId: "a", isForeground: true }
  );
  // b finishes (drops out of thread_activity).
  const events = tracker.ingest(snapshot({ active_thread_id: "a" }), {
    viewedThreadId: "a",
    isForeground: true,
  });
  assert.deepEqual(events, [{ threadId: "b", kind: "completed", notify: true }]);
  assert.equal(tracker.kindFor("b"), "completed");
  assert.equal(tracker.kindFor("a"), null);
});

test("viewed foreground thread completion is suppressed (no dot, no notify)", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(
    snapshot({ active_thread_id: "a", active_turn_id: "t1", current_status: "active" }),
    { viewedThreadId: "a", isForeground: true }
  );
  const events = tracker.ingest(snapshot({ active_thread_id: "a", current_status: "idle" }), {
    viewedThreadId: "a",
    isForeground: true,
  });
  assert.deepEqual(events, [{ threadId: "a", kind: "completed", notify: false }]);
  assert.equal(tracker.kindFor("a"), null);
});

test("viewed thread completion while tab is hidden still flags + notifies", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(
    snapshot({ active_thread_id: "a", active_turn_id: "t1", current_status: "active" }),
    { viewedThreadId: "a", isForeground: false }
  );
  const events = tracker.ingest(snapshot({ active_thread_id: "a", current_status: "idle" }), {
    viewedThreadId: "a",
    isForeground: false,
  });
  assert.deepEqual(events, [{ threadId: "a", kind: "completed", notify: true }]);
  assert.equal(tracker.kindFor("a"), "completed");
});

test("needs_input transition flags attention", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(
    snapshot({ active_thread_id: "a", active_turn_id: "t1", current_status: "active" }),
    { viewedThreadId: "z", isForeground: true }
  );
  const events = tracker.ingest(
    snapshot({
      active_thread_id: "a",
      current_status: "active",
      active_flags: ["waitingOnApproval"],
      pending_approvals: [{ request_id: "r1" }],
    }),
    { viewedThreadId: "z", isForeground: true }
  );
  assert.deepEqual(events, [{ threadId: "a", kind: "needs_input", notify: true }]);
  assert.equal(tracker.kindFor("a"), "needs_input");
});

test("a thread that needs input is not double-reported as completed", () => {
  const tracker = new ThreadAttentionTracker();
  // Working, not waiting.
  tracker.ingest(
    snapshot({ active_thread_id: "a", active_turn_id: "t1", current_status: "active" }),
    { viewedThreadId: "z", isForeground: true }
  );
  // Turn pauses on an approval: status still active, now waiting. Only needs_input.
  const events = tracker.ingest(
    snapshot({
      active_thread_id: "a",
      current_status: "active",
      active_flags: ["waitingOnApproval"],
      pending_approvals: [{ request_id: "r1" }],
    }),
    { viewedThreadId: "z", isForeground: true }
  );
  assert.deepEqual(events, [{ threadId: "a", kind: "needs_input", notify: true }]);
});

test("resuming work clears a stale completed flag", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  tracker.ingest(snapshot({ active_thread_id: "v" }), { viewedThreadId: "v", isForeground: true });
  assert.equal(tracker.kindFor("b"), "completed");
  // b starts working again.
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  assert.equal(tracker.kindFor("b"), null);
});

test("clear() removes a thread's flag", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  tracker.ingest(snapshot({ active_thread_id: "v" }), { viewedThreadId: "v", isForeground: true });
  assert.equal(tracker.kindFor("b"), "completed");
  tracker.clear("b");
  assert.equal(tracker.kindFor("b"), null);
});

test("refocusing a flagged thread in the foreground clears it", () => {
  const tracker = new ThreadAttentionTracker();
  // b completes while user is looking elsewhere (z) — flagged.
  tracker.ingest(snapshot({ active_thread_id: "z", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "z",
    isForeground: true,
  });
  tracker.ingest(snapshot({ active_thread_id: "z" }), { viewedThreadId: "z", isForeground: true });
  assert.equal(tracker.kindFor("b"), "completed");
  // Now the user opens b (it becomes the viewed thread, foreground).
  tracker.ingest(snapshot({ active_thread_id: "b" }), { viewedThreadId: "b", isForeground: true });
  assert.equal(tracker.kindFor("b"), null);
});

test("snapshotMap returns an independent copy", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  tracker.ingest(snapshot({ active_thread_id: "v" }), { viewedThreadId: "v", isForeground: true });
  const map = tracker.snapshotMap();
  assert.equal(map.get("b"), "completed");
  map.delete("b");
  assert.equal(tracker.kindFor("b"), "completed");
});
