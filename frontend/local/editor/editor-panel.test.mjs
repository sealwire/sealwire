import test from "node:test";
import assert from "node:assert/strict";

import { createEditorPanelHost, panelPath } from "./editor-panel.js";

test("an agent's path is taken relative to the session's worktree, never outside it", () => {
  const root = "/repo";
  assert.equal(panelPath("/repo/src/a.rs", root), "src/a.rs");
  assert.equal(panelPath("src/./a.rs", root), "src/a.rs");
  assert.equal(panelPath("file:///repo/README.md", root), "README.md");
  assert.equal(panelPath("/repo-evil/a.rs", root), null, "a sibling with the same prefix is outside");
  assert.equal(panelPath("/etc/passwd", root), null);
  assert.equal(panelPath("src/../../secret", root), null);
  assert.equal(panelPath("src\\a.rs", root), null);
  assert.equal(panelPath("/repo", root), null);
  assert.equal(panelPath("a.rs", null), null);
});

function fakeEditorStore() {
  const opened = [];
  return {
    opened,
    openFile(path, { root, line }) {
      opened.push({ path, root, line });
      return `${root}\n${path}`;
    },
    flushSaves() {},
  };
}

function fakeRail(width) {
  const calls = [];
  let current = width;
  return {
    calls,
    isOpen: () => current > 0,
    open: () => {
      current = 320;
    },
    getWidth: () => current,
    setWidth: (next, options) => {
      calls.push({ next, options });
      current = next;
    },
  };
}

test("opening a file widens the rail for it and leaving it puts the width back unsaved", () => {
  const editorStore = fakeEditorStore();
  const rail = fakeRail(320);
  const host = createEditorPanelHost({
    editorStore,
    getSessionRoot: () => "/repo",
    railControl: rail,
    viewportWidth: () => 1600,
  });
  assert.equal(host.openInPanel({ path: "/repo/src/a.rs", line: 12, diff: true }), true);
  assert.deepEqual(editorStore.opened, [{ path: "src/a.rs", root: "/repo", line: 12 }]);
  assert.equal(host.panel.getState().showingFile, true);
  assert.equal(host.panel.getState().modes["/repo\nsrc/a.rs"], "diff");
  assert.deepEqual(rail.calls[0], { next: 720, options: { commit: false, updateOpenWidth: false } });
  host.showFile(false);
  assert.deepEqual(rail.calls[1], { next: 320, options: { commit: false, updateOpenWidth: false } });
});

test("a path outside the session's worktree is left to the link's own fallback", () => {
  const editorStore = fakeEditorStore();
  const host = createEditorPanelHost({ editorStore, getSessionRoot: () => "/repo", railControl: fakeRail(320) });
  assert.equal(host.openInPanel({ path: "/elsewhere/a.rs" }), false);
  assert.equal(editorStore.opened.length, 0);
  assert.equal(host.panel.getState().showingFile, false);
});
