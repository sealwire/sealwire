// Replaces a labelled `<select>`: a native `<option>` renders one string, with
// nowhere for a tag or a per-row subtitle. The model has its own two-level picker.

import React, { useCallback, useId, useRef, useState } from "react";

import { MenuPortal, useAnchoredMenu } from "./use-anchored-menu.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";

const h = React.createElement;

export function SettingPill({
  className = "",
  disabled = false,
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

  const choose = (option) => {
    close();
    onSelect?.(option.value, option);
  };

  const renderOption = (option) =>
    h(
      "button",
      {
        "aria-checked": option.selected ? "true" : "false",
        className: "setting-pill-option" + (option.selected ? " is-active" : ""),
        "data-value": option.value,
        key: option.value,
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
        (options || []).map(renderOption)
      )
    )
  );
}
