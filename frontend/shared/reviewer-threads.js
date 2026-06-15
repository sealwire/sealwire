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

/**
 * Reviewer threads (from the session snapshot's `reviewer_threads` map) that can be
 * REUSED for a new review of `parentThreadId` (Phase 3 reuse picker). Filters to the
 * parent; if `provider` is given, keeps entries whose provider matches OR is unknown
 * (`null` after a restart — still offered, the backend re-derives the provider on
 * submit). Sorted newest-first by `updated_at`. Defensive about null/malformed input.
 *
 * @param {Array<{reviewer_thread_id?: string, parent_thread_id?: string, reviewer_provider?: string|null, name?: string|null, updated_at?: number|null}>|null|undefined} reviewerThreads
 * @param {string|null|undefined} parentThreadId
 * @param {string|null|undefined} provider
 * @returns {Array<{reviewerThreadId: string, provider: string|null, label: string}>}
 */
export function selectReusableReviewers(reviewerThreads, parentThreadId, provider) {
  if (!parentThreadId) {
    return [];
  }
  return (reviewerThreads || [])
    .filter(
      (entry) =>
        entry?.reviewer_thread_id &&
        entry.parent_thread_id === parentThreadId &&
        (!provider ||
          entry.reviewer_provider == null ||
          entry.reviewer_provider === provider)
    )
    .slice()
    .sort((a, b) => (b?.updated_at || 0) - (a?.updated_at || 0))
    .map((entry) => ({
      reviewerThreadId: entry.reviewer_thread_id,
      provider: entry.reviewer_provider ?? null,
      label: entry.name || entry.reviewer_thread_id,
    }));
}

/**
 * The reuse picker MUST be scoped to the thread the Reviewer panel is showing —
 * the VIEWED thread (`viewThreadId`, falling back to the session's active thread) —
 * the same scope the review job cards (and their per-card "Re-review" launchers)
 * use. Scoping the reuse list to `active_thread_id` while the cards used the viewed
 * thread hid the viewed thread's reviewers from the re-review dropdown whenever you
 * were looking at a non-active thread (e.g. a second session held the active slot),
 * so the prefilled reviewer had no matching <option> and couldn't be selected.
 *
 * @param {{active_thread_id?: string|null, reviewer_threads?: Array}|null|undefined} session
 * @param {string|null|undefined} viewThreadId
 * @param {string|null|undefined} provider
 * @returns {Array<{reviewerThreadId: string, provider: string|null, label: string}>}
 */
export function selectReusableReviewersForView(session, viewThreadId, provider = null) {
  const viewedThreadId = viewThreadId || session?.active_thread_id || null;
  return selectReusableReviewers(session?.reviewer_threads, viewedThreadId, provider);
}
