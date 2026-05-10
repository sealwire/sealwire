export function deriveSessionRuntime({
  composerDraft = "",
  composerEffort = "medium",
  composerModel = "",
  sendPending = false,
  session,
  sessionView,
  threadsFilterValue = "",
}) {
  return {
    composerDisabled: sessionView.composerDisabled,
    currentDraft: composerDraft,
    currentApprovalId: sessionView.currentApprovalId,
    currentEffortValue: composerEffort,
    currentModelValue: composerModel || session?.model || "",
    messagePlaceholder: sessionView.messagePlaceholder,
    models: session?.available_models || [],
    sendDisabled: Boolean(session?.active_turn_id),
    sendPending,
    session,
    stopVisible: Boolean(session?.active_turn_id && !sessionView.composerDisabled),
    threadsFilterHint:
      sessionView.cwdFilterHint && !threadsFilterValue.trim()
        ? sessionView.cwdFilterHint
        : null,
  };
}
