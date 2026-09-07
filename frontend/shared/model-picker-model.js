// One menu grouped by provider, so an option cannot name a model without also
// naming the catalogue it came from — the pair can never go inconsistent.

import { buildModelSelectOptions } from "./composer.js";
import { providerLabel } from "./provider-labels.js";

// Naming a concrete model here would claim a choice the request does not carry.
const DEFAULT_MODEL_LABEL = "default";

function catalogFor(providerModels, provider) {
  return providerModels?.[provider] || [];
}

function modelEntry(models, model) {
  return (models || []).find((entry) => entry?.model === model) || null;
}

export function buildModelPickerGroups({
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

    const rendered = options.map((option) => ({
      label: option.display_name || option.model,
      provider,
      selected: isSelectedProvider && option.model === selectedModel,
      tag: option.is_default ? "default" : null,
      value: option.model,
    }));

    return {
      // A cold catalogue still gets a CHOOSABLE row carrying an empty model id:
      // zero options read as "offered but disabled" and stranded the user.
      // buildModelSelectOptions keeps a selected foreign id visible even when
      // the real catalog is empty. That safety row is not evidence that the
      // catalog loaded: mark the section unavailable so a one-row menu never
      // masquerades as the complete model list.
      empty: models.length === 0,
      label: providerLabel(provider),
      options: rendered.length
        ? rendered
        : [
            {
              label: "Use provider default",
              provider,
              selected: isSelectedProvider && !selectedModel,
              tag: null,
              value: "",
            },
          ],
      provider,
    };
  });
}

// After the merge this pill is the only thing naming the provider, so it says both.
export function selectedModelChip({
  providerModels = {},
  selectedModel = "",
  selectedProvider = "",
} = {}) {
  const name = providerLabel(selectedProvider);
  const entry = modelEntry(catalogFor(providerModels, selectedProvider), selectedModel);
  const modelText = selectedModel
    ? entry?.display_name || selectedModel
    : DEFAULT_MODEL_LABEL;

  return {
    tag: entry?.is_default ? "default" : null,
    value: name ? `${name} · ${modelText}` : modelText,
  };
}
