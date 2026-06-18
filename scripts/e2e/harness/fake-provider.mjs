import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function createFakeProviderScenarioHarness(rootDir, config) {
  const controlDir = path.join(rootDir, "fake-provider-control");
  const scenarioPath = path.join(rootDir, "fake-provider-scenarios.json");
  await fs.mkdir(controlDir, { recursive: true });
  await fs.writeFile(scenarioPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return {
    controlDir,
    scenarioPath,
    env: {
      FAKE_PROVIDER_SCENARIO_PATH: scenarioPath,
      FAKE_PROVIDER_CONTROL_DIR: controlDir,
    },
    async waitForBarrier(name, timeoutMs = 30000) {
      const pausedPath = barrierPath(controlDir, name, "paused.json");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          return JSON.parse(await fs.readFile(pausedPath, "utf8"));
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
        await delay(10);
      }
      throw new Error(`timed out waiting for fake-provider barrier '${name}'`);
    },
    async releaseBarrier(name) {
      await fs.writeFile(barrierPath(controlDir, name, "release"), "release\n", "utf8");
    },
  };
}

function barrierPath(controlDir, name, suffix) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`invalid fake-provider barrier name: ${JSON.stringify(name)}`);
  }
  return path.join(controlDir, `${name}.${suffix}`);
}
