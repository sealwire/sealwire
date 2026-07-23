import test from "node:test";
import assert from "node:assert/strict";

import { createUserTurn } from "./worker.mjs";

test("createUserTurn sends Claude image blocks before prompt text", () => {
  const turn = createUserTurn("Inspect this screenshot", {
    images: [
      {
        media_type: "image/png",
        data: "iVBORw0KGgo=",
      },
    ],
    itemId: "user:item-1",
    messageUuid: "message-1",
    turnId: "turn-1",
  });

  assert.deepEqual(turn.sdkMessage.message.content, [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "iVBORw0KGgo=",
      },
    },
    { type: "text", text: "Inspect this screenshot" },
  ]);
  assert.equal(turn.event.text, "Inspect this screenshot\n\n[Attached image]");
});

test("createUserTurn preserves the string content shape for text-only turns", () => {
  const turn = createUserTurn("hello");
  assert.equal(turn.sdkMessage.message.content, "hello");
});

test("createUserTurn supports an image-only turn", () => {
  const turn = createUserTurn("", {
    images: [{ media_type: "image/jpeg", data: "/9j/" }],
  });

  assert.deepEqual(turn.sdkMessage.message.content, [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: "/9j/",
      },
    },
  ]);
  assert.equal(turn.event.text, "[Attached image]");
});
