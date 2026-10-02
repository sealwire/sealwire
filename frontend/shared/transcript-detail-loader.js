// Loads a row's whole detail on demand, for a tool call or a card alike. Surfaces differ
// only in where they keep state, so each passes those few operations in.

/**
 * @param {object} surface
 * @param {() => string|null} surface.currentThreadId the thread on screen now
 * @param {(threadId: string, itemId: string) => boolean} surface.hasFull
 * @param {(threadId: string, itemId: string) => boolean} [surface.hasFullDiff]
 * @param {(threadId: string, itemId: string) => Promise<object|null>} surface.fetchDetail
 *   null when the answer belongs to another run of the relay
 * @param {(threadId: string, detail: object) => void} surface.store
 * @param {(itemId: string, loading: boolean) => void} surface.setLoading
 * @param {() => void} [surface.onChange] the failed set changed
 * @param {(itemId: string, error: Error) => void} [surface.onError]
 */
export function createTranscriptDetailLoader({
  currentThreadId,
  hasFull,
  hasFullDiff = hasFull,
  fetchDetail,
  store,
  setLoading,
  onChange = null,
  onError = null,
}) {
  // Its own record, not the surface's loading state: a remote surface's state lands on
  // the next render, so a second press before then would start a second request.
  const inFlight = new Set();
  let failed = new Set();

  function markFailed(itemId, on) {
    if (failed.has(itemId) === on) {
      return;
    }
    failed = new Set(failed);
    if (on) {
      failed.add(itemId);
    } else {
      failed.delete(itemId);
    }
    onChange?.();
  }

  /** Resolves true once a detail was stored; false when nothing was needed or it failed. */
  async function load(itemId, { hasFull: complete = hasFull } = {}) {
    const threadId = currentThreadId();
    if (!itemId || !threadId || inFlight.has(itemId) || complete(threadId, itemId)) {
      return false;
    }
    inFlight.add(itemId);
    markFailed(itemId, false);
    setLoading(itemId, true);
    try {
      const detail = await fetchDetail(threadId, itemId);
      if (currentThreadId() !== threadId) {
        return false;
      }
      if (!detail) {
        markFailed(itemId, true);
        return false;
      }
      store(threadId, detail);
      return true;
    } catch (error) {
      if (currentThreadId() === threadId) {
        markFailed(itemId, true);
      }
      onError?.(itemId, error);
      return false;
    } finally {
      inFlight.delete(itemId);
      setLoading(itemId, false);
    }
  }

  return {
    load,
    // A card asks only while what it draws is still short, so a held copy it could not
    // use (its round was run again since) must not stop the fetch.
    loadBody: (itemId) => load(itemId, { hasFull: () => false }),
    // For one file of a change; a running turnDiff's parked summary is held but no diff.
    loadDiff: (itemId) => load(itemId, { hasFull: hasFullDiff }),
    /** A new set on every change, so a memoized reader sees it change. */
    failedItemIds: () => failed,
    reset() {
      if (failed.size) {
        failed = new Set();
        onChange?.();
      }
    },
  };
}
