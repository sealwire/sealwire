// Thread-scoped "Stop is in flight" flags.
//
// The stop HTTP call returns as soon as the provider is *asked* to cancel; the
// turn may keep looking "working" for seconds until the agent answers or the
// relay's fallback idles it. Without a pending flag the Stop button stays
// clickable and looks dead, so users mash it. Pending means: show Stopping…,
// refuse another click, and clear only when that thread is no longer working
// (or the request itself failed — or a newer turn replaced the one we stopped).
//
// Map values are either `true` (turn id unknown, e.g. a background Orchestrator
// stop) or the turn id that was active when Stop was pressed. The turn id lets
// an off-screen idle→new-turn cycle drop a stale flag even if we never observed
// the idle snapshot.

/**
 * @param {Record<string, true | string> | null | undefined} map
 * @param {string | null | undefined} threadId
 * @param {true | string} [turnMarker=true]
 */
export function withStopPending(map, threadId, turnMarker = true) {
  if (!threadId) return map && typeof map === "object" ? map : {};
  return { ...(map || {}), [threadId]: turnMarker === undefined || turnMarker === null ? true : turnMarker };
}

/**
 * @param {Record<string, true | string> | null | undefined} map
 * @param {string | null | undefined} threadId
 */
export function withoutStopPending(map, threadId) {
  if (!threadId || !map?.[threadId]) return map && typeof map === "object" ? map : {};
  const next = { ...map };
  delete next[threadId];
  return next;
}

/**
 * @param {Record<string, true | string> | null | undefined} map
 * @param {string | null | undefined} threadId
 */
export function isStopPending(map, threadId) {
  return Boolean(threadId && map?.[threadId]);
}

/**
 * Drop the flag once the thread is idle again — that is the backend saying stop
 * landed (or the fallback settled it). A still-working thread keeps the flag,
 * unless a newer turn id proves the stopped turn is gone.
 *
 * @param {Record<string, true | string> | null | undefined} map
 * @param {string | null | undefined} threadId
 * @param {boolean | { working?: boolean, turnId?: string | null }} workingOrInfo
 */
export function reconcileStopPending(map, threadId, workingOrInfo) {
  if (!isStopPending(map, threadId)) return map && typeof map === "object" ? map : {};
  const info =
    typeof workingOrInfo === "boolean"
      ? { working: workingOrInfo }
      : workingOrInfo && typeof workingOrInfo === "object"
        ? workingOrInfo
        : {};
  if (!info.working) return withoutStopPending(map, threadId);
  const marker = map[threadId];
  if (typeof marker === "string" && info.turnId && marker !== info.turnId) {
    return withoutStopPending(map, threadId);
  }
  return map;
}

/**
 * Reconcile every pending thread against authoritative liveness. Needed because
 * reconciling only the viewed thread leaves an off-screen idle entry forever —
 * the next turn on that thread then paints Stopping… and the duplicate guard
 * refuses a real Stop.
 *
 * @param {Record<string, true | string> | null | undefined} map
 * @param {(threadId: string) => boolean | { working?: boolean, turnId?: string | null }} resolve
 */
export function reconcileAllStopPending(map, resolve) {
  let next = map && typeof map === "object" ? map : {};
  if (typeof resolve !== "function") return next;
  for (const threadId of Object.keys(next)) {
    next = reconcileStopPending(next, threadId, resolve(threadId));
  }
  return next;
}
