import test from "node:test";
import assert from "node:assert/strict";

import { normalizeThreadTranscriptPage } from "./transcript-page.js";


// Both shapes go through here — pre-chunked entries and raw chunks — and the merge
// guards downstream compare on this field. A branch that drops it makes every page it
// normalises unmergeable, which shows up as an empty transcript, not as a warning.
test("every normalized shape carries the relay generation", () => {
  const chunked = normalizeThreadTranscriptPage({
    thread_id: "t1",
    transcript_generation: "gen-a",
    chunks: [{ entry_index: 0, item_id: "i1", chunk_index: 0, chunk_count: 1, text: "hi" }],
  });
  assert.equal(chunked.transcript_generation, "gen-a");

  const alreadyEntries = normalizeThreadTranscriptPage({
    thread_id: "t1",
    transcript_generation: "gen-a",
    entries: [{ item_id: "i1", kind: "user_text", text: "hi" }],
  });
  assert.equal(alreadyEntries.transcript_generation, "gen-a");
});
