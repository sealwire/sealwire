// Design 24a–24c: every prompt a review sends is drawn as what it was for, one card per
// round, never as a bubble the person did not type.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent } from "./shared/transcript-react.js";
import { dispatchReviewAction, reviewDuration, reviewProgressFor } from "./shared/review-card.js";

const h = React.createElement;
const BASE = "3a0e1f2aa4b5c6d7e8f90123456789abcdef0123";
const HEAD = "7be04d1bb4b5c6d7e8f90123456789abcdef0123";

const finding = (severity, text, location = null) => ({ severity, text, location });
const round = (number, extra = {}) => ({
  round: number,
  reviewer_thread_id: "rev",
  verdict: "needs_changes",
  findings: [],
  findings_total: 0,
  fixed: [],
  fixed_total: 0,
  base_sha: BASE,
  candidate_sha: HEAD,
  checkpoint: false,
  files: 6,
  insertions: 84,
  deletions: 41,
  change: "Gate set_goal on tool availability",
  started_at: 1_790_000_000,
  finished_at: 1_790_000_124,
  ...extra,
});
const ROUND_ONE = round(1, {
  delivered: true,
  findings: [
    finding("high", "The gate is checked only at creation.", "src/goal/gate.rs:88"),
    finding("medium", "Archive deletes the goal with the turn."),
  ],
  findings_total: 2,
});
const review = (extra = {}) => ({
  id: "review-1",
  round: 1,
  max_rounds: 1,
  parent_thread_id: "parent",
  parent_title: "Fix goal gate",
  parent_provider: "claude_code",
  reviewer_thread_id: "rev",
  reviewer_provider: "codex",
  status: "complete",
  rounds: [ROUND_ONE],
  ...extra,
});
const user = (id, text, extra = {}) => ({ item_id: id, kind: "user_text", status: "completed", text, ...extra });
const agent = (id, text, extra = {}) => ({ item_id: id, kind: "agent_text", status: "completed", text, ...extra });
const marked = (id, kind, reviewExtra = {}, text = `PROMPT-${id}`) =>
  user(id, text, { injection: { kind, review: review(reviewExtra) } });

function render(entries, options = {}) {
  return renderToStaticMarkup(h(TranscriptContent, { entries, options: { provider: "claude_code", ...options } }));
}

const reviewCall = (id, extra = {}) => ({
  item_id: id, kind: "tool_call", status: "completed", text: "RAW-MCP-REVIEW-RESULT",
  tool: { name: "review", title: "review", item_type: "mcpToolCall", result_preview: "RAW-MCP-REVIEW-RESULT" },
  injection: { kind: "review_call", review: review({ round: 0, rounds: [], status: "pending_parent_recap", ...extra }) },
});

test("MCP review replaces its tool row and stays one request as results arrive", () => {
  for (const status of ["pending_parent_recap", "waiting_for_reviewer", "complete", "failed"]) {
    const markup = render([reviewCall("call", { status })]);
    assert.equal((markup.match(/data-review-call-id="review-1"/g) || []).length, 1);
    assert.ok(!markup.includes("RAW-MCP-REVIEW-RESULT"));
    assert.ok(!markup.includes("Used 1 tool"));
  }
});

test("MCP review request and delivered review result are separate events", () => {
  const markup = render([reviewCall("call"), marked("result", "review_result")]);
  assert.equal((markup.match(/data-review-call-id="review-1"/g) || []).length, 1);
  assert.equal((markup.match(/data-review-id="review-1"/g) || []).length, 2);
  assert.ok(markup.includes("The gate is checked only at creation."));
});

test("two MCP reviews stay separate, and refused tool calls keep their error", () => {
  const markup = render([reviewCall("one"), reviewCall("two", { id: "review-2" })]);
  assert.equal((markup.match(/data-review-call-id=/g) || []).length, 2);
  const failed = render([{ ...reviewCall("bad"), status: "failed" }], { expandedKeys: new Set(["entry:bad", "tool:bad:result"]) });
  assert.ok(!failed.includes("data-review-call-id="));
  assert.ok(failed.includes("RAW-MCP-REVIEW-RESULT"));
});

