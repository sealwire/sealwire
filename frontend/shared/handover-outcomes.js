// How a handover that failed AFTER it was accepted reaches the person who asked for it.
//
// `/handover` is answered "on its way" minutes before it arrives: the source session has
// to write the summary first, which is a real turn on a real model. Everything that can
// be refused is refused while the call is open, but what is left — the summary never
// finishing, the target being opened and used, deleted, or pulled into a Code Flow — can
// only fail later. The relay keeps that as a durable record and puts the unread ones on
// the snapshot; this turns them into the composer's own failure line.
//
// Two rules, and both are the reason this is not just `if (status === "failed") show()`:
//
//   1. It belongs to the SOURCE thread, not to whichever composer is on screen. The
//      person may well have moved on — that is what handing over is for.
//   2. Each one is shown ONCE. The composer clears its error line whenever a new
//      command attempt starts, so a relay that re-pushed the same failure on every
//      snapshot would put it straight back under a draft it no longer describes.
//      Telling the relay it has been read is what makes that stick across a reload.

/** The sentence a person reads. The relay's own reason already names what was left. */
export function handoverFailureText(handover) {
  const reason = String(handover?.error || "").trim();
  return reason
    ? `Handing over did not finish: ${reason}`
    : "Handing over did not finish, and the relay did not say why.";
}

/**
 * @param {{
 *   report: (threadId: string, message: string) => void,
 *   acknowledge?: (handoverId: string) => void,
 * }} deps
 * @returns {(handovers?: Array<object>) => string[]} the ids reported by this call
 */
export function createHandoverOutcomeReporter({ report, acknowledge = () => {} }) {
  // Within one page load this is what stops a repeat; `acknowledge` is what stops one
  // across reloads. Both are needed — snapshots arrive many times a second, and a
  // reload starts with an empty set.
  const shown = new Set();

  return function reportHandoverOutcomes(handovers = []) {
    const reported = [];
    for (const handover of handovers || []) {
      const id = handover?.id;
      // "working" is not news: the person was already told it was under way.
      if (!id || handover.status !== "failed" || shown.has(id)) continue;
      shown.add(id);
      reported.push(id);
      report(String(handover.source_thread_id || ""), handoverFailureText(handover));
      acknowledge(id);
    }
    return reported;
  };
}
