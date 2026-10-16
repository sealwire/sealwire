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
const { EditorScreen, CodeHost, DiffView, closeTargets, saveStatus } = await import("./editor-screen.js");
const { useStore } = await import("./editor-ui.js");
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

test("files that arrive in the Changes list wait for a tick, and the button says so", async () => {
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
    assert.deepEqual(boxes.map((box) => box.checked), [false, false]);
    assert.equal(container.querySelector(".editor-commit-button").textContent, "Tick the files to commit");
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

async function mountCodeHost(store, key) {
  function Host() {
    const doc = useStore(store, (state) => state.docs[key]);
    return h(CodeHost, { store, docKey: key, doc, cursor: null, hidden: false });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(Host)));
  await settle();
  const content = () => container.querySelector(".editor-code").shadowRoot.querySelector(".cm-content");
  return { root, content };
}

test("a code view follows text typed into the same file in another view", async () => {
  const relay = relayWith({ "/a/foo.rs": "one\n" });
  const store = createEditorStore({ api: relay.api, autosave: false });
  await store.setRoot("/a");
  store.openFile("foo.rs");
  await settle();
  const key = docKey("/a", "foo.rs");
  const { root, content } = await mountCodeHost(store, key);
  try {
    assert.equal(content().textContent, "one");
    // Typed in the session panel's view of the same file.
    store.editKey(key, "two\n");
    await settle();
    assert.equal(content().textContent, "two", "this view would otherwise save its old text over the new");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a code view stops taking keys once its file turns read-only", async () => {
  const relay = relayWith({ "/a/foo.rs": "one\n" });
  const store = createEditorStore({ api: relay.api, autosave: false });
  await store.setRoot("/a");
  store.openFile("foo.rs");
  await settle();
  const key = docKey("/a", "foo.rs");
  const { root, content } = await mountCodeHost(store, key);
  try {
    assert.equal(content().getAttribute("contenteditable"), "true");
    const docs = store.getState().docs;
    await act(async () => store.setState({ docs: { ...docs, [key]: { ...docs[key], readonly: true } } }));
    await settle();
    assert.equal(content().getAttribute("contenteditable"), "false");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a diff is drawn only against a base that was read; anything else says why not", async () => {
  const doc = { text: "now\n", path: "a.rs" };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const note = () => container.querySelector(".editor-panel-diff-note")?.textContent || "";
  const drawn = () => Boolean(container.querySelector(".editor-panel-diff"));
  try {
    for (const [base, expected] of [
      [{ loading: true }, /Loading/],
      [{ loading: false, error: "reading the committed a.rs took too long" }, /took too long/],
      [{ loading: false, tracked: true, binary: true, content: null }, /not text/],
      [{ loading: false, tracked: true, tooLarge: true, content: null }, /too large/],
    ]) {
      await act(async () => root.render(h(DiffView, { doc, base, path: "a.rs" })));
      assert.match(note(), expected, JSON.stringify(base));
      assert.equal(drawn(), false, `no diff for ${JSON.stringify(base)}`);
    }
    await act(async () => root.render(h(DiffView, { doc, base: { loading: false, tracked: false }, path: "a.rs" })));
    assert.match(note(), /New file/);
    assert.equal(drawn(), true);
  } finally {
    await act(async () => root.unmount());
  }
});

async function mountScreen(host) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(EditorScreen, { host })));
  await settle();
  return { container, root, unmount: () => act(async () => root.unmount()) };
}

const button = (container, text) => [...container.querySelectorAll("button")].find((node) => node.textContent.trim() === text);

test("⌘S saves the open file wherever the focus is, and the browser's own save never opens", async () => {
  const relay = relayWith({ "/a/foo.rs": "one\n" });
  const written = [];
  relay.api.writeFile = async ({ content }) => {
    written.push(content);
    return { status: "saved", revision: `r:${content}` };
  };
  const store = createEditorStore({ api: relay.api, autosave: false });
  await store.setRoot("/a");
  store.openFile("foo.rs");
  await settle();
  const { unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {} });
  try {
    store.edit("foo.rs", "two\n");
    const event = new window.KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      document.body.dispatchEvent(event);
    });
    await settle();
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(written, ["two\n"]);
  } finally {
    await unmount();
  }
});

