import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import {
  Virtualizer,
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/virtual-core";
import { canonicalizeWorkspace } from "./thread-groups.js";
import { createThreadListRows } from "./thread-list-state.js";

const h = React.createElement;
const VISIBLE_THREAD_LIMIT = 10;
const VIRTUAL_OVERSCAN = 8;

function shortId(value) {
  return value ? String(value).slice(0, 8) : "unknown";
}

export function ThreadGroupList({
  activeThreadId = null,
  collapsedGroupCwds = new Set(),
  collapsible = false,
  emptyMessage = "No saved threads yet.",
  expandedGroupCwds = new Set(),
  formatThreadMeta = (thread) => thread.updated_at || "",
  groups = [],
  includePreview = false,
  onContextThread = null,
  onResumeThread = null,
  onSelectWorkspace = null,
  onToggleExpandedGroup = null,
  onToggleGroup = null,
  previewFallback = "No preview yet.",
  selectedCwd = "",
  virtualized = false,
}) {
  if (!groups.length) {
    return h("p", { className: "sidebar-empty" }, emptyMessage);
  }

  const normalizedSelectedCwd = canonicalizeWorkspace(selectedCwd);

  if (virtualized) {
    return h(VirtualThreadGroupList, {
      activeThreadId,
      collapsedGroupCwds,
      collapsible,
      expandedGroupCwds,
      formatThreadMeta,
      groups,
      includePreview,
      normalizedSelectedCwd,
      onContextThread,
      onResumeThread,
      onSelectWorkspace,
      onToggleExpandedGroup,
      onToggleGroup,
      previewFallback,
    });
  }

  return h(
    React.Fragment,
    null,
    ...groups.map((group) => {
      const normalizedCwd = canonicalizeWorkspace(group.cwd);
      const isCollapsed = collapsible && collapsedGroupCwds.has(normalizedCwd);
      const isSelected = normalizedSelectedCwd && normalizedCwd === normalizedSelectedCwd;
      const allThreads = group.threads || [];
      const showAll = expandedGroupCwds.has(normalizedCwd);
      const visibleThreads = showAll ? allThreads : allThreads.slice(0, VISIBLE_THREAD_LIMIT);
      const hiddenCount = allThreads.length - visibleThreads.length;

      return h(
        "section",
        {
          className: `thread-group${isSelected ? " is-selected-workspace" : ""}${isCollapsed ? " is-collapsed" : ""}`,
          "data-thread-group-cwd": group.cwd,
          key: group.cwd,
        },
        h(ThreadGroupHeader, {
          collapsible,
          group,
          isCollapsed,
          normalizedCwd,
          onSelectWorkspace,
          onToggleGroup,
        }),
        h(
          "div",
          {
            className: "thread-group-list",
            hidden: isCollapsed,
          },
          ...visibleThreads.map((thread) =>
            h(ThreadGroupItem, {
              active: activeThreadId === thread.id,
              formatThreadMeta,
              group,
              includePreview,
              key: thread.id,
              onContextThread,
              onResumeThread,
              previewFallback,
              thread,
            })
          ),
          hiddenCount > 0
            ? h(
                "button",
                {
                  className: "thread-group-show-more",
                  onClick: () => onToggleExpandedGroup?.(normalizedCwd),
                  type: "button",
                },
                `Show ${hiddenCount} more`
              )
            : null,
          showAll && allThreads.length > VISIBLE_THREAD_LIMIT
            ? h(
                "button",
                {
                  className: "thread-group-show-more",
                  onClick: () => onToggleExpandedGroup?.(normalizedCwd),
                  type: "button",
                },
                "Show less"
              )
            : null
        )
      );
    })
  );
}

function VirtualThreadGroupList({
  activeThreadId,
  collapsedGroupCwds,
  collapsible,
  expandedGroupCwds,
  formatThreadMeta,
  groups,
  includePreview,
  normalizedSelectedCwd,
  onContextThread,
  onResumeThread,
  onSelectWorkspace,
  onToggleExpandedGroup,
  onToggleGroup,
  previewFallback,
}) {
  const rows = useMemo(
    () =>
      createThreadListRows({
        collapsedGroupCwds,
        collapsible,
        expandedGroupCwds,
        groups,
        visibleThreadLimit: VISIBLE_THREAD_LIMIT,
      }),
    [collapsedGroupCwds, collapsible, expandedGroupCwds, groups]
  );
  const virtualizer = useThreadListVirtualizer(rows);
  const virtualRows = virtualizer.getVirtualItems();

  return h(
    "div",
    { className: "thread-list-virtual-root", ref: virtualizer.scrollTargetRef },
    h(
      "div",
      {
        className: "thread-list-virtual-spacer",
        style: {
          height: `${virtualizer.getTotalSize()}px`,
        },
      },
      ...virtualRows.map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) {
          return null;
        }

        return h(
          "div",
          {
            className: "thread-list-virtual-row",
            "data-index": virtualRow.index,
            "data-row-type": row.type,
            key: row.key,
            ref: virtualizer.measureElement,
            style: {
              transform: `translateY(${virtualRow.start}px)`,
            },
          },
          h(ThreadListRow, {
            activeThreadId,
            formatThreadMeta,
            includePreview,
            normalizedSelectedCwd,
            onContextThread,
            onResumeThread,
            onSelectWorkspace,
            onToggleExpandedGroup,
            onToggleGroup,
            previewFallback,
            row,
          })
        );
      })
    )
  );
}

