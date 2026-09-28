// Tool rows measured in a browser: a global `button { justify-content: center }`
// centred any row with nothing but a title (Cursor's "grep"), which markup can't show.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import { TranscriptContent } from "./shared/transcript-react.js";

const h = React.createElement;
const css =
  readFileSync(new URL("./conversation.css", import.meta.url), "utf8")
  + readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const cursorTool = (id, name) => ({
  item_id: id,
  kind: "tool_call",
  status: "completed",
  tool: { item_type: "tool_call", name, title: name, kind: "search" },
});
const bash = (id, status) => ({
  item_id: id,
  kind: "tool_call",
  status,
  tool: { item_type: "toolCall", name: "Bash", title: "Bash", detail: "Build it", command: "npm run build" },
});

async function render(page, entries, options = {}) {
  const markup = renderToStaticMarkup(h(TranscriptContent, { entries, options }));
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body>
      <div class="chat-thread" style="width:800px">${markup}</div></body></html>`,
    { waitUntil: "load" }
  );
}

test("an opened group reads as one aligned list on a hairline, whatever the row carries", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await render(
      page,
      [cursorTool("g1", "grep"), cursorTool("g2", "Find"), cursorTool("g3", "File")],
      { expandedKeys: new Set(["group:g1"]) }
    );
    const m = await page.evaluate(() => {
      const lead = document.querySelector(".work-group-lead").getBoundingClientRect();
      const members = [...document.querySelectorAll(".chat-message.is-group-member")];
      return {
        lead: lead.left,
        titles: members.map((node) => node.querySelector(".tool-run-title").getBoundingClientRect().left),
        dots: members.map((node) => getComputedStyle(node, "::before").content),
        lines: members.map((node) => parseFloat(getComputedStyle(node).borderLeftWidth)),
        seams: members.slice(1).map((node, i) =>
          Math.round(node.getBoundingClientRect().top - members[i].getBoundingClientRect().bottom)
        ),
      };
    });
    for (const left of m.titles) {
      assert.ok(Math.abs(left - m.lead) <= 3, `member title at ${left}, group text at ${m.lead}`);
    }
    assert.deepEqual(m.dots, ["none", "none", "none"], "no dot per row");
    assert.ok(m.lines.every((width) => width >= 1), "each member carries the line");
    assert.deepEqual(m.seams, [0, 0], "no gap breaks the line between members");
  } finally {
    await browser.close();
  }
});

test("a running row wears a pulsing green dot in the chevron's slot, text still aligned", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await render(page, [bash("r1", "running"), { item_id: "u", kind: "agent_text", status: "completed", text: "x" }, bash("c1", "completed")]);
    const m = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".tool-run-row")];
      const dot = document.querySelector(".tool-run-live");
      const probe = document.createElement("span");
      probe.style.color = "var(--ok-fg)";
      document.body.append(probe);
      const green = getComputedStyle(probe).color;
      const dotStyle = getComputedStyle(dot);
      return {
        titles: rows.map((row) => row.querySelector(".tool-run-title").getBoundingClientRect().left),
        dotColor: dotStyle.backgroundColor,
        green,
        animation: dotStyle.animationName,
      };
    });
    assert.equal(m.dotColor, m.green);
    assert.notEqual(m.animation, "none");
    assert.ok(Math.abs(m.titles[0] - m.titles[1]) <= 1, `running ${m.titles[0]} vs done ${m.titles[1]}`);
  } finally {
    await browser.close();
  }
});

// Long transcripts wrap every row, and the wrapper's padding is the spacing there.
test("the hairline stays one piece when the transcript is virtualized", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await render(
      page,
      [cursorTool("g1", "grep"), cursorTool("g2", "Find"), { item_id: "a", kind: "agent_text", status: "completed", text: "after" }],
      { expandedKeys: new Set(["group:g1"]) }
    );
    const m = await page.evaluate(() => {
      const content = document.querySelector(".thread-content");
      for (const node of [...content.children]) {
        const wrapper = document.createElement("div");
        wrapper.className = "transcript-virtual-row";
        wrapper.style.position = "static";
        node.replaceWith(wrapper);
        wrapper.append(node);
      }
      content.style.gap = "0";
      const members = [...document.querySelectorAll(".chat-message.is-group-member")];
      const after = document.querySelector('[data-transcript-entry-kind="agent_text"]');
      return {
        seam: Math.round(members[1].getBoundingClientRect().top - members[0].getBoundingClientRect().bottom),
        afterGap: Math.round(after.getBoundingClientRect().top - members[1].getBoundingClientRect().bottom),
      };
    });
    assert.equal(m.seam, 0, "members touch");
    assert.equal(m.afterGap, 8, "the next message sits a process line's distance below");
  } finally {
    await browser.close();
  }
});

// Tool runs are process, not conversation: they sit close to the messages around
// them instead of taking a full message gap on each side.
const agent = (id, text) => ({ item_id: id, kind: "agent_text", status: "completed", text });
const SPACING_ENTRIES = [
  agent("a1", "Checking first."),
  bash("c1", "completed"),
  agent("a2", "Now the group."),
  cursorTool("g1", "grep"),
  cursorTool("g2", "Find"),
  agent("a3", "Done."),
  agent("a4", "Anything else?"),
];

function measureSpacing() {
  const box = (selector) => document.querySelector(selector).getBoundingClientRect();
  const byId = (id) => box(`[data-transcript-entry-id="${id}"]`);
  const group = box(".chat-message-work-group");
  return {
    aboveTool: Math.round(byId("c1").top - byId("a1").bottom),
    belowTool: Math.round(byId("a2").top - byId("c1").bottom),
    aboveGroup: Math.round(group.top - byId("a2").bottom),
    belowGroup: Math.round(byId("a3").top - group.bottom),
    betweenMessages: Math.round(byId("a4").top - byId("a3").bottom),
  };
}

test("tool rows and group lines sit close to the messages around them", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await render(page, SPACING_ENTRIES);
    assert.deepEqual(await page.evaluate(measureSpacing), {
      aboveTool: 8,
      belowTool: 8,
      aboveGroup: 8,
      belowGroup: 8,
      betweenMessages: 24,
    });

    await page.evaluate(() => {
      const content = document.querySelector(".thread-content");
      for (const node of [...content.children]) {
        const wrapper = document.createElement("div");
        wrapper.className = "transcript-virtual-row";
        wrapper.style.position = "static";
        node.replaceWith(wrapper);
        wrapper.append(node);
      }
      content.style.gap = "0";
    });
    assert.deepEqual(
      await page.evaluate(measureSpacing),
      { aboveTool: 8, belowTool: 8, aboveGroup: 8, belowGroup: 8, betweenMessages: 24 },
      "the same when virtualized"
    );
  } finally {
    await browser.close();
  }
});
