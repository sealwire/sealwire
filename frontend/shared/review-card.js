// Design 24a–24c: a review is one card per round, and the card's colour is its conclusion.
// Same skeleton as the handover cards (`handover-card*` classes); `review-*` sets the tone.
import React, { useState } from "react";

import {
  avatar,
  CardBodyStatus,
  CardIcon,
  Caret,
  clockTime,
  OpenThreadLink,
  ShowAllButton,
  Spinner,
  useCardBody,
  useFold,
  useNow,
} from "./card-parts.js";
import { providerLabel } from "./provider-labels.js";
import { transcriptRowKey } from "./transcript-row-key.js";

const h = React.createElement;

// Asked of an agent on the person's behalf and answered in its own reply, so not shown.
const HIDDEN_KINDS = new Set(["review_recap", "review_commit"]);
const RESULT_KINDS = new Set(["review_result", "review_approved", "review_escalated"]);
const TERMINAL = new Set(["complete", "failed", "escalated", "cancelled"]);
const SEVERITY_TAGS = { high: "HIGH", medium: "MED", low: "LOW" };
// Like a handover card's three sections: the rest is one press away.
const FINDINGS_SHOWN = 3;

export const REVIEW_RESULT_LINE_KIND = "review_result_line";

function agentName(provider, fallback) {
  return providerLabel(provider) || fallback;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function shortSha(sha) {
  return /^[0-9a-f]{7,}$/i.test(String(sha || "")) ? sha.slice(0, 7) : "";
}

export function reviewDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const whole = Math.round(seconds);
  if (whole < 60) {
    return `${whole}s`;
  }
  const minutes = Math.floor(whole / 60);
  if (minutes < 10) {
    return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function roundOf(review, number) {
  return (review?.rounds || []).find((round) => round.round === number) || null;
}

function lastRound(review) {
  const rounds = review?.rounds || [];
  return rounds[rounds.length - 1] || null;
}

function severityCounts(findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings || []) {
    if (finding?.severity in counts) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

/** "1 blocker, 1 medium": what a round found, most severe first. */
export function findingsSummary(round) {
  const counts = severityCounts(round?.findings);
  const parts = [];
  if (counts.high) parts.push(plural(counts.high, "blocker"));
  if (counts.medium) parts.push(`${counts.medium} medium`);
  if (counts.low) parts.push(`${counts.low} minor`);
  const listed = counts.high + counts.medium + counts.low;
  const unlisted = Math.max(0, (round?.findings_total || 0) - listed);
  if (unlisted) parts.push(`${unlisted} more`);
  return parts.join(", ");
}

/** The card's colour: red a blocker, green approved, amber waiting on the person. */
export function reviewTone(kind, round) {
  if (kind === "review_escalated") return "needs-you";
  if (kind === "review_approved") return "pass";
  if (round?.verdict === "approve") return "pass";
  if (round?.verdict === "needs_changes") return "blocker";
  return "needs-you";
}

export function reviewCardTitle(kind, review, round) {
  const reviewer = agentName(review.reviewer_provider, "The reviewer");
  const total = round?.findings_total || 0;
  if (kind === "review_escalated") {
    return total
      ? `${reviewer} still disagrees on ${plural(total, "point")}`
      : `${reviewer} still has concerns`;
  }
  if (kind === "review_approved" || round?.verdict === "approve") {
    if (kind === "review_approved" && review.round > 1) {
      return `Approved after ${review.round} rounds`;
    }
    return total ? `Approved · ${plural(total, "note")}` : "Approved · no findings";
  }
  if (round?.verdict === "needs_changes") {
    const blockers = severityCounts(round.findings).high;
    if (blockers) return `${plural(blockers, "blocker")} · won't merge as is`;
    return total ? `${plural(total, "finding")} · won't merge as is` : "Needs changes";
  }
  if (round?.verdict === "unsure") {
    return `${reviewer} is unsure`;
  }
  return "Review finished";
}

function reviewKicker(kind, review) {
  const reviewer = agentName(review.reviewer_provider, "the reviewer");
  const max = review.max_rounds || 1;
  if (kind === "review_escalated") {
    return review.round >= max && max > 1
      ? `Review needs you · ${review.round} of ${max} rounds used`
      : "Review needs you";
  }
  return max > 1 ? `Reviewed by ${reviewer} · round ${review.round} of ${max}` : `Reviewed by ${reviewer}`;
}

const TONE_ICONS = {
  blocker: ["M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z", "M10.5 10.5 14 14"],
  pass: ["M3.5 8.3 6.5 11 12.5 5"],
  "needs-you": ["M8 2.5 14 13H2z", "M8 7v2.5M8 11.2v.1"],
  info: ["M2 3v10", "M5 8h9M8.5 4.5 5 8l3.5 3.5"],
};

// The file name, so the finding keeps the row's width; the full path is on hover.
function FindingWhere({ location }) {
  const name = location.split(/[\\/]/).pop();
  return h(
    "span",
    { className: "review-finding-where", title: name === location ? undefined : location },
    name
  );
}

function FindingRow({ finding, state, body = null }) {
  const fold = useFold(finding.text, true, finding.clipped ? body : null);
  return h(
    "div",
    { className: "review-finding" },
    h(
      "span",
      { className: `review-finding-tag is-${finding.severity}` },
      SEVERITY_TAGS[finding.severity] || finding.severity
    ),
    h(
      "span",
      {
        ref: fold.ref,
        className: `review-finding-text ${fold.className}`,
        onClick: fold.onClick,
        ...fold.keyboard,
      },
      finding.text
    ),
    state || finding.location
      ? h(
          "span",
          { className: "review-finding-meta" },
          state ? h("span", { className: `review-finding-state is-${state}` }, state) : null,
          finding.location ? h(FindingWhere, { location: finding.location }) : null
        )
      : null
  );
}

/**
 * The findings a card lists, three at first; the Agents panel lists them the same way.
 * Those the relay held back load from the card's row (`body`) when all are asked for.
 */
export function FindingList({ rows, more, body = null }) {
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) {
    return null;
  }
  const loadable = Boolean(body?.load);
  const folds = rows.length > FINDINGS_SHOWN || (more > 0 && loadable);
  const shown = folds && !expanded ? rows.slice(0, FINDINGS_SHOWN) : rows;
  const toggle = () => {
    if (!expanded && more > 0) {
      body?.load?.();
    }
    setExpanded(!expanded);
  };
  const placed = new Map();
  return h(
    React.Fragment,
    null,
    ...shown.map(({ finding, state }) => {
      // By place in its group, not by text: a short copy's text changes when the rest loads.
      const group = state || "open";
      const index = placed.get(group) || 0;
      placed.set(group, index + 1);
      return h(FindingRow, { key: `${group}:${index}`, finding, state, body });
    }),
    // Keyed so the button stays the same node, focus included, as rows come and go.
    more > 0 && !loadable && (!folds || expanded)
      ? h(
          "span",
          { key: "held-back", className: "review-finding-more" },
          `${more} more in the reviewer's thread`
        )
      : null,
    h(CardBodyStatus, { key: "status", body }),
    folds
      ? h(ShowAllButton, {
          key: "show-all",
          open: expanded,
          onToggle: toggle,
          label: "Show all findings",
        })
      : null
  );
}

/** Rows a card lists, each with what became of it where the card knows. */
export function cardFindings(kind, review, round) {
  if (kind === "review_result") {
    return {
      rows: (round?.findings || []).map((finding) => ({ finding, state: null })),
      more: (round?.findings_total || 0) - (round?.findings || []).length,
    };
  }
  const fixed = (review.rounds || []).flatMap((entry) =>
    (entry.fixed || []).map((finding) => ({ finding, state: "fixed" }))
  );
  const open = (round?.findings || []).map((finding) => ({ finding, state: null }));
  const openLeftOut = (round?.findings_total || 0) - open.length;
  // The relay sends a bounded number of rows per card; the totals say what it held back.
  const fixedLeftOut = (review.rounds || []).reduce(
    (sum, entry) => sum + (entry.fixed_total || 0) - (entry.fixed || []).length,
    0
  );
  return kind === "review_escalated"
    ? { rows: open, more: openLeftOut }
    : { rows: [...fixed, ...open], more: openLeftOut + fixedLeftOut };
}

function fixedEarlier(review) {
  return (review.rounds || []).reduce((sum, entry) => sum + (entry.fixed_total || 0), 0);
}

function roundSpan(kind, review, round) {
  if (kind === "review_result") {
    return round?.finished_at ? round.finished_at - round.started_at : NaN;
  }
  const first = (review.rounds || [])[0];
  return first && round?.finished_at ? round.finished_at - first.started_at : NaN;
}

function CardFooterStart({ kind, review, round, parent }) {
  const latest = lastRound(review)?.round === round?.round;
  if (kind === "review_result" && latest && review.status === "addressing_findings") {
    return h("span", { className: "review-card-next" }, h(Spinner), `${parent} is fixing`);
  }
  if (latest && (review.status === "failed" || review.status === "cancelled")) {
    return h(
      "span",
      { className: "review-card-next", title: review.error || "" },
      review.status === "cancelled" ? "Review stopped" : "Review did not finish"
    );
  }
  if (kind === "review_escalated") {
    const fixed = fixedEarlier(review);
    return fixed ? h("span", { className: "review-card-next" }, `${fixed} fixed earlier`) : null;
  }
  const sha = round?.checkpoint ? "" : shortSha(round?.candidate_sha || round?.base_sha);
  return sha
    ? h("span", { className: "review-card-next" }, "at ", h("code", null, sha))
    : null;
}

function EscalatedActions({ review, round }) {
  if (review.decision === "accepted") {
    return h("p", { className: "review-card-decided" }, "You accepted it as it stands.");
  }
  if (review.decision === "continued") {
    return h("p", { className: "review-card-decided" }, "Reviewed again below.");
  }
  if (review.status !== "escalated" || !review.parent_thread_id) {
    return null;
  }
  const common = { type: "button", "data-review-id": review.id };
  return h(
    "div",
    { className: "review-card-actions" },
    h(
      "button",
      {
        ...common,
        className: "review-card-primary",
        "data-review-action": "rerun",
        "data-parent-thread-id": review.parent_thread_id,
        "data-reviewer-thread-id": round?.reviewer_thread_id || review.reviewer_thread_id || "",
        "data-reviewer-provider": review.reviewer_provider || "",
      },
      "One more round"
    ),
    h(
      "button",
      { ...common, className: "review-card-secondary", "data-review-action": "accept" },
      "Accept as is"
    )
  );
}

function ResultCard({ kind, review, parent, rowId, onFold = null }) {
  const round = roundOf(review, review.round) || lastRound(review);
  const tone = reviewTone(kind, round);
  const { rows, more } = cardFindings(kind, review, round);
  const body = useCardBody(rowId, review.findings_clipped);
  const actions = kind === "review_escalated" ? h(EscalatedActions, { review, round }) : null;
  const head = h(
    "div",
    { className: "handover-card-head" },
    h("span", { className: "handover-card-icon" }, h(CardIcon, { paths: TONE_ICONS[tone] })),
    h(
      "div",
      { className: "handover-card-heading" },
      h("span", { className: "handover-card-kicker" }, reviewKicker(kind, review)),
      h("span", { className: "handover-card-title" }, reviewCardTitle(kind, review, round))
    ),
    h("span", { className: "handover-card-time" }, reviewDuration(roundSpan(kind, review, round))),
    onFold
      ? h(
          "button",
          { type: "button", className: "review-card-fold", "aria-label": "Fold this round", onClick: onFold },
          h(Caret, { open: true })
        )
      : null
  );
  return h(
    "div",
    { className: `handover-card review-card is-${tone}`, "data-review-id": review.id },
    head,
    rows.length || actions
      ? h("div", { className: "handover-card-body review-card-body" }, h(FindingList, { rows, more, body }), actions)
      : null,
    h(
      "div",
      { className: "handover-card-foot" },
      h(CardFooterStart, { kind, review, round, parent }),
      h("span", { className: "handover-card-spacer" }),
      h(OpenThreadLink, {
        threadId: round?.reviewer_thread_id || review.reviewer_thread_id,
        label: "Reviewer thread",
      })
    )
  );
}

/** A round a later one replaced: one line, opened on demand (24b). */
function RoundStrip({ kind, review, onOpen }) {
  const round = roundOf(review, review.round) || lastRound(review);
  const tone = kind === "review_brief" ? "info" : reviewTone(kind, round);
  const next = roundOf(review, review.round + 1);
  const found = kind === "review_brief" ? diffLabel(round) : findingsSummary(round);
  const trailing =
    kind === "review_brief"
      ? ""
      : next?.fixed_total
        ? `${next.fixed_total} fixed`
        : "";
  return h(
    "button",
    { type: "button", className: `review-strip is-${tone}`, "aria-expanded": "false", onClick: onOpen },
    h("span", { className: "review-strip-icon" }, h(CardIcon, { paths: TONE_ICONS[tone], size: 14 })),
    h(
      "span",
      { className: "review-strip-text" },
      h("b", null, `Round ${review.round}`),
      found ? ` · ${found}` : ""
    ),
    trailing ? h("span", { className: "review-strip-trailing" }, trailing) : null,
    h(Caret, { open: false })
  );
}

function diffLabel(round) {
  if (!round) {
    return "";
  }
  const base = shortSha(round.base_sha);
  const candidate = round.checkpoint ? "uncommitted" : shortSha(round.candidate_sha);
  if (!candidate) {
    return base ? `no new changes at ${base}` : "";
  }
  const parts = [`${base || "…"}…${candidate}`];
  if (Number.isFinite(round.files)) parts.push(plural(round.files, "file"));
  if (Number.isFinite(round.insertions)) parts.push(`+${round.insertions} −${round.deletions || 0}`);
  return parts.join(" · ");
}

function BriefFact({ label, value }) {
  const fold = useFold(value);
  return h(
    "div",
    { className: "handover-section review-fact" },
    h("span", { className: "handover-section-label" }, label),
    h(
      "span",
      {
        ref: fold.ref,
        className: `handover-section-value${label === "Diff" ? " review-fact-code" : ""} ${fold.className}`,
        onClick: fold.onClick,
        ...fold.keyboard,
      },
      value
    )
  );
}

function BriefCard({ review, onFold = null }) {
  const round = roundOf(review, review.round) || lastRound(review);
  const parent = agentName(review.parent_provider, "Another agent");
  const max = review.max_rounds || 1;
  const facts = [
    ["Change", round?.change],
    ["Diff", diffLabel(round)],
  ].filter(([, value]) => value);
  return h(
    "div",
    { className: "handover-card review-card is-info", "data-review-id": review.id },
    h(
      "div",
      { className: "handover-card-head" },
      h("span", { className: "handover-card-icon" }, h(CardIcon, { paths: TONE_ICONS.info })),
      h(
        "div",
        { className: "handover-card-heading" },
        h(
          "span",
          { className: "handover-card-kicker" },
          max > 1
            ? `Review requested by ${parent} · round ${review.round} of ${max}`
            : `Review requested by ${parent}`
        ),
        h("span", { className: "handover-card-title" }, review.parent_title || "Another session")
      ),
      h("span", { className: "handover-card-time" }, clockTime(round?.started_at)),
      onFold
        ? h(
            "button",
            { type: "button", className: "review-card-fold", "aria-label": "Fold this round", onClick: onFold },
            h(Caret, { open: true })
          )
        : null
    ),
    facts.length
      ? h(
          "div",
          { className: "handover-card-body" },
          ...facts.map(([label, value]) => h(BriefFact, { key: label, label, value }))
        )
      : null,
    h(
      "div",
      { className: "handover-card-foot" },
      h("span", { className: "handover-card-spacer" }),
      h(OpenThreadLink, { threadId: review.parent_thread_id, label: "Reviewed thread" })
    )
  );
}

export function ReviewCallEntry({ attrs, entry, provider = "", providerIcon = "", showAvatar = true }) {
  const review = entry.injection.review;
  const reviewer = agentName(review.reviewer_provider, "another agent");
  const latest = lastRound(review);
  const status = {
    pending_parent_recap: "Review queued",
    complete: "Review complete",
    failed: "Review failed",
    cancelled: "Review cancelled",
    blocked: "Review blocked",
    escalated: "Review needs you",
  }[review.status] || "Review in progress";
  return h(
    "article", { ...attrs, className: `${attrs.className} handover-message review-message` },
    showAvatar ? avatar(providerIcon, provider) : null,
    h("div", { className: "handover-card review-card is-info", "data-review-id": review.id, "data-review-call-id": review.id },
      h("div", { className: "handover-card-head" },
        h("span", { className: "handover-card-icon" }, h(CardIcon, { paths: TONE_ICONS.info })),
        h("div", { className: "handover-card-heading" },
          h("span", { className: "handover-card-kicker" }, `Review requested · ${reviewer}`),
          h("span", { className: "handover-card-title" }, review.parent_title || "Review changes")
        )
      ),
      review.error ? h("div", { className: "handover-card-body" }, review.error) : null,
      h("div", { className: "handover-card-foot" },
        h("span", null, status),
        h("span", { className: "handover-card-spacer" }),
        h(OpenThreadLink, { threadId: latest?.reviewer_thread_id || review.reviewer_thread_id, label: "Reviewer thread" })
      )
    )
  );
}

/**
 * A review row drawn as what it was for. A result sits in the reviewed agent's column but is
 * the reviewer's, so it wears no mark; the brief is the reviewer thread's opening, full width.
 */
export function ReviewEntry({ attrs, entry, folded = false, provider = "" }) {
  const [open, setOpen] = useState(false);
  const review = entry.injection.review;
  const kind = entry.injection.kind;
  if (HIDDEN_KINDS.has(kind)) {
    return null;
  }
  const collapsed = folded && !open;
  const onFold = folded ? () => setOpen(false) : null;
  const card = collapsed
    ? h(RoundStrip, { kind, review, onOpen: () => setOpen(true) })
    : kind === "review_brief"
      ? h(BriefCard, { review, onFold })
      : h(ResultCard, {
          kind,
          review,
          parent: agentName(review.parent_provider || provider, "The agent"),
          rowId: transcriptRowKey(entry),
          onFold,
        });
  if (kind === "review_brief") {
    return h("article", { ...attrs, className: `${attrs.className} handover-brief review-brief` }, card);
  }
  return h(
    "article",
    { ...attrs, className: `${attrs.className} handover-message review-message is-turn-continued` },
    card
  );
}

function resultLineEntry(reply) {
  const review = reply.injection.review;
  const round = roundOf(review, review.round);
  if (!round?.verdict || !round.delivered) {
    return null;
  }
  return {
    id: `review-result:${review.id}:${review.round}`,
    kind: REVIEW_RESULT_LINE_KIND,
    status: "completed",
    review,
    round,
  };
}

/** The reviewer thread's close of a round: its result went back (24c). */
export function ReviewResultLine({ entry }) {
  const { review, round } = entry;
  const parent = agentName(review.parent_provider, "the agent");
  const tone = reviewTone("review_result", round);
  const outcome =
    round.verdict === "approve"
      ? "approved"
      : round.verdict === "needs_changes"
        ? findingsSummary(round) || "needs changes"
        : round.verdict === "unsure"
          ? "unsure"
          : "";
  return h(
    "div",
    { className: "review-result-line", "data-transcript-entry-id": entry.id },
    h(
      "span",
      { className: "review-result-status", role: "status" },
      h(CardIcon, { paths: ["M2 8h9M8 4.5 11.5 8 8 11.5"], size: 11 }),
      h("span", null, `Result sent to ${parent}`),
      outcome ? h("span", { className: `review-result-outcome is-${tone}` }, `· ${outcome}`) : null
    ),
    h(OpenThreadLink, { threadId: review.parent_thread_id, label: "Reviewed thread" })
  );
}

/**
 * Hides the rows only an agent needed and marks every card a later round replaced.
 * Returns the remaining entries, with a closing line after each finished reviewer turn.
 */
export function foldReviewInjections(entries) {
  const list = entries || [];
  if (!list.some((entry) => entry?.injection?.review)) {
    return { entries: list, folded: EMPTY_FOLDED };
  }
  const result = [];
  const folded = new Set();
  const newest = new Map();
  const replyRounds = new Map();
  for (const entry of list) {
    if (entry?.kind !== "agent_text" || entry.injection?.kind !== "review_reply") continue;
    const review = entry.injection.review;
    if (!review) continue;
    if (!replyRounds.has(review.id)) replyRounds.set(review.id, new Set());
    replyRounds.get(review.id).add(review.round);
  }
  let brief = null;
  let reply = null;
  const closeRound = () => {
    const briefReview = brief?.injection?.review;
    const oldBrief = briefReview && !replyRounds.get(briefReview.id)?.has(briefReview.round) ? brief : null;
    const carrier = reply || oldBrief;
    const line = carrier && resultLineEntry(carrier);
    if (line) result.push(line);
    brief = null;
    reply = null;
  };
  for (const entry of list) {
    if (entry?.kind === "user_text") {
      closeRound();
    }
    if (entry?.kind === "agent_text" && entry.injection?.kind === "review_reply") {
      reply = entry;
    }
    const review = entry?.kind === "user_text" ? entry.injection?.review : null;
    if (!review) {
      result.push(entry);
      continue;
    }
    const kind = entry.injection.kind;
    if (HIDDEN_KINDS.has(kind)) {
      continue;
    }
    const key = transcriptRowKey(entry) || "";
    const previous = newest.get(review.id);
    if (previous !== undefined) {
      folded.add(previous);
    }
    newest.set(review.id, key);
    result.push(entry);
    if (kind === "review_brief") {
      brief = entry;
    }
  }
  closeRound();
  return { entries: result, folded };
}

const EMPTY_FOLDED = new Set();

/** A result card is where its agent's turn begins, so the reply under it takes no second mark. */
export function opensReviewedTurn(entry) {
  return entry?.kind === "user_text" && RESULT_KINDS.has(entry.injection?.kind) && Boolean(entry.injection?.review);
}

const PROGRESS = {
  pending_parent_recap: ({ parent }) => `${parent} is summarizing its change`,
  waiting_for_parent_recap: ({ parent }) => `${parent} is summarizing its change`,
  starting_reviewer: ({ reviewer }) => `Starting ${reviewer}`,
  waiting_for_reviewer: ({ reviewer }) => `${reviewer} is reading your last change`,
  waiting_to_post_back: ({ reviewer, parent }) => `Handing ${reviewer}'s result to ${parent}`,
  posting_back: ({ reviewer, parent }) => `Handing ${reviewer}'s result to ${parent}`,
  interrupting: () => "Stopping the review",
  blocked: () => "The reviewer could not be stopped",
};

/** The reviewed thread's live line while a review runs (24a); gone once a card says more. */
export function ReviewProgressLine({ activity, provider = "" }) {
  const describe = PROGRESS[activity?.status];
  const since = activity?.reviewing_since || 0;
  const now = useNow(Boolean(describe && since));
  if (!describe || TERMINAL.has(activity.status)) {
    return null;
  }
  const names = {
    parent: agentName(provider, "The agent"),
    reviewer: agentName(activity.reviewer_provider, "The reviewer"),
  };
  const detail = [describe(names)];
  if (activity.status === "waiting_for_reviewer" && Number.isFinite(activity.files)) {
    detail.push(plural(activity.files, "file"));
  }
  if (since) {
    detail.push(reviewDuration(Math.max(0, now / 1000 - since)));
  }
  if (activity.max_rounds > 1 && activity.round > 0) {
    detail.push(`round ${activity.round} of ${activity.max_rounds}`);
  }
  const blocked = activity.status === "blocked";
  return h(
    "div",
    { className: `handover-line review-progress${blocked ? " handover-failed" : ""}`, role: "status" },
    blocked ? null : h(Spinner),
    h("span", { className: "handover-line-label" }, blocked ? "Review stuck" : "Reviewing"),
    h("span", { className: "handover-line-detail review-progress-detail" }, detail.join(" · ")),
    activity.reviewer_thread_id
      ? h(
          "button",
          { type: "button", className: "handover-card-link", "data-open-thread-id": activity.reviewer_thread_id },
          "Watch"
        )
      : null,
    h(
      "button",
      {
        type: "button",
        className: "handover-card-link",
        "data-review-action": "stop",
        "data-review-id": activity.id,
      },
      blocked ? "Stop & unlock" : "Stop"
    )
  );
}

/**
 * What the reviewed thread's live line shows, or null when a card already says more.
 * The snapshot only says a review runs; the rest is on this device's own reviews.
 */
export function reviewProgressFor(activity, reviewJobs, threadId) {
  if (!threadId || !Array.isArray(activity)) {
    return null;
  }
  const job = activity.find((entry) => entry?.parent_thread_id === threadId && PROGRESS[entry.status]);
  if (!job) {
    return null;
  }
  const detail = (Array.isArray(reviewJobs) ? reviewJobs : []).find((entry) => entry?.id === job.id) || {};
  return {
    id: job.id,
    status: job.status,
    reviewer_provider: detail.reviewer_provider || "",
    reviewer_thread_id: job.reviewer_thread_id || detail.reviewer_thread_id || "",
    round: detail.round || 0,
    max_rounds: detail.max_rounds || 0,
    reviewing_since: detail.reviewing_since || 0,
    files: Number.isFinite(detail.files) ? detail.files : null,
  };
}

/** One meaning for the card's buttons on every surface; each passes what it can do. */
export function dispatchReviewAction(
  { action, reviewId, parentThreadId, reviewerThreadId, reviewerProvider },
  { stop = null, accept = null, rerun = null } = {}
) {
  if (!reviewId) {
    return undefined;
  }
  if (action === "stop") {
    return stop?.(reviewId);
  }
  if (action === "accept") {
    return accept?.(reviewId);
  }
  if (action === "rerun" && reviewerProvider) {
    return rerun?.({
      reviewerProvider,
      reviewerThreadId: reviewerThreadId || null,
      parentThreadId: parentThreadId || null,
      maxRounds: 1,
      recapSource: "last_message",
      continuesReviewId: reviewId,
    });
  }
  return undefined;
}
