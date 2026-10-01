import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Virtualizer,
  defaultRangeExtractor,
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
import { InlineTitleEditor } from "./inline-title-editor.js";
import { threadNameDraft } from "./thread-rename.js";
import {
  ContextMenu,
  MenuConfirm,
  MenuGlyph,
  MenuItem,
  MenuSeparator,
} from "./context-menu-react.js";
import { describeProjectDelete } from "./destructive-confirm-copy.js";
import { CHEVRON_DOWN_SVG, CHEVRON_RIGHT_SVG } from "../svg.js";

const h = React.createElement;

const VISIBLE_THREAD_LIMIT = 10;
const VIRTUAL_OVERSCAN = 8;
const THREAD_LIST_SCROLL_ROOT_SELECTOR = "[data-thread-list-scroll-root]";

function shortId(value) {
  return value ? String(value).slice(0, 8) : "unknown";
}

// Filled rather than stroked: it has to read as a persistent "starred" mark, not
// as an outline action icon, since it sits on the row whatever the pointer does.
function flagGlyph() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      width: "12",
      height: "12",
      viewBox: "0 0 16 16",
      fill: "currentColor",
    },
    h("path", {
      d: "M3 1.5a.75.75 0 0 1 .75.75V2h7.5a.75.75 0 0 1 .6 1.2L10.1 5l1.75 2.3a.75.75 0 0 1-.6 1.2h-7.5v5a.75.75 0 0 1-1.5 0v-11A.75.75 0 0 1 3 1.5Z",
    })
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
  onBeginRename = null,
  onCancelRename = null,
  onCommitRename = null,
  onContextThread = null,
  // `(projectId, name, { sessionCount })`, after the header's own confirm.
  onDeleteProject = null,
  activeProjectId = null,
  hidePinnedGroupHeader = false,
  // `(projectId, nextName)`: the header edits the name in place.
  onRenameProject = null,
  onResumeThread = null,
  onSelectThread = null,
  onThreadActions = null,
  onToggleExpandedGroup = null,
  onToggleGroup = null,
  previewFallback = "No preview yet.",
  renamingThreadId = null,
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
        keepThreadId: renamingThreadId,
        visibleThreadLimit: VISIBLE_THREAD_LIMIT,
      }),
    [
      collapsedGroupCwds,
      collapsible,
      expandedGroupCwds,
      groups,
      hidePinnedGroupHeader,
      renamingThreadId,
    ]
  );
  // The wheel scrolls without blurring, so an editor dropped by the virtualizer would
  // lose the draft with nothing saved; the row being renamed is always rendered.
  const keepIndex = renamingThreadId
    ? rows.findIndex((row) => row.type === "thread" && row.thread.id === renamingThreadId)
    : -1;
  const virtualizer = useThreadListVirtualizer(rows, keepIndex);
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
            onBeginRename,
            onCancelRename,
            onCommitRename,
            onContextThread: onContextThread ? handleContextThread : null,
            onDeleteProject,
            activeProjectId,
            onRenameProject,
            onResumeThread,
            onSelectThread: onSelectThread ? handleSelectThread : null,
            onThreadActions,
            onToggleExpandedGroup,
            onToggleGroup,
            previewFallback,
            renamingThreadId,
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
  onBeginRename,
  onCancelRename,
  onCommitRename,
  onContextThread,
  onDeleteProject,
  activeProjectId,
  onRenameProject,
  onResumeThread,
  onSelectThread,
  onThreadActions,
  onToggleExpandedGroup,
  onToggleGroup,
  previewFallback,
  renamingThreadId,
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
        onRenameProject,
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
      onBeginRename,
      onCancelRename,
      onCommitRename,
      onContextThread,
      onResumeThread,
      onSelectThread,
      onThreadActions,
      previewFallback,
      renaming: renamingThreadId != null && renamingThreadId === row.thread.id,
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

