import test from "node:test";
import assert from "node:assert/strict";

import {
  clearRemoteSurfaceSessionState,
  resetRemoteSurfaceState,
  setRemoteThreads,
} from "../surface-state.js";

test("clearRemoteSurfaceSessionState clears session, threads, and current approval", () => {
  const runtimeState = {
    currentApprovalId: "approval-1",
    session: { active_thread_id: "thread-1" },
    threads: [{ thread_id: "thread-1" }],
  };

  clearRemoteSurfaceSessionState(runtimeState);

  assert.equal(runtimeState.session, null);
  assert.deepEqual(runtimeState.threads, []);
  assert.equal(runtimeState.currentApprovalId, null);
});

test("resetRemoteSurfaceState clears runtime state and external lifecycle hooks", () => {
  const calls = [];
  const runtimeState = {
    currentApprovalId: "approval-1",
    session: { active_thread_id: "thread-1" },
    threads: [{ thread_id: "thread-1" }],
  };

  resetRemoteSurfaceState(runtimeState, {
    clearClaimLifecycle() {
      calls.push("claim");
    },
    clearSessionRuntime() {
      calls.push("runtime");
    },
    rejectPendingActions(reason) {
      calls.push(`reject:${reason}`);
    },
    reason: "unit-test reset",
  });

  assert.deepEqual(calls, ["claim", "runtime", "reject:unit-test reset"]);
  assert.equal(runtimeState.session, null);
  assert.deepEqual(runtimeState.threads, []);
  assert.equal(runtimeState.currentApprovalId, null);
});

test("setRemoteThreads updates the canonical thread list", () => {
  const runtimeState = {
    threads: [],
  };
  const nextThreads = [{ thread_id: "thread-2" }];

  const result = setRemoteThreads(runtimeState, nextThreads);

  assert.equal(result, nextThreads);
  assert.equal(runtimeState.threads, nextThreads);
});
