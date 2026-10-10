import { isReviewInProgressForThread } from "./review-state.js";
import { isWorkflowInProgressForThread } from "./workflow-state.js";

// A running turn does not lock the box: the relay refuses a second send into a busy
// thread and the draft stays. A task reviewer's seat never takes user turns.
export function canComposeThread({ hasActiveSession, reviewLocked, taskReviewer }) {
  return Boolean(hasActiveSession && !reviewLocked && !taskReviewer);
}

/// Ask only puts a quote above the box, so it is offered wherever the thread takes
/// messages at all; whose turn or lease it is right now does not matter.
export function canAskInThread(session) {
  const threadId = session?.active_thread_id;
  return Boolean(
    threadId
    && !session.active_thread_task_reviewer
    && !isReviewInProgressForThread(session, threadId)
    && !isWorkflowInProgressForThread(session, threadId)
  );
}

// Decide the visible/enabled state of the composer's Send and Stop buttons.
//
// Send and Stop are mutually exclusive: there is no pending-message queue yet,
// so while a turn is running the composer shows Stop and never Send.
export function composerButtonState({
  composerReady,
  turnRunning,
  threadWorking,
  activeThreadFrozen,
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
    (threadWorking || pending) && !activeThreadFrozen
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
