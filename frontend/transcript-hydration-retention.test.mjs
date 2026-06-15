// P2: per-thread hydration window retention across thread switches.
//
// Switching to another thread and back used to reload only the tail (the loaded
// older window was lost). These tests pin the store-level contract: leaving a
// thread stashes its hydrated window, and returning restores it instantly
// (entries + order + older cursor + tail-ready), bounded by an LRU cap.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createClearedTranscriptHydrationPatch,
  stashTranscriptHydrationForThread,
  restoreTranscriptHydrationForThread,
  clearTranscriptHydrationThreadCache,
  MAX_RETAINED_HYDRATION_THREADS,
} from "./shared/transcript-hydration-store.js";

function entry(id, text) {
  return {
    item_id: id,
    kind: "agent_text",
    text,
    status: "completed",
    turn_id: `turn-${id}`,
    tool: null,
    content_state: "full",
  };
}

function hydratedThreadState(threadId, ids, { olderCursor = 7, tailReady = true } = {}) {
  return {
    ...createClearedTranscriptHydrationPatch(),
    transcriptHydrationEntries: new Map(ids.map((id) => [id, entry(id, `body-${id}`)])),
    transcriptHydrationOrder: [...ids],
    transcriptHydrationOlderCursor: olderCursor,
    transcriptHydrationSignature: `${threadId}|sig`,
    transcriptHydrationTailReady: tailReady,
    transcriptHydrationThreadId: threadId,
    transcriptHydrationStatus: tailReady ? "complete" : "idle",
  };
}

test("leaving a thread stashes its window; returning restores it instantly", () => {
  const state = hydratedThreadState("thread-A", ["a1", "a2", "a3"], { olderCursor: 12 });

  // Leave A (stash) then switch to B (cleared slot).
  stashTranscriptHydrationForThread(state);
  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-B"));
  assert.equal(state.transcriptHydrationThreadId, "thread-B");
  assert.deepEqual(state.transcriptHydrationOrder, [], "B has no retained window yet");

  // Switch back to A: the loaded window is restored, not just the tail.
  stashTranscriptHydrationForThread(state); // stash B (empty → no-op)
  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-A"));

  assert.equal(state.transcriptHydrationThreadId, "thread-A");
  assert.deepEqual(state.transcriptHydrationOrder, ["a1", "a2", "a3"]);
  assert.equal(state.transcriptHydrationOlderCursor, 12);
  assert.equal(state.transcriptHydrationTailReady, true);
  assert.equal(state.transcriptHydrationEntries.get("a2").text, "body-a2");
});

test("restoring a thread with no stash yields a cleared slot", () => {
  const state = hydratedThreadState("thread-A", ["a1"]);
  Object.assign(state, restoreTranscriptHydrationForThread(state, "never-seen"));
  assert.equal(state.transcriptHydrationThreadId, "never-seen");
  assert.deepEqual(state.transcriptHydrationOrder, []);
  assert.equal(state.transcriptHydrationEntries.size, 0);
  assert.equal(state.transcriptHydrationTailReady, false);
});

test("the per-thread stash is bounded by an LRU cap", () => {
  assert.ok(MAX_RETAINED_HYDRATION_THREADS >= 4, "cap should retain a usable history depth");
  const state = hydratedThreadState("thread-0", ["x0"]);

  const total = MAX_RETAINED_HYDRATION_THREADS + 3;
  for (let index = 0; index < total; index += 1) {
    // Stash the current thread, then move to the next one.
    stashTranscriptHydrationForThread(state);
    Object.assign(state, restoreTranscriptHydrationForThread(state, `thread-${index + 1}`));
    // Give the newly-entered thread a window so it is stashable next iteration.
    state.transcriptHydrationEntries = new Map([[`x${index + 1}`, entry(`x${index + 1}`, "b")]]);
    state.transcriptHydrationOrder = [`x${index + 1}`];
  }

  // The earliest threads were evicted; the most recent ones are retained.
  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-0"));
  assert.deepEqual(state.transcriptHydrationOrder, [], "the oldest thread was evicted by the LRU cap");
});

test("a stash is independent of later live mutations to the active slot", () => {
  const state = hydratedThreadState("thread-A", ["a1", "a2"]);
  stashTranscriptHydrationForThread(state);
  // Mutate the live slot after stashing (as live deltas/snapshots would).
  state.transcriptHydrationEntries.set("a2", entry("a2", "MUTATED"));
  state.transcriptHydrationOrder.push("a3");

  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-B"));
  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-A"));

  // The restored window reflects the stash taken at leave-time, not the later
  // mutation of the (since-reused) live slot.
  assert.deepEqual(state.transcriptHydrationOrder, ["a1", "a2"]);
  assert.equal(state.transcriptHydrationEntries.get("a2").text, "body-a2");
});

test("a genuine reset drops every retained window so stale history can't resurface", () => {
  const state = hydratedThreadState("thread-A", ["a1", "a2"]);
  stashTranscriptHydrationForThread(state);
  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-B"));

  // A full teardown (disconnect / unpair) must forget retained windows.
  clearTranscriptHydrationThreadCache(state);

  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-A"));
  assert.deepEqual(
    state.transcriptHydrationOrder,
    [],
    "thread-A's window must not survive a genuine reset"
  );
});
