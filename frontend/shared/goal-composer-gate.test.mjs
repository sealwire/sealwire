// "Keep going" on the Agents card resubmits a STORED objective, so it must not be
// length-gated: a goal written before the cap moved could otherwise never resume.
//
// This reads app.js's source because the wiring it guards only exists there. It can
// only see that the ungated call is still written — what the gate itself does is
// pinned by behaviour in local/goal-authoring.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Keep going reaches postSessionGoal without passing the authoring gate", async () => {
  const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(
    source,
    /createGoalActions\(\{[\s\S]*?setGoal:\s*\(threadId,\s*objective\)\s*=>\s*postSessionGoal\(threadId,\s*objective\)/
  );
  assert.match(source, /setGoal:\s*postSessionGoalFromComposer/, "/goal still goes through the gate");
});
