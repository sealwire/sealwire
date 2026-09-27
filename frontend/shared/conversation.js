import React from "react";
import { TranscriptContent } from "./transcript-react.js";
import { ScrollToBottomButton } from "./scroll-to-bottom.js";
import { ApprovalFloatBar } from "./approval-float-bar.js";
import { StickToBottomFollower } from "./stick-to-bottom.js";

const h = React.createElement;

function fallbackShortId(value) {
  return value ? String(value).slice(0, 8) : "unknown";
}

export function ConversationEmptyState({
  actions = [],
  badge = null,
  className = "",
  // For a session name, which may be a whole first prompt; paths must stay whole.
  clampDetails = false,
  copy = "",
  details = [],
  title,
}) {
  const classes = ["thread-empty", className].filter(Boolean).join(" ");
  const detailText = details.filter(Boolean).join(" / ");

  return h(
    "div",
    { className: classes },
    badge ? h("span", { className: "thread-empty-badge" }, badge) : null,
    h("h2", null, title),
    copy ? h("p", null, copy) : null,
    detailText
      ? h(
          "p",
          clampDetails
            ? { className: "thread-empty-detail thread-empty-detail-clamped", title: detailText }
            : { className: "thread-empty-detail" },
          detailText
        )
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
  waitingCopy = "This session is open, but another device currently has control. Take over to send the first prompt from here.",
  waitingTitle = "Session active on another device",
}) {
  const detailParts = [];

  if (session?.current_cwd) {
    detailParts.push(`Workspace: ${session.current_cwd}`);
  }
  if (session?.active_thread_id) {
    detailParts.push(`Session: ${shortId(session.active_thread_id)}`);
  }

  return h(ConversationEmptyState, {
    badge: canWrite ? "Ready" : "Waiting",
    className: "thread-empty-ready",
    copy: canWrite ? readyCopy : waitingCopy,
    details: detailParts,
    title: canWrite ? readyTitle : waitingTitle,
  });
}

export function AgentWorkingIndicator({ model }) {
  if (!model || model.hidden) return null;
  const tone = model.tone === "alert" ? "alert" : "ready";
  return h(
    "div",
    {
      "aria-live": "polite",
      className: `agent-working-indicator agent-working-indicator-${tone}`,
      role: "status",
    },
    h("span", { className: "agent-working-indicator-dot", "aria-hidden": "true" }),
    h("span", { className: "agent-working-indicator-label" }, model.label)
  );
}

export function TranscriptState({
  approval = null,
  entries = [],
  hydrationLoading = false,
  onApprovalClick = null,
  onClick = null,
  onScroll = null,
  options = null,
}) {
  return h(
    "div",
    {
      className: "transcript-react-root",
      onClick: onClick || onApprovalClick,
      onScroll,
    },
    h(TranscriptContent, {
      approval,
      entries,
      hydrationLoading,
      options,
    }),
    // Without an id the bar cannot find its card, so it would cover a visible one.
    approval?.request_id ? h(ApprovalFloatBar, { approval, key: approval.request_id }) : null,
    h(ScrollToBottomButton, { entries }),
    h(StickToBottomFollower)
  );
}
