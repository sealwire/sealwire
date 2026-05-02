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
  error = null,
  expandedGroupCwds = new Set(),
  filterValue = "",
  loading = false,
  selectedCwd = "",
} = {}) {
  return {
    collapsedGroupCwds: copyCwdSet(collapsedGroupCwds),
    error,
    expandedGroupCwds: copyCwdSet(expandedGroupCwds),
    filterValue,
    loading: Boolean(loading),
    selectedCwd,
  };
}

export function setThreadListSelectedCwd(threadList, cwd) {
  return {
    ...threadList,
    selectedCwd: cwd || "",
  };
}

export function setThreadListFilterValue(threadList, value) {
  return {
    ...threadList,
    filterValue: value || "",
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
    error: message || "Failed to load threads",
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

export function createThreadListRows({
  collapsedGroupCwds = new Set(),
  collapsible = false,
  expandedGroupCwds = new Set(),
  groups = [],
  visibleThreadLimit = 10,
} = {}) {
  const rows = [];

  for (const group of groups || []) {
    const normalizedCwd = canonicalizeWorkspace(group.cwd);
    const isCollapsed = collapsible && collapsedGroupCwds.has(normalizedCwd);
    const allThreads = group.threads || [];
    const showAll = expandedGroupCwds.has(normalizedCwd);
    const visibleThreads = showAll ? allThreads : allThreads.slice(0, visibleThreadLimit);
    const hiddenCount = allThreads.length - visibleThreads.length;

    rows.push({
      group,
      isCollapsed,
      key: `group:${normalizedCwd}`,
      normalizedCwd,
      type: "group",
    });

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
