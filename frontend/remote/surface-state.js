export function clearRemoteSurfaceSessionState(state) {
  state.session = null;
  state.threads = [];
  state.currentApprovalId = null;
}

export function resetRemoteSurfaceState(
  state,
  {
    clearClaimLifecycle,
    clearSessionRuntime,
    rejectPendingActions,
    reason,
  }
) {
  clearClaimLifecycle();
  clearSessionRuntime();
  rejectPendingActions(reason);
  clearRemoteSurfaceSessionState(state);
}

export function setRemoteThreads(state, threads) {
  state.threads = threads;
  return state.threads;
}
