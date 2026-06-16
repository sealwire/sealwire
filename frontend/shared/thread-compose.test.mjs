import test from "node:test";
import assert from "node:assert/strict";

import { canComposeThread, composerButtonState } from "./thread-compose.js";

test("any client can compose on an idle thread", () => {
  assert.equal(
    canComposeThread({
      activeTurnId: null,
      hasActiveSession: true,
      hasControllerLease: false,
      reviewLocked: false,
    }),
    true
  );
});

test("only the controller can compose while a turn is running", () => {
  const input = {
    activeTurnId: "turn-1",
    hasActiveSession: true,
    reviewLocked: false,
  };

  assert.equal(canComposeThread({ ...input, hasControllerLease: false }), false);
  assert.equal(canComposeThread({ ...input, hasControllerLease: true }), true);
});

test("missing and review-locked threads cannot compose", () => {
  assert.equal(
    canComposeThread({
      activeTurnId: null,
      hasActiveSession: false,
      hasControllerLease: false,
      reviewLocked: false,
    }),
    false
  );
  assert.equal(
    canComposeThread({
      activeTurnId: null,
      hasActiveSession: true,
      hasControllerLease: true,
      reviewLocked: true,
    }),
    false
  );
});

// ---------------------------------------------------------------------------
// composerButtonState — Send and Stop must NEVER show at the same time.
// There is no pending-message queue: a running turn means Stop, not Send.
// ---------------------------------------------------------------------------

test("REGRESSION: view-only observer of a running background thread shows Stop and hides Send", () => {
  // Viewing a thread that is running on another device: no controller lease, so
  // the composer can't compose, but the turn IS running. Before the fix Send
  // stayed visible (greyed) alongside Stop — two buttons at once.
  const state = composerButtonState({
    composerReady: false, // no controller lease → cannot compose
    turnRunning: true,
    threadWorking: true,
    activeThreadFrozen: false,
    canWrite: false,
    viewOnly: true,
    submitInFlight: false,
  });
  assert.equal(state.stopHidden, false, "Stop must show while the background turn runs");
  assert.equal(state.sendHidden, true, "Send must hide whenever Stop shows");
  assert.equal(
    state.sendHidden,
    !state.stopHidden,
    "Send and Stop are mutually exclusive — exactly one is visible"
  );
});

test("controller running its own turn shows Stop and hides Send", () => {
  const state = composerButtonState({
    composerReady: true,
    turnRunning: true,
    threadWorking: true,
    activeThreadFrozen: false,
    canWrite: true,
    viewOnly: false,
    submitInFlight: false,
  });
  assert.equal(state.stopHidden, false);
  assert.equal(state.sendHidden, true);
});

test("a thread working without a turn id yet still shows Stop, not Send", () => {
  // sessionIsWorking can report true from a status update before active_turn_id
  // lands (turnRunning false). Stop must still take over from Send — the fix is
  // about whether the thread is working, not specifically about turnRunning.
  const state = composerButtonState({
    composerReady: true,
    turnRunning: false,
    threadWorking: true,
    activeThreadFrozen: false,
    canWrite: true,
    viewOnly: false,
    submitInFlight: false,
  });
  assert.equal(state.stopHidden, false);
  assert.equal(state.sendHidden, true);
});

test("idle composable thread shows Send and hides Stop", () => {
  const state = composerButtonState({
    composerReady: true,
    turnRunning: false,
    threadWorking: false,
    activeThreadFrozen: false,
    canWrite: true,
    viewOnly: false,
    submitInFlight: false,
  });
  assert.equal(state.sendHidden, false);
  assert.equal(state.sendDisabled, false);
  assert.equal(state.stopHidden, true);
  assert.equal(state.stopDisabled, true);
});

test("a thread frozen under review hides Stop and keeps Send visible-but-disabled", () => {
  const state = composerButtonState({
    composerReady: false, // review-locked → cannot compose
    turnRunning: true,
    threadWorking: true,
    activeThreadFrozen: true,
    canWrite: true,
    viewOnly: false,
    submitInFlight: false,
  });
  assert.equal(state.stopHidden, true, "never offer to stop the review's own turn");
  assert.equal(state.sendHidden, false, "Send stays visible (disabled) when Stop is hidden");
  assert.equal(state.sendDisabled, true);
});
