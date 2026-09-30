// Store-level coverage for how a non-delta entry patch (started/completed/
// patched: status, tool, or a text REPLACEMENT) interacts with the hydration
// window. A patch can never safely write the window itself (no text_offset to
// reconcile a future delta against) and, after four straight attempts each
// shipping a new P1, may not live in a side store either (a `transcriptPatchOverlay` map — now
// deleted). Replaces frontend/transcript-patch-overlay.test.mjs, which pinned
// that deleted mechanism's own contract; this file pins its replacement's.
//
// Surface-level reproductions of the P1s this prevents live in
// frontend/remote/session-ops.test.mjs and frontend/local/session-stream.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyTranscriptDeltaToWindow,
  invalidateTranscriptWindowEntryForPatch,
  prepareTranscriptHydrationState,
  renderedTranscriptFromWindow,
} from "./shared/transcript-hydration-store.js";

function loadedWindowState(threadId, entries) {
  return {
    transcriptHydrationThreadId: threadId,
    transcriptHydrationEntries: new Map(entries.map((entry) => [entry.item_id, entry])),
    transcriptHydrationOrder: entries.map((entry) => entry.item_id),
  };
}

test("invalidateTranscriptWindowEntryForPatch is a no-op on an empty (unloaded) window — it must never be what makes the window look loaded", () => {
  const state = {
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map(),
    transcriptHydrationOrder: [],
  };

  const changed = invalidateTranscriptWindowEntryForPatch(state, "thread-1", {
    item_id: "item-1",
    status: "completed",
    text: "done",
  });

  assert.equal(changed, false);
  assert.equal(state.transcriptHydrationOrder.length, 0);
  assert.equal(state.transcriptHydrationEntries.size, 0);
});

test("invalidateTranscriptWindowEntryForPatch is a no-op for an item the window has never tracked, even when the window IS loaded for other items", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "hi", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);

  invalidateTranscriptWindowEntryForPatch(state, "thread-1", { item_id: "item-2", status: "completed", text: "done" });

  assert.equal(state.transcriptHydrationOrder.includes("item-2"), false);
  assert.equal(state.transcriptHydrationEntries.has("item-2"), false);
});

test("invalidateTranscriptWindowEntryForPatch downgrades content_state and blanks the cached text of a tracked full entry", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "Hello", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);

  const changed = invalidateTranscriptWindowEntryForPatch(state, "thread-1", { item_id: "item-1", status: "completed", text: "Jello" });

  assert.equal(changed, true);
  const entry = state.transcriptHydrationEntries.get("item-1");
  assert.equal(entry.content_state, "preview", "no longer trusted as authoritative");
  assert.equal(entry.text, "", "the pre-patch body must not survive as the base for a future delta's offset math");
  assert.equal(entry.status, "running", "the patch's OWN fields never land in the window — only the caller's array carries them");
});

test("invalidateTranscriptWindowEntryForPatch is a true no-op for an entry that is already blanked and non-full", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "", status: "running", turn_id: "turn-1", tool: null, content_state: "omitted" },
  ]);

  const changed = invalidateTranscriptWindowEntryForPatch(state, "thread-1", { item_id: "item-1", status: "completed" });

  assert.equal(changed, false);
  assert.equal(state.transcriptHydrationEntries.get("item-1").content_state, "omitted");
});

// P1 (review): a status-only patch (completion with no body of its own) used
// to no-op against a PREVIEW/OMITTED entry, on the theory that it was already
// untrusted. But "untrusted" only gates renderedTranscriptFromWindow's own
// projection — it does nothing to stop applyTranscriptDeltaToWindow's merge
// branch (line ~906 above), which reads the cached TEXT regardless of
// content_state. Left in place, a truncated preview's stale text becomes the
// base a later delta's offset is checked against; if that later delta's
// offset happens to match the stale length (a coalesced/re-sent chunk, or
// just the next chunk of the real stream picking up where the truncated
// preview left off), the merge accepts it as a contiguous append and marks
// the result CONTENT_STATE_FULL — silently making the preview's truncated
// prefix authoritative and permanently suppressing the real hydration fetch.
// Blanking the text here (not just downgrading content_state) closes that:
// the next delta then sees `have = 0` against a non-zero offset, which is a
// gap, not a match.
test("a status-only patch against a TRUNCATED (preview) entry must blank its stale text too, or a later delta can silently promote it to full", () => {
  const state = loadedWindowState("thread-1", [
    {
      item_id: "item-1",
      kind: "agent_text",
      text: "The quick brown fox truncated at some point...",
      status: "running",
      turn_id: "turn-1",
      tool: null,
      content_state: "preview",
    },
  ]);

  const changed = invalidateTranscriptWindowEntryForPatch(state, "thread-1", {
    item_id: "item-1",
    status: "completed",
  });

  assert.equal(changed, true);
  const entry = state.transcriptHydrationEntries.get("item-1");
  assert.equal(entry.text, "", "stale preview text must not survive as a future delta's offset base");
  assert.equal(entry.content_state, "preview");

  // Prove the failure mode this closes: a delta whose offset matches the
  // OLD preview text's length must now be refused as a gap instead of
  // silently accepted and promoted to full.
  const applied = applyTranscriptDeltaToWindow(state, {
    item_id: "item-1",
    thread_id: "thread-1",
    delta: " continued",
    text_offset: 48,
  });
  assert.equal(applied, false, "must be refused as a gap, not merged onto the stale pre-patch text");
  assert.equal(state.transcriptHydrationEntries.get("item-1").content_state, "preview", "must not have been promoted to full");
});

