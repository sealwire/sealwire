// Shared by the top-bar switcher and both launch dialogs. `.project-switcher-*` class
// names stay: remote's drawer anchoring and the e2e harness key off them.

import React, { useEffect, useRef, useState } from "react";

import {
  MENU_PLUS_GLYPH,
  MenuConfirm,
  MenuFilter,
  MenuGlyph,
  MenuHeading,
  MenuSeparator,
  highlightMatch,
} from "./context-menu-react.js";
import { isImeComposing } from "./composer-keys.js";
import { describeProjectDelete } from "./destructive-confirm-copy.js";
import { filterProjectRows } from "./project-picker-model.js";
import { CHECK_SVG } from "../svg.js";

const h = React.createElement;

function rowKey(row) {
  return row.id || "__default__";
}

export function ProjectMenu({
  // Active project only: a rename landing on another row is unrecoverable.
  activeProject = null,
  createLabel = "New project…",
  // From `buildProjectPickerRows`, so what a row says is decided in one place.
  defaultRow = null,
  filterPlaceholder = "Switch project…",
  heading = "Projects",
  id = null,
  // Taken as a prop rather than via forwardRef: the owner needs the menu node to
  // position it, and a plain prop keeps this a plain function component.
  menuRef = null,
  // Cancel in the delete confirm closes the menu, as Escape does.
  onClose = null,
  // `(name | null)`: the typed filter when there is one, otherwise null to ask.
  onCreateProject = null,
  // Called after the menu's own confirm.
  onDeleteProject = null,
  onRenameProject = null,
  onSelect = null,
  projectRows = [],
  shortcutHint = null,
  // Rows pinned above the default one (the fork dialog's "inherit" choice).
  topRows = [],
}) {
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef(null);

  const filtering = query.trim().length > 0;
  const pinned = filtering ? [] : [...topRows, ...(defaultRow ? [defaultRow] : [])];
  const projects = filterProjectRows(projectRows, query);
  const createEntry = onCreateProject
    ? { create: true, label: filtering ? `Create “${query.trim()}”` : createLabel }
    : null;
  const entries = [...pinned, ...projects, ...(createEntry ? [createEntry] : [])];

  // Nothing is highlighted on open: the current row is marked by its check alone. The
  // arrows start from it, and typing puts the mark on the first match.
  const [highlight, setHighlight] = useState(-1);
  const current = Math.min(highlight, entries.length - 1);
  const anchor = current >= 0 ? current : entries.findIndex((entry) => entry.active);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const activate = (entry) => {
    if (!entry) return;
    if (entry.create) {
      onCreateProject(filtering ? query.trim() : null);
    } else {
      onSelect?.(entry.id);
    }
  };

  const onKeyDown = (event) => {
    if (!entries.length || isImeComposing(event)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((anchor + 1) % entries.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(anchor <= 0 ? entries.length - 1 : anchor - 1);
    } else if (event.key === "Enter" && current >= 0) {
      event.preventDefault();
      activate(entries[current]);
    }
  };

  const optionRow = (row) => {
    const index = entries.indexOf(row);
    return h(
      "button",
      {
        // menuitemradio: a screen reader should not infer "selected" from a glyph.
        "aria-checked": row.active ? "true" : "false",
        className:
          "context-menu-button project-switcher-option"
          + (row.active ? " is-active" : "")
          + (index === current ? " is-highlighted" : ""),
        "data-project-id": row.id || "",
        key: rowKey(row),
        onClick: () => activate(row),
        onMouseEnter: () => setHighlight(index),
        role: "menuitemradio",
        type: "button",
      },
      h(MenuGlyph, { className: "context-menu-lead", svg: row.active ? CHECK_SVG : "" }),
      h(
        "span",
        { className: "context-menu-label project-switcher-option-label" },
        filtering ? highlightMatch(row.label, query) : row.label
      ),
      row.hint
        ? h("span", { className: "context-menu-hint" }, row.hint)
        : row.count != null
          ? h("span", { className: "context-menu-hint project-switcher-option-count" }, String(row.count))
          : null
    );
  };

  const activeRow = activeProject ? projectRows.find((row) => row.id === activeProject.id) : null;
  const activeCount = Math.max(activeRow?.members || 0, activeRow?.count || 0);
  const activeName = activeProject ? activeProject.name || activeProject.id : "";
  const deleteCopy = activeProject
    ? describeProjectDelete({ name: activeName, sessionCount: activeCount })
    : null;

  if (confirming && deleteCopy) {
    return h(
      "div",
      {
        className: "project-switcher-menu context-menu is-confirming",
        id: id || undefined,
        ref: menuRef,
        role: "dialog",
      },
      h(MenuConfirm, {
        ...deleteCopy,
        onCancel: () => (onClose ? onClose() : setConfirming(false)),
        onConfirm: () =>
          onDeleteProject(activeProject.id, activeName, { sessionCount: activeCount }),
      })
    );
  }

  const manage = activeProject && (onRenameProject || onDeleteProject);

  return h(
    "div",
    { className: "project-switcher-menu context-menu", id: id || undefined, ref: menuRef, role: "menu" },
    h(MenuFilter, {
      hint: shortcutHint,
      inputRef,
      onChange: (value) => {
        setQuery(value);
        setHighlight(0);
      },
      onKeyDown,
      placeholder: filterPlaceholder,
      value: query,
    }),
    pinned.map(optionRow),
    pinned.length && projects.length ? h(MenuSeparator) : null,
    !filtering && heading && projects.length ? h(MenuHeading, null, heading) : null,
    projects.map(optionRow),
    createEntry
      ? h(
          React.Fragment,
          null,
          entries.length > 1 ? h(MenuSeparator) : null,
          h(
            "button",
            {
              className:
                "context-menu-button project-switcher-create"
                + (entries.indexOf(createEntry) === current ? " is-highlighted" : ""),
              onClick: () => activate(createEntry),
              onMouseEnter: () => setHighlight(entries.indexOf(createEntry)),
              role: "menuitem",
              type: "button",
            },
            h(MenuGlyph, { className: "context-menu-lead", svg: MENU_PLUS_GLYPH }),
            h("span", { className: "context-menu-label" }, createEntry.label)
          )
        )
      : null,
    // Acts on one project, so it sits apart from the places, destructive last.
    manage
      ? h(
          React.Fragment,
          null,
          h(MenuSeparator),
          onRenameProject
            ? h(
                "button",
                {
                  className: "context-menu-button project-switcher-manage",
                  onClick: () => onRenameProject(activeProject.id, activeName),
                  role: "menuitem",
                  type: "button",
                },
                h("span", { className: "context-menu-label" }, "Rename project…")
              )
            : null,
          onDeleteProject
            ? h(
                "button",
                {
                  className:
                    "context-menu-button context-menu-button-danger project-switcher-manage project-switcher-danger",
                  onClick: () =>
                    deleteCopy
                      ? setConfirming(true)
                      : onDeleteProject(activeProject.id, activeName, { sessionCount: 0 }),
                  role: "menuitem",
                  type: "button",
                },
                h("span", { className: "context-menu-label" }, "Delete project…")
              )
            : null
        )
      : null
  );
}
