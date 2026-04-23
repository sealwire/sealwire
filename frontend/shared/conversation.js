import React from "react";
import { TranscriptContent } from "./transcript-react.js";

const h = React.createElement;

function fallbackShortId(value) {
  return value ? String(value).slice(0, 8) : "unknown";
}

export function ConversationEmptyState({
  actions = [],
  badge = null,
  className = "",
  copy = "",
  details = [],
  title,
}) {
  const classes = ["thread-empty", className].filter(Boolean).join(" ");
  const visibleDetails = details.filter(Boolean);

  return h(
    "div",
    { className: classes },
    badge ? h("span", { className: "thread-empty-badge" }, badge) : null,
    h("h2", null, title),
    copy ? h("p", null, copy) : null,
    visibleDetails.length
      ? h("p", { className: "thread-empty-detail" }, visibleDetails.join(" / "))
      : null,
    actions.length
      ? h(
          "div",
          { className: "suggestion-row" },
          ...actions.map((action) =>
            h(
              "button",
              {
                className: action.className || "suggestion-button",
                key: action.key || action.label,
                type: "button",
                ...(action.attrs || {}),
              },
              action.label
            )
          )
        )
      : null
  );
}

export function ReadyConversationState({
  canWrite,
  readyCopy = "Session is live. Send the first prompt below when you're ready.",
  readyTitle = "Session ready",
  session,
  shortId = fallbackShortId,
  waitingCopy = "This thread is open, but another device currently has control. Take over to send the first prompt from here.",
  waitingTitle = "Session active on another device",
}) {
  const detailParts = [];

  if (session?.current_cwd) {
    detailParts.push(`Workspace: ${session.current_cwd}`);
  }
  if (session?.active_thread_id) {
    detailParts.push(`Thread: ${shortId(session.active_thread_id)}`);
  }

  return h(ConversationEmptyState, {
    badge: canWrite ? "Ready" : "Waiting",
    className: "thread-empty-ready",
    copy: canWrite ? readyCopy : waitingCopy,
    details: detailParts,
    title: canWrite ? readyTitle : waitingTitle,
  });
}

export function TranscriptState({
  approval = null,
  entries = [],
  hydrationLoading = false,
  loadingLabel = "Loading earlier transcript...",
  onApprovalClick = null,
  onClick = null,
  onScroll = null,
  options = null,
}) {
  return h(
    React.Fragment,
    null,
    hydrationLoading
      ? h("div", { className: "transcript-loading-banner" }, loadingLabel)
      : null,
    h(
      "div",
      {
        className: "transcript-react-root",
        onClick: onClick || onApprovalClick,
        onScroll,
      },
      h(TranscriptContent, {
        approval,
        entries,
        options,
      })
    )
  );
}
