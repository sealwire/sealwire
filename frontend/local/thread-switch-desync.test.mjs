// Tests for the view-only navigation contract behind the "one running thread
// becomes un-enterable" bug: with two claude threads running and the user
// switching between them, one thread gets stuck on the "Loading thread"
// placeholder (the one with the "Back to console" button,
// render-session.js:1100-1120) in the CENTER.
//
// Root cause: the center's render is gated on the live, flipping `active_thread_id`
// (SessionSnapshot carries only the active thread's transcript), so a non-active
// viewed thread renders ONLY when a view-only PIN projects it. The self-heal that
// (re)loads that pin used a one-shot guard that never reset, so a single missed
// or failed load left the thread permanently un-enterable.
//
// - viewOnlySelfHealThreadId() is REAL code (view-only-thread.js) — this is the
//   red→green regression guard.
// - centerDecision() mirrors render-session.js's branch order (render-session.js
//   manipulates the DOM at module load and can't be imported under node --test)
//   to document WHY a missing pin surfaces as "Loading thread / Back to console".

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildViewOnlyPin,
  projectViewOnlySession,
  viewOnlySelfHealThreadId,
  VIEW_ONLY_LOAD_RETRY_BACKOFF_MS,
} from "./view-only-thread.js";
import { canComposeThread, composerButtonState } from "../shared/thread-compose.js";
import { isReviewInProgressForThread } from "../shared/review-state.js";
import { isWorkflowInProgressForThread } from "../shared/workflow-state.js";
import { sessionIsWorking } from "../shared/thread-attention.js";

function snap(activeThreadId, transcript = [], extra = {}) {
  return {
    active_thread_id: activeThreadId,
    active_turn_id: `turn-${activeThreadId}`,
    transcript,
    transcript_truncated: false,
    current_status: "active",
    active_review_jobs: [],
    thread_activity: [],
    pending_approvals: [],
    pending_ask_user_questions: [],
    ...extra,
  };
}

// isViewingConversation (app.js:2243-2245): the center's "show the conversation"
// decision keys entirely off active_thread_id.
function isViewingConversation(viewThreadId, session) {
  return Boolean(session?.active_thread_id && viewThreadId === session.active_thread_id);
}

// renderTranscript branch order (render-session.js:1021-1102) applied to the
// PROJECTED session (render-session.js:251 projects before rendering).
function centerDecision(viewThreadId, viewOnlyThread, realSession) {
  const session = projectViewOnlySession(realSession, { viewThreadId, viewOnlyThread });
  if (!session) return { kind: "no-session" };
  if (!isViewingConversation(viewThreadId, session)) {
    if (isReviewInProgressForThread(session, viewThreadId)) {
      return { kind: "review", threadId: viewThreadId };
    }
    if (viewThreadId && viewThreadId !== session.active_thread_id) {
      return { kind: "loading", threadId: viewThreadId }; // :1100 "Back to console"
    }
    return { kind: "console-home" }; // :1123 "Relay console home"
  }
  const entries = session.transcript || [];
  return { kind: "thread", threadId: session.active_thread_id, empty: entries.length === 0 };
}

// ===========================================================================

test("CHARACTERIZATION: a viewed thread renders only when it equals active_thread_id (or a pin projects it) — otherwise it is stuck on 'Loading thread'", () => {
  // viewThreadId === active_thread_id → live conversation.
  assert.equal(centerDecision("A", null, snap("A", [{ item_id: "a1" }])).kind, "thread");

  // SAME viewThreadId, but the relay flips active to the OTHER running thread and
  // there is no pin yet → the center stops trusting viewThreadId and shows the
  // "Loading thread / Back to console" placeholder. Hostage to active_thread_id.
  assert.deepEqual(centerDecision("A", null, snap("B", [{ item_id: "b1" }])), {
    kind: "loading",
    threadId: "A",
  });

  // A matching pin is the ONLY thing that lets a non-active viewed thread render.
  const pin = buildViewOnlyPin({
    threadId: "A",
    page: { thread_id: "A", entries: [{ item_id: "a1" }], prev_cursor: null },
  });
  assert.equal(centerDecision("A", pin, snap("B", [{ item_id: "b1" }])).threadId, "A");
});

test("REPRO: a missing pin for the viewed thread re-arms a load even after a prior attempt (no permanent one-shot block)", () => {
  // B holds control (active); A is the other running thread, currently viewed,
  // with NO pin. A prior self-heal attempt already happened for A.
  const armed = viewOnlySelfHealThreadId(snap("B", [{ item_id: "b1" }]), {
    viewThreadId: "A",
    viewOnlyThread: null,
    loadAttemptThreadId: "A", // an earlier attempt was spent
    now: 10_000,
  });
  assert.equal(
    armed,
    "A",
    "self-heal must re-arm the missing pin — the one-shot guard must not block recovery forever"
  );
});

