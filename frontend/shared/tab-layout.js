// Per-project tab workspace model.
//
// A project owns an ordered list of tabs; each tab renders a LAYOUT TREE of
// sessions. Today every tab holds exactly one session (a `leaf`), which is the
// Chrome-style "N open, 1 visible" shape. The tree is modelled from the start so
// that iTerm2-style side-by-side panes can be added later by allowing deeper
// nodes — no stored state has to be migrated when that happens.
//
// This module is pure: every operation takes a workspace and returns a new one.
// It deliberately knows nothing about persistence, React, or the relay — the
// caller decides where the state lives and when it is written.
//
// IMPORTANT: a tab is a VIEW concept. Opening or focusing a tab must never move
// the relay's `active_thread_id`, which is a relay-wide control lease shared by
// every connected client (see the note on `viewThread()` in app.js). Tabs are
// built on the per-client "which thread am I looking at" axis instead.

export const LEAF = "leaf";
export const SPLIT = "split";

export const HORIZONTAL = "h";
export const VERTICAL = "v";

/** A layout node holding a single session. */
export function createLeaf(threadId) {
  return { type: LEAF, threadId: String(threadId || "") };
}

/**
 * A layout node splitting space between children. Unused in the current UI —
 * present so the model and its persisted shape already support panes.
 * `sizes` are fractions parallel to `children`; omitted means "even split".
 */
export function createSplit({ dir = HORIZONTAL, children = [], sizes = null } = {}) {
  return {
    type: SPLIT,
    dir: dir === VERTICAL ? VERTICAL : HORIZONTAL,
    children: [...children],
    sizes: sizes ? [...sizes] : null,
  };
}

/** Every thread id in a layout tree, in visual order. */
export function layoutThreadIds(layout) {
  if (!layout) {
    return [];
  }
  if (layout.type === LEAF) {
    return layout.threadId ? [layout.threadId] : [];
  }
  return (layout.children || []).flatMap((child) => layoutThreadIds(child));
}

export function layoutHasThread(layout, threadId) {
  if (!threadId) {
    return false;
  }
  return layoutThreadIds(layout).includes(threadId);
}

function normalizeTab(tab) {
  const pinned = Boolean(tab?.pinned);
  return {
    id: String(tab?.id || ""),
    pinned,
    // A PREVIEW tab is one the user is only looking at. Browsing the sidebar
    // reuses this single slot instead of appending, so peeking at twenty
    // sessions leaves one tab rather than twenty; a deliberate gesture
    // (double-click, pin, drag, sending a message) promotes it. Same contract as
    // an editor's italic tab.
    //
    // Pinned wins: a pinned tab is by definition kept, so the two can never both
    // be set — including on a workspace rehydrated from storage.
    preview: !pinned && Boolean(tab?.preview),
    layout: tab?.layout || createLeaf(""),
  };
}

/** The workspace's preview tab, if it currently has one. At most one exists. */
export function previewTab(workspace) {
  return (workspace?.tabs || []).find((tab) => tab.preview) || null;
}

// Pinned tabs always sort before unpinned ones (Chrome's pinned zone). Sorting is
// stable within each partition so an explicit reorder is preserved.
function partitionPinned(tabs) {
  const pinned = tabs.filter((tab) => tab.pinned);
  const rest = tabs.filter((tab) => !tab.pinned);
  return [...pinned, ...rest];
}

export function createTabWorkspace({ tabs = [], focusedTabId = null } = {}) {
  const normalized = partitionPinned((tabs || []).map(normalizeTab).filter((tab) => tab.id));
  const focusExists = normalized.some((tab) => tab.id === focusedTabId);
  return {
    tabs: normalized,
    // The focus must always name a tab that exists, or be null when there are
    // none — every consumer can then treat a non-null focus as renderable.
    focusedTabId: focusExists ? focusedTabId : normalized[0]?.id || null,
  };
}

export function findTabByThread(workspace, threadId) {
  if (!threadId) {
    return null;
  }
  return (workspace?.tabs || []).find((tab) => layoutHasThread(tab.layout, threadId)) || null;
}

export function findTab(workspace, tabId) {
  return (workspace?.tabs || []).find((tab) => tab.id === tabId) || null;
}

/** The default id for a tab opened from a single session. */
export function tabIdForThread(threadId) {
  return `tab-${threadId}`;
}

/**
 * Open `threadId`. A session is never opened twice: if some tab already shows it
 * (including inside a split), that tab is focused instead of a duplicate being
 * appended — the same rule a browser applies to "switch to tab".
 *
 * `preview: true` opens it as THE preview tab, replacing whatever was previewed
 * before (in place, so the strip doesn't reshuffle while browsing). It only ever
 * affects a NEW tab: focusing a session that is already open never changes
 * whether its tab is kept, in either direction — promotion is `promoteTab`'s job
 * alone, or the preview slot could never be reused.
 */
export function openThreadTab(workspace, threadId, { tabId = null, preview = false } = {}) {
  const base = createTabWorkspace(workspace);
  if (!threadId) {
    return base;
  }

  const existing = findTabByThread(base, threadId);
  if (existing) {
    return { ...base, focusedTabId: existing.id };
  }

  const tab = normalizeTab({
    id: tabId || tabIdForThread(threadId),
    pinned: false,
    preview,
    layout: createLeaf(threadId),
  });

  const replacing = preview ? base.tabs.findIndex((entry) => entry.preview) : -1;
  if (replacing !== -1) {
    const tabs = [...base.tabs];
    tabs.splice(replacing, 1, tab);
    return { tabs: partitionPinned(tabs), focusedTabId: tab.id };
  }

  // Appended after the pinned partition, never inside it.
  return {
    tabs: partitionPinned([...base.tabs, tab]),
    focusedTabId: tab.id,
  };
}

