// The Agents panel is a LEDGER of delegations, not a chat log. What distinguishes two
// delegations is what was asked, which round, and how it turned out — all of which the
// relay only carries as raw agent-written prose. These functions reduce that prose to a
// ledger row, and collapse repeat delegations to one agent into a single thread.
//
// Pure on purpose: the grouping is the part worth testing, and it must not need a DOM.

import { providerLabel } from "./provider-labels.js";
import { reviewChipTone, reviewStatusLabel } from "./review-state.js";

// A title has to stay one line in a 340px rail; a result gets two.
const TITLE_MAX = 76;
const RESULT_MAX = 160;

function stripMarkers(line) {
  return String(line)
    .replace(/^\s*(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`]/g, "")
    .replace(/:\s*$/, "")
    .trim();
}

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.–—-]+$/, "")}…`;
}

function firstMeaningfulLine(text) {
  let fenced = false;
  for (const raw of String(text || "").split("\n")) {
    if (raw.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const line = stripMarkers(raw);
    if (line && !/^[-=_]{3,}$/.test(line)) {
      return line;
    }
  }
  return null;
}

/** The one line that says what a delegation was FOR, out of an agent-written prompt. */
export function intentTitle(message) {
  const first = firstMeaningfulLine(message);
  if (!first) {
    return null;
  }
  if (first.length <= TITLE_MAX) {
    return first;
  }
  // A long opening paragraph usually states the request in its first sentence.
  const sentence = first.match(/^(.{16,76}?[.?!])(?:\s|$)/);
  return sentence ? sentence[1] : truncate(first, TITLE_MAX);
}

/** An answer flattened to the single line a ledger row has room for. */
export function oneLineResult(text) {
  const flat = String(text || "")
    .split("\n")
    .map(stripMarkers)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return flat ? truncate(flat, RESULT_MAX) : null;
}

/** Commit shas shorten; anything else (a uuid, a thread id) is refused rather than shown. */
export function shortSha(value) {
  const hex = String(value || "").trim();
  return /^[0-9a-f]{7,}$/i.test(hex) ? hex.slice(0, 7) : null;
}

function humanVerdict(verdict) {
  return verdict && verdict !== "unknown" ? String(verdict).replace(/_/g, " ") : null;
}

function byUpdatedAsc(a, b) {
  return (a?.updated_at || 0) - (b?.updated_at || 0);
}

/**
 * The review slot: the newest review is the conclusion, every earlier one collapses to a
 * single `R<n>` line. A failed attempt therefore stops earning a card that repeats its
 * error — the whole reason reviews were the loudest thing in the panel.
 */
export function reviewLedger(reviewJobs) {
  const jobs = (reviewJobs || []).filter(Boolean).slice().sort(byUpdatedAsc);
  if (!jobs.length) {
    return null;
  }
  const latest = jobs[jobs.length - 1];
  return {
    latest,
    attempt: jobs.length,
    // Two different "rounds" exist: one review's iterative loop, and successive review
    // requests on the thread. The loop is the more specific answer, so it wins the slot.
    roundLabel:
      latest.max_rounds > 1
        ? `round ${latest.round || 0}/${latest.max_rounds}`
        : `round ${jobs.length}`,
    provider: providerLabel(latest.reviewer_provider) || null,
    // The approval sha is a real commit by construction; the candidate may be a
    // checkpoint the relay made for itself, which nobody can `git show`.
    sha: shortSha(
      latest.verdict_candidate_sha ||
        (latest.candidate_is_checkpoint ? null : latest.candidate_sha)
    ),
    rounds: jobs
      .slice(0, -1)
      .reverse()
      .map((job, index) => ({
        id: job.id,
        label: `R${jobs.length - 1 - index}`,
        summary: reviewRoundSummary(job),
        at: job.updated_at || 0,
      })),
  };
}

function reviewRoundSummary(job) {
  const detail = oneLineResult(job.error) || humanVerdict(job.verdict);
  const label = reviewStatusLabel(job.status);
  return detail ? `${label} · ${detail}` : label;
}

/** What the review DECIDED, in the words the panel headlines it with. */
export function reviewOutcome(job) {
  if (!job) {
    return null;
  }
  if (job.status === "blocked") {
    return { text: "Review blocked — action needed", tone: "alert" };
  }
  const verdict = humanVerdict(job.verdict);
  if (verdict === "needs changes") {
    return { text: "Needs changes · won't merge yet", tone: "alert" };
  }
  if (verdict === "approve") {
    return { text: "Approved", tone: "ready" };
  }
  if (verdict === "unsure") {
    return { text: "Reviewer is unsure", tone: "neutral" };
  }
  return { text: reviewStatusLabel(job.status), tone: reviewChipTone(job.status) };
}

function askState(ask) {
  if (ask.status === "working") {
    return "working";
  }
  if (ask.error) {
    return "failed";
  }
  if (ask.answer) {
    return ask.delivered ? "answered" : "not handed back";
  }
  return ask.status || "done";
}

function askRoundSummary(ask) {
  return oneLineResult(ask.answer) || oneLineResult(ask.error) || askState(ask);
}

/**
 * Asks grouped by the agent on the other end, then by the thread the exchange lives in,
 * so a follow-up is a round inside its thread rather than a second card repeating the
 * same subject. `peer_provider` names the thread being ASKED — on an inbound ask that is
 * us, so those group by the asking session, which is the only identity we have for it.
 */
export function askLedger(asks, viewedThreadId) {
  const groups = new Map();

  for (const ask of (asks || []).filter(Boolean)) {
    const inbound = Boolean(viewedThreadId) && ask.asker_thread_id !== viewedThreadId;
    const otherThreadId = inbound ? ask.asker_thread_id : ask.peer_thread_id;
    const groupKey = inbound
      ? `session:${ask.asker_thread_id}`
      : `provider:${ask.peer_provider || "unknown"}`;
    const group = groups.get(groupKey) || {
      key: groupKey,
      inbound,
      name: inbound
        ? ask.asker_name || "another agent"
        : providerLabel(ask.peer_provider) || "another agent",
      provider: inbound ? null : ask.peer_provider || null,
      model: null,
      working: false,
      updatedAt: 0,
      threads: new Map(),
    };
    groups.set(groupKey, group);

    const threadKey = otherThreadId || ask.id;
    const thread = group.threads.get(threadKey) || { key: threadKey, otherThreadId, asks: [] };
    thread.asks.push(ask);
    group.threads.set(threadKey, thread);
  }

  return [...groups.values()]
    .map((group) => {
      const threads = [...group.threads.values()]
        .map((thread) => {
          const asks = thread.asks.slice().sort(byUpdatedAsc);
          const latest = asks[asks.length - 1];
          return {
            key: thread.key,
            otherThreadId: thread.otherThreadId,
            inbound: group.inbound,
            latest,
            state: askState(latest),
            title: intentTitle(latest.message) || "Untitled request",
            // The raw prompt never renders; the title carries the intent and the
            // tooltip carries the rest.
            prompt: String(latest.message || "").trim() || null,
            result: oneLineResult(latest.answer) || oneLineResult(latest.error),
            updatedAt: latest.updated_at || 0,
            rounds: asks
              .slice(0, -1)
              .reverse()
              .map((ask, index) => ({
                id: ask.id,
                label: `R${asks.length - 1 - index}`,
                summary: askRoundSummary(ask),
                at: ask.updated_at || 0,
              })),
          };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const newest = threads[0]?.latest;
      return {
        ...group,
        threads,
        model: group.inbound ? null : newest?.peer_model || null,
        working: threads.some((thread) => thread.state === "working"),
        updatedAt: threads[0]?.updatedAt || 0,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The "3 threads · 1 running" line beside the Asked heading. */
export function askedSummary(groups) {
  const threads = (groups || []).reduce((total, group) => total + group.threads.length, 0);
  if (!threads) {
    return null;
  }
  const running = (groups || []).reduce(
    (total, group) => total + group.threads.filter((thread) => thread.state === "working").length,
    0
  );
  const label = `${threads} thread${threads === 1 ? "" : "s"}`;
  return running ? `${label} · ${running} running` : label;
}
