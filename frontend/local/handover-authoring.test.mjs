// The same guarantee `/delegate` needed and kept losing: every refusal the relay gives a
// handover is decided while the call is open — no such agent, that one is busy, this
// session is mid-turn — so it has to be SAID, not left in a drawer behind Settings.
import test from "node:test";
import assert from "node:assert/strict";

import { createHandoverAuthor } from "./handover-authoring.js";

function harness({ result = { text: "Handing over.", isError: false } } = {}) {
  const shown = [];
  const sent = [];
  const author = createHandoverAuthor({
    handover: async (threadId, args) => {
      sent.push([threadId, args]);
      return result;
    },
    setComposerError: (threadId, message) => shown.push([threadId, message]),
  });
  return { author, shown, sent };
}

test("the relay's reason for refusing a handover is put on screen", async () => {
  const { author, shown } = harness({
    result: { text: "that agent is busy right now", isError: true },
  });

  const answer = await author("thread-1", { note: "" });

  assert.equal(answer.isError, true);
  assert.deepEqual(shown.at(-1), ["thread-1", "that agent is busy right now"]);
});

test("the attempt opens by clearing, so a fixed draft carries no stale line", async () => {
  const { author, shown } = harness();

  await author("thread-1", { note: "" });

  assert.deepEqual(shown, [["thread-1", ""]], "and a success has nothing of its own to say");
});

// The private controller keeps or clears the draft from `isError`. A helper that slips
// back to a bare boolean reads as SUCCESS there — the draft is thrown away and nothing
// is said.
test("a helper that answers the old boolean is a loud failure, not a silent success", async () => {
  for (const legacy of [false, true, undefined]) {
    const shown = [];
    const author = createHandoverAuthor({
      handover: async () => legacy,
      setComposerError: (threadId, message) => shown.push([threadId, message]),
    });

    const answer = await author("thread-1", { note: "" });

    assert.equal(answer.isError, true, `${legacy} must not read as success`);
    assert.ok(answer.text.trim(), "and the draft is kept for a reason the user can see");
    assert.equal(shown.at(-1)[1], answer.text);
  }
});

// Including the empty note, which is the ordinary case: nothing is dropped on the way
// through, or the relay silently starts a differently-configured agent.
test("the arguments the command collected reach the relay untouched", async () => {
  const { author, sent } = harness();
  const args = { note: "", agent: "peer-7", provider: "codex", model: "gpt-5.6", effort: "high" };

  await author("thread-1", args);

  assert.deepEqual(sent, [["thread-1", args]]);
});
