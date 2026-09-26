// Turning a transcript-page response into something safe to put in a pin.
//
// Every pane that reads a thread it does not own does the same three things to
// a page before trusting it, and each one exists because of a specific way the
// naive version is wrong:
//
//   - NORMALIZE, so a response with no entries reads as an empty page rather
//     than crashing the pane.
//   - VALIDATE the thread id, because a response for the wrong thread is not an
//     empty result, it is another conversation rendered under this one's header.
//   - MERGE against what the pin already has, because a refresh that assigns
//     `entries = page.entries` throws away both the older history you paged in
//     and any delta that landed while the fetch was in flight.
//
// The Orchestrator pane did none of the three. It was written after this
// machinery, beside it rather than on it.

import { mergeRefreshedViewOnlyPage } from "./view-only-thread.js";

/**
 * @param {object|null} page raw response
 * @param {string} threadId the thread this page was requested for
 * @returns {{ thread_id: string, entries: object[], prev_cursor: string|null }}
 * @throws when the response names a different thread
 */
export function normalizeTranscriptPage(page, threadId) {
  const normalized =
    page && Array.isArray(page.entries)
      ? page
      : { thread_id: threadId, entries: [], prev_cursor: null };
  if (normalized.thread_id !== threadId) {
    throw new Error(
      `Transcript response thread mismatch (expected ${threadId}, received ${
        normalized.thread_id || "missing"
      })`
    );
  }
  return normalized;
}

/**
 * Normalize, validate, and merge a page into what a pin already holds.
 *
 * @param {object|null} prior the pin being refreshed, or null for a first load
 * @param {object|null} page raw response
 * @param {string} threadId
 * @returns {{ page: object, entries: object[], olderCursor: string|null, historyExtended: boolean }}
 */
export function refreshedPinPage(prior, page, threadId) {
  const normalized = normalizeTranscriptPage(page, threadId);
  const merged = mergeRefreshedViewOnlyPage(prior, normalized);
  return {
    page: { ...normalized, entries: merged.entries, prev_cursor: merged.olderCursor },
    entries: merged.entries,
    olderCursor: merged.olderCursor,
    // The caller stores this and hands it back as the next refresh's `prior`.
    // Computed here and dropped, it survived exactly one refresh.
    historyExtended: merged.historyExtended,
  };
}
