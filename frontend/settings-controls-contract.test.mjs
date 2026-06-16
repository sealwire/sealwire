import test from "node:test";
import assert from "node:assert/strict";

import { buildReasoningEffortOptionsWithSelection } from "./shared/reasoning-efforts.js";
import { buildModelOptions, buildModelSelectOptions } from "./shared/composer.js";

// Contract for the session-settings controls (model picker + effort control).
//
// Whatever the catalog looks like — fully loaded, empty, stale, or exposing a
// value only via an alias — each control must keep the *current selection*
// representable: present exactly once. That single property rules out both
// failure modes we have hit:
//   - the selection silently disappearing (Claude "max" with a stale catalog)
//   - a duplicate "ghost" row for the same logical selection
//
// These exercise the real shared helpers the components render from, so a
// regression in either control fails here.

const EFFORT_CATALOGS = {
  empty: [],
  "claude with max": [
    {
      model: "claude-opus",
      supported_reasoning_efforts: ["high", "max"],
      default_reasoning_effort: "high",
    },
  ],
  "codex without max": [
    {
      model: "gpt-5.5",
      supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
      default_reasoning_effort: "medium",
    },
  ],
};

const EFFORT_SELECTIONS = ["max", "xhigh", "high", "medium", "low", ""];

for (const [catalogName, models] of Object.entries(EFFORT_CATALOGS)) {
  for (const selected of EFFORT_SELECTIONS) {
    test(`effort control keeps selection representable — catalog="${catalogName}", selected="${selected}"`, () => {
      const model = models[0]?.model || "claude-opus";
      const options = buildReasoningEffortOptionsWithSelection(
        models,
        model,
        "claude_code",
        selected
      );
      assert.ok(options.length > 0, "options must never be empty");
      if (selected) {
        const matches = options.filter((option) => option.value === selected);
        assert.equal(
          matches.length,
          1,
          `selected "${selected}" must appear exactly once, got ${matches.length}`
        );
        assert.ok(matches[0].label, "the selected option must carry a label");
      }
    });
  }
}

const MODEL_CATALOGS = {
  empty: [],
  "alias only (default -> opus)": [
    { model: "default", display_name: "Default (recommended, Opus 4.8)", provider: "anthropic" },
    { model: "claude-sonnet-4-6", display_name: "Sonnet 4.6", provider: "anthropic" },
  ],
  "concrete ids": [
    { model: "claude-opus-4-8", display_name: "Opus 4.8", provider: "anthropic" },
    { model: "claude-sonnet-4-6", display_name: "Sonnet 4.6", provider: "anthropic" },
  ],
};

const MODEL_SELECTIONS = ["claude-opus-4-8", "default", "claude-sonnet-4-6", ""];

for (const [catalogName, models] of Object.entries(MODEL_CATALOGS)) {
  for (const selected of MODEL_SELECTIONS) {
    test(`model picker keeps selection representable — catalog="${catalogName}", selected="${selected}"`, () => {
      const options = buildModelOptions(models, selected);
      if (selected) {
        const matches = options.filter((option) => option.model === selected);
        assert.equal(
          matches.length,
          1,
          `selected "${selected}" must appear exactly once, got ${matches.length}`
        );
      }
    });
  }
}

// Named regressions for the two bugs that motivated this harness.

test("regression: Claude 'max' stays selectable when the catalog is empty/stale", () => {
  const options = buildReasoningEffortOptionsWithSelection([], "claude-opus", "claude_code", "max");
  assert.ok(
    options.some((option) => option.value === "max"),
    "max must remain selectable even with no catalog loaded"
  );
});

test("regression: a concrete model id stays representable against an alias-only catalog", () => {
  const models = [
    { model: "default", display_name: "Default (recommended, Opus 4.8)", provider: "anthropic" },
  ];
  const options = buildModelOptions(models, "claude-opus-4-8");
  const matches = options.filter((option) => option.model === "claude-opus-4-8");
  assert.equal(matches.length, 1, "the concrete id must appear exactly once (single ghost fallback)");
});

test("model picker hides hidden models but keeps the current (even hidden) selection", () => {
  const models = [
    { model: "gpt-5.5", display_name: "GPT-5.5" },
    { model: "codex-auto-review", display_name: "Codex Auto Review", hidden: true },
  ];
  // A hidden model (Codex marks internal/deprecated entries hidden) never shows.
  const options = buildModelOptions(models, "gpt-5.5");
  assert.ok(
    !options.some((option) => option.model === "codex-auto-review"),
    "hidden models must not appear in the picker"
  );
  assert.ok(
    options.some((option) => option.model === "gpt-5.5"),
    "visible models still appear"
  );

  // But if the CURRENT selection is itself hidden, keep it representable (once).
  const onHidden = buildModelOptions(models, "codex-auto-review");
  assert.equal(
    onHidden.filter((option) => option.model === "codex-auto-review").length,
    1,
    "a hidden current selection must stay representable exactly once"
  );
});

// buildModelSelectOptions is the shared filter the local picker (syncModelSuggestions
// in app.js) delegates to — guard its hidden-drop in BOTH allowForeign branches.
const HIDDEN_CATALOG = [
  { model: "gpt-5.5", display_name: "GPT-5.5", is_default: true },
  { model: "codex-auto-review", display_name: "Codex Auto Review", hidden: true },
];

for (const allowForeign of [true, false]) {
  test(`buildModelSelectOptions drops hidden models (allowForeign=${allowForeign})`, () => {
    const { options } = buildModelSelectOptions(HIDDEN_CATALOG, "gpt-5.5", { allowForeign });
    assert.ok(
      !options.some((option) => option.model === "codex-auto-review"),
      "hidden model must be dropped"
    );
    assert.ok(options.some((option) => option.model === "gpt-5.5"), "visible model kept");
  });
}

test("buildModelSelectOptions (allowForeign) keeps a hidden CURRENT selection with its real label", () => {
  const { options, value } = buildModelSelectOptions(HIDDEN_CATALOG, "codex-auto-review", {
    allowForeign: true,
  });
  assert.equal(value, "codex-auto-review", "current selection is preserved");
  const matches = options.filter((option) => option.model === "codex-auto-review");
  assert.equal(matches.length, 1, "representable exactly once");
  assert.equal(matches[0].display_name, "Codex Auto Review", "keeps the real display_name, not the raw id");
});

test("buildModelSelectOptions (!allowForeign) snaps a value not in the catalog to the default", () => {
  const models = [
    { model: "claude-default", display_name: "Default", is_default: true },
    { model: "claude-sonnet", display_name: "Sonnet" },
  ];
  const { options, value } = buildModelSelectOptions(models, "gpt-5.5", { allowForeign: false });
  assert.equal(value, "claude-default", "stale foreign id snaps to the provider default");
  assert.ok(!options.some((option) => option.model === "gpt-5.5"), "the foreign id is not surfaced");
});
