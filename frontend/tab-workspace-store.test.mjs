import test from "node:test";
import assert from "node:assert/strict";

import {
  NO_PROJECT_KEY,
  createTabWorkspaceStore,
  tabWorkspaceKey,
} from "./shared/tab-workspace-store.js";
import { createLeaf } from "./shared/tab-layout.js";
import { loadTabWorkspace, saveTabWorkspace } from "./shared/tab-workspace-prefs.js";

function fakePersistence(seed = {}) {
  const saved = { ...seed };
  const calls = { load: [], save: [], keys: 0 };
  return {
    calls,
    saved,
    load(key) {
      calls.load.push(key);
      return saved[key] || null;
    },
    save(key, workspace) {
      calls.save.push(key);
      saved[key] = workspace;
    },
    keys() {
      calls.keys += 1;
      return Object.keys(saved);
    },
  };
}

const ids = (workspace) => workspace.tabs.map((tab) => tab.id);

test("workspaces are isolated per project", () => {
  const store = createTabWorkspaceStore().getState;
  store().openThread("p1", "t1");
  store().openThread("p2", "t2");

  assert.deepEqual(ids(store().ensureWorkspace("p1")), ["tab-t1"]);
  assert.deepEqual(ids(store().ensureWorkspace("p2")), ["tab-t2"]);
});

test("no selected project still gets a usable workspace", () => {
  assert.equal(tabWorkspaceKey(null), NO_PROJECT_KEY);
  assert.equal(tabWorkspaceKey(""), NO_PROJECT_KEY);
  assert.equal(tabWorkspaceKey("p1"), "p1");

  const store = createTabWorkspaceStore().getState;
  store().openThread(null, "t1");
  assert.deepEqual(ids(store().ensureWorkspace(null)), ["tab-t1"]);
});

test("every real mutation is written through to persistence", () => {
  const persistence = fakePersistence();
  const store = createTabWorkspaceStore({ persistence }).getState;

  const writes = () => persistence.calls.save.length;

  store().openThread("p1", "t1");
  assert.equal(writes(), 1);
  store().openThread("p1", "t2");
  assert.equal(writes(), 2);
  // Pinning floats t2 ahead of t1 → [tab-t2, tab-t1].
  store().setPinned("p1", "tab-t2", true);
  assert.equal(writes(), 3);
  assert.deepEqual(ids(persistence.saved.p1), ["tab-t2", "tab-t1"]);

  store().focusTabId("p1", "tab-t1");
  assert.equal(writes(), 4);
  store().moveTabId("p1", "tab-t2", 0);
  assert.equal(writes(), 4, "tab-t2 is already at index 0 — nothing moved, nothing written");
  store().closeTabId("p1", "tab-t1");
  assert.equal(writes(), 5);

  assert.deepEqual(ids(persistence.saved.p1), ["tab-t2"]);
  assert.deepEqual(persistence.calls.save, ["p1", "p1", "p1", "p1", "p1"]);
});

// A no-op must not churn storage — reopening the session you're already on is the
// common case (clicking the same row twice).
test("a no-op operation neither changes state nor writes", () => {
  const persistence = fakePersistence();
  const store = createTabWorkspaceStore({ persistence }).getState;
  store().openThread("p1", "t1");
  const writesAfterOpen = persistence.calls.save.length;

  const before = store().ensureWorkspace("p1");
  const after = store().focusTabId("p1", "nope");
  assert.equal(after, before, "unknown tab id is a no-op");
  assert.equal(persistence.calls.save.length, writesAfterOpen, "no extra write");
});

test("a stored workspace is restored on first access", () => {
  const persistence = fakePersistence({
    p1: {
      tabs: [
        { id: "tab-t1", pinned: false, layout: createLeaf("t1") },
        { id: "tab-t2", pinned: true, layout: createLeaf("t2") },
      ],
      focusedTabId: "tab-t1",
    },
  });
  const store = createTabWorkspaceStore({ persistence }).getState;

  const workspace = store().ensureWorkspace("p1");
  // Restored AND repaired: the pinned tab is floated back to the front.
  assert.deepEqual(ids(workspace), ["tab-t2", "tab-t1"]);
  assert.equal(workspace.focusedTabId, "tab-t1");
});