test("a tab's menu pins it, and only offers ⌘W where the app can catch it", async () => {
  const relay = relayWith({ "/a/foo.rs": "one\n", "/a/bar.rs": "two\n" });
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.openFile("foo.rs");
  store.openFile("bar.rs");
  await settle();
  const { container, unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {} });
  try {
    const tab = container.querySelector('.editor-tab[data-path="bar.rs"]');
    await act(async () => {
      tab.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle();
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu, "the tab menu opens");
    assert.doesNotMatch(menu.textContent, /⌘W/, "a browser closes its own tab on ⌘W");
    const pin = [...menu.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent.includes("Pin tab"));
    assert.ok(pin, "the menu offers to pin");
    await act(async () => pin.click());
    await settle();
    assert.deepEqual(store.tabsOf("/a").pinned, ["bar.rs"]);
    assert.ok(container.querySelector('.editor-tab.is-pinned[data-path="bar.rs"]'));
  } finally {
    await unmount();
  }
});

test("closing other tabs or every tab leaves the pinned ones", () => {
  const paths = ["p.rs", "a.rs", "b.rs", "c.rs"];
  assert.deepEqual(closeTargets(paths, "a.rs", "others", ["p.rs"]), ["b.rs", "c.rs"]);
  assert.deepEqual(closeTargets(paths, "a.rs", "right", ["p.rs"]), ["b.rs", "c.rs"]);
  assert.deepEqual(closeTargets(paths, "a.rs", "all", ["p.rs"]), ["a.rs", "b.rs", "c.rs"]);
  assert.deepEqual(closeTargets(paths, "p.rs", "close", ["p.rs"]), ["p.rs"], "closing it by hand still works");
});

test("a commit says plainly that it went through, or that nothing was committed", async () => {
  const relay = relayWith({ "/a/x.rs": "x\n" });
  relay.api.changes = async () => ({ entries: [{ path: "x.rs", status: "M" }], sessions: [], complete: true, is_repo: true });
  let refuse = false;
  relay.api.commit = async ({ message }) => {
    if (refuse) {
      throw new Error("lint: 3 problems found");
    }
    return { commit: "abc1234", subject: message };
  };
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.setPanelView("changes");
  const { container, unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {} });
  try {
    await act(async () => container.querySelector('.editor-change-row input[type="checkbox"]').click());
    await settle();
    assert.match(container.querySelector(".editor-commit").textContent, /Write a commit message/);
    await act(async () => store.setCommitMessage("Ship it"));
    await settle();
    await act(async () => container.querySelector(".editor-commit-button").click());
    await settle();
    const done = container.querySelector(".editor-commit-done");
    assert.ok(done.classList.contains("is-ok"));
    assert.ok(button(done, "Show in History"), "the new commit can be found in History");
    refuse = true;
    const box = container.querySelector('.editor-change-row input[type="checkbox"]');
    if (!box.checked) {
      await act(async () => box.click());
    }
    await act(async () => store.setCommitMessage("Again"));
    await settle();
    await act(async () => container.querySelector(".editor-commit-button").click());
    await settle();
    assert.equal(container.querySelector(".editor-commit-error-title").textContent, "Nothing was committed: a hook or git refused it.");
  } finally {
    await unmount();
  }
});

test("the status line says saved only after a save, and a problem instead of saved", () => {
  const clean = { loading: false, dirty: false, saving: false };
  assert.equal(saveStatus({ doc: clean, autosave: true, mode: "edit" }).text, "");
  assert.equal(saveStatus({ doc: { ...clean, lastSavedAt: 5 }, autosave: true, mode: "edit" }).text, "Saved");
  assert.equal(saveStatus({ doc: { ...clean, saving: true }, autosave: true, mode: "edit" }).text, "Saving…");
  assert.equal(saveStatus({ doc: { ...clean, dirty: true }, autosave: false, mode: "edit" }).text, "Unsaved · ⌘S to save");
  const lost = saveStatus({ doc: { ...clean, lastSavedAt: 5, overwritten: { mine: "a", theirs: "b" } }, autosave: true, mode: "edit" });
  assert.equal(lost.tone, "warn");
  assert.notEqual(lost.text, "Saved");
  assert.equal(saveStatus({ doc: { ...clean, conflict: { diskText: "" } }, autosave: true, mode: "edit" }).tone, "warn");
  assert.equal(saveStatus({ doc: { ...clean, lastSavedAt: 5 }, autosave: true, mode: "diff" }).text, "", "a read-only diff has nothing to save");
});

