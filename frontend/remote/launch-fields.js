import { defaultModelForProvider } from "../shared/provider-settings.js";
import {
  buildReasoningEffortOptionsWithSelection,
  resolveReasoningEffortValue,
} from "../shared/reasoning-efforts.js";

// The new-session dialog shows these and the start request sends them, so what
// the user saw is what starts. Only the draft provider's own catalog is read.
export function remoteLaunchFields({ sessionDraft = {}, provider = "", providerModels = {} } = {}) {
  const models = providerModels?.[provider] || [];
  const model = sessionDraft.model || defaultModelForProvider(provider);
  const effort = resolveReasoningEffortValue(models, model, sessionDraft.effort, provider);
  return {
    fields: { ...sessionDraft, provider, model, effort },
    effortOptions: buildReasoningEffortOptionsWithSelection(models, model, provider, effort),
  };
}
