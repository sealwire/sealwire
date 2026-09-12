// THE one way client code names a transcript row.
//
// A row's identity is `row_id`: relay-owned, minted once, never changed, and
// valid within the run named by `transcript_generation`. It is the only thing a
// client may key on — React keys, dedupe, window and cache maps, scroll anchors,
// detail and fork targets.
//
// `item_id` is a COMPATIBILITY alias. The relay sends it carrying the same value
// as `row_id` on every row it ships, so a client built before `row_id` existed
// keeps working; reading it here is what keeps a NEW client working against an
// OLD relay that sends only `item_id`. It is never provider-addressable — the
// relay owns translating a row to whatever a provider calls it.
//
// Route every identity read through this. A site that reads `entry.item_id`
// directly is a site that will disagree with one that reads `row_id` the moment
// the two diverge, and two keys for one row means the same message rendered
// twice.
export function transcriptRowKey(entry) {
  return entry?.row_id ?? entry?.item_id ?? entry?.id ?? null;
}
