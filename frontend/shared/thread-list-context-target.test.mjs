import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadGroupItem } from "./thread-list-react.js";

const h = React.createElement;

const THREAD = { id: "thread-target-1", provider: "fake", name: "Target", updated_at: 1 };
const GROUP = { cwd: "/tmp/project", label: "project" };

function renderItem(props) {
  return renderToStaticMarkup(
    h(ThreadGroupItem, {
      group: GROUP,
      thread: THREAD,
      formatThreadMeta: () => "now",
      ...props,
    })
  );
}

// Regression: the right-click highlight (`is-context-target`) was applied
// imperatively in app.js, so any React re-render of the thread list (which
// happens on every SSE/activity tick) clobbered the class — the row's
// className is owned by React. That stranded the delete-thread e2e, whose
// context-menu wait requires `is-context-target`, until its 45s timeout.
// React must own the class, driven by the store's context-menu target.
test("ThreadGroupItem marks the context-menu target row with is-context-target", () => {
  const markup = renderItem({ contextMenuThreadId: THREAD.id });
  assert.match(markup, /class="conversation-item[^"]*\bis-context-target\b/);
});

test("ThreadGroupItem does not mark other rows as the context-menu target", () => {
  const markup = renderItem({ contextMenuThreadId: "some-other-thread" });
  assert.doesNotMatch(markup, /is-context-target/);
});

test("ThreadGroupItem keeps is-active alongside the context-target highlight", () => {
  const markup = renderItem({ active: true, contextMenuThreadId: THREAD.id });
  assert.match(markup, /class="conversation-item[^"]*\bis-active\b/);
  assert.match(markup, /class="conversation-item[^"]*\bis-context-target\b/);
});
