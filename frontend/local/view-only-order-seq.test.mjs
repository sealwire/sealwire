// The view-only pin holds its rows as a plain array, so it grew its own ordering
// guesses: dedupe-and-prepend for older pages, and for a refresh a three-stage
// fallback (intersect by id, else compare entry_seq, else drop the reader's
// history). When the rows carry birth numbers none of that guessing is needed.
import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeOlderViewOnlyPage,
  mergeRefreshedViewOnlyPage,
} from "./view-only-thread.js";

const S = 1 << 20;

function row(itemId, orderSeq, extra = {}) {
  return { item_id: itemId, order_seq: orderSeq, kind: "agent_text", text: itemId, ...extra };
}

function pin(entries, extra = {}) {
  return {
    threadId: "A",
    entries,
    historyExtended: false,
    olderCursor: null,
    ...extra,
  };
}

test("an older view-only page interleaves by number", () => {
  // Legacy is `[...pageRowsNotAlreadyHeld, ...pinRows]`, so every page row
  // outranks every held row by position alone.
  const merged = mergeOlderViewOnlyPage(pin([row("b", -S), row("d", S)]), {
    thread_id: "A",
    entries: [row("a", -2 * S), row("c", 0)],
    prev_cursor: 7,
  });

  assert.deepEqual(merged.entries.map((entry) => entry.item_id), ["a", "b", "c", "d"]);
  assert.equal(merged.historyExtended, true);
  assert.equal(merged.olderCursor, 7, "cursor still comes from the page");
});

test("a refresh that shares no id keeps the reader's rows instead of dropping them", () => {
  // The three-stage fallback: no shared id, and these rows carry no entry_seq,
  // so the legacy path cannot localize the page and takes it ALONE — the
  // reader's paged-in history and the live row below it both vanish. The birth
  // numbers say exactly where everything goes.
  const merged = mergeRefreshedViewOnlyPage(
    pin([row("a", 0), row("live", 2 * S)], { historyExtended: true, olderCursor: 3 }),
    { thread_id: "A", entries: [row("b", S), row("c", 3 * S)], prev_cursor: 9 }
  );

  assert.deepEqual(
    merged.entries.map((entry) => entry.item_id),
    ["a", "b", "live", "c"],
    "the page is authoritative for its own rows, not for where everything else sits"
  );
  assert.equal(merged.olderCursor, 3, "extended history keeps the pin's cursor");
});

test("a keyed refresh still absorbs a tombstone the page predates", () => {
  const merged = mergeRefreshedViewOnlyPage(
    pin([row("a", 0), row("w", S, { withdrawn: true })]),
    { thread_id: "A", entries: [row("a", 0), row("w", S)], prev_cursor: null }
  );

  const withdrawn = merged.entries.find((entry) => entry.item_id === "w");
  assert.equal(withdrawn.withdrawn, true, "a page copy must not resurrect a withdrawn row");
});

test("without extended history a keyed refresh still bounds the window", () => {
  // The bound the historyExtended gate exists for: transport pages are
  // byte-sized while adjacent tool calls collapse into one visual row, so a
  // reader who never scrolled must not accumulate every older page forever.
  // Placing rows by number must not quietly turn that bound off.
  const merged = mergeRefreshedViewOnlyPage(
    pin([row("old", -5 * S), row("live", 2 * S)], { historyExtended: false }),
    { thread_id: "A", entries: [row("b", S), row("c", 3 * S)], prev_cursor: 9 }
  );

  assert.deepEqual(
    merged.entries.map((entry) => entry.item_id),
    ["b", "live", "c"],
    "rows older than the page are not retained when history was never extended"
  );
  assert.equal(merged.historyExtended, false);
  assert.equal(merged.olderCursor, 9, "and the cursor comes from the page");
});

test("unnumbered pins keep every legacy rule", () => {
  const wrongThread = mergeOlderViewOnlyPage(pin([{ item_id: "e2" }]), {
    thread_id: "OTHER",
    entries: [{ item_id: "x" }],
    prev_cursor: null,
  });
  assert.equal(wrongThread.entries.length, 1, "a wrong-thread page is ignored");

  const emptyPage = mergeRefreshedViewOnlyPage(pin([{ item_id: "keep" }]), {
    thread_id: "A",
    entries: [],
  });
  assert.deepEqual(
    emptyPage.entries.map((entry) => entry.item_id),
    ["keep"],
    "an empty page must never wipe the conversation"
  );
});
