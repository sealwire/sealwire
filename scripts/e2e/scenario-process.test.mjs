import assert from "node:assert/strict";
import test from "node:test";

import { runScenarioProcess } from "./scenario-process.mjs";

test("a scenario that never exits is stopped at its timeout", { timeout: 10000 }, async () => {
  const result = await runScenarioProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: process.env,
    timeoutMs: 300,
    stdio: "ignore",
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("a scenario that finishes reports its own exit", async () => {
  const result = await runScenarioProcess(process.execPath, ["-e", "process.exit(3)"], {
    env: process.env,
    timeoutMs: 10000,
    stdio: "ignore",
  });
  assert.deepEqual(result, { code: 3, signal: null, timedOut: false });
});
