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
  // Every list the channel carries. A field left out here is fetched, returned,
  // and then silently dropped — which looks exactly like the relay never sent it.
  let data = { review_jobs: [], reviewer_threads: [], asks: [], goals: [], handovers: [] };
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
        // A response carrying NO payload is not an answer — it's a failure that didn't
        // throw (the remote fetch resolves to null when the transport drops the field).
        // Accepting it would latch `loaded` with empty lists, and since callers fall back
        // via `cache || snapshot`, a truthy-but-empty cache SHADOWS that fallback for good.
        // Treat it exactly like a thrown error: keep the prior cache, leave the revision
        // unsynced so a later sync retries. An explicitly empty ReviewsResponse is a real
        // answer and still loads normally.
        if (resp == null) {
          return;
        }
        syncedRevision = snapshotRevision;
        loaded = true;
        data = {
          review_jobs: resp?.review_jobs || [],
          reviewer_threads: resp?.reviewer_threads || [],
          asks: resp?.asks || [],
          goals: resp?.goals || [],
          handovers: resp?.handovers || [],
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
 * The goal of the thread the panel is showing, from a `ReviewsResponse`.
 * @param {{goals?: Array}|null|undefined} reviews
 * @param {string|null|undefined} viewedThreadId
 */
export function goalForThread(reviews, viewedThreadId) {
  if (!viewedThreadId) {
    return null;
  }
  return (reviews?.goals || []).find((goal) => goal?.thread_id === viewedThreadId) || null;
}

/**
 * The asks the viewed thread is either end of, stamped with both sides' names. Names, not
 * a resolver: the store diffs slices with `JSON.stringify`, which drops functions.
 * @param {{asks?: Array}|null|undefined} reviews
 * @param {string|null|undefined} viewedThreadId
 * @param {Array<{id?: string, name?: string, provider?: string}>|null|undefined} threads
 */
// Survives the sidebar's page: an asker's session falls out of `state.threads` as
// newer ones arrive, but inbound cards still need its logo. Only ids *absent* from
// the current page keep remembered fields; a present row is authoritative.
const rememberedThreadIdentity = new Map();
const MAX_REMEMBERED_THREAD_IDENTITIES = 256;

export function clearRememberedThreadIdentities() {
  rememberedThreadIdentity.clear();
}

export function rememberThreadIdentities(threads, { protectIds } = {}) {
  const protect = new Set(protectIds || []);
  for (const thread of threads || []) {
    if (!thread?.id) continue;
    // Re-insert so a freshly seen id is treated as newest for the bound below.
    rememberedThreadIdentity.delete(thread.id);
    rememberedThreadIdentity.set(thread.id, {
      // Present row wins, including clears (name/provider null or "").
      name: thread.name || null,
      provider: thread.provider || null,
    });
  }
  // Evict unprotected rows first. Ids still referenced by retained asks must survive
  // a rolling sidebar page, or legacy inbound cards lose their logo again.
  while (rememberedThreadIdentity.size > MAX_REMEMBERED_THREAD_IDENTITIES) {
    let victim = null;
    for (const id of rememberedThreadIdentity.keys()) {
      if (!protect.has(id)) {
        victim = id;
        break;
      }
    }
    if (!victim) break;
    rememberedThreadIdentity.delete(victim);
  }
}

export function asksForThread(reviews, viewedThreadId, threads) {
  if (!viewedThreadId) {
    return [];
  }
  const protectIds = [];
  for (const ask of reviews?.asks || []) {
    if (ask?.asker_thread_id) protectIds.push(ask.asker_thread_id);
    if (ask?.peer_thread_id) protectIds.push(ask.peer_thread_id);
  }
  rememberThreadIdentities(threads, { protectIds });
  const presentIds = new Set();
  const nameById = new Map();
  const providerById = new Map();
  for (const thread of threads || []) {
    if (!thread?.id) continue;
    presentIds.add(thread.id);
    nameById.set(thread.id, thread.name || null);
    providerById.set(thread.id, thread.provider || null);
  }
  return (reviews?.asks || [])
    .filter(
      (ask) =>
        ask?.asker_thread_id === viewedThreadId || ask?.peer_thread_id === viewedThreadId
    )
    .map((ask) => {
      const rememberedAsker = rememberedThreadIdentity.get(ask.asker_thread_id) || {};
      const rememberedPeer = rememberedThreadIdentity.get(ask.peer_thread_id) || {};
      const askerOnPage = presentIds.has(ask.asker_thread_id);
      const peerOnPage = presentIds.has(ask.peer_thread_id);
      // peer_provider can be "" on the wire even when peer_thread_id is set.
      // Outbound cards group on that field — empty became "another agent" + no logo.
      const peerProvider =
        ask.peer_provider ||
        (peerOnPage ? providerById.get(ask.peer_thread_id) : null) ||
        rememberedPeer.provider ||
        null;
      return {
        ...ask,
        asker_name: askerOnPage
          ? nameById.get(ask.asker_thread_id)
          : rememberedAsker.name || null,
        peer_name: peerOnPage
          ? nameById.get(ask.peer_thread_id)
          : rememberedPeer.name || null,
        asker_provider:
          ask.asker_provider ||
          (askerOnPage ? providerById.get(ask.asker_thread_id) : null) ||
          rememberedAsker.provider ||
          null,
        peer_provider: peerProvider,
      };
    });
}

/**
 * Everything the Agents panel shows that depends only on the viewed thread. One call so a
 * surface cannot pick up the review cards and quietly miss the goal, which is how remote
 * shipped without either. It must return EVERY key every time: the store merges patches,
 * so a key left out keeps the thread you were looking at before.
 * @param {{review_jobs?: Array, goals?: Array, asks?: Array, reviewer_threads?: Array}|null|undefined} reviews
 * @param {string|null|undefined} viewedThreadId
 * @param {Array<{id?: string, name?: string}>|null|undefined} threads
 */
export function agentsPanelSlice(reviews, viewedThreadId, threads) {
  return {
    reviewJobs: reviewCardsForViewedThread(reviews, viewedThreadId),
    goal: goalForThread(reviews, viewedThreadId),
    asks: asksForThread(reviews, viewedThreadId, threads),
    // Every reviewer thread, so a card can name its own by joining on reviewer_thread_id.
    reviewerThreads: reviews?.reviewer_threads || [],
    parentThreadId: viewedThreadId || null,
  };
}

/**
 * Reusable reviewer threads of the viewed thread from a `ReviewsResponse`.
 * `workspaceCwd` drops reviewers minted in another tree.
 */
export function reusableReviewersFromReviews(
  reviews,
  viewedThreadId,
  provider = null,
  workspaceCwd = null
) {
  return selectReusableReviewers(
    reviews?.reviewer_threads,
    viewedThreadId,
    provider,
    workspaceCwd
  );
}
