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
  const supportedEfforts = [...(knownEfforts(models, model, provider) || DEFAULT_REASONING_EFFORTS)];
  const labelProvider = provider || modelProvider(models, modelName);

  return supportedEfforts.map((effort) => ({
    label: formatEffortLabel(effort, labelProvider),
    value: effort,
  }));
}

// What this model is known to accept, or null when the catalog cannot say.
function knownEfforts(models, model, provider = "") {
  if (model?.supported_reasoning_efforts?.length) return model.supported_reasoning_efforts;
  // Until OpenCode's native variants arrive, only offer its default sentinel.
  const isOpenCode = provider === "opencode" || model?.provider === "opencode"
    || (models.length > 0 && models.every((row) => row.provider === "opencode"));
  return isOpenCode ? ["default"] : null;
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

// Resolve the reasoning effort to SEND for an existing session.
//
// Order: an explicit composer override, then the session's LIVE effort (what the
// UI shows), then the per-provider last-used memory. The last-used memory only
// seeds new sessions, so it must never override the live session effort — and a
// stale/foreign value there (e.g. a "max" historically mis-bucketed under codex)
// must never be forwarded to a provider that would reject it (HTTP 400).
//
// The chosen value is dropped to the model default ONLY when the model is known
// and provably does not support it. An empty/stale catalog (no supported list)
// leaves it untouched, so a legitimate provider-specific effort like Claude's
// "max" survives rather than being wrongly downgraded.
export function resolveOutgoingEffort({
  override = "",
  sessionEffort = "",
  lastUsedEffort = "",
  models = [],
  model = "",
} = {}) {
  const pick =
    String(override || "").trim() ||
    String(sessionEffort || "").trim() ||
    String(lastUsedEffort || "").trim() ||
    "";
  if (!pick) return pick;
  const option = findModelOption(models, model);
  const supported = option?.supported_reasoning_efforts;
  if (Array.isArray(supported) && supported.length && !supported.includes(pick)) {
    return option?.default_reasoning_effort || supported[0];
  }
  return pick;
}

// Clamps only against efforts the catalog knows. A cold or partial catalog keeps
// the pick, so Claude's `max` or Codex's `minimal` is not rewritten to `low`.
export function resolveReasoningEffortValue(models = [], modelName = "", selectedEffort = "", provider = "") {
  const model = findModelOption(models, modelName);
  const known = knownEfforts(models, model, provider);
  if (selectedEffort && (!known || known.includes(selectedEffort))) {
    return selectedEffort;
  }

  return model?.default_reasoning_effort || (known || DEFAULT_REASONING_EFFORTS)[0] || "medium";
}
