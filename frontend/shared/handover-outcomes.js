// How a handover that failed AFTER it was accepted reaches the person who asked for it.
//
// `/handover` is answered "on its way" minutes before it arrives: the source session has
// to write the summary first, which is a real turn on a real model. Everything that can
// be refused is refused while the call is open; what is left — the summary never
// finishing, the target being used, deleted, or pulled into a Code Flow — can only fail
// later. The relay keeps those as durable records and serves the unread ones on the
// reviews channel, which is fetched PER ACTOR (see `ReviewsResponse::handovers`). This
// turns them into the composer's own failure line.
//
// Three rules, and each one is a bug that was here:
//
//   1. A failure belongs to the SOURCE thread, not to whichever composer is on screen.
//      The person may well have moved on — that is what handing over is for.
//   2. All of a thread's unread failures are shown TOGETHER. Writing them one at a time
//      into a per-thread slot means the last write wins, so the newest failure was
//      overwritten by the oldest and then both were marked read — the one that mattered
//      most was the one nobody could see.
//   3. Nothing is acknowledged until its OWN REASON has been in front of the person, on
//      its own thread's composer. Not when it is written (that consumes a failure while
//      they are looking at another session), and not when it is only counted in an "…and
//      2 more" — a number is not a reason, and there is no second place to go and read
//      the rest.
//
// Which is why the line carries EVERY unread reason rather than paging through them.
// Paging looked safer and was not: acknowledging the first few changes the revision, the
// automatic refetch renders the next few over the top, and the earlier ones flash past
// on one continuous view. Nothing here is user-driven, so nothing here may assume a
// second visit. The lists stay short because the relay's reasons are its own authored
// sentences and an actor's unread outcomes are quota-bounded.

function reasonOf(handover) {
  return String(handover?.error || "").trim() || "the relay did not say why";
}

/** The ids this line gives a reason for — which, by construction, is all of them. */
function spokenFor(handovers = []) {
  return (handovers || []).map((handover) => handover?.id).filter(Boolean);
}

/**
 * One line for this thread's failures, newest first.
 *
 * Every one of them, with its own reason — never a count. The caller acknowledges
 * exactly what this line said, so a reason left out here is a failure consumed unseen,
 * and there is no panel or detail route to go and find it in afterwards.
 */
export function handoverFailureText(handovers = []) {
  const reasons = (handovers || []).map(reasonOf);
  if (!reasons.length) return "";
  if (reasons.length === 1) return `Handing over did not finish: ${reasons[0]}`;
  const spelled = reasons.map((reason, index) => `(${index + 1}) ${reason}`).join(" ");
  return `${reasons.length} handovers did not finish. ${spelled}`;
}

/**
 * @param {{
 *   report: (threadId: string, message: string) => void,
 *   acknowledge?: (handoverId: string) => void,
 * }} deps
 */
export function createHandoverOutcomeReporter({ report, acknowledge = () => {} }) {
  // The ids whose REASON is in the line currently written for each thread. This is the
  // whole of the durability story on the client: anything not in here is still the
  // relay's to hold, and a reload gets it back.
  const spoken = new Map();
  // What was last written for a thread, so a feed that carries the same set again does
  // not rewrite the line under a draft the person is in the middle of fixing.
  const written = new Map();

  /**
   * @param {Array<object>} handovers the actor's feed, as the relay served it
   * @param {{ viewedThreadId?: string | null }} where the person is looking right now
   * @returns {string[]} the threads whose line was (re)written by this call
   */
  function sync(handovers = [], { viewedThreadId = null } = {}) {
    const bySource = new Map();
    for (const handover of handovers || []) {
      // "working" is not news: the person was already told it was under way.
      if (!handover?.id || handover.status !== "failed") continue;
      const source = String(handover.source_thread_id || "");
      if (!bySource.has(source)) bySource.set(source, []);
      bySource.get(source).push(handover);
    }

    const changed = [];
    for (const [source, group] of bySource) {
      // JSON rather than a delimiter: an id is arbitrary text, so the only separator that
      // cannot collide with one is no separator at all.
      const signature = JSON.stringify(group.map((handover) => handover.id));
      if (written.get(source) === signature) continue;
      written.set(source, signature);
      spoken.set(source, spokenFor(group));
      report(source, handoverFailureText(group));
      changed.push(source);
    }
    // A thread the relay no longer lists has had its failures consumed somewhere — this
    // tab or another. Stop tracking it so a later one is reported afresh.
    for (const source of [...written.keys()]) {
      if (!bySource.has(source)) {
        written.delete(source);
        spoken.delete(source);
      }
    }

    // Shown right now, because this IS the composer on screen.
    if (viewedThreadId) confirmShown(viewedThreadId);
    return changed;
  }

  /**
   * The reasons on this thread's line have been put in front of the person — its
   * composer is on screen, or they have deliberately replaced them by handing over
   * again. The line carries all of them, so this consumes all of them, once.
   *
   * @returns {string[]} the ids acknowledged
   */
  function confirmShown(threadId) {
    const ids = spoken.get(threadId);
    if (!ids || !ids.length) return [];
    spoken.delete(threadId);
    written.delete(threadId);
    for (const id of ids) acknowledge(id);
    return ids;
  }

  return { sync, confirmShown };
}
