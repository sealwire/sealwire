// Over plain http there is no Clipboard API, and the textarea fallback selects its own
// text; whatever the reader had selected on the page must come back after the copy.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const clipboardModule = readFileSync(new URL("./shared/clipboard.js", import.meta.url), "utf8");

test("copying without the Clipboard API leaves the page's selection where it was", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><p id="reply">alpha beta gamma</p></body></html>');
    await page.addScriptTag({
      content: `${clipboardModule.replace(/^export /gm, "")}\nwindow.copyTextToClipboard = copyTextToClipboard;`,
    });
    const after = await page.evaluate(async () => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      const text = document.getElementById("reply").firstChild;
      const range = document.createRange();
      range.setStart(text, 6);
      range.setEnd(text, 10);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      await window.copyTextToClipboard("beta");
      return window.getSelection().toString();
    });
    assert.equal(after, "beta");
  } finally {
    await browser.close();
  }
});

// Shift+arrow grows a selection from its focus end, so the direction has to survive too.
test("a selection made right to left keeps its direction through the copy", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><p id="reply">alpha beta gamma</p></body></html>');
    await page.addScriptTag({
      content: `${clipboardModule.replace(/^export /gm, "")}\nwindow.copyTextToClipboard = copyTextToClipboard;`,
    });
    const after = await page.evaluate(async () => {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
      const text = document.getElementById("reply").firstChild;
      window.getSelection().setBaseAndExtent(text, 10, text, 6);
      await window.copyTextToClipboard("beta");
      const selection = window.getSelection();
      return [selection.toString(), selection.anchorOffset, selection.focusOffset];
    });
    assert.deepEqual(after, ["beta", 10, 6]);
  } finally {
    await browser.close();
  }
});
