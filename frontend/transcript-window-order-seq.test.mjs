// The window's order must be the server's numbering, not transport arrival order.
//
// Phase A gives every row a birth-time `order_seq` and puts it on the snapshot,
// on every page, and on every delta. These are the client-side invariants that
// buys — without them the number is on the wire and nowhere else.
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTranscriptDeltaToWindow,
  createMergedTranscriptHydrationPagePatch,
} from "./shared/transcript-hydration-store.js";

const S = 1 << 20;

function row(itemId, orderSeq, extra = {}) {
  return {
    item_id: itemId,
    order_seq: orderSeq,
    kind: "agent_text",
    text: itemId,
    status: "completed",
    turn_id: "turn-1",
    tool: null,
    ...extra,
  };
}

function windowState(...rows) {
  return {
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map(rows.map((entry) => [entry.item_id, entry])),
    transcriptHydrationOrder: rows.map((entry) => entry.item_id),
  };
}

function delta(itemId, orderSeq, text, extra = {}) {
  return {
    thread_id: "thread-1",
    item_id: itemId,
    order_seq: orderSeq,
    entry_seq: 1,
    delta: text,
    delta_kind: "agent_text",
    text_offset: 0,
    turn_id: "turn-1",
    ...extra,
  };
}

test("a delta records the row's birth number on the window entry", () => {
  // TranscriptDeltaEvent.order_seq is on the wire for exactly this. Dropping it
  // leaves every delta-created row unnumbered, which disqualifies the whole
  // window from the keyed merge path for as long as the thread stays live.
  const state = windowState(row("a", 0));

  applyTranscriptDeltaToWindow(state, delta("b", S, "streaming"));

  assert.equal(
    state.transcriptHydrationEntries.get("b").order_seq,
    S,
    "the delta's order_seq must reach the window entry"
  );
});

test("a delta for a mid-numbered row lands in its slot, not at the tail", () => {
  // Two rows stream concurrently and the EARLIER-born one starts emitting later:
  // the relay numbers at birth, so b belongs between a and c no matter which
  // delta arrives first. A blind tail push renders the conversation out of order.
  const state = windowState(row("a", 0), row("c", 2 * S));

  applyTranscriptDeltaToWindow(state, delta("b", S, "late starter"));

  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["a", "b", "c"],
    "arrival order must not outrank the server's numbering"
  );
});

function pageState(...rows) {
  return {
    ...windowState(...rows),
    transcriptHydrationOlderCursor: "cursor",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
  };
}

test("an older page interleaves by number instead of landing wholesale on top", () => {
  // The legacy prepend is `[...pageIds, ...windowIds]` deduped, so EVERY page row
  // outranks every held row by position alone. That is only right when the page
  // is strictly older than everything held — a guess the numbers make unnecessary.
  const state = pageState(row("b", -S), row("d", S));
  const page = {
    thread_id: "thread-1",
    prev_cursor: null,
    entries: [row("a", -2 * S), row("c", 0)],
  };

  const patch = createMergedTranscriptHydrationPagePatch(state, page, { prepend: true });

  assert.deepEqual(
    patch.transcriptHydrationOrder,
    ["a", "b", "c", "d"],
    "held rows keep their numbered slots between the page's rows"
  );
});

test("an unnumbered older page still prepends wholesale, keeping the legacy guess", () => {
  // An old relay's page carries no numbers, so position is the only information
  // there is. Degrading must mean "the previous algorithm", not "drop the page".
  const unnumbered = (id) => {
    const entry = row(id, 0);
    delete entry.order_seq;
    return entry;
  };
  const state = pageState(unnumbered("c"));
  const page = {
    thread_id: "thread-1",
    prev_cursor: null,
    entries: [unnumbered("a"), unnumbered("b")],
  };

  const patch = createMergedTranscriptHydrationPagePatch(state, page, { prepend: true });

  assert.deepEqual(patch.transcriptHydrationOrder, ["a", "b", "c"]);
});

test("back-filling a number onto a legacy-placed row does not silently promote the window", () => {
  // A row the legacy path appended sits at the tail; a later delta supplies its
  // real number. Recording it is right (position is decided once, and moving a
  // row under the reader is worse), but it leaves the window numbered yet NOT in
  // number order. The gate must see that and keep the next merge on legacy,
  // rather than insert against neighbours that are themselves misplaced.
  const unnumberedB = row("b", 0);
  delete unnumberedB.order_seq;
  const state = pageState(row("a", 0), row("c", 2 * S), unnumberedB);

  // Contiguous append: the held row's text is "b", so this delta starts at 1.
  applyTranscriptDeltaToWindow(state, delta("b", S, " more", { text_offset: 1 }));

  assert.equal(state.transcriptHydrationEntries.get("b").order_seq, S, "the number is recorded");
  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["a", "c", "b"],
    "but the row is not moved out from under the reader"
  );

  const patch = createMergedTranscriptHydrationPagePatch(
    state,
    { thread_id: "thread-1", prev_cursor: null, entries: [row("p1", -S), row("p2", 3 * S / 2)] },
    { prepend: true }
  );

  assert.deepEqual(
    patch.transcriptHydrationOrder,
    ["p1", "p2", "a", "c", "b"],
    "an out-of-order window stays on the legacy path instead of being trusted as keyed"
  );
});

test("an unnumbered delta still appends, so an old relay degrades instead of breaking", () => {
  const state = windowState(row("a", 0));

  applyTranscriptDeltaToWindow(state, { ...delta("b", undefined, "no number"), order_seq: undefined });

  assert.deepEqual(state.transcriptHydrationOrder, ["a", "b"]);
});
