// The keyed-world merge contract: update in place without reordering, append the
// tail flat, position only genuine mid-window keys, absorb withdrawal, never let
// a foreign copy move a placed row.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeWindowRows,
  rowsAreOrderKeyed,
  upsertWindowRow,
} from "./transcript-window-reducer.js";

const S = 1 << 20;

function row(id, orderSeq, extra = {}) {
  return { item_id: id, order_seq: orderSeq, kind: "agent_text", text: id, status: "completed", ...extra };
}

function windowOf(...rows) {
  return {
    order: rows.map((r) => r.item_id),
    entries: new Map(rows.map((r) => [r.item_id, r])),
  };
}

test("updating a held row keeps the order array by REFERENCE", () => {
  const window = windowOf(row("a", 0), row("b", S));
  const next = upsertWindowRow(window, row("a", 0, { text: "longer a" }));
  assert.equal(next.order, window.order, "no reorder -> same array, memoization holds");
  assert.equal(next.entries.get("a").text, "longer a");
});

test("a tail row appends; a mid key lands between its neighbours", () => {
  const window = windowOf(row("a", 0), row("c", 2 * S));
  const tail = upsertWindowRow(window, row("d", 3 * S));
  assert.deepEqual(tail.order, ["a", "c", "d"]);
  const mid = upsertWindowRow(window, row("b", S));
  assert.deepEqual(mid.order, ["a", "b", "c"]);
  const head = upsertWindowRow(window, row("older", -S));
  assert.deepEqual(head.order, ["older", "a", "c"]);
});

test("an older keyed page merges to the head without touching held rows", () => {
  const window = windowOf(row("c", 0), row("d", S));
  const merged = mergeWindowRows(window, [row("a", -2 * S), row("b", -S)]);
  assert.deepEqual(merged.order, ["a", "b", "c", "d"]);
  assert.equal(merged.entries.get("c"), window.entries.get("c"), "held rows untouched");
});

test("a copy numbered by another runtime cannot move a placed row", () => {
  const window = windowOf(row("a", 0), row("b", S));
  const next = upsertWindowRow(window, row("a", 99 * S, { text: "foreign copy" }));
  assert.equal(next.order, window.order);
  assert.equal(next.entries.get("a").order_seq, 0, "first key wins");
  assert.equal(next.entries.get("a").text, "foreign copy", "content still merges");
});

test("withdrawal absorbs through the default merge", () => {
  const window = windowOf(row("a", 0, { withdrawn: true }));
  const next = upsertWindowRow(window, row("a", 0, { text: "late unmarked copy" }));
  assert.equal(next.entries.get("a").withdrawn, true);
});

test("an unkeyed row appends in place (row-level legacy fallback)", () => {
  const window = windowOf(row("a", 0), row("b", S));
  const next = upsertWindowRow(window, { item_id: "legacy", text: "x", kind: "agent_text", status: "completed" });
  assert.deepEqual(next.order, ["a", "b", "legacy"]);
});

test("rowsAreOrderKeyed gates the reducer path", () => {
  assert.equal(rowsAreOrderKeyed([row("a", 0)]), true);
  assert.equal(rowsAreOrderKeyed([row("a", 0), { item_id: "b" }]), false);
  assert.equal(rowsAreOrderKeyed([]), false, "an empty page proves nothing — stay on the legacy path");
});
