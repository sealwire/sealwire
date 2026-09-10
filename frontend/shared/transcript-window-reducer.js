// The ONE merge algorithm for a transcript window whose rows carry `order_seq`.
//
// Replaces the per-store splice guesswork (tail-page order merge, snapshot anchor
// chaining, prepend dedupe) for data from a relay that numbers its rows. Callers
// keep their legacy path when the gate below says no — that is the adapter, and it
// is deliberately NOT re-implemented here (network arrival order is wrong for older
// history pages; the legacy algorithms already encode the right guesses).
//
// MUTABLE DRAFT MODEL. These functions mutate the window they are given and
// return whether anything changed. Immutability is the CALLER'S one job: copy the
// map/array once per batch (exactly what the stores already do per patch), hand
// the draft in, publish it after. That is what keeps the hot paths flat:
//  - a row already in the window updates in place: O(1), order untouched;
//  - a new tail row pushes: O(1) — the streaming-delta path stays flat;
//  - a genuinely mid-window row walks from the tail to its slot: rare by
//    construction (a mid key only comes from history merges and future
//    relay-authored cards).
import { transcriptRowKey } from "./transcript-row-key.js";

export function rowHasOrderKey(row) {
  return Number.isSafeInteger(row?.order_seq);
}

/**
 * The adapter gate: the reducer may run only when EVERY row is addressable AND
 * numbered. A row key alone is not enough — an id-less old-relay page would pass
 * a laxer gate and then be silently ignored row by row, which is data loss, not
 * degradation. An empty page proves nothing: stay on the legacy path.
 */
export function rowsAreOrderKeyed(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return false;
  }
  return rows.every((row) => Boolean(transcriptRowKey(row)) && rowHasOrderKey(row));
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
 * Upsert one row into the draft `{order, entries}` IN PLACE. Returns whether the
 * draft changed. An existing row never touches `order`; a row with no key at all
 * is not the reducer's to place and is left alone (the gate keeps whole pages of
 * those on the legacy path — this is only the row-level backstop).
 */
export function upsertWindowRowInPlace(window, row, { mergeRow = defaultMergeRow } = {}) {
  const key = transcriptRowKey(row);
  if (!key) {
    return false;
  }
  const existing = window.entries.get(key);
  window.entries.set(key, mergeRow(existing, row));
  if (existing !== undefined) {
    return true;
  }
  const insertAt = windowInsertionIndex(window.order, window.entries, row);
  if (insertAt >= window.order.length) {
    window.order.push(key);
  } else {
    window.order.splice(insertAt, 0, key);
  }
  return true;
}

/** Bulk upsert into the draft, in row order. One copy belongs to the caller, not here. */
export function mergeWindowRowsInPlace(window, rows, options = {}) {
  let changed = false;
  for (const row of rows || []) {
    if (upsertWindowRowInPlace(window, row, options)) {
      changed = true;
    }
  }
  return changed;
}

// Walk from the tail: new rows overwhelmingly belong at or near the end. A keyed
// row lands after the last row whose key is <= its own; unkeyed neighbours (a
// mixed transient) hold their positions and are walked over.
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
