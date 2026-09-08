// A half-finished answer lives OUT here, not in the card that shows it.
//
// The card is rebuilt whenever the pending list blinks and unmounted whenever
// virtualization scrolls it away; keeping the reader's picks inside it means any
// of that silently forgets what they clicked, with no error and nothing to retry.
const drafts = new Map();
// Only ever a handful are live at once; the cap is a leak stop, not a policy.
const MAX_DRAFTS = 16;

/// Thread AND request, because a request id is only unique within one provider
/// session: the Claude worker numbers them per session ("ask:1", "ask:2", …), so
/// a second relay hands out the same id for an unrelated question — and a draft
/// keyed on the id alone would open that question halfway through someone else's
/// answer.
export function askUserDraftKey(threadId, requestId) {
  return requestId ? `${threadId || "-"}::${requestId}` : "";
}

export function readAskUserDraft(key) {
  return (key && drafts.get(key)) || null;
}

export function writeAskUserDraft(key, draft) {
  if (!key) {
    return;
  }
  // Re-insert so iteration order is least-recently-written first.
  drafts.delete(key);
  drafts.set(key, draft);
  while (drafts.size > MAX_DRAFTS) {
    drafts.delete(drafts.keys().next().value);
  }
}

/// Drop every draft whose question is no longer pending — answered, cancelled,
/// or belonging to a thread the reader has left. Without this the map only ever
/// grows, and the cap starts evicting the draft the reader is still typing into
/// rather than the dead ones.
export function retainAskUserDrafts(keys) {
  const live = new Set(keys || []);
  for (const key of [...drafts.keys()]) {
    if (!live.has(key)) {
      drafts.delete(key);
    }
  }
}

/// Retention follows the RELAY's pending list — every thread's, not the one on
/// screen. Pruning by what is visible would discard a half-written answer for
/// the sin of looking at another conversation for a moment.
export function retainAskUserDraftsForPending(pendingRequests) {
  retainAskUserDrafts(
    (Array.isArray(pendingRequests) ? pendingRequests : [])
      .map((request) => askUserDraftKey(request?.thread_id, request?.request_id))
      .filter(Boolean)
  );
}

export function resetAskUserDraftsForTest() {
  drafts.clear();
}
