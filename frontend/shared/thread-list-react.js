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
import { canonicalizeWorkspace, isUnknownWorkspace } from "./thread-groups.js";
import { createThreadListRows, visibleThreadIds } from "./thread-list-state.js";
import { providerLabel } from "./provider-labels.js";
// The row's agent mark. A provider we ship no mark for leaves the slot EMPTY
// rather than borrowing another vendor's logo, which would mislabel the session
// — same rule the transcript avatar and the session tab follow.
import { providerMark } from "./provider-mark.js";
import { ProjectTagIcon, WorkspaceFolderIcon } from "./panel-icons.js";
import { selectThreadDot } from "./thread-dot.js";

const h = React.createElement;

const VISIBLE_THREAD_LIMIT = 10;
const VIRTUAL_OVERSCAN = 8;
const THREAD_LIST_SCROLL_ROOT_SELECTOR = "[data-thread-list-scroll-root]";

function shortId(value) {
  return value ? String(value).slice(0, 8) : "unknown";
}

// Small stroked glyphs for the project-header rename/delete affordances.
function renameGlyph() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      width: "13",
      height: "13",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M10.5 3.5 12.5 5.5" }),
    h("path", { d: "M3 11 10 4 12 6 5 13 2.5 13.5 3 11Z" })
  );
}

function deleteGlyph() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      width: "13",
      height: "13",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M3.25 4.5H12.75" }),
    h("path", { d: "M6.5 4.5V3H9.5V4.5" }),
    h("path", { d: "M5 4.5 5.5 12.5H10.5L11 4.5" })
  );
}

// The one control that folds a group: "+" to unfold, "−" to fold. A chevron read
// as decoration on a row that was already clickable; a +/− reads as the button it
// is, which matters now that folding and selecting are deliberately separate
// targets (see thread-list-collapse.dom.test.mjs).
function DisclosureButton({ isCollapsed, label, onToggle }) {
  return h(
    "button",
    {
      type: "button",
      className: "thread-group-disclosure",
      "data-state": isCollapsed ? "collapsed" : "expanded",
      "aria-expanded": isCollapsed ? "false" : "true",
      "aria-label": `${isCollapsed ? "Expand" : "Collapse"} ${label}`,
      title: isCollapsed ? "Expand" : "Collapse",
      onClick: (event) => {
        // Never let a fold bubble into the row's select handler.
        event.stopPropagation();
        onToggle();
      },
    },
    h(
      "svg",
      {
        "aria-hidden": "true",
        width: "13",
        height: "13",
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.6",
        strokeLinecap: "round",
      },
      h("path", { d: "M3.5 8h9" }),
      // The vertical stroke is the only difference between "−" and "+".
      isCollapsed ? h("path", { d: "M8 3.5v9" }) : null
    )
  );
}

