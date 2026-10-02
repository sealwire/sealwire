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
const shape = ({ sections, other }) => ({
  sections: sections.map((section) => [section.heading, section.options.map((o) => o.value)]),
  other: other.map((o) => o.value),
});

test("Codex shows its three newest releases, each under its own heading, and folds the rest", () => {
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
        ["gpt-6.1", ["gpt-6.1-sol"]],
        ["gpt-6", ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]],
        ["gpt-5.6", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]],
      ],
      other: ["gpt-5.5"],
    }
  );
});

test("a line with many releases shows only its newest three, headed or not (Gemini, Grok)", () => {
  // Every Gemini 3.x under its own heading made seven; a line inside one major
  // (Grok 4.x) gets no headings but is cut the same way.
  const ids = [
    "google/gemini-3.8-flash",
    "google/gemini-3.7-flash",
    "google/gemini-3.6-flash",
    "google/gemini-3.5-flash",
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-pro",
    "xai/grok-4.7",
    "xai/grok-4.6",
    "xai/grok-4.5",
    "xai/grok-4.3",
  ];
  assert.deepEqual(shape(modelSections(ids.map((id) => option(id)))), {
    sections: [
      ["gemini-3.8", ["google/gemini-3.8-flash"]],
      ["gemini-3.7", ["google/gemini-3.7-flash"]],
      ["gemini-3.6", ["google/gemini-3.6-flash"]],
      ["xai", ["xai/grok-4.7", "xai/grok-4.6", "xai/grok-4.5"]],
    ],
    other: ["google/gemini-3.5-flash", "google/gemini-3.1-pro-preview", "google/gemini-2.5-pro", "xai/grok-4.3"],
  });
});

test("when more than one line would get release headings, the headings name the vendor", () => {
  // Nine vendors at once made thirty release headings over fifty-eight rows.
  const ids = [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-opus-4-7",
    "google/gemini-3.8-flash",
    "openai/gpt-6.1-sol",
    "openai/gpt-6-sol",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.5",
  ];
  assert.deepEqual(shape(modelSections(ids.map((id) => option(id)))), {
    sections: [
      ["anthropic", ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5", "anthropic/claude-opus-4-8"]],
      ["google", ["google/gemini-3.8-flash"]],
      ["openai", ["openai/gpt-6.1-sol", "openai/gpt-6-sol", "openai/gpt-5.6-sol"]],
    ],
    other: ["anthropic/claude-opus-4-7", "openai/gpt-5.5"],
  });
});

test("a vendor nested under OpenCode's OpenRouter keeps its maker in the heading", () => {
  const rows = [
    option("openrouter/anthropic/claude-opus-5", "OpenRouter/Claude Opus 5"),
    option("openrouter/google/gemini-3.8-flash", "OpenRouter/Gemini 3.8 Flash"),
    option("openrouter/openai/gpt-6-sol", "OpenRouter/GPT-6 Sol"),
  ];
  assert.deepEqual(
    shape(modelSections(rows)).sections.map(([heading]) => heading),
    ["OpenRouter/anthropic", "OpenRouter/google", "OpenRouter/openai"]
  );
});

test("one vendor with two headed lines (Opus and Sonnet) gets one heading, not six", () => {
  const ids = [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-sonnet-4-6",
  ];
  assert.deepEqual(shape(modelSections(ids.map((id) => option(id)))), {
    sections: [["anthropic", ids]],
    other: [],
  });
});

test("OpenCode keeps a vendor's one-off models in view under the vendor's name", () => {
  // Zen's single models are not old GPTs, and big-pickle is OpenCode's own default.
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
      ["gpt-6.1", ["openai/gpt-6.1-sol"]],
      ["gpt-6", ["openai/gpt-6-luna"]],
      ["gpt-5.6", ["openai/gpt-5.6-sol"]],
      [
        "OpenCode Zen",
        ["opencode/big-pickle", "opencode/nemotron-3.5-lightning-free", "opencode/nemotron-3-ultra-free"],
      ],
    ],
    other: ["openai/gpt-5.5", "openai/gpt-5.4-mini"],
  });
});

