// Design 25a–25c: a /delegate is a card where it was asked and a card where it was answered.
// Same skeleton as the handover and review cards; the tone says how it went.
import React, { useState } from "react";

import {
  avatar,
  CardIcon,
  Caret,
  clockTime,
  OpenThreadLink,
  Spinner,
  useFold,
  useNow,
} from "./card-parts.js";
import { briefSummary, parseHandoverSections, SummarySections } from "./handover-card.js";
import { renderMarkdown } from "./markdown.js";
import { providerLabel } from "./provider-labels.js";
import { reviewDuration } from "./review-card.js";
import { transcriptRowKey } from "./transcript-row-key.js";

const h = React.createElement;

/** A peer's answer drawn as a card in place of the `report_back` call or reply it came in. */
export const DELEGATE_REPORTED_KIND = "delegate_reported";

// Claude names it `mcp__sealwire__report_back`, Codex plain `report_back`.
const REPORT_BACK_TOOL = /(^|__)report_back$/;

const ICONS = {
  asked: ["M2 8h9M8 4.5 11.5 8 8 11.5", "M14 3v10"],
  task: ["M2 3v10", "M5 8h9M8.5 4.5 5 8l3.5 3.5"],
  answered: ["M3.5 8.3 6.5 11 12.5 5"],
  missing: ["M8 2.5 14 13H2z", "M8 7v2.5M8 11.2v.1"],
};

function agentName(provider, fallback) {
  return providerLabel(provider) || fallback;
}

function peerName(ask) {
  return agentName(ask?.peer_provider, "the other agent");
}

function askerName(ask) {
  return agentName(ask?.asker_provider, "the agent that asked");
}

