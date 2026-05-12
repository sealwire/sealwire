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