test("Pi folds OpenAI's models with no version to rank (4o, o3) with the older GPTs", () => {
  // In view while GPT-5.5 is folded, they would read as newer than it. Realtime 2.1
  // carries its own version, so it stays like any other current line.
  const pi = (id, name) => option(`openai/${id}`, `${name} · openai`);
  const result = modelSections([
    option("", "Default for this folder"),
    pi("gpt-6.1-sol", "GPT-6.1 Sol"),
    pi("gpt-6-sol", "GPT-6 Sol"),
    pi("gpt-5.6-sol", "GPT-5.6 Sol"),
    pi("gpt-5.5", "GPT-5.5"),
    pi("gpt-4o-2024-11-20", "GPT-4o (2024-11-20)"),
    pi("gpt-4o", "GPT-4o"),
    pi("gpt-daybreak-blue-latest", "Daybreak Blue"),
    pi("gpt-realtime-2.1", "GPT-Realtime-2.1"),
    pi("o3", "o3"),
    pi("o4-mini", "o4-mini"),
  ]);
  assert.deepEqual(shape(result), {
    sections: [
      [null, [""]],
      ["gpt-6.1", ["openai/gpt-6.1-sol"]],
      ["gpt-6", ["openai/gpt-6-sol"]],
      ["gpt-5.6", ["openai/gpt-5.6-sol"]],
      ["openai", ["openai/gpt-realtime-2.1"]],
    ],
    other: [
      "openai/gpt-5.5",
      "openai/gpt-4o-2024-11-20",
      "openai/gpt-4o",
      "openai/gpt-daybreak-blue-latest",
      "openai/o3",
      "openai/o4-mini",
    ],
  });
});

test("a vendor's other numbered line, and unprefixed aliases, stay in view", () => {
  // Sonnet 4.6 is current even while Opus 4.1 folds. Without a vendor prefix,
  // "default" and "sonnet" cannot be tied to the folding line at all.
  assert.deepEqual(
    shape(
      modelSections(
        [
          "anthropic/claude-opus-5",
          "anthropic/claude-opus-4-6",
          "anthropic/claude-opus-4-5",
          "anthropic/claude-opus-4-1",
          "anthropic/claude-sonnet-4-6",
        ].map((id) => option(id))
      )
    ),
    {
      sections: [
        ["claude-opus-5", ["anthropic/claude-opus-5"]],
        ["claude-opus-4.6", ["anthropic/claude-opus-4-6"]],
        ["claude-opus-4.5", ["anthropic/claude-opus-4-5"]],
        ["anthropic", ["anthropic/claude-sonnet-4-6"]],
      ],
      other: ["anthropic/claude-opus-4-1"],
    }
  );
  assert.deepEqual(
    shape(
      modelSections(
        ["default", "claude-fable-6", "claude-fable-5-1", "claude-fable-4", "claude-fable-3", "sonnet"].map((id) => option(id))
      )
    ),
    {
      sections: [
        [null, ["default"]],
        ["claude-fable-6", ["claude-fable-6"]],
        ["claude-fable-5.1", ["claude-fable-5-1"]],
        ["claude-fable-4", ["claude-fable-4"]],
        [null, ["sonnet"]],
      ],
      other: ["claude-fable-3"],
    }
  );
});

test("an old-style claude-3.5 line folding does not take claude-opus-5 with it", () => {
  // OpenCode's Helicone lists both namings; Opus 5 is a numbered line of its own.
  const ids = ["claude-4", "claude-3.7", "claude-3.5", "claude-3", "claude-2.1", "claude-opus-5", "claude-sonnet-4.6"];
  assert.deepEqual(shape(modelSections(ids.map((id) => option(id)))), {
    sections: [
      ["claude-4", ["claude-4"]],
      ["claude-3.7", ["claude-3.7"]],
      ["claude-3.5", ["claude-3.5"]],
      [null, ["claude-opus-5", "claude-sonnet-4.6"]],
    ],
    other: ["claude-3", "claude-2.1"],
  });
});

