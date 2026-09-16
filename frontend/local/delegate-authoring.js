// `/delegate` on the local surface.
//
// Extracted from app.js for the same reason `/goal` was: inline in an object literal
// it has no seam, so the one thing that matters about it — that a refusal is SAID —
// cannot be tested, and that is exactly the guarantee that kept getting lost.
//
// The relay hears this one before it refuses, so its reason is a failure and goes to
// the composer's error line, not to the "not sent" slot above it, which is for what
// the composer stopped by itself.

import { commandOutcomeOrContractError } from "../shared/command-outcome.js";

/**
 * @param {{
 *   delegate: (threadId: string, args: object) => Promise<{text: string, isError: boolean}>,
 *   setComposerError?: (threadId: string, message: string) => void,
 * }} deps
 */
export function createDelegateAuthor({ delegate, setComposerError = () => {} }) {
  return async function authorDelegate(threadId, args) {
    // Cleared as the attempt starts, never when it finishes: a success clearing on its
    // way out can erase a newer failure that landed while it was still in flight.
    setComposerError(threadId, "");
    // Normalised, never trusted as-is: the controller decides whether to keep the draft
    // from `isError`, so a helper answering a bare boolean would read as success and
    // throw away what the user typed.
    const outcome = commandOutcomeOrContractError(await delegate(threadId, args), "the message");
    if (outcome.isError) setComposerError(threadId, outcome.text);
    return outcome;
  };
}
