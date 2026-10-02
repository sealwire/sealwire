// Design 27a: the relay's goal prompts are drawn as what they were for — a line where each
// turn starts and a card where the agent settled the goal — never as bubbles nobody typed.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent } from "./shared/transcript-react.js";
import { dispatchGoalAction, goalToolLabel } from "./shared/goal-card.js";
import { isVolatileEntry } from "./shared/caching-transcript-fetcher.js";
import { offersReviewNudge } from "./shared/review-state.js";

const h = React.createElement;
const CONTINUATION = "Keep working toward the goal. Call goal_status first.";

const user = (id, text, extra = {}) => ({ item_id: id, kind: "user_text", status: "completed", text, ...extra });
const agent = (id, text, extra = {}) => ({ item_id: id, kind: "agent_text", status: "completed", text, ...extra });
const turnLine = (id, goalTurn) => user(id, CONTINUATION, { injection: { kind: "goal_turn", goal_turn: goalTurn } });
const tool = (id, name, args, extra = {}) => ({
  item_id: id,
  kind: "tool_call",
  status: "completed",
  text: "",
  tool: { item_type: "mcpToolCall", name, title: name, input_preview: JSON.stringify(args), result_preview: "ok" },
  ...extra,
});

const STEPS = [
  { title: "Design usage view", status: "done", note: "shipped", turn: 1 },
  { title: "Delegate the backend", status: "active", note: "codex has it", turn: 3 },
  { title: "Independent verification", status: "pending" },
];
const settled = (card = {}) => ({
  goal_id: "goal-1",
  thread_id: "t1",
  status: "complete_claimed",
  objective: "Ship per-session usage",
  turns: 5,
  max_turns: 20,
  provider: "claude_code",
  steps: STEPS.map((step) => ({ ...step, status: "done" })),
  left_for_you: [],
  report: "## Summary\n\nAll tests pass.",
  options: [],
  settled_at: 1_790_000_000,
  resolution: null,
  ...card,
});
const settleRow = (id, card, name = "mcp__sealwire-a8b0__goal_complete") =>
  tool(id, name, { summary: "done" }, { injection: { kind: "goal_settled", goal_settled: settled(card) } });

function render(entries, options = {}) {
  return renderToStaticMarkup(h(TranscriptContent, { entries, options: { provider: "claude_code", ...options } }));
}

// What a reader sees, without the tags a line is split into.
function textOf(markup) {
  return markup.replace(/<[^>]+>/g, "");
}

function count(markup, needle) {
  return markup.split(needle).length - 1;
}

test("a goal turn starts with a line, not a bubble of the relay's prompt", () => {
  const markup = render([
    turnLine("u1", { goal_id: "goal-1", turn: 4, max_turns: 20, step: { index: 3, total: 4, title: "Review round 2" } }),
    agent("a1", "Re-checking the phone layout."),
  ]);
  assert.ok(markup.includes("goal-turn"));
  assert.ok(markup.includes("turn 4 of 20"));
  assert.ok(markup.includes("Step 3 · Review round 2"));
  assert.ok(!markup.includes(CONTINUATION), "the relay's own prompt is never shown");
  assert.ok(!markup.includes("chat-message-user"), "and it is not the person's bubble");
  assert.equal(count(markup, 'class="message-avatar"'), 1, "the reply under it still opens the turn");
});

test("a settled card still loading is a placeholder, so the reply after it keeps the turn's mark", () => {
  for (const status of ["complete_claimed", "blocked", "awaiting_user"]) {
    const markup = render([
      user("u1", "go"),
      { ...settleRow("settle", { status }), content_state: "omitted" },
      agent("reply", "Done."),
    ]);
    const reply = markup.slice(markup.indexOf('data-transcript-entry-id="reply"'));
    assert.equal(count(markup, 'class="message-avatar"'), 1, `${status}: the turn still has its mark`);
    assert.ok(reply.includes('class="message-avatar"'), `${status}: on the reply, since the placeholder draws none`);
  }
});

test("a turn line with no step says only the turn", () => {
  const markup = render([turnLine("u1", { goal_id: "goal-1", turn: 1, max_turns: 20 })]);
  assert.ok(markup.includes("turn 1 of 20"));
  assert.ok(!markup.includes("goal-turn-step"));
});

// It is the relay talking, so the idle review nudge still waits for the person's own words.
test("a turn line is not the person's own message", () => {
  const session = {
    transcript: [
      user("u0", "/delegate a task", { injection: { kind: "delegate_task", delegate: [{ id: "a" }] } }),
      turnLine("u1", { goal_id: "goal-1", turn: 2, max_turns: 20 }),
    ],
  };
  assert.equal(offersReviewNudge(session, {}, "t1"), false);
});

