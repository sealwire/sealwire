// `/handover` on the local surface.
//
// Behind a seam for the same reason `/delegate` and `/goal` are: inline in an object
// literal the one guarantee that matters — that a refusal is SAID — has nowhere to be
// tested, and that is the guarantee this class of command keeps losing.
//
// The relay answers a handover before it starts it: everything a person can act on
// (no such agent, that one is busy, this session is mid-turn) is decided while the
// call is open, so its reason is a failure and belongs on the composer's error line,
// not in the "not sent" slot above it.

import { commandOutcomeOrContractError } from "../shared/command-outcome.js";

/**
 * @param {{
 *   handover: (threadId: string, args: object) => Promise<{text: string, isError: boolean}>,
 *   setComposerError?: (threadId: string, message: string) => void,
 * }} deps
 */
export function createHandoverAuthor({ handover, setComposerError = () => {} }) {
  return async function authorHandover(threadId, args) {
    // Cleared as the attempt starts, never when it finishes: a success clearing on its
    // way out can erase a newer failure that landed while it was still in flight.
    setComposerError(threadId, "");
    // Normalised, never trusted as-is: the controller decides whether to keep the draft
    // from `isError`, so a helper answering a bare boolean would read as success and
    // throw away what the user typed.
    const outcome = commandOutcomeOrContractError(await handover(threadId, args), "the handover");
    if (outcome.isError) setComposerError(threadId, outcome.text);
    return outcome;
  };
}
