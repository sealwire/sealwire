import test from "node:test";
import assert from "node:assert/strict";

import { reconcileAuthoritativeTail } from "./authoritative-tail-merge.js";

function entry(itemId, text, overrides = {}) {
  return { item_id: itemId, text, kind: "agent_text", status: "completed", ...overrides };
}

const ORDER_CASES = [
  {
    name: "no overlap: the page comes first, the non-intersecting leftover stays below it (it is newer, not older)",
    order: ["live"],
    entries: new Map([["live", entry("live", "streaming now")]]),
    pageEntries: [entry("u1", "prompt"), entry("a1", "reply")],
    expectedOrder: ["u1", "a1", "live"],
  },
  {
    name: "partial overlap: entries before the intersection stay above, entries after stay below",
    order: ["x", "shared", "y"],
    entries: new Map([
      ["x", entry("x", "older")],
      ["shared", entry("shared", "stale")],
      ["y", entry("y", "newer")],
    ]),
    pageEntries: [entry("shared", "fresh"), entry("new-page-id", "brand new")],
    expectedOrder: ["x", "shared", "new-page-id", "y"],
  },
  {
    name: "page-only ids: an empty visible order is replaced by the page's own order",
    order: [],
    entries: new Map(),
    pageEntries: [entry("p1", "one"), entry("p2", "two")],
    expectedOrder: ["p1", "p2"],
  },
  {
    name: "retained older ids: an id the page never mentions keeps its place",
    order: ["old-1", "old-2", "shared"],
    entries: new Map([
      ["old-1", entry("old-1", "kept")],
      ["old-2", entry("old-2", "also kept")],
      ["shared", entry("shared", "stale")],
    ]),
    pageEntries: [entry("shared", "fresh")],
    expectedOrder: ["old-1", "old-2", "shared"],
  },
];

for (const testCase of ORDER_CASES) {
  test(`reconcileAuthoritativeTail order: ${testCase.name}`, () => {
    const result = reconcileAuthoritativeTail({
      order: testCase.order,
      entries: testCase.entries,
      pageEntries: testCase.pageEntries,
      prevCursor: null,
    });
    assert.deepEqual(result.order, testCase.expectedOrder);
  });
}

test("reconcileAuthoritativeTail does not mutate its inputs", () => {
  const order = ["a"];
  const entries = new Map([["a", entry("a", "hello")]]);
  const pageEntries = [entry("a", "hello world")];
  const orderSnapshot = [...order];
  const entriesSnapshot = [...entries];

  reconcileAuthoritativeTail({ order, entries, pageEntries, prevCursor: null });

  assert.deepEqual(order, orderSnapshot, "the order array must not be mutated");
  assert.deepEqual([...entries], entriesSnapshot, "the entries map must not be mutated");
});

test("a page entry with no item_id is ignored — not addressable, so it cannot be merged", () => {
  const result = reconcileAuthoritativeTail({
    order: ["a"],
    entries: new Map([["a", entry("a", "hello")]]),
    pageEntries: [entry("a", "hello world"), { text: "no id here", kind: "agent_text" }],
    prevCursor: null,
  });
  assert.deepEqual(result.order, ["a"], "the id-less page entry contributes no id to order");
  assert.equal(result.entries.size, 1, "the id-less page entry contributes no entry");
  assert.deepEqual(
    result.repaired.map((repairedEntry) => repairedEntry.item_id),
    ["a"],
    "the id-less page entry is also absent from the overlaid page entries"
  );
});

test("an unexpectedly shorter page entry never shortens already-visible text", () => {
  const result = reconcileAuthoritativeTail({
    order: ["a"],
    entries: new Map([["a", entry("a", "hello world, the full message")]]),
    pageEntries: [entry("a", "hello")],
    prevCursor: null,
  });
  assert.equal(
    result.entries.get("a").text,
    "hello world, the full message",
    "the shorter page body must not overwrite the longer cached one"
  );
});

test("a longer page entry replaces a shorter cached one", () => {
  const result = reconcileAuthoritativeTail({
    order: ["a"],
    entries: new Map([["a", entry("a", "hello")]]),
    pageEntries: [entry("a", "hello world, repaired")],
    prevCursor: null,
  });
  assert.equal(result.entries.get("a").text, "hello world, repaired");
});

test("repaired page entries are always in the PAGE's own order, independent of the visible order", () => {
  const result = reconcileAuthoritativeTail({
    order: ["a", "b", "c"],
    entries: new Map([
      ["a", entry("a", "a-old")],
      ["b", entry("b", "b-old")],
      ["c", entry("c", "c-old")],
    ]),
    pageEntries: [entry("c", "c-new"), entry("a", "a-new")],
    prevCursor: null,
  });
  assert.deepEqual(
    result.repaired.map((repairedEntry) => repairedEntry.item_id),
    ["c", "a"],
    "repaired follows the page's own entry order, not the visible order"
  );
});

const REVISION_CASES = [
  { name: "all null -> null", currentRevision: null, pageRevision: null, targetRevision: null, expected: null },
  { name: "only current -> current", currentRevision: 5, pageRevision: null, targetRevision: null, expected: 5 },
  { name: "only page -> page", currentRevision: null, pageRevision: 5, targetRevision: null, expected: 5 },
  { name: "only target -> target", currentRevision: null, pageRevision: null, targetRevision: 5, expected: 5 },
  { name: "page ahead of current -> page", currentRevision: 3, pageRevision: 7, targetRevision: null, expected: 7 },
  { name: "target ahead of both -> target", currentRevision: 3, pageRevision: 4, targetRevision: 9, expected: 9 },
  { name: "current ahead of a stale target -> current", currentRevision: 9, pageRevision: 4, targetRevision: 2, expected: 9 },
  { name: "zero is a real revision, not treated as absent", currentRevision: 0, pageRevision: null, targetRevision: null, expected: 0 },
];

