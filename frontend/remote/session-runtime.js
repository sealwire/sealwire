import {
  buildReasoningEffortOptions,
  resolveReasoningEffortValue,
} from "../shared/reasoning-efforts.js";

export function deriveSessionRuntime({
  composerDraft = "",
  composerEffort = "medium",
  composerModel = "",
  sendPending = false,
  session,
  sessionView,
}) {
  const currentModelValue = composerModel || session?.model || "";
  const currentEffortValue = resolveReasoningEffortValue(
    session?.available_models || [],
    currentModelValue,
    composerEffort
  );
  return {
    composerDisabled: sessionView.composerDisabled,
    currentDraft: composerDraft,
    currentApprovalId: sessionView.currentApprovalId,
    currentEffortValue,
    currentModelValue,
    effortOptions: buildReasoningEffortOptions(
      session?.available_models || [],
      currentModelValue,
      currentEffortValue
    ),
    messagePlaceholder: sessionView.messagePlaceholder,
    models: session?.available_models || [],
    sendDisabled: Boolean(session?.active_turn_id),
    sendPending,
    session,
    stopVisible: Boolean(session?.active_turn_id && !sessionView.composerDisabled),
  };
}
