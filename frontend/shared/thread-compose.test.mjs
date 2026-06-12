import test from "node:test";
import assert from "node:assert/strict";

import { canComposeThread } from "./thread-compose.js";

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
