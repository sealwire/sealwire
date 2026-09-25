import test from "node:test";
import assert from "node:assert/strict";

import { transcriptRowKey } from "./transcript-row-key.js";
import { reduceTranscriptDeltaEvent } from "./transcript-event-reducer.js";

// The relay owns row identity; `item_id` is a compatibility alias. Client code
// must key on what `transcriptRowKey` returns, and every path that rebuilds an
// entry must carry `row_id` through — an explicit field list drops what it does
// not name, and a dropped key makes one message render as two rows.

test("the row key prefers row_id and falls back for an old relay", () => {
  assert.equal(transcriptRowKey({ row_id: "r1", item_id: "r1" }), "r1");
  assert.equal(
    transcriptRowKey({ item_id: "legacy-1" }),
    "legacy-1",
    "a relay too old to send row_id must still be addressable"
  );
  assert.equal(transcriptRowKey({}), null);
});

test("a collision ships as two rows the client keys apart", () => {
  // What the relay sends after a namespace collision: one row kept the spelling,
  // the other had to mint. Both carry item_id === row_id.
  const entries = [
    { row_id: "x", item_id: "x", kind: "error", text: "the relay's row" },
    { row_id: "x#row1", item_id: "x#row1", kind: "agent_text", text: "the provider's row" },
  ];
  const keys = entries.map(transcriptRowKey);
  assert.deepEqual(keys, ["x", "x#row1"]);
  assert.equal(new Set(keys).size, 2, "two rows, two keys");
});

test("a delta for an unseen row creates it under the relay's key, not the alias", () => {
  // The delta names the minted row. Creating it under `item_id` alone would let
  // the snapshot copy - keyed on row_id - arrive as a second row.
  const outcome = reduceTranscriptDeltaEvent({
    session: { transcript: [] },
    event: {
      thread_id: "t1",
      row_id: "x#row1",
      item_id: "x#row1",
      delta: "streamed",
      delta_kind: "agent_text",
      turn_id: "turn-1",
      entry_seq: 1,
      order_seq: 1024,
      text_offset: 0,
    },
  });

  const created = (outcome.nextTranscript || [])[0];
  assert.ok(created, `the delta created a row: ${JSON.stringify(outcome)}`);
  assert.equal(
    transcriptRowKey(created),
    "x#row1",
    "a delta-born row must carry the relay's key"
  );
  assert.equal(created.row_id, "x#row1", "explicitly, not only via the alias");
});

// --- AskUser: the relay names the row, the client never reconstructs it -----

import { findPendingAskUserRequest } from "./transcript-react.js";

function askUserToolEntry(rowKey) {
  return {
    row_id: rowKey,
    item_id: rowKey,
    kind: "tool_call",
    status: "running",
    turn_id: "turn-1",
    tool: { item_type: "toolCall", name: "AskUserQuestion", title: "AskUserQuestion" },
  };
}

test("a pending question matches the row the relay named, even when that row minted", () => {
  // The tool row had to mint, so its key is NOT `tool:<tool_use_id>`. Slicing
  // `tool:` off it yields `toolu_1#row1`, which matches no pending question —
  // the question would render as a dead read-only card.
  const entry = askUserToolEntry("tool:toolu_1#row1");
  const pending = [
    { request_id: "req-1", tool_use_id: "toolu_1", transcript_row_id: "tool:toolu_1#row1" },
  ];

  const matched = findPendingAskUserRequest(transcriptRowKey(entry), pending);
  assert.equal(
    matched?.request_id,
    "req-1",
    "the card must match the row the relay resolved"
  );
});

test("an old relay with no transcript_row_id still matches by the legacy derivation", () => {
  const entry = askUserToolEntry("tool:toolu_1");
  const pending = [{ request_id: "req-1", tool_use_id: "toolu_1" }];

  const matched = findPendingAskUserRequest(transcriptRowKey(entry), pending);
  assert.equal(
    matched?.request_id,
    "req-1",
    "a relay too old to send the field must keep working"
  );
});
