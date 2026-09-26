import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { projectViewOnlySession } from "./local/view-only-thread.js";
import * as sessionViewModel from "./shared/session-view-model.js";
import { selectSessionRenderModel, visiblePendingAskUserQuestions } from "./remote/view-model.js";
import { selectSessionChromeRenderModel } from "./remote/chrome-view-model.js";
import { canRequestReview } from "./shared/review-state.js";
import { canStartWorkflow } from "./shared/workflow-state.js";

const { selectDisplayedSession } = sessionViewModel;

// The snapshot carries every session's approvals. Viewing session A while a
// background session B waits used to put B's card in A's conversation, and
// A's Approve button then approved B's command.

const APPROVAL_A = { request_id: "req-a", thread_id: "thread-a", kind: "command_execution", summary: "Bash", command: "ls" };
const APPROVAL_B = { request_id: "req-b", thread_id: "thread-b", kind: "command_execution", summary: "Bash", command: "rm -rf build" };

function liveSession(pending_approvals) {
  return {
    active_thread_id: "thread-a",
    current_cwd: "/tmp/a",
    provider_connected: true,
    pending_approvals,
    transcript: [],
  };
}

function displayed(pending) {
  return selectDisplayedSession({ liveSession: liveSession(pending), viewedThreadId: "thread-a" });
}

test("viewing the active session hides another session's approval", () => {
  assert.deepEqual(displayed([APPROVAL_B]).pending_approvals, []);
  const local = projectViewOnlySession(liveSession([APPROVAL_B]), { viewThreadId: "thread-a" });
  assert.deepEqual(local.pending_approvals, []);
});

test("the active session keeps its own approval even when another session's is listed first", () => {
  assert.deepEqual(displayed([APPROVAL_B, APPROVAL_A]).pending_approvals, [APPROVAL_A]);
});

// The relay declines an approval it cannot attribute; the client never guesses.
test("an approval without a thread id belongs to no session", () => {
  const unattributed = { request_id: "req-x", kind: "plan", summary: "Plan" };
  assert.deepEqual(displayed([unattributed]).pending_approvals, []);
  assert.equal(sessionViewModel.pendingApprovalForThread(liveSession([unattributed]), "thread-a"), null);
});

test("nothing to hide keeps the same session object, so memoized renders stay put", () => {
  const live = liveSession([APPROVAL_A]);
  assert.equal(selectDisplayedSession({ liveSession: live, viewedThreadId: "thread-a" }), live);
});

test("pendingApprovalForThread only answers for that thread", () => {
  const { pendingApprovalForThread } = sessionViewModel;
  assert.equal(typeof pendingApprovalForThread, "function");
  const session = liveSession([APPROVAL_B, APPROVAL_A]);
  assert.equal(pendingApprovalForThread(session, "thread-a"), APPROVAL_A);
  assert.equal(pendingApprovalForThread(liveSession([APPROVAL_B]), "thread-a"), null);
  assert.equal(pendingApprovalForThread(null, "thread-a"), null);
});

test("remote: Approve in session A has nothing to submit while only B waits", () => {
  const model = selectSessionRenderModel({
    session: displayed([APPROVAL_B]),
    previousSession: null,
    hasControllerLease: true,
  });
  assert.equal(model.approval, null);
  assert.equal(model.currentApprovalId, null);
});

test("remote: A's header does not claim an approval that belongs to B", () => {
  const state = { remoteAuth: { relayId: "r", deviceId: "d", payloadSecret: "s" }, serverConnectionState: "connected", socketConnected: true };
  const model = selectSessionChromeRenderModel(state, displayed([APPROVAL_B]));
  assert.notEqual(model.statusBadge.label, "Approval required");
});

// react-app.js is the remote boot module and not evaluable in a test, so this is
// the structural half; the behaviour is in remote/session-ops.test.mjs. The
// stored session must stay whole (approval events merge into it), so the scoping
// happens where the app reads it for display.
test("remote: the app renders a session scoped to its own approvals", () => {
  const source = readFileSync(new URL("./remote/react-app.js", import.meta.url), "utf8");
  assert.match(
    source,
    /const session = useMemo\(\s*\(\) => scopeApprovalsToActiveThread\(currentState\.session\)/,
    "every display model below reads `session`; it must not carry other sessions' approvals"
  );
});

test("review and Code Flow are blocked only by the session's own approval", () => {
  const session = {
    active_thread_id: "thread-a",
    active_turn_id: null,
    current_status: "idle",
    pending_approvals: [APPROVAL_A],
  };
  assert.equal(canRequestReview(session, "device-1"), false);
  assert.equal(canStartWorkflow(session), false);
  const other = { ...session, pending_approvals: [APPROVAL_B] };
  assert.equal(canRequestReview(other, "device-1"), true, "B's approval does not block A");
  assert.equal(canStartWorkflow(other), true);
});

test("remote: a question shows only in the session it names", () => {
  const own = { request_id: "q-a", thread_id: "thread-a" };
  const other = { request_id: "q-b", thread_id: "thread-b" };
  const unattributed = { request_id: "q-x" };
  assert.deepEqual(
    visiblePendingAskUserQuestions(null, [own, other, unattributed], "thread-a"),
    [own]
  );
  assert.deepEqual(
    visiblePendingAskUserQuestions(null, [own, unattributed], null),
    [],
    "with no session on screen there is no conversation to ask in"
  );
});

// render-session.js cannot be evaluated in a test, so this is the structural half.
// renderTaskTeam can be handed the conversation's projection, which (viewing a
// non-active thread) keeps only that thread's requests; the Orchestrator's own
// question would then render as "Answered" with no way to reply.
test("local: the Tasks pane reads the Orchestrator's requests from the full snapshot", () => {
  const source = readFileSync(new URL("./local/render-session.js", import.meta.url), "utf8");
  assert.match(source, /pendingApprovalForThread\(state\.session \|\| session, orchId\)/);
  assert.match(source, /pendingAskUserQuestionsForThread\(state\.session \|\| session, orchId\)/);
  assert.doesNotMatch(source, /pendingAskUserQuestionsForThread\(session, orchId\)/);
});
