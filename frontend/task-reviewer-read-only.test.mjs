import test from "node:test";
import assert from "node:assert/strict";

import { canComposeThread } from "./shared/thread-compose.js";
import { selectSessionRenderModel } from "./remote/view-model.js";
import { selectDisplayedSessionModel } from "./shared/session-view-model.js";

// A task reviewer's seat is readable forever and conversable never. The composer
// has to know that BEFORE the user types — the relay refuses the send either way,
// but discovering it by getting an error back is not the same product.

const liveSession = (patch = {}) => ({
  active_thread_id: "task-reviewer-1",
  active_turn_id: null,
  active_controller_device_id: null,
  current_status: "idle",
  pending_approvals: [],
  active_review_jobs: [],
  review_activity: [],
  active_workflow_runs: [],
  workflow_activity: [],
  transcript: [],
  ...patch,
});

test("a task reviewer cannot compose", () => {
  assert.equal(
    canComposeThread({
      hasActiveSession: true,
      reviewLocked: false,
      taskReviewer: true,
    }),
    false
  );
  assert.equal(
    canComposeThread({
      hasActiveSession: true,
      reviewLocked: false,
      taskReviewer: false,
    }),
    true
  );
});

test("the remote composer is disabled and says why for a task reviewer", () => {
  const model = selectSessionRenderModel({
    session: liveSession({ active_thread_task_reviewer: true }),
    previousSession: null,
  });
  assert.equal(model.composerDisabled, true);
  assert.match(model.messagePlaceholder, /review/i);
});

test("an ordinary session is unaffected", () => {
  const model = selectSessionRenderModel({
    session: liveSession(),
    previousSession: null,
  });
  assert.equal(model.composerDisabled, false);
});

// Viewing a thread without resuming it goes through a different projection, and
// that projection spreads the LIVE session first — so the viewed thread's own
// answer has to win in both directions.
test("the view-only projection reads the viewed thread's own reviewer flag", () => {
  const { displayedSession } = selectDisplayedSessionModel({
    liveSession: liveSession({ active_thread_id: "ordinary-1" }),
    viewedThreadId: "task-reviewer-1",
    viewedThread: { threadId: "task-reviewer-1", entries: [], taskReviewer: true },
  });
  assert.equal(displayedSession.active_thread_task_reviewer, true);
});

test("viewing an ordinary thread does not inherit the active reviewer's flag", () => {
  const { displayedSession } = selectDisplayedSessionModel({
    liveSession: liveSession({ active_thread_task_reviewer: true }),
    viewedThreadId: "ordinary-1",
    viewedThread: { threadId: "ordinary-1", entries: [] },
  });
  assert.equal(displayedSession.active_thread_task_reviewer, false);
});
