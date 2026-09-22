import test from "node:test";
import assert from "node:assert/strict";

import {
  closeTab,
  createLeaf,
  createSplit,
  createTabWorkspace,
  findTabByThread,
  focusTab,
  focusedTab,
  layoutThreadIds,
  moveTab,
  openThreadIds,
  openThreadTab,
  promoteTab,
  sameWorkspace,
  setTabPinned,
  tabIdForThread,
} from "./shared/tab-layout.js";

const ids = (workspace) => workspace.tabs.map((tab) => tab.id);

function workspaceWith(threadIds) {
  return threadIds.reduce((workspace, threadId) => openThreadTab(workspace, threadId), createTabWorkspace());
}

test("opening sessions appends tabs and focuses the newest", () => {
  const workspace = workspaceWith(["t1", "t2"]);
  assert.deepEqual(ids(workspace), [tabIdForThread("t1"), tabIdForThread("t2")]);
  assert.equal(workspace.focusedTabId, tabIdForThread("t2"));
});

// A browser switches to an already-open tab rather than opening a second copy;
// duplicating would also give two panes competing over the same session.
test("opening an already-open session focuses its tab instead of duplicating", () => {
  const workspace = openThreadTab(workspaceWith(["t1", "t2"]), "t1");
  assert.deepEqual(ids(workspace), [tabIdForThread("t1"), tabIdForThread("t2")]);
  assert.equal(workspace.focusedTabId, tabIdForThread("t1"));
});

