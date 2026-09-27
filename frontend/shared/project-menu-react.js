// Shared by the top-bar switcher and both launch dialogs. Class names stay
// `.project-switcher-*`: the stylesheet and remote's drawer anchoring key off them.

import React from "react";

const h = React.createElement;

export function ProjectMenu({
  createLabel = "New project",
  // From `buildProjectPickerRows`, so what a row says is decided in one place.
  rows = [],
  id = null,
  heading = "Projects",
  onSelect = null,
  onCreateProject = null,
  onRenameProject = null,
  onDeleteProject = null,
  // Active project only: a rename landing on another row is unrecoverable.
  activeProject = null,
  // Taken as a prop rather than via forwardRef: the owner needs the menu node to
  // position it, and a plain prop keeps this a plain function component.
  menuRef = null,
}) {
  return h(
    "div",
    { className: "project-switcher-menu", id: id || undefined, ref: menuRef, role: "menu" },
    heading
      ? h("div", { className: "project-switcher-menu-heading" }, heading)
      : null,
    rows.map((row) =>
      h(
        "button",
        {
          // menuitemradio: a screen reader should not infer "selected" from a glyph.
          "aria-checked": row.active ? "true" : "false",
          className: "project-switcher-option" + (row.active ? " is-active" : ""),
          "data-project-id": row.id || "",
          key: row.id || "__default__",
          onClick: () => onSelect?.(row.id),
          role: "menuitemradio",
          type: "button",
        },
        h(
          "span",
          { className: "project-switcher-option-text" },
          h("span", { className: "project-switcher-option-label" }, row.label),
          row.subtitle
            ? h("span", { className: "project-switcher-option-subtitle" }, row.subtitle)
            : null
        ),
        // Opacity, not conditional render: the row must not change width.
        h("span", { "aria-hidden": "true", className: "project-switcher-option-check" }, "✓")
      )
    ),
    // One action group under one divider; destructive last, never among the projects.
    onCreateProject
      ? h(
          "button",
          {
            className: "project-switcher-option project-switcher-manage project-switcher-create",
            onClick: () => onCreateProject(),
            role: "menuitem",
            type: "button",
          },
          createLabel
        )
      : null,
    activeProject && onRenameProject
      ? h(
          "button",
          {
            className: "project-switcher-option project-switcher-manage",
            onClick: () =>
              onRenameProject(activeProject.id, activeProject.name || activeProject.id),
            role: "menuitem",
            type: "button",
          },
          "Rename project"
        )
      : null,
    activeProject && onDeleteProject
      ? h(
          "button",
          {
            className:
              "project-switcher-option project-switcher-manage project-switcher-danger",
            onClick: () =>
              onDeleteProject(activeProject.id, activeProject.name || activeProject.id),
            role: "menuitem",
            type: "button",
          },
          "Delete project"
        )
      : null
  );
}
