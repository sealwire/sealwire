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
const { renderMarkdown, renderStreamingMarkdown } = await import("./shared/markdown.js");

for (const render of [renderMarkdown, renderStreamingMarkdown]) {
  test(`${render.name}: clicking a file copies its path without navigation or parent actions`, async () => {
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
    let parentKeyDowns = 0;
    try {
      await act(async () => root.render(React.createElement(
        "div",
        { onClick: () => parentClicks++, onKeyDown: () => parentKeyDowns++ },
        render("Done.\n\n[readme](</tmp/项目/My File.md:12>) [literal](/tmp/100%done.txt) "
          + String.raw`[windows](C:\repo\README.md:12)`
          + " [unsafe](/tmp/x%0Arm%20-rf%20~%0A) [web](https://example.com) `src/index.js`"),
      )));
      const buttons = container.querySelectorAll(".markdown-file-link");
      assert.equal(buttons.length, 3);
      for (const button of buttons) {
        assert.equal(button.getAttribute("role"), "button");
        assert.equal(button.tabIndex, 0);
        assert.equal(button.hasAttribute("href"), false);
        await act(async () => button.click());
        assert.equal(button.dataset.copied, "true");
      }
      for (const key of ["Enter", " "]) {
        const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        await act(async () => buttons[0].dispatchEvent(event));
        assert.equal(event.defaultPrevented, true);
      }
      assert.deepEqual(copied, [
        "/tmp/项目/My File.md:12", "/tmp/100%done.txt", String.raw`C:\repo\README.md:12`,
        "/tmp/项目/My File.md:12", "/tmp/项目/My File.md:12",
      ]);
      assert.equal(parentClicks, 0);
      assert.equal(parentKeyDowns, 0);
      assert.ok(container.textContent.includes("unsafe"));
      assert.equal(window.location.href, "http://127.0.0.1:8787/app");
      assert.equal(container.querySelector("a").href, "https://example.com/");
      assert.equal(container.querySelector("code").textContent, "src/index.js");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      else delete navigator.clipboard;
    }
  });
}
