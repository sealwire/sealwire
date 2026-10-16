import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1:8787/app",
});
global.window = dom.window;
global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MarkdownEditorLinksContext, MarkdownFileOpenContext, renderMarkdown, renderStreamingMarkdown } = await import("./shared/markdown.js");

for (const render of [renderMarkdown, renderStreamingMarkdown]) {
  test(`${render.name}: file anchors open in the editor without copying or parent actions`, async () => {
    const copied = [];
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => copied.push(text) },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let parentClicks = 0;
    const opened = [];
    try {
      await act(async () => root.render(React.createElement(
        "div",
        { onClick: () => parentClicks++ },
        React.createElement(MarkdownEditorLinksContext.Provider, { value: true },
          render("Done.\n\n[readme](</tmp/项目/My File.md:12>) [literal](/tmp/100%done.txt) "
            + String.raw`[windows](C:\repo\README.md:12)`
            + " [relative](src/index.js#L7) [unsafe](/tmp/x%0Arm%20-rf%20~%0A) "
            + "[web](https://example.com) `src/index.js`"),
        ),
      )));
      const links = container.querySelectorAll("a.markdown-file-link");
      assert.equal(links.length, 3);
      for (const link of links) {
        assert.equal(link.tagName, "A");
        assert.equal(link.getAttribute("role"), null);
        assert.equal(link.tabIndex, 0);
        assert.equal(link.getAttribute("target"), "_blank");
        link.addEventListener("click", (event) => {
          assert.equal(event.defaultPrevented, false);
          opened.push(link.href);
          event.preventDefault();
        });
        await act(async () => link.click());
      }
      assert.deepEqual(opened, [
        "vscode://file/tmp/%E9%A1%B9%E7%9B%AE/My%20File.md:12", "vscode://file/tmp/100%25done.txt",
        "vscode://file/C:/repo/README.md:12",
      ]);
      assert.deepEqual(copied, []);
      const relative = container.querySelector('.markdown-file-link[role="button"]');
      await act(async () => relative.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true })));
      assert.deepEqual(copied, ["src/index.js#L7"]);
      assert.equal(parentClicks, 0);
      assert.ok(container.textContent.includes("unsafe"));
      assert.equal(window.location.href, "http://127.0.0.1:8787/app");
      assert.equal(container.querySelector('a[href^="https:"]').href, "https://example.com/");
      assert.equal(container.querySelector("code").textContent, "src/index.js");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      else delete navigator.clipboard;
    }
  });

  test(`${render.name}: a cached message switches between local editor links and remote copying`, async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const body = render("Done.\n\n[file](/repo/src/index.js:7)");
    try {
      for (const enabled of [true, false, true]) {
        await act(async () => root.render(React.createElement(MarkdownEditorLinksContext.Provider, { value: enabled }, body)));
        if (enabled) {
          assert.equal(container.querySelector("a").href, "vscode://file/repo/src/index.js:7");
        } else {
          assert.equal(container.querySelectorAll("a").length, 0);
          assert.equal(container.querySelector('[role="button"]').getAttribute("aria-label"), "Copy path: /repo/src/index.js:7");
        }
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}

test("with a file opener, a file link opens in Sealwire at its line and falls back when it cannot", async () => {
  const copied = [];
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => copied.push(text) },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const asked = [];
  let parentClicks = 0;
  const openFile = (target) => {
    asked.push(target);
    return target.path.startsWith("/repo/");
  };
  try {
    await act(async () => root.render(React.createElement(
      "div",
      { onClick: () => parentClicks++ },
      React.createElement(MarkdownFileOpenContext.Provider, { value: openFile },
        renderMarkdown("[a](</repo/src/a.rs:12>) [b](src/b.rs#L7C3) [c](</elsewhere/c.rs:3>) [web](https://example.com)")
      )
    )));
    const links = [...container.querySelectorAll(".markdown-file-link")];
    assert.equal(links.length, 3, "the web link is not a file link");
    for (const link of links) {
      await act(async () => link.click());
    }
    assert.deepEqual(asked, [
      { path: "/repo/src/a.rs", line: 12, column: null },
      { path: "src/b.rs", line: 7, column: 3 },
      { path: "/elsewhere/c.rs", line: 3, column: null },
    ]);
    assert.deepEqual(copied, ["src/b.rs#L7C3", "/elsewhere/c.rs:3"], "what could not open falls back to copying");
    assert.equal(parentClicks, 0, "the click stays on the link");

    asked.length = 0;
    await act(async () => links[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, metaKey: true })));
    assert.equal(asked.length, 0, "a modifier click keeps the old behaviour");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (previousClipboard) {
      Object.defineProperty(navigator, "clipboard", previousClipboard);
    } else {
      delete navigator.clipboard;
    }
  }
});