function capitalize(text) {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/** `failed` and `cancelled` read the same on a card: no answer came back. */
function outcome(ask) {
  if (ask?.status === "working") return "working";
  if (ask?.status === "done") return "done";
  return "failed";
}

export function drawsDelegateBriefCard(ask) {
  return Boolean(ask && (ask.sent_at || outcome(ask) === "working"));
}

function answerSpan(ask) {
  return ask?.finished_at ? reviewDuration(ask.finished_at - ask.asked_at) : "";
}

function reason(ask) {
  const text = String(ask?.error || "").trim();
  return text ? `${capitalize(text).replace(/[.\s]+$/, "")}.` : "It did not answer.";
}

function DelegateCard({ anchorId, tone, icon, kicker, title, time, onFold = null, children, footerStart = null, link = null }) {
  return h(
    "div",
    { className: `handover-card delegate-card is-${tone}`, ...(anchorId ? { "data-transcript-anchor": `delegate:${anchorId}` } : {}) },
    h(
      "div",
      { className: "handover-card-head" },
      h("span", { className: "handover-card-icon" }, h(CardIcon, { paths: icon })),
      h(
        "div",
        { className: "handover-card-heading" },
        h("span", { className: "handover-card-kicker" }, kicker),
        h("span", { className: "handover-card-title" }, title)
      ),
      time ? h("span", { className: "handover-card-time" }, time) : null,
      onFold
        ? h(
            "button",
            { type: "button", className: "review-card-fold", "aria-label": "Fold this card", onClick: onFold },
            h(Caret, { open: true })
          )
        : null
    ),
    children,
    h(
      "div",
      { className: "handover-card-foot" },
      footerStart,
      h("span", { className: "handover-card-spacer" }),
      link
    )
  );
}

/** The title is the text's first line, so the card does not say it twice. */
function withoutTitle(text, title) {
  const value = String(text || "").trim();
  const [first, ...rest] = value.split("\n");
  const bare = (line) => line.replace(/^#+\s*/, "").replace(/[*_\x60]/g, "").trim();
  return title && bare(first) === bare(title) ? rest.join("\n").trim() : value;
}

// Headings split it like a handover summary; otherwise it is one value, two lines until pressed.
function CardText({ text, title = "", moreLabel, footer = null }) {
  const body = withoutTitle(text, title);
  const plain = !parseHandoverSections(body).some((section) => section.title);
  const fold = useFold(body, plain);
  if (!body) {
    return null;
  }
  if (!plain) {
    return h(SummarySections, { text: body, moreLabel, footer });
  }
  return h(
    "div",
    { className: "handover-card-body" },
    h(
      "div",
      {
        ref: fold.ref,
        className: `handover-section-value message-body delegate-card-text ${fold.className}`,
        onClick: fold.onClick,
        ...fold.keyboard,
      },
      renderMarkdown(body)
    ),
    footer
  );
}

/** The `path:line` places `report_back` said the answer rests on (25a / 25b). */
function Cited({ places }) {
  if (!places?.length) {
    return null;
  }
  return h(
    "div",
    { className: "delegate-card-cited" },
    h("span", { className: "delegate-card-cited-label" }, "Cited"),
    h(
      "span",
      { className: "delegate-card-cited-places" },
      ...places.map((place, index) => h("code", { key: index, className: "delegate-card-cited-place" }, place))
    )
  );
}

/** The asked card once its answer card is below it, as one line (25a). */
function Strip({ anchorId, tone, icon, label, title, onOpen }) {
  return h(
    "button",
    { type: "button", className: `review-strip delegate-strip is-${tone}`, ...(anchorId ? { "data-transcript-anchor": `delegate:${anchorId}` } : {}), "aria-expanded": "false", onClick: onOpen },
    h("span", { className: "review-strip-icon" }, h(CardIcon, { paths: icon, size: 14 })),
    h("span", { className: "review-strip-text" }, h("b", null, label), title ? ` · ${title}` : ""),
    h(Caret, { open: false })
  );
}

function PeerStatus({ ask }) {
  const peer = peerName(ask);
  const state = outcome(ask);
  const since = ask.sent_at || ask.asked_at;
  const now = useNow(state === "working");
  if (state === "working") {
    return h(
      "span",
      { className: "review-card-next" },
      h(Spinner),
      `${peer} is working · ${reviewDuration(Math.max(0, now / 1000 - since))}`
    );
  }
  if (state === "done") {
    return h(
      "span",
      { className: "handover-card-status" },
      h("span", { className: "handover-card-dot", "aria-hidden": "true" }),
      `${peer} answered`
    );
  }
  return h(
    "span",
    { className: "handover-card-status delegate-status-missing" },
    h("span", { className: "handover-card-dot", "aria-hidden": "true" }),
    `No answer from ${peer}`
  );
}

function AskedCard({ ask, brief, collapsed }) {
  const [open, setOpen] = useState(false);
  const peer = peerName(ask);
  const title = ask.title || "A question for another agent";
  if (collapsed && !open) {
    return h(Strip, {
      anchorId: `${ask.id}:asked`,
      tone: "info",
      icon: ICONS.asked,
      label: `Delegated to ${peer}`,
      title,
      onOpen: () => setOpen(true),
    });
  }
  return h(
    DelegateCard,
    {
      anchorId: `${ask.id}:asked`,
      tone: "info",
      icon: ICONS.asked,
      kicker: `Delegated to ${peer}`,
      title,
      time: clockTime(ask.sent_at || ask.asked_at),
      onFold: collapsed ? () => setOpen(false) : null,
      footerStart: h(PeerStatus, { ask }),
      link: h(OpenThreadLink, { threadId: ask.peer_thread_id, label: `${peer} thread` }),
    },
    h(CardText, { text: brief, title, moreLabel: "Show the whole question" })
  );
}

/** Timed out or failed (25c): amber, with the reason. The asker has it too and decides. */
function MissingCard({ ask }) {
  const peer = peerName(ask);
  return h(
    DelegateCard,
    {
      anchorId: `${ask.id}:answer`,
      tone: "needs-you",
      icon: ICONS.missing,
      kicker: `No answer from ${peer}`,
      title: ask.title || "A question for another agent",
      time: answerSpan(ask),
      link: h(OpenThreadLink, { threadId: ask.peer_thread_id, label: `${peer} thread` }),
    },
    h(
      "div",
      { className: "handover-card-body" },
      h("p", { className: "delegate-card-reason" }, reason(ask))
    )
  );
}

function AnsweredCard({ ask }) {
  const peer = peerName(ask);
  return h(
    DelegateCard,
    {
      anchorId: `${ask.id}:answer`,
      tone: "pass",
      icon: ICONS.answered,
      kicker: `${peer} answered`,
      title: ask.title || "A question for another agent",
      time: answerSpan(ask),
      link: h(OpenThreadLink, { threadId: ask.peer_thread_id, label: `${peer} thread` }),
    },
    h(CardText, {
      text: ask.answer,
      moreLabel: "Show the whole answer",
      footer: h(Cited, { places: ask.cited }),
    })
  );
}

function settledBrief(members) {
  for (let index = members.length - 1; index >= 0; index -= 1) {
    const member = members[index];
    if (member?.kind === "agent_text" && member.text) {
      return member.text;
    }
  }
  return "";
}

function PreparingLine({ ask, asker }) {
  const failed = outcome(ask) !== "working";
  if (failed) {
    return h(
      "div",
      { className: "handover-line handover-failed", role: "status" },
      h("span", { className: "handover-line-label" }, "Delegate did not start"),
      ask.error ? h("span", { className: "handover-line-detail" }, reason(ask)) : null
    );
  }
  return h(
    "div",
    { className: "handover-line delegate-preparing", role: "status" },
    h(Spinner),
    h("span", { className: "handover-line-label" }, "Preparing brief"),
    h(
      "span",
      { className: "handover-line-detail delegate-preparing-detail" },
      `${asker} is writing the question for ${ask.peer_provider ? peerName(ask) : "another agent"}`
    ),
    ask.asker_thread_id
      ? h(
          "button",
          {
            type: "button",
            className: "handover-card-link",
            "data-delegate-action": "cancel",
            "data-thread-id": ask.asker_thread_id,
          },
          "Cancel"
        )
      : null
  );
}

/** The asker's `/delegate` turn (25a): what was typed, the brief being written, then its card. */
export function DelegateRequestEntry({
  attrs,
  entry,
  members = [],
  answered = EMPTY_SET,
  provider = "",
  providerIcon = "",
  showCommand = true,
  showOutcome = true,
}) {
  const asks = entry.injection.delegate || [];
  const first = asks[0];
  const asker = agentName(first?.asker_provider || provider, "This session");
  const bubble = h(
    "article",
    { ...attrs, className: `${attrs.className} handover-command` },
    h(
      "div",
      { className: "message-card" },
      h("div", { className: "message-body" }, first?.task ? `/delegate ${first.task}` : "/delegate")
    )
  );
  let outcomeNode = null;
  if (first && !first.sent_at) {
    outcomeNode = h(PreparingLine, { ask: first, asker });
  } else if (first) {
    outcomeNode = h(
      "article",
      { className: "chat-message chat-message-assistant handover-message delegate-message", "data-transcript-anchor": `request:${transcriptRowKey(entry)}` },
      avatar(providerIcon, provider),
      h(
        "div",
        { className: "delegate-stack" },
        // Once the answer card below says how it went, this one is a line.
        h(AskedCard, { ask: first, brief: settledBrief(members), collapsed: answered.has(first.id) })
      )
    );
  }
  return h(
    "div",
    { className: "handover-turn", "data-delegate-row": transcriptRowKey(entry) || "", "data-transcript-content-key": transcriptRowKey(entry) || "" },
    showCommand ? bubble : null,
    showOutcome ? outcomeNode : null
  );
}

/**
 * What came back, where the wake used to be (25a / 25c); it opens the asker's turn. Right
 * under its own asked card it joins that card's column rather than taking a second mark.
 */
export function DelegateAnswerEntry({ attrs, entry, joined = false, provider = "", providerIcon = "" }) {
  const asks = entry.injection.delegate || [];
  return h(
    "article",
    {
      ...attrs,
      className: `${attrs.className} handover-message delegate-message${joined ? " is-turn-continued" : ""}`,
    },
    joined ? null : avatar(providerIcon, provider),
    h(
      "div",
      { className: "delegate-stack" },
      ...asks.map((ask) =>
        outcome(ask) === "done"
          ? h(AnsweredCard, { key: ask.id, ask })
          : h(MissingCard, { key: ask.id, ask })
      )
    )
  );
}

/** The peer's first row (25b): the brief it was given, without the instruction after it. */
export function DelegateTaskEntry({ attrs, entry }) {
  const ask = (entry.injection.delegate || [])[0];
  if (!ask) {
    return null;
  }
  const asker = askerName(ask);
  return h(
    "article",
    { ...attrs, className: `${attrs.className} handover-brief delegate-brief` },
    h(
      DelegateCard,
      {
        anchorId: `${ask.id}:task`,
        tone: "info",
        icon: ICONS.task,
        kicker: ask.asker_title ? `Task from ${asker} · ${ask.asker_title}` : `Task from ${asker}`,
        title: ask.title || "A question from another agent",
        time: clockTime(ask.sent_at || ask.asked_at),
        link: h(OpenThreadLink, { threadId: ask.asker_thread_id, label: "Asker thread" }),
      },
      h(CardText, {
        text: briefSummary(entry.text, ask.instruction),
        title: ask.title,
        moreLabel: "Show the whole task",
      })
    )
  );
}

/** The one reminder a peer gets to use `report_back` (25b). */
export function DelegateNudgeEntry({ attrs, entry }) {
  const ask = (entry.injection.delegate || [])[0];
  return h(
    "div",
    { ...attrs, className: "delegate-nudge", role: "status" },
    h("span", { className: "delegate-dot", "aria-hidden": "true" }),
    `Reminded ${agentName(ask?.peer_provider, "the agent")} to report back`
  );
}

/** The peer's answer as the card the asker got (25b). */
export function DelegateReportedEntry({ entry, provider = "", providerIcon = "" }) {
  const ask = entry.delegate;
  const asker = askerName(ask);
  const attrs = {
    className: `chat-message chat-message-assistant handover-message delegate-message${entry.opensTurn ? "" : " is-turn-continued"}`,
    "data-transcript-entry-id": transcriptRowKey(entry) || "",
    "data-transcript-content-key": transcriptRowKey(entry) || "",
    "data-transcript-anchor": `entry:${transcriptRowKey(entry)}`,
  };
  return h(
    "article",
    attrs,
    entry.opensTurn ? avatar(providerIcon, provider) : null,
    h(
      DelegateCard,
      {
        anchorId: `${ask.id}:reported`,
        tone: "pass",
        icon: ICONS.answered,
        kicker: `Reported back to ${asker}`,
        title: ask.title || "A question from another agent",
        time: answerSpan(ask),
        footerStart: h(
          "span",
          { className: "review-card-next" },
          ask.delivered ? "Delivered" : `${capitalize(asker)} gets it when it is free`
        ),
        link: h(OpenThreadLink, { threadId: ask.asker_thread_id, label: "Asker thread" }),
      },
      h(CardText, {
        text: entry.answer,
        moreLabel: "Show the whole answer",
        footer: h(Cited, { places: entry.cited }),
      })
    )
  );
}

function isReportBackRow(entry) {
  return entry?.kind === "tool_call" && REPORT_BACK_TOOL.test(String(entry.tool?.name || ""));
}

// Until the relay marks the call, only its own arguments say what it answered and cited.
function reportedEntry(row, ask, opensTurn) {
  const input = ask.answered_with_tool ? toolInput(row) : {};
  const answer = ask.answered_with_tool ? ask.answer || input.answer : row.text;
  const cited = ask.cited?.length ? ask.cited : input.cited;
  return {
    ...row,
    kind: DELEGATE_REPORTED_KIND,
    delegate: ask,
    answer: typeof answer === "string" ? answer : "",
    cited: Array.isArray(cited) ? cited.filter((place) => typeof place === "string") : [],
    opensTurn,
  };
}

function toolInput(entry) {
  try {
    const parsed = JSON.parse(entry?.tool?.input_preview || "");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Folds the rows a delegate's cards replace. On the asker: the brief's turn goes into its
 * card, and an answered ask's card folds to a line. On the peer: its answer — the
 * `report_back` call, or failing that its last reply — becomes the "Reported back" card.
 */
export function foldDelegateInjections(entries) {
  const list = entries || [];
  if (!list.some((entry) => entry?.injection?.delegate)) {
    return { entries: list, members: EMPTY_MEMBERS, answered: EMPTY_SET, joined: EMPTY_SET, briefs: EMPTY_SET };
  }
  const briefs = new Set(
    list
      .filter((entry) => entry?.kind === "agent_text" && entry.injection?.kind === "delegate_brief")
      .flatMap((entry) => (entry.injection.delegate || []).filter(drawsDelegateBriefCard).map((ask) => ask.id))
  );
  const answered = new Set();
  for (const entry of list) {
    if (entry?.kind === "user_text" && entry.injection?.kind === "delegate_answer") {
      for (const ask of entry.injection.delegate || []) answered.add(ask.id);
    }
  }
  const result = [];
  const members = new Map();
  const hidden = new Set();
  const joined = new Set();
  let absorbing = null;
  let span = null;
  const opensTurn = (at) => result[at - 1]?.kind === "user_text";
  // The relay marks the row that answered; failing that (a Codex row renamed by a
  // restart), the task's span says which it was.
  const closeSpan = () => {
    const at = !span
      ? -1
      : span.markedAt >= 0
        ? span.markedAt
        : outcome(span.ask) !== "done"
          ? -1
          : span.ask.answered_with_tool
            ? span.reportAt
            : span.textAt;
    if (at >= 0) {
      if (at !== span.markedAt) {
        result[at] = reportedEntry(result[at], span.ask, opensTurn(at));
      }
      for (const index of span.reportRows) {
        if (index !== at) hidden.add(index);
      }
    }
    span = null;
  };
  for (const entry of list) {
    if (entry?.kind === "user_text") {
      const injection = entry.injection;
      const kind = injection?.delegate ? injection.kind : "";
      // The reminder is part of the answer it asked for.
      if (kind === "delegate_nudge" && span && injection.delegate[0]?.id === span.ask.id) {
        result.push(entry);
        continue;
      }
      closeSpan();
      absorbing = null;
      const first = injection?.delegate?.[0];
      const previous = result[result.length - 1];
      const previousAsk = (previous?.injection?.delegate || []).find((ask) => ask.id === first?.id);
      if (
        kind === "delegate_answer"
        && (previous?.injection?.kind === "delegate_request"
          || (previous?.injection?.kind === "delegate_brief"
            && drawsDelegateBriefCard(previousAsk)))
        && previousAsk
      ) {
        joined.add(transcriptRowKey(entry) || "");
      }
      if (kind === "delegate_request" && first && (first.sent_at || outcome(first) === "working")) {
        absorbing = [];
        members.set(transcriptRowKey(entry) || "", absorbing);
      } else if (kind === "delegate_task" && first) {
        span = { ask: first, reportAt: -1, reportRows: [], textAt: -1, markedAt: -1 };
      }
      result.push(entry);
      continue;
    }
    if (absorbing) {
      absorbing.push(entry);
      if (entry.injection?.kind !== "delegate_brief") continue;
    }
    const reported = entry?.injection?.kind === "delegate_reported" ? entry.injection.delegate?.[0] : null;
    if (reported) {
      if (span) {
        span.markedAt = result.length;
        if (isReportBackRow(entry)) span.reportRows.push(result.length);
      }
      result.push(reportedEntry(entry, reported, opensTurn(result.length)));
      continue;
    }
    if (span && isReportBackRow(entry)) {
      span.reportRows.push(result.length);
      span.reportAt = result.length;
    } else if (span && entry?.kind === "agent_text") {
      span.textAt = result.length;
    }
    result.push(entry);
  }
  closeSpan();
  return {
    entries: hidden.size ? result.filter((_, index) => !hidden.has(index)) : result,
    members,
    answered,
    joined,
    briefs,
  };
}

/** An answer card is where the asker's turn begins, so the reply under it takes no second mark. */
export function opensAnsweredTurn(entry) {
  return entry?.kind === "user_text" && entry.injection?.kind === "delegate_answer" && Boolean(entry.injection?.delegate);
}

/** One meaning for the card's button on every surface; each passes what it can do. */
export function dispatchDelegateAction({ action, threadId }, { cancel = null } = {}) {
  return action === "cancel" && threadId ? cancel?.(threadId) : undefined;
}

const EMPTY_MEMBERS = new Map();
const EMPTY_SET = new Set();
