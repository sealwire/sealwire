/**
 * Decide which activity/attention dot a thread row should show.
 *
 * Priority (highest first):
 *   1. needs_input → steady amber. Wins over "working" because a thread waiting
 *      on an approval keeps a live (paused) turn, so it still reads as working;
 *      the amber dot must override the pulse to signal the user must act.
 *   2. working → pulsing blue (with the active tool, when known).
 *   3. completed → steady blue, until the user opens the thread.
 *
 * @param {{ activity?: { tool?: string|null } | null, attentionKind?: "needs_input"|"completed"|null }} input
 * @returns {{ className: string, label: string } | null}
 */
export function selectThreadDot({ activity = null, attentionKind = null } = {}) {
  if (attentionKind === "needs_input") {
    return { className: "conversation-activity-dot is-attention-input", label: "Needs your input" };
  }
  if (activity) {
    return {
      className: "conversation-activity-dot",
      label: activity.tool ? `Working · ${activity.tool}` : "Working",
    };
  }
  if (attentionKind === "completed") {
    return { className: "conversation-activity-dot is-attention-done", label: "Completed" };
  }
  return null;
}
