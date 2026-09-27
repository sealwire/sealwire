// Settings > Log, shared by local and remote. Not in the nav: it is for bug reports, so it
// hangs off the footer link. Kept mounted, because e2e scripts read its text while closed.

import React from "react";
import { SettingsPage } from "./settings-frame.js";
import { LOG_FILTERS, collapseLogRepeats, filterLogRows, logRepeatLabel } from "./settings-model.js";

const h = React.createElement;

/**
 * @param {{
 *   active: boolean,
 *   entries: {at:number,text:string}[],
 *   listId: string,
 *   rootId?: string,
 *   footnote: string,
 * }} props
 */
export function LogPage({ active, entries, listId, rootId, footnote }) {
  const [filter, setFilter] = React.useState("all");
  const [copied, setCopied] = React.useState(false);
  const rows = filterLogRows(collapseLogRepeats(entries), filter);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logEntriesAsText(entries));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return h(
    SettingsPage,
    {
      pageKey: "log",
      active,
      title: "Log",
      actions: h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "theme-picker settings-filter", role: "radiogroup", "aria-label": "Show" },
          ...LOG_FILTERS.map((entry) =>
            h(
              "button",
              {
                key: entry.key,
                "aria-checked": filter === entry.key ? "true" : "false",
                className: `theme-picker-segment${filter === entry.key ? " is-active" : ""}`,
                "data-log-filter": entry.key,
                onClick: () => setFilter(entry.key),
                role: "radio",
                type: "button",
              },
              entry.label
            )
          )
        ),
        h("button", { className: "settings-button", onClick: copy, type: "button" }, copied ? "Copied" : "Copy")
      ),
    },
    h(
      "div",
      { id: rootId },
      rows.length
        ? h(
            "ol",
            { className: "settings-log", id: listId },
            ...rows.map((row, index) =>
              h(
                "li",
                { key: `${row.at}:${index}`, className: `settings-log-row is-${row.level}` },
                h("span", { className: "settings-log-time settings-mono" }, formatClock(row.at)),
                h("span", { className: "settings-log-dot", "aria-hidden": "true" }),
                h("span", { className: "settings-log-text" }, row.text),
                row.count > 1 ? h("span", { className: "settings-log-repeat" }, logRepeatLabel(row)) : null
              )
            )
          )
        : h(
            "p",
            { className: "settings-empty", id: listId },
            filter === "all" ? "Nothing logged yet." : "Nothing matches this filter."
          )
    ),
    h("p", { className: "settings-hint" }, footnote)
  );
}

function formatClock(ms) {
  return ms ? new Date(ms).toLocaleTimeString() : "";
}

export function logEntriesAsText(entries) {
  return (entries || []).map((entry) => `${formatClock(entry.at)}  ${entry.text}`).join("\n");
}
