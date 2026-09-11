// The window's order must be the server's numbering, not transport arrival order.
//
// Phase A gives every row a birth-time `order_seq` and puts it on the snapshot,
// on every page, and on every delta. These are the client-side invariants that
// buys — without them the number is on the wire and nowhere else.
import test from "node:test";
import assert from "node:assert/strict";

import {
  __readWindowInsertionProbeCount,
  __resetWindowInsertionProbeCount,
} from "./shared/transcript-window-reducer.js";
import {
  __readTranscriptFullWindowCopyCount,
  __resetTranscriptFullWindowCopyCount,
  applyTranscriptDeltaToWindow,
  createClearedTranscriptHydrationPatch,
  createMergedTranscriptHydrationPagePatch,
  prepareTranscriptHydrationState,
  renderedTranscriptFromWindow,
  restoreHydratedTranscriptSnapshot,
  restoreTranscriptHydrationForThread,
  stashTranscriptHydrationForThread,
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

// Derives the cached proof from the fixture rather than asserting it, so a
// fixture with an unnumbered or out-of-order row cannot quietly claim to be
// keyed — which is exactly the state these tests exist to distinguish.
function fixtureIsKeyed(rows) {
  let previous = null;
  for (const entry of rows) {
    if (!Number.isSafeInteger(entry.order_seq)) return false;
    if (previous != null && entry.order_seq < previous) return false;
    previous = entry.order_seq;
  }
  return true;
}

function windowState(...rows) {
  return {
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map(rows.map((entry) => [entry.item_id, entry])),
    transcriptHydrationOrder: rows.map((entry) => entry.item_id),
    transcriptHydrationKeyed: fixtureIsKeyed(rows),
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

test("an authoritative tail page interleaves a live row by number", () => {
  // The legacy tail merge splits the window at the page's first known id:
  // everything before stays above the page, everything after stays below. A live
  // delta row that belongs BETWEEN two page rows has no such split point, and
  // when the page and window share no id at all the whole window is declared
  // "newer" and pushed below the page — a guess the numbers make unnecessary.
  const state = pageState(row("a", 0), row("live", 2 * S));
  const page = {
    thread_id: "thread-1",
    prev_cursor: "older-cursor",
    entries: [row("b", S), row("c", 3 * S)],
  };

  const patch = createMergedTranscriptHydrationPagePatch(state, page, { prepend: false });

  assert.deepEqual(patch.transcriptHydrationOrder, ["a", "b", "live", "c"]);
  assert.equal(patch.transcriptHydrationOlderCursor, "older-cursor", "cursor still comes from the page");
  assert.equal(patch.transcriptHydrationStatus, "idle");
  assert.equal(patch.transcriptHydrationTailReady, true);
});

test("the keyed tail page keeps the never-shorten text rule and the tombstone", () => {
  // The tail path's whole job is content repair, so the keyed branch has to carry
  // mergeTranscriptEntry's rules, not just place rows.
  const held = row("a", 0, { text: "a much longer body already on screen" });
  const withdrawnRow = row("w", S, { withdrawn: true });
  const state = pageState(held, withdrawnRow);
  const page = {
    thread_id: "thread-1",
    prev_cursor: null,
    entries: [row("a", 0, { text: "short" }), row("w", S, { withdrawn: false })],
  };

  const patch = createMergedTranscriptHydrationPagePatch(state, page, { prepend: false });

  assert.equal(
    patch.transcriptHydrationEntries.get("a").text,
    "a much longer body already on screen",
    "an unexpectedly short page entry must not shorten visible text"
  );
  assert.equal(
    patch.transcriptHydrationEntries.get("w").withdrawn,
    true,
    "a page copy serialized before the withdrawal must not resurrect the row"
  );
  assert.equal(patch.transcriptHydrationStatus, "complete", "prev_cursor null completes the window");
});

test("an out-of-order window is repaired once the authoritative tail covers it", () => {
  // The isolation rule has to have a way out: a window that went out of order is
  // refused by the keyed gate, but an authoritative page that carries every row
  // is the whole window, so the page's own order becomes the window's.
  const outOfOrder = {
    ...pageState(row("a", 0), row("c", 2 * S), row("b", S)),
    transcriptHydrationOrder: ["a", "c", "b"],
  };
  const page = {
    thread_id: "thread-1",
    prev_cursor: null,
    entries: [row("a", 0), row("b", S), row("c", 2 * S)],
  };

  const patch = createMergedTranscriptHydrationPagePatch(outOfOrder, page, { prepend: false });

  assert.deepEqual(patch.transcriptHydrationOrder, ["a", "b", "c"]);
});

// The snapshot tail merge anchors a new tail id against ids it already holds,
// which cannot see that a live row the tail does NOT carry belongs between two
// tail rows. It runs on every snapshot, so the keyed gate here is the cached
// `transcriptHydrationKeyed` proof rather than an O(window) re-scan.
test("a snapshot tail places a new row by number, around a live row it does not carry", () => {
  const state = {
    ...pageState(row("a", 0), row("live", 2 * S, { status: "running" })),
    session: { active_thread_id: "thread-1", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationSignature: "thread-1|turn-1|stale",
    transcriptHydrationStatus: "complete",
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
  };
  const prepared = prepareTranscriptHydrationState(state, {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [row("b", S), row("c", 3 * S)],
  });
  Object.assign(state, prepared.patch);

  assert.deepEqual(state.transcriptHydrationOrder, ["a", "b", "live", "c"]);
});

test("the restore projection reports the same numbered order it writes into the window", () => {
  // buildHydratedTranscriptSnapshot is the projection half of the same snapshot
  // and places tail ids independently. Left positional it returned one order to
  // the renderer while the window merge stored another.
  const state = {
    ...pageState(row("a", 0), row("live", 2 * S, { status: "running" })),
    session: { active_thread_id: "thread-1", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationSignature: "thread-1|turn-1|stale",
    transcriptHydrationStatus: "complete",
    transcriptHydrationOlderCursor: null,
  };

  const rendered = restoreHydratedTranscriptSnapshot(state, {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [row("b", S), row("c", 3 * S)],
  });

  assert.deepEqual(rendered.transcript.map((entry) => entry.item_id), ["a", "b", "live", "c"]);
  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["a", "b", "live", "c"],
    "the window it wrote into must agree with what it rendered"
  );
});

test("a patch-introduced array-only row projects by number, not at the end", () => {
  // reduceTranscriptEntryPatchEvent deliberately leaves an untracked patch row
  // array-only, so renderedTranscriptFromWindow is where it gets a position.
  const state = pageState(row("a", 0), row("live", 2 * S));
  const session = {
    active_thread_id: "thread-1",
    transcript: [row("a", 0), row("b", S), row("live", 2 * S)],
  };

  const rendered = renderedTranscriptFromWindow(state, session);

  assert.deepEqual(rendered.map((entry) => entry.item_id), ["a", "b", "live"]);
});

test("an unnumbered array-only row still projects positionally", () => {
  const unnumbered = { item_id: "b", kind: "agent_text", text: "b", status: "completed" };
  const state = pageState(row("a", 0), row("live", 2 * S));
  const session = {
    active_thread_id: "thread-1",
    transcript: [row("a", 0), unnumbered, row("live", 2 * S)],
  };

  const rendered = renderedTranscriptFromWindow(state, session);

  assert.deepEqual(
    rendered.map((entry) => entry.item_id),
    ["a", "live", "b"],
    "with no number to place it by, the legacy anchor-then-append is all there is"
  );
});

test("the cached proof cannot go stale across the window lifecycle", () => {
  // The proof is only useful if it is impossible to carry a true value onto a
  // window that no longer earns it. Each transition is checked explicitly.
  assert.equal(
    createClearedTranscriptHydrationPatch().transcriptHydrationKeyed,
    true,
    "an empty window is trivially keyed"
  );

  // An unnumbered live row revokes it.
  const live = windowState(row("a", 0));
  assert.equal(live.transcriptHydrationKeyed, true);
  applyTranscriptDeltaToWindow(live, { ...delta("b", undefined, "no number"), order_seq: undefined });
  assert.equal(live.transcriptHydrationKeyed, false, "an unnumbered row revokes the proof");

  // A numbered one does not.
  const keyed = windowState(row("a", 0));
  applyTranscriptDeltaToWindow(keyed, delta("b", S, "numbered"));
  assert.equal(keyed.transcriptHydrationKeyed, true, "a numbered row preserves it");

  // Stash/restore round-trips the proof rather than assuming it.
  const stashState = { ...windowState(row("a", 0)), transcriptHydrationThreadId: "t1" };
  stashState.transcriptHydrationKeyed = false;
  stashTranscriptHydrationForThread(stashState);
  const restored = restoreTranscriptHydrationForThread(stashState, "t1");
  assert.equal(restored.transcriptHydrationKeyed, false, "an unproven window restores unproven");
});

test("the keyed snapshot path costs the tail, not the window", () => {
  // The reason the proof is cached rather than recomputed. A per-snapshot
  // windowIsOrderKeyed (or a full-window copy) would be O(window) on the hottest
  // path in the app — the freeze markdown/transcript-perf-freeze-analysis.md
  // documents. Asserted with the counters, not a clock.
  const windowSize = 4000;
  const held = Array.from({ length: windowSize }, (_, i) => row(`w${i}`, i * S));
  const state = {
    ...pageState(...held),
    session: { active_thread_id: "thread-1", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationSignature: "thread-1|turn-1|stale",
    transcriptHydrationStatus: "complete",
    transcriptHydrationOlderCursor: null,
  };
  const orderBefore = state.transcriptHydrationOrder;

  __resetTranscriptFullWindowCopyCount();
  __resetWindowInsertionProbeCount();
  // A steady-state snapshot: every tail id is already ordered, plus one new row
  // at the very end — the ordinary streaming case.
  const prepared = prepareTranscriptHydrationState(state, {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [
      held[windowSize - 2],
      held[windowSize - 1],
      row("fresh", windowSize * S),
    ],
  });
  Object.assign(state, prepared.patch);

  assert.equal(state.transcriptHydrationOrder[windowSize], "fresh", "the new row is placed");
  assert.equal(state.transcriptHydrationKeyed, true, "and the window is still proven");
  assert.equal(
    __readTranscriptFullWindowCopyCount(),
    0,
    "no per-snapshot full-window copy"
  );
  assert.ok(
    __readWindowInsertionProbeCount() < 16,
    `a tail row costs O(1), not O(window): ${__readWindowInsertionProbeCount()} probes`
  );
  assert.equal(state.transcriptHydrationOrder, orderBefore, "the order array is mutated, not rebuilt");
});

test("two new rows in ONE restore snapshot keep their relative order", () => {
  // The relay publishes an ask-user card and the message after it under one
  // write lock, so both are new to the window in the same snapshot. The restore
  // projection merges them into an `overlay` that `baseEntries` does not receive
  // until afterwards, so resolving a neighbour against `baseEntries` reported
  // "unnumbered" for the row placed one iteration earlier — and the second row
  // was walked over it. The card rendered BELOW its own trailing message.
  const state = {
    ...pageState(row("a", 0)),
    session: { active_thread_id: "thread-1", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationSignature: "thread-1|turn-1|stale",
    transcriptHydrationStatus: "complete",
    transcriptHydrationOlderCursor: null,
  };

  const rendered = restoreHydratedTranscriptSnapshot(state, {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [row("ask", S), row("trailing", 2 * S)],
  });

  assert.deepEqual(
    rendered.transcript.map((entry) => entry.item_id),
    ["a", "ask", "trailing"],
    "the card stays above the message published alongside it"
  );
  assert.deepEqual(state.transcriptHydrationOrder, ["a", "ask", "trailing"]);
});
