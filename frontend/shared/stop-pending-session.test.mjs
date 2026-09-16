import test from "node:test";
import assert from "node:assert/strict";

import {
  stopPendingResolveFromSession,
  stopPendingTurnMarker,
  threadIsWorkingForStop,
} from "./stop-pending-session.js";
import {
  isStopPending,
  reconcileAllStopPending,
  withStopPending,
} from "./stop-pending.js";

test("threadIsWorkingForStop uses active_turn_id for the active thread", () => {
  assert.equal(
    threadIsWorkingForStop(
      { active_thread_id: "a", active_turn_id: "t1" },
      "a"
    ),
    true
  );
  assert.equal(
    threadIsWorkingForStop(
      { active_thread_id: "a", active_turn_id: null },
      "a"
    ),
    false
  );
});

test("threadIsWorkingForStop treats thread_activity presence as working", () => {
  // Phase may be null on a live entry — presence is the signal.
  assert.equal(
    threadIsWorkingForStop(
      {
        active_thread_id: "conv",
        active_turn_id: "t-conv",
        thread_activity: [{ thread_id: "orch", phase: null }],
      },
      "orch"
    ),
    true
  );
  assert.equal(
    threadIsWorkingForStop(
      {
        active_thread_id: "conv",
        active_turn_id: "t-conv",
        thread_activity: [],
      },
      "orch"
    ),
    false
  );
});

// P1: Orchestrator Stop inserts orchId into the shared map; when it idles off
// the conversation view, reconcileAll must clear it or the next Stop hits the
// duplicate guard and reports "Stop failed".
test("reconcileAll drops an idle Orchestrator pending while viewing the conversation", () => {
  const session = {
    active_thread_id: "conv",
    active_turn_id: "t-conv",
    thread_activity: [],
  };
  const pending = withStopPending(
    withStopPending({}, "conv", "t-conv"),
    "orch",
    true
  );
  const next = reconcileAllStopPending(pending, (id) =>
    stopPendingResolveFromSession(session, id)
  );
  assert.equal(isStopPending(next, "orch"), false);
  assert.equal(isStopPending(next, "conv"), true);
});

// P2: the view-only projection rewrites active_thread_id to the viewed thread
// and drops the real live thread from thread_activity. Resolving against that
// projection falsely idles the stopped live thread and re-arms Stop mid-cancel.
test("stopPendingResolveFromSession must use the real session, not a view-only projection", async () => {
  const { projectViewOnlySession } = await import("../local/view-only-thread.js");
  const real = {
    active_thread_id: "LIVE",
    active_turn_id: "turn-live",
    thread_activity: [],
  };
  const projected = projectViewOnlySession(real, {
    viewThreadId: "B",
    viewOnlyThread: {
      threadId: "B",
      entries: [],
      olderCursor: null,
      generation: 1,
      review: false,
      cwd: "/b",
      provider: "codex",
      loading: false,
    },
  });
  assert.equal(projected.active_thread_id, "B");
  assert.equal(
    threadIsWorkingForStop(projected, "LIVE"),
    false,
    "precondition: the projection lies about LIVE"
  );
  assert.equal(
    threadIsWorkingForStop(real, "LIVE"),
    true,
    "the real snapshot still knows LIVE is working"
  );

  const pending = withStopPending({}, "LIVE", "turn-live");
  const wrong = reconcileAllStopPending(pending, (id) =>
    stopPendingResolveFromSession(projected, id)
  );
  assert.equal(
    isStopPending(wrong, "LIVE"),
    false,
    "precondition: projecting would drop LIVE's Stopping…"
  );
  const right = reconcileAllStopPending(pending, (id) =>
    stopPendingResolveFromSession(real, id)
  );
  assert.equal(isStopPending(right, "LIVE"), true);
});

test("stopPendingTurnMarker records the active turn when known", () => {
  assert.equal(
    stopPendingTurnMarker(
      { active_thread_id: "a", active_turn_id: "turn-9" },
      "a"
    ),
    "turn-9"
  );
  assert.equal(
    stopPendingTurnMarker(
      { active_thread_id: "a", active_turn_id: "turn-9" },
      "orch"
    ),
    true
  );
});

test("stopPendingTurnMarker keeps a view-only pin's turn for a background Stop", () => {
  assert.equal(
    stopPendingTurnMarker(
      { active_thread_id: "A", active_turn_id: "turn-a" },
      "B",
      { overlayTurnId: "turn-b" }
    ),
    "turn-b"
  );
});

// P2: thread_activity can temporarily omit a still-streaming background thread
// (Cursor). The view-only pin still holds that turn's id and legitimately shows
// Stop. Reconciling only the real snapshot would drop Stopping… on the same
// paint that recorded the pending flag — before the ask even returns.
test("reconcile keeps pending when the real snapshot omits a pin-known working turn", () => {
  const real = {
    active_thread_id: "A",
    active_turn_id: "turn-a",
    thread_activity: [],
  };
  assert.equal(
    threadIsWorkingForStop(real, "B"),
    false,
    "precondition: real snapshot alone looks idle for B"
  );

  const pending = withStopPending({}, "B", "turn-b");
  const wrong = reconcileAllStopPending(pending, (id) =>
    stopPendingResolveFromSession(real, id)
  );
  assert.equal(
    isStopPending(wrong, "B"),
    false,
    "precondition: without the pin overlay, reconcile drops B"
  );

  const right = reconcileAllStopPending(pending, (id) =>
    stopPendingResolveFromSession(real, id, {
      overlayWorking: true,
      overlayTurnId: "turn-b",
    })
  );
  assert.equal(isStopPending(right, "B"), true);

  // Once the pin settles (no overlay turn), idle clears as before.
  const settled = reconcileAllStopPending(right, (id) =>
    stopPendingResolveFromSession(real, id, {
      overlayWorking: false,
      overlayTurnId: null,
    })
  );
  assert.equal(isStopPending(settled, "B"), false);
});
