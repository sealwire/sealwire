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
    sendPending,
    session,
    threadsFilterHint:
      sessionView.cwdFilterHint && !threadsFilterValue.trim()
        ? sessionView.cwdFilterHint
        : null,
  };
}