test("closing a tab drops it without touching the others", () => {
  const workspace = closeTab(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t2"));
  assert.deepEqual(ids(workspace), [tabIdForThread("t1"), tabIdForThread("t3")]);
});

// Closing a run of tabs should keep walking rightward instead of snapping focus
// back to the first tab each time.
test("closing the focused tab focuses the right neighbour, else the left", () => {
  const three = workspaceWith(["t1", "t2", "t3"]);

  const middleClosed = closeTab(focusTab(three, tabIdForThread("t2")), tabIdForThread("t2"));
  assert.equal(middleClosed.focusedTabId, tabIdForThread("t3"), "focus moves right");

  const lastClosed = closeTab(focusTab(three, tabIdForThread("t3")), tabIdForThread("t3"));
  assert.equal(lastClosed.focusedTabId, tabIdForThread("t2"), "last tab falls back left");
});

test("closing an unfocused tab leaves the focus alone", () => {
  const workspace = focusTab(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t1"));
  const next = closeTab(workspace, tabIdForThread("t3"));
  assert.equal(next.focusedTabId, tabIdForThread("t1"));
});

test("closing the last tab clears the focus", () => {
  const workspace = closeTab(workspaceWith(["t1"]), tabIdForThread("t1"));
  assert.deepEqual(workspace.tabs, []);
  assert.equal(workspace.focusedTabId, null);
});

test("pinned tabs sort ahead of unpinned ones", () => {
  const workspace = setTabPinned(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t3"), true);
  assert.deepEqual(ids(workspace), [
    tabIdForThread("t3"),
    tabIdForThread("t1"),
    tabIdForThread("t2"),
  ]);
});

test("unpinning returns a tab to the unpinned zone", () => {
  const pinned = setTabPinned(workspaceWith(["t1", "t2"]), tabIdForThread("t1"), true);
  const unpinned = setTabPinned(pinned, tabIdForThread("t1"), false);
  assert.deepEqual(ids(unpinned), [tabIdForThread("t1"), tabIdForThread("t2")]);
});

test("a newly opened session lands after the pinned zone, not inside it", () => {
  const pinned = setTabPinned(workspaceWith(["t1"]), tabIdForThread("t1"), true);
  const workspace = openThreadTab(pinned, "t2");
  assert.deepEqual(ids(workspace), [tabIdForThread("t1"), tabIdForThread("t2")]);
  assert.equal(workspace.tabs[0].pinned, true);
  assert.equal(workspace.tabs[1].pinned, false);
});

test("drag-reorder moves a tab within its own partition", () => {
  const workspace = moveTab(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t3"), 0);
  assert.deepEqual(ids(workspace), [
    tabIdForThread("t3"),
    tabIdForThread("t1"),
    tabIdForThread("t2"),
  ]);
});

// Dragging across the pinned boundary must not silently pin/unpin — the target is
// clamped into the dragged tab's own zone, keeping the partition invariant.
test("drag-reorder cannot interleave pinned and unpinned tabs", () => {
  const pinned = setTabPinned(workspaceWith(["t1", "t2", "t3"]), tabIdForThread("t1"), true);

  const draggedLeft = moveTab(pinned, tabIdForThread("t3"), 0);
  assert.equal(draggedLeft.tabs[0].id, tabIdForThread("t1"), "pinned tab keeps the first slot");
  assert.equal(draggedLeft.tabs[0].pinned, true);
  assert.equal(draggedLeft.tabs[1].id, tabIdForThread("t3"), "clamped to the top of its own zone");
  assert.equal(draggedLeft.tabs[1].pinned, false, "dragging did not pin it");

  const draggedRight = moveTab(pinned, tabIdForThread("t1"), 2);
  assert.equal(draggedRight.tabs[0].id, tabIdForThread("t1"), "lone pinned tab cannot leave its zone");
  assert.equal(draggedRight.tabs[0].pinned, true);
});

test("focus and reorder ignore unknown tab ids", () => {
  const workspace = workspaceWith(["t1"]);
  assert.deepEqual(focusTab(workspace, "nope"), workspace);
  assert.deepEqual(moveTab(workspace, "nope", 0), workspace);
  assert.deepEqual(closeTab(workspace, "nope"), workspace);
});

// Rehydrating from persisted state must not be able to produce a dangling focus,
// otherwise the UI would render an empty pane with tabs present.
test("rehydrating repairs a focus that names no existing tab", () => {
  const workspace = createTabWorkspace({
    tabs: [{ id: "tab-a", layout: createLeaf("t1") }],
    focusedTabId: "tab-gone",
  });
  assert.equal(workspace.focusedTabId, "tab-a");
});

test("rehydrating restores the pinned-first order and drops idless tabs", () => {
  const workspace = createTabWorkspace({
    tabs: [
      { id: "tab-a", layout: createLeaf("t1") },
      { id: "", layout: createLeaf("junk") },
      { id: "tab-b", pinned: true, layout: createLeaf("t2") },
    ],
    focusedTabId: "tab-a",
  });
  assert.deepEqual(ids(workspace), ["tab-b", "tab-a"]);
  assert.equal(workspace.focusedTabId, "tab-a", "an explicit valid focus survives reordering");
});

test("focusedTab resolves the focused entry", () => {
  const workspace = workspaceWith(["t1", "t2"]);
  assert.equal(focusedTab(workspace).id, tabIdForThread("t2"));
  assert.equal(focusedTab(createTabWorkspace()), null);
});

// The split shape is unused by the current UI but must already round-trip, so
// adding side-by-side panes later needs no migration of stored workspaces.
test("layout trees expose every session in visual order", () => {
  const split = createSplit({
    dir: "v",
    children: [createLeaf("t1"), createSplit({ children: [createLeaf("t2"), createLeaf("t3")] })],
  });
  assert.deepEqual(layoutThreadIds(split), ["t1", "t2", "t3"]);
});

test("a session inside a split counts as open", () => {
  const workspace = createTabWorkspace({
    tabs: [
      {
        id: "tab-split",
        layout: createSplit({ children: [createLeaf("t1"), createLeaf("t2")] }),
      },
    ],
  });

  assert.equal(findTabByThread(workspace, "t2").id, "tab-split");
  // The duplicate guard has to see through the tree, or splitting a tab and then
  // reopening one of its sessions would spawn a competing tab.
  const reopened = openThreadTab(workspace, "t2");
  assert.deepEqual(ids(reopened), ["tab-split"]);
  assert.equal(reopened.focusedTabId, "tab-split");
  assert.deepEqual(openThreadIds(workspace), ["t1", "t2"]);
});

// ── Preview tabs ────────────────────────────────────────────────────────────
// Browsing the sidebar must not accumulate tabs: a preview open reuses the one
// preview slot (VS Code's italic tab), and only a deliberate gesture keeps it.

test("a preview open reuses the single preview slot instead of appending", () => {
  let workspace = openThreadTab(createTabWorkspace(), "t1", { preview: true });
  workspace = openThreadTab(workspace, "t2", { preview: true });

  assert.deepEqual(ids(workspace), [tabIdForThread("t2")], "t1's preview tab was replaced");
  assert.equal(workspace.focusedTabId, tabIdForThread("t2"));
  assert.equal(workspace.tabs[0].preview, true);
});

test("a preview tab is replaced in place, keeping strip order", () => {
  let workspace = openThreadTab(createTabWorkspace(), "kept", { preview: false });
  workspace = openThreadTab(workspace, "peek", { preview: true });
  workspace = openThreadTab(workspace, "tail", { preview: false });
  assert.deepEqual(
    ids(workspace),
    [tabIdForThread("kept"), tabIdForThread("peek"), tabIdForThread("tail")]
  );

  const swapped = openThreadTab(workspace, "peek2", { preview: true });
  assert.deepEqual(
    ids(swapped),
    [tabIdForThread("kept"), tabIdForThread("peek2"), tabIdForThread("tail")],
    "the new preview takes the old preview's position, not the end of the strip"
  );
});

test("a kept open never becomes a preview, and never demotes an open tab", () => {
  const kept = openThreadTab(createTabWorkspace(), "t1");
  assert.equal(kept.tabs[0].preview, false, "opening without a preview intent keeps the tab");

  // Focusing an existing preview tab must not silently keep it: only an explicit
  // promotion does that, or the preview slot could never be reused.
  const preview = openThreadTab(createTabWorkspace(), "t1", { preview: true });
  const refocused = openThreadTab(preview, "t1");
  assert.equal(refocused.tabs[0].preview, true);
});

test("promoting a tab keeps it, and frees the preview slot for the next peek", () => {
  let workspace = openThreadTab(createTabWorkspace(), "t1", { preview: true });
  workspace = promoteTab(workspace, tabIdForThread("t1"));
  assert.equal(workspace.tabs[0].preview, false);

  workspace = openThreadTab(workspace, "t2", { preview: true });
  assert.deepEqual(
    ids(workspace),
    [tabIdForThread("t1"), tabIdForThread("t2")],
    "the promoted tab survives the next preview"
  );
});

test("promoting an unknown or already-kept tab is a no-op", () => {
  const workspace = openThreadTab(createTabWorkspace(), "t1");
  assert.deepEqual(promoteTab(workspace, "tab-missing"), workspace);
  assert.deepEqual(promoteTab(workspace, tabIdForThread("t1")), workspace);
});

// Pin and drag are both "I'm keeping this" gestures, same as in an editor.
test("pinning a preview tab keeps it", () => {
  const workspace = setTabPinned(
    openThreadTab(createTabWorkspace(), "t1", { preview: true }),
    tabIdForThread("t1"),
    true
  );
  assert.equal(workspace.tabs[0].pinned, true);
  assert.equal(workspace.tabs[0].preview, false, "a pinned tab is by definition kept");
});

test("dragging a preview tab into place keeps it", () => {
  let workspace = openThreadTab(createTabWorkspace(), "t1");
  workspace = openThreadTab(workspace, "t2");
  workspace = openThreadTab(workspace, "peek", { preview: true });

  const moved = moveTab(workspace, tabIdForThread("peek"), 0);
  assert.deepEqual(
    ids(moved),
    [tabIdForThread("peek"), tabIdForThread("t1"), tabIdForThread("t2")]
  );
  assert.equal(moved.tabs[0].preview, false);
});

// Change detection drives both persistence and re-render; a peek promoted to a kept
// tab that compared equal would never reach IndexedDB or repaint the italic title.
test("preview state participates in workspace equality", () => {
  const preview = openThreadTab(createTabWorkspace(), "t1", { preview: true });
  const kept = promoteTab(preview, tabIdForThread("t1"));
  assert.equal(sameWorkspace(preview, kept), false);
  assert.equal(sameWorkspace(kept, promoteTab(kept, tabIdForThread("t1"))), true);
});

test("preview state survives normalization", () => {
  const stored = createTabWorkspace(
    openThreadTab(createTabWorkspace(), "session-1", { preview: true })
  );
  assert.equal(stored.tabs[0].preview, true, "a reloaded window keeps its preview tab");
  assert.deepEqual(openThreadIds(stored), ["session-1"]);
});
