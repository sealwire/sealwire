// A combobox, not a menu: the workspace is a free path, so a fixed list would drop the
// ability to launch in a directory the relay has never seen.

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { hasFinePrimaryPointer } from "./pointer-class.js";
import {
  abbreviateHomePath,
  gitContextLabel,
  isWorkspaceRestricted,
  workspaceOriginNote,
} from "./workspace-chip-model.js";
import {
  buildSuggestionGroups,
  buildWorktreeGroups,
  canCommitDraft,
  looksLikePath,
} from "./workspace-picker-model.js";
import { MenuPortal, useAnchoredMenu } from "./use-anchored-menu.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";

const h = React.createElement;

/** How often an OPEN panel confirms it is still on screen. See the effect that uses it. */
export const HIDDEN_CHECK_INTERVAL_MS = 400;

/// Undeterminable counts as VISIBLE: where `checkVisibility` is missing, guessing from
/// `offsetParent` would call everything hidden and shut the panel under the cursor.
function hiddenByContainer(node) {
  if (!node || typeof node.checkVisibility !== "function") {
    return false;
  }
  return !node.checkVisibility({
    checkVisibilityCSS: true,
    contentVisibilityAuto: true,
    opacityProperty: true,
  });
}

const FOLDER_ICON = h(
  "svg",
  {
    "aria-hidden": "true",
    className: "workspace-picker-icon",
    fill: "none",
    height: "14",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: "1.6",
    viewBox: "0 0 24 24",
    width: "14",
  },
  h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" })
);

const BRANCH_ICON = h(
  "svg",
  {
    "aria-hidden": "true",
    className: "workspace-picker-icon",
    fill: "none",
    height: "14",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: "1.6",
    viewBox: "0 0 24 24",
    width: "14",
  },
  h("circle", { cx: "6", cy: "6", r: "2.2" }),
  h("circle", { cx: "6", cy: "18", r: "2.2" }),
  h("circle", { cx: "18", cy: "8", r: "2.2" }),
  h("path", { d: "M6 8.2v7.6" }),
  h("path", { d: "M18 10.2c0 3.4-2.7 4.6-6 5.4" })
);

const SEARCH_ICON = h(
  "svg",
  {
    "aria-hidden": "true",
    className: "workspace-picker-search-icon",
    fill: "none",
    height: "14",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: "1.6",
    viewBox: "0 0 24 24",
    width: "14",
  },
  h("circle", { cx: "11", cy: "11", r: "6.5" }),
  h("path", { d: "m16 16 4 4" })
);

const CHECK_ICON = h(
  "svg",
  {
    "aria-hidden": "true",
    className: "workspace-picker-row-check",
    fill: "none",
    height: "16",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: "2",
    viewBox: "0 0 24 24",
    width: "16",
  },
  h("path", { d: "m5 12.5 4.5 4.5L19 7.5" })
);