export function ThreadGroupList({
  activeThreadId = null,
  collapsedGroupCwds = new Set(),
  collapsible = false,
  contextMenuThreadId = null,
  emptyMessage = "No saved sessions yet.",
  expandedGroupCwds = new Set(),
  formatThreadMeta = (thread) => thread.updated_at || "",
  groups = [],
  includePreview = false,
  onContextThread = null,
  onDeleteProject = null,
  activeProjectId = null,
  onContextProject = null,
  hidePinnedGroupHeader = false,
  onRenameProject = null,
  onSelectProject = null,
  onResumeThread = null,
  onSelectThread = null,
  onSelectWorkspace = null,
  onThreadActions = null,
  onToggleExpandedGroup = null,
  onToggleGroup = null,
  previewFallback = "No preview yet.",
  selectedCwd = "",
  selectedThreadIds = null,
  threadActivity = null,
  threadAttention = null,
  threadReviewing = null,
}) {
  // Every hook runs before the empty-list early return below. The sidebar goes from no
  // groups to groups on every cold load, and an early return ABOVE these made React see
  // zero hooks on one render and two on the next — corrupting its hook bookkeeping
  // ("Expected static flag was missing") rather than failing loudly. Both hooks are
  // safe to run with an empty list: `createThreadListRows` returns [], and the
  // virtualizer is built for `count: 0` with a ref that never attaches.
  const normalizedSelectedCwd = canonicalizeWorkspace(selectedCwd);
  const rows = useMemo(
    () =>
      createThreadListRows({
        collapsedGroupCwds,
        collapsible,
        expandedGroupCwds,
        groups,
        hidePinnedGroupHeader,
        visibleThreadLimit: VISIBLE_THREAD_LIMIT,
      }),
    [collapsedGroupCwds, collapsible, expandedGroupCwds, groups, hidePinnedGroupHeader]
  );
  const virtualizer = useThreadListVirtualizer(rows);
  const virtualRows = virtualizer.getVirtualItems();
  // The row hands up `(threadId, event)`; the ORDER a shift+click ranges over is
  // knowable only here, where the rows are built — the list is virtualized, so the
  // shell cannot read it back off the DOM. Hence the third argument.
  const handleSelectThread = useCallback(
    (threadId, event) => onSelectThread?.(threadId, event, visibleThreadIds(rows)),
    [onSelectThread, rows]
  );
  // Same reason, for the same reader: a right-click inside a multi-selection acts on
  // the batch, and ordering it needs the row order. Appended, so the surfaces that
  // take three arguments are unaffected.
  const handleContextThread = useCallback(
    (threadId, clientX, clientY) =>
      onContextThread?.(threadId, clientX, clientY, visibleThreadIds(rows)),
    [onContextThread, rows]
  );

  if (!groups.length) {
    return h("p", { className: "sidebar-empty" }, emptyMessage);
  }

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
            contextMenuThreadId,
            formatThreadMeta,
            includePreview,
            normalizedSelectedCwd,
            onContextThread: onContextThread ? handleContextThread : null,
            onDeleteProject,
            activeProjectId,
            onContextProject,
            onRenameProject,
            onSelectProject,
            onResumeThread,
            onSelectThread: onSelectThread ? handleSelectThread : null,
            onSelectWorkspace,
            onThreadActions,
            onToggleExpandedGroup,
            onToggleGroup,
            previewFallback,
            row,
            selectedThreadIds,
            threadActivity,
            threadAttention,
            threadReviewing,
          })
        );
      })
    )
  );
}

