import React, { useCallback, useState } from "react";
import { canonicalizeWorkspace } from "./thread-groups.js";

const h = React.createElement;
const VISIBLE_THREAD_LIMIT = 10;

function shortId(value) {
  return value ? String(value).slice(0, 8) : "unknown";
}

export function ThreadGroupList({
  activeThreadId = null,
  collapsedGroupCwds = new Set(),
  collapsible = false,
  emptyMessage = "No saved threads yet.",
  expandedGroupCwds = null,
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
}) {
  const [internalExpandedGroupCwds, setInternalExpandedGroupCwds] = useState(() => new Set());
  const effectiveExpandedGroupCwds = expandedGroupCwds || internalExpandedGroupCwds;

  const toggleShowAll = useCallback((cwd) => {
    if (onToggleExpandedGroup) {
      onToggleExpandedGroup(cwd);
      return;
    }

    setInternalExpandedGroupCwds((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) {
        next.delete(cwd);
      } else {
        next.add(cwd);
      }
      return next;
    });
  }, [onToggleExpandedGroup]);

  if (!groups.length) {
    return h("p", { className: "sidebar-empty" }, emptyMessage);
  }

  const normalizedSelectedCwd = canonicalizeWorkspace(selectedCwd);

  return h(
    React.Fragment,
    null,
    ...groups.map((group) => {
      const normalizedCwd = canonicalizeWorkspace(group.cwd);
      const isCollapsed = collapsible && collapsedGroupCwds.has(normalizedCwd);
      const isSelected = normalizedSelectedCwd && normalizedCwd === normalizedSelectedCwd;
      const allThreads = group.threads || [];
      const showAll = effectiveExpandedGroupCwds.has(normalizedCwd);
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
                  onClick: () => toggleShowAll(normalizedCwd),
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
                  onClick: () => toggleShowAll(normalizedCwd),
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