function ThreadListRow({
  activeThreadId,
  formatThreadMeta,
  includePreview,
  normalizedSelectedCwd,
  onContextThread,
  onResumeThread,
  onSelectWorkspace,
  onToggleExpandedGroup,
  onToggleGroup,
  previewFallback,
  row,
}) {
  if (row.type === "group") {
    const isSelected = normalizedSelectedCwd && row.normalizedCwd === normalizedSelectedCwd;
    return h(
      "section",
      {
        className: `thread-group${isSelected ? " is-selected-workspace" : ""}${row.isCollapsed ? " is-collapsed" : ""}`,
        "data-thread-group-cwd": row.group.cwd,
      },
      h(ThreadGroupHeader, {
        collapsible: Boolean(onToggleGroup),
        group: row.group,
        isCollapsed: row.isCollapsed,
        normalizedCwd: row.normalizedCwd,
        onSelectWorkspace,
        onToggleGroup,
      })
    );
  }

  if (row.type === "thread") {
    return h(ThreadGroupItem, {
      active: activeThreadId === row.thread.id,
      formatThreadMeta,
      group: row.group,
      includePreview,
      onContextThread,
      onResumeThread,
      previewFallback,
      thread: row.thread,
    });
  }

  return h(
    "button",
    {
      className: "thread-group-show-more",
      onClick: () => onToggleExpandedGroup?.(row.normalizedCwd),
      type: "button",
    },
    row.type === "show-more" ? `Show ${row.hiddenCount} more` : "Show less"
  );
}

function useThreadListVirtualizer(rows) {
  const scrollTargetRef = useRef(null);
  const [, forceUpdate] = useReducer((value) => value + 1, 0);
  const virtualizerRef = useRef(null);

  if (!virtualizerRef.current) {
    virtualizerRef.current = new Virtualizer({
      count: rows.length,
      estimateSize: () => 40,
      getScrollElement: () => findScrollElement(scrollTargetRef.current),
      observeElementOffset,
      observeElementRect,
      overscan: VIRTUAL_OVERSCAN,
      scrollToFn: elementScroll,
      onChange: () => forceUpdate(),
    });
  }

  const getItemKey = useCallback((index) => rows[index]?.key || index, [rows]);
  const estimateSize = useCallback((index) => {
    const row = rows[index];
    if (row?.type === "group") {
      return 34;
    }
    if (row?.type === "show-more" || row?.type === "show-less") {
      return 30;
    }
    return row?.group?.threads?.length && row.group.threads.length > 0 ? 38 : 36;
  }, [rows]);

  virtualizerRef.current.setOptions({
    count: rows.length,
    estimateSize,
    getItemKey,
    getScrollElement: () => findScrollElement(scrollTargetRef.current),
    measureElement,
    observeElementOffset,
    observeElementRect,
    overscan: VIRTUAL_OVERSCAN,
    scrollToFn: elementScroll,
    onChange: () => forceUpdate(),
  });

  useLayoutEffect(() => {
    const virtualizer = virtualizerRef.current;
    const cleanup = virtualizer._didMount();
    virtualizer._willUpdate();
    forceUpdate();
    return cleanup;
  }, []);

  useLayoutEffect(() => {
    virtualizerRef.current._willUpdate();
  });

  return {
    getTotalSize: () => virtualizerRef.current.getTotalSize(),
    getVirtualItems: () => virtualizerRef.current.getVirtualItems(),
    measureElement: virtualizerRef.current.measureElement,
    scrollTargetRef,
  };
}

function findScrollElement(node) {
  let current = node?.parentElement || null;
  while (current) {
    const overflowY = current.ownerDocument.defaultView
      ?.getComputedStyle(current)
      ?.overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }
    current = current.parentElement;
  }
  return node?.parentElement || null;
}

function ThreadGroupHeader({
  collapsible,
  group,
  isCollapsed,
  normalizedCwd,
  onSelectWorkspace,
  onToggleGroup,
}) {
  if (collapsible) {
    return h(
      "button",
      {
        "aria-expanded": isCollapsed ? "false" : "true",
        className: "thread-group-header",
        onClick: () => onToggleGroup?.(normalizedCwd),
        title: group.cwd,
        type: "button",
      },
      h("span", { "aria-hidden": "true", className: "thread-group-icon" }),
      h("span", { className: "thread-group-name" }, group.label),
      h("span", { "aria-hidden": "true", className: "thread-group-chevron" })
    );
  }

  if (onSelectWorkspace) {
    return h(
      "button",
      {
        className: "thread-group-header",
        "data-select-workspace": group.cwd,
        onClick: () => onSelectWorkspace(group.cwd),
        title: group.cwd,
        type: "button",
      },
      h("span", { "aria-hidden": "true", className: "thread-group-icon" }),
      h("span", { className: "thread-group-name" }, group.label)
    );
  }

  return h(
    "div",
    {
      className: "thread-group-header thread-group-header-static",
      title: group.cwd,
    },
    h("span", { "aria-hidden": "true", className: "thread-group-icon" }),
    h("span", { className: "thread-group-name" }, group.label)
  );
}

function ThreadGroupItem({
  active,
  formatThreadMeta,
  group,
  includePreview,
  onContextThread,
  onResumeThread,
  previewFallback,
  thread,
}) {
  const title = thread.name || thread.preview || shortId(thread.id);

  return h(
    "button",
    {
      className: `conversation-item${active ? " is-active" : ""}`,
      "data-thread-cwd": group.cwd,
      "data-thread-id": thread.id,
      "data-thread-title": title,
      onClick: () => onResumeThread?.(thread.id),
      onContextMenu: onContextThread
        ? (event) => {
            event.preventDefault();
            onContextThread(thread.id, event.clientX, event.clientY);
          }
        : undefined,
      title,
      type: "button",
    },
    h("span", { className: "conversation-title" }, title),
    includePreview
      ? h("span", { className: "conversation-preview" }, thread.preview || previewFallback)
      : null,
    h("span", { className: "conversation-meta" }, formatThreadMeta(thread))
  );
}
