import { sessionIsWorking } from "./thread-attention.js";
import { buildThreadActivityMap } from "./thread-activity.js";

/**
 * Whether a named thread still has an in-flight turn, for Stop-pending reconcile.
 *
 * Active thread: same rule as `sessionIsWorking` (turn id or working status).
 * Background: presence in `thread_activity` (see computeThreadStates) — the
 * entry exists only while a turn is in flight; phase may be null.
 *
 * @param {object | null | undefined} session
 * @param {string | null | undefined} threadId
 */
export function threadIsWorkingForStop(session, threadId) {
  if (!session || !threadId) return false;
  if (session.active_thread_id === threadId) {
    return sessionIsWorking(session);
  }
  return buildThreadActivityMap(session).has(threadId);
}

/**
 * Turn id to associate with a Stop press, when the surface knows it.
 * Prefer the active thread's `active_turn_id`; otherwise an overlay (view-only
 * pin) turn id for a background Stop.
 *
 * @param {object | null | undefined} session
 * @param {string | null | undefined} threadId
 * @param {{ overlayTurnId?: string | null }} [hints]
 * @returns {true | string}
 */
export function stopPendingTurnMarker(session, threadId, hints = {}) {
  if (
    session
    && threadId
    && session.active_thread_id === threadId
    && typeof session.active_turn_id === "string"
    && session.active_turn_id
  ) {
    return session.active_turn_id;
  }
  const overlay = hints?.overlayTurnId;
  if (typeof overlay === "string" && overlay) {
    return overlay;
  }
  return true;
}

/**
 * Resolve one pending thread against a live snapshot.
 *
 * `overlayWorking` / `overlayTurnId` come from a view-only pin (or the viewed
 * projection) for THIS thread: `thread_activity` on the real snapshot can
 * temporarily omit a still-streaming background turn, and without the overlay
 * reconcile would drop Stopping… on the same paint that recorded it.
 *
 * @param {object | null | undefined} session
 * @param {string} threadId
 * @param {{ overlayWorking?: boolean, overlayTurnId?: string | null }} [hints]
 */
export function stopPendingResolveFromSession(session, threadId, hints = {}) {
  let working = threadIsWorkingForStop(session, threadId);
  if (!working && hints?.overlayWorking) {
    working = true;
  }
  let turnId =
    session?.active_thread_id === threadId ? session.active_turn_id || null : null;
  if (!turnId && typeof hints?.overlayTurnId === "string" && hints.overlayTurnId) {
    turnId = hints.overlayTurnId;
  }
  return { working, turnId };
}

/**
 * Overlay hints from a local view-only pin for one pending thread.
 *
 * @param {{ threadId?: string, activeTurnId?: string | null } | null | undefined} pin
 * @param {string} threadId
 */
export function stopPendingOverlayFromPin(pin, threadId) {
  if (!pin || !threadId || pin.threadId !== threadId) {
    return {};
  }
  const overlayTurnId =
    typeof pin.activeTurnId === "string" && pin.activeTurnId ? pin.activeTurnId : null;
  return {
    // Same signal the projection uses for Stop: a pin turn id means working.
    overlayWorking: Boolean(overlayTurnId),
    overlayTurnId,
  };
}

/**
 * Overlay hints when the rendered session is a view-only projection of threadId.
 *
 * @param {object | null | undefined} viewedSession
 * @param {string} threadId
 */
export function stopPendingOverlayFromViewedSession(viewedSession, threadId) {
  if (!viewedSession?.view_only || !threadId || viewedSession.active_thread_id !== threadId) {
    return {};
  }
  const overlayTurnId =
    typeof viewedSession.active_turn_id === "string" && viewedSession.active_turn_id
      ? viewedSession.active_turn_id
      : null;
  return {
    overlayWorking: sessionIsWorking(viewedSession),
    overlayTurnId,
  };
}
