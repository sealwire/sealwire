// Pure helpers for the merged #client-log surface.
//
// The client log shows TWO sources interleaved: client-originated status lines
// (logged via `logLine` — "Prompt failed: ...", "Sending prompt", etc.) and the
// relay's server logs (refreshed from each session snapshot). These used to
// clobber each other (last writer won), so client lines vanished on the next
// snapshot. Merging keeps both visible. Kept dependency-free so the merge
// behavior can be unit-tested without React/DOM.

export const CLIENT_LOG_LIMIT = 400;

// Map the relay's server log entries (`{ created_at, kind, message }`) into the
// internal `{ at, text }` shape. `created_at` is in seconds; entries without a
// finite timestamp sort to the bottom (at: 0).
export function mapRelayLogEntries(entries) {
  return (entries || []).map((entry) => ({
    at: Number.isFinite(entry?.created_at) ? entry.created_at * 1000 : 0,
    text: `[${entry?.kind}] ${entry?.message ?? ""}`,
  }));
}

// Merge client + relay log entries into one newest-first list, capped at `limit`.
// Both inputs are arrays of `{ at, text }` (at = epoch ms). Sorting by `at`
// descending interleaves the two sources by time; the cap keeps the surface
// bounded. Inputs are not mutated.
export function mergeLogEntries(clientLogLines, relayLogLines, limit = CLIENT_LOG_LIMIT) {
  return [...(clientLogLines || []), ...(relayLogLines || [])]
    .sort((left, right) => right.at - left.at)
    .slice(0, limit);
}
