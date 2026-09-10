// A snapshot carrying a new generation lands on `state.session` BEFORE the window is
// rebuilt (local renders coalesce frames). In that gap the window still holds the
// previous run's ids — and both the delta writer and the render projection gate on
// `transcriptWindowIsLoaded`. If that only checks the thread, a new-run delta writes
// into the old-run window and the message it names appears twice.
import test from "node:test";
import assert from "node:assert/strict";

import { transcriptWindowIsLoaded } from "./shared/transcript-hydration-store.js";

function windowHolding(windowGeneration, sessionGeneration) {
  return {
    session: { active_thread_id: "t1", transcript_generation: sessionGeneration },
    transcriptHydrationThreadId: "t1",
    transcriptHydrationGeneration: windowGeneration,
    transcriptHydrationEntries: new Map([["i1", { item_id: "i1" }]]),
    transcriptHydrationOrder: ["i1"],
  };
}

test("a window from the previous run is not writable or projectable", () => {
  assert.equal(transcriptWindowIsLoaded(windowHolding("gen-a", "gen-b"), "t1"), false);
});

test("a window from the live run still is", () => {
  assert.equal(transcriptWindowIsLoaded(windowHolding("gen-b", "gen-b"), "t1"), true);
});

test("a relay too old to name its run is unaffected", () => {
  assert.equal(transcriptWindowIsLoaded(windowHolding("", ""), "t1"), true);
});

test("a window built before the relay learned to name its run is refused", () => {
  assert.equal(transcriptWindowIsLoaded(windowHolding("", "gen-b"), "t1"), false);
});
