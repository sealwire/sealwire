// A list carries a short copy of a long card body and says so; the row's detail has it
// whole. These are the rules both ends of that agree on.
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectClippedBodyItemIds,
  entryBodyClipped,
  overlayCardBodies,
  overlayCardBody,
} from "./card-body.js";

const ask = (extra) => ({
  id: "ask-1",
  asker_thread_id: "asker",
  peer_thread_id: "peer",
  task: "The brief",
  title: "The brief",
  instruction: "",
  status: "working",
  asked_at: 1,
  ...extra,
});

const call = (askExtra, extra) => ({
  row_id: "call",
  item_id: "call",
  kind: "tool_call",
  status: "completed",
  content_state: "full",
  tool: { item_type: "mcpToolCall", name: "delegate" },
  injection: { kind: "delegate_call", delegate: [ask(askExtra)] },
  ...extra,
});

const finding = (text, extra) => ({ severity: "high", text, ...extra });

const reviewRow = (round, extra) => ({
  row_id: "review",
  item_id: "review",
  kind: "user_text",
  status: "completed",
  text: "findings",
  injection: {
    kind: "review_result",
    review: {
      id: "r",
      round: 1,
      max_rounds: 2,
      status: "addressing_findings",
      rounds: [{ round: 1, started_at: 1, finished_at: 5, findings_total: 3, fixed_total: 0, ...round }],
      ...extra,
    },
  },
});

const settled = (extra) => ({
  row_id: "goal",
  item_id: "goal",
  kind: "tool_call",
  status: "completed",
  injection: {
    kind: "goal_settled",
    goal_settled: { goal_id: "g", seq: 1, status: "complete_claimed", report: "The rep…", ...extra },
  },
});

const summaryRow = (text, clipped, extra) => ({
  row_id: "summary",
  item_id: "summary",
  kind: "agent_text",
  status: "completed",
  text,
  injection: { kind: "handover_summary", handover: { id: "h", status: "done" }, ...(clipped ? { text_clipped: true } : {}) },
  ...extra,
});

test("only a body the relay says it shortened counts as one, never a trailing ellipsis", () => {
  assert.equal(entryBodyClipped(call({ task: "Ends like this…" })), false);
  assert.equal(entryBodyClipped(call({ task_clipped: true })), true);
  assert.equal(entryBodyClipped(call({ answer_clipped: true })), true);
  assert.equal(entryBodyClipped(summaryRow("a", true)), true);
  assert.equal(entryBodyClipped(summaryRow("a", false)), false);
  assert.equal(entryBodyClipped(settled({ report_clipped: true })), true);
  assert.equal(entryBodyClipped(reviewRow({ findings: [finding("a")] }, { findings_clipped: true })), true);
  assert.equal(entryBodyClipped(reviewRow({ findings: [finding("a")] })), false);
  assert.equal(entryBodyClipped(null), false);
});

test("a fetched body fills in what the list cut, and the row's news stays the list's", () => {
  const listed = call({ task: "The br…", task_clipped: true, status: "done", delivered: true });
  const fetched = call({ task: "The brief, all of it", status: "working", delivered: false });

  const drawn = overlayCardBody(listed, fetched);

  const drawnAsk = drawn.injection.delegate[0];
  assert.equal(drawnAsk.task, "The brief, all of it");
  assert.equal(drawnAsk.task_clipped, false);
  assert.equal(drawnAsk.status, "done", "how it went is the newer copy's");
  assert.equal(drawnAsk.delivered, true);
  assert.equal(entryBodyClipped(drawn), false);
});

test("a body the list already had whole is left as the list has it", () => {
  const listed = call({ task: "Short", status: "done" });
  const fetched = call({ task: "Something older", status: "working" });
  assert.equal(overlayCardBody(listed, fetched), listed);
  assert.equal(overlayCardBody(listed, null), listed);
});

test("a fetched copy that is itself short does not count as the whole body", () => {
  const listed = call({ task: "The br…", task_clipped: true });
  const fetched = call({ task: "The bri…", task_clipped: true });
  const drawn = overlayCardBody(listed, fetched);
  assert.equal(drawn.injection.delegate[0].task, "The bri…", "the longer opening is drawn");
  assert.equal(entryBodyClipped(drawn), true, "and the card still offers the rest");
});

