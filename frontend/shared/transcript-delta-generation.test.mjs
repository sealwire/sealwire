import test from "node:test";
import assert from "node:assert/strict";

import {
  transcriptDeltaMatchesGeneration,
  transcriptDeltaIsFromAnotherGeneration,
} from "./transcript-generation.js";
import { applyDeltaToViewOnlyPin } from "../local/view-only-thread.js";

// The rule is deliberately symmetric, and checked against the DESTINATION. A
// delta carrying a run the destination does not hold must not mutate a row,
// advance a revision, or re-stamp a buffer.

test("the delta rule accepts same-run and old-relay, and refuses either one-sided race", () => {
  assert.equal(transcriptDeltaMatchesGeneration("gen-1", "gen-1"), true, "same run");
  assert.equal(transcriptDeltaMatchesGeneration("", ""), true, "old relay, nothing to compare");
  assert.equal(transcriptDeltaMatchesGeneration(undefined, undefined), true);

  assert.equal(transcriptDeltaMatchesGeneration("gen-1", "gen-2"), false, "different runs");
  assert.equal(
    transcriptDeltaMatchesGeneration("gen-1", ""),
    false,
    "an unstamped delta arriving after the first stamped snapshot is mixed"
  );
  assert.equal(
    transcriptDeltaMatchesGeneration("", "gen-1"),
    false,
    "and a stamped delta arriving before it is just as mixed"
  );
});

test("the convenience form reads both sides off the usual shapes", () => {
  assert.equal(
    transcriptDeltaIsFromAnotherGeneration(
      { transcript_generation: "gen-1" },
      { transcript_generation: "gen-1" }
    ),
    false
  );
  assert.equal(
    transcriptDeltaIsFromAnotherGeneration(
      { transcript_generation: "gen-1" },
      { transcript_generation: "gen-2" }
    ),
    true
  );
});

function pinWith(generation) {
  return {
    threadId: "t1",
    relayGeneration: generation,
    transcriptRevision: 5,
    entries: [
      { row_id: "r1", item_id: "r1", kind: "agent_text", text: "hello", status: "running" },
    ],
  };
}

function deltaFor(generation) {
  return {
    thread_id: "t1",
    transcript_generation: generation,
    row_id: "r1",
    item_id: "r1",
    delta: " world",
    delta_kind: "agent_text",
    turn_id: "turn-1",
    base_revision: 5,
    revision: 6,
    entry_seq: 1,
    order_seq: 1024,
    text_offset: 5,
  };
}

test("a view-only pin applies a same-run delta", () => {
  const pin = pinWith("gen-1");
  const next = applyDeltaToViewOnlyPin(pin, deltaFor("gen-1"));
  assert.notEqual(next, pin, "the pin advanced");
  assert.equal(next.entries[0].text, "hello world");
});

test("a view-only pin refuses a delta from another run, untouched", () => {
  const pin = pinWith("gen-1");
  const next = applyDeltaToViewOnlyPin(pin, deltaFor("gen-2"));
  assert.equal(next, pin, "the very same object — no row mutated, no revision advanced");
  assert.equal(pin.entries[0].text, "hello", "and the row is unchanged");
  assert.equal(pin.transcriptRevision, 5, "the revision did not advance");
});

test("a view-only pin refuses both one-sided upgrade races", () => {
  const stamped = pinWith("gen-1");
  assert.equal(
    applyDeltaToViewOnlyPin(stamped, deltaFor("")),
    stamped,
    "unstamped delta into a stamped pin"
  );

  const unstamped = pinWith("");
  assert.equal(
    applyDeltaToViewOnlyPin(unstamped, deltaFor("gen-1")),
    unstamped,
    "stamped delta into an unstamped pin"
  );
});

test("an old relay still streams: neither side stamped, the delta applies", () => {
  const pin = pinWith("");
  const event = deltaFor("");
  delete event.transcript_generation;
  delete event.row_id;
  const next = applyDeltaToViewOnlyPin(pin, event);
  assert.notEqual(next, pin, "an unstamped relay must keep working");
  assert.equal(next.entries[0].text, "hello world");
});
