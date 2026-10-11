// Measured in a browser: HTML collapses a run of spaces into one, but `'./safe  x'` and
// `'./safe x'` are different files, so the bar and the folder chip must keep every space.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { TranscriptState } from "./shared/conversation.js";

const css =
  readFileSync(new URL("./conversation.css", import.meta.url), "utf8")
  + readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const approval = (gap) => ({
  request_id: `req-${gap.length}`,
  kind: "permissions",
  summary: "Bash",
  command: `'./safe${gap}x'`,
  cwd: `/tmp/a${gap}b`,
});

test("the float bar and the folder chip keep a run of spaces", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const widths = {};
    for (const gap of [" ", "  "]) {
      const markup = renderToStaticMarkup(
        React.createElement(TranscriptState, { approval: approval(gap), entries: [] })
      );
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body>
          <div class="chat-thread" style="width:900px;height:600px">${markup}</div></body></html>`,
        { waitUntil: "load" }
      );
      widths[gap.length] = await page.evaluate(() => {
        const textWidth = (selector) => {
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(selector));
          return range.getBoundingClientRect().width;
        };
        return { subject: textWidth(".approval-float-subject"), cwd: textWidth(".approval-scope-path") };
      });
    }
    assert.ok(widths[2].subject > widths[1].subject, `bar subject: ${JSON.stringify(widths)}`);
    assert.ok(widths[2].cwd > widths[1].cwd, `folder chip: ${JSON.stringify(widths)}`);

    // The bar keeps spaces, so a multi-line summary (a plan, no command) must not grow it.
    const plan = { request_id: "plan", kind: "plan", summary: "Step one\nStep two\nStep three" };
    const markup = renderToStaticMarkup(React.createElement(TranscriptState, { approval: plan, entries: [] }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body>
        <div class="chat-thread" style="width:390px;height:600px">${markup}</div></body></html>`,
      { waitUntil: "load" }
    );
    const box = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
      const bar = rect(".approval-float-bar");
      const subject = rect(".approval-float-subject");
      return { bar: [bar.top, bar.bottom], subject: [subject.top, subject.bottom] };
    });
    assert.ok(
      box.subject[0] >= box.bar[0] && box.subject[1] <= box.bar[1],
      `subject stays inside the bar: ${JSON.stringify(box)}`
    );
  } finally {
    await browser.close();
  }
});
