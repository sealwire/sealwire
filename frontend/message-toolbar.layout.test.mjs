// Measured in a browser: whether the toolbar holds space, overhangs, or gets clipped
// by the row's paint containment is only visible after layout.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import {
  renderSelectionToolbar,
  SELECTION_COPY_WIDTH,
  SELECTION_TOOLBAR_WIDTH,
  TranscriptContent,
} from "./shared/transcript-react.js";

const css =
  readFileSync(new URL("./conversation.css", import.meta.url), "utf8")
  + readFileSync(new URL("./styles.css", import.meta.url), "utf8");

// Rows off screen lay out at a placeholder height, so the page keeps settling; only
// the reply under test keeps the containment whose clipping is being checked.
const STILL = `*, *::before, *::after { animation: none !important; transition: none !important; }
  .chat-message:not([data-transcript-entry-id="a1"]) { content-visibility: visible !important; }`;

const entries = [
  { item_id: "u1", kind: "user_text", status: "completed", text: "go" },
  { item_id: "a1", kind: "agent_text", status: "completed", text: "Looking first." },
  { item_id: "t1", kind: "tool_call", status: "completed", tool: { item_type: "toolCall", name: "Bash", title: "Bash", command: "ls" } },
  { item_id: "a2", kind: "agent_text", status: "completed", text: "All done." },
];

test("a mid-turn reply holds no action row, and its toolbar floats over its top edge on hover", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const markup = renderToStaticMarkup(
      React.createElement(TranscriptContent, { entries, options: { canAsk: true } })
    );
    await page.setContent(
      `<!doctype html><html><head><style>${css}${STILL}</style></head><body>
        <div class="chat-thread" style="width:800px">${markup}</div></body></html>`,
      { waitUntil: "load" }
    );
    const reply = page.locator('[data-transcript-entry-id="a1"]');
    const before = await reply.evaluate((node) => ({
      held: Math.round(node.getBoundingClientRect().bottom - node.querySelector(".message-body").getBoundingClientRect().bottom),
      toolbar: getComputedStyle(node.querySelector(".message-toolbar")).opacity,
    }));
    assert.ok(before.held <= 2, `the reply holds ${before.held}px under its text`);
    assert.equal(before.toolbar, "0", "hidden until hovered");

    const target = await reply.locator(".message-body").boundingBox();
    await page.mouse.move(target.x + 10, target.y + target.height / 2);
    const hovered = await reply.evaluate((node) => {
      const bar = node.querySelector(".message-toolbar").getBoundingClientRect();
      const hit = document.elementFromPoint(bar.left + bar.width / 2, bar.top + 3);
      return {
        opacity: getComputedStyle(node.querySelector(".message-toolbar")).opacity,
        overhang: Math.round(node.getBoundingClientRect().top - bar.top),
        reachable: Boolean(hit && node.querySelector(".message-toolbar").contains(hit)),
      };
    });
    assert.equal(hovered.opacity, "1");
    assert.ok(hovered.overhang > 8, `overhangs the top edge by ${hovered.overhang}px`);
    assert.ok(hovered.reachable, "the part above the edge is drawn and clickable");

    const lastRow = await page
      .locator('[data-transcript-entry-id="a2"] .message-actions')
      .evaluate((node) => getComputedStyle(node.querySelector(".message-ask-button")).opacity);
    assert.equal(lastRow, "1", "the last reply's row shows without hover");
  } finally {
    await browser.close();
  }
});

// The selection logic runs in selection-toolbar.dom.test.mjs; this is what its marks look like.
test("with part of a reply selected, its toolbar stays away and Ask and Copy float without taking room", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const markup = renderToStaticMarkup(
      React.createElement(TranscriptContent, { entries, options: { canAsk: true } })
    );
    const toolbar = renderToStaticMarkup(renderSelectionToolbar({ text: "first", left: 40, top: 30 }, () => {}));
    await page.setContent(
      `<!doctype html><html><head><style>${css}${STILL}</style></head><body>
        <div class="chat-thread" style="width:800px">${markup}</div></body></html>`,
      { waitUntil: "load" }
    );
    const heightBefore = await page.evaluate(() => {
      document.querySelector('[data-transcript-entry-id="a1"]').setAttribute("data-selecting", "true");
      return document.querySelector(".thread-content").getBoundingClientRect().height;
    });
    const target = await page.locator('[data-transcript-entry-id="a1"] .message-body').boundingBox();
    await page.mouse.move(target.x + 10, target.y + target.height / 2);
    const hidden = await page
      .locator('[data-transcript-entry-id="a1"] .message-toolbar')
      .evaluate((node) => getComputedStyle(node).opacity);
    assert.equal(hidden, "0", "the hovered reply's toolbar stays hidden while selecting");

    const placed = await page.evaluate((html) => {
      const content = document.querySelector(".thread-content");
      content.insertAdjacentHTML("beforeend", html);
      const frame = content.getBoundingClientRect();
      const box = content.querySelector(".selection-toolbar").getBoundingClientRect();
      return {
        height: frame.height,
        left: Math.round(box.left - frame.left),
        top: Math.round(box.top - frame.top),
        width: box.width,
        buttons: [...content.querySelectorAll(".selection-toolbar button")].map((b) => b.getBoundingClientRect().height),
      };
    }, toolbar);
    assert.equal(placed.height, heightBefore, "the toolbar takes no room in the list");
    assert.deepEqual([placed.left, placed.top], [40, 30], "and is placed against the list itself");
    assert.ok(placed.width <= SELECTION_TOOLBAR_WIDTH, `${placed.width}px fits the ${SELECTION_TOOLBAR_WIDTH}px kept at the edge`);
    assert.equal(placed.buttons.length, 2);

    const copyOnly = await page.evaluate((html) => {
      const content = document.querySelector(".thread-content");
      content.querySelector(".selection-toolbar").remove();
      content.insertAdjacentHTML("beforeend", html);
      return content.querySelector(".selection-toolbar").getBoundingClientRect().width;
    }, renderToStaticMarkup(renderSelectionToolbar({ text: "first", left: 40, top: 30 })));
    assert.ok(copyOnly <= SELECTION_COPY_WIDTH, `Copy alone is ${copyOnly}px, ${SELECTION_COPY_WIDTH}px kept at the edge`);
  } finally {
    await browser.close();
  }
});
