// THE one way client code names a transcript row.
//
// Today a row's identity is `item_id`. The planned identity split gives rows a
// relay-owned `row_id` with `item_id` demoted to provider addressing — and every
// algorithm that read `item_id` directly would need rewriting then. Route every
// key read (React keys, dedupe, window maps, scroll anchors) through here and
// that migration becomes this file.
export function transcriptRowKey(entry) {
  return entry?.row_id ?? entry?.item_id ?? entry?.id ?? null;
}
