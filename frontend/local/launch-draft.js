import { launchSeedModel } from "../shared/provider-settings.js";
import { resolveReasoningEffortValue } from "../shared/reasoning-efforts.js";

export function settleLaunchDraft(draft = {}, models = [], provider = "") {
  const model = draft.model || launchSeedModel(provider, models, "");
  return { model, effort: resolveReasoningEffortValue(models, model, draft.effort, provider) };
}
