import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReasoningEffortOptions,
  resolveReasoningEffortValue,
} from "./shared/reasoning-efforts.js";

test("buildReasoningEffortOptions uses model-supported efforts verbatim", () => {
  const options = buildReasoningEffortOptions(
    [
      {
        default_reasoning_effort: "medium",
        model: "gpt-5.5",
        supported_reasoning_efforts: ["minimal", "medium", "xhigh"],
      },
    ],
    "gpt-5.5"
  );

  assert.deepEqual(options, [
    { label: "minimal", value: "minimal" },
    { label: "medium", value: "medium" },
    { label: "xhigh", value: "xhigh" },
  ]);
});

test("resolveReasoningEffortValue falls back to model default when current effort is unsupported", () => {
  const effort = resolveReasoningEffortValue(
    [
      {
        default_reasoning_effort: "xhigh",
        model: "gpt-5.5",
        supported_reasoning_efforts: ["medium", "xhigh"],
      },
    ],
    "gpt-5.5",
    "low"
  );

  assert.equal(effort, "xhigh");
});