test("REPRO: a failed view-only load becomes retryable once the backoff elapses (not left permanently un-enterable)", () => {
  const failed = buildViewOnlyPin({ threadId: "A", error: true, lastRefreshAt: 1_000 });
  const armed = viewOnlySelfHealThreadId(snap("B", [{ item_id: "b1" }]), {
    viewThreadId: "A",
    viewOnlyThread: failed,
    now: 1_000 + VIEW_ONLY_LOAD_RETRY_BACKOFF_MS + 1,
  });
  assert.equal(armed, "A", "a failed load must become retryable once the backoff elapses");
});

test("a freshly failed load is NOT retried within the backoff window (no tight failure loop)", () => {
  const failed = buildViewOnlyPin({ threadId: "A", error: true, lastRefreshAt: 1_000 });
  const armed = viewOnlySelfHealThreadId(snap("B", [{ item_id: "b1" }]), {
    viewThreadId: "A",
    viewOnlyThread: failed,
    now: 1_000 + 50,
  });
  assert.equal(armed, null, "a just-failed load must back off so a failing fetch can't loop");
});

test("a load already in flight (loading pin) is not re-armed", () => {
  const loading = buildViewOnlyPin({ threadId: "A", loading: true });
  assert.equal(
    viewOnlySelfHealThreadId(snap("B"), { viewThreadId: "A", viewOnlyThread: loading, now: 9e12 }),
    null
  );
});

test("a good (loaded) pin is not re-armed", () => {
  const good = buildViewOnlyPin({
    threadId: "A",
    page: { thread_id: "A", entries: [{ item_id: "a1" }], prev_cursor: null },
  });
  assert.equal(
    viewOnlySelfHealThreadId(snap("B"), { viewThreadId: "A", viewOnlyThread: good, now: 9e12 }),
    null
  );
});

test("the active thread is never view-only loaded, and absent inputs load nothing", () => {
  assert.equal(
    viewOnlySelfHealThreadId(snap("A"), { viewThreadId: "A", viewOnlyThread: null, now: 9e12 }),
    null,
    "the active thread is live, not view-only"
  );
  assert.equal(viewOnlySelfHealThreadId(snap("B"), { viewThreadId: null, now: 0 }), null);
  assert.equal(viewOnlySelfHealThreadId(null, { viewThreadId: "A", now: 0 }), null);
});

test("view-only idle saved Codex session remains composable", () => {
  const viewThreadId = "saved-codex";
  const staleSnapshotServerTime = 1_784_662_800;
  const projected = projectViewOnlySession(snap("live-thread", [], {
    // This is the bad transient: an older compact snapshot still claims the
    // viewed thread is active, but the freshly loaded thread_state says it is
    // a saved idle Codex thread (`notLoaded`).
    server_time: staleSnapshotServerTime,
    thread_activity: [{ thread_id: viewThreadId, phase: "thinking", tool: null }],
  }), {
    viewThreadId,
    viewOnlyThread: buildViewOnlyPin({
      threadId: viewThreadId,
      page: { thread_id: viewThreadId, entries: [{ item_id: "tail" }], prev_cursor: null },
      activeTurnId: null,
      currentStatus: "notLoaded",
      lastRefreshAt: staleSnapshotServerTime * 1000 + 500,
      lastRefreshServerTime: staleSnapshotServerTime + 1,
      settingsWritable: true,
    }),
  });
  const canWrite = projected.active_controller_device_id !== "__view_only__";
  const canCompose = canComposeThread({
    activeTurnId: projected.active_turn_id,
    hasActiveSession: Boolean(projected.active_thread_id),
    hasControllerLease: canWrite,
    reviewLocked: false,
  });
  const buttons = composerButtonState({
    composerReady:
      Boolean(projected.active_thread_id) &&
      canCompose &&
      isViewingConversation(viewThreadId, projected),
    turnRunning: Boolean(projected.active_turn_id),
    threadWorking: sessionIsWorking(projected),
    activeThreadFrozen: false,
    canWrite,
    viewOnly: projected.view_only,
    submitInFlight: false,
  });

  assert.equal(projected.current_status, "notLoaded");
  assert.equal(projected.current_phase, null);
  assert.equal(projected.current_tool, null);
  assert.equal(sessionIsWorking(projected), false);
  assert.equal(canCompose, true);
  assert.equal(buttons.sendDisabled, false);
  assert.equal(
    !projected.active_thread_id ||
      !canCompose ||
      !isViewingConversation(viewThreadId, projected),
    false,
    "textarea should stay enabled for an idle targeted-send view"
  );
});

