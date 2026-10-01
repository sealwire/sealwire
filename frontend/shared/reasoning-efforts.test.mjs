import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReasoningEffortOptions,
  buildReasoningEffortOptionsWithSelection,
  resolveOutgoingEffort,
  resolveReasoningEffortValue,
} from "./reasoning-efforts.js";

test("OpenCode offers model default until ACP reports that model's variants", () => {
  const unknown = { model: "test/second", provider: "opencode", supported_reasoning_efforts: [] };
  for (const models of [[], [unknown]]) {
    assert.deepEqual(buildReasoningEffortOptions(models, "test/second", "opencode"), [
      { label: "Model default", value: "default" },
    ]);
    assert.equal(resolveReasoningEffortValue(models, "test/second", "medium", "opencode"), "default");
  }
});

test("OpenCode clamps a previous provider's effort against the selected model", () => {
  const models = [{ model: "test/echo", provider: "opencode",
    supported_reasoning_efforts: ["low", "high", "default"], default_reasoning_effort: "low" }];
  assert.equal(resolveReasoningEffortValue(models, "test/echo", "medium", "opencode"), "low");
  assert.equal(resolveReasoningEffortValue(models, "test/echo", "high", "opencode"), "high");
  assert.deepEqual(buildReasoningEffortOptions(models, "test/echo", "opencode").map((row) => row.value), ["low", "high", "default"]);
});

test("a catalog that does not know a model's efforts keeps the effort it was given", () => {
  // Opening the launch dialog before Claude's catalog arrived turned `max` into `low`.
  for (const models of [[], [{ model: "claude-sonnet-4-6", supported_reasoning_efforts: [] }]]) {
    assert.equal(resolveReasoningEffortValue(models, "claude-sonnet-4-6", "max", "claude_code"), "max");
  }
  assert.equal(resolveReasoningEffortValue([], "gpt-5.5", "minimal", "codex"), "minimal");
  assert.deepEqual(
    buildReasoningEffortOptionsWithSelection([], "claude-sonnet-4-6", "claude_code", "max").at(-1),
    { label: "Max", value: "max" }
  );
});

const CODEX = [
  {
    model: "gpt-5.3-codex",
    provider: "codex",
    supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
    default_reasoning_effort: "medium",
  },
];
const CLAUDE = [
  {
    model: "claude-opus-4-8",
    provider: "claude_code",
    supported_reasoning_efforts: ["low", "medium", "high", "max"],
    default_reasoning_effort: "high",
  },
];

// REGRESSION (codex review): a client already holding a poisoned per-provider
// last-used effort (agent-relay:lastUsed:effort:codex = "max", from the old
// empty->codex bucket collapse) must NOT keep forwarding "max" to codex and
// hitting HTTP 400. For an existing session the live session effort is
// authoritative, so it wins over the stale last-used memory.
test("send prefers the live session effort over a poisoned last-used value", () => {
  assert.equal(
    resolveOutgoingEffort({
      sessionEffort: "high",
      lastUsedEffort: "max", // poisoned codex bucket
      models: CODEX,
      model: "gpt-5.3-codex",
    }),
    "high",
  );
});

// Even with no live session effort yet, a poisoned last-used value must not reach
// codex: it is clamped to the model's default instead of forwarding "max".
test("send clamps an unsupported last-used effort to the model default", () => {
  assert.equal(
    resolveOutgoingEffort({
      sessionEffort: "",
      lastUsedEffort: "max",
      models: CODEX,
      model: "gpt-5.3-codex",
    }),
    "medium",
  );
});

// Guard: a legitimate provider-specific effort (Claude's "max") must survive,
// including when the catalog is empty/stale (no supported list to validate
// against) — clamping there would wrongly downgrade a valid Claude effort.
test("send keeps a legit provider-specific effort when the model is unknown/stale", () => {
  assert.equal(
    resolveOutgoingEffort({ sessionEffort: "max", models: [], model: "claude-opus-4-8" }),
    "max",
  );
  assert.equal(
    resolveOutgoingEffort({ sessionEffort: "max", models: CLAUDE, model: "claude-opus-4-8" }),
    "max",
  );
});

// An explicit composer override wins over everything.
test("send honors an explicit composer override", () => {
  assert.equal(
    resolveOutgoingEffort({
      override: "low",
      sessionEffort: "high",
      lastUsedEffort: "max",
      models: CODEX,
      model: "gpt-5.3-codex",
    }),
    "low",
  );
});