export function WorkspacePicker({
  // Null renders no chip: "not a repo" is the common case and is not worth a line.
  gitContext = null,
  disabled = false,
  id = null,
  inputId = null,
  onChange = null,
  suggestions = [],
  value = "",
  // Non-null switches the panel into worktree mode: branch-first rows grouped by
  // repository, with each tree's change count. `suggestions` is ignored then.
  roots = null,
  // The session's own tree, badged so the way back to following it stays findable.
  sessionPath = "",
  // Fired when the panel opens, so a caller can measure the per-root change counts
  // only while they are actually on screen.
  onOpen = null,
  // …and when it closes, so the caller can stop paying for them. Also fires on
  // unmount, which is a close by another name (thread switch, tab change).
  onClose = null,
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const groupsRef = useRef(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);

  useDismissableMenu({ menuRef: panelRef, onClose: close, open, rootRef });
  const assignPanelRef = useAnchoredMenu({ menuRef: panelRef, open, triggerRef });

  const worktreeMode = Array.isArray(roots);

  const { groups, total, matched } = useMemo(
    () =>
      worktreeMode
        ? buildWorktreeGroups({
            roots,
            selectedPath: value,
            sessionPath,
            query: draft,
          })
        : buildSuggestionGroups({ suggestions, selectedPath: value, query: draft }),
    [worktreeMode, roots, suggestions, value, sessionPath, draft]
  );

  // Flattened once so keyboard movement and click share one index space; a row's
  // position in the panel is its position here, groups included.
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  // Read by the open effect, which must not re-run every time the rows change — it
  // seeds the cursor once per opening, not once per keystroke.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Same reason: the open/close effect must not re-run just because a parent handed
  // down a new closure this render.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Empty filter, cursor on the tree in view: a pre-filled path would match one row and
  // hide the other trees, and row 0 answers "which am I on?" wrongly.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    setDraft("");
    setActive(() => {
      const at = rowsRef.current.findIndex((row) => row.isSelected);
      return at >= 0 ? at : 0;
    });
    // Only where typing is the cheap move. On a phone the caret drags the software
    // keyboard up with it, over the very rows the user opened this to read — and
    // tapping a row is the common case there, while filtering is the rare one.
    //
    // `preventScroll` still matters for the tablets and touch laptops that keep a
    // fine pointer: the field is portalled out of the scrolling dialog body, and
    // Android Chrome otherwise scrolls that body to "reveal" an input already
    // visible in the fixed panel, leaving trigger and panel hundreds of pixels
    // apart. The keyboard's own viewport resize is handled by useAnchoredMenu.
    if (hasFinePrimaryPointer()) {
      inputRef.current?.focus({ preventScroll: true });
    }
    // Identifies WHICH picker: rail, sheet and review panel share one store.
    onOpenRef.current?.(panelId);
    // Also fires on unmount: a thread switch never runs a close handler.
    return () => onCloseRef.current?.(panelId);
    // Keyed on `open` alone: fresh callback closures would reset the filter mid-typing.
    // (The refs above exist precisely so the omitted callbacks stay current anyway.)
    // No eslint-disable here: `exhaustive-deps` is not enabled — see eslint.config.js
    // for why — so a suppression for it is itself reported as an unused directive.
  }, [open]);

  // A hidden container leaves this mounted and open, so the caller keeps measuring.
  // Polled: `rail-collapsed` delays `visibility` 200ms past the attribute change.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const timer = setInterval(() => {
      if (hiddenByContainer(rootRef.current)) {
        setOpen(false);
      }
    }, HIDDEN_CHECK_INTERVAL_MS);
    // No-op in browsers; in Node it stops a left-open picker hanging the test runner.
    timer?.unref?.();
    return () => clearInterval(timer);
  }, [open]);

  // Whatever the filter did, the highlight must land on a row that still exists.
  useEffect(() => {
    setActive((current) => (current < rows.length ? current : 0));
  }, [rows.length]);

  // Scrolls the LIST, not `scrollIntoView` on the row: that walks up and moves the
  // right rail's own scroll position too.
  useEffect(() => {
    if (!open) {
      return;
    }
    const list = groupsRef.current;
    const row = list?.querySelectorAll(".workspace-picker-row")[active];
    if (!list || !row) {
      return;
    }
    const top = row.offsetTop - list.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [open, active, rows.length]);

  const commit = (next) => {
    close();
    const trimmed = String(next || "").trim();
    if (trimmed) {
      onChange?.(trimmed);
    }
  };

  // Path-shaped text, or anything the filter found no home for — see `canCommitDraft`.
  const pathDraft = canCommitDraft(draft, matched);

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      // A path-shaped draft wins: it is the only way to reach a directory not in the
      // list, so a coincidental row match must not swallow it.
      if (looksLikePath(draft)) {
        commit(draft);
        return;
      }
      const row = rows[active];
      if (row) {
        commit(row.path);
        return;
      }
      if (pathDraft) {
        commit(draft);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!rows.length) {
        return;
      }
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + rows.length) % rows.length);
    }
  }

  // Only trust a context naming the path shown, or path B wears path A's branch
  // while its probe is in flight. Compared on the relay's normalized spelling.
  const contextMatchesValue =
    gitContext
    && (!gitContext.cwd
      || gitContext.cwd === value
      || abbreviateHomePath(gitContext.cwd) === abbreviateHomePath(value));
  const gitLabel = contextMatchesValue ? gitContextLabel(gitContext) : null;

  return h(
    "div",
    { className: "workspace-picker", ref: rootRef },
    h(
      "button",
      {
        "aria-controls": open ? panelId : undefined,
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "dialog",
        "aria-label": `Workspace: ${value || "none chosen"}`,
        className: "workspace-picker-trigger",
        ref: triggerRef,
        disabled: disabled || undefined,
        id: id || undefined,
        onClick: () => setOpen((wasOpen) => !wasOpen),
        type: "button",
      },
      worktreeMode ? BRANCH_ICON : FOLDER_ICON,
      h(
        "span",
        { className: "workspace-picker-path", title: value || "" },
        triggerLabel({ worktreeMode, roots, value })
      ),
      gitLabel
        ? h(
            "span",
            {
              className:
                "workspace-picker-git" + (gitContext?.dirty ? " is-dirty" : ""),
            },
            gitLabel
          )
        : null,
      h("span", { "aria-hidden": "true", className: "project-switcher-caret" })
    ),
    // Portalled to <body>: see use-anchored-menu.js. Placement is in viewport
    // coordinates, which only means the viewport once outside the dialog's
    // centring transform.
    h(
      MenuPortal,
      { anchorRef: triggerRef, open },
      h(
        "div",
        { className: "workspace-picker-panel", id: panelId, ref: assignPanelRef },
          h(
            "div",
            { className: "workspace-picker-search" },
            SEARCH_ICON,
            h("input", {
              autoComplete: "off",
              className: "workspace-picker-input",
              id: inputId || undefined,
              onChange: (event) => {
                setDraft(event.target.value);
                setActive(0);
              },
              onKeyDown: handleKeyDown,
              placeholder: worktreeMode
                ? "Filter by branch or repo…"
                : "Filter, or type a path…",
              ref: inputRef,
              spellCheck: false,
              type: "text",
              value: draft,
            }),
            total
              ? h(
                  "span",
                  {
                    className: "workspace-picker-count",
                    // The bare number reads as a count of nothing in particular to a
                    // screen reader, which cannot see it sitting on the filter field.
                    title: matched === total ? undefined : `${matched} of ${total} shown`,
                  },
                  matched === total ? String(total) : `${matched}/${total}`
                )
              : null
          ),
          h(
            "div",
            { className: "workspace-picker-groups", ref: groupsRef, role: "listbox" },
            groups.map((group) =>
              h(
                "div",
                { className: "workspace-picker-group", key: group.key },
                group.title
                  ? h(
                      "div",
                      { className: "workspace-picker-group-head" },
                      h("span", { className: "workspace-picker-group-name" }, group.title),
                      group.subtitle
                        ? h(
                            "span",
                            { className: "workspace-picker-group-count" },
                            group.subtitle
                          )
                        : null
                    )
                  : null,
                group.rows.map((row) =>
                  h(PickerRow, {
                    key: row.path,
                    row,
                    isActive: rows[active] === row,
                    onPick: () => commit(row.path),
                  })
                )
              )
            )
          ),
          !groups.length
            ? h(
                "p",
                { className: "workspace-picker-empty" },
                total ? "No tree matches that filter." : "No other working trees."
              )
            : null,
          h(
            "button",
            {
              className: "workspace-picker-footer",
              // With a path typed this commits it; otherwise it explains where a path
              // goes, and puts the caret back in the field that takes one.
              onClick: () => (pathDraft ? commit(draft) : inputRef.current?.focus()),
              type: "button",
            },
            h(
              "span",
              { className: "workspace-picker-footer-action" },
              pathDraft ? `Use ${draft.trim()}` : "Enter a path…"
            ),
            pathDraft
              ? null
              : h(
                  "span",
                  { className: "workspace-picker-footer-hint" },
                  "for a repo not listed here"
                )
          )
        )
      )
  );
}

