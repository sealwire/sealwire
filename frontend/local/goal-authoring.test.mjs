// The symptom was not "/goal is broken" but "/goal does nothing": a refusal reached
// only the client log, which sits behind Settings → Log. The draft stayed put and
// nothing was said, so Send read as dead. These pin the visible half.
import test from "node:test";
import assert from "node:assert/strict";

import { createGoalAuthor } from "./goal-authoring.js";
import { MAX_GOAL_OBJECTIVE_CHARS } from "../shared/goal-objective.js";

function harness({ setGoalResult = { text: "Goal set.", isError: false } } = {}) {
  const shown = [];
  const held = [];
  const sent = [];
  const author = createGoalAuthor({
    setGoal: async (threadId, objective) => {
      sent.push([threadId, objective]);
      return setGoalResult;
    },
    setComposerError: (threadId, message) => shown.push([threadId, message]),
    setComposerHeld: (threadId, message) => held.push([threadId, message]),
  });
  return { author, shown, held, sent };
}

// The gate stops this before the relay hears about it, so nothing failed and nothing
// was sent: it belongs in "not sent", not on the red line that means something broke.
test("a goal refused for length is held, not reported as a failure", async () => {
  const { author, shown, held, sent } = harness();
  const answer = await author("thread-1", "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1));

  assert.equal(answer.isError, true);
  assert.equal(sent.length, 0, "refused before the network");
  assert.deepEqual(
    held.map(([threadId]) => threadId),
    ["thread-1"],
    "held against the thread it was typed on"
  );
  assert.equal(held[0][1], answer.text, "the visible line says what the log says");
  assert.ok(held[0][1].trim(), "a blank line hides the refusal all over again");
  assert.deepEqual(
    shown.filter(([, message]) => message.trim()),
    [],
    "and nothing claims something went wrong"
  );
});

// The relay DID hear this one and said no, so it is a failure and reads like one.
test("a relay refusal stays on the error line, not in the held slot", async () => {
  const { author, shown, held } = harness({
    setGoalResult: { text: "that thread is busy with a turn", isError: true },
  });

  await author("thread-1", "ship it");

  assert.deepEqual(shown.at(-1), ["thread-1", "that thread is busy with a turn"]);
  assert.deepEqual(
    held.filter(([, message]) => message.trim()),
    [],
    "nothing is waiting on the user here — the relay refused it outright"
  );
});

test("a fresh attempt clears the last refusal on that thread", async () => {
  const { author, shown, held } = harness();
  await author("thread-1", "x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1));
  await author("thread-1", "ship the phone menu");

  assert.deepEqual(
    shown[1],
    ["thread-1", ""],
    "the red line must not outlive the draft that caused it"
  );
  // The refusal went to the HELD region, so checking only the red line above proves
  // nothing about the line actually on screen — it would stay through a fixed draft.
  assert.deepEqual(
    held.at(-1),
    ["thread-1", ""],
    "and neither must the NOT SENT line it really wrote"
  );
});

test("an accepted objective reaches the relay trimmed", async () => {
  const { author, shown, sent } = harness();
  const answer = await author("thread-1", "  ship it  ");

  assert.equal(answer.isError, false);
  assert.deepEqual(sent, [["thread-1", "ship it"]]);
  assert.deepEqual(shown, [["thread-1", ""]]);
});

// The gate only knows about length. Everything else a goal can be refused for — a busy
// thread, a session narrowed since — is decided by the relay, and lands in the same
// invisible place unless it is shown too.
test("a relay refusal is shown, not just the gate's own", async () => {
  const { author, shown } = harness({
    setGoalResult: { text: "that thread is busy with a turn", isError: true },
  });

  const answer = await author("thread-1", "ship it");

  assert.equal(answer.isError, true);
  assert.deepEqual(shown.at(-1), ["thread-1", "that thread is busy with a turn"]);
});

test("a goal that is accepted leaves no line behind", async () => {
  const { author, shown } = harness();
  await author("thread-1", "ship it");
  assert.deepEqual(shown.at(-1), ["thread-1", ""]);
});

// "/goal" on its own is how a goal is called off; the relay reads empty as stop.
test("an empty objective is passed through rather than refused", async () => {
  const { author, sent } = harness();
  await author("thread-1", "   ");
  assert.deepEqual(sent, [["thread-1", ""]]);
});

// The private controller keeps or clears the draft from `isError`. A helper that slips
// back to the old bare boolean reads as SUCCESS there — the draft is thrown away and
// nothing is said, which is worse than the silence this whole path was built to end.
test("a helper that answers the old boolean is a loud failure, not a silent success", async () => {
  for (const legacy of [false, true, undefined]) {
    const shown = [];
    const author = createGoalAuthor({
      setGoal: async () => legacy,
      setComposerError: (threadId, message) => shown.push([threadId, message]),
    });

    const answer = await author("thread-1", "ship it");

    assert.equal(answer.isError, true, `${legacy} must not read as success`);
    assert.ok(answer.text.trim(), "and the draft is kept for a reason the user can see");
    assert.equal(shown.at(-1)[1], answer.text);
  }
});

test("a goal the user authors here supersedes what the card last reported", async () => {
  const began = [];
  const author = createGoalAuthor({
    setGoal: async () => ({ isError: false, text: "" }),
    beginGoalAction: (threadId) => began.push(threadId),
  });

  await author("thread-1", "ship it");

  assert.deepEqual(began, ["thread-1"], "the card's last word is no longer the current one");
});
