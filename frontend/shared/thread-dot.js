/**
 * Decide which activity/attention dot a thread row should show.
 *
 * Priority (highest first):
 *   1. needs_input → steady amber. Wins over "working" because a thread waiting
 *      on an approval keeps a live (paused) turn, so it still reads as working;
 *      the amber dot must override the pulse to signal the user must act.
 *   2. working → pulsing blue (with the active tool, when known).
 *   3. reviewing → pulsing blue. The parent thread is idle while a *separate*
 *      reviewer thread works on it, so it has no activity of its own; it still
 *      reads as live because a review is running against it. Ranks below the
 *      thread's own turn (that's more immediate) but above `completed` — an
 *      active review outranks a stale done flag.
 *   4. completed → steady blue, until the user opens the thread.
 *
 * @param {{
 *   activity?: { tool?: string|null } | null,
 *   attentionKind?: "needs_input"|"completed"|null,
 *   reviewing?: boolean,
 * }} input
 * @returns {{ className: string, label: string } | null}
 */
export function selectThreadDot({ activity = null, attentionKind = null, reviewing = false } = {}) {
  if (attentionKind === "needs_input") {
    return { className: "conversation-activity-dot is-attention-input", label: "Needs your input" };
  }
  if (activity) {
    return {
      className: "conversation-activity-dot",
      label: activity.tool ? `Working · ${activity.tool}` : "Working",
    };
  }
  if (reviewing) {
    return { className: "conversation-activity-dot is-reviewing", label: "Reviewing" };
  }
  if (attentionKind === "completed") {
    return { className: "conversation-activity-dot is-attention-done", label: "Completed" };
  }
  return null;
}
