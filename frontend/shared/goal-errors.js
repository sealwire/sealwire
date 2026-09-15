// Which USER action on a goal is the current one, per thread, and what it had to say.
//
// A generation, deliberately not a fingerprint of the goal's own state. Only a person
// acting supersedes what a previous action reported; the goal moves for reasons that say
// nothing about whether the last refusal is still true. A driven turn bumps `turns`. A
// Stop that partly succeeds settles the goal in the same breath as the warning it
// returns — "stopped, but the turn it started is still running" is ABOUT that mutation,
// so anything keyed on the goal looking unchanged throws the warning away.
//
// Two doors act on one goal — the card's buttons and the composer's `/goal` — and
// neither can see the other, so both bump the same counter.

/** Start a user action. Clears what the previous one said; returns the new generation. */
export function beginGoalAction(state, threadId) {
  if (!threadId) return state || {};
  const current = (state || {})[threadId];
  return {
    ...(state || {}),
    [threadId]: { generation: (current?.generation || 0) + 1, message: "" },
  };
}

export function goalActionGeneration(state, threadId) {
  return (state || {})[threadId]?.generation || 0;
}

/** Record an outcome against the action that produced it — and only if it is still current. */
export function withGoalError(state, threadId, message, generation) {
  if (!threadId) return state || {};
  const current = (state || {})[threadId];
  // A settlement from an action the user has already replaced says nothing about now.
  if ((current?.generation || 0) !== (generation || 0)) return state || {};
  return {
    ...(state || {}),
    [threadId]: { generation: generation || 0, message: String(message || "") },
  };
}

export function goalErrorFrom(state, threadId) {
  return (state || {})[threadId]?.message || "";
}

/** Retire the current word without opening a new action. The user has read it. */
export function withGoalErrorCleared(state, threadId) {
  const current = (state || {})[threadId];
  if (!current) return state || {};
  return { ...(state || {}), [threadId]: { ...current, message: "" } };
}
