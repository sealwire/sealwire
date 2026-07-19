// Single source of truth for "does this provider status mean a turn is in
// flight?" — the frontend mirror of `thread_status_is_working` (state/relay.rs).
//
// This exists because the rule had drifted into four independent copies
// (thread-attention, review-state, fork-fields, and the backend), each with its
// own set literal and its own normalization — or none. Codex's camelCase
// `notLoaded` exposed that: it was added to one set that compared raw strings,
// so the fix was cosmetic and saved Codex threads still read as working.
//
// Providers do not agree on an idle word, and the vocabulary is provider
// FORMATTING, not semantics:
//   • Claude hardcodes `idle`
//   • Codex passes through its own `status.type`: `notLoaded` for a saved
//     thread the app-server has not opened, and a `thread/list` summary with no
//     live status parses to `unknown`
// Classifying any of those as working freezes UI affordances (Stop / Take-over /
// Request review / Fork) that the backend then rejects.
//
// The BACKEND is authoritative; this gate only governs affordances. A mismatch
// would at worst enable a control the server refuses — never the reverse — so
// when in doubt this set should grow, not shrink.
const NON_WORKING_STATUSES = new Set([
  "",
  "idle",
  "viewing",
  "completed",
  "unknown",
  "notloaded",
]);

export function normalizeThreadStatus(status) {
  return String(status ?? "").trim().toLowerCase();
}

export function isWorkingThreadStatus(status) {
  return !NON_WORKING_STATUSES.has(normalizeThreadStatus(status));
}

// Exported for the parity test that pins every frontend predicate to this list.
export const NON_WORKING_THREAD_STATUSES = Object.freeze([...NON_WORKING_STATUSES]);
