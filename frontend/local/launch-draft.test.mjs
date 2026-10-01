import test from "node:test";
import assert from "node:assert/strict";

import { settleLaunchDraft } from "./launch-draft.js";

// Echo is the catalog's default only for the folder the relay discovered it in;
// the new session's own folder may default to Second.
const OPENCODE = [
  { model: "test/echo", provider: "opencode", is_default: true,
    supported_reasoning_efforts: ["low", "high", "default"], default_reasoning_effort: "default" },
  { model: "test/second", provider: "opencode", supported_reasoning_efforts: [] },
];
const CLAUDE = [
  { model: "claude-opus-4-8", is_default: true,
    supported_reasoning_efforts: ["low", "high", "max"], default_reasoning_effort: "high" },
];

test("OpenCode with no model picked stays empty so its folder's config decides", () => {
  for (const effort of ["medium", "high"]) {
    assert.deepEqual(
      settleLaunchDraft({ model: "", effort }, OPENCODE, "opencode"),
      { model: "", effort: "default" }
    );
  }
});

test("an OpenCode model the user picked is kept, with its own efforts", () => {
  assert.deepEqual(
    settleLaunchDraft({ model: "test/echo", effort: "high" }, OPENCODE, "opencode"),
    { model: "test/echo", effort: "high" }
  );
});

test("other providers still take the catalog's default model", () => {
  assert.deepEqual(
    settleLaunchDraft({ model: "", effort: "max" }, CLAUDE, "claude_code"),
    { model: "claude-opus-4-8", effort: "max" }
  );
});

test("a cold catalog leaves the draft's effort alone, except OpenCode's", () => {
  assert.deepEqual(
    settleLaunchDraft({ model: "claude-sonnet-4-6", effort: "max" }, [], "claude_code"),
    { model: "claude-sonnet-4-6", effort: "max" }
  );
  assert.deepEqual(
    settleLaunchDraft({ model: "", effort: "medium" }, [], "opencode"),
    { model: "", effort: "default" }
  );
});
