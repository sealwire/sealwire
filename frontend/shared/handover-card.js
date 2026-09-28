// Design 23a/23b: both ends of a /handover as one card each, drawn from the same summary.
import React, { useState } from "react";

import {
  avatar,
  CardIcon,
  clockTime,
  OpenThreadLink,
  ShowAllButton,
  Spinner,
  useFold,
} from "./card-parts.js";
import { renderMarkdown } from "./markdown.js";
import { providerLabel } from "./provider-labels.js";
import { transcriptRowKey } from "./transcript-row-key.js";

const h = React.createElement;
const SECTIONS_SHOWN = 3;

const MARKDOWN_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
// \x60 is a backtick, spelled out so source scanners do not read a template literal.
const CODE_FENCE = /^\s{0,3}(\x60{3,}|~{3,})/;
// Without headings the card shows this much and folds the rest.
const PREVIEW_LINES = 6;
const PREVIEW_CHARS = 600;

/**
 * The summary split at its markdown headings, the only form the prompt asks for; any
 * other way of writing one is left as text rather than guessed at.
 */
export function parseHandoverSections(text) {
  const lines = String(text || "").split("\n");
  // A `#` inside a code block is a shell comment, not a heading.
  let fence = null;
  const depths = lines.map((line) => {
    const marker = line.match(CODE_FENCE)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? null : marker;
      return 0;
    }
    return fence ? 0 : line.match(MARKDOWN_HEADING)?.[1].length || 0;
  });
  const nested = depths.filter((depth) => depth >= 2);
  // Sections are the largest `##`-or-smaller level; a `#` is a section only when repeated.
  const sectionLevel = nested.length
    ? Math.min(...nested)
    : depths.filter((depth) => depth === 1).length >= 2 ? 1 : 0;
  const sections = [];
  let current = { title: "", lines: [] };
  lines.forEach((line, index) => {
    const depth = depths[index];
    if (depth && depth === sectionLevel) {
      sections.push(current);
      current = { title: line.match(MARKDOWN_HEADING)[2], lines: [] };
    } else if (!depth || (sectionLevel && depth > sectionLevel)) {
      current.lines.push(line);
    }
  });
  sections.push(current);
  return sections
    .map(({ title, lines: body }) => ({ title, body: body.join("\n").trim() }))
    .filter(({ title, body }) => title || body);
}

/** The opening of an unstructured summary, or null when it is short enough to show whole. */
function summaryPreview(body) {
  const lines = body.split("\n");
  let shown = 0;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() && ++shown > PREVIEW_LINES) {
      end = index;
      break;
    }
  }
  let preview = lines.slice(0, end).join("\n").trimEnd();
  if (preview.length > PREVIEW_CHARS) {
    preview = `${preview.slice(0, PREVIEW_CHARS).trimEnd()}…`;
  }
  return preview === body ? null : preview;
}

/** The brief is the summary followed by the instruction; the card shows the summary. */
export function briefSummary(text, instruction) {
  const value = String(text || "");
  return instruction && value.endsWith(instruction)
    ? value.slice(0, value.length - instruction.length)
    : value;
}

function agentName(provider) {
  return providerLabel(provider) || "the other agent";
}

const HANDED_OVER_ICON = ["M2 8h9M8 4.5 11.5 8 8 11.5", "M14 3v10"];
const PICKED_UP_ICON = ["M2 3v10", "M5 8h9M8.5 4.5 5 8l3.5 3.5"];

// Folded to a couple of lines; its heading or its text opens it.
function SummarySection({ section, body }) {
  const fold = useFold(body, Boolean(section.title));
  const label = !section.title
    ? null
    : fold.togglable
      ? h(
          "button",
          {
            type: "button",
            className: "handover-section-label",
            "aria-expanded": fold.open ? "true" : "false",
            onClick: fold.toggle,
          },
          section.title
        )
      : h("span", { className: "handover-section-label" }, section.title);
  return h(
    "div",
    { className: `handover-section${section.title ? "" : " is-untitled"}` },
    label,
    h(
      "div",
      {
        ref: fold.ref,
        className: `handover-section-value message-body ${fold.className}`,
        onClick: fold.onClick,
      },
      renderMarkdown(body || "—")
    )
  );
}

function SummarySections({ text }) {
  const [expanded, setExpanded] = useState(false);
  const sections = parseHandoverSections(text);
  if (!sections.length) {
    return null;
  }
  // "The first three headings": an untitled opening line rides along without taking a slot.
  const lead = sections[0].title ? 0 : 1;
  const titled = sections.length - lead;
  const preview = titled ? null : summaryPreview(sections[0].body);
  const hidden = titled ? Math.max(0, titled - SECTIONS_SHOWN) : 0;
  const shown = expanded || !titled ? sections : sections.slice(0, lead + SECTIONS_SHOWN);
  const more = hidden || preview ? "Show full summary" : null;
  return h(
    "div",
    { className: "handover-card-body" },
    ...shown.map((section, index) =>
      h(SummarySection, {
        key: `${index}:${section.title}`,
        section,
        body: (!expanded && preview) || section.body,
      })
    ),
    more
      ? h(ShowAllButton, {
          open: expanded,
          onToggle: () => setExpanded((value) => !value),
          label: more,
        })
      : null
  );
}

