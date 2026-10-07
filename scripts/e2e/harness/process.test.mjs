import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const PROCESS_MODULE = new URL("./process.mjs", import.meta.url).href;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A runner stops a hung scenario with SIGTERM. Its relay and broker must go with it, or
// they hold their ports and CPU for the rest of the run.
test("a scenario stopped with SIGTERM takes its managed processes down", async () => {
  const scenario = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { spawnManagedProcess } from ${JSON.stringify(PROCESS_MODULE)};
       const child = spawnManagedProcess("sleeper", process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
       console.log(child.pid);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const [line] = await once(scenario.stdout, "data");
  const managedPid = Number(String(line).trim());
  try {
    assert.ok(alive(managedPid), "precondition: the managed process is running");
    scenario.kill("SIGTERM");
    await once(scenario, "exit");
    for (let i = 0; i < 50 && alive(managedPid); i += 1) {
      await delay(20);
    }
    assert.equal(alive(managedPid), false, "the managed process outlived its scenario");
  } finally {
    if (alive(managedPid)) process.kill(managedPid, "SIGKILL");
  }
});
