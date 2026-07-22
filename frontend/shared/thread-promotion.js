// Deferred-thread promotion detection, shared by both surfaces.
//
// Deferred Claude sessions live under a synthetic `claude-pending-…` id until
// the first send promotes them to the real SDK session id. The relay records
// that lineage (`thread_promoted_from`, mirroring `forked_from`) and every
// session snapshot carries it as `active_thread_promoted_from` — the
// AUTHORITATIVE signal that lets any client, observers included, tell a
// promotion apart from an ordinary thread switch. The active-id sequence
// alone cannot: "pending id -> different id" is also exactly what another
// device switching the relay to an unrelated thread looks like, and
// promotion snapshots have no reliable turn/transcript shape to corroborate
// with (reconnects and snapshot coalescing erase any such invariant).
//
// Consumers must therefore ONLY classify a transition as promotion when the
// snapshot's own lineage field names the exact thread id this client was on.
// Absence of the field (older relay) means no detection — degrading to plain
// thread-switch behavior, never to a wrong rekey.

export function detectDeferredThreadPromotion({
  previousThreadId,
  nextThreadId,
  nextThreadPromotedFrom,
} = {}) {
  if (
    !previousThreadId
    || !nextThreadId
    || previousThreadId === nextThreadId
    || !nextThreadPromotedFrom
    || nextThreadPromotedFrom !== previousThreadId
  ) {
    return null;
  }
  return { from: previousThreadId, to: nextThreadId };
}

// Whether an observer whose view is PINNED to the pending thread should be
// re-pinned onto the promoted id. Without this, the projection keeps
// rendering the stale pending transcript forever (the pending thread ceased
// to exist). The promotion itself is authoritative, so no further
// corroboration is needed — including promotions first observed late (after
// the turn completed, after a reconnect, or with more transcript activity).
export function shouldRebindPinnedViewOnPromotion({
  pinnedThreadId,
  promotion,
} = {}) {
  return Boolean(
    promotion && pinnedThreadId && pinnedThreadId === promotion.from
  );
}
