// What the handover, review and delegate cards share: the fold, and the small parts of
// the skeleton.
import React, { useEffect, useRef, useState } from "react";

const h = React.createElement;

export function clockTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const date = new Date(seconds * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Ticks once a second while `active`, for a card's running time. */
export function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function CardIcon({ paths, size = 15 }) {
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    ...paths.map((d) => h("path", { key: d, d }))
  );
}

export function Caret({ open }) {
  return h(
    "svg",
    {
      className: `handover-caret${open ? " is-open" : ""}`,
      width: 9,
      height: 9,
      viewBox: "0 0 10 10",
      fill: "currentColor",
      "aria-hidden": "true",
    },
    h("path", { d: "M3 1.5 7 5 3 8.5z" })
  );
}

export function Spinner() {
  return h("span", { className: "handover-spinner", "aria-hidden": "true" });
}

export function OpenThreadLink({ threadId, label }) {
  if (!threadId) {
    return null;
  }
  return h(
    "button",
    { type: "button", className: "handover-card-link", "data-open-thread-id": threadId },
    label
  );
}

export function avatar(markup, provider) {
  return h("span", {
    className: "message-avatar",
    "aria-hidden": "true",
    ...(markup ? { "data-provider": provider } : null),
    dangerouslySetInnerHTML: { __html: markup },
  });
}

/** The card's own "show the rest" button, under what it holds back. */
export function ShowAllButton({ open, onToggle, label }) {
  return h(
    "button",
    {
      type: "button",
      className: "handover-card-more",
      "aria-expanded": open ? "true" : "false",
      onClick: onToggle,
    },
    h(Caret, { open }),
    open ? "Show less" : label
  );
}

/**
 * Folds a value to two lines (`card-fold`). It opens on a press only once the browser
 * says it is cut off, since widths differ per screen.
 */
export function useFold(content, enabled = true) {
  const [open, setOpen] = useState(false);
  const [cutOff, setCutOff] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    if (!enabled || open || !node) {
      return undefined;
    }
    const measure = () => setCutOff(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [enabled, open, content]);
  const togglable = enabled && (open || cutOff);
  const toggle = () => setOpen((value) => !value);
  return {
    ref,
    open,
    togglable,
    toggle,
    // For a value with no button of its own to open it; a handover section has its heading.
    keyboard: togglable
      ? {
          tabIndex: 0,
          role: "button",
          "aria-expanded": open ? "true" : "false",
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          },
        }
      : null,
    className: `card-fold${enabled && !open ? " is-clamped" : ""}${togglable ? " is-togglable" : ""}`,
    // A link still goes where it points, and a drag to select text is not a press.
    onClick: togglable
      ? (event) => {
          if (!event.target.closest?.("a") && !String(globalThis.getSelection?.() || "")) {
            toggle();
          }
        }
      : undefined,
  };
}
