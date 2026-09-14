import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_GOAL_OBJECTIVE_CHARS,
  goalObjectiveCharCount,
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

test("exactly 500 characters is accepted; 501 is refused", () => {
  assert.equal(goalObjectiveRefusal("x".repeat(MAX_GOAL_OBJECTIVE_CHARS)), null);
  const refusal = goalObjectiveRefusal("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1));
  assert.match(refusal, /at most 500/);
  assert.match(refusal, /status report/);
});

test("astral characters count as one each, matching the relay", () => {
  // 251 emoji → 502 UTF-16 code units, but 251 scalars — must stay under the cap.
  const emoji = "🙂".repeat(251);
  assert.equal(goalObjectiveCharCount(emoji), 251);
  assert.equal(emoji.length, 502, "control: JS .length is UTF-16 units");
  assert.equal(goalObjectiveRefusal(emoji), null);
});

test("prepareAuthoredGoalObjective gates /goal authoring before the network", () => {
  assert.deepEqual(prepareAuthoredGoalObjective("  ship it  "), {
    objective: "ship it",
  });
  assert.deepEqual(prepareAuthoredGoalObjective("   "), { objective: "" });
  const over = prepareAuthoredGoalObjective("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1));
  assert.match(over.refuse, /at most 500/);
  assert.equal(over.objective, undefined);
});