test("a result replaces the prompt that carried it, and the recap asked for is not shown", () => {
  const markup = render([
    user("u0", "please fix the gate"),
    agent("a0", "done"),
    marked("recap", "review_recap", { round: 0, rounds: [] }),
    agent("a1", "Recap: I gated set_goal."),
    marked("result", "review_result"),
    agent("a2", "Codex is right, moving the check."),
  ]);

  assert.doesNotMatch(markup, /PROMPT-recap|PROMPT-result/, "no injected prompt is drawn as a message");
  assert.doesNotMatch(markup, /Sent to/, "what the relay sent is never shown");
  assert.match(markup, /Reviewed by Codex</);
  assert.match(markup, /1 blocker · won&#x27;t merge as is/);
  assert.match(markup, /class="handover-card review-card is-blocker"/);
  assert.match(markup, />HIGH</);
  assert.match(markup, />MED</);
  assert.match(markup, /src\/goal\/gate\.rs:88/);
  assert.match(markup, /data-open-thread-id="rev"[^>]*>Reviewer thread/);
  assert.match(markup, /at <code>7be04d1<\/code>/);
  assert.match(markup, /2m 04s/);
  assert.match(markup, /Codex is right, moving the check\./, "the agent's reply follows as usual");
});

test("a result card sits in the agent's column, not the person's", () => {
  const markup = render([marked("result", "review_result")]);
  const article = markup.match(/<article[^>]*data-transcript-entry-id="result"[^>]*>/)?.[0] || "";
  assert.match(article, /chat-message-assistant/, article);
  assert.doesNotMatch(article, /chat-message-user/, "a right-aligned row shrinks the card to nothing");
});

test("a result card is the reviewer's, so the mark goes on the agent's reply under it", () => {
  const markup = render([marked("result", "review_result"), agent("a1", "On it.")]);
  const card = markup.slice(0, markup.indexOf('data-transcript-entry-id="a1"'));
  assert.doesNotMatch(card, /class="message-avatar"/, "no mark on the reviewer's result");
  assert.match(card, /is-turn-continued/, "it keeps the agent column's text edge");
  assert.equal((markup.match(/class="message-avatar"/g) || []).length, 1, "the reply opens the turn");
});

const peerAsk = (id, extra = {}) => ({
  id,
  asker_thread_id: "parent",
  asker_provider: "claude_code",
  peer_thread_id: `peer-${id}`,
  peer_provider: "codex",
  task: "Check the gate",
  title: "Check the gate",
  instruction: "",
  status: "working",
  delivered: false,
  asked_at: 1_790_000_000,
  sent_at: 1_790_000_030,
  ...extra,
});
const OWN_CARDS = {
  "review call": () => reviewCall("own"),
  "delegate call": () => ({
    item_id: "own",
    kind: "tool_call",
    status: "completed",
    tool: { item_type: "mcpToolCall", name: "delegate", title: "delegate" },
    injection: { kind: "delegate_call", delegate: [peerAsk("sent")] },
  }),
};
const marks = (markup) => (markup.match(/class="message-avatar"/g) || []).length;

test("a turn that starts with the agent's own review or delegate card wears one mark, on that card", () => {
  const incoming = {
    "a delegate's answer": user("in", "W", {
      injection: { kind: "delegate_answer", delegate: [peerAsk("answered", { status: "done", delivered: true, answer: "Bounded.", finished_at: 1_790_000_100 })] },
    }),
    "a review result": marked("in", "review_result"),
    "your message": user("in", "go on"),
  };
  for (const [from, row] of Object.entries(incoming)) {
    for (const [card, call] of Object.entries(OWN_CARDS)) {
      const markup = render([row, call(), agent("reply", "Waiting on it.")]);
      const where = `${from}, then a ${card}`;
      assert.equal(marks(markup), 1, `${where}: one mark for the turn`);
      const reply = markup.slice(markup.indexOf('data-transcript-entry-id="reply"'));
      assert.doesNotMatch(reply, /class="message-avatar"/, `${where}: the card opened the turn, not the reply`);
    }
  }
});

test("an own review or delegate card later in a turn takes no second mark", () => {
  for (const [card, call] of Object.entries(OWN_CARDS)) {
    const markup = render([user("u1", "go"), agent("first", "Asking."), call()]);
    assert.equal(marks(markup), 1, `${card}: the turn's first reply has it`);
    assert.match(markup, /is-turn-continued[^>]*>(?:(?!<article)[\s\S])*(?:data-review-call-id|Delegated to)/, `${card}: it keeps the reply's text edge`);
  }
});

test("an own card still loading is a placeholder, so the reply after it keeps the turn's mark", () => {
  for (const [card, call] of Object.entries(OWN_CARDS)) {
    const markup = render([user("u1", "go"), { ...call(), content_state: "omitted" }, agent("reply", "Waiting on it.")]);
    const reply = markup.slice(markup.indexOf('data-transcript-entry-id="reply"'));
    assert.equal(marks(markup), 1, `${card}: the turn still has its mark`);
    assert.match(reply, /class="message-avatar"/, `${card}: on the reply, since the placeholder draws none`);
  }
});

test("an approval with nothing found is green and says so", () => {
  const markup = render([
    marked("result", "review_result", {
      rounds: [round(1, { verdict: "approve" })],
    }),
  ]);
  assert.match(markup, /is-pass/);
  assert.match(markup, /Approved · no findings/);
});

test("while the agent fixes a round, that round's card says so", () => {
  const markup = render([
    marked("result", "review_result", { max_rounds: 3, status: "addressing_findings" }),
  ]);
  assert.match(markup, /Reviewed by Codex · round 1 of 3/);
  assert.match(markup, /Claude is fixing/);
});

test("a later round folds the earlier card to one line saying what got fixed", () => {
  const rounds = [
    ROUND_ONE,
    round(2, {
      verdict: "approve",
      fixed: ROUND_ONE.findings,
      fixed_total: 2,
      finished_at: 1_790_000_540,
    }),
  ];
  const markup = render([
    marked("result", "review_result", { max_rounds: 3, rounds }),
    agent("a1", "Both fixed."),
    marked("commit", "review_commit", { max_rounds: 3, rounds }),
    marked("approved", "review_approved", { round: 2, max_rounds: 3, rounds }),
  ]);

  assert.doesNotMatch(markup, /PROMPT-commit/, "the commit reminder is not a message");
  assert.match(markup, /class="review-strip is-blocker"/);
  assert.match(markup, /<b>Round 1<\/b> · 1 blocker, 1 medium/);
  assert.match(markup, />2 fixed</);
  assert.match(markup, /Approved after 2 rounds/);
  assert.equal((markup.match(/>fixed</g) || []).length, 2, "the last card lists what was fixed");
  assert.match(markup, /9m/);
});

test("a card lists three findings, each folded to two lines, and keeps the rest a press away", () => {
  const five = Array.from({ length: 5 }, (_, index) => finding("medium", `finding ${index}`));
  const markup = render([
    marked("result", "review_result", { rounds: [round(1, { findings: five, findings_total: 5 })] }),
  ]);
  for (const shown of ["finding 0", "finding 1", "finding 2"]) {
    assert.match(markup, new RegExp(`>${shown}<`));
  }
  assert.doesNotMatch(markup, />finding 3</);
  assert.match(markup, />Show all findings</);
  assert.match(markup, /class="review-finding-text card-fold is-clamped"/);
});

test("a finding names its file, and the whole path is on hover", () => {
  // A path eats the row's width from the finding itself, and the file name is what
  // tells two findings apart at a glance.
  const markup = render([
    marked("result", "review_result", {
      rounds: [
        round(1, {
          delivered: true,
          findings: [
            finding("high", "Gate checked once.", "crates/relay-server/src/goal/gate.rs:88"),
            finding("medium", "Archive drops it.", "archive.rs:142"),
          ],
          findings_total: 2,
        }),
      ],
    }),
  ]);
  assert.match(
    markup,
    /class="review-finding-where" title="crates\/relay-server\/src\/goal\/gate\.rs:88">gate\.rs:88</
  );
  assert.match(
    markup,
    /class="review-finding-where">archive\.rs:142</,
    "a bare name has nothing more to show on hover"
  );
});

test("three findings or fewer need nothing to open", () => {
  const markup = render([marked("result", "review_result")]);
  assert.doesNotMatch(markup, /Show all findings/);
});

test("a review out of rounds asks the person, and stops asking once they decide", () => {
  const rounds = [ROUND_ONE, round(2, { findings: [finding("high", "Races with hot reload.", "gate.rs:96")], findings_total: 1, fixed: [ROUND_ONE.findings[1]], fixed_total: 1 })];
  const escalated = (extra = {}) =>
    render([marked("esc", "review_escalated", { round: 2, max_rounds: 2, status: "escalated", rounds, ...extra })]);

  const asking = escalated();
  assert.match(asking, /is-needs-you/);
  assert.match(asking, /Review needs you · 2 of 2 rounds used/);
  assert.match(asking, /Codex still disagrees on 1 point</);
  // Every row it lists is still standing, so a per-row "open" told nothing apart.
  assert.doesNotMatch(asking, /review-finding-state/);
  assert.match(asking, /1 fixed earlier/);
  assert.match(asking, /data-review-action="rerun"[^>]*data-parent-thread-id="parent"[^>]*data-reviewer-thread-id="rev"[^>]*data-reviewer-provider="codex"[^>]*>One more round/);
  assert.match(asking, /data-review-action="accept"[^>]*>Accept as is/);

  const decided = escalated({ decision: "accepted" });
  assert.doesNotMatch(decided, /data-review-action/);
  assert.match(decided, /You accepted it as it stands\./);

  const continued = escalated({ decision: "continued" });
  assert.doesNotMatch(continued, /data-review-action/, "the next round answers this card");
  assert.match(continued, /Reviewed again below\./);
});

test("the reviewer thread opens on a request card and closes each round with one line", () => {
  const markup = render(
    [
      marked("brief", "review_brief", { max_rounds: 3, status: "addressing_findings" }),
      agent("r1", "The gate is checked once.\n\nVERDICT: NEEDS_CHANGES", {
        injection: { kind: "review_reply", review: review({ max_rounds: 3, status: "addressing_findings" }) },
      }),
    ],
    { provider: "codex" }
  );

  assert.doesNotMatch(markup, /PROMPT-brief/);
  assert.match(markup, /Review requested by Claude · round 1 of 3/);
  assert.match(markup, /class="handover-card-title">Fix goal gate</);
  assert.match(markup, /Gate set_goal on tool availability/);
  assert.match(markup, /3a0e1f2…7be04d1 · 6 files · \+84 −41/);
  assert.match(markup, /data-open-thread-id="parent"[^>]*>Reviewed thread/);
  assert.match(markup, /Result sent to Claude/);
  assert.equal((markup.match(/Result sent to Claude/g) || []).length, 1, "loading the request adds no second result");
  assert.match(markup, /· 1 blocker, 1 medium/);
});

test("the reviewer reply page shows its result without loading the request page", () => {
  const markup = render(
    [agent("r1", "## Findings\nNone.\n\nVERDICT: APPROVE", {
      injection: { kind: "review_reply", review: review({ rounds: [round(1, { verdict: "approve", delivered: true })] }) },
    })],
    { provider: "codex" }
  );

  assert.match(markup, /VERDICT: APPROVE/, "the review text stays readable");
  assert.match(markup, /Result sent to Claude/);
  assert.equal((markup.match(/Result sent to Claude/g) || []).length, 1);
  assert.match(markup, /data-open-thread-id="parent"[^>]*>Reviewed thread/);
});

test("an unrelated user row between request and reply does not duplicate the result", () => {
  const markup = render(
    [
      marked("brief", "review_brief"),
      user("intervening", "A provider-side note"),
      agent("r1", "VERDICT: NEEDS_CHANGES", {
        injection: { kind: "review_reply", review: review() },
      }),
    ],
    { provider: "codex" }
  );

  assert.equal((markup.match(/Result sent to Claude/g) || []).length, 1);
  assert.ok(markup.indexOf("VERDICT: NEEDS_CHANGES") < markup.indexOf("Result sent to Claude"));
});

test("a review recorded before reply marks keeps its result when the request page loads", () => {
  const markup = render(
    [marked("brief", "review_brief"), agent("r1", "VERDICT: NEEDS_CHANGES")],
    { provider: "codex" }
  );
  assert.equal((markup.match(/Result sent to Claude/g) || []).length, 1);
});

test("a round whose result never reached the agent does not claim it did", () => {
  const markup = render(
    [
      marked("brief", "review_brief", { rounds: [round(1, { findings: ROUND_ONE.findings, findings_total: 2, delivered: false })] }),
      agent("r1", "The gate is checked once.\n\nVERDICT: NEEDS_CHANGES"),
    ],
    { provider: "codex" }
  );
  assert.doesNotMatch(markup, /Result sent/);
});

test("a round still being read has no closing line yet", () => {
  const markup = render(
    [marked("brief", "review_brief", { status: "waiting_for_reviewer", rounds: [round(1, { verdict: null, finished_at: null })] })],
    { provider: "codex" }
  );
  assert.doesNotMatch(markup, /Result sent/);
});

test("while a review runs, the reviewed thread ends on one live line", () => {
  // The snapshot only says a review runs; what it is doing comes from this device's reviews.
  const activity = [
    { id: "review-1", parent_thread_id: "other", status: "waiting_for_reviewer" },
    { id: "review-2", parent_thread_id: "parent", reviewer_thread_id: "rev", status: "waiting_for_reviewer" },
  ];
  const jobs = [
    {
      id: "review-2",
      parent_thread_id: "parent",
      reviewer_thread_id: "rev",
      status: "waiting_for_reviewer",
      reviewer_provider: "codex",
      round: 1,
      max_rounds: 1,
      reviewing_since: Date.now() / 1000 - 72,
      files: 6,
    },
  ];
  const progress = reviewProgressFor(activity, jobs, "parent");
  const markup = render([user("u0", "hi")], { reviewProgress: progress });

  assert.match(markup, />Reviewing</);
  assert.match(markup, /Codex is reading your last change · 6 files · 1m 1\ds/);
  assert.match(markup, /data-open-thread-id="rev"[^>]*>Watch/);
  assert.match(markup, /data-review-action="stop"[^>]*data-review-id="review-2"[^>]*>Stop/);

  assert.match(
    render([user("u0", "hi")], { reviewProgress: reviewProgressFor(activity, [], "parent") }),
    /The reviewer is reading your last change/,
    "before this device's reviews arrive the line still says what is happening"
  );
  assert.equal(
    reviewProgressFor([{ ...activity[1], status: "addressing_findings" }], jobs, "parent"),
    null,
    "while the agent fixes, the round's card says so instead"
  );
});

test("the card's buttons mean the same thing on every surface", () => {
  const calls = [];
  const handlers = {
    stop: (id) => calls.push(["stop", id]),
    accept: (id) => calls.push(["accept", id]),
    rerun: (values) => calls.push(["rerun", values]),
  };
  dispatchReviewAction({ action: "stop", reviewId: "r" }, handlers);
  dispatchReviewAction({ action: "accept", reviewId: "r" }, handlers);
  dispatchReviewAction(
    { action: "rerun", reviewId: "r", parentThreadId: "p", reviewerThreadId: "t", reviewerProvider: "codex" },
    handlers
  );
  assert.deepEqual(calls, [
    ["stop", "r"],
    ["accept", "r"],
    [
      "rerun",
      {
        reviewerProvider: "codex",
        reviewerThreadId: "t",
        parentThreadId: "p",
        maxRounds: 1,
        recapSource: "last_message",
        continuesReviewId: "r",
      },
    ],
  ]);
});

test("a page holding a review that can still change is not cached as settled", async () => {
  const { isCacheablePage } = await import("./shared/caching-transcript-fetcher.js");
  const page = (extra) => ({ thread_id: "parent", entries: [marked("result", "review_result", extra)] });

  assert.equal(isCacheablePage(page({ status: "waiting_for_reviewer" }), "parent"), false);
  assert.equal(isCacheablePage(page({ status: "escalated" }), "parent"), false, "the person has not decided");
  assert.equal(isCacheablePage(page({ status: "escalated", decision: "accepted" }), "parent"), true);
  assert.equal(isCacheablePage(page({ status: "complete" }), "parent"), true);
});

test("a page and a snapshot both carry the review mark into the held rows", async () => {
  const { createMergedTranscriptHydrationPagePatch, prepareTranscriptHydrationState } = await import(
    "./shared/transcript-hydration-store.js"
  );
  const row = (status) => ({ ...marked("result", "review_result", { status }), content_state: "full", turn_id: "t1", tool: null });
  const held = {
    transcriptHydrationEntries: new Map([["result", row("addressing_findings")]]),
    transcriptHydrationOrder: ["result"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "parent|sig",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "parent",
  };

  const paged = createMergedTranscriptHydrationPagePatch(
    held,
    { thread_id: "parent", prev_cursor: null, entries: [row("complete")] },
    { prepend: false }
  );
  assert.equal(paged.transcriptHydrationEntries.get("result").injection?.review.status, "complete");

  const state = {
    ...held,
    session: { active_thread_id: "parent", transcript_revision: 10 },
    transcriptHydrationBaseSnapshot: { active_thread_id: "parent", transcript_revision: 10 },
  };
  const snapshot = {
    active_thread_id: "parent",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [row("complete")],
  };
  Object.assign(state, prepareTranscriptHydrationState(state, snapshot).patch);
  assert.equal(state.transcriptHydrationEntries.get("result").injection?.review.status, "complete");
});

test("a card says how long a round took the way a person reads it", () => {
  assert.equal(reviewDuration(45), "45s");
  assert.equal(reviewDuration(124), "2m 04s");
  assert.equal(reviewDuration(540), "9m 00s");
  assert.equal(reviewDuration(900), "15m");
  assert.equal(reviewDuration(3_900), "1h 5m");
  assert.equal(reviewDuration(NaN), "");
});
