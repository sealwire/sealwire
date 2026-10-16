// Why a branch switch did not happen, in plain words first and git's own words a click
// away. Shown by the location menu and by History, which both offer switching.

import React from "react";

import { t } from "../../shared/i18n.js";

const h = React.createElement;

export function SwitchRefusal({ branches, onNewWorktree = null }) {
  if (branches.unsaved?.length) {
    return h(
      "div",
      { className: "editor-menu-error", role: "alert" },
      h(
        "div",
        { className: "editor-menu-error-title" },
        t("{paths}: edits not saved yet. Save or undo them before switching.", { paths: branches.unsaved.join(", ") })
      )
    );
  }
  if (!branches.failed) {
    return h("div", { className: "editor-menu-error", role: "alert" }, branches.error);
  }
  return h(
    "div",
    { className: "editor-menu-error", role: "alert" },
    h(
      "div",
      { className: "editor-menu-error-title" },
      t("Git did not switch to {branch}; nothing changed. Usually this means files you changed here differ on that branch.", {
        branch: branches.failed.branch,
      })
    ),
    onNewWorktree
      ? h(
          "button",
          { type: "button", className: "editor-branch-button", disabled: branches.acting === true, onClick: onNewWorktree },
          t("Open it in a new worktree instead")
        )
      : null,
    h("details", { className: "editor-menu-error-details" }, h("summary", null, t("What git said")), h("pre", null, branches.error))
  );
}
