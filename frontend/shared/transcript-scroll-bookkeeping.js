import {
  captureTranscriptScrollSnapshot,
  readTranscriptScrollPosition,
  rememberTranscriptScrollPosition,
  restoreTranscriptScrollPosition,
} from "./transcript-scroll.js";

// Shared bookkeeping engine behind both transcript panes (Local, Remote).
// Owns the three things every pane retains across renders — the previous
// render's snapshot, per-key scroll positions, per-key anchored-id sets —
// keyed by an opaque "scroll key" the caller supplies (a thread id for
// Local, `relayId:threadId` for Remote). Pure and React-free so every
// surface-specific timing quirk (flushSync vs. listener-driven, capture
// mode, reset epochs) stays in the adapter hook, not here.
export function createTranscriptScrollBookkeeping() {
  let previousSnapshot = null;
  const positions = new Map();
  const anchors = new Map();
  // `undefined` until the first sync: mount adopts whatever generation is live
  // rather than reading itself as a change.
  let generation;

  function anchorsFor(key) {
    return anchors.get(key) || new Set();
  }

  // Remembering a leaving view and dropping the anchors of whatever key the
  // bounded LRU evicted are one coupled step — every retirement path shares
  // this, so no caller can retain a position while orphaning its anchors.
  function rememberView(key, geometrySource) {
    const evictedKey = rememberTranscriptScrollPosition(positions, key, geometrySource);
    if (evictedKey) {
      anchors.delete(evictedKey);
    }
    return evictedKey;
  }

  function readRestoreIntent(key) {
    return readTranscriptScrollPosition(positions, key);
  }

  // A plain existence check, deliberately not `readRestoreIntent`: that read
  // also refreshes LRU recency, which would touch a leaving key's position
  // even on the "don't overwrite it" path that only wants to know it exists.
  function hasPosition(key) {
    return positions.has(key);
  }

  function applyRestore({
    key,
    nextEntries,
    nextThreadId,
    pendingInputRequestIds,
    restoredScrollPosition,
    scrollElement,
  }) {
    const anchorSet = anchorsFor(key);
    // A retained snapshot committed under a DIFFERENT, non-null key must not
    // stand in for "the same thread" here: two keys can share a thread id
    // (relay-scoped keys with the same underlying thread), and comparing
    // activeThreadId alone would read a genuine switch as "nothing changed"
    // and silently drop the restoredScrollPosition the caller already
    // resolved for this key. A null scrollKey (the null-element snapshot) is
    // the one exception -- there is no better signal, so let decide's own
    // activeThreadId comparison do the switch detection.
    const snapshotForKey =
      previousSnapshot && (previousSnapshot.scrollKey == null || previousSnapshot.scrollKey === key)
        ? previousSnapshot
        : null;
    const action = restoreTranscriptScrollPosition({
      alreadyAnchoredUserIds: anchorSet,
      nextEntries,
      nextThreadId,
      pendingInputRequestIds,
      previousSnapshot: snapshotForKey,
      restoredScrollPosition,
      scrollElement,
    });
    const claimedIds = [action?.userEntryId, ...(action?.inputRequestIds || [])].filter(
      Boolean
    );
    if (claimedIds.length) {
      for (const id of claimedIds) {
        anchorSet.add(id);
      }
      anchors.set(key, anchorSet);
    }
    return action;
  }

  function commitSnapshot({ key, threadId, entries, scrollElement }) {
    previousSnapshot = {
      ...captureTranscriptScrollSnapshot({ entries, scrollElement, threadId }),
      scrollKey: key,
    };
    return previousSnapshot;
  }

  function reset() {
    previousSnapshot = null;
    positions.clear();
    anchors.clear();
  }

  /**
   * Drop everything retained when the relay's run changes. Returns whether it
   * reset.
   *
   * All three retained things are keyed by item ids — the snapshot's entry ids,
   * the anchored-id sets — and a new run renames the same messages
   * (shared/transcript-generation.js). Applying them across that boundary
   * anchors to ids the new run has never issued, which scrolls to the wrong
   * place on the first frame after an upgrade.
   *
   * Both directions count, empty included: "" -> "gen-a" is a relay that gained
   * stamping and "gen-a" -> "" is one that lost it, and both renumber. A relay
   * that never stamps holds "" forever, so it never resets after mount — which
   * is also what makes this terminate instead of resetting every render.
   */
  function syncGeneration(nextGeneration) {
    const normalized = String(nextGeneration ?? "");
    if (generation === undefined) {
      generation = normalized;
      return false;
    }
    if (generation === normalized) {
      return false;
    }
    generation = normalized;
    reset();
    return true;
  }

  // Rekey the promoted key/thread-id pair (the deferred-Claude case: a
  // synthetic `claude-pending-*` id promoted to its real session id on first
  // send) across all three retained things in one step. Returns true if
  // anything was rekeyed.
  function retarget(options) {
    // `options || {}`, not a destructured default param: a default only
    // applies for `undefined`, and callers (safely) pass `null` too.
    const { fromKey, toKey, fromThreadId, toThreadId } = options || {};
    if (!fromKey || !toKey || !fromThreadId || !toThreadId || fromKey === toKey) {
      return false;
    }
    let changed = false;
    // Thread ids alone are not a reliable match: two distinct keys can share
    // one (a reconnect reusing a thread id under a different relay). Only
    // rekey the retained snapshot when its own scrollKey agrees with fromKey
    // -- or is absent, the null-element snapshot's shape, which carries no
    // key to disagree with.
    const snapshotScrollKey = previousSnapshot?.scrollKey;
    const snapshotBelongsToFromKey = snapshotScrollKey == null || snapshotScrollKey === fromKey;
    if (previousSnapshot?.activeThreadId === fromThreadId && snapshotBelongsToFromKey) {
      previousSnapshot.activeThreadId = toThreadId;
      if (snapshotScrollKey === fromKey) {
        previousSnapshot.scrollKey = toKey;
      }
      changed = true;
    }
    if (positions.has(fromKey)) {
      positions.set(toKey, positions.get(fromKey));
      positions.delete(fromKey);
      changed = true;
    }
    if (anchors.has(fromKey)) {
      anchors.set(toKey, anchors.get(fromKey));
      anchors.delete(fromKey);
      changed = true;
    }
    return changed;
  }

  return {
    anchorsFor,
    applyRestore,
    commitSnapshot,
    getSnapshot: () => previousSnapshot,
    hasPosition,
    readRestoreIntent,
    rememberView,
    reset,
    retarget,
    syncGeneration,
  };
}
