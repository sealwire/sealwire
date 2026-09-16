// A `/review` the relay refuses — "another session is running in this workspace" — used
// to reach only the client log: a drawer behind Settings here, `display: none` on the
// phone. The controller turns the rejection into a bare `false`, so without this the
// draft sits there and Send reads as dead, which is the defect this whole channel exists
// to close.
import test from "node:test";
import assert from "node:assert/strict";

import { createReviewAuthor } from "./review-authoring.js";

function harness({ requestReview } = {}) {
  const shown = [];
  const author = createReviewAuthor({
    requestReview: requestReview || (async () => ({ message: "Review started." })),
    getThreadId: () => "thread-1",
    setComposerError: (threadId, message) => shown.push([threadId, message]),
  });
  return { author, shown };
}

test("the relay's reason for refusing a review is put on screen", async () => {
  const { author, shown } = harness({
    requestReview: async () => {
      throw new Error("another session is running in this workspace");
    },
  });

  await assert.rejects(() => author({}), /another session is running/);
  assert.deepEqual(shown.at(-1), ["thread-1", "another session is running in this workspace"]);
});

test("a refusal with no message still says something", async () => {
  const { author, shown } = harness({
    requestReview: async () => {
      throw new Error("");
    },
  });

  await assert.rejects(() => author({}));
  assert.ok(shown.at(-1)[1].trim(), "a blank line hides the refusal all over again");
});

test("the attempt opens by clearing, so a success retires the last refusal", async () => {
  const { author, shown } = harness();

  await author({});

  assert.deepEqual(shown, [["thread-1", ""]], "and a success has nothing of its own to say");
});

// Rethrown on purpose: the controller reads the rejection to keep the draft staged.
test("the rejection still reaches the caller", async () => {
  const { author } = harness({
    requestReview: async () => {
      throw new Error("nope");
    },
  });

  await assert.rejects(() => author({}), /nope/);
});
