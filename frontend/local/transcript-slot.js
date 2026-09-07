import React from "react";

const h = React.createElement;

export const LOCAL_TRANSCRIPT_FALLBACK = h(
  "div",
  { className: "thread-empty" },
  h("h2", null, "Relay standing by"),
  h(
    "p",
    null,
    "Load a workspace, then use this console to watch the live session, control state, and trusted devices."
  )
);

let currentContent = LOCAL_TRANSCRIPT_FALLBACK;
const listeners = new Set();

export function getLocalTranscriptSlotSnapshot() {
  return currentContent;
}

export function subscribeLocalTranscriptSlot(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLocalTranscriptSlotContent(content) {
  if (Object.is(currentContent, content)) {
    return;
  }
  currentContent = content;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function getLocalTranscriptSlotSubscriptionCount() {
  return listeners.size;
}

export function resetLocalTranscriptSlotForTest() {
  currentContent = LOCAL_TRANSCRIPT_FALLBACK;
  listeners.clear();
}
