// Design 25a–25c: every prompt a /delegate sends is drawn as what it was for — a card
// where it was asked and a card where it was answered — never as a bubble nobody typed.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent } from "./shared/transcript-react.js";
import { dispatchDelegateAction } from "./shared/delegate-card.js";
import { isVolatileEntry } from "./shared/caching-transcript-fetcher.js";

const h = React.createElement;
const INSTRUCTION = "\n\n---\nAnother agent asked for this and cannot see your session. When you are done, call the `report_back` tool.";
const BRIEF = "How does remote Ask read message text?\n\nFind where the remote ask handler takes its text.";
const WAKE = "The agents you asked have finished. You were not waiting, so here is what they said.\n\n---\nYou asked peer:\nBRIEF\n\nIt said:\nFrom innerText.\n\nDecide what to do next: carry on with one of them, ask someone else, tell the user, or stop.";

const ask = (extra = {}) => ({
  id: "ask-1",
  asker_thread_id: "asker",
  asker_title: "Selection Ask",
  asker_provider: "claude_code",
  peer_thread_id: "peer",
  peer_provider: "codex",
  task: "问下 Codex，remote 那边 ask 是怎么取文字的",
  title: "How does remote Ask read message text?",
  instruction: INSTRUCTION,
  status: "working",
  answered_with_tool: false,
  delivered: false,
  asked_at: 1_790_000_000,
  sent_at: 1_790_000_030,
  ...extra,
});
const user = (id, text, extra = {}) => ({ item_id: id, kind: "user_text", status: "completed", text, ...extra });
const agent = (id, text) => ({ item_id: id, kind: "agent_text", status: "completed", text });
const marked = (id, kind, asks, text = `PROMPT-${id}`) =>
  user(id, text, { injection: { kind, delegate: asks } });
const reportBack = (id, name, answer) => ({
  item_id: id,
  kind: "tool_call",
  status: "completed",
  text: "",
  tool: { item_type: "mcpToolCall", name, title: name, input_preview: JSON.stringify({ answer }) },
});

function render(entries, options = {}) {
  return renderToStaticMarkup(h(TranscriptContent, { entries, options: { provider: "claude_code", ...options } }));
}

function count(markup, needle) {
  return markup.split(needle).length - 1;
}

test("while the brief is written there is one line, and the prompt that asked for it is not shown", () => {
  const markup = render([
    marked("req", "delegate_request", [ask({ sent_at: undefined, peer_thread_id: "" })], "BRIEF-PROMPT"),
    { ...agent("brief", "half a bri"), status: "running" },
  ]);
  assert.ok(markup.includes("/delegate 问下 Codex"), "what the person typed stays theirs");
  assert.ok(markup.includes("Preparing brief"));
  assert.ok(markup.includes("Claude is writing the question for Codex"));
  assert.ok(markup.includes('data-delegate-action="cancel"'));
  assert.ok(!markup.includes("BRIEF-PROMPT"), "the relay's own prompt is never a bubble");
  assert.ok(!markup.includes("half a bri"), "the brief shows once it is a card, not while it streams");
});

test("once sent, the brief becomes the Delegated card and the peer's progress is its footer", () => {
  const markup = render([
    marked("req", "delegate_request", [ask()], "BRIEF-PROMPT"),
    agent("brief", BRIEF),
  ]);
  assert.ok(markup.includes("Delegated to Codex"));
  assert.ok(markup.includes("How does remote Ask read message text?"));
  assert.ok(markup.includes("Codex is working"));
  assert.ok(markup.includes('data-open-thread-id="peer"'));
  assert.equal(count(markup, "Find where the remote ask handler"), 1, "the brief is drawn once, on the card");
  assert.equal(
    count(markup, "How does remote Ask read message text?"),
    1,
    "its first line is the card's title, not said again in the body"
  );
  assert.ok(markup.includes("card-fold is-clamped"), "two lines until pressed, like every card");
  assert.ok(!markup.includes("Preparing brief"));
});