test("persistence is read at most once per project", () => {
  const persistence = fakePersistence();
  const store = createTabWorkspaceStore({ persistence }).getState;

  store().ensureWorkspace("p1");
  store().ensureWorkspace("p1");
  store().openThread("p1", "t1");
  store().ensureWorkspace("p1");

  assert.deepEqual(persistence.calls.load, ["p1"]);
});

// A throwing adapter is realistic (private mode, quota, corrupt JSON) and must
// never take the surface down with it.
test("a throwing persistence adapter degrades instead of propagating", () => {
  const persistence = {
    load() {
      throw new Error("storage exploded");
    },
    save() {
      throw new Error("quota exceeded");
    },
  };
  const store = createTabWorkspaceStore({ persistence }).getState;

  assert.deepEqual(store().ensureWorkspace("p1").tabs, []);
  const workspace = store().openThread("p1", "t1");
  assert.deepEqual(ids(workspace), ["tab-t1"], "the in-memory change survives a failed write");
});

// A deleted session's tab is dead weight: it can't be focused into anything and it
// keeps a stale title in the strip. It also leaves a [data-thread-id] node in the
// DOM for a thread the rest of the UI has already forgotten.
test("deleting a session closes its tab in every workspace", () => {
  const persistence = fakePersistence();
  const store = createTabWorkspaceStore({ persistence }).getState;

  store().openThread("p1", "t1");
  store().openThread("p1", "t2");
  // Same session tabbed under another project — its assignment can change while a
  // tab is open, so the sweep must not stop at one workspace.
  store().openThread("p2", "t1");

  store().closeThreadEverywhere("t1");

  assert.deepEqual(ids(store().ensureWorkspace("p1")), ["tab-t2"]);
  assert.deepEqual(ids(store().ensureWorkspace("p2")), []);
  assert.deepEqual(ids(persistence.saved.p1), ["tab-t2"], "the removal is persisted");
});

// Regression: the sweep used to walk only the in-memory `workspaces`, so a project
// whose tabs live purely in storage (never visited this page load) kept the dead
// tab — and resurrected it the first time you opened that project.
test("deleting a session also sweeps workspaces that were never loaded", () => {
  const persistence = fakePersistence({
    p_cold: {
      tabs: [
        { id: "tab-t1", pinned: false, layout: createLeaf("t1") },
        { id: "tab-t9", pinned: false, layout: createLeaf("t9") },
      ],
      focusedTabId: "tab-t1",
    },
  });
  const store = createTabWorkspaceStore({ persistence }).getState;

  // Only p_hot is loaded; p_cold exists solely in storage.
  store().openThread("p_hot", "t1");
  assert.deepEqual(Object.keys(store().workspaces), ["p_hot"]);

  store().closeThreadEverywhere("t1");

  assert.deepEqual(ids(store().ensureWorkspace("p_hot")), []);
  assert.deepEqual(
    ids(store().ensureWorkspace("p_cold")),
    ["tab-t9"],
    "the cold workspace must not bring the deleted session back"
  );
});

test("closing an unknown or missing session is a no-op", () => {
  const persistence = fakePersistence();
  const store = createTabWorkspaceStore({ persistence }).getState;
  store().openThread("p1", "t1");
  const writes = persistence.calls.save.length;

  store().closeThreadEverywhere("nope");
  store().closeThreadEverywhere(null);

  assert.deepEqual(ids(store().ensureWorkspace("p1")), ["tab-t1"]);
  assert.equal(persistence.calls.save.length, writes);
});

test("the store works with no persistence at all", () => {
  const store = createTabWorkspaceStore().getState;
  assert.deepEqual(store().ensureWorkspace("p1").tabs, []);
  assert.deepEqual(ids(store().openThread("p1", "t1")), ["tab-t1"]);
});

test("prefs read/write is a no-op without a window", () => {
  // Node has no `window`, which is exactly the SSR/test path the adapter guards.
  assert.equal(loadTabWorkspace("p1"), null);
  assert.doesNotThrow(() => saveTabWorkspace("p1", { tabs: [], focusedTabId: null }));
});
