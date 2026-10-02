// A forked thread's start: a card in place of the context a replay sent, or a line where
// a native fork's copied history ends. Everything shown is read off the relay's fields.
import React from "react";

import { clockTime, OpenThreadLink, useCardBody, useFold } from "./card-parts.js";
import { renderMarkdown } from "./markdown.js";
import { providerLabel } from "./provider-labels.js";
import { FORK_SVG } from "../svg.js";
import { transcriptRowKey } from "./transcript-row-key.js";

const h = React.createElement;

export const FORK_DIVIDER_KIND = "fork_divider";

function sourceAgent(fork) {
  return providerLabel(fork.source_provider) || "another agent";
}

function forkIcon(className) {
  return h("span", {
    className,
    "aria-hidden": "true",
    dangerouslySetInnerHTML: { __html: FORK_SVG },
  });
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The "Carried over" line, or null for a branch that carried nothing. */
export function carriedText(carried) {
  const { total = 0, full = 0, condensed = 0, dropped = 0 } = carried || {};
  if (!total) {
    return null;
  }
  if (full === total) {
    return total === 1 ? "The one step, as written." : `All ${total} steps, as written.`;
  }
  const parts = [`the last ${full} as written`];
  if (condensed) {
    parts.push(`the ${condensed} before ${condensed === 1 ? "it" : "them"} cut to a line each`);
  }
  if (dropped) {
    parts.push(`the oldest ${dropped} left out to fit`);
  }
  return `${plural(total, "step")} — ${parts.join(", ")}.`;
}

function ForkRow({ label, value, folds = true, body = null, className = "" }) {
  const fold = useFold(value, folds, body);
  const heading = fold.togglable
    ? h(
        "button",
        {
          type: "button",
          className: "handover-section-label",
          "aria-expanded": fold.open ? "true" : "false",
          onClick: fold.toggle,
        },
        label
      )
    : h("span", { className: "handover-section-label" }, label);
  return h(
    "div",
    { className: "handover-section" },
    heading,
    h(
      "div",
      {
        ref: fold.ref,
        className: `handover-section-value ${className} ${fold.className}`,
        onClick: fold.onClick,
      },
      value
    )
  );
}

/** A replayed fork's first message, drawn as where it came from rather than what was sent. */
export function ForkBriefEntry({ attrs, entry }) {
  const fork = entry.injection.fork;
  const body = useCardBody(transcriptRowKey(entry), fork.note_clipped);
  const point = fork.branch_point;
  const carried = carriedText(fork.carried);
  return h(
    "article",
    { ...attrs, className: `${attrs.className} handover-brief fork-brief`, "data-fork-id": fork.id },
    h(
      "div",
      { className: "handover-card fork-card" },
      h(
        "div",
        { className: "handover-card-head" },
        forkIcon("handover-card-icon fork-card-icon"),
        h(
          "div",
          { className: "handover-card-heading" },
          h("span", { className: "handover-card-kicker" }, `Forked from ${sourceAgent(fork)}`),
          h("span", { className: "handover-card-title" }, fork.source_title || "Another session")
        ),
        fork.created_at ? h("span", { className: "handover-card-time" }, clockTime(fork.created_at)) : null
      ),
      h(
        "div",
        { className: "handover-card-body" },
        point
          ? h(ForkRow, {
              label: "Branched at",
              className: "message-body",
              value: h(
                "p",
                null,
                h("span", { className: "fork-card-speaker" }, `${point.speaker === "user" ? "You" : sourceAgent(fork)}:`),
                " ",
                // A quote, so the agent's line breaks would only spend the two folded lines.
                point.text.replace(/\s+/g, " ")
              ),
            })
          : null,
        fork.note
          ? h(ForkRow, {
              label: "Your note",
              className: "message-body",
              value: renderMarkdown(fork.note),
              body,
            })
          : null,
        carried
          ? h(ForkRow, { label: "Carried over", className: "fork-card-carried", value: carried, folds: false })
          : null
      ),
      fork.source_thread_id
        ? h(
            "div",
            { className: "handover-card-foot" },
            h("span", { className: "handover-card-spacer" }),
            h(OpenThreadLink, { threadId: fork.source_thread_id, label: "Source thread" })
          )
        : null
    )
  );
}

/** Where a native fork's copied history ends and the branch begins. */
export function ForkDivider({ entry }) {
  const { fork } = entry;
  const time = clockTime(fork.created_at);
  return h(
    "div",
    { className: "fork-divider", role: "note", "data-transcript-entry-id": entry.id, "data-fork-id": fork.id },
    h("span", { className: "fork-divider-line", "aria-hidden": "true" }),
    h(
      "span",
      { className: "fork-divider-label" },
      forkIcon("fork-divider-icon"),
      fork.source_title
        ? h(React.Fragment, null, "Forked from ", h("span", { className: "fork-divider-title" }, fork.source_title))
        : "Forked from another session",
      time ? ` · ${time}` : null
    ),
    h(OpenThreadLink, { threadId: fork.source_thread_id, label: "Source thread" }),
    h("span", { className: "fork-divider-line", "aria-hidden": "true" })
  );
}

/** Puts the divider after the row a native fork's copy ended on. */
export function foldForkStarts(entries) {
  const list = entries || [];
  if (!list.some((entry) => entry?.injection?.kind === "fork_start")) {
    return list;
  }
  const result = [];
  for (const entry of list) {
    result.push(entry);
    const fork = entry?.injection?.kind === "fork_start" ? entry.injection.fork : null;
    if (fork) {
      result.push({ id: `fork-start:${fork.id}`, kind: FORK_DIVIDER_KIND, status: "completed", fork });
    }
  }
  return result;
}