test("a completion claim is a green card with its steps, what is left, and its buttons", () => {
  const markup = render([
    agent("a1", "All done."),
    settleRow("tool", { left_for_you: ["Not committed; restart relay 8787"] }),
  ]);
  assert.ok(markup.includes("goal-card is-pass"));
  assert.ok(textOf(markup).includes("Goal complete · claimed by Claude"));
  assert.ok(markup.includes("Ship per-session usage"));
  assert.ok(markup.includes("5 turns"));
  assert.ok(markup.includes("Design usage view"));
  assert.ok(markup.includes(">shipped<"), "a settled step says what came of it");
  assert.ok(markup.includes("Left for you"));
  assert.ok(markup.includes("Not committed; restart relay 8787"));
  assert.ok(markup.includes("Full report"), "the report is one press away");
  assert.ok(!markup.includes("All tests pass."), "and folded until then");
  assert.ok(markup.includes('data-goal-action="resume"'));
  assert.ok(markup.includes("Not done — keep going"));
  assert.ok(markup.includes('data-goal-action="stop"'));
  assert.ok(markup.includes("Mark done"));
  assert.ok(markup.includes("is-turn-continued"), "the turn's mark is on the reply above it");
});

test("a goal waiting on the person is amber, with the question under the step it stopped on", () => {
  const markup = render([
    settleRow(
      "tool",
      {
        status: "awaiting_user",
        turns: 3,
        steps: STEPS,
        report: "Provider has no opus 5.5 xhigh — use high?",
        options: ["Use opus 5.5 high", "Stop here"],
      },
      "goal_needs_you"
    ),
  ]);
  assert.ok(markup.includes("goal-card is-needs-you"));
  assert.ok(textOf(markup).includes("Goal needs you · turn 3 of 20"));
  assert.ok(markup.includes("paused"));
  assert.ok(markup.includes("goal-step-mark is-flag is-needs-you"));
  const flagged = markup.slice(markup.indexOf("Delegate the backend"), markup.indexOf("Independent verification"));
  assert.ok(flagged.includes("Provider has no opus 5.5 xhigh"), "the question sits under its step");
  assert.ok(!markup.includes("codex has it"), "in place of that step's note");
  assert.equal(count(markup, 'data-goal-action="option"'), 2);
  assert.ok(markup.includes('data-goal-option="Use opus 5.5 high"'));
  assert.ok(markup.includes('data-goal-action="reply"'));
  assert.ok(!markup.includes('data-goal-action="stop"'), "a question is answered, not cancelled");
  assert.ok(!markup.includes("Left for you"));
  assert.equal(count(markup, 'class="message-avatar"'), 1, "the card opens its turn when nothing came before it");
});

test("a stuck goal is red, and with no plan its reason is a paragraph", () => {
  const markup = render([
    settleRow("tool", { status: "blocked", turns: 3, steps: [], report: "No access to the staging box." }, "goal_blocked"),
  ]);
  assert.ok(markup.includes("goal-card is-blocker"));
  assert.ok(textOf(markup).includes("Goal stuck · turn 3 of 20"));
  assert.ok(markup.includes("No access to the staging box."));
  assert.ok(markup.includes("Reply…"));
  assert.ok(markup.includes("Cancel goal"));
  assert.ok(!markup.includes('data-goal-action="option"'));
});

test("once answered, a card's buttons give way to how it was answered", () => {
  const cases = [
    [{ resolution: "reopened" }, "Reopened"],
    [{ resolution: "accepted" }, "Marked done"],
    [{ status: "awaiting_user", options: ["Yes"], resolution: "answered" }, "Answered"],
    [{ status: "blocked", resolution: "cancelled" }, "Cancelled"],
  ];
  for (const [card, line] of cases) {
    const markup = render([settleRow("tool", card)]);
    assert.ok(markup.includes(`goal-card-resolved">${line}<`), line);
    assert.ok(!markup.includes("data-goal-action"), `${line}: no buttons left`);
    assert.ok(!markup.includes(">paused<"), `${line}: no longer paused`);
  }
});

test("a settling call is never folded into the turn's tool group", () => {
  const markup = render([
    agent("a1", "Checking."),
    tool("t1", "Read", { file_path: "a.js" }),
    tool("t2", "mcp__sealwire-a8b0__goal_status", {}),
    settleRow("t3"),
    { ...tool("t4", "Bash", {}), tool: { name: "Bash", command: "ls" } },
    { ...tool("t5", "Bash", {}), tool: { name: "Bash", command: "ls -la" } },
  ]);
  assert.ok(markup.includes("goal-card is-pass"));
  assert.match(markup, /Read 1 file<\/span><span class="work-group-rest"> · 1 tool</, "the rows before it group without it");
  assert.ok(markup.includes("Ran 2 commands"), "and the rows after it are a group of their own");
});

test("settled statuses that get no card stay an ordinary tool row", () => {
  const markup = render([settleRow("tool", { status: "out_of_turns" })]);
  assert.ok(!markup.includes("goal-card"));
});

