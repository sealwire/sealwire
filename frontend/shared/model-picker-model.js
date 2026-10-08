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

/** What a ModelPicker takes for one choice: its menu, and the chip naming the pick. */
export function modelPickerProps({
  offerProviderDefault = false,
  providerModels = {},
  providers = [],
  selectedModel = "",
  selectedProvider = "",
} = {}) {
  const chip = selectedModelChip({ providerModels, selectedModel, selectedProvider });
  return {
    groups: buildModelPickerGroups({ offerProviderDefault, providerModels, providers, selectedModel, selectedProvider }),
    provider: selectedProvider,
    value: chip.value,
    valueTitle: chip.title,
  };
}

// The logo beside the chip names the provider, so the text is the model alone.
export function selectedModelChip({
  providerModels = {},
  selectedModel = "",
  selectedProvider = "",
} = {}) {
  const entry = modelEntry(catalogFor(providerModels, selectedProvider), selectedModel);
  const name = selectedModel ? entry?.display_name || selectedModel : DEFAULT_MODEL_LABEL;
  // "OpenCode Zen/" filled the whole chip and left the model itself behind the ellipsis.
  const slash = name.indexOf("/");
  const value = slash > 0 ? name.slice(slash + 1) : name;
  return {
    provider: selectedProvider,
    tag: null,
    ...(value === name ? {} : { title: name }),
    value,
  };
}

/**
 * `openai/gpt-6.1-sol` is line `openai/gpt`, family `gpt`, version [6, 1]; `qwen3.8-max`
 * is family `qwen` at [3, 8], joined with "". Must read ids the way the relay's
 * `model_order.rs` does, or a heading splits what it sorted.
 */
export function modelLine(id) {
  const base = String(id || "").split("[")[0];
  const slash = base.lastIndexOf("/");
  const vendor = slash >= 0 ? base.slice(0, slash) : "";
  // OpenRouter and Bedrock tag a variant after a colon: `:free`, `:batch`, `v1:0`.
  const name = (slash >= 0 ? base.slice(slash + 1) : base).split(":")[0];
  const words = name.split("-");
  let at = -1;
  let found = null;
  for (let index = 0; index < words.length; index += 1) {
    // A date beside a real version cannot be compared with it, and what follows it is date too.
    if (/^\d{4,}$/.test(words[index])) break;
    found = versionOf(words[index], index);
    if (found) {
      at = index;
      break;
    }
  }
  if (!found) {
    return { family: name, joiner: "-", line: base, vendor, version: [] };
  }
  const { letters, version } = found;
  // Claude spells 4.6 as `4-6`.
  for (const word of words.slice(at + 1)) {
    if (!/^\d{1,2}$/.test(word)) break;
    version.push(Number(word));
  }
  const family = [...words.slice(0, at), letters].filter(Boolean).join("-");
  return {
    family,
    joiner: letters ? "" : "-",
    line: vendor ? `${vendor}/${family}` : family,
    vendor,
    version,
  };
}

function versionOf(word, at) {
  const match = /^([A-Za-z]*)(\d+(?:\.\d+)*)$/.exec(word);
  // A bare `o3` or `k3` has no family name to rank it within.
  if (!match || (at === 0 && match[1].length === 1)) return null;
  return { letters: match[1], version: match[2].split(".").map(Number) };
}

function compareVersions(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? -1) - (b[index] ?? -1);
    if (diff) return diff;
  }
  return 0;
}

// "OpenCode Zen/Big Pickle" names its vendor before the slash. Under OpenCode's
// OpenRouter every label starts "OpenRouter/", so the maker comes from the id.
function vendorLabel(option, vendor) {
  const label = String(option.label || "");
  if (!label.includes("/")) return vendor;
  const nested = vendor.indexOf("/");
  return label.slice(0, label.indexOf("/")) + (nested >= 0 ? vendor.slice(nested) : "");
}

// Codex's own list carries three releases (6.1, 6, 5.6); every Gemini 3.x under its
// own heading made seven.
const SHOWN_RELEASES = 3;

const release = ({ version: [major, minor = 0] }) => (minor ? `${major}.${minor}` : `${major}`);

/**
 * One provider's rows as the second level shows them. Each line shows its three newest
 * releases, under a heading each when it is the one line spanning majors; everything
 * else goes to `other`.
 */
export function modelSections(options = []) {
  // The layout depends on ids and labels alone, so a catalogue is grouped once per
  // load; the rows handed back are always this call's, which carry its selection.
  const key = options.map((option) => `${option.value}\u0001${option.label}`).join("\u0000");
  let layout = layoutCache.get(key);
  if (!layout) {
    layout = layOut(options);
    layoutCache.set(key, layout);
    if (layoutCache.size > LAYOUT_CACHE_SIZE) layoutCache.delete(layoutCache.keys().next().value);
  }
  const rows = (indices) => indices.map((index) => options[index]);
  return {
    other: rows(layout.other),
    sections: layout.sections.map((section) => ({ heading: section.heading, options: rows(section.indices) })),
  };
}

// One entry per catalogue a picker has shown this session; a few providers' worth.
const LAYOUT_CACHE_SIZE = 32;
const layoutCache = new Map();

