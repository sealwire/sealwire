import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Window = dom.window.Window;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.MutationObserver = dom.window.MutationObserver;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
global.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom does no layout; CodeMirror only measures with these.
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createEditorStore, docKey } = await import("./editor-store.js");
const { EditorScreen } = await import("./editor-screen.js");
const { createHistoryStore } = await import("./history-store.js");

const h = React.createElement;

function relayWith(files) {
  const disk = new Map(Object.entries(files));
  return {
    disk,
    api: {
      listDir: async () => ({ entries: [], truncated: false }),
      changes: async () => ({ entries: [], complete: true, is_repo: true }),
      threadWorkspace: async () => null,
      readFile: async (root, path) => {
        const content = disk.get(`${root}/${path}`);
        return { content, revision: `r:${content}`, binary: false, too_large: false, readonly: false };
      },
      statFiles: async () => [],
      writeFile: async () => ({ status: "saved", revision: "r:x" }),
      baseFile: async () => ({ tracked: false, content: null }),
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

test("a close confirmation answers for the folder it was asked in, even after switching folders", async () => {
  const relay = relayWith({ "/a/foo.rs": "a\n", "/b/foo.rs": "b\n" });
  const store = createEditorStore({ api: relay.api, autosave: false });
  await store.setRoot("/b");
  store.openFile("foo.rs");
  await settle();
  store.edit("foo.rs", "b edited\n");
  await store.setRoot("/a");
  store.openFile("foo.rs");
  await settle();
  store.edit("foo.rs", "a edited\n");

  const host = { store, isVisible: () => true, ensureLoaded() {} };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(h(EditorScreen, { host })));
    await settle();

    await act(async () => {
      container.querySelector(".editor-tab-close").click();
    });
    await settle();
    assert.ok(container.querySelector(".editor-confirm"), "asked before closing an unsaved tab");

    // The folder changes while the question is still on screen.
    await act(async () => {
      await store.setRoot("/b");
    });
    await settle();
    const dontSave = [...container.querySelectorAll(".editor-confirm button")].find(
      (button) => button.textContent === "Don't save"
    );
    if (dontSave) {
      await act(async () => dontSave.click());
      await settle();
    }

    assert.deepEqual(store.tabsOf("/b").paths, ["foo.rs"], "the other folder's tab is untouched");
    assert.equal(store.getState().docs[docKey("/b", "foo.rs")]?.text, "b edited\n", "its unsaved text is kept");
  } finally {
    await act(async () => root.unmount());
  }
});

test("files that arrive in the Changes list come ticked", async () => {
  const relay = relayWith({ "/a/x.rs": "x\n", "/a/y.rs": "y\n" });
  relay.api.changes = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ entries: [{ path: "x.rs", status: "M" }, { path: "y.rs", status: "?" }], sessions: [], complete: true, is_repo: true }), 30)
    );
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.setChangedOnly(false);
  const host = { store, isVisible: () => true, ensureLoaded() {} };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(h(EditorScreen, { host })));
    await act(async () => {
      container.querySelector(".editor-panel-view:nth-child(2)").click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await settle();
    const boxes = [...container.querySelectorAll(".editor-change-row input[type=checkbox]")];
    assert.equal(boxes.length, 2);
    assert.deepEqual(boxes.map((box) => box.checked), [true, true]);
    assert.equal(container.querySelector(".editor-commit-button").textContent, "Commit 2 files");
  } finally {
    await act(async () => root.unmount());
  }
});

test("History is a tab beside the files: picking a file tab hides it, and its tab brings it back", async () => {
  const relay = relayWith({ "/a/foo.rs": "now\n" });
  relay.api.branches = async () => ({
    root: "/a",
    current: "main",
    branches: [{ name: "main", remote: false, worktree: "/a" }],
    worktrees: [],
    busy: null,
  });
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.openFile("foo.rs");
  const asked = [];
  const history = createHistoryStore({
    api: {
      history: async (query) => {
        asked.push(query);
        return {
          commits: [
            { id: "c2", parents: ["c1"], author: "Ann", time: 2, refs: ["HEAD -> main"], subject: "Tune foo" },
            { id: "c1", parents: [], author: "Ann", time: 1, refs: [], subject: "Start" },
          ],
          more: false,
          complete: true,
          is_repo: true,
        };
      },
      historyCommit: async (root, id) => ({
        id,
        parents: ["c1"],
        author: "Ann",
        email: "ann@example.com",
        time: 2,
        message: "Tune foo\n\nWhy it changed.",
        files: [{ path: "foo.rs", old_path: null, status: "M" }],
        truncated: false,
      }),
      historyFile: async (root, id, path) => ({ path, before: "then\n", after: "now\n", binary: false, too_large: false }),
    },
  });
  const host = { store, history, isVisible: () => true, ensureLoaded() {} };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(h(EditorScreen, { host })));
    await settle();
    const historyButton = [...container.querySelectorAll(".editor-panel-view")].find((button) => button.textContent === "History");
    await act(async () => historyButton.click());
    await settle();
    assert.ok(container.querySelector(".editor-tab.is-history.is-active"), "History opens as the active tab");
    assert.equal(asked[0].root, "/a");
    const rows = container.querySelectorAll(".editor-history-row");
    assert.equal(rows.length, 2);
    assert.equal(container.querySelectorAll(".editor-history-row .editor-graph").length, 2);
    assert.ok(container.querySelector(".editor-history-branch[data-branch=main]"), "the panel lists the branches");

    await act(async () => rows[0].click());
    await settle();
    assert.equal(container.querySelector(".editor-history-subject").textContent, "Tune foo");
    await act(async () => container.querySelector(".editor-history-files .editor-change-open").click());
    await settle();
    assert.equal(history.getState().file.data.before, "then\n");

    await act(async () => container.querySelector('.editor-tab[data-path="foo.rs"]').click());
    await settle();
    assert.equal(container.querySelector(".editor-history"), null, "the file tab takes the place of History");
    assert.ok(container.querySelector(".editor-tab.is-history:not(.is-active)"), "History stays in the strip");

    await act(async () => container.querySelector(".editor-tab.is-history").click());
    await settle();
    assert.ok(container.querySelector(".editor-history"));
    assert.equal(history.getState().selected, "c2", "the picked commit is still picked");
  } finally {
    await act(async () => root.unmount());
  }
});
