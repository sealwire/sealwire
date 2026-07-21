import test from "node:test";
import assert from "node:assert/strict";

import { describeSessionStatus, describeStatusChips } from "./session-status.js";

test("no session → providers offline, no task", () => {
  const s = describeSessionStatus(null);
  assert.equal(s.providers.ready, false);
  assert.equal(s.task.state, "none");
  assert.equal(s.attention, null);
  assert.equal(s.primaryLabel, "Providers offline");
});

test("providers up, no active thread → ready + no task", () => {
  const s = describeSessionStatus({ provider_connected: true });
  assert.equal(s.providers.ready, true);
  assert.equal(s.providers.label, "Ready");
  assert.equal(s.task.state, "none");
  assert.equal(s.primaryLabel, "No active task");
});

test("open thread with a live turn → working", () => {
  const s = describeSessionStatus({
    provider_connected: true,
    active_thread_id: "t1",
    active_turn_id: "turn-9",
  });
  assert.equal(s.task.state, "working");
  assert.equal(s.primaryLabel, "Working");
});

test("open thread, idle status, no turn → idle (NOT the same as 'no task')", () => {
  const s = describeSessionStatus({
    provider_connected: true,
    active_thread_id: "t1",
    active_turn_id: null,
    current_status: "idle",
  });
  assert.equal(s.task.state, "idle");
  assert.equal(s.primaryLabel, "Idle");
});

test("a working status with no turn id still reads as working", () => {
  const s = describeSessionStatus({
    provider_connected: true,
    active_thread_id: "t1",
    current_status: "running",
  });
  assert.equal(s.task.state, "working");
});

test("a pending approval is a cross-cutting attention subject and wins the pill", () => {
  const s = describeSessionStatus(
    { provider_connected: true, active_thread_id: "t1" },
    { approval: { request_id: "a1" } }
  );
  assert.equal(s.attention.kind, "approval");
  assert.equal(s.primaryLabel, "Approval required");
});

test("provider outage outranks task state in the collapsed pill", () => {
  const s = describeSessionStatus({ provider_connected: false, active_thread_id: "t1" });
  assert.equal(s.providers.ready, false);
  assert.equal(s.task.state, "idle");
  assert.equal(s.primaryLabel, "Providers offline");
});

test("describeStatusChips renders the provider + task subjects as a status line", () => {
  assert.deepEqual(describeStatusChips({ provider_connected: true }), [
    { label: "Providers", value: "Ready" },
    { label: "Task", value: "No active task" },
  ]);
  assert.deepEqual(
    describeStatusChips({ provider_connected: true, active_thread_id: "t1", active_turn_id: "x" }),
    [
      { label: "Providers", value: "Ready" },
      { label: "Task", value: "Working" },
    ]
  );
  assert.deepEqual(describeStatusChips({ provider_connected: false }), [
    { label: "Providers", value: "Offline" },
    { label: "Task", value: "No active task" },
  ]);
});
