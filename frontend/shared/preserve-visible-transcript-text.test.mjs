// Text preservation matches rows by item id alone, and across a restart the same id
// (`history-3`) can name a DIFFERENT message. Grafting the old run's longer body onto
// the new run's row silently replaces a message with no error anywhere.
import assert from "node:assert/strict";
import { test } from "node:test";

import { preserveVisibleTranscriptText } from "./preserve-visible-transcript-text.js";

const THREAD = "thread-1";

function sessionWith(generation, text, contentState) {
  return {
    active_thread_id: THREAD,
    transcript_generation: generation,
    transcript: [
      { item_id: "history-3", kind: "agent_text", status: "completed", text, content_state: contentState },
    ],
  };
}

test("text from another run is not grafted onto a same-named row", () => {
  const current = sessionWith("run-a", "run A's much longer message body", "full");
  const snapshot = sessionWith("run-b", "new", "preview");
  const preserved = preserveVisibleTranscriptText(current, snapshot);
  assert.equal(
    preserved.transcript[0].text,
    "new",
    "run B's history-3 is a different message; keeping run A's body silently replaces it"
  );
});

test("an unstamped side means an upgrade race, and preservation is refused", () => {
  const current = sessionWith("", "old unstamped body that is longer", "full");
  const snapshot = sessionWith("run-b", "new", "preview");
  const preserved = preserveVisibleTranscriptText(current, snapshot);
  assert.equal(preserved.transcript[0].text, "new");
});

test("the same run still preserves longer visible text", () => {
  const current = sessionWith("run-a", "the full body already on screen", "full");
  const snapshot = sessionWith("run-a", "short", "preview");
  const preserved = preserveVisibleTranscriptText(current, snapshot);
  assert.equal(
    preserved.transcript[0].text,
    "the full body already on screen",
    "the guard must not disable preservation inside one run"
  );
});

test("a relay too old to stamp still preserves (both sides empty)", () => {
  const current = sessionWith("", "the full body already on screen", "full");
  const snapshot = sessionWith("", "short", "preview");
  const preserved = preserveVisibleTranscriptText(current, snapshot);
  assert.equal(preserved.transcript[0].text, "the full body already on screen");
});
