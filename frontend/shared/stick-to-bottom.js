import React from "react";
import { getTranscriptScrollController } from "./transcript-scroll-controller.js";
export { classifyScrollIntent, classifyTranscriptScrollAction, RESTICK_AT_BOTTOM_PX } from "./transcript-scroll-intent.js";

// React lifetime adapter. The controller owns follow intent, gestures, anchors,
// measurements and all transcript position writes on both surfaces.
export function StickToBottomFollower() {
  const marker = React.useRef(null);
  React.useLayoutEffect(() => {
    const scroller = marker.current?.closest(".chat-thread");
    return scroller ? getTranscriptScrollController(scroller).connect() : undefined;
  }, []);
  React.useLayoutEffect(() => {
    const scroller = marker.current?.closest(".chat-thread");
    if (scroller) getTranscriptScrollController(scroller).refreshContent();
  });
  return React.createElement("span", {
    "aria-hidden": "true", className: "stick-to-bottom-anchor", hidden: true, ref: marker,
  });
}
