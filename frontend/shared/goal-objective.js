// A goal is a standing aim the relay re-injects every turn. A status dump here
// burns tokens and crowds the Agents card — keep it short on purpose.
export const MAX_GOAL_OBJECTIVE_CHARS = 500;

/** Unicode scalar count — same unit as Rust `chars().count()` on the relay. */
export function goalObjectiveCharCount(text) {
  return [...String(text || "")].length;
}

/**
 * @param {string|null|undefined} objective
 * @returns {string|null} refusal text, or null when the objective is fine (including empty —
 *   empty means "stop" on some paths and is handled elsewhere).
 */
export function goalObjectiveRefusal(objective) {
  const trimmed = String(objective || "").trim();
  if (!trimmed) return null;
  if (goalObjectiveCharCount(trimmed) > MAX_GOAL_OBJECTIVE_CHARS) {
    return `Keep the goal short (at most ${MAX_GOAL_OBJECTIVE_CHARS} characters) — what to aim for, not a status report.`;
  }
  return null;
}

/**
 * Gate for /goal authoring only — not for "Keep going", which resubmits a stored aim.
 * @returns {{ refuse: string } | { objective: string }}
 */
export function prepareAuthoredGoalObjective(objective) {
  const trimmed = String(objective || "").trim();
  if (!trimmed) {
    return { objective: "" };
  }
  const refuse = goalObjectiveRefusal(trimmed);
  if (refuse) {
    return { refuse };
  }
  return { objective: trimmed };
}
