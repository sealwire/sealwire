import {
  buildReasoningEffortOptions,
  resolveReasoningEffortValue,
} from "../shared/reasoning-efforts.js";

export function selectRemoteControlSession({ session, realSession }) {
  if (session?.view_only) {
    return realSession || null;
  }
  return session || null;
}

export function deriveSessionRuntime({
  composerDraft = "",
  composerEffort = "medium",
  composerModel = "",
  sendPending = false,
  session,
  sessionView,
}) {
  const currentModelValue = composerModel || session?.model || "";
  // The session's reasoning_effort is the source of truth. An empty composer
  // effort means "this surface hasn't overridden it" (e.g. you just opened the
  // session on another device), so fall back to the session value instead of
  // the model default — otherwise a high session silently shows/sends medium.
  const currentEffortValue = resolveReasoningEffortValue(
    session?.available_models || [],
    currentModelValue,
    composerEffort || session?.reasoning_effort || ""
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