test("text, answers, reports and findings each come from the fetched copy", () => {
  const text = overlayCardBody(
    summaryRow("## Goal\nPart", true, { status: "completed" }),
    summaryRow("## Goal\nPart and the rest", false)
  );
  assert.equal(text.text, "## Goal\nPart and the rest");
  assert.equal(text.injection.text_clipped, false);
  assert.equal(entryBodyClipped(text), false);

  const answer = overlayCardBody(
    call({ answer: "Half", answer_clipped: true, cited: [] }),
    call({ answer: "Half and the rest", cited: ["a.rs:1"] })
  );
  assert.equal(answer.injection.delegate[0].answer, "Half and the rest");
  assert.deepEqual(answer.injection.delegate[0].cited, ["a.rs:1"]);

  const report = overlayCardBody(
    settled({ report_clipped: true, resolution: "accepted" }),
    settled({ report: "The report, whole" })
  );
  assert.equal(report.injection.goal_settled.report, "The report, whole");
  assert.equal(report.injection.goal_settled.resolution, "accepted");

  const review = overlayCardBody(
    reviewRow({ findings: [finding("on…", { clipped: true })], delivered: true }, { findings_clipped: true, decision: "accepted" }),
    reviewRow({ findings: [finding("one, whole"), finding("two"), finding("three")] })
  );
  const round = review.injection.review.rounds[0];
  assert.deepEqual(round.findings.map((item) => item.text), ["one, whole", "two", "three"]);
  assert.equal(round.delivered, true, "the round's news is the list's");
  assert.equal(review.injection.review.decision, "accepted");
  assert.equal(entryBodyClipped(review), false);
});

test("a round the reviewer ran again since the fetch keeps the list's findings", () => {
  const listed = reviewRow({ findings: [finding("new…", { clipped: true })], finished_at: 9 }, { findings_clipped: true });
  const fetched = reviewRow({ findings: [finding("old, whole")], finished_at: 5 });
  assert.equal(overlayCardBody(listed, fetched), listed);
});

// A result card also carries the next round, only to count what it fixed.
test("a round the card only counts may start or end after the fetch without losing the findings", () => {
  const fetched = reviewRow({ findings: [finding("one, whole"), finding("two"), finding("three")] });
  const counted = { round: 2, started_at: 6, findings: [], fixed: [], findings_total: 0, fixed_total: 0 };
  const listed = reviewRow({ findings: [finding("on…", { clipped: true })] }, { findings_clipped: true });
  listed.injection.review.rounds.push(counted);

  const started = overlayCardBody(listed, fetched).injection.review;
  assert.deepEqual(started.rounds[0].findings.map((item) => item.text), ["one, whole", "two", "three"]);
  assert.deepEqual(started.rounds[1], counted, "the counted round is the list's");
  assert.equal(started.findings_clipped, false);

  const finished = { ...counted, finished_at: 9, fixed_total: 2 };
  listed.injection.review.rounds[1] = finished;
  assert.equal(overlayCardBody(listed, fetched).injection.review.rounds[1].fixed_total, 2);
  assert.equal(entryBodyClipped(overlayCardBody(listed, fetched)), false);
});

test("a round the short copy had no room for is filled in from the fetch", () => {
  const round = (number, fixed) => ({ round: number, started_at: 1, finished_at: 5, findings: [], findings_total: 0, fixed, fixed_total: 2 });
  const listed = reviewRow({ fixed: [finding("a…", { clipped: true })], fixed_total: 2 }, { findings_clipped: true });
  listed.injection.review.rounds.push(round(2, []));
  const fetched = reviewRow({ fixed: [finding("a, whole"), finding("b")], fixed_total: 2 });
  fetched.injection.review.rounds.push(round(2, [finding("c"), finding("d")]));

  const drawn = overlayCardBody(listed, fetched).injection.review.rounds;
  assert.deepEqual(drawn.flatMap((item) => item.fixed.map((one) => one.text)), ["a, whole", "b", "c", "d"]);
});

test("the rows that need their whole body fetched, and a stable list when none was", () => {
  const entries = [
    call({ task_clipped: true }),
    { row_id: "plain", kind: "agent_text", status: "completed", text: "hi" },
    summaryRow("a", true),
  ];
  assert.deepEqual(collectClippedBodyItemIds(entries), ["call", "summary"]);

  assert.equal(overlayCardBodies(entries, new Map()), entries);
  const details = new Map([["summary", summaryRow("a and b", false)]]);
  const drawn = overlayCardBodies(entries, details);
  assert.notEqual(drawn, entries);
  assert.equal(drawn[0], entries[0]);
  assert.equal(drawn[2].text, "a and b");
  assert.equal(overlayCardBodies(entries, details)[2], drawn[2], "the same pair draws the same object");
});

test("a fork card's long note is drawn whole once the row's detail has it", () => {
  const forkRow = (note, extra) => ({
    row_id: "brief",
    kind: "user_text",
    status: "completed",
    text: "the replayed context",
    injection: { kind: "fork_brief", fork: { id: "fork-1", note, ...extra } },
  });
  assert.equal(entryBodyClipped(forkRow("Short")), false);
  const listed = forkRow("The start of a long no…", { note_clipped: true, source_thread_id: "src" });
  assert.equal(entryBodyClipped(listed), true);

  const drawn = overlayCardBody(listed, forkRow("The start of a long note, and the rest of it"));
  assert.equal(drawn.injection.fork.note, "The start of a long note, and the rest of it");
  assert.equal(drawn.injection.fork.note_clipped, false);
  assert.equal(drawn.injection.fork.source_thread_id, "src", "the rest of the card is the list's");
  assert.equal(entryBodyClipped(drawn), false);
});