/**
 * Keep a preview tab: it stops being replaceable and survives the next peek.
 *
 * Deliberately separate from `openThreadTab` so that merely routing to a session
 * — boot, popstate, a re-render's normalization pass — can never promote by
 * accident. Only the gestures that mean "I'm working here" call this.
 */
export function promoteTab(workspace, tabId) {
  const base = createTabWorkspace(workspace);
  const target = findTab(base, tabId);
  if (!target?.preview) {
    return base;
  }
  return {
    ...base,
    tabs: base.tabs.map((tab) => (tab.id === tabId ? { ...tab, preview: false } : tab)),
  };
}

/**
 * Close a tab. Focus moves to the right-hand neighbour, falling back to the left
 * when the closed tab was last — matching browser/terminal behaviour, so closing
 * a run of tabs keeps walking in one direction instead of jumping to the start.
 * Closing a tab only removes it from the workspace; the session itself is
 * untouched.
 */
export function closeTab(workspace, tabId) {
  const base = createTabWorkspace(workspace);
  const index = base.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return base;
  }

  const tabs = base.tabs.filter((tab) => tab.id !== tabId);
  if (base.focusedTabId !== tabId) {
    return { ...base, tabs };
  }

  const nextFocus = tabs[index] || tabs[index - 1] || null;
  return { tabs, focusedTabId: nextFocus?.id || null };
}

export function focusTab(workspace, tabId) {
  const base = createTabWorkspace(workspace);
  return findTab(base, tabId) ? { ...base, focusedTabId: tabId } : base;
}

/**
 * Pin or unpin a tab. Pinning moves it into the pinned zone (and unpinning out of
 * it) via the same stable partition used everywhere else, so the strip never
 * interleaves pinned and unpinned tabs.
 */
export function setTabPinned(workspace, tabId, pinned) {
  const base = createTabWorkspace(workspace);
  if (!findTab(base, tabId)) {
    return base;
  }
  // Through normalizeTab, so pinning also keeps a previewed tab — pinning is one
  // of the "I'm keeping this" gestures.
  const tabs = base.tabs.map((tab) =>
    tab.id === tabId ? normalizeTab({ ...tab, pinned: Boolean(pinned) }) : tab
  );
  return { ...base, tabs: partitionPinned(tabs) };
}

/**
 * Drag-reorder a tab to `toIndex`.
 *
 * The target is clamped to the tab's OWN partition: a pinned tab can only be
 * reordered among pinned tabs and vice versa. Dragging across the boundary is
 * deliberately not a pin/unpin gesture in this version — silently changing pinned
 * state from a drag is surprising, and `setTabPinned` is the explicit affordance.
 */
export function moveTab(workspace, tabId, toIndex) {
  const base = createTabWorkspace(workspace);
  const from = base.tabs.findIndex((tab) => tab.id === tabId);
  if (from === -1) {
    return base;
  }

  // Placing a tab by hand is an "I'm keeping this" gesture too: a preview tab
  // that got dragged into position must not be replaced by the next peek.
  const moving = normalizeTab({ ...base.tabs[from], preview: false });
  const pinnedCount = base.tabs.filter((tab) => tab.pinned).length;
  const lowerBound = moving.pinned ? 0 : pinnedCount;
  const upperBound = moving.pinned ? pinnedCount - 1 : base.tabs.length - 1;
  const target = Math.min(Math.max(Number(toIndex), lowerBound), upperBound);
  if (!Number.isFinite(target) || target === from) {
    return base;
  }

  const tabs = [...base.tabs];
  tabs.splice(from, 1);
  tabs.splice(target, 0, moving);
  return { ...base, tabs };
}

/** The focused tab, or null when the workspace is empty. */
export function focusedTab(workspace) {
  const base = workspace || {};
  return (base.tabs || []).find((tab) => tab.id === base.focusedTabId) || null;
}

/** Thread ids of every open tab, in strip order. Useful for prefetch/retention. */
export function openThreadIds(workspace) {
  return (workspace?.tabs || []).flatMap((tab) => layoutThreadIds(tab.layout));
}

/**
 * Structural equality, for change detection.
 *
 * Reference equality is useless here: every operation normalizes through
 * `createTabWorkspace`, so a no-op still yields a fresh object. Callers that
 * persist or re-render on change need to know whether anything actually moved.
 */
export function sameWorkspace(left, right) {
  if (left === right) {
    return true;
  }
  const a = left || {};
  const b = right || {};
  if ((a.focusedTabId || null) !== (b.focusedTabId || null)) {
    return false;
  }

  const aTabs = a.tabs || [];
  const bTabs = b.tabs || [];
  if (aTabs.length !== bTabs.length) {
    return false;
  }

  return aTabs.every((tab, index) => {
    const other = bTabs[index];
    return (
      tab.id === other.id
      && Boolean(tab.pinned) === Boolean(other.pinned)
      // A peek promoted to a kept tab changes nothing but this flag, and it still
      // has to reach persistence and repaint the tab — so it belongs here.
      && Boolean(tab.preview) === Boolean(other.preview)
      // Layout trees are a handful of nodes; a serialized compare keeps this honest
      // about nested splits without hand-rolling a tree walk.
      && JSON.stringify(tab.layout) === JSON.stringify(other.layout)
    );
  });
}
