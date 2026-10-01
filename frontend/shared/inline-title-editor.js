import React, { useEffect, useRef } from "react";

import { isImeComposing } from "./composer-keys.js";

const h = React.createElement;

// In-place title editor shared by the session tab strip and the sidebar rows.
// Blur saves an edited name rather than dropping it: the box is small and easy to click
// away from. Escape is the explicit "forget it".
export function InlineTitleEditor({ defaultValue, onCommit, onCancel, className, ariaLabel }) {
  const inputRef = useRef(null);
  // Enter commits and then blurs; without this the blur would submit the name again.
  const settledRef = useRef(false);
  // Saving an untouched box would pin the agent's title as the user's own, so only an
  // explicit Enter may do that; a click-away or removal leaves it as a cancel.
  const openedWithRef = useRef(defaultValue ?? "");

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    // Selected, so the common case — replacing the agent's title — is just typing.
    input.select();
    // Removal fires no blur, so a host that drops the box would lose the draft; keep it as
    // a click-away would. Deferred because this runs inside React's commit.
    return () => {
      if (settledRef.current) {
        return;
      }
      settledRef.current = true;
      const value = input.value;
      queueMicrotask(() => (value === openedWithRef.current ? onCancel?.() : onCommit?.(value)));
    };
  }, []);

  const settle = (commit, { explicit = false } = {}) => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    const value = inputRef.current?.value ?? "";
    if (commit && (explicit || value !== openedWithRef.current)) {
      onCommit?.(value);
    } else {
      onCancel?.();
    }
  };

  return h("input", {
    ref: inputRef,
    type: "text",
    className,
    defaultValue,
    "aria-label": ariaLabel,
    // The host turns presses, clicks and double clicks into its own gestures (pan,
    // open, keep). Inside the box they place a caret and select text.
    onPointerDown: (event) => event.stopPropagation(),
    onClick: (event) => event.stopPropagation(),
    onDoubleClick: (event) => event.stopPropagation(),
    // The host claims `contextmenu` for its own menu; here it must stay the browser's
    // cut/copy/paste menu.
    onContextMenu: (event) => event.stopPropagation(),
    onBlur: () => settle(true),
    onKeyDown: (event) => {
      if (isImeComposing(event)) {
        // The input method's own keys; global shortcuts must still not see them.
        event.stopPropagation();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        settle(true, { explicit: true });
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
        event.currentTarget.blur();
      } else if (event.key === "Tab") {
        settle(true);
      }
      // Global shortcuts listen above the React root; editing keys must stay here.
      event.stopPropagation();
    },
  });
}
