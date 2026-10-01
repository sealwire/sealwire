import test from "node:test";
import assert from "node:assert/strict";

import { providerLabel, selectModelBadge } from "./provider-labels.js";

test("providerLabel maps known providers and humanizes unknown ones", () => {
  assert.equal(providerLabel("claude_code"), "Claude");
  assert.equal(providerLabel("codex"), "Codex");
  assert.equal(providerLabel("opencode"), "OpenCode");
  assert.equal(providerLabel("some_new_thing"), "Some New Thing");
  assert.equal(providerLabel(""), "");
});

test("model badge shows the provider only, not the model tier", () => {
  const badge = selectModelBadge({ provider: "claude_code", model: "default" });
  assert.equal(badge.text, "Claude");
  assert.ok(!badge.text.includes("default"), "model tier must not appear on the badge");
  assert.equal(badge.show, true);
});

test("model + effort are preserved on the tooltip", () => {
  const badge = selectModelBadge({
    provider: "claude_code",
    model: "opus[1m]",
    reasoningEffort: "high",
  });
  assert.equal(badge.text, "Claude");
  assert.equal(badge.title, "Claude · opus[1m] · effort high");
});

test("hides the badge (no bare-model fallback) when there is no provider", () => {
  // Product decision is provider-only. A saved thread can carry model settings but no
  // provider summary; showing a naked model tier there would resurrect the noise this
  // change removed, so the badge is hidden instead.
  const badge = selectModelBadge({ provider: "", model: "gpt-x" });
  assert.equal(badge.show, false);
  assert.equal(badge.text, "");
});

test("nothing to show when neither provider nor model is present", () => {
  const badge = selectModelBadge({});
  assert.equal(badge.show, false);
  assert.equal(badge.text, "");
});
