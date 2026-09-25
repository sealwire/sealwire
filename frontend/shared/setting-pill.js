// Replaces a labelled `<select>`: a native `<option>` renders one string, with
// nowhere for a tag, a provider heading, or a per-row subtitle.

import React, { useCallback, useId, useRef, useState } from "react";

import { MenuPortal, useAnchoredMenu } from "./use-anchored-menu.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";

const h = React.createElement;

export function SettingPill({
  className = "",
  // Either `options` (flat) or `groups` (sectioned, for the model picker).
  // Groups win when both are supplied.
  disabled = false,
  groups = null,
  id = null,
  inherited = false,
  label,
  onOpen = null,
  onSelect = null,
  options = null,
  tag = null,
  value,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  useDismissableMenu({ menuRef, onClose: close, open, rootRef });
  const assignMenuRef = useAnchoredMenu({ menuRef, open, triggerRef });

  const sections = groups || [{ label: null, options: options || [], provider: null }];

  const choose = (option) => {
    close();
    onSelect?.(option.value, option);
  };

  const renderOption = (option, section) =>
    h(
      "button",
      {
        "aria-checked": option.selected ? "true" : "false",
        className: "setting-pill-option" + (option.selected ? " is-active" : ""),
        "data-provider": option.provider || section.provider || undefined,
        "data-value": option.value,
        key: `${section.provider || ""}:${option.value}`,
        onClick: () => choose(option),
        role: "menuitemradio",
        type: "button",
      },
      h(
        "span",
        { className: "setting-pill-option-text" },
        h("span", { className: "setting-pill-option-label" }, option.label),
        option.subtitle
          ? h("span", { className: "setting-pill-option-subtitle" }, option.subtitle)
          : null
      ),
      option.tag ? h("span", { className: "setting-pill-option-tag" }, option.tag) : null,
      h("span", { "aria-hidden": "true", className: "setting-pill-option-check" }, "✓")
    );

  const renderSection = (section, index) =>
    h(
      "div",
      { className: "setting-pill-section", key: section.provider || section.label || index },
      section.label ? h("div", { className: "setting-pill-section-heading" }, section.label) : null,
      // A note beside the choosable row, not a replacement for it.
      section.empty
        ? h(
            "div",
            { className: "setting-pill-section-empty" },
            "Catalogue unavailable — the relay will pick"
          )
        : null,
      section.options.map((option) => renderOption(option, section))
    );

  return h(
    "div",
    {
      className:
        "setting-pill" + (inherited ? " is-inherited" : "") + (className ? ` ${className}` : ""),
      ref: rootRef,
    },
    h(
      "button",
      {
        "aria-controls": open ? menuId : undefined,
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "menu",
        className: "setting-pill-trigger",
        disabled: disabled || undefined,
        id: id || undefined,
        onClick: () => {
          if (!open) onOpen?.();
          setOpen((wasOpen) => !wasOpen);
        },
        ref: triggerRef,
        type: "button",
      },
      h("span", { className: "setting-pill-label" }, label),
      h("span", { className: "setting-pill-value" }, value),
      tag ? h("span", { className: "setting-pill-tag" }, tag) : null,
      h("span", { "aria-hidden": "true", className: "project-switcher-caret" })
    ),
    // Portalled to <body>: see use-anchored-menu.js. The menu is placed in
    // viewport coordinates, which only means the viewport outside the dialog's
    // centring transform.
    h(
      MenuPortal,
      { anchorRef: triggerRef, open },
      h(
        "div",
        { className: "setting-pill-menu", id: menuId, ref: assignMenuRef, role: "menu" },
        sections.map(renderSection)
      )
    )
  );
}
