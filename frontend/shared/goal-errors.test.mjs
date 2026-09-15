import test from "node:test";
import assert from "node:assert/strict";

import {
  beginGoalAction,
  goalActionGeneration,
  goalErrorFrom,
  withGoalError,
  withGoalErrorCleared,
} from "./goal-errors.js";

function act(state, threadId) {
  const next = beginGoalAction(state, threadId);
  return { state: next, generation: goalActionGeneration(next, threadId) };
}

test("what an action reported is readable until something supersedes it", () => {
  const a = act({}, "t1");
  const state = withGoalError(a.state, "t1", "that thread is busy", a.generation);
  assert.equal(goalErrorFrom(state, "t1"), "that thread is busy");
});

// The reason this is a generation and not a fingerprint of the goal. Stop settles the
// goal AND returns "stopped, but the turn it started is still running" — a warning about
// that very mutation. Anything keyed on the goal looking unchanged discards it.
test("a warning survives the mutation it is about", () => {
  const a = act({}, "t1");
  const state = withGoalError(
    a.state,
    "t1",
    "the goal is stopped, but the turn it started is still running",
    a.generation
  );
  assert.match(goalErrorFrom(state, "t1"), /still running/);
});

// A driven turn bumps the goal's turn count without the user doing anything.
test("the relay making progress on its own does not silence a still-true refusal", () => {
  const a = act({}, "t1");
  let state = withGoalError(a.state, "t1", "that thread is busy", a.generation);
  // Whatever the goal does, no user action has happened, so nothing here changes.
  assert.equal(goalErrorFrom(state, "t1"), "that thread is busy");
  assert.equal(goalActionGeneration(state, "t1"), a.generation);
});

test("the next user action clears what the last one said", () => {
  const a = act({}, "t1");
  let state = withGoalError(a.state, "t1", "that thread is busy", a.generation);
  const b = act(state, "t1");
  assert.equal(goalErrorFrom(b.state, "t1"), "", "the other door has taken over");
});

// The late-settlement direction: the card's request is still in flight when the composer
// replaces the goal, and answers afterwards.
test("an action the user has already replaced cannot report onto the new one", () => {
  const a = act({}, "t1");
  const b = act(a.state, "t1");
  const state = withGoalError(b.state, "t1", "stale refusal from the first attempt", a.generation);
  assert.equal(goalErrorFrom(state, "t1"), "");
});

test("threads keep their own", () => {
  const a = act({}, "t1");
  const b = act(a.state, "t2");
  let state = withGoalError(b.state, "t1", "a failed", a.generation);
  state = withGoalError(state, "t2", "b failed", goalActionGeneration(state, "t2"));

  assert.equal(goalErrorFrom(state, "t1"), "a failed");
  assert.equal(goalErrorFrom(state, "t2"), "b failed");

  const again = act(state, "t1");
  assert.equal(goalErrorFrom(again.state, "t1"), "");
  assert.equal(goalErrorFrom(again.state, "t2"), "b failed", "t2 is none of t1's business");
});

// The word left by the action that CANCELS a goal has no buttons of its own to
// supersede it, so dismissing has to actually retire it — and only it.
test("dismissing retires the current word without opening an action", () => {
  const a = act({}, "t1");
  const b = act(a.state, "t2");
  let state = withGoalError(b.state, "t1", "still running", a.generation);
  state = withGoalError(state, "t2", "b failed", goalActionGeneration(state, "t2"));

  const cleared = withGoalErrorCleared(state, "t1");

  assert.equal(goalErrorFrom(cleared, "t1"), "", "the message is gone");
  assert.equal(
    goalActionGeneration(cleared, "t1"),
    goalActionGeneration(state, "t1"),
    "but no action was opened, so a settlement in flight is still the current one"
  );
  assert.equal(goalErrorFrom(cleared, "t2"), "b failed", "t2 is none of t1's business");
});

test("dismissing a thread that never failed is harmless", () => {
  assert.equal(goalErrorFrom(withGoalErrorCleared({}, "t1"), "t1"), "");
});