test("a diff with nothing to show says the file matches its last commit", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(h(DiffView, { doc: { text: "same\n", path: "a.rs" }, base: { loading: false, tracked: true, content: "same\n" }, path: "a.rs", onEdit: () => {} }))
    );
    assert.match(container.textContent, /No changes since the last commit/);
    assert.equal(container.querySelector(".editor-panel-diff"), null);
  } finally {
    await act(async () => root.unmount());
  }
});

test("an untrusted folder shows only the way to trust it, not stale tabs and a saved status", async () => {
  const relay = relayWith({ "/a/foo.rs": "x\n" });
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.openFile("foo.rs");
  await settle();
  await act(async () => store.setState({ rootError: "This folder is not trusted yet." }));
  const { container, unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {}, trustFolder: async () => {} });
  try {
    await act(async () => store.setState({ rootError: "This folder is not trusted yet." }));
    await settle();
    assert.equal(container.querySelectorAll(".editor-main .editor-tab").length, 0);
    assert.equal(container.querySelector(".editor-status"), null);
    assert.match(container.querySelector(".editor-panel").textContent, /not trusted/);
    assert.match(container.querySelector(".editor-main").textContent, /you and the agents can change/);
  } finally {
    await unmount();
  }
});

test("the session that changed a file is a way back to it", async () => {
  const relay = relayWith({ "/a/x.rs": "x\n" });
  relay.api.changes = async () => ({
    entries: [{ path: "x.rs", status: "M", session: "t1" }],
    sessions: [{ id: "t1", title: "Fix reconnect", provider: "codex" }],
    complete: true,
    is_repo: true,
  });
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.openFile("x.rs");
  await settle();
  const opened = [];
  const { container, unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {}, openThread: (id) => opened.push(id) });
  try {
    const by = container.querySelector(".editor-path-by");
    assert.equal(by.tagName, "BUTTON");
    await act(async () => by.click());
    await act(async () => store.setPanelView("changes"));
    await settle();
    const title = container.querySelector(".editor-change-group-title");
    assert.equal(title.tagName, "BUTTON");
    await act(async () => title.click());
    assert.deepEqual(opened, ["t1", "t1"]);
  } finally {
    await unmount();
  }
});

test("with no file open the Editor says so and points at the files; the panel is titled by its folder", async () => {
  const relay = relayWith({});
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/work/agent-relay");
  store.setPanelView("changes");
  const { container, unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {} });
  try {
    assert.match(container.querySelector(".editor-placeholder").textContent, /No file is open/);
    await act(async () => button(container.querySelector(".editor-placeholder"), "Show files").click());
    await settle();
    assert.equal(store.getState().panelView, "files");
    assert.equal(container.querySelector(".editor-panel-title").textContent, "agent-relay");
  } finally {
    await unmount();
  }
});

test("a save conflict names who changed the file and leads with Compare", async () => {
  const relay = relayWith({ "/a/x.rs": "x\n" });
  relay.api.changes = async () => ({
    entries: [{ path: "x.rs", status: "M", session: "t1" }],
    sessions: [{ id: "t1", title: "Fix reconnect", provider: "codex" }],
    complete: true,
    is_repo: true,
  });
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.openFile("x.rs");
  await settle();
  const key = docKey("/a", "x.rs");
  const docs = store.getState().docs;
  store.setState({ docs: { ...docs, [key]: { ...docs[key], dirty: true, text: "mine\n", conflict: { diskText: "agent\n", diskRevision: "r2" } } } });
  const { container, unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {} });
  try {
    const banner = container.querySelector(".editor-banner");
    assert.match(banner.textContent, /Fix reconnect/);
    assert.equal(banner.querySelector(".editor-button.is-primary")?.textContent, "Compare");
  } finally {
    await unmount();
  }
});

test("the location names a worktree once when its branch has the same name", async () => {
  const relay = relayWith({});
  relay.api.branches = async () => ({ root: "/w/spike", current: "spike", branches: [], worktrees: [], busy: null });
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/w/spike");
  await settle();
  const { container, unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {} });
  try {
    assert.equal(container.querySelector(".editor-location").textContent.trim(), "spike");
  } finally {
    await unmount();
  }
});

