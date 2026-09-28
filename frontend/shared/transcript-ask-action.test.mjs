import test from "node:test";
import assert from "node:assert/strict";

import { resolveTranscriptAction } from "./transcript-interactions.js";

function button(attrs) {
  const node = {
    dataset: attrs,
    closest(selector) {
      const name = selector.match(/\[data-([a-z-]+)/)?.[1];
      const key = name?.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return key && key in attrs ? node : null;
    },
  };
  return node;
}

test("an Ask button resolves to askMessage with the message's text", () => {
  const action = resolveTranscriptAction(button({ askMessage: "the whole reply" }));
  assert.equal(action?.kind, "askMessage");
  assert.equal(action.text, "the whole reply");
});
