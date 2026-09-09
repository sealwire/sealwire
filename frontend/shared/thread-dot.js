/**
 * The five states a session row can be in, highest priority first.
 *
 * This ladder is the single source of truth for BOTH the per-row dot and the bell
 * filter's buckets. They must not drift: a row showing an amber dot has to land in the
 * bell's "Needs input" bucket, or the two readings of the same session disagree on
 * screen.
 *
 *   1. needs_input → wins over "working" because a thread waiting on an approval keeps a
 *      live (paused) turn, so it still reads as working; the amber dot must override the
 *      pulse to signal the user must act.
 *   2. working → the thread's own turn.
 *   3. reviewing → the parent thread is idle while a *separate* reviewer thread works on
 *      it, so it has no activity of its own; it still reads as live because a review is
 *      running against it. Ranks below the thread's own turn (that's more immediate) but
 *      above `completed` — an active review outranks a stale done flag.
 *   4. completed → until the user opens the thread.
 *   5. follow_up → the user flagged this session, and none of the four live states above
 *      apply. Reached ONLY as a fallback: a flagged thread that is also working, awaiting
 *      input, reviewing, or done stays under that live state — flagging never overrides
 *      it. This is the whole point of the flag: an idle thread is otherwise invisible to
 *      the bell (falls through to `null` below), so flagging it is the only way to keep
 *      it listed once it goes quiet.
 *
 * `null` is the sixth, unnamed state: idle and unflagged. It has no dot and no bucket.
 */
export const THREAD_STATES = Object.freeze([
  "needs_input",
  "working",
  "reviewing",
  "completed",
  "follow_up",
]);

export const THREAD_STATE_LABELS = Object.freeze({
  needs_input: "Needs input",
  working: "Working",
  reviewing: "Reviewing",
  completed: "Done",
  follow_up: "Follow up",
});

/**
 * Reduce the four per-thread signals to one state key.
 *
 * The first three inputs come from three different places — `thread_activity` (the
 * snapshot), `ThreadAttentionTracker` (derived transitions) and the review jobs channel
 * — which is why this ladder exists rather than a single field on the thread. `flagged`
 * is durable server state (like a session's custom name), checked last so it never
 * overrides a live signal.
 *
 * @param {{
 *   activity?: { tool?: string|null } | null,
 *   attentionKind?: "needs_input"|"completed"|null,
 *   reviewing?: boolean,
 *   flagged?: boolean,
 * }} input
 * @returns {"needs_input"|"working"|"reviewing"|"completed"|"follow_up"|null}
 */
export function selectThreadState({
  activity = null,
  attentionKind = null,
  reviewing = false,
  flagged = false,
} = {}) {
  if (attentionKind === "needs_input") {
    return "needs_input";
  }
  if (activity) {
    return "working";
  }
  if (reviewing) {
    return "reviewing";
  }
  if (attentionKind === "completed") {
    return "completed";
  }
  if (flagged) {
    return "follow_up";
  }
  return null;
}

const DOT_BY_STATE = {
  needs_input: { className: "conversation-activity-dot is-attention-input", label: "Needs your input" },
  working: { className: "conversation-activity-dot", label: "Working" },
  reviewing: { className: "conversation-activity-dot is-reviewing", label: "Reviewing" },
  completed: { className: "conversation-activity-dot is-attention-done", label: "Completed" },
};

/**
 * Decide which activity/attention dot a thread row should show.
 *
 * A thin projection of `selectThreadState` so the dot and the bell bucket cannot
 * disagree about the same row.
 *
 * @returns {{ className: string, label: string } | null}
 */
export function selectThreadDot(input = {}) {
  const state = selectThreadState(input);
  // `follow_up` means "flagged, otherwise idle" — no activity is happening, so it
  // gets no dot. Its signal is the separate, persistent flag mark on the row.
  if (!state || state === "follow_up") {
    return null;
  }
  const dot = DOT_BY_STATE[state];
  // The only state whose label carries extra detail.
  if (state === "working" && input.activity?.tool) {
    return { ...dot, label: `Working · ${input.activity.tool}` };
  }
  return dot;
}
