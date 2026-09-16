// The composer's "not sent" slot on the LOCAL surface: what a "/" command stopped
// before the relay ever heard about it.
//
// A sibling of composer-error.js rather than a second use of it. The error line is
// for things that went wrong — a send that failed, a relay that refused. Nothing
// went wrong here: the composer read the draft, decided it was not ready, and sent
// nothing. Sharing one slot would force one colour onto both, and the red one is
// what made "/goal too long" read as a crash rather than as a typo to fix.
//
// Same imperative style and the same per-thread rule as the error line: record/clear
// touch only the thread they name, and `syncComposerHeld` is the only writer to the
// DOM, called on every render so navigation alone settles what is on screen.

import { threadError, withThreadError, withoutThreadError } from "../shared/composer-errors.js";

/** @type {Record<string, string>} */
let held = {};

export function recordComposerHeld({ threadId = "", message = "" } = {}) {
  held = withThreadError(held, threadId, message);
  return held;
}

export function composerHeldFor(threadId) {
  return threadError(held, threadId);
}

export function clearComposerHeld(threadId) {
  held = withoutThreadError(held, threadId);
  return held;
}

/**
 * Render the held message belonging to the thread now on screen (if any).
 *
 * @param {{ hidden: boolean, querySelector: Function } | null | undefined} node
 * @param {string | null} viewedThreadId
 */
export function syncComposerHeld(node, viewedThreadId) {
  const shown = threadError(held, viewedThreadId);
  if (node) {
    const text = node.querySelector?.(".composer-held-text");
    if (text) text.textContent = shown;
    node.hidden = !shown;
  }
  return shown;
}

/** Test seam: drop everything, so one test's held draft cannot leak into another. */
export function resetComposerHeldForTest() {
  held = {};
}
