// One menu grouped by provider, so an option cannot name a model without also
// naming the catalogue it came from — the pair can never go inconsistent.

import { buildModelSelectOptions } from "./composer.js";
import { providerLabel } from "./provider-labels.js";
import { providerPicksFolderDefaultModel } from "./provider-settings.js";

// Naming a concrete model here would claim a choice the request does not carry.
const DEFAULT_MODEL_LABEL = "Default";

function catalogFor(providerModels, provider) {
  return providerModels?.[provider] || [];
}

function modelEntry(models, model) {
  return (models || []).find((entry) => entry?.model === model) || null;
}

export function buildModelPickerGroups({
  // A launch's empty model means "the provider decides"; a fork's means "inherit".
  offerProviderDefault = false,
  providerModels = {},
  providers = [],
  selectedModel = "",
  selectedProvider = "",
} = {}) {
  // The provider list is its own round trip and can be missing while a catalogue
  // is not. Zero groups is the one state with no row to click: it paints as a bare
  // strip under the pill. Offer the provider the draft is already on instead.
  const sections = providers?.length
    ? providers
    : [selectedProvider].filter(Boolean);

  return sections.map((provider) => {
    const models = catalogFor(providerModels, provider);
    const isSelectedProvider = provider === selectedProvider;
    // Only the SELECTED provider's group: passing it to every group would surface
    // a Claude id under Codex and tick two rows for one choice.
    const { options } = buildModelSelectOptions(
      models,
      isSelectedProvider ? selectedModel : "",
      { allowForeign: true }
    );

    // The catalog's default is only the default of the folder it was read in.
    const folderDefault = providerPicksFolderDefaultModel(provider);
    const rendered = options.map((option) => ({
      label: option.display_name || option.model,
      provider,
      selected: isSelectedProvider && option.model === selectedModel,
      tag: option.is_default && !folderDefault ? "default" : null,
      value: option.model,
    }));
    const providerDefault = {
      label: "Use provider default",
      provider,
      selected: isSelectedProvider && !selectedModel,
      tag: null,
      value: "",
    };
    if (folderDefault && offerProviderDefault && rendered.length) {
      rendered.unshift({ ...providerDefault, label: "Default for this folder" });
    }
    const shown = rendered.length ? rendered : [providerDefault];
    const chosen = shown.find((option) => option.selected);
    const fallback = folderDefault ? null : rendered.find((option) => option.tag === "default");

    return {
      // A cold catalogue still gets a CHOOSABLE row carrying an empty model id:
      // zero options read as "offered but disabled" and stranded the user.
      // buildModelSelectOptions keeps a selected foreign id visible even when
      // the real catalog is empty. That safety row is not evidence that the
      // catalog loaded: mark the section unavailable so a one-row menu never
      // masquerades as the complete model list.
      empty: models.length === 0,
      hint: chosen?.value ? chosen.label : chosen ? DEFAULT_MODEL_LABEL : fallback?.label || DEFAULT_MODEL_LABEL,
      label: providerLabel(provider),
      options: shown,
      provider,
    };
  });
}

// The logo beside the chip names the provider, so the text is the model alone.
export function selectedModelChip({
  providerModels = {},
  selectedModel = "",
  selectedProvider = "",
} = {}) {
  const entry = modelEntry(catalogFor(providerModels, selectedProvider), selectedModel);
  return {
    provider: selectedProvider,
    tag: null,
    value: selectedModel ? entry?.display_name || selectedModel : DEFAULT_MODEL_LABEL,
  };
}

/**
 * `openai/gpt-6.1-sol` is line `openai/gpt`, family `gpt`, version [6, 1]. Must read
 * ids the way the relay's `model_order.rs` does, or a heading splits what it sorted.
 */
export function modelLine(id) {
  const base = String(id || "").split("[")[0];
  const slash = base.lastIndexOf("/");
  const vendor = slash >= 0 ? base.slice(0, slash) : "";
  const name = slash >= 0 ? base.slice(slash + 1) : base;
  const words = name.split("-");
  const at = words.findIndex((word) => versionOf(word));
  if (at < 0) {
    return { family: name, line: base, vendor, version: [] };
  }
  const version = versionOf(words[at]);
  // Claude spells 4.6 as `4-6`. Longer numbers are dates.
  for (const word of words.slice(at + 1)) {
    if (!/^\d{1,2}$/.test(word)) break;
    version.push(Number(word));
  }
  const family = words.slice(0, at).join("-");
  return { family, line: vendor ? `${vendor}/${family}` : family, vendor, version };
}

function versionOf(word) {
  const digits = word.startsWith("v") ? word.slice(1) : word;
  return /^\d+(\.\d+)*$/.test(digits) ? digits.split(".").map(Number) : null;
}

function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff) return diff;
  }
  return 0;
}

// "OpenCode Zen/Big Pickle" names its vendor before the slash.
function vendorLabel(option, vendor) {
  const label = String(option.label || "");
  return label.includes("/") ? label.slice(0, label.indexOf("/")) : vendor;
}

/**
 * One provider's rows as the second level shows them: a line that spans several
 * generations gets a heading for its newest major and for the last point release
 * before it, and the rest of that line folds into `older`.
 */
export function modelSections(options = []) {
  const parsed = options.map((option, index) => ({ index, option, ...modelLine(option.value) }));
  const lines = new Map();
  for (const entry of parsed) {
    if (!entry.version.length) continue;
    if (!lines.has(entry.line)) lines.set(entry.line, []);
    lines.get(entry.line).push(entry);
  }

  const placed = new Map();
  for (const entries of lines.values()) {
    const newest = Math.max(...entries.map((entry) => entry.version[0]));
    const generation = (entry) =>
      entry.version[0] === newest ? `${newest}` : `${entry.version[0]}.${entry.version[1] ?? 0}`;
    const generations = [...new Set(entries.map(generation))];
    if (generations.length < 2) continue;
    // Only a list already sorted newest-first can be cut into sections; anything
    // else would scatter one heading across the menu.
    const contiguous = entries.at(-1).index - entries[0].index === entries.length - 1;
    const descending = entries.every(
      (entry, at) => at === 0 || compareVersions(entries[at - 1].version, entry.version) >= 0
    );
    if (!contiguous || !descending) {
      return { older: [], sections: [{ heading: null, options }] };
    }
    const open = generations.slice(0, 2);
    for (const entry of entries) {
      const key = generation(entry);
      placed.set(entry.index, open.includes(key) ? `${entry.family}-${key}` : null);
    }
  }

  const sections = [];
  const older = [];
  for (const entry of parsed) {
    let heading = null;
    if (placed.has(entry.index)) {
      heading = placed.get(entry.index);
      if (heading === null) {
        older.push(entry.option);
        continue;
      }
    } else if (entry.vendor) {
      heading = vendorLabel(entry.option, entry.vendor);
    }
    const last = sections.at(-1);
    if (last && last.heading === heading) {
      last.options.push(entry.option);
    } else {
      sections.push({ heading, options: [entry.option] });
    }
  }
  return { older, sections };
}

/** Typed text matches any provider's real models, by name or id, older ones too. */
export function searchModelOptions(groups = [], query = "") {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  return groups.flatMap((group) =>
    group.options
      .filter((option) => option.value && !group.direct)
      .filter(
        (option) =>
          String(option.label || "").toLowerCase().includes(needle)
          || String(option.value).toLowerCase().includes(needle)
      )
      .map((option) => ({ ...option, provider: option.provider || group.provider }))
  );
}
