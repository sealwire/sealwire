// What the handover, review and delegate cards share: the fold, and the small parts of
// the skeleton.
import React, { useContext, useEffect, useRef, useState } from "react";

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

/** How a transcript lets its cards load a row's whole body: `{ load, loading, failed }`. */
export const CardBodyContext = React.createContext(null);

/**
 * A body the relay may have sent short. `load` is set only while it is short and the
 * surface can fetch the rest, from row `rowId`.
 */
export function useCardBody(rowId, clipped) {
  const detail = useContext(CardBodyContext);
  const id = rowId || "";
  const loadable = Boolean(clipped && id && typeof detail?.load === "function");
  const loading = loadable && Boolean(detail.loading?.has?.(id));
  return {
    clipped: Boolean(clipped),
    loading,
    failed: loadable && !loading && Boolean(detail.failed?.has?.(id)),
    load: loadable ? () => detail.load(id) : null,
  };
}

/** Under a short body once asked for: that the rest is on its way, or a way to retry. */
export function CardBodyStatus({ body }) {
  if (body?.loading) {
    return h(
      "div",
      { className: "card-body-status", role: "status", "data-card-body-loading": "true" },
      h(Spinner),
      "Loading the rest…"
    );
  }
  if (body?.failed) {
    return h(
      "div",
      { className: "card-body-status is-failed", role: "status" },
      "Could not load the rest.",
      h(
        "button",
        { type: "button", className: "handover-card-link", "data-card-body-retry": "true", onClick: body.load },
        "Try again"
      )
    );
  }
  return null;
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
 * says it is cut off, since widths differ per screen, or `body` says there is more.
 */
export function useFold(content, enabled = true, body = null) {
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
  const more = Boolean(enabled && body?.load);
  const togglable = enabled && (open || cutOff || more);
  const toggle = () => {
    if (!open) {
      body?.load?.();
    }
    setOpen(!open);
  };
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
            // A focused link inside sends its keys up through here; they stay the link's.
            if (event.target !== event.currentTarget) {
              return;
            }
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