function HandoverCard({ icon, kicker, title, time, summary, footerStart, link }) {
  return h(
    "div",
    { className: "handover-card" },
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
      time ? h("span", { className: "handover-card-time" }, time) : null
    ),
    summary ? h(SummarySections, { text: summary }) : null,
    h(
      "div",
      { className: "handover-card-foot" },
      footerStart,
      h("span", { className: "handover-card-spacer" }),
      link
    )
  );
}

function typedCommand(handover) {
  return handover?.note ? `/handover ${handover.note}` : "/handover";
}

function settledSummary(members) {
  for (let index = members.length - 1; index >= 0; index -= 1) {
    const member = members[index];
    if (member?.kind === "agent_text" && member.text) {
      return member.text;
    }
  }
  return "";
}

function SourceCard({ handover, members }) {
  const target = agentName(handover.target_provider);
  return h(HandoverCard, {
    icon: HANDED_OVER_ICON,
    kicker: "Handed over",
    title: handover.target_title ? `to ${target} · ${handover.target_title}` : `to ${target}`,
    time: clockTime(handover.updated_at),
    summary: settledSummary(members),
    footerStart: h(
      "span",
      { className: "handover-card-status" },
      h("span", { className: "handover-card-dot", "aria-hidden": "true" }),
      `${target} picked it up`
    ),
    link: h(OpenThreadLink, { threadId: handover.target_thread_id, label: "Open thread" }),
  });
}

/**
 * The source's `/handover` turn: what was typed, then a progress line or the card.
 * A failure leaves the turn's rows as they are, so nothing already written is hidden.
 */
export function HandoverSourceEntry({
  attrs,
  entry,
  members = [],
  provider = "",
  providerIcon = "",
}) {
  const handover = entry.injection.handover;
  const sourceAgent = agentName(handover.source_provider || provider);
  const target = agentName(handover.target_provider);
  const bubble = h(
    "article",
    { ...attrs, className: `${attrs.className} handover-command` },
    h("div", { className: "message-card" }, h("div", { className: "message-body" }, typedCommand(handover)))
  );
  let outcome;
  if (handover.status === "failed") {
    outcome = h(
      "div",
      { className: "handover-line handover-failed", role: "status" },
      h("span", { className: "handover-line-label" }, "Handover did not finish"),
      handover.error ? h("span", { className: "handover-line-detail" }, handover.error) : null
    );
  } else if (handover.status === "working") {
    outcome = h(
      "div",
      { className: "handover-line", role: "status" },
      h(Spinner),
      h("span", { className: "handover-line-label" }, "Preparing handover"),
      h("span", { className: "handover-line-detail" }, `${sourceAgent} is summarizing this thread for ${target}`)
    );
  } else {
    outcome = h(
      "article",
      {
        className: "chat-message chat-message-assistant handover-message",
        "data-handover-id": handover.id,
      },
      avatar(providerIcon, provider),
      h(SourceCard, { handover, members })
    );
  }
  return h("div", { className: "handover-turn", "data-handover-row": transcriptRowKey(entry) || "" }, bubble, outcome);
}

/** The target's first row: the summary it was given, in place of the user bubble. */
export function HandoverTargetEntry({ attrs, entry }) {
  const handover = entry.injection.handover;
  const sourceAgent = agentName(handover.source_provider);
  return h(
    "article",
    { ...attrs, className: `${attrs.className} handover-brief`, "data-handover-id": handover.id },
    h(HandoverCard, {
      icon: PICKED_UP_ICON,
      kicker: `Picked up from ${sourceAgent}`,
      title: handover.source_title || "Another session",
      time: clockTime(handover.created_at),
      summary: briefSummary(entry.text, handover.instruction),
      footerStart: null,
      link: h(OpenThreadLink, { threadId: handover.source_thread_id, label: "Source thread" }),
    })
  );
}

/**
 * Pulls each delivered handover's turn out of the list: its rows become the card.
 * Returns the remaining entries and, per request row, the rows it absorbed.
 */
export function foldHandoverTurns(entries) {
  let folded = null;
  let members = null;
  let absorbing = null;
  entries.forEach((entry, index) => {
    if (entry?.kind === "user_text") {
      absorbing = null;
      const handover = entry.injection?.kind === "handover_request" ? entry.injection.handover : null;
      if (handover && handover.status !== "failed") {
        absorbing = [];
        members = members || new Map();
        members.set(transcriptRowKey(entry) || "", absorbing);
        folded = folded || entries.slice(0, index);
      }
    } else if (absorbing) {
      absorbing.push(entry);
      return;
    }
    if (folded) {
      folded.push(entry);
    }
  });
  return { entries: folded || entries, members: members || EMPTY_MEMBERS };
}

const EMPTY_MEMBERS = new Map();
