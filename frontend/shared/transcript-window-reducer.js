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

/**
 * The other half of the gate for merges that place page rows RELATIVE to held
 * rows: every row numbered AND the window already in number order. A numbered
 * page against an unnumbered window has nothing to measure against, and the
 * reducer would have to guess — the legacy algorithm's job, done better.
 *
 * "Numbered" alone is NOT enough. A row the legacy path placed by position and
 * something numbered afterwards leaves a window with a number on every row that
 * is not in number order; inserting against those neighbours builds a right
 * answer on a wrong premise. Such a window stays on legacy until an
 * authoritative page rebuilds it in order. An empty window is trivially keyed.
 */
export function windowIsOrderKeyed(order, entries) {
  if (!Array.isArray(order) || !(entries instanceof Map)) {
    return false;
  }
  let previous = null;
  for (const key of order) {
    const entry = entries.get(key);
    if (!rowHasOrderKey(entry)) {
      return false;
    }
    if (previous != null && entry.order_seq < previous) {
      return false;
    }
    previous = entry.order_seq;
  }
  return true;
}

function defaultMergeRow(existing, incoming) {
  return existing ? { ...existing, ...incoming } : incoming;
}

// The two things a row's identity owns, enforced AROUND the caller's merge
// rather than inside a default it replaces. Every migrating store brings its own
// content merge (text selection, tool merge, content_state rank) that ends in
// `{...existing, ...incoming}`, which would otherwise hand both of these to
// whichever copy arrived last.
function applyRowIdentityInvariants(existing, merged) {
  if (!existing) {
    return merged;
  }
  return {
    ...merged,
    // A copy serialized before the withdrawal must never resurrect the row.
    ...(existing.withdrawn === true || merged.withdrawn === true ? { withdrawn: true } : {}),
    // First key wins — a row is numbered once; a copy numbered by another
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
export function upsertWindowRowInPlace(window, row, options = {}) {
  return upsertRowAt(window, row, options).changed;
}

// Shared body. `hint` is where the PREVIOUS row in this batch landed; see
// mergeWindowRowsInPlace for why that collapses a page merge to linear.
function upsertRowAt(window, row, { mergeRow = defaultMergeRow } = {}, hint = null) {
  const key = transcriptRowKey(row);
  if (!key) {
    return { changed: false, insertedAt: null };
  }
  const existing = window.entries.get(key);
  window.entries.set(key, applyRowIdentityInvariants(existing, mergeRow(existing, row)));
  if (existing !== undefined) {
    return { changed: true, insertedAt: null };
  }
  const insertAt = windowInsertionIndex(window.order, window.entries, row, hint);
  if (insertAt >= window.order.length) {
    window.order.push(key);
    windowOrderWriteCount += 1;
    return { changed: true, insertedAt: window.order.length - 1 };
  }
  window.order.splice(insertAt, 0, key);
  windowOrderWriteCount += window.order.length - insertAt;
  return { changed: true, insertedAt: insertAt };
}

/**
 * Bulk upsert into the draft. Replaces `window.order` with a newly built array
 * when it can merge linearly, and mutates in place otherwise; either way the
 * caller reads the result off the draft it passed in.
 *
 * A per-row insert cannot be linear no matter how good its search is: splicing
 * into the head shifts the whole array, so a 50-row page into a 5000-row window
 * moves a quarter of a million elements. When both sides are numbered and the
 * window is already ordered, walk the two in step instead and write each element
 * exactly once. That is the scroll-up freeze this file exists to prevent.
 */
export function mergeWindowRowsInPlace(window, rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return false;
  }
  if (
    list.length > 1
    && rowsAreOrderKeyed(list)
    && windowIsOrderKeyed(window.order, window.entries)
  ) {
    return mergeKeyedRowsLinearly(window, list, options);
  }

  // Mixed or unnumbered input: place row by row, carrying the previous row's
  // slot forward so a run of adjacent rows does not re-walk the window.
  let changed = false;
  let hint = null;
  for (const row of list) {
    const { changed: rowChanged, insertedAt } = upsertRowAt(window, row, options, hint);
    if (rowChanged) {
      changed = true;
    }
    if (insertedAt != null) {
      hint = insertedAt + 1;
    }
  }
  return changed;
}

// Sorting here is correct but it means the relay broke its own contract: it
// builds pages from an ascending transcript. Say so once — a silent sort turns a
// server-side ordering bug into a client-side cost nobody ever looks at. Once,
// not per page, because this would otherwise fire on every scroll-up.
let warnedAboutUnsortedPage = false;

function warnOnceAboutUnsortedPage() {
  if (warnedAboutUnsortedPage) {
    return;
  }
  warnedAboutUnsortedPage = true;
  // eslint-disable-next-line no-console
  console?.warn?.(
    "transcript page arrived out of order_seq order; sorting it. This is a relay-side "
      + "contract violation, not a client fallback that should be relied on."
  );
}

export function __resetUnsortedPageWarning() {
  warnedAboutUnsortedPage = false;
}

function isAscendingByOrderSeq(rows) {
  for (let index = 1; index < rows.length; index += 1) {
    windowInsertionProbeCount += 1;
    if (rows[index].order_seq < rows[index - 1].order_seq) {
      return false;
    }
  }
  return true;
}

// Two-pointer merge of an ascending run of rows into an ascending window.
// Rows already held keep their slot and their object identity is only replaced
// by the caller's own merge — position is never revisited.
function mergeKeyedRowsLinearly(window, rows, { mergeRow = defaultMergeRow } = {}) {
  // The relay builds a page from its own ascending transcript, so this scan
  // almost always just confirms that and the merge below is O(window + page).
  // Verify rather than assume: a page that is NOT ascending must still merge
  // correctly, and sorting is the only honest answer for it. The check's own
  // comparisons are counted, so the linearity test cannot be fooled by work
  // hidden in a sort.
  let sorted = rows;
  if (!isAscendingByOrderSeq(rows)) {
    warnOnceAboutUnsortedPage();
    sorted = [...rows].sort((left, right) => left.order_seq - right.order_seq);
  }
  const order = window.order;
  const merged = [];
  let changed = false;
  let index = 0;

  for (const row of sorted) {
    const key = transcriptRowKey(row);
    const existing = window.entries.get(key);
    window.entries.set(key, applyRowIdentityInvariants(existing, mergeRow(existing, row)));
    changed = true;
    if (existing !== undefined) {
      continue;
    }
    while (index < order.length) {
      const neighbour = window.entries.get(order[index]);
      windowInsertionProbeCount += 1;
      if (rowHasOrderKey(neighbour) && neighbour.order_seq > row.order_seq) {
        break;
      }
      merged.push(order[index]);
      windowOrderWriteCount += 1;
      index += 1;
    }
    merged.push(key);
    windowOrderWriteCount += 1;
  }

  while (index < order.length) {
    merged.push(order[index]);
    windowOrderWriteCount += 1;
    index += 1;
  }

  window.order = merged;
  return changed;
}

// Counts neighbours EXAMINED while placing rows. The scroll-up freeze this file
// replaces was an O(page x window) merge; a test asserts this stays linear.
let windowInsertionProbeCount = 0;

export function __readWindowInsertionProbeCount() {
  return windowInsertionProbeCount;
}

export function __resetWindowInsertionProbeCount() {
  windowInsertionProbeCount = 0;
}

// Counts ELEMENTS MOVED in the order array. Probe count alone cannot see this:
// splicing one row into the head of a 5000-row window is two comparisons and
// five thousand element moves, so a per-row splice reads as linear while being
// quadratic. Both counters together are what make "linear" a real claim.
let windowOrderWriteCount = 0;

export function __readWindowOrderWriteCount() {
  return windowOrderWriteCount;
}

export function __resetWindowOrderWriteCount() {
  windowOrderWriteCount = 0;
}

// True when `at` is a valid slot for `row`: everything left of it is <= the row
// and everything right of it is >= the row. Only the two adjacent neighbours are
// examined, so a correct hint costs O(1) and a wrong one costs nothing but falls
// through to the walk.
function slotFits(order, entries, row, at) {
  if (!Number.isInteger(at) || at < 0 || at > order.length) {
    return false;
  }
  if (at > 0) {
    const left = entries.get(order[at - 1]);
    windowInsertionProbeCount += 1;
    if (!rowHasOrderKey(left) || left.order_seq > row.order_seq) {
      return false;
    }
  }
  if (at < order.length) {
    const right = entries.get(order[at]);
    windowInsertionProbeCount += 1;
    if (!rowHasOrderKey(right) || right.order_seq < row.order_seq) {
      return false;
    }
  }
  return true;
}

// Walk from the tail: new rows overwhelmingly belong at or near the end. A keyed
// row lands after the last row whose key is <= its own; unkeyed neighbours (a
// mixed transient) hold their positions and are walked over.
function windowInsertionIndex(order, entries, row, hint = null) {
  if (!rowHasOrderKey(row)) {
    return order.length;
  }
  if (hint != null && slotFits(order, entries, row, hint)) {
    return hint;
  }
  let index = order.length;
  let sawKeyedNeighbour = false;
  while (index > 0) {
    const neighbour = entries.get(order[index - 1]);
    windowInsertionProbeCount += 1;
    if (!rowHasOrderKey(neighbour)) {
      index -= 1;
      continue;
    }
    sawKeyedNeighbour = true;
    if (neighbour.order_seq <= row.order_seq) {
      return index;
    }
    index -= 1;
  }
  // Walked the whole window without one number to compare against — a mixed
  // window from an old relay. The head is the one place a row we know nothing
  // about certainly does not belong; "every number outranks mine" is head.
  return sawKeyedNeighbour ? 0 : order.length;
}
