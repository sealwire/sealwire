import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationPanel } from "./conversation-panel.js";

// No device has to claim a session before its first prompt; the relay does not
// gate sends on which device spoke last.
test("an empty open session reads as ready on every device", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ConversationPanel, {
      entries: [],
      readyState: { session: { active_thread_id: "t-1" } },
    })
  );
  assert.ok(markup.includes("Ready"), markup);
  assert.ok(!/another device|take over/i.test(markup), markup);
});
