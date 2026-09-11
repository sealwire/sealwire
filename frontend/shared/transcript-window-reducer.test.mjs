// The keyed-world merge contract: mutate the caller's draft, update in place
// without touching order, push the tail flat, position only genuine mid keys,
// absorb withdrawal, never let a foreign copy move a placed row.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  __readWindowInsertionProbeCount,
  __readWindowOrderWriteCount,
  __resetWindowInsertionProbeCount,
  __resetWindowOrderWriteCount,
  mergeWindowRowsInPlace,
  rowsAreOrderKeyed,
  upsertWindowRowInPlace,
  windowIsOrderKeyed,
} from "./transcript-window-reducer.js";

const S = 1 << 20;

function row(id, orderSeq, extra = {}) {
  return { item_id: id, order_seq: orderSeq, kind: "agent_text", text: id, status: "completed", ...extra };
}

function draftOf(...rows) {
  return {
    order: rows.map((r) => r.item_id),
    entries: new Map(rows.map((r) => [r.item_id, r])),
  };
}

test("updating a held row mutates content only — order is not touched at all", () => {
  const draft = draftOf(row("a", 0), row("b", S));
  const orderBefore = draft.order;
  assert.equal(upsertWindowRowInPlace(draft, row("a", 0, { text: "longer a" })), true);
  assert.equal(draft.order, orderBefore);
  assert.deepEqual(draft.order, ["a", "b"]);
  assert.equal(draft.entries.get("a").text, "longer a");
});

test("a tail row pushes; a mid key lands between its neighbours; a head key lands first", () => {
  const draft = draftOf(row("a", 0), row("c", 2 * S));
  upsertWindowRowInPlace(draft, row("d", 3 * S));
  assert.deepEqual(draft.order, ["a", "c", "d"]);
  upsertWindowRowInPlace(draft, row("b", S));
  assert.deepEqual(draft.order, ["a", "b", "c", "d"]);
  upsertWindowRowInPlace(draft, row("older", -S));
  assert.deepEqual(draft.order, ["older", "a", "b", "c", "d"]);
});

test("an older keyed page merges to the head without touching held rows", () => {
  const held = row("c", 0);
  const draft = draftOf(held, row("d", S));
  assert.equal(mergeWindowRowsInPlace(draft, [row("a", -2 * S), row("b", -S)]), true);
  assert.deepEqual(draft.order, ["a", "b", "c", "d"]);
  assert.equal(draft.entries.get("c"), held, "held rows keep their object identity");
});

test("a copy numbered by another runtime cannot move a placed row", () => {
  const draft = draftOf(row("a", 0), row("b", S));
  upsertWindowRowInPlace(draft, row("a", 99 * S, { text: "foreign copy" }));
  assert.deepEqual(draft.order, ["a", "b"]);
  assert.equal(draft.entries.get("a").order_seq, 0, "first key wins");
  assert.equal(draft.entries.get("a").text, "foreign copy", "content still merges");
});

test("withdrawal absorbs through the default merge", () => {
  const draft = draftOf(row("a", 0, { withdrawn: true }));
  upsertWindowRowInPlace(draft, row("a", 0, { text: "late unmarked copy" }));
  assert.equal(draft.entries.get("a").withdrawn, true);
});

test("the reducer's invariants survive a caller's own mergeRow", () => {
  // Every store migrating onto the reducer passes its OWN entry merge (text
  // selection, tool merge, content_state ranking). Those all end in
  // `{...existing, ...incoming}`, so leaving the invariants to the default
  // hands the number and the tombstone back to whichever copy arrived last.
  const draft = draftOf(row("a", 0, { withdrawn: true }));
  const storeMerge = (existing, incoming) => ({ ...existing, ...incoming });

  upsertWindowRowInPlace(
    draft,
    row("a", 99 * S, { text: "late copy", withdrawn: false }),
    { mergeRow: storeMerge }
  );

  assert.equal(draft.entries.get("a").order_seq, 0, "first key wins through a custom merge");
  assert.equal(draft.entries.get("a").withdrawn, true, "withdrawal still absorbs");
  assert.equal(draft.entries.get("a").text, "late copy", "the caller's merge still decides content");
});