test("goal tool rows say what they did, from their arguments only", () => {
  assert.deepEqual(goalToolLabel({ name: "mcp__sealwire-a8b0__goal_status", input_preview: "{}" }), {
    title: "Checked goal status",
    detail: "",
  });
  assert.deepEqual(
    goalToolLabel({ name: "goal_plan", input_preview: JSON.stringify({ steps: ["Design", "Build", "Verify"] }) }),
    { title: "Planned 3 steps", detail: "Design · Build · Verify" }
  );
  assert.equal(
    goalToolLabel({ name: "goal_step", input_preview: JSON.stringify({ step: 2, status: "done", note: "tests pass" }) }).title,
    "Step 2 done"
  );
  assert.equal(
    goalToolLabel({ name: "goal_step", input_preview: JSON.stringify({ step: 3, status: "active" }) }).title,
    "Step 3 started"
  );
  assert.equal(goalToolLabel({ name: "goal_plan", input_preview: '{"steps": ["cut off' }).title, "Planned the goal");
  assert.equal(goalToolLabel({ name: "delegate", input_preview: "{}" }), null);
  assert.equal(goalToolLabel({ name: "my_goal_status_tool" }), null);

  const markup = render([tool("t1", "mcp__sealwire-a8b0__goal_step", { step: 2, status: "done", note: "tests pass" })]);
  assert.ok(markup.includes("Step 2 done"));
  assert.ok(markup.includes("tests pass"));
});

// Whether a card is still the one the goal sits on is the relay's call: this device's copy
// of the goal can be stale, and acting on it wrote old words back over a revision.
test("a card's keep going and stop go to the relay with the card's seq, never the cached goal", () => {
  const calls = [];
  const handlers = {
    card: (threadId, seq, action) => calls.push(["card", threadId, seq, action]),
    send: (threadId, text) => calls.push(["send", threadId, text]),
    reply: (threadId) => calls.push(["reply", threadId]),
  };
  const press = (action, extra = {}) =>
    dispatchGoalAction({ action, threadId: "t1", goalId: "goal-1", seq: "3", option: "", ...extra }, handlers);
  press("resume");
  press("stop");
  press("reply");
  press("bogus");
  assert.deepEqual(calls, [
    ["card", "t1", 3, "keep_going"],
    ["card", "t1", 3, "stop"],
    ["reply", "t1"],
  ]);

  calls.length = 0;
  for (const goal of [null, { id: "goal-1", thread_id: "t1", objective: "old words", settlement_seq: 9 }]) {
    dispatchGoalAction({ action: "resume", threadId: "t1", goalId: "goal-1", seq: "3" }, { ...handlers, goal });
  }
  assert.deepEqual(
    calls,
    [
      ["card", "t1", 3, "keep_going"],
      ["card", "t1", 3, "keep_going"],
    ],
    "a missing or stale cached goal neither blocks the press nor lends it an objective"
  );

  calls.length = 0;
  press("stop", { seq: "" });
  press("resume", { seq: undefined });
  assert.deepEqual(calls, [], "a card that names no seq cannot ask for anything");
});

// Any reply resumes a goal that waits on the person, so an answer needs no card check —
// and a stale reviews cache must not leave the buttons dead.
test("an offered answer is sent to the card's thread with no cached goal at all", () => {
  const calls = [];
  dispatchGoalAction(
    { action: "option", threadId: "t1", goalId: "goal-1", seq: "4", option: "Use opus 5.5 high" },
    { card: () => calls.push(["card"]), send: (threadId, text) => calls.push(["send", threadId, text]) }
  );
  dispatchGoalAction({ action: "option", threadId: "t1", seq: "4", option: "" }, { send: () => calls.push(["empty"]) });
  assert.deepEqual(calls, [["send", "t1", "Use opus 5.5 high"]]);
});

test("a settled card is re-read until the person has answered it", () => {
  const row = (resolution) => settleRow("tool", { resolution });
  assert.ok(isVolatileEntry(row(null)));
  assert.ok(!isVolatileEntry(row("accepted")));
});

test("a snapshot's clipped report never replaces the whole one already read, but its news does", async () => {
  const { prepareTranscriptHydrationState } = await import("./shared/transcript-hydration-store.js");
  const whole = "R".repeat(3000);
  const row = (card, content_state) => ({ ...settleRow("settle", card), turn_id: "turn-1", content_state });
  const state = {
    session: { active_thread_id: "t1", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "t1", transcript_revision: 10 },
    transcriptHydrationEntries: new Map([["settle", row({ report: whole }, "full")]]),
    transcriptHydrationOrder: ["settle"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "t1|sig",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "t1",
  };
  const snapshot = {
    active_thread_id: "t1",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [row({ report: `${"R".repeat(1599)}…`, report_clipped: true, resolution: "reopened" }, "preview")],
  };

  Object.assign(state, prepareTranscriptHydrationState(state, snapshot).patch);

  const card = state.transcriptHydrationEntries.get("settle").injection.goal_settled;
  assert.equal(card.report, whole);
  assert.equal(card.resolution, "reopened", "what did change still lands");
});

test("a turn line whose prompt text was dropped from the snapshot is still the line", () => {
  const shell = { ...turnLine("u1", { goal_id: "goal-1", turn: 2, max_turns: 20 }), text: "Keep work…", content_state: "omitted" };
  const markup = render([shell]);
  assert.ok(markup.includes("turn 2 of 20"));
  assert.ok(!markup.includes("Loading message"));
});
