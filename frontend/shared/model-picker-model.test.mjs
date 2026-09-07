import test from "node:test";
import assert from "node:assert/strict";

import { buildModelPickerGroups, selectedModelChip } from "./model-picker-model.js";

// Merging the two dropdowns moves a real invariant here: the submitted pair must
// stay consistent, and the current model must stay visible in a stale catalogue.

const CLAUDE = [
  { model: "claude-opus-4-6", display_name: "Opus 4.6", is_default: true },
  { model: "claude-sonnet-4-5", display_name: "Sonnet 4.5" },
  { model: "claude-internal", display_name: "Internal", hidden: true },
];
const CODEX = [
  { model: "gpt-5.5", display_name: "GPT-5.5", is_default: true },
  { model: "gpt-5-codex", display_name: "GPT-5 Codex" },
];

const CATALOGS = { claude_code: CLAUDE, codex: CODEX };
const PROVIDERS = ["claude_code", "codex"];

test("models are grouped under their provider, in provider order", () => {
  const groups = buildModelPickerGroups({
    providerModels: CATALOGS,
    providers: PROVIDERS,
    selectedModel: "claude-opus-4-6",
    selectedProvider: "claude_code",
  });

  assert.deepEqual(
    groups.map((group) => [group.provider, group.label]),
    [
      ["claude_code", "Claude"],
      ["codex", "Codex"],
    ]
  );
  assert.deepEqual(
    groups[1].options.map((option) => option.value),
    ["gpt-5.5", "gpt-5-codex"]
  );
});

test("hidden models are dropped", () => {
  // Codex marks internal/deprecated entries hidden. They were never offered in
  // the old select and must not reappear just because the menu is new.
  const groups = buildModelPickerGroups({
    providerModels: CATALOGS,
    providers: PROVIDERS,
    selectedModel: "claude-opus-4-6",
    selectedProvider: "claude_code",
  });

  assert.equal(
    groups[0].options.some((option) => option.value === "claude-internal"),
    false
  );
});

test("exactly one option is selected, and it is the one in the chosen provider's group", () => {
  const groups = buildModelPickerGroups({
    providerModels: CATALOGS,
    providers: PROVIDERS,
    selectedModel: "gpt-5-codex",
    selectedProvider: "codex",
  });
  const selected = groups.flatMap((group) =>
    group.options.filter((option) => option.selected)
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].value, "gpt-5-codex");
  assert.equal(selected[0].provider, "codex");
});

test("an id that exists in two catalogs only selects under the chosen provider", () => {
  // Only reachable since the merge: two lit rows would be two answers.
  const groups = buildModelPickerGroups({
    providerModels: {
      claude_code: [{ model: "shared-id", display_name: "Shared" }],
      codex: [{ model: "shared-id", display_name: "Shared" }],
    },
    providers: PROVIDERS,
    selectedModel: "shared-id",
    selectedProvider: "codex",
  });
  const selected = groups.flatMap((group) =>
    group.options.filter((option) => option.selected)
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].provider, "codex");
});

test("the default model is tagged so the menu says which one you would get", () => {
  const groups = buildModelPickerGroups({
    providerModels: CATALOGS,
    providers: PROVIDERS,
    selectedModel: "claude-sonnet-4-5",
    selectedProvider: "claude_code",
  });
  const tags = groups[0].options.map((option) => [option.value, option.tag]);

  assert.deepEqual(tags, [
    ["claude-opus-4-6", "default"],
    ["claude-sonnet-4-5", null],
  ]);
});

test("a selected model missing from its catalog is still listed, so the choice is visible", () => {
  // Dropping it would tick nothing while the dialog holds a real value, so the
  // user re-picks and changes their session by accident.
  const groups = buildModelPickerGroups({
    providerModels: { claude_code: [], codex: CODEX },
    providers: PROVIDERS,
    selectedModel: "claude-opus-4-6",
    selectedProvider: "claude_code",
  });

  assert.deepEqual(
    groups[0].options.map((option) => [option.value, option.selected]),
    [["claude-opus-4-6", true]]
  );
  assert.equal(
    groups[0].empty,
    true,
    "the synthetic current-model row must not masquerade as a loaded catalog"
  );
});

