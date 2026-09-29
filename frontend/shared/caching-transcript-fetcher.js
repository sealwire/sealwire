// Wrap a transcript page fetcher with a persistent older-page cache.
//
// RED LINE: the live tail (`before == null`) is ALWAYS fetched from the network
// and is NEVER served from or written to the cache. Streaming authority and the
// "is there anything new" check are therefore unchanged. Only older, append-
// stable history pages (`before != null`) are cached and served cache-first.
//
// Why older pages are safe to cache by `before`: the relay's cursor names "rows older
// than this row's order key", and rows appended at the tail never take a key below an
// existing one. A rebuilt transcript mints cursors the old ones never equal, so the
// chain re-fetches rather than reading a page that no longer lines up.
//
// Every cache interaction is best-effort: any failure degrades to a cache
// miss / no-op so history loading keeps working exactly as before.
export function createCachingTranscriptPageFetcher({
  fetchPage,
  cache,
  getScope,
  getGeneration,
}) {
  if (typeof fetchPage !== "function") {
    throw new Error("createCachingTranscriptPageFetcher requires a fetchPage function");
  }
  if (!cache || typeof cache.readPage !== "function" || typeof cache.writePage !== "function") {
    // No usable cache: behave exactly like the underlying fetcher.
    return fetchPage;
  }

  const resolveScope = typeof getScope === "function" ? getScope : () => "default";
  // Which relay process minted the ids in a page. A restart rebuilds threads from
  // provider history and that renumbers item ids, so a page cached by the previous
  // process names the same messages differently — merged in, one message renders
  // twice. Keyed by it, those pages are simply never read.
  const resolveGeneration = typeof getGeneration === "function" ? getGeneration : () => "";

  return async function cachedFetchTranscriptPage({ threadId, before }) {
    const isOlderPage = before != null;

    // Live tail: never touch the cache.
    if (!isOlderPage || !threadId) {
      return fetchPage({ threadId, before });
    }

    const scope = resolveScope() || "default";

    const generation = resolveGeneration() || "";

    const cached = await readPageSafely(cache, { scope, threadId, before, generation });
    if (cached && cached.thread_id === threadId) {
      return cached;
    }

    const page = await fetchPage({ threadId, before });

    if (isCacheablePage(page, threadId)) {
      // Fire-and-forget: a write failure must never block or break loading.
      void writePageSafely(cache, { scope, threadId, before, page, generation });
    }

    return page;
  };
}

// The relay mutates a transcript entry IN PLACE by item_id at its (stable) position
// while its turn is in flight: status flips running -> completed, a tool gains a
// late result/diff, agent text keeps streaming. Because the cache is keyed by the
// fixed `before` cursor and reads do not revalidate, caching such a page would
// persist a stale copy that never heals after reload. So a page is only written
// through once EVERY entry in it has settled to a terminal status. (Residual: an
// already-completed file-change entry can still have its apply_state badge flipped
// by a later rollback/reapply — a narrow, low-severity staleness that clears on
// eviction/unpair; the diff content itself is stable.)
const VOLATILE_ENTRY_STATUSES = new Set([
  "running",
  "in_progress",
  "in-progress",
  "pending",
  "streaming",
]);

const SETTLED_REVIEW_STATUSES = new Set(["complete", "failed", "escalated", "cancelled"]);

export function isVolatileEntry(entry) {
  // The card on this row still changes when the handover ends.
  if (entry?.injection?.handover?.status === "working") {
    return true;
  }
  // A review card changes until the review ends, and a review waiting on the person
  // until they decide.
  const review = entry?.injection?.review;
  if (
    review
    && (!SETTLED_REVIEW_STATUSES.has(review.status)
      || (review.status === "escalated" && !review.decision))
  ) {
    return true;
  }
  // A delegate card changes until its answer is handed back.
  if (
    (entry?.injection?.delegate || []).some(
      (ask) =>
        ask?.status === "working"
        || (!ask?.delivered && Boolean(ask?.peer_thread_id))
    )
  ) {
    return true;
  }
  const status = typeof entry?.status === "string" ? entry.status.trim().toLowerCase() : "";
  return VOLATILE_ENTRY_STATUSES.has(status);
}

export function isCacheablePage(page, threadId) {
  return Boolean(
    page
      && page.thread_id === threadId
      && Array.isArray(page.entries)
      && page.entries.length > 0
      && !page.entries.some(isVolatileEntry)
  );
}

async function readPageSafely(cache, args) {
  try {
    return (await cache.readPage(args)) || null;
  } catch {
    return null;
  }
}

async function writePageSafely(cache, args) {
  try {
    await cache.writePage(args);
  } catch {
    // Best-effort cache; ignore failures.
  }
}