for (const testCase of REVISION_CASES) {
  test(`reconcileAuthoritativeTail revision: ${testCase.name}`, () => {
    const result = reconcileAuthoritativeTail({
      order: [],
      entries: new Map(),
      pageEntries: [],
      currentRevision: testCase.currentRevision,
      pageRevision: testCase.pageRevision,
      targetRevision: testCase.targetRevision,
      prevCursor: null,
    });
    assert.equal(result.revision, testCase.expected);
  });
}

const CURSOR_CASES = [
  {
    name: "no prev_cursor -> not truncated, no older cursor",
    prevCursor: null,
    expectedTruncated: false,
    expectedOlderCursor: null,
  },
  {
    name: "a prev_cursor -> truncated, older cursor recorded",
    prevCursor: "cursor-1",
    expectedTruncated: true,
    expectedOlderCursor: "cursor-1",
  },
  {
    name: "undefined prev_cursor behaves like null",
    prevCursor: undefined,
    expectedTruncated: false,
    expectedOlderCursor: null,
  },
];

for (const testCase of CURSOR_CASES) {
  test(`reconcileAuthoritativeTail truncated/olderCursor: ${testCase.name}`, () => {
    const result = reconcileAuthoritativeTail({
      order: [],
      entries: new Map(),
      pageEntries: [],
      prevCursor: testCase.prevCursor,
    });
    assert.equal(result.truncated, testCase.expectedTruncated);
    assert.equal(result.olderCursor, testCase.expectedOlderCursor);
  });
}

test("a custom mergeEntry override replaces the default never-shorten overlay", () => {
  const calls = [];
  const mergeEntry = (existing, incoming) => {
    calls.push({ existing, incoming });
    return { ...incoming, merged: true };
  };
  const result = reconcileAuthoritativeTail({
    order: ["a"],
    entries: new Map([["a", entry("a", "old")]]),
    pageEntries: [entry("a", "new")],
    prevCursor: null,
    mergeEntry,
  });
  assert.equal(calls.length, 1, "the override must be consulted for every page entry");
  assert.equal(result.entries.get("a").merged, true);
  assert.equal(result.repaired[0].merged, true);
});

// ---------------------------------------------------------------------------
// Keyed ordering: when every row carries a birth number and the window is in
// number order, the split-point guesses above are not needed at all.
// ---------------------------------------------------------------------------

const S = 1 << 20;

function keyed(itemId, orderSeq, overrides = {}) {
  return {
    item_id: itemId,
    order_seq: orderSeq,
    text: itemId,
    kind: "agent_text",
    status: "completed",
    ...overrides,
  };
}

function keyedWindow(...rows) {
  return {
    order: rows.map((row) => row.item_id),
    entries: new Map(rows.map((row) => [row.item_id, row])),
  };
}

test("a keyed page with NO shared id places the window by number instead of guessing", () => {
  // The legacy answer here is "the window cannot be older, so put it below the
  // page". That is a documented guess. The numbers make it a fact, and the fact
  // is different: `a` is older than the page and `live` sits inside it.
  const result = reconcileAuthoritativeTail({
    ...keyedWindow(keyed("a", 0), keyed("live", 2 * S)),
    pageEntries: [keyed("b", S), keyed("c", 3 * S)],
    prevCursor: "older",
  });

  assert.deepEqual(result.order, ["a", "b", "live", "c"]);
  assert.equal(result.truncated, true);
  assert.equal(result.olderCursor, "older");
});

test("a keyed merge still reports `repaired` for exactly the page's rows", () => {
  // Remote feeds `repaired` into syncTranscriptWindowWithRepairedEntries, so a
  // keyed merge that forgot it would silently stop resyncing the window.
  const result = reconcileAuthoritativeTail({
    ...keyedWindow(keyed("a", 0)),
    pageEntries: [keyed("b", S, { text: "fresh b" }), keyed("c", 2 * S)],
    prevCursor: null,
  });

  assert.deepEqual(result.repaired.map((row) => row.item_id), ["b", "c"]);
  assert.equal(result.repaired[0].text, "fresh b");
  assert.equal(result.truncated, false);
});

test("a keyed merge keeps never-shorten text and absorbs a tombstone", () => {
  const result = reconcileAuthoritativeTail({
    ...keyedWindow(
      keyed("a", 0, { text: "a much longer body already on screen" }),
      keyed("w", S, { withdrawn: true })
    ),
    pageEntries: [keyed("a", 0, { text: "short" }), keyed("w", S, { withdrawn: false })],
  });

  assert.equal(result.entries.get("a").text, "a much longer body already on screen");
  assert.equal(result.entries.get("w").withdrawn, true);
});

test("an unnumbered page keeps the legacy split-point behaviour exactly", () => {
  const result = reconcileAuthoritativeTail({
    order: ["live"],
    entries: new Map([["live", entry("live", "streaming now")]]),
    pageEntries: [entry("p1", "page one"), entry("p2", "page two")],
  });

  assert.deepEqual(result.order, ["p1", "p2", "live"]);
});
