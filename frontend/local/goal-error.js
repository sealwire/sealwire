// The goal card's own failure line on the LOCAL surface.
//
// Separate from the composer's line on purpose: that one also carries send and settings
// failures, and "Message failed" rendered on the goal card would name the wrong action.

import {
  beginGoalAction,
  goalActionGeneration,
  goalErrorFrom,
  withGoalError,
  withGoalErrorCleared,
} from "../shared/goal-errors.js";

/** @type {Record<string, {generation: number, message: string}>} */
let actions = {};

/** Open a user action on this thread's goal; answers the generation to file it under. */
export function beginLocalGoalAction(threadId) {
  actions = beginGoalAction(actions, threadId);
  return goalActionGeneration(actions, threadId);
}

export function recordGoalError(threadId, message, generation) {
  actions = withGoalError(actions, threadId, message, generation);
  return actions;
}

export function clearGoalError(threadId) {
  actions = withGoalErrorCleared(actions, threadId);
  return actions;
}

export function goalErrorFor(threadId) {
  return goalErrorFrom(actions, threadId);
}

/** Test seam: drop everything, so one test's failures cannot leak into another. */
export function resetGoalErrorsForTest() {
  actions = {};
}