function ThreadListRow({
  activeThreadId,
  contextMenuThreadId,
  formatThreadMeta,
  includePreview,
  normalizedSelectedCwd,
  onContextThread,
  onDeleteProject,
  activeProjectId,
  onContextProject,
  onRenameProject,
  onSelectProject,
  onResumeThread,
  onSelectThread,
  onSelectWorkspace,
  onThreadActions,
  onToggleExpandedGroup,
  onToggleGroup,
  previewFallback,
  row,
  selectedThreadIds,
  threadActivity,
  threadAttention,
  threadReviewing,
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
        onDeleteProject,
        activeProjectId,
        onContextProject,
        onRenameProject,
        onSelectProject,
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
      reviewing: threadReviewing?.has?.(row.thread.id) || false,
      contextMenuThreadId,
      formatThreadMeta,
      group: row.group,
      includePreview,
      onContextThread,
      onResumeThread,
      onSelectThread,
      onThreadActions,
      previewFallback,
      selected: selectedThreadIds?.has?.(row.thread.id) || false,
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

// The header's leading mark: a tag for a project, a folder for a working
// directory. Both kinds used to render the same CSS-drawn folder, which made
// them indistinguishable in a column that shows them side by side — and the
// folder was wrong for a project, which is deliberately not bound to a cwd.
//
// The kind is read from the GROUP, not from whichever branch below happens to
// render it. A pinned project carries a projectId but no rename/delete handlers,
// so it falls through to the generic collapsible branch — and that is the case
// actually on screen, since both surfaces group by cwd today and lift one
// project to the top. Anything keyed on the branch (a CSS rule on
// `.thread-group-header-project`, say) gets exactly that row wrong.
//
// `projectId: null` is the Unassigned bucket — the absence of a project — so it
// takes the folder rather than claiming to be one.
//
// No workspace-trust marker here, and that is a decision rather than an omission. This
// header is passive — it renders because sessions exist, not because anyone asked about
// the folder — and an ungranted folder is the ordinary case that blocks nothing. A tag on
// most rows forever is a tag people stop reading, and it would spend the attention the
// in-context offer needs. `thread-groups.js` withholds the flag for the same reason.
function groupIcon(group) {
  return h(
    "span",
    { "aria-hidden": "true", className: "thread-group-icon" },
    h(group.projectId ? ProjectTagIcon : WorkspaceFolderIcon)
  );
}

// Exported for unit tests: the list itself virtualizes and renders nothing
// under SSR, so the sentinel guard below cannot be observed through it.
export function ThreadGroupHeader({
  activeProjectId = null,
  collapsible,
  group,
  isCollapsed,
  normalizedCwd,
  onDeleteProject,
  onContextProject = null,
  onRenameProject,
  onSelectProject = null,
  onSelectWorkspace,
  onToggleGroup,
}) {
  // The unknown-workspace key is internal; every branch shows the label
  // instead so it is never presented to the user as a path.
  const headerTitle = isUnknownWorkspace(group.cwd) ? group.label : group.cwd;

  // Real Project groups (project mode) carry a truthy `projectId`; cwd groups omit
  // the field and the Unassigned bucket is `projectId: null`, so neither gets the
  // rename/delete affordances. Rendered as a <div> (not a button) so the action
  // <button>s are valid children and there's no header-level click to fight.
  const projectId = group.projectId || null;
  // Collapse is only offered where a surface actually wired it; otherwise the
  // chevron would be a control that does nothing.
  const canToggle = Boolean(collapsible && onToggleGroup);
  if (projectId && (onRenameProject || onDeleteProject)) {
    const isActiveProject = Boolean(activeProjectId) && activeProjectId === projectId;
    // The whole row selects — the label is only a few characters wide, and a user
    // aiming at "the project" hits the row. Selecting must NOT also fold: making
    // an already-active project active again would hide the sessions you were
    // reaching for. Folding lives on the disclosure button alone.
    const activateRow = () => {
      onSelectProject?.(projectId);
    };
    const rowClickable = Boolean(onSelectProject);
    return h(
      "div",
      {
        className:
          "thread-group-header thread-group-header-static thread-group-header-project"
          + (isActiveProject ? " is-active" : "")
          // A <div> gets no pointer cursor for free.
          + (rowClickable ? " is-clickable" : ""),
        "data-project-id": projectId,
        title: headerTitle,
        onClick: rowClickable ? activateRow : undefined,
        // Right-click opens the same project actions the inline buttons expose. The
        // inline buttons keep it reachable without a mouse; this keeps the mouse path
        // that the previous project-row sidebar had.
        onContextMenu: onContextProject
          ? (event) => {
              event.preventDefault();
              onContextProject(projectId, group.label, event.clientX, event.clientY);
            }
          : undefined,
      },
      groupIcon(group),
      // Still a real <button> so the row's action is keyboard-reachable — the
      // header itself is a <div> (it hosts the action <button>s) and cannot be
      // one. stopPropagation keeps it from ALSO firing the row handler, which
      // would double-toggle straight back to where it started.
      onSelectProject
        ? h(
            "button",
            {
              type: "button",
              className: "thread-group-name thread-group-name-button",
              onClick: (event) => {
                event.stopPropagation();
                activateRow();
              },
            },
            group.label
          )
        : h("span", { className: "thread-group-name" }, group.label),
      // At-a-glance activity, carried on the group as `summary`. Only the states
      // worth acting on: a plain "N sessions" restated what the nested rows
      // already show, and it crowded the collapse chevron off the right edge.
      // These two must NOT be derived from the visible rows — the group collapses
      // and the list truncates past a limit, and the counts have to survive both.
      group.summary && (group.summary.working || group.summary.needsInput)
        ? h(
            "span",
            { className: "thread-group-badges" },
            group.summary.working
              ? h(
                  "span",
                  { className: "project-sidebar-badge is-working" },
                  `${group.summary.working} working`
                )
              : null,
            group.summary.needsInput
              ? h(
                  "span",
                  { className: "project-sidebar-badge is-attention" },
                  `${group.summary.needsInput} needs input`
                )
              : null
          )
        : null,
      h(
        "span",
        { className: "thread-group-actions" },
        onRenameProject &&
          h(
            "button",
            {
              type: "button",
              className: "thread-group-action",
              title: "Rename project",
              "aria-label": `Rename project ${group.label}`,
              onClick: (event) => {
                event.stopPropagation();
                onRenameProject(projectId, group.label);
              },
            },
            renameGlyph()
          ),
        onDeleteProject &&
          h(
            "button",
            {
              type: "button",
              className: "thread-group-action thread-group-action-danger",
              title: "Delete project",
              "aria-label": `Delete project ${group.label}`,
              onClick: (event) => {
                event.stopPropagation();
                onDeleteProject(projectId, group.label);
              },
            },
            deleteGlyph()
          )
      ),
      canToggle
        ? h(DisclosureButton, {
            isCollapsed,
            label: `project ${group.label}`,
            onToggle: () => onToggleGroup(normalizedCwd),
          })
        : null
    );
  }

  if (collapsible) {
    // A <div>, not a <button>: it hosts the disclosure <button>, and nesting
    // buttons is invalid. Same shape as a project header — the label is its own
    // button so the selection stays keyboard-reachable.
    //
    // The Unknown-workspace key is a display sentinel rather than a directory. It
    // would be sent to the relay verbatim as a path, so it never leaves the
    // display layer: that group folds, but its label is inert.
    const selectable = Boolean(onSelectWorkspace) && Boolean(group.cwd) && !isUnknownWorkspace(group.cwd);
    const selectWorkspace = () => onSelectWorkspace(group.cwd);
    return h(
      "div",
      {
        className: "thread-group-header" + (selectable ? " is-clickable" : ""),
        onClick: selectable ? selectWorkspace : undefined,
        title: headerTitle,
        // Present only for the bell's state buckets, so CSS can drop the folder glyph.
        // "Needs input" is not a directory, and absent renders exactly as before.
        "data-group-kind": group.state ? "state" : undefined,
      },
      groupIcon(group),
      selectable
        ? h(
            "button",
            {
              type: "button",
              className: "thread-group-name thread-group-name-button",
              "data-select-workspace": group.cwd,
              onClick: (event) => {
                // Don't also fire the row handler — one selection per click.
                event.stopPropagation();
                selectWorkspace();
              },
            },
            group.label
          )
        : h("span", { className: "thread-group-name" }, group.label),
      h(DisclosureButton, {
        isCollapsed,
        label: group.label,
        onToggle: () => onToggleGroup?.(normalizedCwd),
      })
    );
  }

  // The Unknown-workspace group key is a display sentinel, not a directory —
  // selecting it would write "__unknown_workspace__" into the workspace input
  // and then send it to the relay as a path. Render its header as a static
  // label so the value cannot leave the display layer.
  if (onSelectWorkspace && !isUnknownWorkspace(group.cwd)) {
    return h(
      "button",
      {
        className: "thread-group-header",
        "data-select-workspace": group.cwd,
        onClick: () => onSelectWorkspace(group.cwd),
        title: headerTitle,
        type: "button",
      },
      groupIcon(group),
      h("span", { className: "thread-group-name" }, group.label)
    );
  }

  return h(
    "div",
    {
      className: "thread-group-header thread-group-header-static",
      title: headerTitle,
    },
    groupIcon(group),
    h("span", { className: "thread-group-name" }, group.label)
  );
}

export function ThreadGroupItem({
  active,
  activity = null,
  attentionKind = null,
  reviewing = false,
  contextMenuThreadId = null,
  formatThreadMeta,
  group,
  includePreview,
  onContextThread,
  onResumeThread,
  onSelectThread = null,
  onThreadActions = null,
  previewFallback,
  selected = false,
  thread,
}) {
  const title = thread.name || thread.preview || shortId(thread.id);
  const provider = providerLabel(thread.provider);
  // Four-state dot: needs_input (amber) > working (pulse) > reviewing (blue pulse)
  // > completed (steady blue). See selectThreadDot for the full ordering rationale.
  const dot = selectThreadDot({ activity, attentionKind, reviewing });
  // The right-click highlight is React-owned, driven off the store's context-menu
  // target (opening/closing the menu re-renders the thread list). It must NOT be
  // painted imperatively: the list re-renders on every SSE/activity tick, and a
  // re-render that recomputes this button's className (active flips, virtualizer
  // remounts the row, ...) would strip an imperatively-set class — leaving the
  // highlight flickering off while the menu is still open. Owning it here keeps
  // it stable across renders.
  const isContextTarget = contextMenuThreadId === thread.id;

  const rowButton = h(
    "button",
    {
      className: `conversation-item${active ? " is-active" : ""}${isContextTarget ? " is-context-target" : ""}${selected ? " is-multi-selected" : ""}`,
      // Only meaningful where rows are selectable; a surface without the handler
      // would otherwise announce every row as "not selected" for no reason.
      "aria-selected": onSelectThread ? String(Boolean(selected)) : undefined,
      "data-thread-cwd": group.cwd,
      "data-thread-id": thread.id,
      "data-thread-provider": thread.provider || "",
      "data-thread-title": title,
      // One row, two intents. A single click PEEKS: the session opens instantly,
      // as before, but into the reusable preview tab — so scrolling the sidebar
      // hunting for a session no longer leaves a tab behind for every row touched
      // on the way. A double click KEEPS it, the way an editor pins the tab you
      // actually start working in.
      //
      // The two clicks of a double click fire first and peek; the dblclick then
      // upgrades that same tab. Nothing is opened twice — `preview` only ever
      // decides how a NEW tab is flagged, and the surface with no tab strip
      // (remote) simply ignores the option.
      //
      // EVERY click first goes to the selection layer, which returns true when it has
      // claimed the gesture (cmd/shift, or a Mac ctrl+click that is really a
      // right-click) and false for a plain one. A plain click is not a no-op there —
      // it is what sets the ANCHOR a later shift+click ranges from — so it cannot be
      // filtered out here, only by the caller, which is the side that knows the
      // platform. See threadSelectionIntent.
      //
      // The text-selection half of shift+click is suppressed in CSS (user-select on
      // .conversation-item): it begins on mousedown, too early for this to stop.
      onClick: (event) => {
        if (onSelectThread?.(thread.id, event)) {
          event.preventDefault();
          return;
        }
        onResumeThread?.(thread.id, { preview: true });
      },
      onDoubleClick: () => onResumeThread?.(thread.id, { preview: false }),
      onContextMenu: onContextThread
        ? (event) => {
            event.preventDefault();
            onContextThread(thread.id, event.clientX, event.clientY);
          }
        : undefined,
      title: provider ? `${provider} · ${title}` : title,
      type: "button",
    },
    // One fixed-width leading slot. The mark says WHICH agent owns the row, and
    // the FIXED width is what puts every title on the same left edge — the text
    // pill it replaces was a different width per provider ("Claude" vs "Codex"),
    // so titles stepped in and out down the column. The provider name is not
    // lost: it still leads the row's `title` tooltip, and the mark is
    // aria-hidden so screen readers read that instead of a decorative glyph.
    h(
      "span",
      { className: "conversation-lead", "aria-hidden": "true" },
      providerMark(thread.provider)
    ),
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

  // Without an actions handler there is nothing to reveal — keep the bare row, so the
  // surfaces that don't pass one (local, which has its own right-click menu) render
  // byte-for-byte as before. Same optional-prop gate `onRenameProject` uses on the
  // header.
  if (!onThreadActions) return rowButton;

  // The actions button is a SIBLING of the row button, never a child: the row itself is
  // a <button>, and nesting one inside it is invalid HTML that browsers reparent. The
  // wrapper is the shared positioned ancestor that lets it overlay the row's right edge
  // (see .project-sidebar-row-wrap, the same pattern).
  //
  // This is also the only session-actions entry that works on a phone. Right-click is
  // unreachable there — a touch long-press never dispatches `contextmenu` on iOS — so
  // CSS keeps this button permanently visible under `@media (hover: none)`.
  return h(
    "div",
    { className: "conversation-item-wrap" },
    rowButton,
    h(
      "button",
      {
        type: "button",
        className: "conversation-more",
        "aria-label": `Actions for ${title}`,
        title: "Session actions",
        onClick: (event) => {
          // The row underneath opens the session on click; without this the sheet and
          // the session would both fire.
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onThreadActions(thread.id, rect.right, rect.bottom);
        },
      },
      h(MoreGlyph)
    )
  );
}

// Local to this module rather than imported from project-overview-react.js: that file is
// an unrelated component, and a three-dot glyph is not worth coupling them over.
function MoreGlyph() {
  return h(
    "svg",
    { "aria-hidden": "true", width: "16", height: "16", viewBox: "0 0 16 16", fill: "currentColor" },
    h("circle", { cx: "3", cy: "8", r: "1.3" }),
    h("circle", { cx: "8", cy: "8", r: "1.3" }),
    h("circle", { cx: "13", cy: "8", r: "1.3" })
  );
}
