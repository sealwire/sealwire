const DEFAULT_REASONING_EFFORTS = ["medium", "low", "high", "xhigh"];

function formatReasoningEffortLabel(value) {
  return value || "medium";
}

export function findModelOption(models = [], modelName = "") {
  return (models || []).find((model) => model.model === modelName) || null;
}

export function buildReasoningEffortOptions(models = [], modelName = "") {
  const model = findModelOption(models, modelName);
  const supportedEfforts = model?.supported_reasoning_efforts?.length
    ? [...model.supported_reasoning_efforts]
    : [...DEFAULT_REASONING_EFFORTS];

  return supportedEfforts.map((effort) => ({
    label: formatReasoningEffortLabel(effort),
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
