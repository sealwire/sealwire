import test from "node:test";
import assert from "node:assert/strict";

import {
  isStopPending,
  reconcileAllStopPending,
  reconcileStopPending,
  withoutStopPending,
  withStopPending,
} from "./stop-pending.js";

test("withStopPending marks one thread without touching others", () => {
  const next = withStopPending({ "thread-a": true }, "thread-b");
  assert.equal(isStopPending(next, "thread-a"), true);
  assert.equal(isStopPending(next, "thread-b"), true);
});

test("withoutStopPending clears only the named thread", () => {
  const next = withoutStopPending({ "thread-a": true, "thread-b": true }, "thread-a");
  assert.equal(isStopPending(next, "thread-a"), false);
  assert.equal(isStopPending(next, "thread-b"), true);
});

// The bug this pins: stop's HTTP round-trip finishes while the turn is still
// working, so clearing pending on response would re-enable Stop and invite
// double-clicks. Pending must survive until the thread goes idle.
test("reconcile keeps pending while the thread is still working", () => {
  const pending = withStopPending({}, "thread-1");
  assert.deepEqual(reconcileStopPending(pending, "thread-1", true), pending);
});

test("reconcile of an idle viewed thread leaves another thread's pending intact", () => {
  // Same navigation hole the phone hit with a global bit: after stopping A,
  // looking at idle B must not clear A's Stopping… flag.
  const pending = withStopPending({}, "thread-a");
  const afterB = reconcileStopPending(pending, "thread-b", false);
  assert.equal(isStopPending(afterB, "thread-a"), true);
  assert.equal(isStopPending(afterB, "thread-b"), false);
});

test("reconcileAll clears every idle pending thread, including ones not on screen", () => {
  // Stop A, switch to B, A idles off-screen: A's flag must drop so a later turn
  // on A is not stuck behind Stopping… / the duplicate-click guard.
  const pending = withStopPending(withStopPending({}, "thread-a"), "thread-b");
  const next = reconcileAllStopPending(pending, (id) => id === "thread-b");
  assert.equal(isStopPending(next, "thread-a"), false);
  assert.equal(isStopPending(next, "thread-b"), true);
});

test("reconcile drops a stale pending when a newer turn id is on the thread", () => {
  const pending = withStopPending({}, "thread-a", "turn-old");
  const next = reconcileStopPending(pending, "thread-a", {
    working: true,
    turnId: "turn-new",
  });
  assert.equal(isStopPending(next, "thread-a"), false);
});
