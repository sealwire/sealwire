import assert from "node:assert/strict";
import { test } from "node:test";

import {
  askLedger,
  askedSummary,
  intentTitle,
  oneLineResult,
  reviewLedger,
  reviewOutcome,
  shortSha,
} from "./agents-ledger.js";

test("an intent title is the first real line, stripped of markdown", () => {
  assert.equal(
    intentTitle("## Research · where /goal should live\n\nSome long body."),
    "Research · where /goal should live"
  );
  assert.equal(intentTitle("- **Second opinion**: shard size 50k"), "Second opinion: shard size 50k");
  assert.equal(intentTitle("```\ncode\n```\nWould the tests pass"), "Would the tests pass");
  assert.equal(intentTitle("   \n\n"), null);
});

test("a one-paragraph prompt is cut at its first sentence, not mid-word", () => {
  const title = intentTitle(
    "Would the tests still pass if I revert it? I am asking because the retry loop " +
      "was rewritten twice and nobody re-ran the suite afterwards."
  );
  assert.equal(title, "Would the tests still pass if I revert it?");

  const noSentence = intentTitle(
    "rework the workspace-diff host into shared chrome and then also fold the rail into it"
  );
  assert.equal(
    noSentence,
    "rework the workspace-diff host into shared chrome and then also fold the…",
    "a sentence-less runaway line truncates at a word boundary"
  );
});

test("a result flattens to one line", () => {
  assert.equal(
    oneLineResult("Keep it a relay-owned record\n\nin the JSON state file, not SQLite."),
    "Keep it a relay-owned record in the JSON state file, not SQLite."
  );
  assert.equal(oneLineResult(""), null);
});

test("only a real sha shortens — a uuid or thread id is refused", () => {
  assert.equal(shortSha("2011c6939ab4f00c1d"), "2011c69");
  assert.equal(shortSha("3f2b1c7e-9a44-4c1a-8f0d-2b6e5a1c7d90"), null);
  assert.equal(shortSha("rev-thread-7"), null);
  assert.equal(shortSha(null), null);
});

const REVIEWS = [
  { id: "r1", status: "complete", verdict: "approve", updated_at: 100 },
  { id: "r2", status: "failed", error: "nothing committed to review", updated_at: 200 },
  {
    id: "r3",
    status: "complete",
    verdict: "needs_changes",
    reviewer_provider: "codex",
    verdict_candidate_sha: "2011c6939ab4",
    updated_at: 300,
  },
];

test("the newest review is the conclusion; earlier attempts collapse to one line each", () => {
  const ledger = reviewLedger(REVIEWS.slice().reverse());
  assert.equal(ledger.latest.id, "r3", "newest by updated_at leads, whatever the input order");
  assert.equal(ledger.attempt, 3);
  assert.equal(ledger.provider, "Codex");
  assert.equal(ledger.sha, "2011c69");
  assert.deepEqual(
    ledger.rounds.map((round) => [round.label, round.summary]),
    [
      ["R2", "Review failed · nothing committed to review"],
      ["R1", "Review complete · approve"],
    ]
  );
  assert.equal(reviewLedger([]), null);
});

test("the review headline states the decision, not the lifecycle, when there is a verdict", () => {
  assert.deepEqual(reviewOutcome({ status: "complete", verdict: "needs_changes" }), {
    text: "Needs changes · won't merge yet",
    tone: "alert",
  });
  assert.deepEqual(reviewOutcome({ status: "complete", verdict: "approve" }), {
    text: "Approved",
    tone: "ready",
  });
  // A blocked review outranks its verdict: it is the one thing the user must act on.
  assert.equal(reviewOutcome({ status: "blocked", verdict: "approve" }).text, "Review blocked — action needed");
  assert.equal(reviewOutcome({ status: "waiting_for_reviewer" }).text, "Reviewing");
  assert.equal(reviewOutcome(null), null);
});

