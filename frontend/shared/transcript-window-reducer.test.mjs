// The keyed-world merge contract: mutate the caller's draft, update in place
// without touching order, push the tail flat, position only genuine mid keys,
// absorb withdrawal, never let a foreign copy move a placed row.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeWindowRowsInPlace,
  rowsAreOrderKeyed,
  upsertWindowRowInPlace,
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
