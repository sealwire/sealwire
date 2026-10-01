// A FORM CONTROL, not navigation: choosing here sets a field on the session about
// to be created rather than re-pinning the sidebar. Menu shared with the switcher.

import React, { useCallback, useId, useRef, useState } from "react";

import { NO_PROJECT_LABEL } from "./project-labels.js";
import { ProjectMenu } from "./project-menu-react.js";
import { buildProjectPickerRows } from "./project-picker-model.js";
import { MenuPortal, useAnchoredMenu } from "./use-anchored-menu.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";

const h = React.createElement;

// Sentinel row id for "resolve from the source". Not null — null is "no project", and
// the whole point is that those are different requests.
export const INHERIT_ROW_ID = "__fork_inherit__";
// An id no project can have, so every real row reads as unselected while the
// inherit row holds the mark.
const NO_MATCH = "__none__";

export function ProjectPicker({
  activeProjectId = null,
  className = "",
  createLabel = "New project…",
  disabled = false,
  // Fork only: an explicit row for "resolve from the source at submit time",
  // which is a different request from choosing no project.
  inheritRow = null,
  id = null,
  label = "Project",
  onCreateProject = null,
  onSelectProject = null,
  projects = [],
  threadProjectId = {},
  threads = [],
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // Escape must be CONSUMED here: this opens inside a modal dialog.
  useDismissableMenu({ menuRef, onClose: close, open, rootRef });
  const assignMenuRef = useAnchoredMenu({ menuRef, open, triggerRef });

  const inheriting = Boolean(inheritRow?.active);
  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId) || null
    : null;
  // Fail-open like the switcher: a deleted project reads as the default, and
  // nothing below sees the raw id.
  const resolvedProjectId = activeProject?.id || null;
  // The chip names what the fork WOULD get; the menu row names what the choice is.
  // Both as the row label would duplicate the concrete project row beneath it.
  const currentLabel = inheriting
    ? inheritRow.chipLabel || inheritRow.label
    : activeProject
      ? activeProject.name || activeProject.id
      : NO_PROJECT_LABEL;

  const choose = (projectId) => {
    close();
    onSelectProject?.(projectId);
  };

  return h(
    "div",
    {
      className: `project-picker${className ? ` ${className}` : ""}`,
      ref: rootRef,
    },
    h(
      "button",
      {
        "aria-controls": open ? menuId : undefined,
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "menu",
        "aria-label": `${label}: ${currentLabel}`,
        className: "project-picker-trigger" + (inheriting ? " is-inherited" : ""),
        "data-active-project-id": resolvedProjectId || "",
        "data-inheriting": inheriting ? "true" : undefined,
        disabled: disabled || undefined,
        id: id || undefined,
        onClick: () => setOpen((wasOpen) => !wasOpen),
        ref: triggerRef,
        type: "button",
      },
      // The dot is the same "which project" signal the session rows carry, so the
      // chip reads as a project rather than as one more settings dropdown.
      h("span", {
        "aria-hidden": "true",
        className:
          "project-picker-dot"
          + (resolvedProjectId || inheriting ? " is-assigned" : ""),
      }),
      h("span", { className: "project-picker-label" }, currentLabel),
      h("span", { "aria-hidden": "true", className: "project-switcher-caret" })
    ),
    // Portalled to <body>: see use-anchored-menu.js.
    h(
      MenuPortal,
      { anchorRef: triggerRef, open },
      h(ProjectMenu, {
        createLabel,
        ...buildProjectPickerRows({
          activeProjectId: inheriting ? NO_MATCH : resolvedProjectId,
          defaultLabel: NO_PROJECT_LABEL,
          projects,
          threadProjectId,
          threads,
        }),
        filterPlaceholder: "Find a project…",
        id: menuId,
        menuRef: assignMenuRef,
        onClose: close,
        onCreateProject: onCreateProject
          ? (name) => {
              close();
              onCreateProject(name);
            }
          : null,
        onSelect: (rowId) => choose(rowId === INHERIT_ROW_ID ? INHERIT_ROW_ID : rowId),
        // No rename/delete: a destructive act should not sit one keystroke from
        // a routine one, and the switcher already carries that pair.
        topRows: inheritRow
          ? [
              {
                active: inheriting,
                id: INHERIT_ROW_ID,
                hint: inheritRow.hint || null,
                label: inheritRow.label,
              },
            ]
          : [],
      })
      )
  );
}