test("the answer replaces the wake, folds the asked card to a line, and opens the asker's turn", () => {
  const done = ask({ status: "done", delivered: true, answer: "From innerText, so it carries the button label.", finished_at: 1_790_000_160 });
  const markup = render([
    marked("req", "delegate_request", [done], "BRIEF-PROMPT"),
    agent("brief", BRIEF),
    marked("wake", "delegate_answer", [done], WAKE),
    agent("decision", "Confirmed — switching remote/ask.js to data-ask-message."),
  ]);
  assert.ok(markup.includes("review-strip"), "the asked card is a line now");
  assert.ok(markup.includes("<b>Delegated to Codex</b> · How does remote Ask read message text?"));
  assert.ok(markup.includes("Codex answered"));
  assert.ok(markup.includes("From innerText, so it carries the button label."));
  assert.ok(markup.includes("2m 40s"), "how long the answer took");
  assert.ok(!markup.includes("The agents you asked have finished"), "the wake itself is not shown");
  assert.ok(!markup.includes("Decide what to do next"));
  assert.ok(!markup.includes("Find where the remote ask handler"), "folded: the brief waits behind the line");
  const answerAt = markup.indexOf("Codex answered");
  const decisionAt = markup.indexOf("Confirmed — switching");
  assert.ok(answerAt < decisionAt, "the decision follows the card");
  assert.equal(
    count(markup, "message-avatar"),
    1,
    "one mark for the folded card, the answer under it, and the reply that follows"
  );
});

test("no answer: the answer row is amber with the reason, and there is nothing to press", () => {
  const failed = ask({ status: "failed", delivered: true, error: "it stopped without answering", finished_at: 1_790_000_300 });
  const markup = render([
    marked("req", "delegate_request", [failed]),
    agent("brief", BRIEF),
    marked("wake", "delegate_answer", [failed], WAKE),
  ]);
  assert.ok(markup.includes("review-strip"), "the asked card is a line once its outcome is handed back");
  assert.equal(count(markup, "No answer from Codex"), 1, "said once, on the answer card");
  assert.ok(markup.includes("It stopped without answering."));
  assert.ok(markup.includes("is-needs-you"), "amber");
  assert.ok(!markup.includes("data-delegate-action"), "the asker decides what next, not a button");
});

test("a brief that never got written leaves the turn's rows as they were", () => {
  const failed = ask({ status: "failed", sent_at: undefined, peer_thread_id: "", error: "this session did not write a brief" });
  const markup = render([marked("req", "delegate_request", [failed]), agent("brief", "I could not.")]);
  assert.ok(markup.includes("Delegate did not start"));
  assert.ok(markup.includes("This session did not write a brief."));
  assert.ok(markup.includes("I could not."), "what it did write is still readable");
});

test("the peer gets the task as a card, without the instruction after it", () => {
  const markup = render([marked("task", "delegate_task", [ask()], `${BRIEF}${INSTRUCTION}`)]);
  assert.ok(markup.includes("Task from Claude · Selection Ask"));
  assert.ok(markup.includes("Find where the remote ask handler"));
  assert.ok(!markup.includes("report_back"), "the instruction is for the agent, not the reader");
  assert.ok(markup.includes('data-open-thread-id="asker"'));
});

test("the peer's report_back call is the Reported back card, and its reminder is one line", () => {
  const done = ask({ status: "done", delivered: true, answered_with_tool: true, answer: "From innerText.", finished_at: 1_790_000_160 });
  const markup = render([
    marked("task", "delegate_task", [done], `${BRIEF}${INSTRUCTION}`),
    agent("a1", "Confirmed, it is innerText."),
    marked("nudge", "delegate_nudge", [done], "You finished without calling `report_back`."),
    reportBack("tool", "mcp__sealwire__report_back", "From innerText."),
  ]);
  assert.ok(markup.includes("Reminded Codex to report back"));
  assert.ok(!markup.includes("You finished without calling"));
  assert.ok(markup.includes("Reported back to Claude"));
  assert.ok(markup.includes("From innerText."));
  assert.ok(markup.includes("Delivered"));
  assert.ok(!markup.includes("mcp__sealwire__report_back"), "the call is the card, not a tool row");
});

