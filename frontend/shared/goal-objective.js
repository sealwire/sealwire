// A goal is a standing aim the relay re-injects WHOLE every turn, so length is a
// per-turn cost rather than a one-off one. The wall is set where a pasted document
// stops being a task; the notice below it is the part that actually teaches, since
// the cost is invisible from the composer.
export const MAX_GOAL_OBJECTIVE_CHARS = 8000;
export const LONG_GOAL_OBJECTIVE_CHARS = 2000;

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
  const count = goalObjectiveCharCount(trimmed);
  if (count <= MAX_GOAL_OBJECTIVE_CHARS) return null;
  // Says how much to cut, because the draft is kept: the fix is an edit, and
  // "too long" alone leaves the user guessing at a number they cannot see.
  return `This goal is ${count} characters and ${MAX_GOAL_OBJECTIVE_CHARS} is the most it can be. Trim ${count - MAX_GOAL_OBJECTIVE_CHARS} and send it again.`;
}

/**
 * Advice, never a refusal — it describes a goal that is already set.
 *
 * Deliberately still returned above the hard cap: a goal stored before the cap
 * moved can be resumed verbatim, so the card has to be able to describe one.
 *
 * @returns {string|null}
 */
export function goalObjectiveLengthNotice(objective) {
  const trimmed = String(objective || "").trim();
  if (!trimmed) return null;
  const count = goalObjectiveCharCount(trimmed);
  if (count <= LONG_GOAL_OBJECTIVE_CHARS) return null;
  return `${count} characters, re-sent in full every turn.`;
}

/**
 * Gate for /goal authoring only — not for "Keep going", which resubmits a stored aim.
 *
 * Carries no notice: the composer's only visible line is error-toned, so advice
 * shown there reads as a refusal. `goalObjectiveLengthNotice` belongs to the card.
 *
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