/** What the closed chip says. Worktree mode names the BRANCH; the path is the title. */
function triggerLabel({ worktreeMode, roots, value }) {
  if (!value) {
    return "Choose a directory";
  }
  if (worktreeMode) {
    const match = (roots || []).find((root) => root?.path === value);
    if (match) {
      return match.branch || "detached";
    }
  }
  return abbreviateHomePath(value);
}

function PickerRow({ row, isActive, onPick }) {
  return h(
    "button",
    {
      "aria-selected": row.isSelected ? "true" : "false",
      className:
        "workspace-picker-row"
        + (row.isSelected ? " is-selected" : "")
        + (isActive ? " is-active" : ""),
      onClick: onPick,
      role: "option",
      // A 304px column ellipsizes both the branch and the directory, and the full
      // path is the only unambiguous name a tree has.
      title: row.path,
      type: "button",
    },
    h(
      "span",
      { className: "workspace-picker-row-body" },
      h(
        "span",
        { className: "workspace-picker-row-head" },
        h("span", { className: "workspace-picker-row-primary" }, row.primary),
        row.badges.map((badge) =>
          h("span", { className: "workspace-picker-badge", key: badge }, badge)
        )
      ),
      row.secondary || row.status
        ? h(
            "span",
            { className: "workspace-picker-row-sub" },
            row.secondary
              ? h("span", { className: "workspace-picker-row-where" }, row.secondary)
              : null,
            row.secondary && row.status
              ? h("span", { "aria-hidden": "true", className: "workspace-picker-row-sep" }, "·")
              : null,
            row.status
              ? h(
                  "span",
                  {
                    className:
                      "workspace-picker-row-status is-" + row.status.tone,
                  },
                  row.status.text
                )
              : null
          )
        : null
    ),
    row.isSelected ? CHECK_ICON : null
  );
}

