import React from "react";

import { CHEVRON_DOWN_SVG } from "../svg.js";
import {
  computeScrollToBottomVisible,
  findScrollContainer,
  readScrollMetrics,
} from "./scroll-to-bottom-core.js";
import { getTranscriptScrollController } from "./transcript-scroll-controller.js";
import { dispatchTranscriptScrollActionEvent } from "./transcript-scroll.js";

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
export function ScrollToBottomButton({ label = "Scroll to latest" }) {
  const anchorRef = React.useRef(null);
  const buttonRef = React.useRef(null);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const scroller = findScrollContainer(anchorRef.current);
    if (!scroller) return undefined;
    const update = metrics => setVisible(computeScrollToBottomVisible(metrics));
    update(readScrollMetrics(scroller));
    return getTranscriptScrollController(scroller).subscribePosition(update);
  }, []);

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

    // The controller resumes following as measured content grows. The button
    // has no separate multi-frame settling loop to fight a subsequent gesture.
    dispatchTranscriptScrollActionEvent(anchorRef.current, "rejoin-bottom");
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
