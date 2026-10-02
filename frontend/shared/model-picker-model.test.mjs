import test from "node:test";
import assert from "node:assert/strict";

import {
  buildModelPickerGroups,
  modelSections,
  searchModelOptions,
  selectedModelChip,
} from "./model-picker-model.js";

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

test("an unknown model still shows its id rather than going blank", () => {
  const chip = selectedModelChip({
    providerModels: CATALOGS,
    selectedModel: "some-unfetched-id",
    selectedProvider: "claude_code",
  });

  assert.equal(chip.value, "some-unfetched-id");
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

test("OpenCode's menu offers its folder default and tags no catalog model as default", () => {
  // The catalog's default belongs to the folder it was discovered in, not the new session's.
  const groups = buildModelPickerGroups({
    offerProviderDefault: true,
    providerModels: {
      opencode: [
        { model: "test/echo", display_name: "Echo", is_default: true },
        { model: "test/second", display_name: "Second" },
      ],
    },
    providers: ["opencode"],
    selectedModel: "",
    selectedProvider: "opencode",
  });
  assert.deepEqual(
    groups[0].options.map((option) => [option.value, option.tag, option.selected]),
    [["", null, true], ["test/echo", null, false], ["test/second", null, false]]
  );
  assert.equal(
    selectedModelChip({
      providerModels: { opencode: [{ model: "test/echo", display_name: "Echo", is_default: true }] },
      selectedModel: "test/echo",
      selectedProvider: "opencode",
    }).tag,
    null
  );
});

// --- two-level picker: sections inside one provider ---------------------------------

const option = (value, label = value) => ({ label, provider: "x", selected: false, tag: null, value });
const shape = ({ sections, older }) => ({
  sections: sections.map((section) => [section.heading, section.options.map((o) => o.value)]),
  older: older.map((o) => o.value),
});

test("Codex splits into the current generation, the last point release, and Older", () => {
  // The design's own example: GPT-6.1 sits with GPT-6, GPT-5.6 is its own group.
  assert.deepEqual(
    shape(
      modelSections(
        ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].map(
          (id) => option(id)
        )
      )
    ),
    {
      sections: [
        ["gpt-6", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]],
        ["gpt-5.6", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]],
      ],
      older: ["gpt-5.5"],
    }
  );
});

test("OpenCode keeps a vendor's one-off models under the vendor's name, not in Older", () => {
  // Older is per line: Zen's single models are not "older GPT", and big-pickle is
  // OpenCode's own default, so folding it away would hide the usual pick.
  const result = modelSections([
    option("", "Default for this folder"),
    option("openai/gpt-6.1-sol", "OpenAI/GPT-6.1 Sol"),
    option("openai/gpt-6-luna", "OpenAI/GPT-6 Luna"),
    option("openai/gpt-5.6-sol", "OpenAI/GPT-5.6 Sol"),
    option("openai/gpt-5.5", "OpenAI/GPT-5.5"),
    option("openai/gpt-5.4-mini", "OpenAI/GPT-5.4 mini"),
    option("opencode/big-pickle", "OpenCode Zen/Big Pickle"),
    option("opencode/nemotron-3.5-lightning-free", "OpenCode Zen/Nemotron 3.5 Lightning Free"),
    option("opencode/nemotron-3-ultra-free", "OpenCode Zen/Nemotron 3 Ultra Free"),
  ]);
  assert.deepEqual(shape(result), {
    sections: [
      [null, [""]],
      ["gpt-6", ["openai/gpt-6.1-sol", "openai/gpt-6-luna"]],
      ["gpt-5.6", ["openai/gpt-5.6-sol"]],
      [
        "OpenCode Zen",
        ["opencode/big-pickle", "opencode/nemotron-3.5-lightning-free", "opencode/nemotron-3-ultra-free"],
      ],
    ],
    older: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
  });
});

test("a short list with no line spanning generations stays flat (Claude)", () => {
  assert.deepEqual(
    shape(modelSections(["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"].map((id) => option(id)))),
    { sections: [[null, ["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"]]], older: [] }
  );
});

test("a list whose versions are not in order stays flat rather than half-grouped (Cursor)", () => {
  // Cursor's order is its own recommendation; grouping it would scatter one heading
  // across the menu and fold a model the provider put near the top.
  assert.deepEqual(
    shape(
      modelSections(
        ["default[]", "claude-opus-5[x=1]", "gpt-5.6-sol[r=1]", "claude-opus-4-6[x=1]", "claude-opus-4-8[x=1]"].map(
          (id) => option(id)
        )
      )
    ),
    {
      sections: [[null, ["default[]", "claude-opus-5[x=1]", "gpt-5.6-sol[r=1]", "claude-opus-4-6[x=1]", "claude-opus-4-8[x=1]"]]],
      older: [],
    }
  );
});

test("each provider row says which model it would run", () => {
  const groups = buildModelPickerGroups({
    providerModels: { ...CATALOGS, opencode: [{ model: "opencode/big-pickle", display_name: "Big Pickle", is_default: true }] },
    providers: [...PROVIDERS, "opencode", "cursor"],
    selectedModel: "gpt-5-codex",
    selectedProvider: "codex",
  });
  assert.deepEqual(
    groups.map((group) => [group.provider, group.hint]),
    [
      ["claude_code", "Opus 4.6"],
      ["codex", "GPT-5 Codex"],
      // A catalogue default is only the default of the folder it was read in.
      ["opencode", "Default"],
      ["cursor", "Default"],
    ]
  );
});

test("the chip names the model alone; the provider is the logo beside it", () => {
  assert.deepEqual(
    selectedModelChip({ providerModels: CATALOGS, selectedModel: "claude-opus-4-6", selectedProvider: "claude_code" }),
    { provider: "claude_code", tag: null, value: "Opus 4.6" }
  );
  assert.equal(
    selectedModelChip({ providerModels: CATALOGS, selectedModel: "", selectedProvider: "codex" }).value,
    "Default"
  );
});

test("typing searches every provider's models, older ones included", () => {
  const groups = buildModelPickerGroups({
    providerModels: { ...CATALOGS, opencode: [{ model: "openai/gpt-5.5", display_name: "OpenAI/GPT-5.5" }] },
    providers: [...PROVIDERS, "opencode"],
    selectedModel: "",
    selectedProvider: "codex",
  });
  assert.deepEqual(
    searchModelOptions(groups, "5.5").map((option) => [option.provider, option.value]),
    [
      ["codex", "gpt-5.5"],
      ["opencode", "openai/gpt-5.5"],
    ]
  );
  assert.deepEqual(
    searchModelOptions(groups, "SONNET").map((option) => option.value),
    ["claude-sonnet-4-5"]
  );
});
