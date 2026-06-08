import test from "node:test";
import assert from "node:assert/strict";

import { selectThreadDot } from "./thread-dot.js";

test("no activity and no attention → no dot", () => {
  assert.equal(selectThreadDot({}), null);
  assert.equal(selectThreadDot({ activity: null, attentionKind: null }), null);
});

test("working only → pulsing blue dot, with tool label", () => {
  const dot = selectThreadDot({ activity: { tool: "bash" }, attentionKind: null });
  assert.equal(dot.className, "conversation-activity-dot");
  assert.equal(dot.label, "Working · bash");
});

test("working without a tool → generic Working label", () => {
  const dot = selectThreadDot({ activity: { tool: null } });
  assert.equal(dot.label, "Working");
});

test("completed only → steady blue done dot", () => {
  const dot = selectThreadDot({ activity: null, attentionKind: "completed" });
  assert.equal(dot.className, "conversation-activity-dot is-attention-done");
  assert.equal(dot.label, "Completed");
});

test("needs_input only → steady amber dot", () => {
  const dot = selectThreadDot({ activity: null, attentionKind: "needs_input" });
  assert.equal(dot.className, "conversation-activity-dot is-attention-input");
  assert.equal(dot.label, "Needs your input");
});

test("needs_input WINS over a live working turn (the finding-2 case)", () => {
  // A thread waiting on an approval keeps a working runtime status; the amber
  // dot must still show instead of the pulsing blue one.
  const dot = selectThreadDot({ activity: { tool: "bash" }, attentionKind: "needs_input" });
  assert.equal(dot.className, "conversation-activity-dot is-attention-input");
});

test("working outranks a stale completed flag", () => {
  const dot = selectThreadDot({ activity: { tool: null }, attentionKind: "completed" });
  assert.equal(dot.className, "conversation-activity-dot");
});
