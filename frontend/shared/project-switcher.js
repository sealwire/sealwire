// The Project switcher: one control that decides which project is PINNED to the
// top of the session list.
//
// It is not a filter and it is not a mode. The list below it is always the full
// list; selecting a project only lifts that project's sessions into a group at the
// top (see `buildThreadGroups`' `pinnedProjectId`). "All sessions" is
// therefore a real destination rather than an escape hatch — nothing is hidden in
// any state.
//
// Shared by local and remote deliberately. The control is identical on both — a
// menu of names — and the surfaces differ only in what selecting one does, which
// is the caller's business. Writing it twice is how the two sidebars drifted
// before.
//
// Rename/delete for the ACTIVE project sit at the bottom, behind a divider, for the
// surfaces with no other home for them (remote's drawer, where the group header is
// not rendered). The menu names many projects and can act on exactly one; a rename
// that landed on a different row would not be recoverable.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";

import { ALL_SESSIONS_LABEL } from "./project-labels.js";
import { ProjectMenu } from "./project-menu-react.js";
import { MenuPortal, useAnchoredMenu } from "./use-anchored-menu.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";
import { buildProjectPickerRows } from "./project-picker-model.js";
import { CHEVRON_DOWN_SVG } from "../svg.js";

const h = React.createElement;

export function ProjectSwitcher({
  activeProjectId = null,
  className = "",
  createLabel = "New project…",
  // The trigger's text and tooltip. Supplied by the surface rather than derived
  // here, because on local this control IS the header title and that decision
  // lives in `header-labels.js` — one tested place for "what does the header
  // say", instead of two that agree until they don't.
  label = "",
  labelTooltip = "",
  onCreateProject = null,
  // Rename/delete for the ACTIVE project; see the note at the top of the file.
  onDeleteProject = null,
  onRenameProject = null,
  onSelectProject = null,
  projects = [],
  // `{ key, hint }`: a ⌘/Ctrl+key that opens the menu from anywhere, and the hint the
  // filter shows for it. Only where nothing else on the page wants that key.
  shortcut = null,
  // For the per-row session counts and the recency order.
  threads = [],
  threadProjectId = {},
  // Whether this control is the PAGE HEADING. True in the local and remote chat
  // headers, where the switcher replaced the title outright. False for compact
  // placements such as remote's drawer icon, where surrounding chrome already names
  // the region and the control should stay a plain button.
  //
  // Defaults to true so the surface that IS a heading does not have to say so.
  renderHeading = true,
  titleId = null,
  // An icon in place of the text label. Remote's drawer uses this: switching projects
  // is a low-frequency act on a phone, so the control sits beside search and the bell
  // rather than taking a row above the list. The name is not lost — it becomes the
  // trigger's tooltip, and the pinned chip below the list says it in the open.
  triggerIcon = null,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!shortcut?.key) {
      return undefined;
    }
    const onKeyDown = (event) => {
      if (
        (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key.toLowerCase() === shortcut.key
        // A modal owns the keyboard; switching projects behind it would be invisible.
        && !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [shortcut?.key]);

  // Dismissal and placement both come from the shared hooks: a menu here is the
  // same kind of object as a picker menu, and used to hand-roll both.
  useDismissableMenu({ menuRef, onClose: close, open, rootRef });
  const assignMenuRef = useAnchoredMenu({ menuRef, open, triggerRef });

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId) || null
    : null;
  // A selection whose project is gone (deleted from another device) shows the
  // default rather than a dangling name. The grouper independently falls back to
  // plain cwd grouping for the same id, so the control and the list agree without
  // either having to tell the other.
  const derivedLabel = activeProject
    ? activeProject.name || activeProject.id
    : ALL_SESSIONS_LABEL;
  const currentLabel = label || derivedLabel;
  // The RESOLVED id, and the only one anything below is allowed to read. An id whose
  // project is gone (deleted from another device, payload not loaded) already fell back
  // to the default LABEL; letting the highlight, the data attribute and the menu's tick
  // keep reading the raw id gave one control two answers — the icon stayed lit and no
  // menu row was marked, while the list had already gone back to plain cwd grouping.
  // Fail open, in one place, for every consumer.
  const resolvedProjectId = activeProject?.id || null;

  const choose = (projectId) => {
    close();
    onSelectProject?.(projectId);
  };

  const triggerButton = h(
    "button",
    {
      "aria-expanded": open ? "true" : "false",
      "aria-haspopup": "menu",
      "aria-controls": open ? menuId : undefined,
      className:
        "project-switcher-trigger"
        + (triggerIcon ? " project-switcher-icon-trigger" : "")
        // Marked the way `.sidebar-search-toggle` and `.sidebar-bell-toggle` are, so a
        // pinned project is legible from the top bar without opening anything.
        + (triggerIcon && resolvedProjectId ? " is-active" : ""),
      "data-active-project-id": resolvedProjectId || "",
      onClick: () => setOpen((wasOpen) => !wasOpen),
      ref: triggerRef,
      title: labelTooltip || currentLabel,
      type: "button",
    },
    triggerIcon
      ? triggerIcon
      : h(
          "span",
          { className: "project-switcher-label", id: titleId || undefined },
          currentLabel
        ),
    triggerIcon
      ? null
      : h("span", {
          "aria-hidden": "true",
          className: "project-switcher-caret",
          dangerouslySetInnerHTML: { __html: CHEVRON_DOWN_SVG },
        })
  );

  return h(
    "div",
    {
      className: `project-switcher${className ? ` ${className}` : ""}`,
      ref: rootRef,
    },
    // An <h1> wrapping the <button>, not the other way round: a heading is flow
    // content and would be invalid inside a button, and this element IS the page
    // heading on local — the switcher replaced the header title rather than
    // sitting under it.
    //
    // The heading also carries the trigger's typography (`font: inherit` on the
    // trigger). A surface that opts out therefore has to supply that itself — see
    // `.project-switcher-sidebar`, which is what remote's drawer uses.
    renderHeading
      ? h("h1", { className: "project-switcher-heading" }, triggerButton)
      : triggerButton,
    h(
      MenuPortal,
      { anchorRef: triggerRef, open },
      h(ProjectMenu, {
        activeProject,
        createLabel,
        ...buildProjectPickerRows({
          activeProjectId: resolvedProjectId,
          defaultCount: threads.length,
          projects,
          threadProjectId,
          threads,
        }),
        id: menuId,
        menuRef: assignMenuRef,
        onClose: close,
        onCreateProject: onCreateProject
          ? (name) => {
              close();
              onCreateProject(name);
            }
          : null,
        onDeleteProject: onDeleteProject
          ? (projectId, name, details) => {
              close();
              onDeleteProject(projectId, name, details);
            }
          : null,
        onRenameProject: onRenameProject
          ? (projectId, name) => {
              close();
              onRenameProject(projectId, name);
            }
          : null,
        onSelect: choose,
        shortcutHint: shortcut?.hint || null,
      })
    )
  );
}
