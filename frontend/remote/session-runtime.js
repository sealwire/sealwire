export function deriveSessionRuntime({
  session,
  sessionView,
  threadsFilterValue = "",
}) {
  return {
    composerDisabled: sessionView.composerDisabled,
    currentApprovalId: sessionView.currentApprovalId,
    messagePlaceholder: sessionView.messagePlaceholder,
    session,
    threadsFilterHint:
      sessionView.cwdFilterHint && !threadsFilterValue.trim()
        ? sessionView.cwdFilterHint
        : null,
  };
}
