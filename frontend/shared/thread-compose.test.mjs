import test from "node:test";
import assert from "node:assert/strict";

import { canComposeThread, composerButtonState } from "./thread-compose.js";

test("any client can compose on an idle thread", () => {
  assert.equal(
    canComposeThread({
      hasActiveSession: true,
      reviewLocked: false,
    }),
    true
  );
});

test("any device can type while a turn runs, whichever device started it", () => {
  // Typing ahead cannot interleave turns: the relay refuses a second send into a
  // thread that is still running, and the composer keeps the draft.
  assert.equal(
    canComposeThread({
      hasActiveSession: true,
      reviewLocked: false,
    }),
    true
  );
});

test("missing and review-locked threads cannot compose", () => {
  assert.equal(
    canComposeThread({
      hasActiveSession: false,
      reviewLocked: false,
    }),
    false
  );
  assert.equal(
    canComposeThread({
      hasActiveSession: true,
      reviewLocked: true,
    }),
    false
  );
});

// ---------------------------------------------------------------------------
// composerButtonState — Send and Stop must NEVER show at the same time.
// There is no pending-message queue: a running turn means Stop, not Send.
// ---------------------------------------------------------------------------

test("REGRESSION: a running turn shows Stop and hides Send, even when the composer is not ready", () => {
  // Send used to stay visible (greyed) alongside Stop — two buttons at once.
  const state = composerButtonState({
    composerReady: false,
    turnRunning: true,
    threadWorking: true,
    activeThreadFrozen: false,
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

test("a running turn shows Stop and hides Send", () => {
  const state = composerButtonState({
    composerReady: true,
    turnRunning: true,
    threadWorking: true,
    activeThreadFrozen: false,
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
    submitInFlight: false,
  });
  assert.equal(state.stopHidden, true, "never offer to stop the review's own turn");
  assert.equal(state.sendHidden, false, "Send stays visible (disabled) when Stop is hidden");
  assert.equal(state.sendDisabled, true);
});

// Stop's HTTP call returns before the turn idles. Until then the button must
// stay up, say Stopping…, and refuse another click — otherwise users mash it.
test("a pending stop keeps Stop visible and disabled while the turn is still working", () => {
  const state = composerButtonState({
    composerReady: true,
    turnRunning: true,
    threadWorking: true,
    activeThreadFrozen: false,
    submitInFlight: false,
    stopPending: true,
  });
  assert.equal(state.stopHidden, false);
  assert.equal(state.stopDisabled, true, "cannot press Stop again while stopping");
  assert.equal(state.stopPending, true);
  assert.equal(state.sendHidden, true);
});

// Ask only fills the box, so whose turn or lease it is right now does not matter.
test("Ask is offered wherever the thread takes messages at all", async () => {
  const { canAskInThread } = await import("./thread-compose.js");
  const idle = { active_thread_id: "t", active_turn_id: null };
  assert.equal(canAskInThread(idle), true);
  assert.equal(canAskInThread({ ...idle, active_turn_id: "turn-1" }), true, "mid-turn too");
  assert.equal(canAskInThread({ ...idle, active_thread_task_reviewer: true }), false);
  assert.equal(canAskInThread({ active_thread_id: null }), false);
  assert.equal(canAskInThread(null), false);
});
