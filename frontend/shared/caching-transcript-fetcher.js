// Wrap a transcript page fetcher with a persistent older-page cache.
//
// RED LINE: the live tail (`before == null`) is ALWAYS fetched from the network
// and is NEVER served from or written to the cache. Streaming authority and the
// "is there anything new" check are therefore unchanged. Only older, append-
// stable history pages (`before != null`) are cached and served cache-first.
//
// Why older pages are safe to cache by `before`: the relay's reverse pagination
// (build_reverse_thread_transcript_page) uses indices counted from the OLDEST
// entry (index 0), and `prev_cursor` is the page's lower-bound index. Appending
// new messages at the tail only grows transcript.len() and never shifts older
// indices, so a given `before` cursor maps to stable content under the common
// tail-append case. A structural rewrite (compaction/branch switch) produces a
// fresh tail with fresh cursors, so the chain naturally re-fetches.
//
// Every cache interaction is best-effort: any failure degrades to a cache
// miss / no-op so history loading keeps working exactly as before.
export function createCachingTranscriptPageFetcher({ fetchPage, cache, getScope }) {
  if (typeof fetchPage !== "function") {
    throw new Error("createCachingTranscriptPageFetcher requires a fetchPage function");
  }
  if (!cache || typeof cache.readPage !== "function" || typeof cache.writePage !== "function") {
    // No usable cache: behave exactly like the underlying fetcher.
    return fetchPage;
  }

  const resolveScope = typeof getScope === "function" ? getScope : () => "default";

  return async function cachedFetchTranscriptPage({ threadId, before }) {
    const isOlderPage = before != null;

    // Live tail: never touch the cache.
    if (!isOlderPage || !threadId) {
      return fetchPage({ threadId, before });
    }

    const scope = resolveScope() || "default";

    const cached = await readPageSafely(cache, { scope, threadId, before });
    if (cached && cached.thread_id === threadId) {
      return cached;
    }

    const page = await fetchPage({ threadId, before });

    if (isCacheablePage(page, threadId)) {
      // Fire-and-forget: a write failure must never block or break loading.
      void writePageSafely(cache, { scope, threadId, before, page });
    }

    return page;
  };
}

// The relay mutates a transcript entry IN PLACE by item_id at its (stable) index
// while its turn is in flight: status flips running -> completed, a tool gains a
// late result/diff, agent text keeps streaming. Because the cache is keyed by the
// fixed `before` index and reads do not revalidate, caching such a page would
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

export function isVolatileEntry(entry) {
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