function useThreadListVirtualizer(rows, keepIndex = -1) {
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
  const rangeExtractor = useCallback(
    (range) => {
      const indexes = defaultRangeExtractor(range);
      if (keepIndex < 0 || indexes.includes(keepIndex)) {
        return indexes;
      }
      return [...indexes, keepIndex].sort((a, b) => a - b);
    },
    [keepIndex]
  );

  virtualizerRef.current.setOptions({
    count: rows.length,
    estimateSize,
    getItemKey,
    getScrollElement: () => findScrollElement(scrollTargetRef.current),
    measureElement,
    observeElementOffset,
    observeElementRect,
    overscan: VIRTUAL_OVERSCAN,
    rangeExtractor,
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

// No workspace-trust marker on a header, deliberately: it renders because sessions
// exist, an ungranted folder blocks nothing, and a tag on most rows gets tuned out.
function MoreGlyphSmall() {
  return h(
    "svg",
    { "aria-hidden": "true", width: "14", height: "14", viewBox: "0 0 16 16", fill: "currentColor" },
    h("circle", { cx: "3.5", cy: "8", r: "1.2" }),
    h("circle", { cx: "8", cy: "8", r: "1.2" }),
    h("circle", { cx: "12.5", cy: "8", r: "1.2" })
  );
}

// Read from `group.summary`, not the rows: the group folds and truncates, and the counts
// have to survive both. No plain session count — the rows below already say it.
function groupActivity(group) {
  const working = group.summary?.working || 0;
  const needsInput = group.summary?.needsInput || 0;
  if (!working && !needsInput) {
    return null;
  }
  const count = (n, kind, label) =>
    h(
      "span",
      {
        "aria-label": `${n} ${label}`,
        className: `thread-group-count is-${kind}`,
        role: "img",
        title: `${n} ${label}`,
      },
      h("span", { "aria-hidden": "true", className: "thread-group-count-dot" }),
      h("span", { "aria-hidden": "true" }, String(n))
    );
  return h(
    "span",
    { className: "thread-group-badges" },
    needsInput ? count(needsInput, "attention", "needs input") : null,
    working ? count(working, "working", "working") : null
  );
}

// Exported for unit tests: the list virtualizes and renders nothing under SSR.
// The whole row folds the group; selecting lives in the switcher, so the row no longer
// has to split into a label and a separate +/− that nobody found.
export function ThreadGroupHeader({
  activeProjectId = null,
  collapsible,
  group,
  isCollapsed,
  normalizedCwd,
  onDeleteProject = null,
  onRenameProject = null,
  onToggleGroup,
}) {
  const [menu, setMenu] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const moreRef = useRef(null);

  // The unknown-workspace key is internal; every branch shows the label
  // instead so it is never presented to the user as a path.
  const headerTitle = isUnknownWorkspace(group.cwd) ? group.label : group.cwd;
  // Real project groups carry a truthy `projectId`; cwd groups omit it and the
  // Unassigned bucket is `projectId: null`, so neither has actions.
  const projectId = group.projectId || null;
  const canRename = Boolean(projectId && onRenameProject);
  const canDelete = Boolean(projectId && onDeleteProject);
  const hasMenu = canRename || canDelete;
  const canToggle = Boolean(collapsible && onToggleGroup);
  const isActiveProject = Boolean(projectId) && activeProjectId === projectId;
  // Members, not rows: an empty screen is not an empty project (see `memberCount`).
  const sessionCount = Math.max(group.memberCount || 0, group.threads?.length || 0);

  const openMenu = (x, y) => {
    setConfirming(false);
    setMenu({ x, y });
  };
  const closeMenu = () => {
    setMenu(null);
    setConfirming(false);
  };
  const beginRename = () => {
    closeMenu();
    setRenaming(true);
  };
  const deleteNow = () => {
    closeMenu();
    onDeleteProject(projectId, group.label, { sessionCount });
  };
  const deleteCopy = canDelete
    ? describeProjectDelete({ name: group.label, sessionCount })
    : null;

  const lead = h(
    "span",
    { "aria-hidden": "true", className: "thread-group-icon" },
    // `projectId: null` is the Unassigned bucket — the absence of a project — so it
    // takes the folder, not the tag.
    h("span", { className: "thread-group-kind" }, h(projectId ? ProjectTagIcon : WorkspaceFolderIcon)),
    canToggle
      ? h(MenuGlyph, {
          className: "thread-group-chevron",
          svg: isCollapsed ? CHEVRON_RIGHT_SVG : CHEVRON_DOWN_SVG,
        })
      : null
  );

  const name = renaming
    ? h(InlineTitleEditor, {
        ariaLabel: "Project name",
        className: "thread-group-name-input",
        defaultValue: group.label,
        onCancel: () => setRenaming(false),
        onCommit: (value) => {
          setRenaming(false);
          const next = String(value || "").trim();
          // A project has to have a name; blank is a cancel, not a reset.
          if (next && next !== group.label) {
            onRenameProject(projectId, next);
          }
        },
      })
    : h("span", { className: "thread-group-name" }, group.label);

  // A project's roll-up only: a folder's rows already say it all, and the bell's state
  // buckets are themselves the state.
  const activity = projectId ? groupActivity(group) : null;

  const onContextMenu = hasMenu
    ? (event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY);
      }
    : undefined;

  // While renaming, the row stops being a <button>: an <input> inside one is invalid,
  // and the button would eat the clicks that place a caret.
  const main = canToggle && !renaming
    ? h(
        "button",
        {
          "aria-expanded": isCollapsed ? "false" : "true",
          "aria-label": `${isCollapsed ? "Expand" : "Collapse"} ${group.label}`,
          className: "thread-group-toggle",
          onClick: () => onToggleGroup(normalizedCwd),
          onContextMenu,
          onKeyDown: canRename
            ? (event) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  setRenaming(true);
                }
              }
            : undefined,
          title: headerTitle,
          type: "button",
        },
        lead,
        name,
        activity
      )
    : h(
        "div",
        {
          className: `thread-group-toggle is-static${renaming ? " is-editing" : ""}`,
          onContextMenu,
          title: headerTitle,
        },
        lead,
        name,
        activity
      );

  return h(
    "div",
    {
      className:
        "thread-group-header"
        + (projectId ? " thread-group-header-project" : "")
        + (isActiveProject ? " is-active" : "")
        + (canToggle ? " is-foldable" : "")
        + (isCollapsed ? " is-collapsed" : "")
        + (menu ? " is-menu-open" : ""),
      "data-project-id": projectId || undefined,
      // Present only for the bell's state buckets, so CSS can drop the folder glyph.
      "data-group-kind": group.state ? "state" : undefined,
    },
    main,
    hasMenu && !renaming
      ? h(
          "button",
          {
            "aria-expanded": menu ? "true" : "false",
            "aria-haspopup": "menu",
            "aria-label": `Actions for project ${group.label}`,
            className: "thread-group-more",
            onClick: (event) => {
              if (menu) {
                closeMenu();
                return;
              }
              const box = event.currentTarget.getBoundingClientRect();
              openMenu(box.left, box.bottom + 4);
            },
            ref: moreRef,
            title: "Project actions",
            type: "button",
          },
          h(MoreGlyphSmall)
        )
      : null,
    menu
      ? h(
          ContextMenu,
          {
            anchor: menu,
            ariaLabel: `Project ${group.label}`,
            confirming,
            ignoreRef: moreRef,
            onClose: closeMenu,
          },
          confirming && deleteCopy
            ? h(MenuConfirm, {
                ...deleteCopy,
                onCancel: closeMenu,
                onConfirm: deleteNow,
              })
            : h(
                React.Fragment,
                null,
                canRename
                  ? h(MenuItem, { hint: "F2", label: "Rename…", onSelect: beginRename })
                  : null,
                canRename && canDelete ? h(MenuSeparator) : null,
                canDelete
                  ? h(MenuItem, {
                      danger: true,
                      label: "Delete project…",
                      // An empty project has nothing to warn about: it goes at once and
                      // the host offers an Undo.
                      onSelect: () => (deleteCopy ? setConfirming(true) : deleteNow()),
                    })
                  : null
              )
        )
      : null
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
  onBeginRename = null,
  onCancelRename = null,
  onCommitRename = null,
  onContextThread,
  onResumeThread,
  onSelectThread = null,
  onThreadActions = null,
  previewFallback,
  renaming = false,
  selected = false,
  thread,
}) {
  const title = thread.name || thread.preview || shortId(thread.id);
  const isRenaming = renaming && Boolean(onCommitRename);
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

  const rowChildren = [
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
      // Independent of `dot`, deliberately: a flagged session that is also
      // working/needs-input/reviewing/done keeps showing both. This is the row's
      // half of the flag — the bell's "Follow up" bucket is the other half, for
      // when nothing else keeps the row visible.
      //
      // Nested inside this flex row, NOT a direct child of `.conversation-item`
      // above: that element is a 3-column CSS grid (`grid-template-columns: 14px
      // minmax(0, 1fr) auto`) sized for exactly its three positional children
      // (lead, title-row, meta). A 4th grid-level sibling here would shift every
      // later child over by one column — the flag lands in the title's `1fr`
      // track, the title gets squeezed into the `auto` meta track, and meta
      // wraps onto an auto-generated second row. Flex children of this row incur
      // no such shift.
      thread.flagged
        ? h(
            "span",
            {
              className: "conversation-flag-mark",
              role: "img",
              "aria-label": "Flagged for follow-up",
              title: "Flagged for follow-up",
            },
            flagGlyph()
          )
        : null,
      dot
        ? h("span", {
            className: dot.className,
            role: "img",
            "aria-label": dot.label,
            title: dot.label,
          })
        : null,
      isRenaming
        ? h(InlineTitleEditor, {
            className: "conversation-title-input",
            ariaLabel: "Session name",
            defaultValue: threadNameDraft(thread, shortId(thread.id)),
            onCommit: (value) => onCommitRename(thread.id, value),
            onCancel: () => onCancelRename?.(thread.id),
          })
        : h("span", { className: "conversation-title" }, title)
    ),
    includePreview
      ? h("span", { className: "conversation-preview" }, thread.preview || previewFallback)
      : null,
    h("span", { className: "conversation-meta" }, formatThreadMeta(thread)),
  ];

  // While renaming, the row stops being a <button>: an <input> inside one is invalid
  // HTML, and the button would eat the clicks that place a caret.
  const rowButton = isRenaming
    ? h(
        "div",
        {
          className: `conversation-item is-renaming${active ? " is-active" : ""}`,
          "data-thread-cwd": group.cwd,
          "data-thread-id": thread.id,
        },
        ...rowChildren
      )
    : h(
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
          // F2 renames the focused row, the key the menu's "Rename… F2" names.
          onKeyDown: onBeginRename && onCommitRename
            ? (event) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  event.stopPropagation();
                  onBeginRename(thread.id);
                }
              }
            : undefined,
          onContextMenu: onContextThread
            ? (event) => {
                event.preventDefault();
                onContextThread(thread.id, event.clientX, event.clientY);
              }
            : undefined,
          title: provider ? `${provider} · ${title}` : title,
          type: "button",
        },
        ...rowChildren
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
