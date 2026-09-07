// A half-finished answer lives OUT here, not in the card that shows it.
//
// The card is a transcript row: it is rebuilt whenever the pending list blinks,
// and unmounted whenever virtualization scrolls it away. Keeping the reader's
// picks inside it means any of that silently forgets what they clicked, with no
// error and nothing to retry. Keyed by request id, which is unique per question,
// so a draft can never be shown against a different one.
const drafts = new Map();
// Only ever a handful are live at once; the cap is a leak stop, not a policy.
const MAX_DRAFTS = 16;

export function readAskUserDraft(requestId) {
  return (requestId && drafts.get(requestId)) || null;
}

export function writeAskUserDraft(requestId, draft) {
  if (!requestId) {
    return;
  }
  // Re-insert so iteration order is least-recently-written first.
  drafts.delete(requestId);
  drafts.set(requestId, draft);
  while (drafts.size > MAX_DRAFTS) {
    drafts.delete(drafts.keys().next().value);
  }
}

export function resetAskUserDraftsForTest() {
  drafts.clear();
}
