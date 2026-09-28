// Design 20c-3: one logo per turn, and tool work folded to a quiet line whose raw
// command only shows once opened.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JSDOM } from "jsdom";

import { resolveTranscriptAction } from "./shared/transcript-interactions.js";
import { TranscriptContent } from "./shared/transcript-react.js";

const h = React.createElement;
const user = (id, text) => ({ item_id: id, kind: "user_text", status: "completed", text });
const agent = (id, text, extra = {}) => ({ item_id: id, kind: "agent_text", status: "completed", text, ...extra });
const bash = (id, status = "completed") => ({
  item_id: id,
  kind: "tool_call",
  status,
  tool: {
    item_type: "toolCall",
    name: "Bash",
    title: "Bash",
    detail: "Use boolean asserts",
    command: "python3 - <<'EOF' p='frontend/x.test.mjs'",
  },
});

function render(entries, options = {}) {
  return renderToStaticMarkup(h(TranscriptContent, { entries, options }));
}

function article(markup, id) {
  const start = markup.indexOf(`data-transcript-entry-id="${id}"`);
  const open = markup.lastIndexOf("<article", start);
  return markup.slice(open, markup.indexOf("</article>", start) + 10);
}

test("a turn wears its logo once, and your next message starts a turn with its own", () => {
  const markup = render([
    user("u1", "go"),
    agent("a1", "First, the tests."),
    bash("c1"),
    agent("a2", "Now the fix."),
    user("u2", "and?"),
    agent("a3", "Done."),
  ]);
  assert.match(article(markup, "a1"), /class="message-avatar"/);
  assert.doesNotMatch(article(markup, "a2"), /class="message-avatar"/, "same turn, no second logo");
  assert.match(article(markup, "a3"), /class="message-avatar"/, "a new turn after your message");
});

test("a reply still loading keeps to the same rule", () => {
  const markup = render([
    user("u1", "go"),
    agent("a1", "First."),
    agent("a2", "", { content_state: "omitted" }),
  ]);
  assert.doesNotMatch(article(markup, "a2"), /class="message-avatar"/);
});

test("a lone finished command folds to a group line, its command out of sight", () => {
  const entries = [agent("a1", "Checking."), bash("c1"), agent("a2", "Red, as expected.")];
  const folded = render(entries);
  assert.match(folded, /class="work-group-lead">Ran 1 command</);
  assert.doesNotMatch(folded, /python3/, "no raw command while folded");

  const opened = render(entries, { expandedKeys: new Set(["entry:c1"]) });
  assert.match(article(opened, "c1"), /Use boolean asserts/);
  assert.match(article(opened, "c1"), /python3/, "opened, the command is there");
});

// Folding a lone tool once it finishes must not shut what the reader opened while it ran.
test("a lone tool opened while it ran stays open when it finishes", () => {
  const expandedKeys = new Set(["entry:c1"]);
  const running = render([agent("a1", "Checking."), bash("c1", "running"), agent("a2", "…")], { expandedKeys });
  assert.match(running, /class="tool-run-detail"/, "open while running");

  const done = render([agent("a1", "Checking."), bash("c1"), agent("a2", "Red, as expected.")], { expandedKeys });
  assert.match(done, /class="work-group-lead">Ran 1 command</);
  assert.match(done, /class="tool-run-detail"/, "still open once folded");
});

test("a lone thought stays its own line: its preview is worth more than a count", () => {
  const markup = render([
    agent("a1", "Hm."),
    { item_id: "r1", kind: "reasoning", status: "completed", text: "Weighing the options" },
    agent("a2", "Decided."),
  ]);
  assert.doesNotMatch(markup, /work-group-chip/);
  assert.match(markup, /Weighing the options/);
});

test("a running command says what it does, not the command itself", () => {
  const markup = render([agent("a1", "Running it."), bash("c1", "running")]);
  const row = article(markup, "c1");
  assert.match(row, /Use boolean asserts/);
  assert.doesNotMatch(row, /python3/);
});

test("a command with nothing but its text still shows that text", () => {
  const markup = render([
    agent("a1", "Running it."),
    { item_id: "x1", kind: "command", status: "running", text: "cargo test -p relay-server", tool: { command: "cargo test -p relay-server" } },
  ]);
  assert.match(article(markup, "x1"), /cargo test -p relay-server/);
});

// Opening a tool is what fetches its full detail; a group of one opens its tool, so its
// line has to be clicked as that tool, not as a group.
test("clicking a group of one opens its tool; a larger group opens as a group", () => {
  const chipAction = (entries) => {
    const { document } = new JSDOM(render(entries)).window;
    return resolveTranscriptAction(document.querySelector(".work-group-chip"));
  };
  const lone = chipAction([agent("a1", "Checking."), bash("c1"), agent("a2", "Done.")]);
  assert.deepEqual([lone?.kind, lone?.itemId], ["toggleEntry", "c1"]);

  const pair = chipAction([agent("a1", "Checking."), bash("c1"), bash("c2"), agent("a2", "Done.")]);
  assert.deepEqual([pair?.kind, pair?.expandKey], ["toggleGroup", "group:c1"]);
});