test("Show in History opens History on the commit just made", async () => {
  const relay = relayWith({ "/a/x.rs": "x\n" });
  relay.api.changes = async () => ({ entries: [{ path: "x.rs", status: "M" }], sessions: [], complete: true, is_repo: true });
  relay.api.commit = async ({ message }) => ({ commit: "abc1234", subject: message });
  relay.api.branches = async () => ({ root: "/a", current: "main", branches: [], worktrees: [], busy: null });
  const full = "abc1234def5678abc1234def5678abc1234def56";
  const history = createHistoryStore({
    api: {
      history: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                commits: [{ id: full, parents: [], author: "Ann", time: 2, refs: [], subject: "Ship it" }],
                more: false,
                complete: true,
                is_repo: true,
              }),
            15
          )
        ),
      historyCommit: async (root, id) => ({ id, parents: [], author: "Ann", email: "a@e.com", time: 2, message: "Ship it", files: [], truncated: false }),
      historyFile: async () => ({}),
    },
  });
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.setPanelView("changes");
  const { container, unmount } = await mountScreen({ store, history, isVisible: () => true, ensureLoaded() {} });
  try {
    await act(async () => container.querySelector('.editor-change-row input[type="checkbox"]').click());
    await act(async () => store.setCommitMessage("Ship it"));
    await settle();
    await act(async () => container.querySelector(".editor-commit-button").click());
    await settle();
    await act(async () => button(container.querySelector(".editor-commit-done"), "Show in History").click());
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    await settle();
    assert.equal(history.getState().selected, full);
    assert.ok(container.querySelector(".editor-history-row.is-selected"), "the new commit is the picked row");
  } finally {
    await unmount();
  }
});

test("the reason switching is off is the app's own sentence, not the relay's raw words", async () => {
  const relay = relayWith({});
  relay.api.branches = async () => ({
    root: "/a",
    current: "main",
    branches: [
      { name: "main", remote: false, worktree: "/a" },
      { name: "topic", remote: false, worktree: null },
    ],
    worktrees: [{ path: "/a", branch: "main", is_main: true }],
    busy: "an agent is working in this folder right now; switching would change files under it",
  });
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  await settle();
  const { container, unmount } = await mountScreen({ store, isVisible: () => true, ensureLoaded() {} });
  try {
    await act(async () => container.querySelector(".editor-location").click());
    await settle();
    const note = document.querySelector(".editor-location-menu .editor-menu-note.is-warn");
    assert.equal(note?.textContent, "Switching is off here. An agent is working in this folder right now, and switching would change files under it.");
  } finally {
    await unmount();
  }
});

test("Show in History finds the new commit even while History is filtered to something else", async () => {
  const relay = relayWith({ "/a/x.rs": "x\n" });
  relay.api.changes = async () => ({ entries: [{ path: "x.rs", status: "M" }], sessions: [], complete: true, is_repo: true });
  relay.api.commit = async ({ message }) => ({ commit: "abc1234", subject: message });
  relay.api.branches = async () => ({ root: "/a", current: "main", branches: [], worktrees: [], busy: null });
  const full = "abc1234def5678abc1234def5678abc1234def56";
  const history = createHistoryStore({
    api: {
      history: async (query) => ({
        commits: query.author ? [] : [{ id: full, parents: [], author: "Ann", time: 2, refs: [], subject: "Ship it" }],
        more: false,
        complete: true,
        is_repo: true,
      }),
      historyCommit: async (root, id) => {
        if (id.length < 40) {
          throw new Error("that is not a commit id");
        }
        return { id, parents: [], author: "Ann", email: "a@e.com", time: 2, message: "Ship it", files: [], truncated: false };
      },
      historyFile: async () => ({}),
    },
  });
  await history.setFilters({ author: "omar" }, "/a");
  const store = createEditorStore({ api: relay.api, autosave: true });
  await store.setRoot("/a");
  store.setPanelView("changes");
  const { container, unmount } = await mountScreen({ store, history, isVisible: () => true, ensureLoaded() {} });
  try {
    await act(async () => container.querySelector('.editor-change-row input[type="checkbox"]').click());
    await act(async () => store.setCommitMessage("Ship it"));
    await settle();
    await act(async () => container.querySelector(".editor-commit-button").click());
    await settle();
    await act(async () => button(container.querySelector(".editor-commit-done"), "Show in History").click());
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    await settle();
    assert.equal(history.getState().selected, full);
    assert.equal(history.getState().filters.author, "", "the filter that hid it is cleared");
  } finally {
    await unmount();
  }
});
