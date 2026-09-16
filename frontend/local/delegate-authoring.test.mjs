// Reported by the user: a "/delegate" with a real message just sat there. The relay had
// refused it — their thread was mid-turn — and the reason reached only the client log,
// which is a drawer behind Settings. Send read as dead, exactly as "/goal" used to.
import test from "node:test";
import assert from "node:assert/strict";

import { createDelegateAuthor } from "./delegate-authoring.js";

function harness({ result = { text: "Handed over.", isError: false } } = {}) {
  const shown = [];
  const sent = [];
  const author = createDelegateAuthor({
    delegate: async (threadId, args) => {
      sent.push([threadId, args]);
      return result;
    },
    setComposerError: (threadId, message) => shown.push([threadId, message]),
  });
  return { author, shown, sent };
}

test("the relay's reason for refusing is put on screen", async () => {
  const { author, shown } = harness({
    result: { text: "that thread is busy with a turn", isError: true },
  });

  const answer = await author("thread-1", { message: "review the frontend" });

  assert.equal(answer.isError, true);
  assert.deepEqual(shown.at(-1), ["thread-1", "that thread is busy with a turn"]);
});

test("the attempt opens by clearing, so a fixed draft carries no stale line", async () => {
  const { author, shown } = harness();

  await author("thread-1", { message: "review the frontend" });

  assert.deepEqual(shown, [["thread-1", ""]], "and a success has nothing of its own to say");
});

// The private controller keeps or clears the draft from `isError`. A helper that slips
// back to a bare boolean reads as SUCCESS there — the draft is thrown away and nothing
// is said, which is worse than the silence this path exists to end.
test("a helper that answers the old boolean is a loud failure, not a silent success", async () => {
  for (const legacy of [false, true, undefined]) {
    // Built here rather than through the harness: passing `undefined` as an option
    // lands on the destructuring default, so the case under test never arrives.
    const shown = [];
    const author = createDelegateAuthor({
      delegate: async () => legacy,
      setComposerError: (threadId, message) => shown.push([threadId, message]),
    });

    const answer = await author("thread-1", { message: "look" });

    assert.equal(answer.isError, true, `${legacy} must not read as success`);
    assert.ok(answer.text.trim(), "and the draft is kept for a reason the user can see");
    assert.equal(shown.at(-1)[1], answer.text);
  }
});

test("the arguments the command collected reach the relay untouched", async () => {
  const { author, sent } = harness();
  const args = { message: "review the frontend", agent: "peer-7", provider: "codex" };

  await author("thread-1", args);

  assert.deepEqual(sent, [["thread-1", args]]);
});
