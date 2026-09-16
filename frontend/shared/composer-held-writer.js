// Writing into the composer's "not sent" region retires whatever the last attempt left
// on the error line.
//
// The two regions answer different questions — "the composer stopped this itself" versus
// "something failed" — but only one of them can be the CURRENT word about the draft in
// the box. The commands that refuse LOCALLY never reach an action, so their refusal used
// to appear underneath a red line from an earlier attempt that was no longer true.
//
// This covers only the refusals that come back through the controller's `hold`. Every
// other place that writes the region has to keep the rule itself, and there are four:
// `/goal` on each surface (`local/goal-authoring.js`, `remote/composer-command-actions.js`)
// and Stop-with-no-turn on each (`local/session/lifecycle.js`, `remote/session-ops.js`).
// The Stop pair was missed when this file was first written and shipped the very bug the
// paragraph above describes. All five sites are pinned; change one, check the rest.

/**
 * @param {(message: string) => void} hold  writes the "not sent" region
 * @param {() => void} clearError  retires the error line for the same thread
 */
export function createHeldWriter(hold, clearError = () => {}) {
  return (message) => {
    hold?.(message);
    // Unconditional, including the empty write. The controller only reaches `hold("")`
    // once a command pill and runner are found, so it means "a new attempt has begun" —
    // and a new attempt supersedes the previous result, exactly as an ordinary send does.
    // A failure of THIS attempt writes its own line afterwards.
    clearError();
  };
}
