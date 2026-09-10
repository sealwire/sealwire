export function threadListQueryKey({
  limit = null,
  scope = "default",
  surface,
}) {
  return [
    "thread-list",
    surface,
    scope,
    { limit },
  ];
}

/**
 * `generation` names the run of the relay whose item ids the page will carry.
 *
 * Without it in the key, a request issued after a restart DEDUPES onto the identical
 * request still in flight from before it, and the caller is handed a page full of the
 * previous run's ids.
 */
export function threadTranscriptPageQueryKey({
  before = null,
  generation = "",
  scope = "default",
  surface,
  threadId,
}) {
  return [
    "thread-transcript",
    surface,
    scope,
    generation || "",
    threadId || "",
    before ?? null,
  ];
}

export function createThreadListQueryOptions({
  fetchThreads,
  limit = null,
  scope = "default",
  surface,
}) {
  return {
    queryKey: threadListQueryKey({ limit, scope, surface }),
    queryFn: () => fetchThreads({ limit }),
  };
}

/**
 * Fetch the thread list bypassing the query cache's in-flight de-duplication, and seed
 * the cache with the result.
 *
 * `queryClient.fetchQuery` returns the ALREADY-RUNNING request's promise when one is in
 * flight for the same key (query-core's `Query.fetch` returns its retryer's promise
 * unless `cancelRefetch` is set, and `fetchQuery` never sets it). Normally that
 * coalescing is exactly what you want — boot, the 12s poll and a manual refresh should
 * not become three requests.
 *
 * It is wrong for a refresh triggered by a KNOWN mutation, such as the `threads_revision`
 * bump after a rename. There, the caller needs data that reflects a change made at a
 * specific moment; being handed a response to a request that was issued BEFORE it means
 * silently rendering pre-mutation state. And because the revision has already been
 * consumed by then, nothing retries — the stale title sits there until the next poll.
 *
 * Starting a second request is NOT enough on its own, which is the subtle part. The
 * pre-mutation request stays in flight and keeps owning the cache key, so a routine
 * refresh arriving afterwards dedupes onto IT — and since that refresh is the most recent
 * invocation, the callers' generation guards (which only know invocation order) accept
 * its stale answer and discard the fresh one. Evicting the query first is what stops a
 * later reader from attaching to a request that predates the mutation.
 *
 * Nothing subscribes to this key independently — it is a de-dup layer, not a store — so
 * evicting it is safe; the caller already holds the data it needs. `setQueryData`
 * afterwards re-seeds it so the next reader starts from post-mutation state.
 */
export async function fetchThreadListFresh({
  fetchThreads,
  limit = null,
  queryClient = null,
  scope = "default",
  surface,
}) {
  const queryKey = threadListQueryKey({ limit, scope, surface });
  // Before the request, so nothing that arrives while it runs can join the old one.
  queryClient?.removeQueries({ queryKey, exact: true });
  const threads = await fetchThreads({ limit });
  queryClient?.setQueryData(queryKey, threads);
  return threads;
}

export function createThreadTranscriptPageQueryOptions({
  before = null,
  fetchPage,
  generation = "",
  scope = "default",
  surface,
  threadId,
}) {
  return {
    queryKey: threadTranscriptPageQueryKey({
      before,
      generation,
      scope,
      surface,
      threadId,
    }),
    queryFn: () => fetchPage({
      before,
      threadId,
    }),
  };
}

/**
 * Fetch a transcript page bypassing the query cache's in-flight
 * de-duplication, and seed the cache with the result. Mirrors
 * `fetchThreadListFresh` above for the identical reason: a caller here needs
 * data that reflects a moment AFTER a client-detected event (a per-item
 * delta gap/mismatch/missing-head), and a request that began BEFORE that
 * moment must not be allowed to satisfy it.
 *
 * `fetchPage` itself must ALSO bypass any read-through disk cache (pass the
 * raw, uncached primitive) — evicting the query here only stops a race with
 * `fetchQuery`'s own dedup; it does nothing if `fetchPage` reads stale data
 * from somewhere else first.
 *
 * `removeQueries` does not just detach the key for future readers: query-core's
 * `Query.destroy()` cancels its retryer outright (`retryer.js`'s `cancel`),
 * rejecting the promise every caller is holding — including one from BEFORE
 * this eviction whose fetch is still in flight. So the request this call
 * supersedes fails with a `CancelledError` rather than quietly resolving
 * unread; callers going through the ordinary `ensureConversationTranscript` /
 * `hydrateTranscript` path already treat a rejected `fetchPage` as a normal,
 * loggable failure (`onError`), not a crash. Because a FRESH Query is built
 * for the evicted key, any caller who calls `fetchQuery` for it AFTER this
 * eviction — even before this function's own fetch resolves — starts its own
 * independent request rather than attaching to anything this call touched.
 * `setQueryData` once this function's own fetch resolves seeds that fresh
 * Query with the authoritative answer, so a reader arriving after BOTH have
 * settled reads this one, not whichever happened to finish first.
 */
export async function fetchThreadTranscriptPageFresh({
  before = null,
  fetchPage,
  generation = "",
  queryClient = null,
  scope = "default",
  surface,
  threadId,
}) {
  // MUST be the same key ordinary paging uses, generation included. Evicting a key
  // built without it leaves the current run's in-flight request registered, so the
  // repair below is not fresh at all — it attaches to the request it meant to replace.
  const queryKey = threadTranscriptPageQueryKey({ before, generation, scope, surface, threadId });
  // Before the request, so a request racing this one cannot dedupe onto a
  // request that predates it.
  queryClient?.removeQueries({ queryKey, exact: true });
  const page = await fetchPage({ before, threadId });
  queryClient?.setQueryData(queryKey, page);
  return page;
}

/**
 * Drop every cached transcript page query that is not from `generation`.
 *
 * `gcTime: Infinity` (shared/query-client.js) means nothing ever expires on its own,
 * so without this the previous run's pages sit in the cache for the life of the tab —
 * and any of them can still be handed to a caller. Removing them also cancels the
 * requests still in flight from that run, which is the other half of the problem.
 *
 * Returns how many were removed, so a caller can log or assert on it.
 */
export function dropTranscriptPageQueriesFromOtherGenerations(queryClient, generation) {
  if (!queryClient || typeof queryClient.getQueryCache !== "function") {
    return 0;
  }
  const current = generation || "";
  const stale = queryClient
    .getQueryCache()
    .findAll({ queryKey: ["thread-transcript"] })
    .filter((query) => (query.queryKey?.[3] || "") !== current);
  stale.forEach((query) => {
    queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
  });
  return stale.length;
}
