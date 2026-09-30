// The Agents panel is a LEDGER of delegations, not a chat log. What distinguishes two
// delegations is what was asked, which round, and how it turned out. New relays send those
// fields as bounded previews; these functions also reduce legacy raw prose to the same
// ledger row and collapse repeat delegations to one agent into a single thread.
//
// Pure on purpose: the grouping is the part worth testing, and it must not need a DOM.

import { providerLabel } from "./provider-labels.js";
import { cardFindings, reviewCardTitle, reviewTone } from "./review-card.js";
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
  const error = oneLineResult(job.error);
  if (error) {
    return `${reviewStatusLabel(job.status)} · ${error}`;
  }
  return reviewResultCard(job)?.title || reviewStatusLabel(job.status);
}

// The panel's colours for the conversation card's tones.
const PANEL_TONES = { blocker: "blocker", pass: "ready", "needs-you": "alert" };

/**
 * The conversation's last card for this review, as the relay sent it. Null while the
 * reviewer reads a newer round: what it found before is not what it is doing now.
 */
function reviewResultCard(job) {
  const result = job?.result;
  if (!result?.kind || !Array.isArray(result.rounds)) {
    return null;
  }
  if (job.reviewing_since > 0) {
    return null;
  }
  const review = {
    reviewer_provider: job.reviewer_provider,
    round: result.round,
    max_rounds: job.max_rounds,
    rounds: result.rounds,
  };
  const round = result.rounds.find((entry) => entry.round === result.round) || null;
  return {
    kind: result.kind,
    round,
    title: reviewCardTitle(result.kind, review, round),
    tone: PANEL_TONES[reviewTone(result.kind, round)] || "neutral",
    ...cardFindings(result.kind, review, round),
  };
}

/** What the review's card lists: `{rows, more}` for `FindingList`, or null. */
export function reviewFindings(job) {
  const card = reviewResultCard(job);
  return card
    ? {
        rows: card.rows,
        more: card.more,
        verdict: card.round?.verdict || null,
        note: card.round?.verdict_note || null,
      }
    : null;
}

/** What the review DECIDED, in the words its card in the conversation uses. */
export function reviewOutcome(job) {
  if (!job) {
    return null;
  }
  if (job.status === "blocked") {
    return { text: "Review blocked — action needed", tone: "alert" };
  }
  const card = reviewResultCard(job);
  if (card) {
    return { text: card.title, tone: card.tone };
  }
  return { text: reviewStatusLabel(job.status), tone: reviewChipTone(job.status) };
}

/** New relays project the ledger onto `title`/`result`. That field is the discriminator —
 * not a length heuristic, which cannot tell a preview from a short legacy body and also
 * disagrees with Rust's Unicode-scalar bounds under emoji. */
function askHasProjectedLedger(ask) {
  return typeof ask?.title === "string";
}

function cardTitle(ask) {
  if (askHasProjectedLedger(ask)) {
    const title = String(ask.title || "").trim();
    return title || "Untitled request";
  }
  return intentTitle(ask?.message) || "Untitled request";
}

function cardResult(ask) {
  if (askHasProjectedLedger(ask)) {
    const direct = ask.result ?? ask.answer ?? ask.error;
    const raw = String(direct || "").trim();
    return raw || null;
  }
  return oneLineResult(ask?.answer) || oneLineResult(ask?.error);
}

function askState(ask) {
  // Nothing runs until the user answers an agent's flagship request.
  if (ask.status === "working" && ask.model_request?.decision === "pending") {
    return "needs you";
  }
  if (ask.status === "working") {
    return "working";
  }
  if (ask.error) {
    return "failed";
  }
  if (ask.answer || ask.result) {
    return ask.delivered ? "answered" : "not handed back";
  }
  return ask.status || "done";
}

function askRoundSummary(ask) {
  if (ask.model_request?.started_model) {
    const result = cardResult(ask);
    return `Started on ${ask.model_request.started_model}${result ? ` · ${result}` : ""}`;
  }
  if (ask.model_request?.start_error) {
    return `Did not start · ${ask.model_request.start_error}`;
  }
  return cardResult(ask) || askState(ask);
}

/**
 * Asks grouped by the agent on the other end, then by the thread the exchange lives in,
 * so a follow-up is a round inside its thread rather than a second card repeating the
 * same subject. `peer_provider` names the thread being ASKED — on an inbound ask that is
 * us, so those group by the asking session and take `asker_provider` for the logo.
 */