test("a version glued to the name (qwen3.8) or followed by a :tag still ranks", () => {
  // The relay has already sorted this; until qwen3.8 read as 3.8, every Qwen 3 model
  // was folded away.
  const or = (id) => option(`openrouter/${id}`);
  assert.deepEqual(
    shape(
      modelSections([
        or("qwen/qwen3.8-flash"),
        or("qwen/qwen3.7-max"),
        or("qwen/qwen3.5-plus-02-15"),
        or("qwen/qwen-2.5-72b-instruct"),
        or("qwen/qwen-plus"),
      ])
    ),
    {
      sections: [
        ["qwen3.8", ["openrouter/qwen/qwen3.8-flash"]],
        ["qwen3.7", ["openrouter/qwen/qwen3.7-max"]],
        ["qwen3.5", ["openrouter/qwen/qwen3.5-plus-02-15"]],
      ],
      other: ["openrouter/qwen/qwen-2.5-72b-instruct", "openrouter/qwen/qwen-plus"],
    }
  );
  assert.deepEqual(
    shape(
      modelSections([
        or("anthropic/claude-opus-5"),
        or("anthropic/claude-opus-4.8"),
        or("anthropic/claude-opus-4.7"),
        or("anthropic/claude-opus-4.6:batch"),
      ])
    ).other,
    ["openrouter/anthropic/claude-opus-4.6:batch"]
  );
});

test("a :batch or :free copy folds when the model itself is listed", () => {
  // OpenRouter lists most models twice or three times over; one row each is enough.
  const ids = [
    "openrouter/openai/gpt-6-sol",
    "openrouter/openai/gpt-6-sol:batch",
    "openrouter/google/gemma-4-31b-it:free",
    "openrouter/google/gemma-4-31b-it",
    "openrouter/apodex/apodex-1.1-mini:free",
  ];
  // Pi's labels carry no slash, so the heading is the vendor part of the id.
  assert.deepEqual(shape(modelSections(ids.map((id) => option(id, id.split("/").pop())))), {
    sections: [
      ["openrouter/openai", ["openrouter/openai/gpt-6-sol"]],
      ["openrouter/google", ["openrouter/google/gemma-4-31b-it"]],
      ["openrouter/apodex", ["openrouter/apodex/apodex-1.1-mini:free"]],
    ],
    other: ["openrouter/openai/gpt-6-sol:batch", "openrouter/google/gemma-4-31b-it:free"],
  });
});

test("a dated snapshot folds when its model or its -latest alias is listed", () => {
  const ids = [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-haiku-4-5-20251001",
    "mistral/mistral-large-2411",
    "mistral/mistral-large-2512",
    "mistral/mistral-large-latest",
    "mistral/devstral-small-2505",
  ];
  assert.deepEqual(shape(modelSections(ids.map((id) => option(id)))), {
    sections: [
      ["anthropic", ["anthropic/claude-haiku-4-5"]],
      ["mistral", ["mistral/mistral-large-latest", "mistral/devstral-small-2505"]],
    ],
    other: ["anthropic/claude-haiku-4-5-20251001", "mistral/mistral-large-2411", "mistral/mistral-large-2512"],
  });
});

test("a dated id is not ranked against a numbered one (Mistral)", () => {
  // As 2604 > 3, mistral-medium-3.5 folded as if it were older than the dated ones.
  const ids = ["mistral/mistral-medium-2604", "mistral/mistral-medium-2508", "mistral/mistral-medium-3.5"];
  assert.deepEqual(shape(modelSections(ids.map((id) => option(id)))), {
    sections: [["mistral", ids]],
    other: [],
  });
});