/** Restricted-Mode strip for Diff/Review. Absent `onTrustWorkspace` ⇒ remote/read-only. */
function trustPrompt(workspace, onTrustWorkspace) {
  const cwd = workspace?.cwd || "";
  if (!cwd || !isWorkspaceRestricted(workspace?.git)) {
    return null;
  }
  const canGrant = typeof onTrustWorkspace === "function";
  const copy = canGrant
    ? "Restricted — trusting lets this relay run git here (including hooks)."
    : "Restricted — this folder isn’t trusted. Trust it on the computer running the relay.";
  return h(
    "div",
    {
      className: "thread-workspace-trust",
      role: "status",
    },
    h("span", { className: "thread-workspace-trust-icon", "aria-hidden": "true" }, "⚠"),
    h("p", { className: "thread-workspace-trust-copy" }, copy),
    canGrant
      ? h(
          "button",
          {
            className: "thread-workspace-trust-button",
            onClick: () => onTrustWorkspace(cwd),
            title: `Trust ${cwd} — allows this relay to run git (and repository hooks) in that folder`,
            type: "button",
          },
          "Trust this folder"
        )
      : null
  );
}

/** `onPin` is a durable session pin; `onView` is Diff preview only. */
export function ThreadWorkspaceField({
  workspace = null,
  // `WorkspaceDiffResponse.fallback_from` when the resolved workspace has not landed yet.
  fallbackFrom = null,
  busy = false,
  error = null,
  onPin = null,
  onView = null,
  // Diff preview of another tree: clear means follow session, not unpin.
  previewing = false,
  // The session's own tree. Picking it is what returns the panel to FOLLOWING the
  // session — the job the removed "Follow session" button used to do.
  sessionCwd = "",
  onOpen = null,
  onClose = null,
  id = null,
  label = null,
  // Local only — null on a paired device (no broker grant action).
  onTrustWorkspace = null,
}) {
  const note = workspaceOriginNote(workspace, fallbackFrom, { previewing });
  const trust = trustPrompt(workspace, onTrustWorkspace);
  // `error` too: with no workspace to draw around, bailing here is what turned a failed
  // resolve into a tree bar that silently was not there.
  if (!workspace && !note && !error) {
    return null;
  }
  const roots = workspace?.roots || [];
  const pinned = workspace?.origin?.kind === "pinned";
  const canChange = typeof onPin === "function" || typeof onView === "function";
  const preview = typeof onView === "function";
  const onChange = (path) => {
    if (preview) {
      // Choosing the session's own tree is "follow again", not "pin a preview to it":
      // a preview left parked on that path would stop following if the session moved.
      onView(sessionCwd && path === sessionCwd ? null : path);
    } else {
      onPin?.(path);
    }
  };
  // Preview mode has no clear button at all now — the session's own row is the way
  // back, and it is badged so it can be found.
  const showClear = !preview && pinned && typeof onPin === "function";
  return h(
    "div",
    { className: "thread-workspace-field" },
    label ? h("span", { className: "thread-workspace-label" }, label) : null,
    workspace
      ? h(
          "div",
          { className: "thread-workspace-row" },
          h(WorkspacePicker, {
            disabled: busy || !canChange,
            gitContext: workspace.git || null,
            id,
            onChange,
            onClose,
            onOpen,
            roots,
            sessionPath: sessionCwd || workspace.cwd || "",
            value: workspace.cwd || "",
          }),
          showClear
            ? h(
                "button",
                {
                  className: "link-button thread-workspace-unpin",
                  disabled: busy || undefined,
                  onClick: () => onPin?.(null),
                  title: "Stop pinning and follow the tree the relay detects",
                  type: "button",
                },
                "Unpin"
              )
            : null
        )
      : null,
    note
      ? h(
          "p",
          {
            className:
              note.tone === "warn"
                ? "workspace-changes-fallback-note"
                : "workspace-origin-note",
            title: note.title || undefined,
          },
          note.text
        )
      : null,
    // After the origin note: which tree this is comes first, then why it reads as empty.
    trust,
    error
      ? h("p", { className: "thread-workspace-error", role: "alert" }, error)
      : null
  );
}
