import { canonicalizeWorkspace } from "./thread-groups.js";

function copyCwdSet(values) {
  return new Set([...(values || [])].map((cwd) => canonicalizeWorkspace(cwd)).filter(Boolean));
}

function toggleCwd(values, cwd) {
  const normalized = canonicalizeWorkspace(cwd);
  const next = copyCwdSet(values);
  if (!normalized) {
    return next;
  }

  if (next.has(normalized)) {
    next.delete(normalized);
  } else {
    next.add(normalized);
  }
  return next;
}

export function createThreadListUiState({
  collapsedGroupCwds = new Set(),
  drawerOpen = false,
  error = null,
  expandedGroupCwds = new Set(),
  loading = false,
  selectedCwd = "",
} = {}) {
  return {
    collapsedGroupCwds: copyCwdSet(collapsedGroupCwds),
    drawerOpen: Boolean(drawerOpen),
    error,
    expandedGroupCwds: copyCwdSet(expandedGroupCwds),
    loading: Boolean(loading),
    selectedCwd,
  };
}

export function setThreadListDrawerOpen(threadList, open) {
  return {
    ...threadList,
    drawerOpen: Boolean(open),
  };
}

export function setThreadListSelectedCwd(threadList, cwd) {
  return {
    ...threadList,
    selectedCwd: cwd || "",
  };
}

export function toggleThreadListCollapsedGroup(threadList, cwd) {
  return {
    ...threadList,
    collapsedGroupCwds: toggleCwd(threadList?.collapsedGroupCwds, cwd),
  };
}

export function toggleThreadListExpandedGroup(threadList, cwd) {
  return {
    ...threadList,
    expandedGroupCwds: toggleCwd(threadList?.expandedGroupCwds, cwd),
  };
}

export function startThreadListRefresh(threadList) {
  return {
    ...threadList,
    error: null,
    loading: true,
  };
}

export function finishThreadListRefresh(threadList) {
  return {
    ...threadList,
    loading: false,
  };
}

export function failThreadListRefresh(threadList, message) {
  return {
    ...threadList,
    error: message || "Failed to load sessions",
    loading: false,
  };
}

export function clearThreadListError(threadList) {
  return {
    ...threadList,
    error: null,
  };
}

export function shouldRenderThreadListLoadingPlaceholder(threadList, groups = [], threads = []) {
  return Boolean(threadList?.loading && !groups?.length && !threads?.length);
}

/**
 * The ids of the session rows the list actually renders, in render order.
 *
 * Derived from the rows rather than the DOM because the list is virtualized: a
 * shift+click range has to span sessions that are scrolled out of view and so are
 * not in the document at all.
 */
export function visibleThreadIds(rows) {
  return (rows || []).filter((row) => row.type === "thread").map((row) => row.thread.id);
}

export function createThreadListRows({
  collapsedGroupCwds = new Set(),
  collapsible = false,
  expandedGroupCwds = new Set(),
  groups = [],
  // Drop the PINNED group's header row entirely. The surface that pins is the surface
  // that names the pin somewhere else — remote shows a quiet chip above the list — so
  // the header would be a row whose only content is a string already on screen.
  //
  // Dropped HERE rather than hidden in CSS: the list is virtualized and measures every
  // row it emits, so a `display: none` header still reserves its height and leaves a
  // gap that looks like a rendering fault.
  hidePinnedGroupHeader = false,
  visibleThreadLimit = 10,
} = {}) {
  const rows = [];

  for (const group of groups || []) {
    // Neutral group key: the canonical cwd in cwd mode, or the project id /
    // "__unassigned__" sentinel in project mode. Collapse/expand Sets + row keys
    // are keyed on this uniformly (kept under the `normalizedCwd` field name so the
    // existing toggle handlers keep working — canonicalize is a no-op on ids).
    const normalizedCwd = canonicalizeWorkspace(group.key ?? group.cwd);
    const headerless = hidePinnedGroupHeader && Boolean(group.pinned);
    // A headerless group can never be folded. The disclosure control lives ON the
    // header, so a collapsed one would hide its sessions with nothing left on screen
    // to reopen it — and the collapsed set survives reloads, so it would stay that way.
    const isCollapsed =
      !headerless && collapsible && collapsedGroupCwds.has(normalizedCwd);
    const allThreads = group.threads || [];
    const showAll = expandedGroupCwds.has(normalizedCwd);
    const visibleThreads = showAll ? allThreads : allThreads.slice(0, visibleThreadLimit);
    const hiddenCount = allThreads.length - visibleThreads.length;

    if (!headerless) {
      rows.push({
        group,
        isCollapsed,
        key: `group:${normalizedCwd}`,
        normalizedCwd,
        type: "group",
      });
    }

    if (isCollapsed) {
      continue;
    }

    visibleThreads.forEach((thread) => {
      rows.push({
        group,
        key: `thread:${thread.id}`,
        normalizedCwd,
        thread,
        type: "thread",
      });
    });

    if (hiddenCount > 0) {
      rows.push({
        group,
        hiddenCount,
        key: `show-more:${normalizedCwd}`,
        normalizedCwd,
        type: "show-more",
      });
    }

    if (showAll && allThreads.length > visibleThreadLimit) {
      rows.push({
        group,
        key: `show-less:${normalizedCwd}`,
        normalizedCwd,
        type: "show-less",
      });
    }
  }

  return rows;
}