export function askLedger(asks, viewedThreadId) {
  const groups = new Map();

  for (const ask of (asks || []).filter(Boolean)) {
    const inbound = Boolean(viewedThreadId) && ask.asker_thread_id !== viewedThreadId;
    const otherThreadId = inbound ? ask.asker_thread_id : ask.peer_thread_id;
    const groupKey = inbound
      ? `session:${ask.asker_thread_id}`
      : `provider:${ask.peer_provider || "unknown"}`;
    const groupProvider = inbound ? ask.asker_provider || null : ask.peer_provider || null;
    const group = groups.get(groupKey) || {
      key: groupKey,
      inbound,
      // Prefer the session's own name; fall back to the provider label before the
      // generic "another agent", which only exists to avoid an empty heading — and
      // whose first letter used to become a fake logo ("a").
      name: inbound
        ? ask.asker_name || providerLabel(ask.asker_provider) || "another agent"
        : providerLabel(ask.peer_provider) || "another agent",
      provider: groupProvider,
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
          const modelRequests = asks.filter(
            (ask) => ask.model_request && (ask === latest || ask.status === "working")
          );
          const shownRequests = new Set(modelRequests.map((ask) => ask.id));
          return {
            key: thread.key,
            otherThreadId: thread.otherThreadId,
            inbound: group.inbound,
            latest,
            state: askState(latest),
            // Delegated to you, the peer session is this one, so its name says nothing.
            title: (!group.inbound && latest.peer_title) || cardTitle(latest),
            result: cardResult(latest),
            updatedAt: latest.updated_at || 0,
            // An unanswered request is still actionable even when a later round
            // exists. Keep its subject with its controls so the decision is clear.
            modelRequests: modelRequests
              .reverse()
              .map((ask) => ({ id: ask.id, title: cardTitle(ask), request: ask.model_request })),
            rounds: asks
              .slice(0, -1)
              .reverse()
              .map((ask, index) =>
                shownRequests.has(ask.id)
                  ? null
                  : {
                      id: ask.id,
                      label: `R${asks.length - 1 - index}`,
                      summary: askRoundSummary(ask),
                      at: ask.updated_at || 0,
                    }
              )
              .filter(Boolean),
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

/** How many delegation subjects a section heading counts. */
export function threadCount(groups) {
  return (groups || []).reduce((total, group) => total + group.threads.length, 0);
}

function handoverRow(label, text) {
  return text ? { label, text } : null;
}

/**
 * The viewed thread's handovers, split by which end it is. A handover still being
 * written has given the target nothing yet, so only its source shows it.
 */
export function handoverLedger(links, viewedThreadId) {
  const pickedUp = [];
  const handedOver = [];
  const newest = (links || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  for (const link of newest) {
    if (link.target_thread_id === viewedThreadId && link.status === "done") {
      pickedUp.push({
        key: link.id,
        direction: "from",
        name: link.source_title || providerLabel(link.source_provider) || "Another session",
        provider: link.source_provider || null,
        title: null,
        state: null,
        at: link.created_at || 0,
        rows: [
          handoverRow("Goal", link.goal),
          handoverRow("State", link.state),
          handoverRow("Next", link.next),
        ].filter(Boolean),
        otherThreadId: link.source_thread_id,
        linkLabel: "Source thread",
      });
    } else if (link.source_thread_id === viewedThreadId) {
      const agent = providerLabel(link.target_provider) || "Another agent";
      const state =
        link.status === "working"
          ? "handing over"
          : !link.finished_at
            ? "working"
            : link.outcome === "completed"
              ? "done"
              : link.outcome || null;
      handedOver.push({
        key: link.id,
        direction: "to",
        name: agent,
        provider: link.target_provider || null,
        title: link.target_title || null,
        state,
        at: link.created_at || 0,
        // Once the target has answered, its words replace what it was handed.
        rows: link.result
          ? [handoverRow("Result", link.result)]
          : [handoverRow("Next", link.next), { label: "Since", at: link.created_at || 0 }].filter(
              Boolean
            ),
        otherThreadId: link.target_thread_id,
        linkLabel: `${agent} thread`,
      });
    }
  }
  return { pickedUp, handedOver };
}
