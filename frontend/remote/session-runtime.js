export function deriveSessionRuntime({
  composerDraft = "",
  composerEffort = "medium",
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
    messagePlaceholder: sessionView.messagePlaceholder,
    sendPending,
    session,
    threadsFilterHint:
      sessionView.cwdFilterHint && !threadsFilterValue.trim()
        ? sessionView.cwdFilterHint
        : null,
  };
}
