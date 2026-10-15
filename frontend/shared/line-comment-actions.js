import { t } from "./i18n.js";

/** Server string for `ListCommentsResponse.hand_back_unavailable_reason` on task runs. */
export const TEAM_RUN_HAND_BACK_UNAVAILABLE =
  "hand-back is only supported for thread-scoped comments; a finished task run cannot accept handed-back line comments yet";

export function commentScopeKind(scope) {
  if (typeof scope !== "string") {
    return "unknown";
  }
  if (scope.startsWith("team_run:")) {
    return "team_run";
  }
  if (scope.startsWith("thread:")) {
    return "thread";
  }
  return "unknown";
}

/**
 * Whether the hand-back action should be offered for an open comment in `scope`.
 * Prefer `canHandBack` from `GET /api/comments` when available.
 */
export function canHandBackLineComment(scope, { status = "open", canHandBack } = {}) {
  if (status !== "open") {
    return false;
  }
  if (typeof canHandBack === "boolean") {
    return canHandBack;
  }
  return commentScopeKind(scope) === "thread" && scope.length > "thread:".length;
}

/**
 * Why hand-back is disabled, if it is. Prefer `handBackUnavailableReason` from the list API.
 */
export function lineCommentHandBackDisabledReason(
  scope,
  { canHandBack, handBackUnavailableReason } = {}
) {
  if (typeof handBackUnavailableReason === "string" && handBackUnavailableReason) {
    return handBackUnavailableReason;
  }
  if (canHandBackLineComment(scope, { canHandBack })) {
    return null;
  }
  if (commentScopeKind(scope) === "team_run") {
    return TEAM_RUN_HAND_BACK_UNAVAILABLE;
  }
  return t("Hand-back is not available for this comment.");
}

/**
 * Render state for a per-comment hand-back control.
 * When `disabled` is true, show the control inert with `reason` — never a button that errors on click.
 */
export function lineCommentHandBackButtonState(scope, options = {}) {
  const status = options.status ?? "open";
  if (status !== "open") {
    return { show: false };
  }
  if (canHandBackLineComment(scope, options)) {
    return { show: true, disabled: false, reason: null };
  }
  return {
    show: true,
    disabled: true,
    reason: lineCommentHandBackDisabledReason(scope, options),
  };
}
