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

/**
 * Identity-preserving when nothing is withdrawn, so React memoization holds.
 *
 * Id-aware: withdrawal belongs to the ID, not to one copy of it — an unmarked twin
 * of a withdrawn id (an older serialization that slipped past a merge) must not
 * survive the filter either.
 */
export function visibleTranscriptEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }
  let withdrawnIds = null;
  let anyWithdrawn = false;
  for (const entry of entries) {
    if (transcriptEntryIsWithdrawn(entry)) {
      anyWithdrawn = true;
      if (entry.item_id) {
        (withdrawnIds ??= new Set()).add(entry.item_id);
      }
    }
  }
  if (!anyWithdrawn) {
    return entries;
  }
  return entries.filter(
    (entry) =>
      !transcriptEntryIsWithdrawn(entry)
      && !(entry?.item_id && withdrawnIds?.has(entry.item_id))
  );
}

/** OR the tombstone from dropped same-id copies onto the kept entries. */
export function absorbWithdrawnById(keptEntries, droppedEntries) {
  if (!Array.isArray(keptEntries) || !Array.isArray(droppedEntries)) {
    return keptEntries;
  }
  let withdrawnIds = null;
  for (const entry of droppedEntries) {
    if (transcriptEntryIsWithdrawn(entry) && entry.item_id) {
      (withdrawnIds ??= new Set()).add(entry.item_id);
    }
  }
  if (!withdrawnIds) {
    return keptEntries;
  }
  return keptEntries.map((entry) =>
    entry?.item_id && withdrawnIds.has(entry.item_id) && entry.withdrawn !== true
      ? { ...entry, withdrawn: true }
      : entry
  );
}