test("view-only workflow-locked same-cwd session is not composable", () => {
  const viewThreadId = "same-cwd-sibling";
  const projected = projectViewOnlySession(snap("live-thread", [], {
    active_workflow_runs: [
      {
        id: "wf1",
        status: "running",
        parent_thread_id: "parent-thread",
        locked_thread_ids: ["parent-thread", viewThreadId],
      },
    ],
  }), {
    viewThreadId,
    viewOnlyThread: buildViewOnlyPin({
      threadId: viewThreadId,
      page: { thread_id: viewThreadId, entries: [{ item_id: "tail" }], prev_cursor: null },
      currentStatus: "notLoaded",
      workflowLocked: true,
    }),
  });
  const activeThreadFrozen = isWorkflowInProgressForThread(projected, projected.active_thread_id);
  const canCompose = canComposeThread({
    activeTurnId: projected.active_turn_id,
    hasActiveSession: Boolean(projected.active_thread_id),
    hasControllerLease: projected.active_controller_device_id !== "__view_only__",
    reviewLocked: activeThreadFrozen,
  });

  assert.equal(projected.workflow_locked, true);
  assert.equal(activeThreadFrozen, true);
  assert.equal(canCompose, false);
});

test("view-only different-cwd session stays composable during unrelated workflow", () => {
  const viewThreadId = "different-cwd";
  const projected = projectViewOnlySession(snap("live-thread", [], {
    active_workflow_runs: [
      {
        id: "wf1",
        status: "running",
        parent_thread_id: "parent-thread",
        locked_thread_ids: ["parent-thread", "same-cwd-sibling"],
      },
    ],
  }), {
    viewThreadId,
    viewOnlyThread: buildViewOnlyPin({
      threadId: viewThreadId,
      page: { thread_id: viewThreadId, entries: [{ item_id: "tail" }], prev_cursor: null },
      currentStatus: "notLoaded",
      workflowLocked: false,
    }),
  });
  const activeThreadFrozen = isWorkflowInProgressForThread(projected, projected.active_thread_id);
  const canCompose = canComposeThread({
    activeTurnId: projected.active_turn_id,
    hasActiveSession: Boolean(projected.active_thread_id),
    hasControllerLease: projected.active_controller_device_id !== "__view_only__",
    reviewLocked: activeThreadFrozen,
  });

  assert.equal(projected.workflow_locked, false);
  assert.equal(activeThreadFrozen, false);
  assert.equal(canCompose, true);
});

test("a newer snapshot activity row keeps a viewed thread working", () => {
  const viewThreadId = "saved-codex";
  const projected = projectViewOnlySession(snap("live-thread", [], {
    server_time: 20,
    thread_activity: [{ thread_id: viewThreadId, phase: "tool", tool: "bash" }],
  }), {
    viewThreadId,
    viewOnlyThread: buildViewOnlyPin({
      threadId: viewThreadId,
      page: { thread_id: viewThreadId, entries: [{ item_id: "tail" }], prev_cursor: null },
      currentStatus: "notLoaded",
      lastRefreshAt: 99_999,
      lastRefreshServerTime: 19,
    }),
  });
  const buttons = composerButtonState({
    composerReady: false,
    turnRunning: Boolean(projected.active_turn_id),
    threadWorking: sessionIsWorking(projected),
    activeThreadFrozen: false,
    canWrite: false,
    viewOnly: projected.view_only,
    submitInFlight: false,
  });

  assert.equal(projected.active_turn_id, `view:${viewThreadId}`);
  assert.equal(projected.current_phase, "tool");
  assert.equal(projected.current_tool, "bash");
  assert.equal(sessionIsWorking(projected), true);
  assert.equal(buttons.stopHidden, false);
  assert.equal(buttons.sendHidden, true);
});

test("without server_time, view-only projection keeps activity authoritative", () => {
  const viewThreadId = "saved-codex";
  const projected = projectViewOnlySession(snap("live-thread", [], {
    thread_activity: [{ thread_id: viewThreadId, phase: "thinking", tool: null }],
  }), {
    viewThreadId,
    viewOnlyThread: buildViewOnlyPin({
      threadId: viewThreadId,
      page: { thread_id: viewThreadId, entries: [{ item_id: "tail" }], prev_cursor: null },
      currentStatus: "notLoaded",
      lastRefreshServerTime: 20,
    }),
  });

  assert.equal(projected.active_turn_id, `view:${viewThreadId}`);
  assert.equal(sessionIsWorking(projected), true);
});
