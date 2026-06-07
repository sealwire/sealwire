// Pure helpers for the local thread context-menu's "delete/archive the reviewer
// thread(s) too?" prompt. They live here — outside the side-effectful app.js
// entry module — so the request-shaping logic can be unit-tested without a DOM,
// React, or fetch harness. Both `archiveThreadFromContextMenu` and
// `deleteThreadFromContextMenu` in app.js build on them.

/**
 * Count how many hidden reviewer threads belong to a given parent thread, reading
 * the session snapshot's `reviewer_threads` map (reviewer_thread_id ->
 * parent_thread_id). Returns 0 for a missing parent id or an absent/empty map.
 *
 * @param {Array<{parent_thread_id?: string}>|null|undefined} reviewerThreads
 * @param {string|null|undefined} parentThreadId
 * @returns {number}
 */
export function countReviewerThreadsForParent(reviewerThreads, parentThreadId) {
  if (!parentThreadId) {
    return 0;
  }
  return (reviewerThreads || []).filter(
    (entry) => entry?.parent_thread_id === parentThreadId
  ).length;
}

/**
 * Build the extra `fetch()` init (headers + body) for a delete/archive request,
 * given the user's reviewer-thread choice.
 *
 * - `undefined` (no reviewers, so the prompt never ran) → bodyless request `{}`;
 *   the backend then applies its endpoint default (delete cascades, archive keeps).
 * - explicit boolean → send `{ delete_reviewers }` as a JSON body so the user's
 *   choice is honoured verbatim, never silently defaulted.
 *
 * The caller spreads the result after `method: "POST"`.
 *
 * @param {boolean|undefined} deleteReviewers
 * @returns {{headers?: Record<string,string>, body?: string}}
 */
export function reviewerChoiceRequestInit(deleteReviewers) {
  if (deleteReviewers === undefined) {
    return {};
  }
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delete_reviewers: deleteReviewers }),
  };
}
