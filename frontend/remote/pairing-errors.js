import { t } from "../shared/i18n.js";

export function isExpiredPairingError(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("pairing request is missing or expired")
    || normalized.includes("join_ticket has expired")
    || normalized.includes("pairing link has expired")
  );
}

export function expiredPairingMessage() {
  return t("This QR code or pairing link has expired. Generate a new QR code from the local relay and scan it again.");
}

export function normalizePairingError(message) {
  if (isExpiredPairingError(message)) {
    return expiredPairingMessage();
  }
  return message || t("unknown pairing error");
}

/// Error code the broker sends to the peer that just lost its seat because a later
/// client joined with the same pairing ticket.
export const PAIRING_TICKET_SUPERSEDED_CODE = "pairing_ticket_superseded";

export function supersededPairingMessage() {
  return t("Another device took over this pairing code. Generate a new QR code from the local relay and scan it again on this device only.");
}

/// Decide what a broker `error` frame means for an in-flight pairing.
///
/// `terminal` means the ticket is dead for good, and the caller owes it three
/// things — retire it so `connectionTarget` stops feeding the automatic reconnect,
/// scrub the URL fragment so a page reload cannot resurrect it, and close the
/// socket. There is deliberately no separate "clear the ticket" flag: the two
/// terminal cases differ only in wording, and half-terminal handling is exactly
/// what let a superseded ticket keep reconnecting.
///
/// Everything else (rate limiting, transport hiccups) stays retryable, and none of
/// this applies when no pairing is in flight — a paired device's ordinary reconnect
/// must not be killed by it.
///
/// This is not the only expiry check: the broker answers failed joins with a
/// generic "broker join rejected" and a plain close carries no message at all, so
/// `pairingTicketIsLive` in state.js is the authoritative one.
export function classifyBrokerPairingError(frame, { hasPairingTicket }) {
  const retryable = { terminal: false, message: null };
  if (!hasPairingTicket) {
    return retryable;
  }
  if (frame?.code === PAIRING_TICKET_SUPERSEDED_CODE) {
    return { terminal: true, message: supersededPairingMessage() };
  }
  if (isExpiredPairingError(frame?.message)) {
    return { terminal: true, message: expiredPairingMessage() };
  }
  return retryable;
}
