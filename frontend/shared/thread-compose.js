export function canComposeThread({
  activeTurnId,
  hasActiveSession,
  hasControllerLease,
  reviewLocked,
}) {
  return Boolean(
    hasActiveSession
    && !reviewLocked
    && (hasControllerLease || !activeTurnId)
  );
}

// Decide the visible/enabled state of the composer's Send and Stop buttons.
//
// Send and Stop are mutually exclusive: there is no pending-message queue yet,
// so while a turn is running the composer shows Stop and never Send. A view-only
// observer of a background thread still gets Stop, so Send must hide for them
// too — not only for the controller running its own turn.
export function composerButtonState({
  composerReady,
  turnRunning,
  threadWorking,
  activeThreadFrozen,
  canWrite,
  viewOnly,
  submitInFlight,
}) {
  // `threadWorking` (not `turnRunning`) gates Stop: a thread can be working from
  // a status update before `active_turn_id` lands, and that still warrants Stop.
  // `!activeThreadFrozen` keeps us from offering to stop a review's own turn.
  const stopVisible = Boolean(
    threadWorking && !activeThreadFrozen && (canWrite || viewOnly)
  );
  return {
    // Send hides exactly when Stop shows — the two buttons never coexist.
    sendHidden: stopVisible,
    sendDisabled: Boolean(
      !composerReady || turnRunning || activeThreadFrozen || submitInFlight
    ),
    stopHidden: !stopVisible,
    stopDisabled: !stopVisible,
  };
}
