// Local /goal must refuse over-limit aims before the network; Keep going must not,
// or a pre-cap dump can never be resumed from the Agents card.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("local composer setGoal is gated; Keep going is not", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /setGoal:\s*postSessionGoalFromComposer/);
  assert.match(
    source,
    /createGoalActions\(\{[\s\S]*?setGoal:\s*\(threadId,\s*objective\)\s*=>\s*postSessionGoal\(threadId,\s*objective\)/
  );
  assert.match(source, /function postSessionGoalFromComposer/);
  assert.match(source, /prepareAuthoredGoalObjective/);
});
