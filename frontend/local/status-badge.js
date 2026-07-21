import { describeSessionStatus } from "../shared/session-status.js";
import { REVIEW_BLOCKED_BADGE, REVIEW_IN_PROGRESS_BADGE } from "../shared/review-state.js";

/**
 * Salience-ordered status pill for the local header. This is the SINGLE consumer
 * of the shared session-status seam for the local surface: the approval, provider
 * outage, and task labels all come from `describeSessionStatus`, while the
 * local-only transient states (pairing requests, blocked/in-progress review, a
 * stalled turn) are layered on top.
 *
 * Extracting it out of the render closure is what lets the provider-outage label
 * be tested at the consumer level — the previous inline chain hardcoded "Offline"
 * and never reached the seam, so the helper's "Providers offline" label was dead.
 *
 * @param {{
 *   session: object|null,
 *   approval?: object|null,
 *   pendingPairingCount?: number,
 *   reviewBlocked?: boolean,
 *   stalled?: boolean,
 *   activeThreadFrozen?: boolean,
 * }} input
 * @returns {{ text: string, tone: "alert"|"offline"|"ready" }}
 */
export function selectStatusBadge({
  session,
  approval = null,
  pendingPairingCount = 0,
  reviewBlocked = false,
  stalled = false,
  activeThreadFrozen = false,
} = {}) {
  const status = describeSessionStatus(session, { approval });

  if (approval) {
    return { text: status.attention.label, tone: "alert" };
  }
  if (pendingPairingCount > 0) {
    return {
      text:
        pendingPairingCount === 1
          ? "Pairing request"
          : `${pendingPairingCount} pairing requests`,
      tone: "alert",
    };
  }
  if (!status.providers.ready) {
    // `primaryLabel` here is "Providers offline" — the subject-named label from the
    // seam. The old inline chain hardcoded a bare "Offline" and never reached it.
    return { text: status.primaryLabel, tone: "offline" };
  }
  if (reviewBlocked) {
    return { text: REVIEW_BLOCKED_BADGE.label, tone: REVIEW_BLOCKED_BADGE.tone };
  }
  if (stalled) {
    return { text: "Stalled?", tone: "alert" };
  }
  if (activeThreadFrozen) {
    return { text: REVIEW_IN_PROGRESS_BADGE.label, tone: REVIEW_IN_PROGRESS_BADGE.tone };
  }
  return { text: status.primaryLabel, tone: "ready" };
}
