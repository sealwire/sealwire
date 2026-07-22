import test from "node:test";
import assert from "node:assert/strict";

import { selectStatusBadge } from "./status-badge.js";
import { REVIEW_BLOCKED_BADGE, REVIEW_IN_PROGRESS_BADGE } from "../shared/review-state.js";

// The regression the reviewer caught: the actual consumer path must render the
// seam's "Providers offline" label for a provider outage, not a hardcoded
// "Offline" that bypasses describeSessionStatus.
test("provider disconnected → 'Providers offline' from the seam (not a hardcoded 'Offline')", () => {
  const badge = selectStatusBadge({ session: { provider_connected: false } });
  assert.equal(badge.text, "Providers offline");
  assert.equal(badge.tone, "offline");
});

test("an approval wins over a provider outage", () => {
  const badge = selectStatusBadge({
    session: { provider_connected: false },
    approval: { request_id: "a1" },
  });
  assert.equal(badge.text, "Approval required");
  assert.equal(badge.tone, "alert");
});

test("pending pairings badge outranks a provider outage and pluralizes", () => {
  assert.deepEqual(
    selectStatusBadge({ session: { provider_connected: false }, pendingPairingCount: 1 }),
    { text: "Pairing request", tone: "alert" }
  );
  assert.deepEqual(
    selectStatusBadge({ session: { provider_connected: false }, pendingPairingCount: 3 }),
    { text: "3 pairing requests", tone: "alert" }
  );
});

test("providers up, no active thread → 'No active task'", () => {
  const badge = selectStatusBadge({ session: { provider_connected: true } });
  assert.equal(badge.text, "No active task");
  assert.equal(badge.tone, "ready");
});

test("providers up, live turn → 'Working'", () => {
  const badge = selectStatusBadge({
    session: { provider_connected: true, active_thread_id: "t1", active_turn_id: "turn-1" },
  });
  assert.equal(badge.text, "Working");
  assert.equal(badge.tone, "ready");
});

test("a blocked review outranks the task subject", () => {
  const badge = selectStatusBadge({
    session: { provider_connected: true, active_thread_id: "t1" },
    reviewBlocked: true,
  });
  assert.equal(badge.text, REVIEW_BLOCKED_BADGE.label);
  assert.equal(badge.tone, REVIEW_BLOCKED_BADGE.tone);
});

test("a blocked workflow gets a Code Flow badge", () => {
  const badge = selectStatusBadge({
    session: { provider_connected: true, active_thread_id: "t1" },
    workflowBlocked: true,
  });
  assert.equal(badge.text, "Code Flow blocked — action needed");
  assert.equal(badge.tone, "alert");
});

test("a stalled turn outranks the task subject", () => {
  const badge = selectStatusBadge({
    session: { provider_connected: true, active_thread_id: "t1" },
    stalled: true,
  });
  assert.equal(badge.text, "Stalled?");
  assert.equal(badge.tone, "alert");
});

test("a frozen (under-review) active thread shows the in-progress badge", () => {
  const badge = selectStatusBadge({
    session: { provider_connected: true, active_thread_id: "t1" },
    activeThreadFrozen: true,
  });
  assert.equal(badge.text, REVIEW_IN_PROGRESS_BADGE.label);
  assert.equal(badge.tone, REVIEW_IN_PROGRESS_BADGE.tone);
});

test("a workflow-frozen active thread gets a Code Flow in-progress badge", () => {
  const badge = selectStatusBadge({
    session: { provider_connected: true, active_thread_id: "t1" },
    activeThreadFrozen: true,
    activeThreadWorkflowFrozen: true,
  });
  assert.equal(badge.text, "Code Flow in progress");
  assert.equal(badge.tone, "alert");
});
