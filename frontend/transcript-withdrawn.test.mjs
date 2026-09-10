// `withdrawn` is an ABSORBING flag: the server keeps a definitively-rejected send as
// a marked row (a snapshot merge cannot express absence), so any client merge that
// lets a later unmarked copy win resurrects a message the relay already answered for.
import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileAuthoritativeTail } from "./shared/authoritative-tail-merge.js";
import { reduceTranscriptEntryPatchEvent } from "./shared/transcript-event-reducer.js";
import { visibleTranscriptEntries } from "./shared/withdrawn-transcript.js";

function row(itemId, extra = {}) {
  return {
    item_id: itemId,
    kind: "user_text",
    status: "completed",
    text: "doomed send",
    turn_id: null,
    tool: null,
    ...extra,
  };
}

test("an authoritative tail page cannot resurrect a withdrawn row", () => {
  const result = reconcileAuthoritativeTail({
    order: ["r1"],
    entries: new Map([["r1", row("r1", { withdrawn: true })]]),
    // An older copy of the row, serialized before the withdrawal.
    pageEntries: [row("r1", { withdrawn: false })],
  });
  assert.equal(
    result.entries.get("r1").withdrawn,
    true,
    "withdrawn must absorb: existing || incoming"
  );
});

test("an entry patch cannot resurrect a withdrawn row", () => {
  const session = {
    active_thread_id: "t",
    transcript: [row("r1", { withdrawn: true })],
    transcript_revision: 5,
  };
  const result = reduceTranscriptEntryPatchEvent({
    event: {
      thread_id: "t",
      revision: 6,
      entry: row("r1", { withdrawn: false, status: "completed" }),
    },
    session,
  });
  assert.equal(result.kind, "accepted_patch");
  const patched = result.nextTranscript.find((entry) => entry.item_id === "r1");
  assert.equal(patched.withdrawn, true, "a late unmarked copy must not clear the tombstone");
});

test("withdrawn rows are filtered from the visible entries, identity-preserving otherwise", () => {
  const kept = [row("a"), row("b")];
  assert.equal(
    visibleTranscriptEntries(kept),
    kept,
    "no withdrawn rows -> the SAME array back, so React memoization holds"
  );
  const filtered = visibleTranscriptEntries([row("a"), row("gone", { withdrawn: true }), row("b")]);
  assert.deepEqual(
    filtered.map((entry) => entry.item_id),
    ["a", "b"]
  );
});

// ---- review round: end-to-end absorption ----
import {
  mergeOlderViewOnlyPage,
  mergeRefreshedViewOnlyPage,
} from "./local/view-only-thread.js";
import { preserveVisibleTranscriptText } from "./shared/preserve-visible-transcript-text.js";
import {
  createClearedTranscriptHydrationPatch,
  createMergedTranscriptHydrationPagePatch,
} from "./shared/transcript-hydration-store.js";
import { collapseDuplicateTranscriptRows } from "./shared/transcript-react.js";

test("hydration page ingestion preserves order_seq and withdrawn", () => {
  const state = {
    ...createClearedTranscriptHydrationPatch(),
    session: { active_thread_id: "t" },
  };
  const page = {
    thread_id: "t",
    entries: [row("r1", { order_seq: 42, withdrawn: true })],
    prev_cursor: null,
    revision: 1,
  };
  const patch = createMergedTranscriptHydrationPagePatch(state, page, { prepend: false });
  const stored = patch.transcriptHydrationEntries.get("r1");
  assert.equal(stored.order_seq, 42, "the ordering contract must survive ingestion");
  assert.equal(stored.withdrawn, true, "the withdrawal contract must survive ingestion");
});

test("the visible filter hides EVERY copy of a withdrawn id", () => {
  const filtered = visibleTranscriptEntries([
    row("r1"),
    row("r1", { withdrawn: true }),
    row("r2"),
  ]);
  assert.deepEqual(
    filtered.map((entry) => entry.item_id),
    ["r2"],
    "an unmarked twin of a withdrawn id must not survive the filter"
  );
});

test("an older view-only page's tombstone marks the pin's copy", () => {
  const pin = { threadId: "t", entries: [row("r1")], historyExtended: false, olderCursor: null };
  const page = {
    thread_id: "t",
    entries: [row("r1", { withdrawn: true }), row("r0")],
    prev_cursor: null,
  };
  const merged = mergeOlderViewOnlyPage(pin, page);
  const kept = merged.entries.find((entry) => entry.item_id === "r1");
  assert.equal(kept.withdrawn, true, "the dropped duplicate's tombstone must be absorbed");
});

test("a view-only refresh cannot resurrect the pin's tombstone", () => {
  const pin = {
    threadId: "t",
    entries: [row("r1", { withdrawn: true })],
    historyExtended: false,
    olderCursor: null,
  };
  const page = { thread_id: "t", entries: [row("r1")], prev_cursor: null };
  const merged = mergeRefreshedViewOnlyPage(pin, page);
  const kept = merged.entries.find((entry) => entry.item_id === "r1");
  assert.equal(kept.withdrawn, true, "fresh overwrite must absorb the prior tombstone");
});

test("snapshot text preservation cannot resurrect a tombstone", () => {
  const current = {
    active_thread_id: "t",
    transcript: [row("r1", { withdrawn: true, content_state: "full" })],
  };
  const snapshot = {
    active_thread_id: "t",
    transcript: [row("r1", { content_state: "full" })],
  };
  const preserved = preserveVisibleTranscriptText(current, snapshot);
  assert.equal(preserved.transcript[0].withdrawn, true);
});

test("duplicate-row collapse absorbs the withdrawn flag", () => {
  const collapsed = collapseDuplicateTranscriptRows([
    row("r1", { withdrawn: true }),
    row("r1", { status: "completed", text: "longer text than the first copy" }),
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].withdrawn, true);
});