test("a keyless row is not the reducer's to place", () => {
  const draft = draftOf(row("a", 0));
  assert.equal(upsertWindowRowInPlace(draft, { text: "no identity" }), false);
  assert.deepEqual(draft.order, ["a"]);
});

test("the gate refuses anything the reducer would drop or misplace", () => {
  assert.equal(rowsAreOrderKeyed([row("a", 0)]), true);
  assert.equal(rowsAreOrderKeyed([row("a", 0), { item_id: "b" }]), false, "unnumbered row");
  assert.equal(
    rowsAreOrderKeyed([{ text: "id-less old-relay row" }]),
    false,
    "an id-less page must reach the LEGACY path, not be silently ignored row by row"
  );
  assert.equal(rowsAreOrderKeyed([]), false, "an empty page proves nothing");
});

test("an older page merging into a deep window stays linear", () => {
  // The scroll-up case: 50 older rows into a 5000-row window. Inserting row by
  // row is O(page x window) twice over — walking back from the tail to find each
  // slot, and shifting the array on each splice. Both counters are asserted
  // because either one alone passes while the other stays quadratic.
  const windowSize = 5000;
  const pageSize = 50;
  const held = Array.from({ length: windowSize }, (_, i) => row(`w${i}`, i * S));
  const draft = {
    order: held.map((r) => r.item_id),
    entries: new Map(held.map((r) => [r.item_id, r])),
  };
  const page = Array.from({ length: pageSize }, (_, i) => row(`p${i}`, (i - pageSize - 10) * S));

  __resetWindowInsertionProbeCount();
  __resetWindowOrderWriteCount();
  mergeWindowRowsInPlace(draft, page);
  const probes = __readWindowInsertionProbeCount();
  const writes = __readWindowOrderWriteCount();

  assert.deepEqual(
    draft.order.slice(0, pageSize),
    page.map((r) => r.item_id),
    "the page still lands, in order, at the head"
  );
  // Counts the ascending-check scan too, so no work can hide in a sort.
  assert.ok(
    probes < windowSize + 8 * pageSize,
    `linear comparisons: ${probes} probes for ${pageSize} rows into ${windowSize}`
  );
  // Comparisons are only half the cost. Splicing each row into the HEAD shifts
  // the whole array every time, so a per-row splice is still O(page x window)
  // in element movement while the probe count alone reads as linear.
  assert.ok(
    writes < 3 * (windowSize + pageSize),
    `linear element movement: ${writes} order writes for ${pageSize} rows into ${windowSize}`
  );
});

test("a window numbered out of order is not treated as keyed", () => {
  // A row placed by the LEGACY path and numbered afterwards leaves a window that
  // has a number on every row but is not in number order. Reading that as keyed
  // lets the reducer insert against neighbours that are themselves misplaced —
  // a wrong answer built on a wrong premise. It must fall back to legacy.
  const a = row("a", 0);
  const c = row("c", 2 * S);
  const b = row("b", S);
  const entries = new Map([
    ["a", a],
    ["c", c],
    ["b", b],
  ]);

  assert.equal(windowIsOrderKeyed(["a", "b", "c"], entries), true, "sorted is keyed");
  assert.equal(
    windowIsOrderKeyed(["a", "c", "b"], entries),
    false,
    "every row numbered, but not in number order"
  );
});

test("a page that arrives out of order still merges into full order", () => {
  // The relay's pages are ascending, so the merge verifies that rather than
  // paying a sort. A page that breaks the expectation must still come out right:
  // correctness is not what the fast path is allowed to trade away.
  const draft = draftOf(row("held", 0));
  const scrambled = [row("d", 3 * S), row("a", -3 * S), row("c", 2 * S), row("b", -2 * S)];

  assert.equal(mergeWindowRowsInPlace(draft, scrambled), true);

  assert.deepEqual(draft.order, ["a", "b", "held", "c", "d"]);
});
