// The ONE merge algorithm for a transcript window whose rows carry `order_seq`.
//
// Replaces the per-store splice guesswork (tail-page order merge, snapshot anchor
// chaining, prepend dedupe) for data from a relay that numbers its rows. Callers
// keep their legacy path when rows carry no keys — that is the adapter, and it is
// deliberately NOT re-implemented here (network arrival order is wrong for older
// history pages; the legacy algorithms already encode the right guesses).
//
// Performance contract (why this is not sort-on-write):
//  - a row already in the window updates in place: O(1), order untouched;
//  - a new tail row appends: O(1) — the streaming-delta path stays flat;
//  - a genuinely mid-window row walks from the tail to its slot: rare by
//    construction (a mid-insert needs a mid order key, which only history merges
//    and future relay-authored cards produce).
import { transcriptRowKey } from "./transcript-row-key.js";

export function rowHasOrderKey(row) {
  return Number.isSafeInteger(row?.order_seq);
}

/** Whether every addressable row carries an order key — the reducer's precondition. */
export function rowsAreOrderKeyed(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return false;
  }
  return rows.every((row) => !transcriptRowKey(row) || rowHasOrderKey(row));
}

// Absorbing by default: `withdrawn` belongs to the id, and a copy serialized
// before the withdrawal must never resurrect the row.
function defaultMergeRow(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  return {
    ...existing,
    ...incoming,
    ...(existing.withdrawn === true || incoming.withdrawn === true ? { withdrawn: true } : {}),
    // First key wins — a row's key is assigned once; a copy numbered by another
    // runtime must not move a row already placed.
    ...(rowHasOrderKey(existing) ? { order_seq: existing.order_seq } : {}),
  };
}

/**
 * Upsert one row into `{order, entries}` (the shape the hydration store already
 * holds). Mutates neither input; returns `{order, entries, changed}` where the
 * ORDER ARRAY IS THE SAME REFERENCE when no reordering happened, so React-side
 * identity checks keep holding.
 */
export function upsertWindowRow(window, row, { mergeRow = defaultMergeRow } = {}) {
  const key = transcriptRowKey(row);
  if (!key) {
    return { order: window.order, entries: window.entries, changed: false };
  }
  const entries = new Map(window.entries);
  const existing = window.entries.get(key);
  entries.set(key, mergeRow(existing, row));
  if (existing !== undefined) {
    return { order: window.order, entries, changed: true };
  }

  const order = window.order.slice();
  const insertAt = windowInsertionIndex(order, entries, row);
  if (insertAt >= order.length) {
    order.push(key);
  } else {
    order.splice(insertAt, 0, key);
  }
  return { order, entries, changed: true };
}

/**
 * Bulk merge, in row order. Same guarantees per row; the common case (a page of
 * already-known ids, or a contiguous keyed tail) never reorders anything held.
 */
export function mergeWindowRows(window, rows, options = {}) {
  let next = { order: window.order, entries: window.entries };
  let changed = false;
  for (const row of rows || []) {
    const result = upsertWindowRow(next, row, options);
    changed = changed || result.changed;
    next = result;
  }
  return { order: next.order, entries: next.entries, changed };
}

// Walk from the tail: new rows overwhelmingly belong at or near the end. A row
// with no key appends (the legacy row-level fallback); a keyed row lands after
// the last row whose key is <= its own, skipping unkeyed rows in place.
function windowInsertionIndex(order, entries, row) {
  if (!rowHasOrderKey(row)) {
    return order.length;
  }
  let index = order.length;
  while (index > 0) {
    const neighbour = entries.get(order[index - 1]);
    if (!rowHasOrderKey(neighbour)) {
      index -= 1;
      continue;
    }
    if (neighbour.order_seq <= row.order_seq) {
      return index;
    }
    index -= 1;
  }
  return index;
}
