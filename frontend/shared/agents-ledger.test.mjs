import assert from "node:assert/strict";
import { test } from "node:test";

import {
  askLedger,
  askedSummary,
  intentTitle,
  oneLineResult,
  reviewFindings,
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

const finding = (severity, text, location = null) => ({ severity, text, location });

const APPROVED = {
  kind: "review_result",
  round: 1,
  rounds: [{ round: 1, verdict: "approve", findings: [], findings_total: 0 }],
};

const REVIEWS = [
  { id: "r1", status: "complete", verdict: "approve", updated_at: 100, result: APPROVED },
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
      ["R1", "Approved · no findings"],
    ]
  );
  assert.equal(reviewLedger([]), null);
});

test("the review headline is the conversation card's title, in its colour", () => {
  const job = {
    status: "complete",
    reviewer_provider: "codex",
    max_rounds: 1,
    result: {
      kind: "review_result",
      round: 1,
      rounds: [
        {
          round: 1,
          verdict: "needs_changes",
          findings: [finding("high", "Gate checked once", "src/gate.rs:88"), finding("medium", "Archive drops it")],
          findings_total: 2,
        },
      ],
    },
  };
  assert.deepEqual(reviewOutcome(job), { text: "1 blocker · won't merge as is", tone: "blocker" });
  assert.deepEqual(reviewOutcome({ ...job, result: APPROVED }), {
    text: "Approved · no findings",
    tone: "ready",
  });
  const escalated = {
    ...job,
    status: "escalated",
    max_rounds: 2,
    result: {
      kind: "review_escalated",
      round: 2,
      rounds: [{ round: 1 }, { ...job.result.rounds[0], round: 2 }],
    },
  };
  assert.deepEqual(reviewOutcome(escalated), { text: "Codex still disagrees on 2 points", tone: "alert" });
  // A blocked review outranks its verdict: it is the one thing the user must act on.
  assert.equal(reviewOutcome({ ...job, status: "blocked" }).text, "Review blocked — action needed");
  // Reading the next round: what it found last time is not what it is doing now.
  assert.deepEqual(reviewOutcome({ ...job, status: "waiting_for_reviewer", reviewing_since: 50 }), {
    text: "Reviewing",
    tone: "active",
  });
  assert.equal(
    reviewOutcome({ status: "complete", verdict: "needs_changes" }).text,
    "Review complete",
    "a verdict with nothing listed is not put into words of its own"
  );
  assert.equal(reviewOutcome(null), null);
});

test("a review's findings are the rows its conversation card lists", () => {
  const rows = [1, 2, 3, 4].map((n) => finding(n === 1 ? "high" : "low", `finding ${n}`));
  const listed = reviewFindings({
    status: "complete",
    reviewer_provider: "codex",
    result: {
      kind: "review_result",
      round: 1,
      rounds: [{ round: 1, verdict: "needs_changes", findings: rows, findings_total: 6 }],
    },
  });
  assert.deepEqual(
    listed.rows.map(({ finding, state }) => [finding.text, state]),
    rows.map((row) => [row.text, null])
  );
  assert.equal(listed.more, 2, "the relay held two back");
  assert.equal(reviewFindings({ status: "complete" }), null);
  assert.equal(
    reviewFindings({ status: "waiting_for_reviewer", reviewing_since: 9, result: APPROVED }),
    null,
    "nothing is listed while the reviewer reads the next round"
  );
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

test("a server ask preview is not normalized a second time by the ledger", () => {
  // New relays set `title`/`result`. That — not a length guess — is what must stop
  // a second intentTitle/oneLineResult pass from stripping digits or disagreeing
  // with Rust's Unicode-scalar bounds under emoji.
  const emojiTitle = `2. ${"😀".repeat(38)}`;
  const emojiResult = `2026. ${"😀".repeat(78)}`;
  const [projected] = askLedger(
    [
      {
        id: "preview-1",
        asker_thread_id: "me",
        peer_thread_id: "codex-1",
        peer_provider: "codex",
        title: emojiTitle,
        result: emojiResult,
        message: emojiTitle,
        answer: emojiResult,
        status: "done",
        delivered: true,
        updated_at: 1,
      },
    ],
    "me"
  );
  assert.equal(projected.threads[0].title, emojiTitle);
  assert.equal(projected.threads[0].result, emojiResult);

  // A short legacy body without `title` still goes through the markdown stripper.
  const [legacy] = askLedger(
    [
      {
        id: "legacy-1",
        asker_thread_id: "me",
        peer_thread_id: "codex-1",
        peer_provider: "codex",
        message: "## 2. Investigate auth retries",
        answer: "- **Fixed** the retry",
        status: "done",
        delivered: true,
        updated_at: 2,
      },
    ],
    "me"
  );
  assert.equal(legacy.threads[0].title, "2. Investigate auth retries");
  assert.equal(legacy.threads[0].result, "Fixed the retry");
});

test("an inbound ask groups by the session that asked, since peer_provider names us", () => {
  const groups = askLedger(
    [
      {
        id: "in-1",
        asker_thread_id: "them",
        asker_name: "Retry work",
        asker_provider: "claude_code",
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
  assert.equal(groups[0].provider, "claude_code", "the asker's provider, not ours");
  assert.equal(groups[0].model, null, "we do not know what model asked us");
  assert.ok(groups[0].threads[0].inbound);
});

test("an inbound ask with no name still takes the asker's provider logo, not a letter 'a'", () => {
  // Without asker_provider the panel fell back to name "another agent" and a letter mark
  // of "a" — which looks like a broken logo, not an unknown peer.
  const [group] = askLedger(
    [
      {
        id: "in-2",
        asker_thread_id: "them",
        asker_name: null,
        asker_provider: "codex",
        peer_thread_id: "me",
        peer_provider: "claude_code",
        message: "New round, and this one is frontend.",
        answer: "Ranked findings Critical — …",
        status: "done",
        delivered: true,
        updated_at: 10,
      },
    ],
    "me"
  );
  assert.equal(group.provider, "codex");
  assert.equal(group.name, "Codex", "provider label beats the 'another agent' placeholder");
});

test("an outbound ask with an empty peer_provider still groups under the peer once stamped", () => {
  const [group] = askLedger(
    [
      {
        id: "out-1",
        asker_thread_id: "me",
        peer_thread_id: "them",
        peer_provider: "codex",
        message: "New round, and this one is frontend.",
        status: "done",
        delivered: true,
        updated_at: 10,
      },
    ],
    "me"
  );
  assert.equal(group.provider, "codex");
  assert.equal(group.name, "Codex");
  assert.equal(group.inbound, false);
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
