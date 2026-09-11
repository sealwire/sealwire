// Shared primitive for reconciling a fetched AUTHORITATIVE bounded-tail page
// against whatever is already visible. Local (the hydration window,
// transcript-hydration-store.js) and Remote (session-ops.js) each fetch this
// same shape of thing — a bounded tail page — and used to hand-roll their own
// reconciliation. This is the one implementation of that policy; see
// .sealwire/PLAN.md.
//
// Pure: takes an id order + id->entry lookup, returns the next ones. No
// `state`, no DOM, no fetch, and none of its inputs are mutated.

import { transcriptRowKey } from "./transcript-row-key.js";
import {
  mergeWindowRowsInPlace,
  rowsAreOrderKeyed,
  windowIsOrderKeyed,
} from "./transcript-window-reducer.js";

/**
 * @param {object} input
 * @param {string[]} input.order - item_ids currently visible, in order.
 * @param {Map<string, object>} input.entries - id -> entry lookup for `order`.
 * @param {object[]} input.pageEntries - the fetched page's entries (page.entries).
 * @param {number|null} [input.currentRevision]
 * @param {number|null} [input.pageRevision]
 * @param {number|null} [input.targetRevision]
 * @param {string|null} [input.prevCursor] - page.prev_cursor.
 * @param {(existing: object|undefined, incoming: object) => object} [input.mergeEntry] -
 *   defaults to a never-shorten text overlay (see `defaultMergeEntry`).
 * @returns {{order: string[], entries: Map<string, object>, repaired: object[],
 *   revision: number|null, truncated: boolean, olderCursor: string|null}}
 */
export function reconcileAuthoritativeTail({
  order,
  entries,
  pageEntries,
  currentRevision = null,
  pageRevision = null,
  targetRevision = null,
  prevCursor = null,
  mergeEntry = defaultMergeEntry,
}) {
  const addressable = (pageEntries || []).filter((entry) => entry?.item_id);
  const revision = maxRevision(currentRevision, pageRevision, targetRevision);
  const tail = {
    revision,
    truncated: prevCursor != null,
    olderCursor: prevCursor ?? null,
  };

  // Numbered on both sides: place by number. mergeTailPageOrder below can only
  // split the window at the page's first known id, so it has no answer for a
  // live row whose number falls BETWEEN two page rows, and none at all when the
  // page and window share no id — there it has to guess which side the window
  // sits on. The caller's own mergeEntry still decides CONTENT either way.
  if (rowsAreOrderKeyed(addressable) && windowIsOrderKeyed(order, entries)) {
    const draft = { order: [...order], entries: new Map(entries) };
    mergeWindowRowsInPlace(draft, addressable, { mergeRow: mergeEntry });
    return {
      ...tail,
      order: draft.order,
      entries: draft.entries,
      repaired: addressable
        .map((entry) => draft.entries.get(transcriptRowKey(entry)))
        .filter(Boolean),
    };
  }

  const nextEntries = new Map(entries);
  const pageItemIds = [];
  const repaired = [];

  for (const entry of addressable) {
    // Entries with no item_id are dropped above: the page cannot be
    // authoritative for something it cannot name.
    const itemId = entry.item_id;
    const merged = mergeEntry(nextEntries.get(itemId), entry);
    nextEntries.set(itemId, merged);
    pageItemIds.push(itemId);
    repaired.push(merged);
  }

  return {
    ...tail,
    order: mergeTailPageOrder(order, pageItemIds),
    entries: nextEntries,
    repaired,
  };
}

// The default overlay when a caller has no richer merge rules of its own
// (Remote's repair — Local always passes its own mergeTranscriptEntry, which
// has additional rules — tool view, turn_id, content_state rank — that stay
// Local-only). The page is authoritative, but never let an unexpectedly short
// page entry shorten already-visible text.
function defaultMergeEntry(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  return {
    ...existing,
    ...incoming,
    text: selectTranscriptText(existing.text, incoming.text),
    // Absorbing: a copy serialized before the withdrawal must not resurrect the row.
    ...(existing.withdrawn === true || incoming.withdrawn === true ? { withdrawn: true } : {}),
  };
}

function maxRevision(...values) {
  const known = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return known.length ? Math.max(...known) : null;
}

// Splice a TAIL page's ids into the window's order instead of replacing it.
//
// A tail page is authoritative for the ids it carries and for their relative
// order — but it is NOT the whole window. Older pages the reader scrolled in sit
// above it, and an id a live SSE delta appended after the page was built sits
// below it. Replacing `order` with the page's ids therefore ORPHANED those:
// still present in `entries`, never rendered again, and unrecoverable, because
// both re-add sites only fire for ids that are new to `entries`.
//
// Everything in the window before the page's first known id stays above the
// page; everything after it stays below. O(window), which is fine here — a page
// merge is user-paced (cold hydration / scroll-up) and already copies the map;
// it is the per-SNAPSHOT path that must stay proportional to the tail.
export function mergeTailPageOrder(existingOrder, pageItemIds) {
  if (!existingOrder?.length) {
    return uniqueItemIds(pageItemIds);
  }
  const pageIds = new Set(pageItemIds);
  const above = [];
  const below = [];
  let reachedPage = false;
  for (const itemId of existingOrder) {
    if (pageIds.has(itemId)) {
      reachedPage = true;
      continue;
    }
    (reachedPage ? below : above).push(itemId);
  }
  if (!reachedPage) {
    // Nothing in the window is in the page, so there is no split point. The
    // window cannot be OLDER than a tail page it does not intersect — older
    // pages are only ever prepended onto a window that already holds the tail —
    // so whatever is here is NEWER: a live delta that landed before this page
    // did (a just-cleared window on a thread switch can hold nothing else).
    // Keep it below the page rather than stranding it above.
    return uniqueItemIds([...pageItemIds, ...above]);
  }
  return uniqueItemIds([...above, ...pageItemIds, ...below]);
}

// The never-shorten text rule: an authoritative (but possibly stale/partial)
// incoming body must never regress already-visible text. `existingFull` /
// `incomingFull` let a richer caller (Local's mergeTranscriptEntry) fold in
// its own preview/omitted content-state ranking; callers with no such notion
// (Remote's default overlay above) leave both at their default `true`, which
// collapses this to a pure length comparison.
export function selectTranscriptText(existingText, incomingText, existingFull = true, incomingFull = true) {
  if (incomingText == null) {
    return existingText ?? null;
  }
  if (existingText == null) {
    return incomingText;
  }
  // Keep a cached full body over a non-authoritative (preview) incoming body ONLY
  // when our cache is at least as long — i.e. genuinely more complete. A stale
  // partial cache is SHORTER than the grown preview the server now ships, so the
  // longer one must win (otherwise the entry freezes on the partial). No
  // "..."-suffix inference; fullness comes from content_state and length.
  if (existingFull && !incomingFull && existingText.length >= incomingText.length) {
    return existingText;
  }
  return incomingText.length >= existingText.length ? incomingText : existingText;
}

export function uniqueItemIds(itemIds) {
  const seen = new Set();
  const unique = [];
  for (const itemId of itemIds) {
    if (!itemId || seen.has(itemId)) {
      continue;
    }
    seen.add(itemId);
    unique.push(itemId);
  }
  return unique;
}
