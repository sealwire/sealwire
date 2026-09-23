import { prepareAuthoredGoalObjective } from "../shared/goal-objective.js";
import { commandOutcomeOrContractError } from "../shared/command-outcome.js";

// The "/" controller expects capabilities that answer `{text, isError}`. Two remote
// shapes reach it, and they are settled separately ON PURPOSE: collapsing them is how a
// goal helper that regresses to a bare boolean becomes a refusal nobody is shown.

const OK = { text: "", isError: false };
// `delegate` renders its own reason as it fails, so the text here stays empty or the
// controller logs the same sentence twice.
const REFUSED = { text: "", isError: true };

async function settledSelfReporting(run) {
  try {
    return (await run()) ? OK : REFUSED;
  } catch (error) {
    return { text: `Could not reach the relay: ${error?.message || error}`, isError: true };
  }
}

// The goal helpers answer `{isError, text}` and report NOWHERE, so their reason is put
// on the composer here — this is the door the user came through, and the card is not.
async function settledGoal(run, report) {
  let answer;
  try {
    answer = await run();
  } catch (error) {
    const text = `Could not reach the relay: ${error?.message || error}`;
    report(text);
    return { text, isError: true };
  }
  const outcome = commandOutcomeOrContractError(answer, "the goal");
  if (outcome.isError) report(outcome.text);
  return outcome.isError ? { text: outcome.text, isError: true } : OK;
}

export function createRemoteComposerCommandActions({
  setGoal,
  stopGoal,
  delegate,
  handover,
  // The phone's log drawer is `display: none` and nothing opens it, so unlike the
  // desktop there is no second channel: without this a refusal lands nowhere.
  setComposerError = () => {},
  // The gate's own refusal never reached the relay, so it is not a failure — it is a
  // draft that is not ready. Red would say the opposite.
  setComposerHeld = () => {},
  // The other door onto the same goal. Writing one here is a user action, so whatever
  // the card's own buttons last reported stops being the current word.
  beginGoalAction = () => {},
} = {}) {
  return {
    setGoal: (threadId, objective) => {
      // Two capabilities rather than one with an empty string: the relay gates and
      // logs them separately, and "/goal" on its own means call it off.
      const prepared = prepareAuthoredGoalObjective(objective);
      if (prepared.refuse) {
        setComposerHeld(threadId, prepared.refuse);
        setComposerError(threadId, "");
        return Promise.resolve({ text: prepared.refuse, isError: true });
      }
      // This attempt supersedes whatever the last one left on this thread, in either
      // region — a stale line under a draft that has since been fixed is a dead end.
      setComposerError(threadId, "");
      setComposerHeld(threadId, "");
      beginGoalAction(threadId);
      const report = (text) => setComposerError(threadId, text);
      if (!prepared.objective) {
        return settledGoal(() => stopGoal(threadId), report);
      }
      return settledGoal(() => setGoal(threadId, prepared.objective), report);
    },
    askAgent: (threadId, args) => settledSelfReporting(() => delegate(threadId, args)),
    handOver: (threadId, args) => settledSelfReporting(() => handover(threadId, args)),
  };
}
