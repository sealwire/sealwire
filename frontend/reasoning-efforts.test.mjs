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

test("buildReasoningEffortOptions orders default efforts low->medium->high->xhigh", () => {
  const options = buildReasoningEffortOptions([], "unknown");
  assert.deepEqual(options, [
    { label: "low", value: "low" },
    { label: "medium", value: "medium" },
    { label: "high", value: "high" },
    { label: "xhigh", value: "xhigh" },
  ]);
});

test("buildReasoningEffortOptions returns at least 2 effort options for any model", () => {
  const options = buildReasoningEffortOptions(
    [{ default_reasoning_effort: "medium", model: "gpt-5.5", supported_reasoning_efforts: ["low", "high"] }],
    "gpt-5.5"
  );
  assert.ok(options.length >= 2, `expected at least 2 efforts, got ${options.length}`);
  assert.equal(options[0].value, "low");
  assert.equal(options[1].value, "high");
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
