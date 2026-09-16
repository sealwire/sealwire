// `taskReviewer` is unlike the other gates here: it never lifts. The seat is a
// record of what the reviewer judged, so the relay refuses user turns into it for
// as long as it exists (TASK_REVIEWER_READ_ONLY_MSG).
export function canComposeThread({
  activeTurnId,
  hasActiveSession,
  hasControllerLease,
  reviewLocked,
  taskReviewer,
}) {
  return Boolean(
    hasActiveSession
    && !reviewLocked
    && !taskReviewer
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
  stopPending = false,
}) {
  // `threadWorking` (not `turnRunning`) gates Stop: a thread can be working from
  // a status update before `active_turn_id` lands, and that still warrants Stop.
  // `!activeThreadFrozen` keeps us from offering to stop a review's own turn.
  // `stopPending` keeps Stop up after the HTTP ask returns and before the turn
  // actually idles — otherwise the button flickers enabled and invites mashing.
  const pending = Boolean(stopPending);
  const stopVisible = Boolean(
    (threadWorking || pending) && !activeThreadFrozen && (canWrite || viewOnly)
  );
  return {
    // Send hides exactly when Stop shows — the two buttons never coexist.
    sendHidden: stopVisible,
    sendDisabled: Boolean(
      !composerReady || turnRunning || activeThreadFrozen || submitInFlight || pending
    ),
    stopHidden: !stopVisible,
    stopDisabled: !stopVisible || pending,
    stopPending: pending && stopVisible,
  };
}
