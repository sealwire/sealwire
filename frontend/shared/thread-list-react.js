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
import { providerLabel, providerTone } from "./provider-labels.js";
import { selectThreadDot } from "./thread-dot.js";

const h = React.createElement;
const VISIBLE_THREAD_LIMIT = 10;
const VIRTUAL_OVERSCAN = 8;
const THREAD_LIST_SCROLL_ROOT_SELECTOR = "[data-thread-list-scroll-root]";

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
  threadActivity = null,
  threadAttention = null,
}) {
  if (!groups.length) {
    return h("p", { className: "sidebar-empty" }, emptyMessage);
  }

  const normalizedSelectedCwd = canonicalizeWorkspace(selectedCwd);
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
              transform: `translateY(${virtualRow.start - virtualizer.scrollMargin}px)`,
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
            threadActivity,
            threadAttention,
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
  threadActivity,
  threadAttention,
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
      activity: threadActivity?.get?.(row.thread.id) || null,
      attentionKind: threadAttention?.get?.(row.thread.id) || null,
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
  const scrollElement = findScrollElement(scrollTargetRef.current);
  const scrollMargin = measureScrollMargin(scrollTargetRef.current, scrollElement);

  if (!virtualizerRef.current) {
    virtualizerRef.current = new Virtualizer({
      count: rows.length,
      estimateSize: () => 40,
      getScrollElement: () => findScrollElement(scrollTargetRef.current),
      observeElementOffset,
      observeElementRect,
      overscan: VIRTUAL_OVERSCAN,
      scrollMargin,
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
    scrollMargin,
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
    scrollMargin,
    scrollTargetRef,
  };
}

function findScrollElement(node) {
  const markedRoot = findMarkedScrollRoot(node);
  if (markedRoot) {
    return markedRoot;
  }

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

function findMarkedScrollRoot(node) {
  const parent = node?.parentElement || null;
  const markedRoot = parent?.closest?.(THREAD_LIST_SCROLL_ROOT_SELECTOR) || null;
  return markedRoot?.contains(node) ? markedRoot : null;
}

function measureScrollMargin(node, scrollElement) {
  const root = node?.parentElement || null;
  if (!root || !scrollElement || root === scrollElement) {
    return 0;
  }

  const rootRect = root.getBoundingClientRect();
  const scrollRect = scrollElement.getBoundingClientRect();
  return rootRect.top - scrollRect.top + scrollElement.scrollTop;
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
  activity = null,
  attentionKind = null,
  formatThreadMeta,
  group,
  includePreview,
  onContextThread,
  onResumeThread,
  previewFallback,
  thread,
}) {
  const title = thread.name || thread.preview || shortId(thread.id);
  const provider = providerLabel(thread.provider);
  const providerToneClass = `is-${providerTone(thread.provider)}`;
  // Three-state dot: needs_input (amber) > working (pulse) > completed (blue).
  // See selectThreadDot for why needs_input outranks the live-turn pulse.
  const dot = selectThreadDot({ activity, attentionKind });

  return h(
    "button",
    {
      className: `conversation-item${active ? " is-active" : ""}`,
      "data-thread-cwd": group.cwd,
      "data-thread-id": thread.id,
      "data-thread-provider": thread.provider || "",
      "data-thread-title": title,
      onClick: () => onResumeThread?.(thread.id),
      onContextMenu: onContextThread
        ? (event) => {
            event.preventDefault();
            onContextThread(thread.id, event.clientX, event.clientY);
          }
        : undefined,
      title: provider ? `${provider} · ${title}` : title,
      type: "button",
    },
    provider
      ? h("span", {
          className: `conversation-provider-badge ${providerToneClass}`,
        }, provider)
      : h("span", {}),
    h(
      "span",
      { className: "conversation-title-row" },
      dot
        ? h("span", {
            className: dot.className,
            role: "img",
            "aria-label": dot.label,
            title: dot.label,
          })
        : null,
      h("span", { className: "conversation-title" }, title)
    ),
    includePreview
      ? h("span", { className: "conversation-preview" }, thread.preview || previewFallback)
      : null,
    h("span", { className: "conversation-meta" }, formatThreadMeta(thread))
  );
}
