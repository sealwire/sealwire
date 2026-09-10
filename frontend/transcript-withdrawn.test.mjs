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
