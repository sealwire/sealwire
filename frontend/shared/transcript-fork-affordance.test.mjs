import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { computeForkableItemIds } from "./transcript-fork.js";
import { TranscriptEntry } from "./transcript-react.js";

// A turn is user_text -> (reasoning|tool_call|agent_text)* and the only branch
// point that means anything is where the agent came to rest. Forking from a
// mid-turn agent message would branch from a state the agent never treated as
// final (tool still in flight, reasoning half-emitted).
test("only the last agent message of each turn is forkable", () => {
  const entries = [
    { item_id: "u1", kind: "user_text", turn_id: "t1" },
    { item_id: "a1", kind: "agent_text", turn_id: "t1" },
    { item_id: "tool1", kind: "tool_call", turn_id: "t1" },
    { item_id: "a2", kind: "agent_text", turn_id: "t1" },
    { item_id: "u2", kind: "user_text", turn_id: "t2" },
    { item_id: "a3", kind: "agent_text", turn_id: "t2" },
  ];

  const forkable = computeForkableItemIds(entries);

  assert.equal(forkable.has("a2"), true, "turn-final agent message is forkable");
  assert.equal(forkable.has("a3"), true, "tip agent message is forkable");
  assert.equal(forkable.has("a1"), false, "mid-turn agent message is not forkable");
  assert.equal(forkable.has("u1"), false, "user messages are not forkable");
  assert.equal(forkable.has("tool1"), false, "tool calls are not forkable");
});

test("a turn boundary is detected from turn_id changes even without a user entry", () => {
  const entries = [
    { item_id: "a1", kind: "agent_text", turn_id: "t1" },
    { item_id: "a2", kind: "agent_text", turn_id: "t2" },
  ];

  const forkable = computeForkableItemIds(entries);

  assert.equal(forkable.has("a1"), true, "last agent message of turn t1");
  assert.equal(forkable.has("a2"), true, "last agent message of turn t2");
});

test("entries without item ids are never forkable", () => {
  const forkable = computeForkableItemIds([
    { kind: "agent_text", turn_id: "t1", text: "no id" },
  ]);
  assert.equal(forkable.size, 0);
});

test("agent message renders a fork button carrying its own item id", () => {
  const markup = renderToStaticMarkup(
    React.createElement(TranscriptEntry, {
      entry: { item_id: "a2", kind: "agent_text", text: "done", turn_id: "t1" },
      options: { canFork: true, forkableItemIds: new Set(["a2"]) },
    })
  );

  assert.match(markup, /data-fork-from-item="a2"/);
  // The fork affordance must sit in the same action row as copy so it is
  // reachable by tap on iOS, where the thread-list contextmenu never fires.
  assert.match(markup, /message-actions/);
  assert.match(markup, /message-copy-button/);
});

test("non-turn-final agent messages render copy but no fork button", () => {
  const markup = renderToStaticMarkup(
    React.createElement(TranscriptEntry, {
      entry: { item_id: "a1", kind: "agent_text", text: "thinking", turn_id: "t1" },
      options: { canFork: true, forkableItemIds: new Set(["a2"]) },
    })
  );

  assert.match(markup, /message-copy-button/);
  assert.doesNotMatch(markup, /data-fork-from-item/);
});

test("surfaces that cannot fork render no fork button at all", () => {
  const markup = renderToStaticMarkup(
    React.createElement(TranscriptEntry, {
      entry: { item_id: "a2", kind: "agent_text", text: "done", turn_id: "t1" },
      options: { canFork: false, forkableItemIds: new Set(["a2"]) },
    })
  );

  assert.doesNotMatch(markup, /data-fork-from-item/);
});
