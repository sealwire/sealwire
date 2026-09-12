import test from "node:test";
import assert from "node:assert/strict";

import { transcriptRowKey } from "./transcript-row-key.js";
import { normalizeThreadTranscriptPage } from "./transcript-page.js";
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

test("a chunk-reconstructed page keeps row_id, and omits it entirely for an old relay", () => {
  // The two fields deliberately differ here. A real relay ships them equal, so a
  // fixture that did the same would pass on the `item_id` fallback alone and prove
  // nothing about whether `row_id` was carried at all.
  const modern = normalizeThreadTranscriptPage({
    thread_id: "t1",
    chunks: [
      { entry_index: 0, row_id: "r1", item_id: "not-the-key", kind: "agent_text", text: "hi" },
    ],
  });
  assert.equal(
    modern.entries[0].row_id,
    "r1",
    "row_id must survive the chunks->entries rebuild"
  );
  assert.equal(
    transcriptRowKey(modern.entries[0]),
    "r1",
    "and it must be what the row keys on"
  );

  const legacy = normalizeThreadTranscriptPage({
    thread_id: "t1",
    chunks: [{ entry_index: 0, item_id: "legacy-1", kind: "agent_text", text: "hi" }],
  });
  assert.equal(
    Object.hasOwn(legacy.entries[0], "row_id"),
    false,
    "an old relay's page shape must be unchanged, so its cached pages stay readable"
  );
  assert.equal(transcriptRowKey(legacy.entries[0]), "legacy-1");
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
