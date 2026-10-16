import test from "node:test";
import assert from "node:assert/strict";

import { changesOpener, createEditorPanelHost, panelPath } from "./editor-panel.js";

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

function storedRail(width) {
  const rail = fakeRail(width);
  rail.opened = 0;
  rail.open = () => {
    rail.opened += 1;
    rail.setWidth(320, { commit: true, updateOpenWidth: true });
  };
  rail.getPreferredWidth = () => 360;
  return rail;
}

test("a file opened while the rail is collapsed opens it again, without saving any width", () => {
  const editorStore = fakeEditorStore();
  const rail = storedRail(320);
  const host = createEditorPanelHost({
    editorStore,
    getSessionRoot: () => "/repo",
    railControl: rail,
    viewportWidth: () => 1600,
  });
  host.openInPanel({ path: "src/a.rs" });
  // The user collapses the rail with its own toggle while the file is showing.
  rail.setWidth(0, { commit: true, updateOpenWidth: false });
  rail.calls.length = 0;
  host.openInPanel({ path: "src/b.rs" });
  assert.ok(rail.isOpen(), "the next file link brings the rail back");
  assert.equal(rail.opened, 0, "open() would save its width as the user's choice");
  assert.ok(rail.calls.every((call) => call.options?.commit === false), JSON.stringify(rail.calls));
  host.showFile(false);
  assert.ok(rail.getWidth() > 0, "leaving the file shows the rail at its usual width, not collapsed");
});

test("Open on a change shown for another worktree is not offered in the session's panel", () => {
  const open = () => true;
  assert.equal(changesOpener(open, "/repo", null), open);
  assert.equal(changesOpener(open, "/repo", "/repo"), open);
  assert.equal(changesOpener(open, "/repo", "/repo/.sealwire/worktrees/b"), null);
});

test("going to the Editor from a file in the panel leaves the panel as it was, for when the user comes back", async () => {
  const editorStore = { ...fakeEditorStore(), showInEditor: async () => {} };
  const rail = fakeRail(320);
  let opened = 0;
  const host = createEditorPanelHost({
    editorStore,
    getSessionRoot: () => "/repo",
    railControl: rail,
    viewportWidth: () => 1600,
    openEditor: () => {
      opened += 1;
    },
  });
  host.openInPanel({ path: "src/a.rs" });
  const widened = rail.getWidth();
  await host.openInEditor("/repo\nsrc/a.rs");
  assert.equal(opened, 1);
  assert.equal(host.panel.getState().showingFile, true, "the file is still the one showing");
  assert.equal(rail.getWidth(), widened, "the panel keeps the width it had");
});
