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
