// Design 20c-3 measured in a browser: a turn's replies and its process lines share
// one left edge under a single logo, and process lines sit a size below the text.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { TranscriptContent } from "./shared/transcript-react.js";

const css =
  readFileSync(new URL("./conversation.css", import.meta.url), "utf8")
  + readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const agent = (id, text) => ({ item_id: id, kind: "agent_text", status: "completed", text });
const bash = (id, status = "completed") => ({
  item_id: id,
  kind: "tool_call",
  status,
  tool: { item_type: "toolCall", name: "Bash", title: "Bash", detail: `Step ${id}`, command: "npm test" },
});

const ENTRIES = [
  { item_id: "u1", kind: "user_text", status: "completed", text: "go" },
  agent("a1", "First the tests."),
  bash("c1"),
  bash("c2"),
  agent("a2", "Now the fix."),
  { item_id: "r1", kind: "reasoning", status: "completed", text: "Weighing it" },
  agent("a3", "Running it."),
  bash("c3", "running"),
];

// Light theme: the design's greys are drawn on it.
test("a turn's replies and process lines share the text's left edge, a size below it", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const markup = renderToStaticMarkup(React.createElement(TranscriptContent, { entries: ENTRIES, options: {} }));
    await page.setContent(
      `<!doctype html><html data-theme="light"><head><style>${css}</style></head><body>
        <div class="chat-thread" style="width:800px">${markup}</div></body></html>`,
      { waitUntil: "load" }
    );
    const m = await page.evaluate(() => {
      const left = (selector) => Math.round(document.querySelector(selector).getBoundingClientRect().left);
      const probe = document.createElement("span");
      probe.style.color = "var(--text-faint)";
      document.body.append(probe);
      const chip = getComputedStyle(document.querySelector(".work-group-chip"));
      const running = getComputedStyle(document.querySelector('[data-transcript-entry-id="c3"] .tool-run-title'));
      return {
        text: left('[data-transcript-entry-id="a1"] .message-body'),
        laterReplies: [left('[data-transcript-entry-id="a2"] .message-body'), left('[data-transcript-entry-id="a3"] .message-body')],
        group: left(".work-group-chevron"),
        thought: left(".reasoning-chevron"),
        running: left('[data-transcript-entry-id="c3"] .tool-run-marker'),
        chip: { size: chip.fontSize, weight: chip.fontWeight, color: chip.color },
        lead: getComputedStyle(document.querySelector(".work-group-lead")).fontWeight,
        runningTitle: { size: running.fontSize, weight: running.fontWeight },
        faint: getComputedStyle(probe).color,
        leading: getComputedStyle(document.querySelector('[data-transcript-entry-id="a1"] .message-card')).lineHeight,
      };
    });
    assert.deepEqual(m.laterReplies, [m.text, m.text], "replies without a logo keep the text's edge");
    for (const [name, value] of Object.entries({ group: m.group, thought: m.thought, running: m.running })) {
      assert.ok(Math.abs(value - m.text) <= 1, `${name} line at ${value}, text at ${m.text}`);
    }
    assert.deepEqual(m.chip, { size: "12px", weight: "400", color: m.faint });
    assert.equal(m.lead, "400", "the group's lead is not bold");
    assert.deepEqual(m.runningTitle, { size: "12px", weight: "400" });
    assert.equal(parseFloat(m.leading).toFixed(1), (14 * 1.65).toFixed(1), "the text has room between its lines");
  } finally {
    await browser.close();
  }
});
