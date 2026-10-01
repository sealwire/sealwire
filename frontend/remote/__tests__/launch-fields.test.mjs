import test from "node:test";
import assert from "node:assert/strict";

import { remoteLaunchFields } from "../launch-fields.js";

test("a cold catalog keeps the effort the draft holds, and offers it", () => {
  const launch = remoteLaunchFields({
    sessionDraft: { provider: "claude_code", model: "claude-sonnet-4-6", effort: "max" },
    provider: "claude_code",
    providerModels: {},
  });
  assert.equal(launch.fields.effort, "max");
  assert.ok(launch.effortOptions.some((option) => option.value === "max"));
});

test("OpenCode with no model chosen starts on the model's default effort", () => {
  const launch = remoteLaunchFields({
    sessionDraft: { provider: "opencode", model: "", effort: "medium" },
    provider: "opencode",
    // Another provider's catalog must not decide OpenCode's options.
    providerModels: {
      codex: [{ model: "gpt-5.5", supported_reasoning_efforts: ["medium"], is_default: true }],
    },
  });
  assert.equal(launch.fields.model, "");
  assert.equal(launch.fields.effort, "default");
  assert.deepEqual(launch.effortOptions, [{ label: "Model default", value: "default" }]);
});

test("a discovered OpenCode default does not replace the chosen folder's default", () => {
  const launch = remoteLaunchFields({
    sessionDraft: { provider: "opencode", model: "", effort: "high" },
    provider: "opencode",
    providerModels: {
      opencode: [{ model: "test/echo", is_default: true, supported_reasoning_efforts: ["high", "default"] }],
    },
  });
  assert.equal(launch.fields.model, "");
  assert.equal(launch.fields.effort, "default");
});