test("a short list with no line spanning generations stays flat (Claude)", () => {
  assert.deepEqual(
    shape(modelSections(["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"].map((id) => option(id)))),
    { sections: [[null, ["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"]]], other: [] }
  );
});

test("Cursor's unprefixed ids group by their first word once the relay has sorted them", () => {
  // Cursor names no vendor, but claude-, gpt- and gemini- say who made each model.
  const ids = [
    "default[]",
    "grok-4.7[fast=true]",
    "grok-4.6[fast=true]",
    "composer-2.5[fast=true]",
    "claude-opus-5-5[effort=medium]",
    "claude-opus-5[thinking=true]",
    "claude-opus-4-8[thinking=true]",
    "claude-opus-4-7[thinking=true]",
    "claude-fable-5-1[thinking=true]",
    "claude-sonnet-5-5[effort=high]",
    "claude-sonnet-4-6[thinking=true]",
    "gpt-5.6-sol[reasoning=medium]",
    "gpt-5.5[reasoning=medium]",
    "gpt-5.4[reasoning=medium]",
    "gpt-5.3-codex[reasoning=medium]",
    "glm-5.2[reasoning=high]",
    "glm-5p3[reasoning=high]",
  ];
  assert.deepEqual(shape(modelSections(ids.map((id) => option(id)))), {
    sections: [
      [null, ["default[]"]],
      ["grok", ["grok-4.7[fast=true]", "grok-4.6[fast=true]"]],
      ["composer", ["composer-2.5[fast=true]"]],
      [
        "claude",
        [
          "claude-opus-5-5[effort=medium]",
          "claude-opus-5[thinking=true]",
          "claude-opus-4-8[thinking=true]",
          "claude-fable-5-1[thinking=true]",
          "claude-sonnet-5-5[effort=high]",
          "claude-sonnet-4-6[thinking=true]",
        ],
      ],
      ["gpt", ["gpt-5.6-sol[reasoning=medium]", "gpt-5.5[reasoning=medium]", "gpt-5.4[reasoning=medium]"]],
      ["glm", ["glm-5.2[reasoning=high]", "glm-5p3[reasoning=high]"]],
    ],
    other: ["claude-opus-4-7[thinking=true]", "gpt-5.3-codex[reasoning=medium]"],
  });
});

test("a catalogue's grouping is reused, but every call gets its own rows back", () => {
  const ids = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.5"];
  modelSections(ids.map((id) => ({ ...option(id), selected: id === "gpt-6-sol" })));
  const again = ids.map((id) => ({ ...option(id), selected: id === "gpt-5.5" }));
  const reused = modelSections(again);
  assert.equal(reused.other[0], again[3], "this call's row, so the new tick shows");
  assert.equal(reused.sections[1].options[0], again[1]);

  const reloaded = modelSections(["gpt-6.2-sol", ...ids].map((id) => option(id)));
  assert.deepEqual(
    reloaded.sections.map((section) => section.heading),
    ["gpt-6.2", "gpt-6.1", "gpt-6"],
    "a reload that adds a release is grouped afresh"
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
      other: [],
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

test("every search word has to match, and a provider's own name counts", () => {
  const groups = buildModelPickerGroups({
    providerModels: { ...CATALOGS, opencode: [{ model: "openai/gpt-5.5", display_name: "OpenAI/GPT-5.5" }] },
    providers: [...PROVIDERS, "opencode"],
    selectedModel: "",
    selectedProvider: "codex",
  });
  const found = (query) => searchModelOptions(groups, query).map((option) => [option.provider, option.value]);
  assert.deepEqual(found("opencode"), [["opencode", "openai/gpt-5.5"]]);
  assert.deepEqual(found("codex  5.5"), [["codex", "gpt-5.5"]]);
  assert.deepEqual(found("opencode sonnet"), []);
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
