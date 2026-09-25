// P2 perf regression (see markdown/transcript-perf-freeze-analysis.md).
//
// The reported tab-freeze root cause: every streaming snapshot rebuilt the
// ENTIRE hydrated window — `new Map(allEntries)` + `[...allOrder]` + `order.map`
// in both `createMergedSnapshotTailPatch` (prepare) and
// `buildHydratedTranscriptSnapshot` (restore) — which is O(n) per snapshot and
// saturates the main thread once a thread's window is large (scrolled up / long
// session). These tests pin the invariant that the steady-state per-snapshot
// path touches only the ~tail, not the whole window.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createClearedTranscriptHydrationPatch,
  invalidateTranscriptWindowEntryForPatch,
  prepareTranscriptHydrationState,
  renderedTranscriptFromWindow,
  restoreHydratedTranscriptSnapshot,
  __readTranscriptArrayFallbackLookupBuildCount,
  __readTranscriptFullWindowCopyCount,
  __resetTranscriptArrayFallbackLookupBuildCount,
  __resetTranscriptFullWindowCopyCount,
} from "./shared/transcript-hydration-store.js";

const BODY = "x".repeat(120);
const entry = (i) => ({
  item_id: `item-${i}`,
  kind: i % 3 === 0 ? "user_text" : "agent_text",
  text: `msg ${i} ${BODY}`,
  status: "completed",
  turn_id: `turn-${i}`,
  tool: null,
  content_state: "full",
});

// A large, fully-scrolled hydrated window (what scroll-up builds).
function hydratedState(n) {
  const ids = Array.from({ length: n }, (_, i) => `item-${i}`);
  return {
    ...createClearedTranscriptHydrationPatch(),
    session: { active_thread_id: "t1", transcript_revision: n },
    transcriptHydrationEntries: new Map(ids.map((id, i) => [id, entry(i)])),
    transcriptHydrationOrder: [...ids],
    transcriptHydrationOlderCursor: "c1",
    transcriptHydrationSignature: "t1|sig",
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "t1",
    transcriptHydrationBaseSnapshot: { active_thread_id: "t1" },
  };
}

// One streaming snapshot for an already-hydrated thread: a compact tail of ~6
// entries whose last entry keeps growing (re-merged each tick).
function streamingSnapshot(n, tick) {
  const tail = [];
  for (let i = Math.max(0, n - 6); i < n; i += 1) tail.push(entry(i));
  // The last entry "grows" each tick: the cached body plus appended text, so it
  // is strictly longer (the realistic streaming-append shape the merge prefers).
  tail[tail.length - 1] = {
    ...entry(n - 1),
    text: `${entry(n - 1).text} grow ${tick} ${"y".repeat(tick + 8)}`,
  };
  return {
    active_thread_id: "t1",
    active_turn_id: "turn-stream",
    transcript_revision: n + tick,
    transcript_truncated: true,
    transcript: tail,
  };
}

test("a steady-state streaming snapshot does not copy the whole hydrated window", () => {
  const n = 5000;
  const state = hydratedState(n);
  __resetTranscriptFullWindowCopyCount();

  const ticks = 25;
  for (let t = 0; t < ticks; t += 1) {
    const snap = streamingSnapshot(n, t);
    // restore (immediate render overlay) + prepare (tail merge) — the two paths
    // that used to clone the full window every snapshot.
    restoreHydratedTranscriptSnapshot(state, snap);
    const prepared = prepareTranscriptHydrationState(state, snap);
    if (prepared.patch) Object.assign(state, prepared.patch);
  }

  assert.equal(
    __readTranscriptFullWindowCopyCount(),
    0,
    "the per-snapshot path must touch only the tail, never copy the full window"
  );
});

test("per-snapshot work stays bounded as the window grows (no O(n) regression)", () => {
  // The full window is copied at most a tiny constant number of times across the
  // whole run regardless of n, so the per-snapshot cost no longer scales with
  // the loaded history depth.
  for (const n of [1000, 20000]) {
    const state = hydratedState(n);
    __resetTranscriptFullWindowCopyCount();
    for (let t = 0; t < 10; t += 1) {
      const snap = streamingSnapshot(n, t);
      restoreHydratedTranscriptSnapshot(state, snap);
      const prepared = prepareTranscriptHydrationState(state, snap);
      if (prepared.patch) Object.assign(state, prepared.patch);
    }
    assert.equal(
      __readTranscriptFullWindowCopyCount(),
      0,
      `window n=${n}: steady-state snapshots must not copy the full window`
    );
  }
});

// P1 (review): renderedTranscriptFromWindow's array-fallback for an
// invalidated/absent window entry (invalidateTranscriptWindowEntryForPatch —
// see .sealwire/PLAN.md, "Invalidate; do not write") builds a lookup Map from
// the CURRENT array in ONE linear pass, not a `.find()` per window entry —
// the latter would turn every settle into O(window * array) instead of
// O(window + array). Proved with a counter that totals ARRAY ENTRIES VISITED
// (transcriptArrayFallbackLookupBuildCount), not wall time: it must equal
// exactly (calls * array length) at both 1k and 20k — a per-window-entry
// `.find()` would instead multiply that by the window length too, since it
// re-scans the whole array for every window entry.
test("the array-fallback lookup scans the array once per call as the window grows 1k -> 20k, not once per window entry", () => {
  for (const n of [1000, 20000]) {
    const state = hydratedState(n);
    // Invalidate one entry so every call actually exercises the fallback
    // path (a no-op invalidate would let the fast "no array-only ids, no
    // untrusted entries" path hide a regression).
    invalidateTranscriptWindowEntryForPatch(state, "t1", { item_id: "item-0" });
    const session = {
      active_thread_id: "t1",
      transcript: Array.from({ length: n }, (_, i) => entry(i)),
    };
    __resetTranscriptArrayFallbackLookupBuildCount();

    const calls = 10;
    let lastProjected = null;
    for (let i = 0; i < calls; i += 1) {
      lastProjected = renderedTranscriptFromWindow(state, session);
    }

    assert.equal(
      __readTranscriptArrayFallbackLookupBuildCount(),
      calls * n,
      `window n=${n}: the array must be scanned exactly once per call (${calls} calls * ${n} entries), ` +
        "not once per window entry per call"
    );
    assert.equal(
      lastProjected.find((e) => e.item_id === "item-0").text,
      session.transcript[0].text,
      "the invalidated entry must still resolve correctly via the array fallback"
    );
  }
});

test("the streaming tail still merges correctly without a full-window copy", () => {
  const n = 200;
  const state = hydratedState(n);
  const snap = streamingSnapshot(n, 7);
  const prepared = prepareTranscriptHydrationState(state, snap);
  if (prepared.patch) Object.assign(state, prepared.patch);

  // The growing tail entry's new text landed, and the window is intact + ordered.
  assert.equal(state.transcriptHydrationOrder.length, n);
  assert.match(state.transcriptHydrationEntries.get(`item-${n - 1}`).text, / grow 7 /);
  assert.equal(state.transcriptHydrationEntries.get("item-0").text, `msg 0 ${BODY}`);

  const merged = restoreHydratedTranscriptSnapshot(state, snap);
  assert.equal(merged.transcript.length, n);
  assert.equal(merged.transcript[0].item_id, "item-0");
  assert.equal(merged.transcript.at(-1).item_id, `item-${n - 1}`);
});