test("an unknown provider list still offers the provider the draft is on", () => {
  // Zero sections renders as an empty 14px strip under the pill — the remote menu
  // bug. The provider list is one broker round trip that can be lost, so it must
  // never be the only thing standing between the user and their own catalogue.
  const groups = buildModelPickerGroups({
    providerModels: CATALOGS,
    providers: [],
    selectedModel: "gpt-5.5",
    selectedProvider: "codex",
  });

  assert.deepEqual(
    groups.map((group) => group.provider),
    ["codex"]
  );
  assert.deepEqual(
    groups[0].options.map((option) => [option.value, option.selected]),
    [
      ["gpt-5.5", true],
      ["gpt-5-codex", false],
    ]
  );
});

test("a provider with no catalog yet is still CHOOSABLE, not just visible", () => {
  // A cold catalogue must not strand the user on their current provider: the relay
  // can start it on its own default, and an empty model id asks for exactly that.
  const groups = buildModelPickerGroups({
    providerModels: { claude_code: CLAUDE },
    providers: PROVIDERS,
    selectedModel: "claude-opus-4-6",
    selectedProvider: "claude_code",
  });

  assert.equal(groups.length, 2, "codex is still offered");
  assert.equal(groups[1].empty, true, "and is marked as catalogue-less");
  assert.deepEqual(
    groups[1].options.map((option) => [option.value, option.label, option.provider]),
    [["", "Use provider default", "codex"]],
    "with one row that resolves the model server-side"
  );
});

test("the provider-default row is what is ticked when no model is held", () => {
  const groups = buildModelPickerGroups({
    providerModels: { codex: [] },
    providers: ["codex"],
    selectedModel: "",
    selectedProvider: "codex",
  });

  assert.equal(groups[0].options[0].selected, true);
});

test("the chip names provider and model together", () => {
  const chip = selectedModelChip({
    providerModels: CATALOGS,
    selectedModel: "claude-opus-4-6",
    selectedProvider: "claude_code",
  });

  assert.equal(chip.value, "Claude · Opus 4.6");
  assert.equal(chip.tag, "default");
});

test("a non-default model carries no tag", () => {
  const chip = selectedModelChip({
    providerModels: CATALOGS,
    selectedModel: "claude-sonnet-4-5",
    selectedProvider: "claude_code",
  });

  assert.equal(chip.value, "Claude · Sonnet 4.5");
  assert.equal(chip.tag, null);
});

test("an unknown model still shows its id rather than going blank", () => {
  const chip = selectedModelChip({
    providerModels: CATALOGS,
    selectedModel: "some-unfetched-id",
    selectedProvider: "claude_code",
  });

  assert.equal(chip.value, "Claude · some-unfetched-id");
});

test("with no model chosen the chip says so instead of naming a provider alone", () => {
  const chip = selectedModelChip({
    providerModels: CATALOGS,
    selectedModel: "",
    selectedProvider: "claude_code",
  });

  assert.equal(chip.value, "Claude · default");
});

test("a provider the relay does not offer produces no group to pick from", () => {
  // The host repairs the draft; the picker must at least not invent a group for a
  // provider the relay never offered.
  const groups = buildModelPickerGroups({
    providerModels: { fake: [{ model: "fake-echo", display_name: "Fake Echo" }] },
    providers: ["fake"],
    selectedModel: "gpt-5.5",
    selectedProvider: "codex",
  });

  assert.deepEqual(
    groups.map((group) => group.provider),
    ["fake"],
    "only providers the relay offers are listed"
  );
  assert.equal(
    groups.flatMap((group) => group.options).some((option) => option.selected),
    false,
    "and nothing is ticked, because the held selection is not choosable"
  );
});