test("renderedTranscriptFromWindow falls back to the array's current entry once the window copy is invalidated", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "Hello", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);
  invalidateTranscriptWindowEntryForPatch(state, "thread-1", { item_id: "item-1", status: "completed", text: "Jello" });

  const session = {
    active_thread_id: "thread-1",
    transcript: [
      { item_id: "item-1", kind: "agent_text", text: "Jello", status: "completed", turn_id: "turn-1", tool: { name: "done" } },
    ],
  };
  const projected = renderedTranscriptFromWindow(state, session);

  assert.equal(projected[0].text, "Jello");
  assert.equal(projected[0].status, "completed");
  assert.deepEqual(projected[0].tool, { name: "done" });
  // The window's own cache is untouched by the fallback — only the
  // projection reads through to the array.
  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "");
});

test("renderedTranscriptFromWindow folds in an item the window has never tracked, from the array, instead of dropping it", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "hi", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);
  const session = {
    active_thread_id: "thread-1",
    transcript: [
      { item_id: "item-1", kind: "agent_text", text: "hi", status: "running", turn_id: "turn-1", tool: null },
      { item_id: "item-2", kind: "agent_text", text: "brand new", status: "completed", turn_id: "turn-2", tool: null },
    ],
  };

  const projected = renderedTranscriptFromWindow(state, session);

  assert.deepEqual(projected.map((entry) => entry.item_id), ["item-1", "item-2"]);
  assert.equal(projected[1].text, "brand new");
});

// Patching entry C must not drop siblings A and B — a prior attempt's
// whole-window invalidate (downgrading every OTHER cached entry to force a
// refetch) did exactly that once enough entries needed repair at once.
test("patching entry C invalidates only C — siblings A and B project unaffected", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "a", kind: "agent_text", text: "A body", status: "completed", turn_id: "turn-1", tool: null, content_state: "full" },
    { item_id: "b", kind: "agent_text", text: "B body", status: "completed", turn_id: "turn-1", tool: null, content_state: "full" },
    { item_id: "c", kind: "agent_text", text: "C body", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);
  invalidateTranscriptWindowEntryForPatch(state, "thread-1", { item_id: "c", status: "completed", text: "C patched" });

  assert.equal(state.transcriptHydrationEntries.get("a").content_state, "full", "sibling A must stay trusted");
  assert.equal(state.transcriptHydrationEntries.get("b").content_state, "full", "sibling B must stay trusted");

  const session = {
    active_thread_id: "thread-1",
    transcript: [
      { item_id: "a", kind: "agent_text", text: "A body", status: "completed", turn_id: "turn-1", tool: null },
      { item_id: "b", kind: "agent_text", text: "B body", status: "completed", turn_id: "turn-1", tool: null },
      { item_id: "c", kind: "agent_text", text: "C patched", status: "completed", turn_id: "turn-1", tool: null },
    ],
  };
  const projected = renderedTranscriptFromWindow(state, session);

  assert.deepEqual(projected.map((entry) => entry.item_id), ["a", "b", "c"], "no sibling must be dropped or reordered");
  assert.equal(projected.find((e) => e.item_id === "a").text, "A body", "A must project straight from the (untouched, still full) window");
  assert.equal(projected.find((e) => e.item_id === "b").text, "B body", "B must project straight from the (untouched, still full) window");
  assert.equal(projected.find((e) => e.item_id === "c").text, "C patched", "C must fall back to the array for its own invalidated entry");
});

test("a delta with a non-zero offset against an invalidated (blanked) entry is refused as a gap, not silently applied to the pre-patch text", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "Hello", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);
  invalidateTranscriptWindowEntryForPatch(state, "thread-1", { item_id: "item-1", status: "completed", text: "Jello" });

  const applied = applyTranscriptDeltaToWindow(state, {
    item_id: "item-1",
    thread_id: "thread-1",
    delta: "!",
    text_offset: 5,
  });

  assert.equal(applied, false);
  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "", "must not silently become the pre-patch text plus the delta");
});

test("a delta at offset 0 against an invalidated entry starts a genuine fresh stream", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "Hello", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);
  invalidateTranscriptWindowEntryForPatch(state, "thread-1", { item_id: "item-1", status: "completed", text: "Jello" });

  const applied = applyTranscriptDeltaToWindow(state, {
    item_id: "item-1",
    thread_id: "thread-1",
    delta: "Restarted",
    text_offset: 0,
  });

  assert.equal(applied, true);
  assert.equal(state.transcriptHydrationEntries.get("item-1").text, "Restarted");
  assert.equal(state.transcriptHydrationEntries.get("item-1").content_state, "full");
});

test("an authoritative snapshot/hydration merge re-establishes full content_state for an invalidated entry", () => {
  const state = loadedWindowState("thread-1", [
    { item_id: "item-1", kind: "agent_text", text: "Hello", status: "running", turn_id: "turn-1", tool: null, content_state: "full" },
  ]);
  invalidateTranscriptWindowEntryForPatch(state, "thread-1", { item_id: "item-1", status: "completed", text: "Jello" });

  prepareTranscriptHydrationState(state, {
    active_thread_id: "thread-1",
    transcript_truncated: true,
    transcript_revision: 5,
    transcript: [
      { item_id: "item-1", kind: "agent_text", text: "Jello", status: "completed", turn_id: "turn-1", tool: null, content_state: "full" },
    ],
  });

  const entry = state.transcriptHydrationEntries.get("item-1");
  assert.equal(entry.content_state, "full");
  assert.equal(entry.text, "Jello");
});
