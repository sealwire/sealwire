// The conversation header, once.
//
// It existed twice — local/react-shell.js and remote/react-app.js — in the same shape,
// with the same class names, differing in ways that were almost all accidental: the
// leading wrapper was `.chat-header-leading` on one side and `.chat-header-main` on the
// other, separately styled, and the only real difference between those two rules was a
// gap of 8px against 12px. The collapsed-actions pair and the back button were
// byte-identical apart from their ids.
//
// What is genuinely per-surface stays per-surface, as slots and ids rather than as a
// second copy of the header:
//   - remote has a drawer hamburger; local has no drawer
//   - the back button goes to the console on local and to the relay list on remote, so
//     its label and destination are passed in
//   - local wires its buttons by id from app.js and passes no handlers; remote passes
//     handlers and no id is load-bearing. Both work, because a missing onClick is just
//     undefined.
//
// Local's shell renders exactly once, so nothing here may depend on a prop that changes:
// local hands it static mounts (`#project-switcher-mount`, `#workspace-subtitle`) and
// keeps writing into them imperatively, while remote hands it live nodes. The component
// does not know or care which it got — it owns the STRUCTURE, not the data.

import React from "react";

import { t } from "./i18n.js";
import { BackArrowIcon, ComposeIcon, ToggleLeftPanelIcon } from "./panel-icons.js";

const h = React.createElement;

// The heading's inner column: a title row (title + status + info) over a subtitle. This
// is the part remote had as `WorkspaceHeading` and local had inline; the class names were
// already the same, which is why the two could drift without anyone noticing.
export function ConversationHeadingBody({
  titleNode = null,
  statusNode = null,
  infoButton = null,
  subtitleNode = null,
}) {
  return h(
    React.Fragment,
    null,
    h("div", { className: "chat-heading-title-row" }, titleNode, statusNode, infoButton),
    subtitleNode
  );
}

export function ConversationHeader({
  // Slot for a surface-specific control that leads the row (remote's drawer hamburger).
  navToggle = null,
  // Ids stay per-surface: local resolves them at dom.js import time, and remote prefixes
  // everything with `remote-` so the two can coexist in one test page.
  backButtonId,
  composeButtonId,
  headingId,
  leftPanelToggleId,
  // The back button points somewhere different on each surface, so its words come in
  // with it rather than being guessed from the id.
  backLabel = t("Back"),
  backHidden = true,
  onBack,
  onCompose,
  onToggleLeftPanel,
  // The heading column and the trailing action cluster.
  heading = null,
  actions = null,
}) {
  return h(
    "header",
    { className: "chat-header" },
    h(
      "div",
      { className: "chat-header-leading" },
      navToggle,
      // Only visible while the sidebar is collapsed (CSS), which is why these two sit
      // together in their own box rather than in the trailing actions.
      h(
        "div",
        { className: "chat-header-collapsed-actions" },
        h(
          "button",
          {
            "aria-label": t("Show navigation panel"),
            className: "header-button header-panel-toggle header-panel-toggle-left",
            id: leftPanelToggleId,
            onClick: onToggleLeftPanel,
            title: t("Show navigation panel (⌘B)"),
            type: "button",
          },
          h(ToggleLeftPanelIcon)
        ),
        h(
          "button",
          {
            "aria-label": t("Start new session"),
            className: "header-button header-compose-button",
            id: composeButtonId,
            onClick: onCompose,
            title: t("Start new session"),
            type: "button",
          },
          h(ComposeIcon)
        )
      ),
      h(
        "button",
        {
          "aria-label": backLabel,
          className: "header-icon-button chat-heading-back-button",
          hidden: backHidden,
          id: backButtonId,
          onClick: onBack,
          title: backLabel,
          type: "button",
        },
        h(BackArrowIcon)
      ),
      h("div", { className: "chat-heading", id: headingId }, heading)
    ),
    h("div", { className: "chat-header-actions" }, actions)
  );
}
