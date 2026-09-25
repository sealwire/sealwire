import assert from "node:assert/strict";
import test from "node:test";

import { pickFallbacks } from "./update-model-prices.mjs";

const card = { input: 1, output: 1 };
const table = (...keys) => Object.fromEntries(keys.map((key) => [key, card]));

test("the fallback is the newest mid-tier model, compared as versions not strings", () => {
  const picked = pickFallbacks(
    table("claude-sonnet-4-9", "claude-sonnet-4-10", "claude-opus-9", "gpt-5.9", "gpt-5.10", "gpt-5.10-mini")
  );
  assert.deepEqual(picked, { claude: "claude-sonnet-4-10", openai: "gpt-5.10" });
});

test("a dated snapshot is not mistaken for a newer minor version", () => {
  const picked = pickFallbacks(table("claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "gpt-5", "gpt-5-2025-08-07"));
  assert.deepEqual(picked, { claude: "claude-sonnet-4-5", openai: "gpt-5" });
});

test("a table with nothing the rule can pick refuses instead of writing no fallback", () => {
  assert.throws(() => pickFallbacks(table("claude-opus-5", "gpt-5")), /claude/);
});
