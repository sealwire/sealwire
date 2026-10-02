// The sidebar's primary action, as a split button.
//
// It used to be one plain button that opened the start-session dialog, with the provider
// choice living inside that dialog. The dialog is still the full form — nothing moved out
// of it — but the common case is "start a session with THIS agent", and that took opening
// a modal, finding a select, changing it, and starting. The right half is a shortcut to
// exactly that path: pick an agent, and the dialog opens already set to it.
//
// The two halves are ONE control, so they share a shell and a hairline gap rather than
// sitting as two buttons that happen to be adjacent — the caret is not a peer of "New
// session", it is a modifier on it.
//
// Provider data is injected, never fetched here: the local surface reads it from the
// imperative `state.providers` catalogue and the remote surface from its store, and this
// component has no way to know which it is talking to.

import React from "react";

import { providerMarkSlot } from "./provider-mark.js";
import { MenuPortal, useAnchoredMenu } from "./use-anchored-menu.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";

const h = React.createElement;

// Drawn here rather than passed in as markup: both surfaces get the same glyph, which is
// the reason shared/panel-icons.js exists. Real elements, `currentColor`, no innerHTML.
function PlusIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "16",
      viewBox: "0 0 24 24",
      width: "16",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
    },
    h("path", { d: "M5 12h14" }),
    h("path", { d: "M12 5v14" })
  );
}

export function StartSessionSplitButton({
  buttonId,
  menuId,
  label = "New session",
  providerOptions = [],
  activeProvider = "",
  disabled = false,
  onStart,
  onStartWithProvider,
  title,
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const close = React.useCallback(() => setOpen(false), []);

  // A provider list that arrives late (the local surface fetches /api/providers after
  // boot) must not leave the menu stuck open on a stale set.
  React.useEffect(() => {
    if (!providerOptions.length) setOpen(false);
  }, [providerOptions.length]);

  // Was a hand-rolled copy of the same outside-pointer/Escape effect the pickers
  // use, minus the placement. Both come from the shared hooks now, which is what
  // gets this menu the flip-by-distance behaviour it never had.
  useDismissableMenu({ menuRef, onClose: close, open, rootRef });
  const assignMenuRef = useAnchoredMenu({ menuRef, open, triggerRef });

  const choose = (provider) => {
    close();
    onStartWithProvider?.(provider);
  };

  // With nothing to choose between, the caret is not disabled — it is absent. A dead half
  // of a split button reads as broken; one button reads as "there is one way to do this".
  const canPick = providerOptions.length > 1 && typeof onStartWithProvider === "function";

  return h(
    "div",
    { className: "start-session-split", ref: rootRef },
    h(
      "button",
      {
        className: "start-session-button",
        disabled: disabled || undefined,
        id: buttonId,
        onClick: () => onStart?.(),
        title,
        type: "button",
      },
      h(PlusIcon),
      h("span", null, label)
    ),
    canPick
      ? h(
          "button",
          {
            "aria-controls": open ? menuId : undefined,
            "aria-expanded": open ? "true" : "false",
            "aria-haspopup": "menu",
            "aria-label": "Choose an agent",
            className: "start-session-split-toggle",
            disabled: disabled || undefined,
            onClick: () => setOpen((wasOpen) => !wasOpen),
            ref: triggerRef,
            title: "Start a session with a specific agent",
            type: "button",
          },
          h("span", { "aria-hidden": "true", className: "start-session-split-caret" })
        )
      : null,
    h(
      MenuPortal,
      { anchorRef: triggerRef, open: open && canPick },
      h(
          "div",
          { className: "start-session-split-menu", id: menuId, ref: assignMenuRef, role: "menu" },
          ...providerOptions.map((option) =>
            h(
              "button",
              {
                className:
                  "start-session-split-option"
                  + (option.value === activeProvider ? " is-active" : ""),
                key: option.value,
                onClick: () => choose(option.value),
                role: "menuitem",
                type: "button",
              },
              providerMarkSlot(option.value, { className: "start-session-split-mark" }),
              h("span", null, option.label || option.value)
            )
          )
        )
    )
  );
}
