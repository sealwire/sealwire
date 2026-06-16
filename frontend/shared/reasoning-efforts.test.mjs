import test from "node:test";
import assert from "node:assert/strict";

import { resolveOutgoingEffort } from "./reasoning-efforts.js";

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
