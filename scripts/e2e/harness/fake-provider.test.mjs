import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFakeProviderScenarioHarness } from "./fake-provider.mjs";

test("fake-provider harness writes scenarios and releases observed barriers", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-provider-harness-"));
  try {
    const config = {
      prompts: {
        pause: {
          chunks: ["before", "after"],
          pause_after_chunks: 1,
          barrier: "turn-a",
        },
      },
    };
    const harness = await createFakeProviderScenarioHarness(rootDir, config);
    assert.deepEqual(
      JSON.parse(await fs.readFile(harness.scenarioPath, "utf8")),
      config
    );
    assert.equal(harness.env.FAKE_PROVIDER_CONTROL_DIR, harness.controlDir);

    await fs.writeFile(
      path.join(harness.controlDir, "turn-a.paused.json"),
      JSON.stringify({ barrier: "turn-a", thread_id: "thread-a" }),
      "utf8"
    );
    assert.equal((await harness.waitForBarrier("turn-a", 100)).thread_id, "thread-a");
    await harness.releaseBarrier("turn-a");
    assert.equal(
      await fs.readFile(path.join(harness.controlDir, "turn-a.release"), "utf8"),
      "release\n"
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("fake-provider harness rejects unsafe barrier names", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-provider-harness-"));
  try {
    const harness = await createFakeProviderScenarioHarness(rootDir, { prompts: {} });
    await assert.rejects(() => harness.releaseBarrier("../escape"), /invalid.*barrier/i);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
