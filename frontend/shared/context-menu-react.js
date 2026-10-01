// The React side of the one menu spec in styles.css (`.context-menu*`). The session
// row's menu is imperative (react-shell.js + app.js) but wears the same classes.

import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { positionContextMenuElement } from "./context-menu-position.js";
import { CHECK_SVG, CHEVRON_RIGHT_SVG, PLUS_SVG, SEARCH_SVG } from "../svg.js";

const h = React.createElement;

const ITEM_SELECTOR =
  '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';

export function MenuGlyph({ svg, className = "" }) {
  return h("span", {
    "aria-hidden": "true",
    className,
    dangerouslySetInnerHTML: { __html: svg },
  });
}

/** Move focus between a menu's items; returns true when the key was a move. */
export function moveMenuFocus(menu, key) {
  if (!menu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
    return false;
  }
  const items = [...menu.querySelectorAll(ITEM_SELECTOR)];
  if (!items.length) {
    return true;
  }
  const at = items.indexOf(menu.ownerDocument.activeElement);
  let next = 0;
  if (key === "End") next = items.length - 1;
  else if (key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
  else if (key === "ArrowUp") next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  items[next].focus();
  return true;
}

/**
 * A menu opened at a point (`anchor: {x, y}`, viewport coordinates), portalled to <body>.
 * Escape, a press outside, a window blur or a resize close it.
 */
export function ContextMenu({
  anchor,
  ariaLabel = undefined,
  children,
  className = "",
  confirming = false,
  id = undefined,
  // The control that toggles this menu: a press on it is its own toggle, not "outside".
  ignoreRef = null,
  onClose,
}) {
  const menuRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const x = anchor?.x ?? 0;
  const y = anchor?.y ?? 0;

  // Every render, not just the first: the confirm state changes the menu's size,
  // and placement is derived from it.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu) {
      positionContextMenuElement(menu, x, y, menu.ownerDocument?.defaultView);
    }
  });

  useEffect(() => {
    const menu = menuRef.current;
    const doc = menu?.ownerDocument;
    const view = doc?.defaultView;
    if (!menu || !view) {
      return undefined;
    }
    // Focus the panel so the arrow keys work at once, without stealing a focus the
    // content claimed for itself (a filter box, the confirm's Cancel).
    if (!menu.contains(doc.activeElement)) {
      menu.focus({ preventScroll: true });
    }
    const close = () => onCloseRef.current?.();
    const onPointerDown = (event) => {
      if (menu.contains(event.target) || ignoreRef?.current?.contains(event.target)) {
        return;
      }
      close();
    };
    // Capture, so a surface-level Escape handler (sidebar search, a modal) does not
    // also act on the press that only meant "close the menu".
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        close();
      }
    };
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("keydown", onKeyDown, true);
    view.addEventListener("blur", close);
    view.addEventListener("resize", close);
    return () => {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      view.removeEventListener("blur", close);
      view.removeEventListener("resize", close);
    };
  }, []);

  if (typeof document === "undefined") {
    return null;
  }
  return createPortal(
    h(
      "div",
      {
        "aria-label": ariaLabel,
        className: `context-menu${confirming ? " is-confirming" : ""}${className ? ` ${className}` : ""}`,
        id,
        onContextMenu: (event) => event.preventDefault(),
        onKeyDown: (event) => {
          if (moveMenuFocus(menuRef.current, event.key)) {
            event.preventDefault();
          }
        },
        ref: menuRef,
        role: confirming ? "dialog" : "menu",
        tabIndex: -1,
      },
      children
    ),
    document.body
  );
}

/**
 * One row. `checked` (true/false) makes it a radio row with the check slot on the
 * left; `lead` puts another glyph in that slot (the "+" of New project).
 */
export function MenuItem({
  checked = undefined,
  className = "",
  danger = false,
  disabled = false,
  highlighted = false,
  hint = null,
  id = undefined,
  label,
  lead = null,
  muted = false,
  onSelect,
  onMouseEnter = undefined,
  submenu = false,
  title = undefined,
}) {
  const radio = checked !== undefined;
  const slot = radio || lead
    ? h(MenuGlyph, {
        className: "context-menu-lead",
        svg: radio ? (checked ? CHECK_SVG : "") : lead,
      })
    : null;
  return h(
    "button",
    {
      "aria-checked": radio ? String(Boolean(checked)) : undefined,
      "aria-haspopup": submenu ? "menu" : undefined,
      className:
        "context-menu-button"
        + (danger ? " context-menu-button-danger" : "")
        + (muted ? " is-muted" : "")
        + (highlighted ? " is-highlighted" : "")
        + (className ? ` ${className}` : ""),
      disabled,
      id,
      onClick: () => onSelect?.(),
      onMouseEnter,
      role: radio ? "menuitemradio" : "menuitem",
      title,
      type: "button",
    },
    slot,
    h("span", { className: "context-menu-label" }, label),
    hint ? h("span", { className: "context-menu-hint" }, hint) : null,
    submenu ? h(MenuGlyph, { className: "context-menu-chevron", svg: CHEVRON_RIGHT_SVG }) : null
  );
}

export function MenuSeparator() {
  return h("div", { className: "context-menu-separator", role: "separator" });
}

export function MenuHeading({ children }) {
  return h("div", { "aria-hidden": "true", className: "context-menu-heading" }, children);
}

export function MenuFilter({ inputRef = null, onChange, onKeyDown, placeholder, value, hint = null }) {
  return h(
    "label",
    { className: "context-menu-filter" },
    h(MenuGlyph, { svg: SEARCH_SVG }),
    h("input", {
      "aria-label": placeholder,
      autoComplete: "off",
      onChange: (event) => onChange?.(event.target.value),
      onKeyDown,
      placeholder,
      ref: inputRef,
      spellCheck: false,
      type: "text",
      value,
    }),
    hint ? h("span", { className: "context-menu-hint" }, hint) : null
  );
}

/** `text` with the first case-insensitive match of `query` underlined. */
export function highlightMatch(text, query) {
  const value = String(text ?? "");
  const needle = String(query ?? "").trim().toLowerCase();
  const at = needle ? value.toLowerCase().indexOf(needle) : -1;
  if (at < 0) {
    return value;
  }
  return h(
    React.Fragment,
    null,
    value.slice(0, at),
    h("span", { className: "context-menu-match" }, value.slice(at, at + needle.length)),
    value.slice(at + needle.length)
  );
}

/**
 * The state a destructive item turns its menu into. Cancel takes focus, so an Enter
 * that arrives by reflex does not confirm.
 */
export function MenuConfirm({ body = null, confirmLabel, onCancel, onConfirm, title }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
  }, []);
  return h(
    "div",
    { className: "context-menu-confirm" },
    h("p", { className: "context-menu-confirm-title" }, title),
    body ? h("p", { className: "context-menu-confirm-body" }, body) : null,
    h(
      "div",
      { className: "context-menu-confirm-actions" },
      h(
        "button",
        { className: "context-menu-confirm-cancel", onClick: onCancel, ref: cancelRef, type: "button" },
        "Cancel"
      ),
      h(
        "button",
        { className: "context-menu-confirm-danger", onClick: onConfirm, type: "button" },
        confirmLabel
      )
    )
  );
}

export const MENU_PLUS_GLYPH = PLUS_SVG;
