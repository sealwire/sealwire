import test from "node:test";
import assert from "node:assert/strict";

import {
  LONG_GOAL_OBJECTIVE_CHARS,
  MAX_GOAL_OBJECTIVE_CHARS,
  goalObjectiveCharCount,
  goalObjectiveLengthNotice,
  goalObjectiveRefusal,
  prepareAuthoredGoalObjective,
} from "./goal-objective.js";

test("a short standing aim is accepted", () => {
  assert.equal(goalObjectiveRefusal("ship the phone menu"), null);
});

test("empty is not refused here — stop vs set is the caller's job", () => {
  assert.equal(goalObjectiveRefusal(""), null);
  assert.equal(goalObjectiveRefusal("   "), null);
});

test("the cap is a wall for a pasted document, not for a page of instructions", () => {
  assert.equal(goalObjectiveRefusal("x".repeat(MAX_GOAL_OBJECTIVE_CHARS)), null);
  assert.equal(goalObjectiveRefusal("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1)) !== null, true);
  // The size that started this: a task brief with file paths and constraints.
  assert.equal(goalObjectiveRefusal("x".repeat(600)), null);
});

// The draft is kept on refusal, so the fix is an edit — and an edit needs a number.
test("the refusal says how much to cut, not just that it is too long", () => {
  const over = 137;
  const refusal = goalObjectiveRefusal("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + over));
  assert.match(refusal, new RegExp(String(MAX_GOAL_OBJECTIVE_CHARS + over)), "says what you wrote");
  assert.match(refusal, new RegExp(String(MAX_GOAL_OBJECTIVE_CHARS)), "says the limit");
  assert.match(refusal, new RegExp(`Trim ${over}\\b`), "says the difference, so it need not be worked out");
});

test("a long-but-accepted aim is described, never refused", () => {
  const long = "x".repeat(LONG_GOAL_OBJECTIVE_CHARS + 1);
  assert.equal(goalObjectiveRefusal(long), null, "the notice must not become a second wall");
  assert.match(goalObjectiveLengthNotice(long), /every turn/);
  assert.match(goalObjectiveLengthNotice(long), new RegExp(String(LONG_GOAL_OBJECTIVE_CHARS + 1)));
});

test("an ordinary aim gets no notice", () => {
  assert.equal(goalObjectiveLengthNotice("ship the phone menu"), null);
  assert.equal(goalObjectiveLengthNotice("x".repeat(LONG_GOAL_OBJECTIVE_CHARS)), null);
  assert.equal(goalObjectiveLengthNotice(""), null);
});

// "Keep going" resubmits a stored aim verbatim, including one written before the cap
// moved. The card still has to be able to describe it.
test("a goal over the hard cap is still described rather than going silent", () => {
  assert.match(
    goalObjectiveLengthNotice("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1)),
    /re-sent in full every turn/
  );
});

test("astral characters count as one each, matching the relay", () => {
  const emoji = "🙂".repeat(MAX_GOAL_OBJECTIVE_CHARS);
  assert.equal(goalObjectiveCharCount(emoji), MAX_GOAL_OBJECTIVE_CHARS);
  assert.equal(emoji.length, MAX_GOAL_OBJECTIVE_CHARS * 2, "control: JS .length is UTF-16 units");
  assert.equal(goalObjectiveRefusal(emoji), null, "exactly at the cap in scalars");
  assert.equal(goalObjectiveRefusal(emoji + "🙂") !== null, true);
});

test("prepareAuthoredGoalObjective gates /goal authoring before the network", () => {
  assert.deepEqual(prepareAuthoredGoalObjective("  ship it  "), { objective: "ship it" });
  assert.deepEqual(prepareAuthoredGoalObjective("   "), { objective: "" });
  const over = prepareAuthoredGoalObjective("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1));
  assert.ok(over.refuse);
  assert.equal(over.objective, undefined);
});

// The notice is advice about a goal that IS set, so the gate must not start refusing
// on it — the composer's only visible line is error-toned.
test("a long aim passes the gate untouched", () => {
  const long = "x".repeat(LONG_GOAL_OBJECTIVE_CHARS + 1);
  assert.deepEqual(prepareAuthoredGoalObjective(long), { objective: long });
});

// Two constants, two languages, one rule: a JS cap below the relay's lets the composer
// refuse what the relay would take; above it, the relay refuses after the gate passed
// and the refusal lands in the log the user cannot see.
test("the cap matches the relay's, which enforces it for every other door", async () => {
  const { readFile } = await import("node:fs/promises");
  const rust = await readFile(
    new URL("../../crates/relay-server/src/state/goal.rs", import.meta.url),
    "utf8"
  );
  const declared = rust.match(/MAX_GOAL_OBJECTIVE_CHARS:\s*usize\s*=\s*([0-9_]+)/)?.[1];
  assert.ok(declared, "the relay's constant must still be findable");
  assert.equal(Number(declared.replace(/_/g, "")), MAX_GOAL_OBJECTIVE_CHARS);
});
