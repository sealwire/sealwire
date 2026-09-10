// A withdrawn row is delivered but never rendered: the send it represents was
// definitively rejected, and the server keeps the row as a tombstone because a
// snapshot merge can only add and update — it cannot express absence.
//
// Filtered where each surface assembles the entries its panel (and its SCROLL
// bookkeeping) consumes — not only in the React renderer, or a hidden row could
// still anchor "latest user message" scrolling.

export function transcriptEntryIsWithdrawn(entry) {
  return entry?.withdrawn === true;
}

/** Identity-preserving when nothing is withdrawn, so React memoization holds. */
export function visibleTranscriptEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.some(transcriptEntryIsWithdrawn)
    ? entries.filter((entry) => !transcriptEntryIsWithdrawn(entry))
    : entries;
}
