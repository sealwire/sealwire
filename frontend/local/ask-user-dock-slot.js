// The shell renders once; the session renderer publishes into it. Same seam as
// transcript-slot.js, kept separate so the live question card's mount is not
// tied to the transcript's — which is the reason for docking it at all.
let currentContent = null;
const listeners = new Set();

export function getLocalAskUserDockSnapshot() {
  return currentContent;
}

export function subscribeLocalAskUserDockSlot(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLocalAskUserDockContent(content) {
  if (Object.is(currentContent, content)) {
    return;
  }
  currentContent = content;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function resetLocalAskUserDockSlotForTest() {
  currentContent = null;
  listeners.clear();
}
