export function pairingNowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Fallback used when a snapshot doesn't carry `expires_at` (e.g. an older
// relay-server binary that pre-dates the field). Matches the current backend
// default so behavior is consistent against the matching backend, and at worst
// slightly aggressive against a 90s-default legacy backend.
const FALLBACK_PAIRING_TTL_SECS = 30;

// Compute the effective expiry timestamp for a request, falling back to
// requested_at + FALLBACK_PAIRING_TTL_SECS if expires_at isn't available.
// Returns null if neither field is present.
export function effectivePairingExpiry(request) {
  if (!request) return null;
  if (request.expires_at) return request.expires_at;
  if (request.requested_at) return request.requested_at + FALLBACK_PAIRING_TTL_SECS;
  return null;
}

export function filterActivePairings(requests, nowSeconds = pairingNowSeconds()) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return [];
  }
  return requests.filter((request) => {
    const expiry = effectivePairingExpiry(request);
    return expiry === null || expiry > nowSeconds;
  });
}

export function earliestPairingExpiry(requests) {
  if (!Array.isArray(requests)) {
    return null;
  }
  let earliest = Infinity;
  for (const request of requests) {
    const expiry = effectivePairingExpiry(request);
    if (expiry !== null && expiry < earliest) {
      earliest = expiry;
    }
  }
  return Number.isFinite(earliest) ? earliest : null;
}

// Pure decision: given the latest approval + (already filtered) pending pairings,
// what should the bottom action banner show? Returns one of:
//   { kind: "approval", approval }
//   { kind: "pairing",  label, count }
//   { kind: "hidden" }
// Used by the renderer; testable without DOM.
export function decidePendingActionBannerState(
  approval,
  pendingPairings,
  shortId = (value) => String(value || "")
) {
  if (approval) {
    return { kind: "approval", approval };
  }
  if (Array.isArray(pendingPairings) && pendingPairings.length > 0) {
    return {
      kind: "pairing",
      label: formatPendingPairingsBannerLabel(pendingPairings, shortId),
      count: pendingPairings.length,
    };
  }
  return { kind: "hidden" };
}

export function formatPendingPairingsBannerLabel(
  requests,
  shortId = (value) => String(value || "")
) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return "";
  }
  const head = requests[0];
  const headLabel = head.label || shortId(head.device_id);
  if (requests.length === 1) {
    return `Device "${headLabel}" wants to pair`;
  }
  const extra = requests.length - 1;
  const noun = extra === 1 ? "device" : "devices";
  return `Device "${headLabel}" wants to pair, and ${extra} more ${noun}`;
}
