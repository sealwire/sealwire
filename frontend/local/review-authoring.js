// `/review` from the composer.
//
// Only the COMMAND door wraps here. The request modal calls the same capability and
// shows the relay's reason inline itself, so reporting there too would say it twice;
// the command has no modal, and the controller swallows the rejection into a bare
// `false`, which is how a refused `/review` came to say nothing at all.
//
// The relay heard this one before refusing, so its reason is a failure and goes to the
// error line — not to the "not sent" slot, which is for what the composer stopped.

/**
 * @param {{
 *   requestReview: (values: object) => Promise<unknown>,
 *   getThreadId?: () => string | null,
 *   setComposerError?: (threadId: string, message: string) => void,
 * }} deps
 */
export function createReviewAuthor({
  requestReview,
  getThreadId = () => null,
  setComposerError = () => {},
}) {
  return async function authorReview(values) {
    const threadId = getThreadId();
    // Cleared as the attempt starts, never when it finishes: a success clearing on its
    // way out can erase a newer failure that landed while it was still in flight.
    setComposerError(threadId, "");
    try {
      return await requestReview(values);
    } catch (error) {
      setComposerError(
        threadId,
        error?.message || "The relay refused the review, without saying why."
      );
      // Rethrown so the controller still knows it failed and keeps the draft.
      throw error;
    }
  };
}