function layOut(options) {
  const parsed = options.map((option, index) => ({ index, option, ...modelLine(option.value) }));
  const lines = new Map();
  for (const entry of parsed) {
    if (!entry.version.length) continue;
    if (!lines.has(entry.line)) lines.set(entry.line, []);
    lines.get(entry.line).push(entry);
  }

  const cut = [];
  for (const entries of lines.values()) {
    const releases = [...new Set(entries.map(release))];
    const spansMajors = new Set(entries.map((entry) => entry.version[0])).size > 1;
    if (!spansMajors && releases.length <= SHOWN_RELEASES) continue;
    // Only a list already sorted newest-first can be cut into sections; anything
    // else would scatter one heading across the menu.
    const contiguous = entries.at(-1).index - entries[0].index === entries.length - 1;
    const descending = entries.every(
      (entry, at) => at === 0 || compareVersions(entries[at - 1].version, entry.version) >= 0
    );
    if (!contiguous || !descending) {
      return { other: [], sections: [{ heading: null, indices: options.map((_, index) => index) }] };
    }
    cut.push({ entries, releases, spansMajors });
  }
  // Release headings suit one line (GPT 6.1 / 6 / 5.6). Opus and Sonnet together made
  // six headings over six rows, nine vendors thirty; there the vendor heads instead.
  const byRelease = cut.filter((line) => line.spansMajors).length === 1;

  const headings = new Map();
  const folded = new Set();
  const settled = new Set();
  const trimmed = [];
  for (const { entries, releases, spansMajors } of cut) {
    const shown = releases.slice(0, SHOWN_RELEASES);
    // Spelled as its first model spells it: qwen-2.5 and qwen3.8 share the line `qwen`.
    const spelled = new Map();
    for (const entry of entries) {
      const key = release(entry);
      if (!spelled.has(key)) spelled.set(key, `${entry.family}${entry.joiner}${key}`);
      settled.add(entry.index);
      if (!shown.includes(key)) folded.add(entry.index);
      else if (spansMajors && byRelease) headings.set(entry.index, spelled.get(key));
    }
    if (releases.length > SHOWN_RELEASES) trimmed.push(entries[0]);
  }
  // Only versionless ids (gpt-4o, o3): a numbered line like claude-opus-5 ranks on its
  // own beside a folding claude-3.5. Unprefixed ids may be aliases like "default".
  const foldsWith = (entry) =>
    !entry.version.length
    && trimmed.some(
      (line) => line.vendor === entry.vendor && (entry.vendor || entry.family.startsWith(`${line.family}-`))
    );
  // OpenRouter lists most models again as `:batch` or `:free`, and dated snapshots sit
  // beside the model or its `-latest` alias; one row each is enough.
  const listed = new Set(options.map((option) => option.value));
  const isCopy = ({ option }) => {
    const base = option.value.replace(/:[^/]*$/, "").replace(/-\d{4,}(-\d{2}){0,2}$/, "");
    return base !== option.value && (listed.has(base) || listed.has(`${base}-latest`));
  };

  // Cursor names no vendor, but claude-, gpt- and gemini- say who made each model.
  // "default" or "sonnet" starts no numbered line, so it stays unheaded.
  const firstWord = (entry) => entry.family.split("-")[0];
  const families = new Set(parsed.filter((entry) => entry.version.length).map(firstWord));
  const byFamily = cut.length > 0 && !byRelease;
  const headingOf = (entry) => {
    if (headings.has(entry.index)) return headings.get(entry.index);
    if (entry.vendor) return vendorLabel(entry.option, entry.vendor);
    return byFamily && families.has(firstWord(entry)) ? firstWord(entry) : null;
  };

  const sections = [];
  const other = [];
  for (const entry of parsed) {
    if (folded.has(entry.index) || isCopy(entry) || (!settled.has(entry.index) && foldsWith(entry))) {
      other.push(entry.index);
      continue;
    }
    const heading = headingOf(entry);
    const last = sections.at(-1);
    if (last && last.heading === heading) {
      last.indices.push(entry.index);
    } else {
      sections.push({ heading, indices: [entry.index] });
    }
  }
  return { other, sections };
}

/** A row's name with the vendor dropped when the heading above it already says it. */
export function labelUnderHeading(label, heading) {
  const text = String(label || "");
  const slash = text.indexOf("/");
  if (!heading || slash <= 0) return text;
  const vendor = text.slice(0, slash);
  // OpenRouter's heading is "OpenRouter/anthropic" over rows labelled "OpenRouter/…".
  return heading === vendor || heading.startsWith(`${vendor}/`) ? text.slice(slash + 1) : text;
}

/**
 * Typed text filters every provider's real models, folded ones too. Each word has to
 * match the model's name, its id or the provider's name: "opencode gpt-6".
 */
export function searchModelOptions(groups = [], query = "") {
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return groups.flatMap((group) =>
    group.options
      .filter((option) => option.value && !group.direct)
      .filter((option) => {
        const text = `${group.label || ""} ${option.label || ""} ${option.value}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .map((option) => ({ ...option, provider: option.provider || group.provider }))
  );
}
