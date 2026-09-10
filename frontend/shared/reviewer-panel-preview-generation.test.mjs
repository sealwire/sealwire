// The reviewer preview strips a transcript page to bare entries and renders the
// latest agent text. A terminal review fetches ONCE, so a pre-restart page landing
// late would freeze the old run's text on the card forever. Refused, not emptied:
// the panel's catch keeps the last good preview instead of blanking it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewerPreviewEntriesFromPage } from "./reviewer-panel.js";

const SESSION = { active_thread_id: "t", transcript_generation: "run-b" };

test("a page from another run is refused, not rendered", () => {
  assert.throws(
    () =>
      reviewerPreviewEntriesFromPage(SESSION, {
        thread_id: "reviewer-thread",
        transcript_generation: "run-a",
        entries: [{ item_id: "x", kind: "agent_text", text: "old run verdict" }],
      }),
    /another relay run/,
    "the old run's verdict text must not freeze onto the card"
  );
});

test("a same-run page passes through", () => {
  const entries = [{ item_id: "x", kind: "agent_text", text: "verdict" }];
  assert.deepEqual(
    reviewerPreviewEntriesFromPage(SESSION, { transcript_generation: "run-b", entries }),
    entries
  );
});

test("a relay too old to stamp still passes through (both sides empty)", () => {
  const entries = [{ item_id: "x", kind: "agent_text", text: "verdict" }];
  assert.deepEqual(
    reviewerPreviewEntriesFromPage({ active_thread_id: "t" }, { entries }),
    entries
  );
});
