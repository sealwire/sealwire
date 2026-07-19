import test from "node:test";
import assert from "node:assert/strict";

import {
  ThreadAttentionTracker,
  computeThreadStates,
  sessionIsWorking,
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

test("statusIsWorking treats idle/viewing/empty/completed/unknown as not working", () => {
  assert.equal(statusIsWorking("active"), true);
  assert.equal(statusIsWorking("thinking"), true);
  assert.equal(statusIsWorking("idle"), false);
  assert.equal(statusIsWorking("viewing"), false);
  assert.equal(statusIsWorking(""), false);
  assert.equal(statusIsWorking(null), false);
  // Settled vocabulary must match the Rust `thread_status_is_working` set:
  // a saved Codex thread parses to `unknown`, Claude reports `completed`.
  // Treating either as working showed a Stop the backend rejects.
  assert.equal(statusIsWorking("completed"), false);
  assert.equal(statusIsWorking("unknown"), false);
});

test("sessionIsWorking mirrors Rust is_working: turn or working status, never phase alone", () => {
  assert.equal(sessionIsWorking({ active_turn_id: "t1", current_status: "idle" }), true);
  assert.equal(sessionIsWorking({ active_turn_id: null, current_status: "active" }), true);
  // A leftover phase with no turn and a settled status is NOT working — the
  // backend can't Stop it, so the UI must not offer to.
  assert.equal(
    sessionIsWorking({ active_turn_id: null, current_phase: "thinking", current_status: "idle" }),
    false,
  );
  assert.equal(sessionIsWorking({ active_turn_id: null, current_status: "unknown" }), false);
  assert.equal(sessionIsWorking(null), false);
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

test("computeThreadStates attributes approvals + ask-user by their own thread_id", () => {
  const states = computeThreadStates(
    snapshot({
      active_thread_id: "a",
      thread_activity: [{ thread_id: "b" }],
      pending_approvals: [{ request_id: "r1", thread_id: "b" }],
      pending_ask_user_questions: [{ request_id: "q1", thread_id: "c" }],
    })
  );
  // The approval belongs to background thread b, not the active thread a.
  assert.equal(states.get("a")?.needsInput ?? false, false);
  assert.equal(states.get("b").needsInput, true);
  assert.equal(states.get("c").needsInput, true);
});

test("computeThreadStates falls back to active thread when approval lacks thread_id", () => {
  const states = computeThreadStates(
    snapshot({ active_thread_id: "a", pending_approvals: [{ request_id: "r1" }] })
  );
  assert.equal(states.get("a").needsInput, true);
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
  tracker.ingest(
    snapshot({ active_thread_id: "a", thread_activity: [{ thread_id: "b" }] }),
    { viewedThreadId: "a", isForeground: true }
  );
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

test("background approval badges + notifies the originating thread, not the active one", () => {
  const tracker = new ThreadAttentionTracker();
  // Active thread b is being viewed; thread a runs in the background.
  tracker.ingest(snapshot({ active_thread_id: "b", thread_activity: [{ thread_id: "a" }] }), {
    viewedThreadId: "b",
    isForeground: true,
  });
  // a (background) requests an approval.
  const events = tracker.ingest(
    snapshot({
      active_thread_id: "b",
      thread_activity: [{ thread_id: "a" }],
      pending_approvals: [{ request_id: "r1", thread_id: "a" }],
    }),
    { viewedThreadId: "b", isForeground: true }
  );
  assert.deepEqual(events, [{ threadId: "a", kind: "needs_input", notify: true }]);
  assert.equal(tracker.kindFor("a"), "needs_input");
  assert.equal(tracker.kindFor("b"), null);
});

test("needs_input badge is live: present while waiting (even while working), cleared on resolve", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "a" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  // a is waiting on approval but its runtime status is still "active" (working).
  tracker.ingest(
    snapshot({
      active_thread_id: "v",
      thread_activity: [{ thread_id: "a" }],
      pending_approvals: [{ request_id: "r1", thread_id: "a" }],
    }),
    { viewedThreadId: "v", isForeground: true }
  );
  assert.equal(tracker.kindFor("a"), "needs_input");
  // Still waiting on the next snapshot → badge persists (live, no new event needed).
  const again = tracker.ingest(
    snapshot({
      active_thread_id: "v",
      thread_activity: [{ thread_id: "a" }],
      pending_approvals: [{ request_id: "r1", thread_id: "a" }],
    }),
    { viewedThreadId: "v", isForeground: true }
  );
  assert.deepEqual(again, []);
  assert.equal(tracker.kindFor("a"), "needs_input");
  // Approval answered, a keeps working → needs_input clears, no completed yet.
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "a" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  assert.equal(tracker.kindFor("a"), null);
});

test("needs_input is not double-reported as completed", () => {
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
      pending_approvals: [{ request_id: "r1", thread_id: "a" }],
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
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  assert.equal(tracker.kindFor("b"), null);
});

test("clear() removes a thread's flag and bumps the version", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  tracker.ingest(snapshot({ active_thread_id: "v" }), { viewedThreadId: "v", isForeground: true });
  const before = tracker.getVersion();
  tracker.clear("b");
  assert.equal(tracker.kindFor("b"), null);
  assert.ok(tracker.getVersion() > before);
});

test("refocusing a flagged thread in the foreground clears it on the next snapshot", () => {
  const tracker = new ThreadAttentionTracker();
  tracker.ingest(snapshot({ active_thread_id: "z", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "z",
    isForeground: true,
  });
  tracker.ingest(snapshot({ active_thread_id: "z" }), { viewedThreadId: "z", isForeground: true });
  assert.equal(tracker.kindFor("b"), "completed");
  tracker.ingest(snapshot({ active_thread_id: "b" }), { viewedThreadId: "b", isForeground: true });
  assert.equal(tracker.kindFor("b"), null);
});

test("clearViewedOnFocus clears the last-viewed thread without a snapshot", () => {
  const tracker = new ThreadAttentionTracker();
  // b completes while viewing b with the tab hidden → b stays flagged.
  tracker.ingest(snapshot({ active_thread_id: "b", active_turn_id: "t1", current_status: "active" }), {
    viewedThreadId: "b",
    isForeground: false,
  });
  tracker.ingest(snapshot({ active_thread_id: "b", current_status: "idle" }), {
    viewedThreadId: "b",
    isForeground: false,
  });
  assert.equal(tracker.kindFor("b"), "completed");
  // Tab regains focus: the viewed thread's dot clears with no new snapshot.
  tracker.clearViewedOnFocus(true);
  assert.equal(tracker.kindFor("b"), null);
});

test("subscribe is notified on attention changes", () => {
  const tracker = new ThreadAttentionTracker();
  let calls = 0;
  const unsubscribe = tracker.subscribe(() => {
    calls += 1;
  });
  tracker.ingest(snapshot({ active_thread_id: "v", thread_activity: [{ thread_id: "b" }] }), {
    viewedThreadId: "v",
    isForeground: true,
  });
  // b completes → attention changes → listener fires.
  tracker.ingest(snapshot({ active_thread_id: "v" }), { viewedThreadId: "v", isForeground: true });
  assert.ok(calls >= 1);
  unsubscribe();
  const after = calls;
  tracker.clear("b");
  assert.equal(calls, after, "no callbacks after unsubscribe");
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

// Codex sends camelCase `notLoaded` for a saved thread the app-server has not
// opened. This predicate compared the raw string against a lowercase set, so
// the real value never matched and every saved Codex thread read as working —
// surfacing a bogus "Background thread is running" banner plus Stop/Take-over
// controls the backend then rejects.
test("statusIsWorking normalizes provider casing (Codex notLoaded)", () => {
  assert.equal(statusIsWorking("notLoaded"), false, "the value Codex actually sends");
  assert.equal(statusIsWorking("notloaded"), false);
  assert.equal(statusIsWorking("  notLoaded  "), false, "and is whitespace tolerant");
  assert.equal(statusIsWorking("IDLE"), false, "casing is formatting, not semantics");
  // Genuinely working statuses must stay working.
  assert.equal(statusIsWorking("active"), true);
});

test("sessionIsWorking is false for a saved Codex thread with no turn", () => {
  assert.equal(
    sessionIsWorking(snapshot({ current_status: "notLoaded", active_turn_id: null })),
    false
  );
  // An in-flight turn still wins regardless of the status word.
  assert.equal(
    sessionIsWorking(snapshot({ current_status: "notLoaded", active_turn_id: "turn-1" })),
    true
  );
});