test("a peer without the tool answers in prose, and that reply is the card", () => {
  const done = ask({ status: "done", delivered: false, answered_with_tool: false, answer: "It is innerText.", finished_at: 1_790_000_160 });
  const markup = render([
    marked("task", "delegate_task", [done], `${BRIEF}${INSTRUCTION}`),
    agent("a1", "Looking."),
    agent("a2", "It is innerText."),
  ]);
  assert.equal(count(markup, "It is innerText."), 1, "drawn once, as the card");
  assert.ok(markup.includes("Reported back to Claude"));
  assert.ok(markup.includes("Claude gets it when it is free"));
  assert.ok(markup.includes("Looking."), "the rest of the turn stays");
});

test("Cancel means one thing on every surface", () => {
  const calls = [];
  const handlers = { cancel: (threadId) => calls.push(threadId) };
  dispatchDelegateAction({ action: "cancel", threadId: "asker" }, handlers);
  dispatchDelegateAction({ action: "bogus", threadId: "asker" }, handlers);
  assert.deepEqual(calls, ["asker"]);
});

test("a delegate row is re-read until its card can no longer change", () => {
  const row = (extra) => marked("r", "delegate_answer", [ask(extra)]);
  assert.ok(isVolatileEntry(row({ status: "working" })));
  assert.ok(isVolatileEntry(row({ status: "failed", delivered: false })), "the asker hears of it next");
  assert.ok(isVolatileEntry(row({ status: "done", delivered: false })), "not yet handed back");
  assert.ok(!isVolatileEntry(row({ status: "done", delivered: true })));
  assert.ok(!isVolatileEntry(row({ status: "failed", delivered: true })));
  assert.ok(!isVolatileEntry(row({ status: "failed", peer_thread_id: "", sent_at: undefined })), "never reached anyone");
});

test("a snapshot's clipped answer never replaces the whole one already read, but its news does", async () => {
  const { prepareTranscriptHydrationState } = await import("./shared/transcript-hydration-store.js");
  const whole = "W".repeat(3000);
  const row = (card, content_state) => ({
    ...marked("wake", "delegate_answer", [ask(card)], WAKE),
    turn_id: "t1",
    tool: null,
    content_state,
  });
  const state = {
    session: { active_thread_id: "asker", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "asker", transcript_revision: 10 },
    transcriptHydrationEntries: new Map([["wake", row({ status: "done", answer: whole, delivered: false }, "full")]]),
    transcriptHydrationOrder: ["wake"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "asker|sig",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "asker",
  };
  const snapshot = {
    active_thread_id: "asker",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [row({ status: "done", answer: `${"W".repeat(1599)}…`, delivered: true }, "preview")],
  };

  Object.assign(state, prepareTranscriptHydrationState(state, snapshot).patch);

  const card = state.transcriptHydrationEntries.get("wake").injection.delegate[0];
  assert.equal(card.answer, whole);
  assert.equal(card.delivered, true, "what did change still lands");
});

test("an answer marked where it is becomes the card even when the task row is not loaded", () => {
  const done = ask({ status: "done", delivered: true, answered_with_tool: true, answer: "From innerText.", finished_at: 1_790_000_160 });
  const markup = render([
    agent("a1", "Long work, pages of it."),
    { ...reportBack("tool", "report_back", "From innerText."), injection: { kind: "delegate_reported", delegate: [done] } },
  ]);
  assert.ok(markup.includes("Reported back to Claude"));
  assert.ok(markup.includes("From innerText."));
  assert.ok(!markup.includes(">report_back<"), "not drawn as a tool row as well");

  const prose = ask({ status: "done", delivered: true, answer: "It is innerText.", finished_at: 1_790_000_160 });
  const reply = render([{ ...agent("a2", "It is innerText."), injection: { kind: "delegate_reported", delegate: [prose] } }]);
  assert.ok(reply.includes("Reported back to Claude"));
  assert.equal(count(reply, "It is innerText."), 1);
});
