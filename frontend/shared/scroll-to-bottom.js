import React from "react";

import { CHEVRON_DOWN_SVG } from "../svg.js";
import {
  computeScrollToBottomVisible,
  findScrollContainer,
  maxScrollTop,
  readScrollMetrics,
} from "./scroll-to-bottom-core.js";

const h = React.createElement;

// Floating "jump to the latest message" button. Rendered inside the shared
// TranscriptState (see conversation.js) so every surface — local + remote,
// desktop + phone — gets it for free. The outer `.scroll-to-bottom` element is a
// zero-height strip pinned to the bottom of the transcript viewport (sticky
// inside the scrolling `.chat-thread` on desktop/remote; `position: fixed`
// against the window on the local phone layout, where the page itself scrolls —
// see conversation.css), so the button hovers just above the composer without
// adding scrollable height. It only appears when the reader has scrolled away
// from the bottom.
export function ScrollToBottomButton({ entries = [], label = "Scroll to latest" }) {
  const anchorRef = React.useRef(null);
  const buttonRef = React.useRef(null);
  const settleTimerRef = React.useRef(null);
  const [visible, setVisible] = React.useState(false);

  // The active scroller (`.chat-thread` on desktop, the window on phone) is
  // resolved fresh every read so the button works on both layouts and adapts as
  // the transcript grows past the viewport.
  const update = React.useCallback(() => {
    setVisible(
      computeScrollToBottomVisible(readScrollMetrics(findScrollContainer(anchorRef.current)))
    );
  }, []);

  React.useEffect(() => {
    const anchor = anchorRef.current;
    const chatThread = anchor?.closest?.(".chat-thread") || null;
    const view = anchor?.ownerDocument?.defaultView
      || (typeof window !== "undefined" ? window : null);

    // Listen on both candidates: desktop scrolls `.chat-thread`, phone scrolls
    // the window. Whichever fires, update() reads the currently-active one.
    chatThread?.addEventListener?.("scroll", update, { passive: true });
    view?.addEventListener?.("scroll", update, { passive: true });
    view?.addEventListener?.("resize", update);

    // Content height changes (streaming tokens, expanding tool cards, the
    // turn-end spacer collapsing) move the bottom without firing a scroll
    // event, so watch the scroller and its content for resizes too.
    let resizeObserver = null;
    if (typeof ResizeObserver !== "undefined" && chatThread) {
      resizeObserver = new ResizeObserver(() => update());
      resizeObserver.observe(chatThread);
      const content = chatThread.querySelector?.(".thread-content");
      if (content) {
        resizeObserver.observe(content);
      }
    }

    update();

    return () => {
      chatThread?.removeEventListener?.("scroll", update);
      view?.removeEventListener?.("scroll", update);
      view?.removeEventListener?.("resize", update);
      resizeObserver?.disconnect();
    };
  }, [update]);

  // Re-evaluate when the transcript changes: new/updated entries can grow the
  // scroll height while the reader sits mid-transcript.
  React.useEffect(() => {
    update();
  }, [entries, update]);

  // Cancel any in-flight scroll-settling timer when the button unmounts.
  React.useEffect(
    () => () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    },
    []
  );

  // Move focus off the button before the wrapper becomes aria-hidden, so focus
  // is never trapped inside a hidden subtree.
  React.useEffect(() => {
    if (visible) return;
    const button = buttonRef.current;
    if (button && button.ownerDocument?.activeElement === button) {
      button.blur();
    }
  }, [visible]);

  const handleClick = React.useCallback((event) => {
    // Defensive: the remote surface delegates clicks via a React onClick on
    // `.transcript-react-root`; keep this (non-transcript) click from reaching it.
    event.stopPropagation();

    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }

    // `content-visibility: auto` on `.chat-message` re-measures rows as they
    // scroll into view, growing scrollHeight while we descend — so a single
    // scrollTo lands well short of the true bottom. Snap to the (moving) bottom
    // repeatedly until the height stops changing or we hit a small cap.
    let tries = 0;
    let lastHeight = -1;
    const step = () => {
      const scrollEl = findScrollContainer(anchorRef.current);
      const metrics = readScrollMetrics(scrollEl);
      if (!scrollEl || !metrics) {
        settleTimerRef.current = null;
        return;
      }
      const top = maxScrollTop(metrics);
      if (typeof scrollEl.scrollTo === "function") {
        scrollEl.scrollTo({ top, behavior: "auto" });
      } else if ("scrollTop" in scrollEl) {
        scrollEl.scrollTop = top;
      }
      tries += 1;
      if (metrics.scrollHeight !== lastHeight && tries < 12) {
        lastHeight = metrics.scrollHeight;
        settleTimerRef.current = setTimeout(step, 60);
      } else {
        settleTimerRef.current = null;
      }
    };
    step();
  }, []);

  return h(
    "div",
    {
      className: "scroll-to-bottom",
      ref: anchorRef,
      "data-visible": visible ? "true" : "false",
      "aria-hidden": visible ? "false" : "true",
    },
    h(
      "button",
      {
        className: "scroll-to-bottom-button",
        ref: buttonRef,
        type: "button",
        onClick: handleClick,
        "aria-label": label,
        title: label,
        tabIndex: visible ? 0 : -1,
      },
      h("span", {
        className: "inline-icon",
        "aria-hidden": "true",
        dangerouslySetInnerHTML: { __html: CHEVRON_DOWN_SVG },
      })
    )
  );
}
