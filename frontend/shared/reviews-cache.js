// Revision-keyed cache for the reviewer-panel data (review cards + reviewer threads),
// fetched over a DEDICATED channel (`/api/session/reviews` locally, the `fetch_reviews`
// broker action remotely) that is NOT byte-budget compacted. The session snapshot carries
// only a tiny scalar `reviews_revision`; this cache re-fetches the full data ONLY when that
// revision changes — so the reviewer panel stays populated during live turns (which drain
// the snapshot's `active_review_jobs`) without re-fetching on every snapshot frame.

import { selectReusableReviewers } from "./reviewer-threads.js";

/**
 * Create a reviews cache. `sync(revision, fetch, onUpdate)` fetches the full
 * `ReviewsResponse` only when `revision` differs from what's cached/in-flight, then calls
 * `onUpdate()` so the caller can re-render. A failed fetch keeps the prior cache. A `null`
 * revision (snapshot without the field) is a no-op.
 */
export function createReviewsCache() {
  // The SNAPSHOT revision we last fetched FOR — gate on this (not the response's revision).
  // If the relay moved between the snapshot and our fetch, the response's revision can lag the
  // snapshot's; gating on the requested revision still marks that snapshot handled, so a
  // re-render → sync doesn't loop fetching until the snapshot is redelivered.
  let syncedRevision = null;
  let loaded = false;
  let data = { review_jobs: [], reviewer_threads: [] };
  let inflightRevision = null;

  return {
    current() {
      return data;
    },
    hasData() {
      return loaded;
    },
    async sync(snapshotRevision, fetchReviews, onUpdate) {
      if (snapshotRevision == null) {
        return;
      }
      if (syncedRevision === snapshotRevision || inflightRevision === snapshotRevision) {
        return;
      }
      inflightRevision = snapshotRevision;
      try {
        const resp = await fetchReviews();
        // Drop a stale response if a newer revision started fetching meanwhile.
        if (inflightRevision !== snapshotRevision) {
          return;
        }
        syncedRevision = snapshotRevision;
        loaded = true;
        data = {
          review_jobs: resp?.review_jobs || [],
          reviewer_threads: resp?.reviewer_threads || [],
        };
        if (typeof onUpdate === "function") {
          onUpdate();
        }
      } catch (_error) {
        // Keep the prior cache on error — better stale cards than an empty panel. Leave
        // syncedRevision unchanged so a later sync retries this revision.
      } finally {
        if (inflightRevision === snapshotRevision) {
          inflightRevision = null;
        }
      }
    },
  };
}

/**
 * The review-job cards for the thread the panel is showing, from a `ReviewsResponse`.
 * @param {{review_jobs?: Array}|null|undefined} reviews
 * @param {string|null|undefined} viewedThreadId
 */
export function reviewCardsForViewedThread(reviews, viewedThreadId) {
  if (!viewedThreadId) {
    return [];
  }
  return (reviews?.review_jobs || []).filter(
    (job) => job?.parent_thread_id === viewedThreadId
  );
}

/**
 * The reusable reviewer threads of the viewed thread, from a `ReviewsResponse` (mirrors
 * `selectReusableReviewersForView` but over the dedicated channel's reviewer_threads).
 */
export function reusableReviewersFromReviews(reviews, viewedThreadId, provider = null) {
  return selectReusableReviewers(reviews?.reviewer_threads, viewedThreadId, provider);
}
