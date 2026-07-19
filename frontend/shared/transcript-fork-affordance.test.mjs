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

// turn_id is deliberately IGNORED as a boundary. Its semantics are
// provider-specific: Claude stamps every assistant message with its own uuid
// as turn_id (so trusting it made every Claude message "turn-final" — button
// spam), while Codex shares one turn_id per turn. The only provider-neutral
// boundary is the next user message.
test("turn_id changes alone are not a boundary — only user messages are", () => {
  const entries = [
    { item_id: "a1", kind: "agent_text", turn_id: "t1" },
    { item_id: "a2", kind: "agent_text", turn_id: "t2" },
  ];

  const forkable = computeForkableItemIds(entries);

  assert.equal(forkable.has("a1"), false, "not final: another agent message follows");
  assert.equal(forkable.has("a2"), true, "final agent message of the block");
});

test("reasoning and tool entries do not close a block", () => {
  const entries = [
    { item_id: "u1", kind: "user_text" },
    { item_id: "a1", kind: "agent_text", turn_id: "x1" },
    { item_id: "r1", kind: "reasoning", turn_id: "x1" },
    { item_id: "tool1", kind: "tool_call", turn_id: "x1" },
    { item_id: "a2", kind: "agent_text", turn_id: "x2" },
    { item_id: "u2", kind: "user_text" },
    { item_id: "a3", kind: "agent_text", turn_id: "x3" },
  ];

  const forkable = computeForkableItemIds(entries);

  assert.deepEqual([...forkable].sort(), ["a2", "a3"]);
});

test("entries without item ids are never forkable", () => {
  const forkable = computeForkableItemIds([
    { kind: "agent_text", turn_id: "t1", text: "no id" },
  ]);
  assert.equal(forkable.size, 0);
});

test("an id-less trailing agent message shadows the earlier one", () => {
  // Offering a1 would be a mid-block fork: the agent kept going after it.
  // The block's true rest point (the id-less entry) cannot carry a button,
  // so the block offers nothing rather than a wrong branch point.
  const forkable = computeForkableItemIds([
    { item_id: "a1", kind: "agent_text" },
    { kind: "agent_text", text: "trailing, no id" },
  ]);
  assert.equal(forkable.size, 0);
});

// Claude spontaneous follow-up turns: an SDK-injected user record (e.g. a
// <task-notification> re-arming a turn) used to be dropped from the live
// stream, so the same thread produced FEWER fork points live than after a
// resume. The worker now surfaces those records live (they map to the same
// `user:<uuid>` item id hydration produces), so the two projections must agree
// exactly. Asserting equality — not a subset — is what keeps the live drop
// from being reintroduced.
test("live and hydrated projections yield identical fork points", () => {
  const projection = [
    { item_id: "user:u1", kind: "user_text" },
    { item_id: "assistant:a1", kind: "agent_text" },
    { item_id: "user:notif-1", kind: "user_text" }, // injected <task-notification>
    { item_id: "assistant:a2", kind: "agent_text" },
  ];

  // Both surfaces build from the same entry shape, so the same input must give
  // the same answer whichever path produced it.
  const live = computeForkableItemIds(projection);
  const hydrated = computeForkableItemIds([...projection]);

  assert.deepEqual([...live].sort(), [...hydrated].sort());
  assert.deepEqual(
    [...live].sort(),
    ["assistant:a1", "assistant:a2"],
    "the injected notification closes a block, so both agent messages rest"
  );
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
