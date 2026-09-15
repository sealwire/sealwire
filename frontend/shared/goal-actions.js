import { goalOutcomeOrContractError } from "./goal-outcome.js";

// Stopping and resuming are separate capabilities rather than one write with an empty
// objective meaning "stop": the intent then survives all the way down instead of being
// encoded as "" here and decoded again at each transport.
export function createGoalActions({
  getThreadId,
  setGoal,
  stopGoal,
  log = () => {},
  // Reported onto the CARD, not the composer: on a phone this panel is opened as a
  // native <dialog>, so the composer sits behind an inert layer where the message
  // could be neither read nor dismissed. The relay answers a refusal with 200 +
  // `isError`, which is neither a throw nor a success, so nothing else catches it.
  setGoalError = () => {},
  // Opens a user action on this goal and answers its generation. What this attempt
  // later reports is filed under it, so a settlement the user has already superseded
  // (from here or from the composer) cannot land on the goal that replaced it.
  beginGoalAction = () => 0,
}) {
  const write = (capability, ...args) => {
    const threadId = getThreadId();
    if (!threadId) return;
    // Cleared when this attempt STARTS, never when it finishes. These buttons are
    // fire-and-forget and nothing disables them, so a success clearing on its way out
    // can erase a newer failure that landed while it was still in flight.
    const generation = beginGoalAction(threadId);
    void Promise.resolve()
      .then(() => capability?.(threadId, ...args))
      .then((result) => {
        if (result?.text) log(result.text);
        // A refusal is 200 + `isError`, not a throw, so nothing else catches it — and
        // anything that is not the contract counts as a failure rather than as success,
        // or a helper slipping back to a bare boolean goes silent right here.
        const outcome = goalOutcomeOrContractError(result);
        if (outcome.isError) setGoalError(threadId, outcome.text, generation);
      })
      .catch((error) => {
        const message = `Could not reach the relay: ${error?.message || error}`;
        log(message);
        setGoalError(threadId, message, generation);
      });
  };
  return {
    onStopGoal: () => write(stopGoal),
    // Re-sending the same objective is how "keep going" answers a completion claim.
    onResumeGoal: (objective) => write(setGoal, objective || ""),
  };
}
