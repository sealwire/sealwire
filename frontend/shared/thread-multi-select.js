// Multi-select over the session list — the Finder/VS Code gesture set, as pure
// functions of a selection and the flattened row order, so the rules are testable
// without a DOM and the shell only has to store what comes back.

// The read fallback for a surface that holds no selection. Same contract as the
// other shared empty constants: a stable identity, never written through.
export const EMPTY_THREAD_SELECTION = Object.freeze({ ids: new Set(), anchorId: null });

const MAX_CONFIRM_TITLES = 10;

export function createThreadSelection() {
  return { ids: new Set(), anchorId: null };
}

/**
 * What a click on a row MEANS: open the session, toggle it into the selection,
 * or extend a range from the anchor.
 *
 * Ctrl is a toggle everywhere EXCEPT Apple platforms, where ctrl+click is itself
 * the right-click: honouring it would flip the row's selection underneath the
 * context menu that same gesture opens.
 */
export function threadSelectionIntent(event, { applePlatform = false } = {}) {
  if (!event) return "open";
  if (event.shiftKey) return "range";
  if (event.metaKey) return "toggle";
  if (event.ctrlKey && !applePlatform) return "toggle";
  return "open";
}

function rangeBetween(orderedThreadIds, fromId, toId) {
  const from = orderedThreadIds.indexOf(fromId);
  const to = orderedThreadIds.indexOf(toId);
  if (from < 0 || to < 0) return null;
  const [start, end] = from <= to ? [from, to] : [to, from];
  return new Set(orderedThreadIds.slice(start, end + 1));
}

/**
 * Fold a click into the selection. Returns the next selection and whether the
 * click should still open the session — only a plain click does.
 */
export function applyThreadSelectionClick({
  selection = EMPTY_THREAD_SELECTION,
  threadId,
  orderedThreadIds = [],
  intent = "open",
} = {}) {
  if (!threadId) {
    return { selection, open: false };
  }

  if (intent === "range") {
    // The anchor stays put, so a second shift+click re-ranges from the same
    // origin instead of growing the range one row per click.
    const range = selection.anchorId
      ? rangeBetween(orderedThreadIds, selection.anchorId, threadId)
      : null;
    return range
      ? { selection: { ids: range, anchorId: selection.anchorId }, open: false }
      : { selection: { ids: new Set([threadId]), anchorId: threadId }, open: false };
  }

  if (intent === "toggle") {
    const ids = new Set(selection.ids);
    if (ids.has(threadId)) {
      ids.delete(threadId);
    } else {
      ids.add(threadId);
    }
    return { selection: { ids, anchorId: threadId }, open: false };
  }

  // A plain click still records the anchor, so shift+click straight afterwards
  // ranges from the row the user just opened.
  return { selection: { ids: new Set(), anchorId: threadId }, open: true };
}

/**
 * Drop ids whose sessions are no longer in the list — after a delete, a refresh,
 * or a filter change. Returns the SAME object when nothing changed, because the
 * shells feed this straight back into React.
 */
export function pruneThreadSelection(selection = EMPTY_THREAD_SELECTION, liveThreadIds = []) {
  const live = liveThreadIds instanceof Set ? liveThreadIds : new Set(liveThreadIds);
  const kept = [...selection.ids].filter((id) => live.has(id));
  const anchorId = selection.anchorId && live.has(selection.anchorId) ? selection.anchorId : null;
  if (kept.length === selection.ids.size && anchorId === selection.anchorId) {
    return selection;
  }
  return { ids: new Set(kept), anchorId };
}

/**
 * Which sessions a right-click acts on, and the selection to keep while the menu
 * is open. Right-clicking inside a multi-selection targets the whole batch;
 * right-clicking outside it drops the selection and targets that one row.
 */
export function resolveContextMenuTargets({
  selection = EMPTY_THREAD_SELECTION,
  threadId,
  orderedThreadIds = [],
} = {}) {
  if (!threadId) {
    return { threadIds: [], selection };
  }
  if (selection.ids.size > 1 && selection.ids.has(threadId)) {
    return {
      // List order, not click order: the confirm reads top-to-bottom the way the
      // sidebar does.
      threadIds: orderedThreadIds.filter((id) => selection.ids.has(id)),
      selection,
    };
  }
  return { threadIds: [threadId], selection: { ids: new Set(), anchorId: threadId } };
}

/** The confirm text for a batch delete. */
export function describeBulkDelete({ titles = [] } = {}) {
  const shown = titles.slice(0, MAX_CONFIRM_TITLES);
  const hidden = titles.length - shown.length;
  const lines = shown.map((title) => `• ${title}`);
  // Truncated so the batch cannot push the warning below off the bottom of the
  // dialog, which is the one line that has to be read.
  if (hidden > 0) {
    lines.push(`…and ${hidden} more`);
  }
  return (
    `Permanently delete ${titles.length} sessions?\n\n${lines.join("\n")}\n\n` +
    "This removes each local session file and related local index/state entries. " +
    "This cannot be undone."
  );
}
