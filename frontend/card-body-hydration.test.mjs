// A snapshot squeezed to an empty shell must not empty a card the client already holds.
import test from "node:test";
import assert from "node:assert/strict";

import { prepareTranscriptHydrationState } from "./shared/transcript-hydration-store.js";

function hydrated(row) {
  const id = row.row_id;
  return {
    session: { active_thread_id: "t", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "t", transcript_revision: 10 },
    transcriptHydrationEntries: new Map([[id, row]]),
    transcriptHydrationOrder: [id],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "t|sig",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "t",
  };
}

function shelled(state, row) {
  const snapshot = { active_thread_id: "t", transcript_revision: 11, transcript_truncated: true, transcript: [row] };
  Object.assign(state, prepareTranscriptHydrationState(state, snapshot).patch);
  return state.transcriptHydrationEntries.get(row.row_id);
}

const call = (task, extra) => ({
  row_id: "call",
  item_id: "call",
  kind: "tool_call",
  status: "completed",
  turn_id: "t1",
  tool: { item_type: "mcpToolCall", name: "delegate" },
  content_state: "full",
  injection: {
    kind: "delegate_call",
    delegate: [{ id: "ask", asker_thread_id: "t", task, task_clipped: true, title: "T", status: "working", asked_at: 1, sent_at: 2 }],
  },
  ...extra,
});

test("an emptied shell keeps the brief already read, and the news it brings lands", () => {
  const state = hydrated(call("The brief, its opening…"));
  const shell = call("", { content_state: "omitted" });
  shell.injection.delegate[0].status = "done";
  shell.injection.delegate[0].task_clipped = false;

  const ask = shelled(state, shell).injection.delegate[0];

  assert.equal(ask.task, "The brief, its opening…");
  assert.equal(ask.task_clipped, true, "still the opening, so it still says so");
  assert.equal(ask.status, "done");
});

const finding = (text) => ({ severity: "high", text });
const review = (round, extra) => ({
  row_id: "review",
  item_id: "review",
  kind: "user_text",
  status: "completed",
  turn_id: "t1",
  text: "findings",
  content_state: "full",
  injection: {
    kind: "review_result",
    review: {
      id: "r",
      round: 1,
      max_rounds: 1,
      status: "complete",
      rounds: [{ round: 1, findings_total: 2, fixed_total: 0, started_at: 1, finished_at: 5, findings: [], fixed: [], ...round }],
      ...extra,
    },
  },
});

test("an emptied shell keeps the findings already read, and the decision it brings lands", () => {
  const state = hydrated(review({ findings: [finding("one"), finding("two")], change: "the change" }));
  const shell = review({ delivered: true }, { decision: "accepted" });
  shell.content_state = "omitted";

  const kept = shelled(state, shell).injection.review;

  assert.deepEqual(kept.rounds[0].findings.map((item) => item.text), ["one", "two"]);
  assert.equal(kept.rounds[0].change, "the change");
  assert.equal(kept.rounds[0].delivered, true);
  assert.equal(kept.decision, "accepted");
});

// A push cuts a card's bodies further than a page does and says so only on the card, so
// its copy arrives "full"; the longer opening already held must not give way to it.
test("a push's shorter cut never replaces the longer opening held, but its news lands", () => {
  const state = hydrated(call(`${"b".repeat(2000)}…`));
  const pushed = call(`${"b".repeat(1200)}…`);
  pushed.injection.delegate[0].status = "done";

  const ask = shelled(state, pushed).injection.delegate[0];

  assert.equal(ask.task.length, 2001);
  assert.equal(ask.task_clipped, true);
  assert.equal(ask.status, "done");
});

const summary = (text, clipped) => ({
  row_id: "summary",
  item_id: "summary",
  kind: "agent_text",
  status: "completed",
  turn_id: "t1",
  text,
  content_state: "full",
  injection: { kind: "handover_summary", handover: { id: "h", status: "done" }, ...(clipped ? { text_clipped: true } : {}) },
});

test("a summary held whole stays whole, and is not called short, when a push cuts it", () => {
  const whole = "s".repeat(1800);
  const state = hydrated(summary(whole, false));

  const kept = shelled(state, summary(`${"s".repeat(1200)}…`, true));

  assert.equal(kept.text, whole);
  assert.equal(kept.injection.text_clipped, false);
});

test("a report held longer stays when a push cuts it shorter", () => {
  const settled = (report) => ({
    row_id: "goal",
    item_id: "goal",
    kind: "tool_call",
    status: "completed",
    turn_id: "t1",
    tool: { item_type: "mcpToolCall", name: "goal_complete" },
    content_state: "full",
    injection: { kind: "goal_settled", goal_settled: { goal_id: "g", seq: 1, report, report_clipped: true } },
  });
  const state = hydrated(settled(`${"r".repeat(2000)}…`));
  const pushed = settled(`${"r".repeat(1200)}…`);
  pushed.injection.goal_settled.resolution = "accepted";

  const kept = shelled(state, pushed).injection.goal_settled;

  assert.equal(kept.report.length, 2001);
  assert.equal(kept.resolution, "accepted");
});
