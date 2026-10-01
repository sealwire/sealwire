import React, { useEffect, useRef } from "react";

const h = React.createElement;

// A short-lived note at the bottom of the window with one way back. Used where an
// action skipped its confirm because there was nothing to lose, and Undo is cheaper.
export function UndoToast({ message, onDismiss, onUndo, timeoutMs = 6000 }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current?.(), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs]);
  return h(
    "div",
    { className: "undo-toast", role: "status" },
    h("span", { className: "undo-toast-message" }, message),
    h(
      "button",
      {
        className: "undo-toast-action",
        onClick: () => {
          dismissRef.current?.();
          onUndo?.();
        },
        type: "button",
      },
      "Undo"
    )
  );
}
