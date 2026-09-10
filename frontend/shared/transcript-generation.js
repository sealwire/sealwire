// One rule, for every place a fetched transcript page is merged.
//
// A relay restart rebuilds each thread from provider history, and that renumbers item
// ids — so a page produced by an earlier run names the SAME messages differently.
// Merged in, each of them renders twice. Pages can be in flight across a restart, so
// "which run produced this" has to be checked at the moment of merge, not only at the
// moment of request.

/**
 * Whether a page may be merged into the window a snapshot describes.
 *
 * Strict equality once both sides are normalised — deliberately symmetric:
 *
 *  - Neither side carries a generation: a relay too old to stamp one, talking to a
 *    client that has nothing to compare. Accepted, exactly as before this existed.
 *  - Both carry one: they must be the same run.
 *  - Only ONE side carries one: that is an upgrade or downgrade race, in EITHER
 *    order — a stamped page arriving before the first stamped snapshot is just as
 *    mixed as an unstamped page arriving after it. Refused.
 */
export function transcriptPageMatchesGeneration(sessionGeneration, pageGeneration) {
  return (sessionGeneration || "") === (pageGeneration || "");
}

/** Convenience for the common `(state.session, page)` shape. */
export function transcriptPageIsFromAnotherGeneration(session, page) {
  return !transcriptPageMatchesGeneration(
    session?.transcript_generation,
    page?.transcript_generation
  );
}
