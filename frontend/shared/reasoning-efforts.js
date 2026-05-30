import { formatEffortLabel } from "./provider-settings.js";

const DEFAULT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];

function modelProvider(models, modelName) {
  return findModelOption(models, modelName)?.agent_provider
    || findModelOption(models, modelName)?.provider_key
    || "";
}

export function findModelOption(models = [], modelName = "") {
  return (models || []).find((model) => model.model === modelName) || null;
}

export function buildReasoningEffortOptions(models = [], modelName = "", provider = "") {
  const model = findModelOption(models, modelName);
  const supportedEfforts = model?.supported_reasoning_efforts?.length
    ? [...model.supported_reasoning_efforts]
    : [...DEFAULT_REASONING_EFFORTS];
  const labelProvider = provider || modelProvider(models, modelName);

  return supportedEfforts.map((effort) => ({
    label: formatEffortLabel(effort, labelProvider),
    value: effort,
  }));
}

// Like buildReasoningEffortOptions, but guarantees the currently-selected
// effort stays in the list. The catalog can be empty or stale (e.g. right
// after a restart, or when list_models intermittently fails), in which case
// the default option set omits provider-specific values like Claude's "max" —
// and the segmented control would then show the user's selection as gone.
// Keeping it present means the selection is always visible and re-submittable.
export function buildReasoningEffortOptionsWithSelection(
  models = [],
  modelName = "",
  provider = "",
  selectedEffort = ""
) {
  const options = buildReasoningEffortOptions(models, modelName, provider);
  if (selectedEffort && !options.some((option) => option.value === selectedEffort)) {
    options.push({ label: formatEffortLabel(selectedEffort, provider), value: selectedEffort });
  }
  return options;
}

export function resolveReasoningEffortValue(models = [], modelName = "", selectedEffort = "") {
  const model = findModelOption(models, modelName);
  const supportedEfforts = model?.supported_reasoning_efforts?.length
    ? model.supported_reasoning_efforts
    : DEFAULT_REASONING_EFFORTS;

  if (selectedEffort && supportedEfforts.includes(selectedEffort)) {
    return selectedEffort;
  }

  return model?.default_reasoning_effort || supportedEfforts[0] || "medium";
}