const ASKS = [
  {
    id: "a1",
    asker_thread_id: "me",
    peer_thread_id: "codex-1",
    peer_provider: "codex",
    peer_model: "gpt-5-codex",
    message: "Research · where /goal should live",
    answer: "Keep it a relay-owned record in the JSON state file, not SQLite.",
    status: "done",
    delivered: true,
    updated_at: 100,
  },
  {
    id: "a2",
    asker_thread_id: "me",
    peer_thread_id: "codex-2",
    peer_provider: "codex",
    peer_model: "gpt-5-codex",
    message: "Would the tests still pass if I revert it",
    status: "working",
    updated_at: 300,
  },
  {
    id: "a3",
    asker_thread_id: "me",
    peer_thread_id: "codex-2",
    peer_provider: "codex",
    message: "and does the retry loop still back off",
    answer: "Yes, unchanged.",
    status: "done",
    delivered: true,
    updated_at: 200,
  },
];

test("asks group by agent, and a follow-up to one thread is a round inside it", () => {
  const [codex] = askLedger(ASKS, "me");
  assert.equal(codex.name, "Codex", "the agent's name is the GROUP heading");
  assert.equal(codex.model, "gpt-5-codex");
  assert.ok(codex.working, "the group reports the live thread");
  assert.equal(codex.threads.length, 2, "two subjects, not three cards");

  const [live, research] = codex.threads;
  assert.equal(live.key, "codex-2", "newest thread leads");
  assert.equal(live.title, "Would the tests still pass if I revert it");
  assert.equal(live.state, "working");
  assert.deepEqual(
    live.rounds.map((round) => [round.label, round.summary]),
    [["R1", "Yes, unchanged."]],
    "the earlier follow-up collapses into the thread rather than taking its own card"
  );
  assert.equal(research.rounds.length, 0);
  assert.equal(research.result, "Keep it a relay-owned record in the JSON state file, not SQLite.");
});

test("an inbound ask groups by the session that asked, since peer_provider names us", () => {
  const groups = askLedger(
    [
      {
        id: "in-1",
        asker_thread_id: "them",
        asker_name: "Retry work",
        peer_thread_id: "me",
        peer_provider: "codex",
        message: "have a look at the retry loop",
        status: "working",
        updated_at: 10,
      },
    ],
    "me"
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Retry work");
  assert.equal(groups[0].model, null, "we do not know what model asked us");
  assert.ok(groups[0].threads[0].inbound);
});

test("an answer nobody has been handed yet says so", () => {
  const [group] = askLedger(
    [
      {
        id: "a",
        asker_thread_id: "me",
        peer_thread_id: "p",
        peer_provider: "codex",
        message: "check it",
        answer: "done",
        status: "done",
        delivered: false,
        updated_at: 1,
      },
    ],
    "me"
  );
  assert.equal(group.threads[0].state, "not handed back");
});

test("the Asked heading counts threads, not asks", () => {
  assert.equal(askedSummary(askLedger(ASKS, "me")), "2 threads · 1 running");
  assert.equal(askedSummary(askLedger(ASKS.slice(0, 1), "me")), "1 thread");
  assert.equal(askedSummary([]), null);
});

test("a checkpoint commit is not offered as a sha the user can look up", () => {
  // Checkpoints are hidden commits the relay makes for itself. Showing seven
  // characters of one reads as "git show this", and it is not there.
  const checkpoint = reviewLedger([
    {
      id: "r1",
      status: "complete",
      candidate_sha: "2011c6939ab4f00c1d",
      candidate_is_checkpoint: true,
      updated_at: 10,
    },
  ]);
  assert.equal(checkpoint.sha, null);

  const real = reviewLedger([
    {
      id: "r1",
      status: "complete",
      candidate_sha: "2011c6939ab4f00c1d",
      candidate_is_checkpoint: false,
      updated_at: 10,
    },
  ]);
  assert.equal(real.sha, "2011c69");
});

test("an approved review still names the commit its approval is pinned to", () => {
  // The approval sha is a real commit by construction, so the checkpoint flag —
  // which describes `candidate_sha` — must not suppress it.
  const ledger = reviewLedger([
    {
      id: "r1",
      status: "complete",
      candidate_sha: "aaaaaaaaaaaaaaa",
      candidate_is_checkpoint: true,
      verdict_candidate_sha: "2011c6939ab4f00c1d",
      updated_at: 10,
    },
  ]);
  assert.equal(ledger.sha, "2011c69");
});
