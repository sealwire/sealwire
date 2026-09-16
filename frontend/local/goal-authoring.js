// `/goal` authoring on the local surface.
//
// Extracted from app.js so the rule it enforces is testable by behaviour. The
// guard that used to stand here was a grep over app.js's own source, which stays
// green through any change that keeps the words and drops the effect.

import { prepareAuthoredGoalObjective } from "../shared/goal-objective.js";
import { goalOutcomeOrContractError } from "../shared/goal-outcome.js";

/**
 * @param {{
 *   setGoal: (threadId: string, objective: string) => Promise<{text: string, isError: boolean}>,
 *   setComposerError?: (threadId: string, message: string) => void,
 *   beginGoalAction?: (threadId: string) => void,
 * }} deps
 *   `setComposerError` is the visible half: the controller only logs what comes
 *   back, and the log lives behind Settings → Log, so a refusal on its own reads
 *   as a dead Send button. An empty message clears, like every other caller.
 *
 *   `beginGoalAction` tells the goal CARD that the user has acted on this goal from
 *   here, so whatever its own buttons last reported stops being the current word.
 */
export function createGoalAuthor({
  setGoal,
  setComposerError = () => {},
  beginGoalAction = () => {},
}) {
  return async function authorGoal(threadId, objective) {
    const prepared = prepareAuthoredGoalObjective(objective);
    if (prepared.refuse) {
      setComposerError(threadId, prepared.refuse);
      return { text: prepared.refuse, isError: true };
    }
    // This attempt supersedes the last refusal on this thread only — a stale red
    // line under a draft that has since been fixed is its own dead end.
    setComposerError(threadId, "");
    beginGoalAction(threadId);
    // Normalised, never trusted as-is: the controller decides whether to keep the
    // draft from `isError`, so a helper answering the old bare boolean would read as
    // success and throw away what the user typed.
    const outcome = goalOutcomeOrContractError(await setGoal(threadId, prepared.objective));
    // Length is the only thing the gate can judge. A busy thread, a session narrowed
    // since, a workspace that moved — the relay decides those, and its reason reaches
    // the same collapsed panel unless it is put on screen here.
    if (outcome.isError) setComposerError(threadId, outcome.text);
    return outcome;
  };
}
