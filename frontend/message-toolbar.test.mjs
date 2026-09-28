// Design 20c-2: a reply's actions float over it instead of holding a row under it;
// only the last reply of a finished turn keeps a row, since that is what gets copied.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent } from "./shared/transcript-react.js";

const h = React.createElement;
const user = (id, text) => ({ item_id: id, kind: "user_text", status: "completed", text });
const agent = (id, text) => ({ item_id: id, kind: "agent_text", status: "completed", text });
const bash = (id) => ({
  item_id: id,
  kind: "tool_call",
  status: "completed",
  tool: { item_type: "toolCall", name: "Bash", title: "Bash", command: "ls" },
});

const TURN = [user("u1", "go"), agent("a1", "Looking first."), bash("t1"), agent("a2", "All done.")];

function article(markup, id) {
  const start = markup.indexOf(`data-transcript-entry-id="${id}"`);
  const open = markup.lastIndexOf("<article", start);
  return markup.slice(open, markup.indexOf("</article>", start) + 10);
}

test("a reply in the middle of a turn floats its actions and holds no row", () => {
  const markup = renderToStaticMarkup(h(TranscriptContent, { entries: TURN, options: { canAsk: true } }));
  const middle = article(markup, "a1");
  assert.match(middle, /class="message-toolbar"/);
  assert.match(middle, /data-ask-message="Looking first\."[^>]*>.*Ask</);
  assert.match(middle, /data-copy-message="Looking first\."/);
  assert.doesNotMatch(middle, /class="message-actions"/);
});

test("the last reply of a finished turn keeps a row with Ask and Copy", () => {
  const markup = renderToStaticMarkup(h(TranscriptContent, { entries: TURN, options: { canAsk: true } }));
  const last = article(markup, "a2");
  assert.match(last, /class="message-actions"/);
  assert.match(last, />Ask</);
  assert.match(last, />Copy</);
  assert.doesNotMatch(last, /class="message-toolbar"/);
});

test("while the turn is still running its latest reply is not the last one yet", () => {
  const markup = renderToStaticMarkup(
    h(TranscriptContent, { entries: TURN, options: { canAsk: true, turnRunning: true } })
  );
  const latest = article(markup, "a2");
  assert.match(latest, /class="message-toolbar"/);
  assert.doesNotMatch(latest, /class="message-actions"/);
});

test("Ask only appears where the surface can take a question", () => {
  const markup = renderToStaticMarkup(h(TranscriptContent, { entries: TURN, options: {} }));
  assert.doesNotMatch(markup, /data-ask-message=/);
  assert.match(article(markup, "a1"), /data-copy-message=/, "Copy still does");
});
